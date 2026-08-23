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

        /**
         * 覚えていた情報をすべて忘れる。
         * 配信やチャンネルが切り替わったとき、前の配信のデータを引きずらないために呼びます。
         * @returns {void}
         */
        const forget = () => {
            core = null;
            coreAt = -Infinity;
            tamedAt = -Infinity;
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
            host: () => pick(['.player-controls__left-control-group'], watcher.root ?? document),
        };
    }

    // このアダプターを「twitch」という ID で登録する。
    registerSite('twitch', /(^|\.)twitch\.tv$/, twitch);
})();
