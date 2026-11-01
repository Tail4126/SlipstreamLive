// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * adapters/dazn.js — DAZN 専用の「アダプター」
 * =============================================================================
 *
 * ■ このサイトだけ読み込まれ方が違う
 *   YouTube・Twitch・ツイキャス・TikTok と違い、DAZN のスクリプトは manifest に書いていません。
 *   ユーザーが設定画面の「このサイトで有効にする」で www.dazn.com へのアクセスを許可したときに、
 *   background.js が scripting.registerContentScripts() で
 *   「shared/util.js → このファイル → inject.js」を MAIN world に登録します（並びは manifest と同じ）。
 *   許可が無いあいだは、このファイルはどのページにも読み込まれません。
 *
 * ■ DAZN のプレーヤー
 *   Web 版の DAZN は、自社のプレーヤー（peng）の中で dash.js を使って MPEG-DASH を再生します。
 *   peng はプレーヤーの外枠を次の形で組み立て、<video> は PLAYER_SOLUTION の中に置きます。
 *
 *     div.player-root[data-test-id="PLAYER_ROOT"]
 *       ├ div.player-solution[data-test-id="PLAYER_SOLUTION"] … ここに <video>
 *       ├ div.player-ui[data-test-id="PLAYER_UI"]
 *       └ div.ad-wta
 *
 *   data-test-id とクラス名のどちらかが残っていれば見つけられるよう、両方で探します。
 *   複数の試合を並べて見る「マルチビュー」では外枠が並ぶので、いちばん大きく映っていて
 *   音が出ている <video> を選びます（音を出している試合が、いま見ている試合のため）。
 *
 * ■ ライブ判定と遅延について
 *   - DAZN のライブは、動画の長さ（duration）が 2^32 秒という極端に大きな値になります
 *     （ふつうの dash.js では Infinity）。見逃し配信やハイライトは長さが決まっているので、
 *     長さが ENDLESS 以上のものだけをライブとします。
 *   - DAZN のライブの多くは、再生位置（currentTime）が「1970 年からの経過秒数」にそろっています。
 *     そこで遅延は「今の時刻 − 再生位置」、つまり現実の時刻から何秒遅れて見ているかを表示します
 *     （YouTube・Twitch の配信元からの遅延に相当）。再生位置がそろっていないチャンネルでは、
 *     「受信済みの末尾 − 再生位置」を表示します（TikTok と同じ。求め方の詳細は lag() を参照）。
 *   - DAZN のライブは巻き戻し（「最初から見る」など）ができるので、最前線にいるかどうかは
 *     tracker で推定します（ツイキャス・Twitch と同じ）。ただし「受信済みの末尾 − 再生位置」で
 *     求めているときは巻き戻しを見分けられないため、常に最前線にいるものとして扱います。
 *   - 必要なバッファの目安（needs）は、バッファの末尾が 1 回に伸びる幅（＝セグメント 1 個の長さ）
 *     を測って求めます。DAZN は配信によって低遅延の設定を使い分けているため、決め打ちにしていません。
 *
 * ■ DAZN で加速すると何が起きるか（実測）
 *   DAZN の dash.js は、配信の最新地点がずっと先にあっても、バッファを約 12 秒までしか先読みしません。
 *   そのため加速しても、最前線に追いつくまではバッファが減らず（dash.js が読み足すため）、
 *   遅延だけが縮みます。2026 年 10 月にライブ TV（NFL Network）で試すと、開いた直後に約 40 秒だった
 *   遅延が、約 1 分半で約 19 秒まで縮み、そこから先はバッファが 1〜4 秒になって通常速度に落ち着きました。
 *
 * ■ バッジの位置
 *   コントロールバー下段の左側（再生・10 秒戻し・音量・現在時刻）の末尾に並べます（host() を参照）。
 *   コントロールバーはマウスを乗せたときだけ表示されるので、バッジも一緒に現れたり隠れたりします。
 *
 * ■ アダプターの役割については adapters/youtube.js の冒頭コメントを参照。
 */
