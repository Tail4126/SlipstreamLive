// SPDX-License-Identifier: Apache-2.0 OR MIT
/* ================================================================================================
 * adapters/twitch.js — Twitch 用のプレイヤー操作アダプタ
 *
 * 【どこから呼ばれるか】
 *   manifest.json の content_scripts（MAIN world）から adapters/youtube.js の次に読み込まれ、
 *   自動実行されて registerSite() で自己登録するだけ。
 *   実際にアダプタが作られるのは inject.js がホスト名を照合して create() を呼んだとき。
 *
 * 【Twitch ならではの事情】
 *   Twitch は YouTube と違い、公式のプレイヤー JavaScript API を一切公開していない。
 *   そこでページが React 製であることを利用し、React が内部で持つコンポーネントの木構造
 *   （Fiber ツリー）を自力でたどって、再生を司る中核オブジェクト mediaPlayerInstance を
 *   引きずり出している。当然これは非公式な手段なので、Twitch の実装変更で
 *   いつ壊れてもおかしくない。壊れても全体が停止しないよう、呼び出しはすべて
 *   safeCall() 経由にし、取得できなければ静かに既定動作へ落ちるようにしてある。
 *
 * 【もう一つの特徴】
 *   Twitch 自身も「遅れたら少し早送りして追いつく」機能（setLiveSpeedUpRate）を持っている。
 *   本拡張と同時に働くと速度の奪い合いになるため、定期的に Twitch 側の倍率を 1.0 へ戻している。
 * ================================================================================================ */
