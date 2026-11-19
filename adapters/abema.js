// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * adapters/abema.js — ABEMA 専用の「アダプター」
 * =============================================================================
 *
 * ■ このサイトも、DAZN・Kick と同じく許可制で読み込まれる
 *   ABEMA のスクリプトは manifest に書いていません。ユーザーが設定画面の「このサイトで有効にする」で
 *   abema.tv へのアクセスを許可したときに、background.js が scripting.registerContentScripts() で
 *   「shared/util.js → このファイル → inject.js」を MAIN world に登録します（並びは manifest と同じ）。
 *   許可が無いあいだは、どのページにも読み込まれません。
 *
 * ■ ABEMA のプレーヤー
 *   Web 版の ABEMA は、dash.js（ABEMA が手を入れた版。2026 年 11 月の実測で 4.7.2-abema.4）で
 *   MPEG-DASH を再生します。本編の <video> は、どの画面でも video.com-a-Video__video-element です。
 *     - テレビ（/now-on-air/<チャンネル>）… 24 時間のリニア放送。画面は div.com-tv-TVScreen です。
 *     - 追っかけ再生（テレビの「最初からみる」。ABEMA プレミアム）とライブイベント（/live-event/<ID>）
 *       … ビデオと同じ VOD 用の画面（div.com-vod-VODScreen-container）で再生します。
 *     - ビデオ（/video/episode/<ID> などの見逃し配信）… 長さが決まっているので対象外です。
 *   ビデオの前などに流れる CM は、本編とは別の <video>（クラス名なし。c-video_ad-VideoAdContainerView の中）で
 *   流れるので、本編として選びません。
 *
 * ■ ライブ判定と遅延
 *   - ライブは動画の長さ（duration）が Infinity になります。
 *   - テレビの再生位置（currentTime）は「1970 年からの経過秒数」にそろっています（MPD の
 *     availabilityStartTime が 1970 年。DAZN のライブと同じです）。そこで遅延は「今の時刻 − 再生位置」、
 *     つまり現実の時刻から何秒遅れて見ているかを表示します。2026 年 11 月に ABEMA NEWS とアニメの
 *     チャンネルで測ると、開いた直後は 20〜28 秒で、等倍で見ている間はほとんど動きませんでした。
 *     dash.js 自身の getCurrentLiveLatency() は、同じときに 19〜24 秒の間を 5 秒ずつ跳ねていたため使いません
 *     （端末の時計は、ABEMA のサーバーが返す時刻と 1 秒以内で一致していました）。
 *     再生位置がそろっていない配信では「シーク可能範囲の末尾 − 再生位置」、それも無ければ
 *     「受信済みの末尾 − 再生位置」を使います（求め方は lag() を参照。DAZN と同じ順番です）。
 *   - テレビは一時停止でき、止めていたぶん遅れて再生を続けます（巻き戻せる範囲は 60 秒で、それより
 *     遅れると dash.js が範囲の中へ移します）。最前線にいるかどうかは tracker で推定します（DAZN と同じ）。
 *
 * ■ CM
 *   テレビの CM は、配信の映像そのものに差し込まれています（サーバー側の広告挿入。MPD のアドレスは
 *   Yospace の形式で、差し込まれた部分はそれぞれ別の Period になります）。番組の Period の ID は
 *   数字だけですが、差し込まれた Period の ID は「yo-1.0.1」のように yo- で始まります（2026 年 11 月の実測では、
 *   番組の終わりに yo-1.0.1・yo-1.0.2・yo-1.0.3 の 30 秒・30 秒・15 秒が続き、数字の ID の短い Period を挟んで
 *   次の番組に戻りました）。yo- の Period のあいだは制御しません。今どの Period を再生しているかは、dash.js のプレーヤーの実体
 *   （React の内部データから探します。search() を参照）に尋ねます。
 *   実体が見つからないときは、CM を見分けられないまま、ほかの判定だけで動きます。
 *
 * ■ バッジの位置
 *   コントロールの右側に並ぶボタンの先頭（左隣）に置きます（host() を参照）。
 *     - テレビ … フルスクリーン・音量のボタン（div.com-tv-TVController）の左
 *     - VOD 用の画面 … 速度などの設定・フルスクリーン・音量の並び（div.com-vod-VideoControlBar__right）の左
 *   どちらのコントロールもマウスを乗せたときだけ表示されるので、バッジも一緒に現れたり隠れたりします。
 *
 * ■ アダプターの役割については adapters/youtube.js の冒頭コメントを参照。
 */