(() => {
    'use strict';

    const util = globalThis.__slipstreamliveUtil;
    if (!util) return;

    const { tracker, registerSite, ENDLESS, BADGE_STYLE_PLAIN } = util;

    /** このアダプターを使うホスト名。 */
    const HOST = /(^|\.)dazn\.com$/;

    /** プレーヤーの外枠（peng の PLAYER_ROOT）。 */
    const ROOT = '[data-test-id="PLAYER_ROOT"], .player-root';

    /** 本編の <video>（peng の PLAYER_SOLUTION の中）。 */
    const VIDEOS = '[data-test-id="PLAYER_SOLUTION"] video, .player-solution video';

    /**
     * コントロールバーの中の、現在時刻の表示と音量ボタン。
     * DAZN の data-test-id は「VOLUME_BUTTON VOLUME_BUTTON_UNMUTED」のように状態を表す語が
     * 空白区切りで続くため、`~=`（空白で区切られた語のどれかが一致）で探します。
     * クラス名は自動生成で変わるため使いません。
     */
    const TIME   = '[data-test-id~="CURRENT_TIME"]';
    const VOLUME = '[data-test-id~="VOLUME_BUTTON"]';

    /** 現在時刻の表示から、ボタンが並ぶ箱まで何階層まで上へたどるか。 */
    const CLIMB = 4;

    /** つかんでいる video が健在でも、念のため探し直す間隔（ミリ秒）。 */
    const RECHECK_MS = 500;

    /**
     * 再生位置が「1970 年からの経過秒数」（世界の時計）にそろっているとみなす下限（秒）。
     * DAZN のライブは、再生位置がそのまま現在時刻（例: 1793385642 秒 ＝ 2026 年 10 月）になっています。
     * 10 億秒は 2001 年 9 月で、ふつうの番組の長さとは桁が違うため、取り違えません。
     */
    const EPOCH_MIN = 1e9;

    /**
     * 世界の時計で求めた遅延を信じる範囲（秒）。
     * 端末の時計は少しずれていることがあるため、わずかなマイナスまでは許して 0 に丸めます。
     * 大きくずれているとき（範囲の外）は、時計を使わない求め方に切り替えます。
     */
    const WALL_MIN = -5;
    const WALL_MAX = 86400;

    /**
     * セグメント 1 個の長さがまだ測れていないときに使う値（秒）。
     * DAZN の DASH は 2 秒前後の短いセグメントで届くため、2 秒にしています
     * （2026 年 10 月にライブ TV で測ると、チャンネルによって 2.0 秒と 2.6 秒でした）。
     */
    const SEGMENT_GUESS = 2;

    /**
     * バッファの末尾の伸びを「セグメント 1 個ぶん」として数える幅（秒）の範囲。
     * 小さすぎる伸びは、音声と映像の届く時刻のずれで生じる端数です。
     * 大きすぎる伸びは、シークの直後などで、セグメントの長さとは関係ありません。
     */
    const STEP_MIN = 0.2;
    const STEP_MAX = 15;

    /** 伸び幅を何回ぶん覚えておくか（その中央値をセグメントの長さとみなします）。 */
    const STEP_KEEP = 9;

    /** 中央値を使い始めるのに必要な記録の数。 */
    const STEP_MIN_N = 3;

    /**
     * 要素のうち、画面内に見えている部分の面積を求める（adapters/tiktok.js と同じ考え方）。
     * @param {Element} node 対象の要素
     * @returns {number} 見えている面積（ピクセル²）。見えていなければ 0
     */
    function area(node) {
        const rect   = node.getBoundingClientRect();
        const width  = Math.min(rect.right, innerWidth) - Math.max(rect.left, 0);
        const height = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
        return width > 0 && height > 0 ? width * height : 0;
    }

    /**
     * 数値の配列の中央値を求める（元の配列は並べ替えません）。
     * @param {number[]} values 値の配列（空でないこと）
     * @returns {number} 中央値
     */
    function median(values) {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * DAZN 用アダプターを生成する。
     * @returns {object} アダプターオブジェクト
     */
    function dazn() {
        /** @type {HTMLVideoElement|null} 現在の video 要素 */
        let video   = null;
        /** @type {number} 最後に video を探した時刻 */
        let checkAt = -Infinity;

        /**
         * @type {object|string|null} 最後に見た再生ソース（srcObject、無ければ currentSrc の blob: URL）。
         * 同じ <video> のまま別の配信へ切り替わったことに気付くために使います。
         */
        let source  = null;
        /** @type {number} 再生ソースが入れ替わった回数。media() の id に混ぜて、配信の切り替わりを知らせます */
        let swaps   = 0;

        /** @type {number} 前回見たバッファの末尾（秒）。セグメントの長さを測るのに使います */
        let edge    = NaN;
        /** @type {number[]} 直近の「バッファの末尾の伸び幅」（秒） */
        const steps = [];

        /** 遅延を追跡し、巻き戻し視聴中かどうかを判定する道具。 */
        const latency = tracker();

        /**
         * @type {string} 直前に遅延を求めた方法（'wall' / 'seekable' / 'buffer'。まだ無ければ ''）。
         * 方法が変わったら、tracker が覚えている最小値は比べ物にならないので捨てます。
         */
        let method = '';

        /**
         * media() / status() の結果の入れ物。制御ループから頻繁に呼ばれるので、
         * 呼ぶたびに作らず中身だけ書き換えて返します。
         */
        const current = { id: '', live: false };
        const stat    = { latency: NaN, atHead: true };

        /**
         * 再生が詰まったとき（waiting イベント）に、遅延の記録をやり直す。
         * 詰まっている間は遅延が伸びるので、そのまま比べると「巻き戻して見ている」と取り違えるためです
         * （videoWatcher を使うツイキャス・Twitch と同じ扱い。ユーザー操作のシーク中は除きます）。
         * @returns {void}
         */
        const stalled = () => {
            if (video && !video.seeking) latency.reset();
        };

        /**
         * 本編の video を探す。毎フレーム呼ばれます。
         *
         * 探し直しは、つかんでいる video がページから外れたときと、RECHECK_MS ごとだけです。
         * 画面に映っている面積が大きいものを選び、止まっているもの・音を消しているものは
         * 面積を半分に見積もります（マルチビューで、いま音を出して見ている試合を選ぶため）。
         * peng の外枠が見つからないときは、ページ全体の <video> から選びます
         * （DAZN が外枠の印を変えても、ひとまず動き続けられるようにするため）。
         * @returns {HTMLVideoElement|null} 見つかった video 要素
         */
        function find() {
            const now = performance.now();
            if (video?.isConnected && now - checkAt < RECHECK_MS) return video;
            checkAt = now;

            let nodes = document.querySelectorAll(VIDEOS);
            if (!nodes.length) nodes = document.querySelectorAll('video');

            let best = null;
            let size = 0;
            for (const node of nodes) {
                const value = area(node) * (node.paused ? 0.5 : 1) * (node.muted ? 0.5 : 1);
                if (value > size) { best = node; size = value; }
            }

            // 画面内に見えるものが無ければ、つかんでいる video を（まだページにあれば）使い続けます。
            const next = best ?? (video?.isConnected ? video : null);

            // 入れ替わったら、詰まりの見張りを新しい video に付け替えます（古い要素に残すとメモリを手放せないため）。
            if (next !== video) {
                video?.removeEventListener('waiting', stalled);
                video = next;
                video?.addEventListener('waiting', stalled);
            }
            return video;
        }

        /**
         * バッファの末尾がどれだけ伸びたかを記録する（セグメントの長さを測るため）。
         *
         * dash.js はセグメントを 1 個ずつ追加するので、バッファの末尾は「セグメント 1 個の長さ」
         * ずつ階段状に伸びます。その段差を記録しておき、needs() が中央値を使います。
         * @returns {void}
         */
        function measure() {
            let end = NaN;
            try {
                const ranges = video?.buffered;
                if (ranges?.length) end = ranges.end(ranges.length - 1);
            } catch {
                end = NaN;
            }
            const grew = end - edge;
            if (grew >= STEP_MIN && grew <= STEP_MAX) {
                steps.push(grew);
                if (steps.length > STEP_KEEP) steps.shift();
            }
            edge = end;
        }

        /**
         * 遅延（秒）と、最前線にいるかを求める。3 つの求め方を、使えるものから順に試します。
         *
         *   1) 世界の時計 … 「今の時刻 − 再生位置」。
         *      DAZN のライブの多くは、再生位置が「1970 年からの経過秒数」にそろっています（MPD の
         *      availabilityStartTime が 1970 年）。そのため、この差がそのまま「現実の時刻から何秒
         *      遅れて見ているか」になります（dash.js の getCurrentLiveLatency() と同じ考え方で、
         *      YouTube・Twitch で表示している配信元からの遅延に相当します）。
         *      2026 年 10 月に DAZN のライブ TV（NFL Network）で測ると、開いた直後は約 40 秒で、
         *      加速して最前線に追いつくと約 19 秒になりました。
         *   2) シーク可能範囲 … 「範囲の末尾 − 再生位置」（ツイキャスと同じ）。
         *      DAZN の dash.js は、ライブでも範囲を [0, 2^32] にしていて末尾が配信の最新地点を
         *      表さないため、末尾が ENDLESS より小さい（本当の範囲らしい）ときだけ使います。
         *   3) バッファ … 「受信済みの末尾 − 再生位置」（TikTok と同じ）。最後の手段です。
         *      再生位置が 1970 年基準でないチャンネル（同じ月に測ると、ライブ TV の一部のチャンネルは
         *      再生位置が約 5,400 万秒でした）では、ここに来ます。
         *
         * 1) と 2) は配信の最新地点からの遅れなので、tracker で巻き戻し視聴（DVR）を見分けます。
         * 3) はバッファが溜まるだけで伸びる値で、巻き戻しとは関係なく増減するため、比べずに
         * 常に「最前線にいる」として返します（そうしないと、読み込み始めに溜まっていく
         * バッファを巻き戻しと取り違え、(DVR) と表示してしまいます）。
         * @returns {{ latency: number, atHead: boolean }} 結果の入れ物（使い回します）
         */
        function lag() {
            let how = '';
            let value = NaN;
            try {
                const node = video;
                const at = node?.currentTime ?? NaN;

                if (at > EPOCH_MIN) {
                    const wall = Date.now() / 1000 - at;
                    if (wall >= WALL_MIN && wall <= WALL_MAX) { how = 'wall'; value = Math.max(0, wall); }
                }

                if (!how && node) {
                    const seekable = node.seekable;
                    const end = seekable.length ? seekable.end(seekable.length - 1) : NaN;
                    if (end < ENDLESS && end >= at) { how = 'seekable'; value = end - at; }
                }

                if (!how && node) {
                    const buffered = node.buffered;
                    how   = 'buffer';
                    value = buffered.length ? Math.max(0, buffered.end(buffered.length - 1) - at) : NaN;
                }
            } catch {
                how = '';
                value = NaN;
            }

            // 求め方が変わったら、それまでの最小値は比べ物にならないので捨てます。
            if (how !== method) {
                method = how;
                latency.reset();
            }

            if (how === 'wall' || how === 'seekable') return latency.read(value);
            stat.latency = value;
            stat.atHead  = true;
            return stat;
        }

        /**
         * 配信が切り替わったときの後始末。測っていたセグメントの長さと遅延の記録を捨てます。
         * @returns {void}
         */
        function forget() {
            latency.reset();
            method = '';
            edge = NaN;
            steps.length = 0;
        }

        return {
            // DAZN のプレーヤーには速度変更のメニューがないため、ユーザーの手動設定を気にする必要がありません。
            // dash.js の追いつき機能（低遅延の配信で速度を上げ下げする）が書き換えても、横取りした側で受け止めます。
            respectUserRate: false,

            // dash.js は 1.5 秒より小さい隙間を自動で飛び越えて再生を続けるため、その幅まではつながっているとみなします。
            gap: 1.5,

            badgeClass: '',
            badgeStyle: BADGE_STYLE_PLAIN,

            reset: forget,

            /**
             * プレーヤーの外枠要素を返す（コントロールバーが見つからないときの、バッジの表示位置の基準）。
             * @returns {Element|null}
             */
            root: () => video?.closest(ROOT) ?? video?.parentElement ?? null,

            video: find,

            /**
             * 現在再生中のメディアの情報を返す。
             *
             * ライブ判定の条件は 2 つ：
             *   1) 再生ソースが設定されている（何も読み込んでいない <video> は対象外）
             *   2) 動画の長さが ENDLESS 以上（読み込み中で不明な場合も含む）
             *      DAZN のライブは長さが 2^32 秒（4294967296）で、ふつうの dash.js なら Infinity です。
             * @returns {{ id: string, live: boolean }}
             */
            media() {
                const node = video;
                const path = location.pathname.toLowerCase();

                // 再生ソースが入れ替わったら「別の配信」とみなし、id を変えます。
                const src = node ? (node.srcObject ?? node.currentSrc) : null;
                if (src !== source) {
                    source = src;
                    swaps += 1;
                }

                const duration = node?.duration ?? NaN;
                current.id   = `${path}#${swaps}`;
                current.live = node !== null && Boolean(src) && (Number.isNaN(duration) || duration >= ENDLESS);
                return current;
            },

            /**
             * 現在の遅延と、ライブ最前線にいるかを返す（ついでにセグメントの長さを測ります）。
             * 遅延の求め方は lag() を参照（tracker は結果の入れ物を使い回します）。
             * @returns {{ latency: number, atHead: boolean }}
             */
            status() {
                measure();
                return lag();
            },

            /**
             * このサイトが必要とするバッファの目安（秒）を返す。
             * 測ったセグメントの長さ（伸び幅の中央値）です。まだ測れていなければ SEGMENT_GUESS を返します。
             * @returns {number}
             */
            needs: () => (steps.length >= STEP_MIN_N ? median(steps) : SEGMENT_GUESS),

            /**
             * バッジを差し込みたい場所（コントロールバー下段の、左側のボタンが並ぶ箱）を返す。
             *
             * 下段の左側には、再生／一時停止・10 秒戻し・音量・現在時刻の表示が並んでいます。
             * 現在時刻の表示（CURRENT_TIME）から上へたどり、音量ボタンも含む最初の祖先を
             * 「ボタンが並ぶ箱」とみなして、その末尾（現在時刻の右隣）にバッジを並べます
             * （YouTube で時刻表示の隣に並べるのと同じ位置です）。
             * 外枠の中から探すのは、マルチビューで別のプレーヤーの箱と取り違えないためです。
             * コントロールバーはマウスを乗せたときだけ表示されるので、バッジも一緒に現れたり隠れたりします。
             * 見つからなければ null を返し、本体側がプレーヤーの左上に浮かべる枠を用意します。
             * @returns {Element|null}
             */
            host() {
                const root = video?.closest(ROOT);
                const time = root?.querySelector(TIME);
                for (let node = time?.parentElement, depth = 0; node && depth < CLIMB; node = node.parentElement, depth++) {
                    if (node === root) break;
                    if (node.querySelector(VOLUME)) return node;
                }
                return null;
            },
        };
    }

    // このアダプターを「dazn」という ID で登録する。
    registerSite('dazn', HOST, dazn);
})();
