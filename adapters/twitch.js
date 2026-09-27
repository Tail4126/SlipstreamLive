// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * adapters/twitch.js — Twitch 専用の「アダプター」
 * =============================================================================
 *
 * ■ Twitch ならではの難しさ
 *   YouTube と違い、Twitch はプレーヤーの内部 API を DOM 要素に生やしていません。
 *   代わりにページ全体が React というライブラリで作られており、
 *   プレーヤーの実体（mediaPlayerInstance）は React の内部データ構造の中に隠れています。
 *
 *   そこで、DOM 要素に React が付ける隠しプロパティ（`__reactFiber$...`）を入口にして、
 *   内部ツリーを辿って実体を探し出す、という少し強引な手を使っています。
 *   見つからなくても動作は続く（遅延表示が出ないだけ）ように作られています。
 *
 * ■ プレーヤーが落ちたときの復帰について
 *   Twitch のプレーヤーは「エラー #3000」のような番号付きのエラーで完全に停止することがあり、
 *   通常の対処はページの再読み込みです。このアダプターは heal() でその状態を見張り、
 *   Twitch 自身が表示する再読み込みボタンを代わりに押して、ページを保ったまま復帰させます。
 *
 * ■ アダプターの役割については adapters/youtube.js の冒頭コメントを参照。
 */