(() => {
    'use strict';

    const util = globalThis.__slipstreamliveUtil;
    if (!util) return;

    const { tracker, safeCall, registerSite, ENDLESS, BADGE_STYLE_PLAIN } = util;

    /** このアダプターを使うホスト名（abema.tv）。 */
    const HOST = /(^|\.)abema\.tv$/;

    /** 本編の <video>。テレビ・追っかけ再生・ライブイベント・ビデオのどれも、このクラスを持ちます。 */
    const VIDEOS = 'video.com-a-Video__video-element';

    /** ビデオの CM（本編とは別の <video> で流れるもの）の入れ物。ページ全体から選ぶときに除外します。 */
    const AD_BOX = '[class*="VideoAdContainerView"]';

    /** プレーヤーの外枠（テレビの画面と、VOD 用の画面）。バッジの代わりの枠を浮かべる基準です。 */
    const ROOT = '.com-tv-TVScreen__player, .com-vod-VODScreen-container';

    /**
     * バッジを並べたい、コントロールの右側のボタンの並び。
     *   .com-tv-TVController                            … テレビ（フルスクリーン・音量）
     *   .com-vod-VideoControlBar__right                 … VOD 用の画面（設定・ワイド表示・フルスクリーン・音量）
     *   .com-vod-LiveEventPayperviewControlBar__bottons … ペイパービューのライブイベント（綴りは ABEMA のまま）
     */
    const BARS = '.com-tv-TVController, .com-vod-VideoControlBar__right, .com-vod-LiveEventPayperviewControlBar__bottons';

    /**
     * video から何階層まで上へたどって、コントロールを探すか。
     * テレビは 6 階層上の div.com-tv-TVScreen、ビデオは 5 階層上の外枠の中にコントロールがありました。
     */
    const CLIMB = 8;

    /** つかんでいる video が健在でも、念のため探し直す間隔（ミリ秒）。 */
    const RECHECK_MS = 500;

    /**
     * dash.js のプレーヤーの実体が見つからないときに探し直す間隔（ミリ秒）。
     * 見つからないたびに倍へ延ばし（最長 SEARCH_MAX_MS）、探索を繰り返しすぎないようにします（Kick と同じ）。
     */
    const SEARCH_MS     = 1000;
    const SEARCH_MAX_MS = 8000;

    /** video の React の内部ノードから、祖先へ何段まで実体を探すか。2026 年 11 月の実測では 3 段上にありました。 */
    const UPWARD = 12;

    /** 差し込まれた Period（CM）の ID の形。番組の Period の ID は数字だけです。 */
    const INSERTED = /^yo-/;

    /**
     * 再生位置が「1970 年からの経過秒数」にそろっているとみなす下限（秒）。DAZN と同じです。
     * 10 億秒は 2001 年 9 月で、ふつうの番組の長さとは桁が違うため、取り違えません。
     */
    const EPOCH_MIN = 1e9;

    /**
     * 求めた遅延を信じる範囲（秒）。端末の時計は少しずれていることがあるため、わずかなマイナスまでは
     * 許して 0 に丸めます。範囲の外になるときは、次の求め方に切り替えます（DAZN と同じ）。
     */
    const WALL_MIN = -5;
    const WALL_MAX = 86400;

    /**
     * セグメント 1 個の長さがまだ測れていないときに使う値（秒）。
     * 2026 年 11 月に ABEMA NEWS のチャンネルで測ると、バッファの末尾は 1 回に 10.2〜10.4 秒ずつ伸び、
     * 残量は約 6 秒から約 18 秒までののこぎり波になりました（アニメのチャンネルでは、伸びが 2〜10 秒ほどでばらつきました）。
     * まだ測れていないうちは、長いほうに合わせて慎重に見積もります。
     */
    const SEGMENT_GUESS = 10;

    /**
     * バッファの末尾の伸びを「セグメント 1 個ぶん」として数える幅（秒）の範囲（DAZN と同じ考え方）。
     * 小さすぎる伸びは音声と映像の届く時刻のずれ、大きすぎる伸びはシークや一時停止の後の読み込みです。
     */
    const STEP_MIN = 0.2;
    const STEP_MAX = 20;

    /** 伸び幅を何回ぶん覚えておくか（その最大値をセグメントの長さとみなします。needs() を参照）。 */
    const STEP_KEEP = 9;

    /** 測った値を使い始めるのに必要な記録の数。 */
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
     * 値が「指定の <video> を再生している dash.js のプレーヤー」かどうか。
     * dash.js の getVideoElement() は、<video> がまだ結び付いていないと例外を投げるので、読むだけでも例外に備えます。
     * @param {unknown} value 調べる値
     * @param {HTMLVideoElement} video 対象の video 要素
     * @returns {boolean} そうなら true
     */
    function owns(value, video) {
        if (value === null || typeof value !== 'object') return false;
        try {
            return typeof value.getActiveStream === 'function'
                && typeof value.getVideoElement === 'function'
                && value.getVideoElement() === video;
        } catch {
            return false;
        }
    }

    /**
     * React の内部データ（fiber）を video から上へたどって、dash.js のプレーヤーの実体を探す。
     *
     * 2026 年 11 月の ABEMA では、video の 3 段上のクラスコンポーネント（MPEG-DASH 用の再生部品）が、
     * 自分のプロパティ player に実体を持っていました（さらに上のコンポーネントには props の player として渡されます）。
     * クラスコンポーネントの実体（stateNode）は、React が描き直しても同じオブジェクトのまま使われるので、
     * 古い描画の内容を読んでしまう心配がありません。getVideoElement() が今の video と一致するものだけを採用します。
     * @param {HTMLVideoElement} video 対象の video 要素
     * @returns {object|null} 見つかった実体。無ければ null
     */
    function search(video) {
        // React は DOM 要素に `__reactFiber$xxxxx` という名前のプロパティを付けます（末尾は毎回変わります）。
        const key = Object.keys(video).find((name) => name.startsWith('__reactFiber$'));
        for (let node = key ? video[key] : null, i = 0; node && i < UPWARD; node = node.return, i++) {
            const instance = node.stateNode;
            if (instance !== null && typeof instance === 'object' && !(instance instanceof Node)
                && owns(instance.player, video)) return instance.player;
            const props = node.memoizedProps;
            if (props !== null && typeof props === 'object' && owns(props.player, video)) return props.player;
        }
        return null;
    }

    /**
     * ABEMA 用アダプターを生成する。
     * @returns {object} アダプターオブジェクト
     */
    function abema() {
        /** @type {HTMLVideoElement|null} 現在の video 要素 */
        let video   = null;
        /** @type {number} 最後に video を探した時刻 */
        let checkAt = -Infinity;

        /** @type {object|null} dash.js のプレーヤーの実体（React の中から探し出したもの） */
        let core     = null;
        /** @type {number} 次に実体を探してよい時刻 */
        let searchAt = -Infinity;
        /** @type {number} 実体を探して見つからなかった回数（探し直す間隔を延ばすのに使います） */
        let misses   = 0;

        /**
         * @type {object|string|null} 最後に見た再生ソース（srcObject、無ければ currentSrc の blob: URL）。
         * 同じ <video> のまま別の配信へ切り替わったことに気付くために使います（DAZN と同じ）。
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
         * （DAZN と同じ扱い。ユーザー操作のシーク中は除きます）。
         * @returns {void}
         */
        const stalled = () => {
            if (video && !video.seeking) latency.reset();
        };

        /**
         * dash.js のプレーヤーの実体を返す（無ければ、間隔を守って探す）。
         * つかんでいる実体が今の <video> を再生していなければ（チャンネルを移って作り直された、など）、
         * 手放して探し直します。
         * @returns {object|null} 実体。見つからなければ null
         */
        function player() {
            if (core && !owns(core, video)) core = null;
            if (core || !video) return core;

            const now = performance.now();
            if (now < searchAt) return null;

            let found = null;
            try { found = search(video); } catch { found = null; }
            if (!found) {
                misses += 1;
                searchAt = now + Math.min(SEARCH_MS * 2 ** (misses - 1), SEARCH_MAX_MS);
                return null;
            }
            core   = found;
            misses = 0;
            return core;
        }

        /**
         * 今再生している Period が、差し込まれたもの（CM）かどうか。
         * dash.js の getActiveStream() は、再生位置が今いる Period を返します
         * （2026 年 11 月の実測で、ID が切り替わったのは再生位置がその Period の始まりに達したときでした）。
         * 実体が見つからない・尋ねられないときは false（番組とみなす）を返します。
         * @returns {boolean} 差し込まれた Period なら true
         */
        function inserted() {
            const stream = safeCall(player(), 'getActiveStream', null);
            const id = safeCall(stream, 'getStreamInfo', null)?.id;
            return typeof id === 'string' && INSERTED.test(id);
        }

        /**
         * 本編の video を探す。毎フレーム呼ばれます。
         *
         * 探し直しは、つかんでいる video がページから外れたときと、RECHECK_MS ごとだけです。
         * 画面に映っている面積が大きいものを選び、止まっているもの・音を消しているものは
         * 面積を半分に見積もります（DAZN と同じ。追っかけ再生へ切り替えた直後などに、見ているほうを選ぶため）。
         * ABEMA が本編のクラス名を変えたときは、ビデオの CM を除いたページ全体の <video> から選びます。
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
                if (node.closest(AD_BOX)) continue;
                const value = area(node) * (node.paused ? 0.5 : 1) * (node.muted ? 0.5 : 1);
                if (value > size) { best = node; size = value; }
            }

            // 画面内に見えるものが無ければ、つかんでいる video を（まだページにあれば）使い続けます。
            const next = best ?? (video?.isConnected ? video : null);

            // 入れ替わったら、詰まりの見張りを付け替え、プレーヤーの実体も探し直します。
            if (next !== video) {
                video?.removeEventListener('waiting', stalled);
                video = next;
                video?.addEventListener('waiting', stalled);
                core     = null;
                misses   = 0;
                searchAt = -Infinity;
            }
            return video;
        }

        /**
         * バッファの末尾がどれだけ伸びたかを記録する（セグメントの長さを測るため。DAZN と同じ）。
         * dash.js はセグメントを 1 個ずつ追加するので、バッファの末尾は「セグメント 1 個の長さ」ずつ
         * 階段状に伸びます。その段差を記録しておき、needs() が最大値を使います。
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
         *   1) 世界の時計 … 「今の時刻 − 再生位置」。テレビの再生位置は 1970 年からの経過秒数なので、
         *      これがそのまま「現実の時刻から何秒遅れて見ているか」になります。
         *   2) シーク可能範囲 … 「範囲の末尾 − 再生位置」。再生位置がそろっていない配信のためのものです。
         *      ABEMA のテレビでは範囲の末尾も 1970 年からの経過秒数なので、ENDLESS では区切らず、
         *      差が WALL_MIN〜WALL_MAX に収まるときだけ使います。
         *   3) バッファ … 「受信済みの末尾 − 再生位置」（TikTok・DAZN と同じ）。最後の手段です。
         *
         * 1) と 2) は配信の最新地点からの遅れなので、tracker で巻き戻し視聴（一時停止の後を含みます）を
         * 見分けます。3) はバッファが溜まるだけで伸びる値なので、比べずに常に「最前線にいる」として返します。
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
                    const ahead = seekable.length ? seekable.end(seekable.length - 1) - at : NaN;
                    if (ahead >= WALL_MIN && ahead <= WALL_MAX) { how = 'seekable'; value = Math.max(0, ahead); }
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
         * 配信が切り替わったとき（inject.js が reset() として呼びます）の後始末。
         * 測っていたセグメントの長さと遅延の記録を捨てます。
         * @returns {void}
         */
        function forget() {
            latency.reset();
            method = '';
            edge = NaN;
            steps.length = 0;
        }

        return {
            // 追っかけ再生とライブイベントの VOD 用の画面には「速度」の設定（1x / 1.3x / 1.5x / 1.7x / 2x）があります。
            // ユーザーが自分で速度を選んだら、拡張機能は手を引きます（YouTube と同じ）。
            // テレビの画面には速度の設定がなく、ページ側が速度を書き換えることもありませんでした
            // （dash.js の追いつき機能は、低遅延モードでないため動いていません）。
            respectUserRate: true,

            // dash.js は 1.5 秒より小さい隙間を自動で飛び越えて再生を続けるため（ABEMA の設定も
            // smallGapLimit が 1.5 秒でした）、その幅まではつながっているとみなします（DAZN と同じ）。
            gap: 1.5,

            badgeClass: '',

            // order:-1 で、右側のボタンの並びの先頭（左隣）に表示します。
            // バッジはその並びの末尾に追加されますが、ボタンの並びはどれも横並びの flex なので、
            // 見た目の順番だけを先頭へ移せます（代わりの枠に浮かべるときも、バッジどうしの順番は変わりません）。
            badgeStyle: `${BADGE_STYLE_PLAIN};order:-1`,

            reset: forget,

            /**
             * プレーヤーの外枠要素を返す（コントロールが見つからないときの、バッジの表示位置の基準）。
             * @returns {Element|null}
             */
            root: () => video?.closest(ROOT) ?? video?.parentElement ?? null,

            video: find,

            /**
             * 現在再生中のメディアの情報を返す。
             *
             * ライブ判定の条件は 3 つすべてを満たすこと：
             *   1) 再生ソースが設定されている（何も読み込んでいない <video> は対象外）
             *   2) 差し込まれた Period（CM）を再生していない
             *   3) 動画の長さが ENDLESS 以上（ライブは Infinity。読み込み中で不明な場合も含む）
             *
             * id は「パス#再生ソースの入れ替わり回数」です（DAZN と同じ）。チャンネルを移るとパスが変わります。
             * CM の間は末尾に #ad を付け、CM の始まりと終わりを「別の配信になった」合図にします（YouTube と同じ考え方）。
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

                const ad = node !== null && inserted();
                const duration = node?.duration ?? NaN;
                current.id   = `${path}#${swaps}${ad ? '#ad' : ''}`;
                current.live = node !== null && Boolean(src) && !ad
                    && (Number.isNaN(duration) || duration >= ENDLESS);
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
             *
             * 直近の伸び幅の最大値です。まだ測れていなければ SEGMENT_GUESS を返します。
             * DAZN は中央値を使いますが、ABEMA のテレビは伸び方が揃っていません。2026 年 11 月の実測では、
             * 音声と映像の届く時刻がずれて 10 秒の伸びが「0.3 秒＋10 秒」のように割れたり、CM の明けに
             * 3〜4 秒の伸びが続いた後で 9 秒の伸びが来たりしました。中央値で 3〜4 秒と見積もると、
             * 本体が残量の波をその短さの窓で見て底を高く見積もり、加速しすぎて次のセグメントが届く前に
             * 残量が尽きました（最低速度に落ちたうえで、読み込み待ちになりました）。
             * 波の 1 周期をまるごと見られるよう、いちばん大きい伸び（最も長いセグメント）に合わせます。
             * 最大値に改めた版では、57 秒の遅れから 23 秒ほどまで詰めたところで、波の底を 5〜6 秒残して
             * 等倍に落ち着き、最低速度には入りませんでした。
             * @returns {number}
             */
            needs: () => (steps.length >= STEP_MIN_N ? Math.max(...steps) : SEGMENT_GUESS),

            /**
             * バッジを差し込みたい場所（コントロールの右側のボタンの並び）を返す。
             *
             * video から上へ CLIMB 階層までたどり、その中にあるボタンの並び（BARS）を探します。
             * テレビのコントロールは画面（div.com-tv-TVScreen）の下端に、VOD 用の画面のコントロールは
             * 画面の外枠の中にあり、どちらも video の親や祖先の中に見つかります。
             * video に近い祖先から探すので、ページにほかのプレーヤー（ビデオのミニプレーヤーなど）があっても取り違えません。
             * 見つからなければ null を返し、本体側がプレーヤーの左上に浮かべる枠を用意します。
             * @returns {Element|null}
             */
            host() {
                for (let node = video?.parentElement, depth = 0; node && depth < CLIMB; node = node.parentElement, depth++) {
                    if (node === document.body) break;
                    const bar = node.querySelector(BARS);
                    if (bar) return bar;
                }
                return null;
            },
        };
    }

    // このアダプターを「abema」という ID で登録する。
    registerSite('abema', HOST, abema);
})();