(() => {
    'use strict';

    const util = globalThis.__slipstreamliveUtil;
    if (!util) return;                              // 読み込み順が壊れている場合は登録せず終了

    const { pick, tracker, toNum, safeCall, videoWatcher, registerSite,
        ENDLESS, BADGE_STYLE_PLAIN } = util;

    const SEARCH_MS = 1000;                         // 中核オブジェクトの再探索を試みる最小間隔（ミリ秒）
    const TAME_MS = 2000;                           // Twitch 側の自動加速倍率を 1.0 へ戻す間隔（ミリ秒）

    /**
     * Twitch 用アダプタの本体を生成する。
     *
     * @returns {Object} inject.js が使うアダプタ
     */
    function twitch() {
        /* --- DOM セレクタ ---------------------------------------------------------------------- */

        // プレイヤーのルート候補（優先度順）
        const ROOTS = ['div[data-a-target="video-player"]', '.video-player__container', '.persistent-player'];

        // 広告再生中に現れる要素。1 つでも見つかればライブ映像ではないと判断する
        const ADS = '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], .video-player__ad-container';

        // ライブ配信中であることを示す UI（赤い LIVE バッジや経過時間表示）
        const LIVE = '[data-a-target="player-info-live-indicator"], .live-time';

        /* --- 内部状態 -------------------------------------------------------------------------- */

        // 遅延の基準線トラッカー。追っかけ再生中かどうかの判定に使う
        const latency = tracker();

        // React の Fiber ツリーから掘り出した mediaPlayerInstance（Twitch の再生制御オブジェクト）
        let core = null;

        // 前回 core を探索した時刻（ミリ秒）。失敗し続けても毎 tick 探索して重くならないようにする
        let coreAt = -Infinity;

        // 前回 Twitch 側の自動加速を抑え込んだ時刻（ミリ秒）
        let tamedAt = -Infinity;

        /**
         * 掴んでいる内部参照と探索キャッシュをすべて捨てる。
         * 配信が切り替わったりプレイヤーが作り直されたりすると、古い core は無効になるため。
         *
         * @returns {void}
         */
        const forget = () => {
            core = null;
            coreAt = -Infinity;
            tamedAt = -Infinity;
            latency.reset();
        };

        // プレイヤールートと <video> の追跡役（shared/util.js が提供）
        const watcher = videoWatcher({
            roots: ROOTS,
            onSwap: forget,
            onStall: () => latency.reset(),         // 読み込み停止後は遅延が跳ねるので基準線を引き直す
        });

        /**
         * React の Fiber ツリーをたどって mediaPlayerInstance を探し出す。
         *
         * React は各 DOM 要素に __reactFiber$xxxx という隠しプロパティを付けており、
         * そこから内部のコンポーネント構造へ入っていける。手順は次の 3 段階。
         *
         *   1. プレイヤーのルート DOM から __reactFiber$ で始まるプロパティを見つけ、入口とする
         *   2. まず親方向（return を辿る鎖）へ最大 30 段さかのぼる。目的の値は親側にあることが多い
         *   3. それでも無ければ子孫方向へ深さ優先で最大 3000 ノード探索する
         *
         * 30 段・3000 ノードという上限は、構造が変わって当たらなくなったときに
         * 無限に探し続けてページを固まらせないための安全弁である。
         *
         * @returns {Object|null} mediaPlayerInstance。見つからなければ null
         */
        function search() {
            const root = watcher.root;
            const key = root && Object.keys(root).find((name) => name.startsWith('__reactFiber$'));
            const fiber = key ? root[key] : null;
            if (!fiber) return null;

            // 1 つの Fiber ノードから mediaPlayerInstance を取り出す試み（2 通りの置き場所を見る）
            const of = (node) =>
                node?.memoizedProps?.mediaPlayerInstance ?? node?.stateNode?.props?.mediaPlayerInstance ?? null;

            for (let node = fiber, i = 0; node && i < 30; node = node.return, i++) {
                const hit = of(node);
                if (hit) return hit;
            }

            // 深さ優先探索。stack に子と兄弟を積みながら、budget（探索回数の予算）が尽きるまで回す
            const stack = fiber.child ? [fiber.child] : [];
            for (let budget = 3000; stack.length && budget > 0; budget--) {
                const node = stack.pop();
                const hit = of(node);
                if (hit) return hit;
                if (node.sibling) stack.push(node.sibling);
                if (node.child) stack.push(node.child);
            }

            return null;
        }

        /**
         * core のメソッドを安全に呼ぶ。core をまだ掴めていなければ、
         * SEARCH_MS 間隔を空けて再探索を試みる（毎 tick 探索すると重いため）。
         *
         * @param {string} name - メソッド名
         * @param {any} fallback - 呼べなかったときに返す値
         * @param {...any} args - メソッドへ渡す引数
         * @returns {any} 戻り値、または fallback
         */
        function ask(name, fallback, ...args) {
            const now = performance.now();
            if (!core && now - coreAt >= SEARCH_MS) {
                coreAt = now;
                try { core = search(); } catch { }  // 構造変更で例外が出ても握り潰して次回に賭ける
            }
            return safeCall(core, name, fallback, ...args);
        }

        return {
            // Twitch のプレイヤーには速度変更 UI が無く、代わりにプレイヤー自身が勝手に速度調整する。
            // 「ユーザーが選んだ速度」という概念が存在しないため、本拡張の制御を無条件に優先する
            respectUserRate: false,

            // 広告明けなどで生じるバッファの隙間は大きめなので、許容値も広く取る（秒）
            gap: 5,

            badgeClass: '',                         // 流用できる Twitch のボタン用クラスが無い
            badgeStyle: BADGE_STYLE_PLAIN,          // 代わりに素のスタイルを直接あてる

            reset: forget,

            /**
             * バッジの器となるプレイヤールート要素を返す。
             *
             * @returns {Element|null}
             */
            root: () => watcher.root,

            /**
             * 監視対象の <video> を取得する。
             * あわせて Twitch 自身の追いつき機能（setLiveSpeedUpRate）が働かないよう、
             * TAME_MS 間隔で倍率を 1.0 へ固定し直す。これを怠ると、Twitch と本拡張が
             * 交互に速度を書き換えて映像がガタつく「速度の奪い合い」が起きる。
             *
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
             * メディアの識別 ID とライブ配信かどうかを判定する。
             * Twitch は公式の「ライブ判定 API」が無いため、複数の手がかりを組み合わせる。
             *
             *   live = VOD ではない
             *          && （尺が未確定 || メタデータ未ロード）
             *          && 広告中ではない
             *          && （尺が未確定 || ライブ UI がある || チャンネル情報が取れている）
             *
             * 尺（duration）が未確定というのは「終わりが決まっていない＝配信中」を意味する。
             * ただしメタデータ読み込み前は duration が NaN になるだけなので、
             * その場合はライブ UI やチャンネル情報という別の証拠を要求している。
             *
             * @returns {{ id: string, live: boolean }}
             */
            media() {
                const login = ask('getLoadedChannelLogin', null);        // 配信者のチャンネル名
                const duration = watcher.video?.duration ?? NaN;         // 動画の尺（秒）

                const endless = duration >= ENDLESS;                     // 尺が未確定＝ライブの強い証拠
                const unknown = Number.isNaN(duration);                  // メタデータ未ロード（判定保留）

                // URL から VOD（録画）やクリップを判定する。これらはライブではないので制御対象外
                const vod = location.hostname.startsWith('clips.')
                    || (location.hostname === 'player.twitch.tv'
                        ? /[?&](video|collection)=/.test(location.search)
                        : /^\/(videos\/|[^/]+\/(video|clip)\/)/.test(location.pathname));

                const live = !vod && (endless || unknown) && !document.querySelector(ADS)
                    && (endless || Boolean(document.querySelector(LIVE)) || Boolean(login));

                // 埋め込みプレイヤーはパスが固定なので、代わりにクエリ文字列で区別する
                const path = location.hostname === 'player.twitch.tv' ? location.search : location.pathname;
                return {
                    id: `${path}|${login ?? ''}`.toLowerCase(),
                    live,
                };
            },

            /**
             * 遅延（秒）を取得し、基準線トラッカーを通して追っかけ再生の判定を付けて返す。
             *
             * @returns {{ latency: number, atHead: boolean }}
             */
            status: () => latency.read(toNum(ask('getLiveLatency', NaN))),

            /**
             * 自動しきい値が使う目安バッファ量（秒）。
             * Twitch は配信ごとに低遅延モードの有無が違うため、それに合わせて 2 秒 / 4 秒を返す。
             *
             * @returns {number} 目安となるバッファ量（秒）
             */
            needs: () => (ask('isLiveLowLatency', true) === true ? 2 : 4),

            /**
             * バッジを差し込むコントロールバー内のスロットを探す。
             *
             * @returns {Element|null}
             */
            host: () => pick(['.player-controls__left-control-group'], watcher.root ?? document),
        };
    }

    registerSite('twitch', /(^|\.)twitch\.tv$/, twitch);
})();