(() => {
    'use strict';

    const util = globalThis.__slipstreamliveUtil;
    if (!util) return;

    const { pick, tracker, toNum, safeCall, videoWatcher, registerSite,
        ENDLESS, BADGE_STYLE_PLAIN } = util;

    /** プレーヤー実体の再探索を試みる間隔（ミリ秒）。見つからないとき無駄に探し続けないための制限。 */
    const SEARCH_MS = 1000;

    /** Twitch 独自の自動加速機能を無効化し直す間隔（ミリ秒）。 */
    const TAME_MS = 2000;

    /** エラーゲート（「エラー #3000」などの覆い）のセレクター。 */
    const GATE = '.content-overlay-gate, [data-a-target="player-overlay-content-gate"]';

    /**
     * Twitch のエラー番号。
     *
     * 同じ覆いは年齢確認やサブスク限定の告知にも使われますが、そちらには番号が入りません。
     * 番号の有無で「復帰させるべき異常」だけを選び分けます。
     * 文言は言語ごとに変わっても番号は変わらないため、この判定は 9 言語すべてで通用します。
     */
    const CODE = /#\s*\d{4}/;

    /** 異常の有無を確かめる間隔（ミリ秒）。20ms ごとに DOM を探す必要はありません。 */
    const HEAL_POLL_MS = 500;

    /**
     * 復帰を試みる間隔（ミリ秒）。
     *
     * 先頭の値は「異常を見つけてから 1 回目まで」の猶予で、2 つ目以降は前回の試行からの間隔です。
     * 最初に少し待つのは、Twitch 自身が立ち直ることがあり、その復帰と衝突させないためです。
     * 配列の長さがそのまま試行回数の上限になり、配信終了など直りようのない相手へ
     * 延々と挑み続けないための歯止めになります。
     */
    const HEAL_WAIT = [1200, 4000, 10000, 25000];

    /** 何回目までを「再読み込みボタンを押す」で対応するか。それ以降は setSrc に切り替えます。 */
    const HEAL_CLICKS = 3;

    /** 正常な再生がこれだけ続いたら、試行回数を忘れる（ミリ秒）。 */
    const HEAL_CLEAR_MS = 5000;

    /**
     * React ツリー全体を辿るときの探索上限。
     *
     * setSrc を持つコンポーネントはプレーヤー要素のはるか上流（実測で 12,500 ノードほど先）に
     * あり、search() のようにプレーヤーの周辺だけを見る探索では届きません。
     * 余裕を見てこの値にしています。
     */
    const SOURCE_BUDGET = 40000;

    /** setSrc コンポーネントを探し直す間隔（ミリ秒）。探索が重いので広めに取ります。 */
    const SOURCE_MS = 3000;

    /**
     * Twitch 用アダプターを生成する。
     * @returns {object} アダプターオブジェクト
     */
    function twitch() {
        /** プレーヤーの外枠を探すためのセレクター候補（優先度順）。 */
        const ROOTS = ['div[data-a-target="video-player"]', '.video-player__container', '.persistent-player'];

        /** 広告再生中を示す要素のセレクター（どれかがあれば広告中）。 */
        const ADS = '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], .video-player__ad-container';

        /** 「LIVE」表示を示す要素のセレクター。 */
        const LIVE = '[data-a-target="player-info-live-indicator"], .live-time';

        /** 遅延を追跡し、巻き戻し視聴中かどうかを判定する道具。 */
        const latency = tracker();

        /** @type {object|null} Twitch プレーヤーの実体（React の中から探し出したもの） */
        let core = null;
        /** @type {number} 最後に core を探した時刻 */
        let coreAt = -Infinity;
        /** @type {number} 最後に Twitch 独自の自動加速を無効化した時刻 */
        let tamedAt = -Infinity;

        /** @type {object|null} setSrc を持つ React コンポーネント（Twitch 内部の player-source） */
        let source = null;
        /** @type {number} 最後に source を探した時刻 */
        let sourceAt = -Infinity;
        /** @type {number} 最後に異常の有無を確かめた時刻 */
        let pollAt = -Infinity;
        /** @type {number} 異常を最初に見つけた時刻。異常が無ければ NaN */
        let brokenAt = NaN;
        /** @type {number} 最後に復帰を試みた時刻 */
        let healAt = -Infinity;
        /** @type {number} 今回の異常で復帰を試みた回数 */
        let tries = 0;
        /** @type {number} 正常な再生が続き始めた時刻。途切れていれば NaN */
        let goodAt = NaN;

        /**
         * 覚えていた情報をすべて忘れる。
         * 配信やチャンネルが切り替わったとき、前の配信のデータを引きずらないために呼びます。
         *
         * ■ 復帰の試行回数（tries）をここで消さない理由
         *   復帰に成功すると <video> が入れ替わり、onSwap 経由でこの関数が呼ばれます。
         *   ここで回数を 0 に戻すと「復帰する → また落ちる → また復帰する」を
         *   無限に繰り返せてしまいます。回数を忘れるのは heal() の中、
         *   正常な再生が一定時間続いたときだけです。
         * @returns {void}
         */
        const forget = () => {
            core = null;
            coreAt = -Infinity;
            tamedAt = -Infinity;
            source = null;
            sourceAt = -Infinity;
            latency.reset();
        };

        // <video> 要素の入れ替わりを見張る共通部品（shared/util.js 参照）。
        const watcher = videoWatcher({
            roots: ROOTS,
            onSwap: forget,                  // 動画が入れ替わったら全部忘れる
            onStall: () => latency.reset(),  // 再生が詰まったら遅延の記録をやり直す
        });

        /**
         * React の内部ツリーを辿って、Twitch プレーヤーの実体を探し出す。
         *
         * ■ 探し方は 2 段階
         *   1) 上へ（先祖方向）最大 30 階層。実体は普通プレーヤーの親側にあるので、まずこちらを試す。
         *   2) 下へ（子孫方向）最大 3000 ノード。上で見つからなかったときの保険。
         *
         *   どちらも探索量に上限を設けているのは、React のツリーが巨大な場合に
         *   探索でページを固まらせないためです（無限ループ対策も兼ねています）。
         * @returns {object|null} プレーヤー実体。見つからなければ null
         */
        function search() {
            const root = watcher.root;

            // React は DOM 要素に `__reactFiber$xxxxx` という名前のプロパティを付けます。
            // 末尾のランダム文字列は毎回変わるので、前方一致で探します。
            const key = root && Object.keys(root).find((name) => name.startsWith('__reactFiber$'));
            const fiber = key ? root[key] : null;
            if (!fiber) return null;

            /**
             * 1 つのノードからプレーヤー実体を取り出す試み。
             * Twitch のバージョンによって置き場所が 2 通りあるため、両方を確認します。
             * @param {object|null|undefined} node React の内部ノード
             * @returns {object|null} 見つかった実体、または null
             */
            const of = (node) =>
                node?.memoizedProps?.mediaPlayerInstance ?? node?.stateNode?.props?.mediaPlayerInstance ?? null;

            // (1) 先祖方向へ辿る。node.return が「親ノード」を指します。
            for (let node = fiber, i = 0; node && i < 30; node = node.return, i++) {
                const hit = of(node);
                if (hit) return hit;
            }

            // (2) 子孫方向へ辿る（深さ優先探索）。
            // stack に「これから調べるノード」を積み、pop() で 1 つずつ取り出します。
            // budget は調べる回数の上限で、これが尽きたら諦めます。
            const stack = fiber.child ? [fiber.child] : [];
            for (let budget = 3000; stack.length && budget > 0; budget--) {
                const node = stack.pop();
                const hit = of(node);
                if (hit) return hit;
                if (node.sibling) stack.push(node.sibling); // 兄弟ノード
                if (node.child) stack.push(node.child);     // 子ノード
            }
            return null;
        }

        /**
         * プレーヤー実体のメソッドを安全に呼び出す。
         * 実体をまだ持っていなければ、SEARCH_MS 間隔で探索を試みます。
         * @param {string} name 呼び出すメソッド名
         * @param {*} fallback 呼べなかった場合に返す値
         * @param {...unknown} args 渡す引数
         * @returns {*} 戻り値、または fallback
         */
        function ask(name, fallback, ...args) {
            const now = performance.now();
            if (!core && now - coreAt >= SEARCH_MS) {
                coreAt = now;
                try { core = search(); } catch { }
            }
            return safeCall(core, name, fallback, ...args);
        }

        /**
         * setSrc を持つ React コンポーネントを、#root から辿って探す。
         *
         * ■ なぜ #root から探すのか
         *   このコンポーネントはプレーヤー要素のはるか上流にあり、
         *   search() のようにプレーヤーの周辺だけを見る探索では届きません。
         *   ツリー全体を対象にする必要があります。
         *
         * setInitialPlaybackSettings も併せ持つものを本命とし、見つからなければ
         * setSrc だけを持つものを代わりに使います。Twitch 側の作りが変わって
         * 片方のメソッドが消えても、完全に手詰まりにならないようにするためです。
         * @returns {object|null} 見つかったコンポーネント。無ければ null
         */
        function findSource() {
            const host = document.getElementById('root');
            if (!host) return null;

            // React はツリーの根を __reactContainer$xxxxx という名前で置きます。
            // 末尾のランダム文字列は毎回変わるので、前方一致で探します。
            const key = Object.keys(host).find((name) =>
                name.startsWith('__reactContainer$') || name.startsWith('__reactFiber$'));
            const fiber = key ? host[key] : null;
            if (!fiber) return null;

            let loose = null;
            const stack = [fiber];
            for (let budget = SOURCE_BUDGET; stack.length && budget > 0; budget--) {
                const node = stack.pop();
                const inst = node.stateNode;
                if (typeof inst?.setSrc === 'function') {
                    if (typeof inst.setInitialPlaybackSettings === 'function') return inst;
                    loose ??= inst;
                }
                if (node.sibling) stack.push(node.sibling);
                if (node.child) stack.push(node.child);
            }
            return loose;
        }

        /**
         * setSrc コンポーネントを、探索間隔を守りながら取得する。
         * 探索はツリー全体を歩くため重く、見つからないときに探し続けないよう制限しています。
         * @returns {object|null} コンポーネント。見つからなければ null
         */
        function sourceOf() {
            const now = performance.now();
            if (!source && now - sourceAt >= SOURCE_MS) {
                sourceAt = now;
                try { source = findSource(); } catch { source = null; }
            }
            return source;
        }

        /**
         * 「エラー #3000」などのゲートが出ていれば、その要素を返す。
         *
         * ■ video.error を見ない理由
         *   このエラーで止まったとき、<video> は error が立つのではなく中身を空にされます
         *   （readyState も networkState も 0 になります）。MediaError では検知できないため、
         *   画面に出る番号を手がかりにします。
         * @returns {Element|null} ゲート要素。異常が無ければ null
         */
        function fault() {
            const gate = pick([GATE], watcher.root);
            return gate && CODE.test(gate.textContent ?? '') ? gate : null;
        }

        /**
         * 復帰を 1 回試みる。回数が増えるほど強い手を使います。
         * @param {Element} gate エラーゲートの要素
         * @param {number} n 今回が何回目の試行か（1 から始まる）
         * @returns {string} 何をしたかを表す短い文字列（デバッグログ用）
         */
        function attempt(gate, n) {
            const button = gate.querySelector('button');

            // 前半は Twitch 純正の再読み込みボタンを押します。実測で 1 秒未満に復帰します。
            // ボタンの文言は言語ごとに変わるため、「ゲートの中の button」という構造で拾います。
            if (button && n <= HEAL_CLICKS) { safeCall(button, 'click', null); return `click #${n}`; }

            // それでも直らなければ、React 側にソースを張り直させます。
            const inst = sourceOf();
            if (inst) {
                const done = safeCall(inst, 'setSrc', null, { isNewMediaPlayerInstance: false });
                // 戻り値は Promise です。拒否されたときに未処理の警告が出ないよう受けておきます。
                if (typeof done?.catch === 'function') done.catch(() => { });
                return `setSrc #${n}`;
            }

            if (button) { safeCall(button, 'click', null); return `click #${n}`; }
            return `giveup #${n}`;
        }

        /**
         * プレーヤーが落ちていないかを見張り、必要なら復帰を試みる。
         *
         * ■ すぐに手を出さない理由
         *   落ちた直後は Twitch 自身が立ち直ることがあります。そこへ割り込むと
         *   互いの復帰処理がぶつかるため、まず HEAL_WAIT[0] だけ待ちます。
         *   以降も間隔を広げながら数回だけ試し、駄目なら諦めます。
         * @returns {string|null} 検知または試行をしたときだけ、その内容を表す文字列
         */
        function heal() {
            const now = performance.now();
            if (now - pollAt < HEAL_POLL_MS) return null;
            pollAt = now;

            const gate = fault();

            // --- 異常なし ---
            if (!gate) {
                const node = watcher.video;
                if (!node || node.error || node.readyState < 3) { goodAt = NaN; return null; }

                // 正常な再生が続いたら、今回の異常のことは忘れます。
                if (Number.isNaN(goodAt)) goodAt = now;
                if (now - goodAt >= HEAL_CLEAR_MS) { brokenAt = NaN; tries = 0; }
                return null;
            }

            // --- 異常あり ---
            goodAt = NaN;

            // 広告中は触りません。広告の差し替えで一瞬ゲートが出ることがあるためです。
            if (document.querySelector(ADS)) return null;

            // 見つけた最初の 1 回は記録だけして様子を見ます。
            if (Number.isNaN(brokenAt)) {
                brokenAt = now;
                healAt = now;
                return 'detected';
            }

            if (tries >= HEAL_WAIT.length) return null;
            if (now - healAt < HEAL_WAIT[tries]) return null;

            healAt = now;
            tries += 1;
            return attempt(gate, tries);
        }

        return {
            // Twitch のプレーヤー UI には速度変更メニューがないため、
            // ユーザーの手動設定を気にする必要がありません。
            respectUserRate: false,

            // Twitch は広告などでバッファに大きな隙間ができるため、許容を広く（5 秒）とります。
            gap: 5,

            badgeClass: '',
            badgeStyle: BADGE_STYLE_PLAIN,

            reset: forget,
            root: () => watcher.root,

            /**
             * エラーで止まったプレーヤーを復帰させる。
             * このアダプターにだけある任意のメソッドで、inject.js は
             * 持たないサイト（YouTube・ツイキャス）では呼びません。
             */
            heal,

            /**
             * 現在の <video> 要素を返す。
             *
             * ついでに、Twitch 自身が持っている自動加速機能を無効化します（等倍に固定）。
             * これを放置すると、Twitch とこの拡張機能が同時に速度を操作して
             * 互いに邪魔をしてしまうためです。定期的にやり直すのは、
             * Twitch 側が独自に設定し直してくることがあるからです。
             * @returns {HTMLVideoElement|null}
             */
            video() {
                const node = watcher.find();
                const now = performance.now();
                if (node && now - tamedAt >= TAME_MS) {
                    tamedAt = now;
                    ask('setLiveSpeedUpRate', null, 1.0);
                }
                return node;
            },

            /**
             * 現在再生中のメディアの情報を返す。
             *
             * Twitch には「これはライブです」と直接教えてくれる API が無いので、
             * 複数の手がかりを組み合わせて推測します。
             * @returns {{ id: string, live: boolean }}
             */
            media() {
                const login = ask('getLoadedChannelLogin', null); // チャンネル名
                const duration = watcher.video?.duration ?? NaN;

                // ライブ配信は動画の長さが極端に大きくなる、または取得できない（NaN）。
                const endless = duration >= ENDLESS;
                const unknown = Number.isNaN(duration);

                // URL から「録画（VOD）やクリップのページか」を判定します。
                //   clips.twitch.tv     … クリップ専用ドメイン
                //   player.twitch.tv    … 埋め込み。?video= や ?collection= が付いていれば録画
                //   www.twitch.tv       … /videos/123 や /チャンネル名/video/123 なら録画
                const vod = location.hostname.startsWith('clips.')
                    || (location.hostname === 'player.twitch.tv'
                        ? /[?&](video|collection)=/.test(location.search)
                        : /^\/(videos\/|[^/]+\/(video|clip)\/)/.test(location.pathname));

                // 総合判定：録画でなく、長さが無限（か不明）で、広告中でもなく、
                // かつ「LIVE 表示がある」「チャンネル名が取れる」のいずれかを満たすこと。
                const live = !vod && (endless || unknown) && !document.querySelector(ADS)
                    && (endless || Boolean(document.querySelector(LIVE)) || Boolean(login));

                // 識別子は「URL ＋ チャンネル名」。これが変われば別の配信と判断されます。
                const path = location.hostname === 'player.twitch.tv' ? location.search : location.pathname;
                return {
                    id: `${path}|${login ?? ''}`.toLowerCase(),
                    live,
                };
            },

            /**
             * 現在の遅延と、ライブ最前線にいるかを返す。
             * Twitch は atHead を教えてくれないので、tracker で自前に推定します。
             * @returns {{ latency: number, atHead: boolean }}
             */
            status: () => latency.read(toNum(ask('getLiveLatency', NaN))),

            /**
             * このサイトが必要とするバッファの目安（秒）を返す。
             * 低遅延モードなら短いセグメント（約 2 秒）、通常モードなら約 4 秒。
             * @returns {number}
             */
            needs: () => (ask('isLiveLowLatency', true) === true ? 2 : 4),

            /**
             * バッジを差し込みたい場所（コントロールバー左側）を返す。
             * @returns {Element|null}
             */
            host: () => pick(['.player-controls__left-control-group'], watcher.root),
        };
    }

    // このアダプターを「twitch」という ID で登録する。
    registerSite('twitch', /(^|\.)twitch\.tv$/, twitch);
})();
