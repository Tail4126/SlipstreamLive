// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * adapters/tiktok.js — TikTok LIVE 専用の「アダプター」
 * =============================================================================
 *
 * ■ TikTok ならではの難しさ：再生の方式が 2 つある
 *   TikTok LIVE の Web プレーヤーは、環境によって再生の仕組みそのものを切り替えます。
 *
 *     MSE 方式       … 一般的な方式。Firefox・Edge・CPU が 6 コア未満の Chrome などで選ばれます。
 *                      <video> 要素が自分で映像を再生するので、playbackRate も buffered も
 *                      YouTube やツイキャスと同じようにそのまま使えます。
 *     WebCodecs 方式 … Chrome 122 以降（Edge を除く）・CPU 6 コア以上・Windows 10 以降（または
 *                      Windows 以外）のときだけ選ばれる方式。TikTok が Worker の中で映像を自前で解読し、
 *                      映像は MediaStreamTrackGenerator、音声は AudioWorklet を通して
 *                      <video> へ「生中継」します。
 *
 *   WebCodecs 方式の <video> は MediaStream を映しているだけなので、仕様上 playbackRate を
 *   変えても無視され（常に 1 倍）、buffered も空です。TikTok 自身の速度変更の口（内部の
 *   プレーヤーの playbackRate）もありますが、2026 年 10 月に Chrome 156 で調べた時点では値を
 *   控えるだけで、映像が同期している音声側の時計は 1 倍のまま進みました。
 *   つまりこの方式では、拡張機能から再生速度を変える手段がありません。
 *
 * ■ そこで：Chrome でも MSE 方式を選ばせる（steer）
 *   TikTok はどちらの方式にするかを、ページを開いたときに「ブラウザの種類と版」と
 *   「CPU のコア数（navigator.hardwareConcurrency）」で決めています（WebCodecs 方式は 6 コア以上が条件）。
 *   そこでページのスクリプトより先に、TikTok から見えるコア数を最大 4 にしておきます。
 *   すると TikTok は Firefox や Edge と同じ MSE 方式を選び、速度を調整できるようになります。
 *   （実測：Chrome 156 で MSE 方式に切り替わり、1.5 倍を指定すると 1.488 倍で進み、バッファが減った）
 *   これが TikTok タブの設定「Chrome での速度変更を有効にする」（forceMse）です。
 *
 *   見せかけるのは次の条件をすべて満たすときだけです。
 *     - Chromium 系のブラウザ（UA に "chrome/" を含む）。Firefox は元から MSE 方式です
 *     - 最上位のページ（iframe ではない）
 *     - 実際のコア数が 4 より多い（4 以下なら、値はそのまま返します）
 *     - 拡張機能全体と forceMse がどちらも有効
 *   書き換えるのは TikTok のページ（このファイルが読み込まれる www.tiktok.com）の
 *   メインワールドだけで、他のサイトや Worker の中の値には影響しません。
 *   方式はページを開いたときに決まるため、設定の変更はページを再読み込みすると反映されます。
 *
 * ■ ライブ判定と遅延について
 *   - 対象にするのは LIVE のページ（/live、/live/…、/@ユーザー名/live）だけです。
 *     おすすめフィードなどの通常の動画には触りません。
 *   - LIVE フィード（/live）は URL を変えずに次の配信へ切り替わるので、
 *     <video> の再生ソースが入れ替わったことを「別の配信になった」合図にします。
 *   - TikTok は配信元からの総遅延を教えてくれないため、遅延バッジには
 *     「受信済みの末尾から、どれだけ遅れて再生しているか」を出します。
 *     TikTok LIVE には巻き戻し（DVR）が無いので、常に最前線にいるものとして扱います。
 *
 * ■ アダプターの役割については adapters/youtube.js の冒頭コメントを参照。
 */
(() => {
    'use strict';

    const util = globalThis.__slipstreamliveUtil;
    if (!util) return;

    const { registerSite, ENDLESS, BADGE_STYLE_PLAIN } = util;

    /** このアダプターを使うホスト名。 */
    const HOST = /(^|\.)tiktok\.com$/;

    /** LIVE のページ（/live・/live/…・/@ユーザー名/live）を見分ける正規表現。 */
    const LIVE_PATH = /^\/(@[^/]+\/)?live(\/|$)/i;

    /** ライブのプレーヤーの外枠。TikTok は xgplayer というプレーヤーを使っています。 */
    const PLAYER = '.xgplayer';

    /**
     * バッジを並べる場所の目印（コントロールバー左側の、再読み込み／再生ボタン）。
     * クラス名は自動生成で毎回変わるため、テスト用に付いている data-e2e 属性で探し、
     * その親（ボタンが並ぶ横一列の箱）にバッジを足します。
     */
    const CONTROLS = ['[data-e2e="replay-icon"]', '[data-e2e="play-icon"]'];

    /**
     * コントロールを探すとき、video から何階層まで上へたどるか。
     * 配信ルームでは 5 階層ほど上の箱（data-e2e="live-room-content"）の中にあります。
     */
    const CLIMB = 8;

    /** つかんでいる video が健在でも、念のため探し直す間隔（ミリ秒）。 */
    const RECHECK_MS = 500;

    /**
     * TikTok に見せる CPU のコア数の上限。
     * WebCodecs 方式の条件（6 以上）は満たさず、H.265（HEVC）の配信を選ぶ条件（4 以上）は
     * 満たす値にしています。4 より小さくすると、TikTok が H.265 を選ばなくなるためです。
     */
    const SHOWN_CORES = 4;

    /**
     * デバッグモードかどうか（inject.js の debugging() と同じ判定）。
     * ページ側から自由に定義できる変数なので、読むときの例外に巻き込まれないよう囲みます。
     * @returns {boolean}
     */
    const debugging = () => {
        try { return window.__slipstreamliveDebug === true; }
        catch { return false; }
    };

    // =========================================================================
    // Chrome でも MSE 方式を選ばせる仕組み（steer）
    // =========================================================================

    /** @type {string|null} wanted() が最後に読んだ設定の JSON。変わったときだけ解析し直します */
    let seenJson = null;
    /** @type {boolean} その JSON から求めた「見せかけてよいか」 */
    let seenWant = true;

    /**
     * 設定で、コア数の見せかけが有効になっているか。
     *
     * 設定は content.js が <html> の data-slpstrm 属性に書いたものを読みます
     * （inject.js と同じ受け取り方です）。ページを開いた直後で、まだ属性が無いときは
     * 既定値（有効）として扱います。TikTok が方式を決めるのは、プレーヤーの部品を
     * 読み込み終えたあとなので、実際にはほぼ必ず設定が届いてから呼ばれます。
     *
     * 属性はページ側からも書き換えられますが、ここで値が狂っても起きるのは
     * 「TikTok の再生方式が変わる」ことだけで、速度の制御には使いません
     * （速度の制御は inject.js が自分で検証した設定だけを使います）。
     * @returns {boolean} 見せかけてよければ true
     */
    function wanted() {
        let json = null;
        try { json = document.documentElement?.dataset.slpstrm ?? null; }
        catch { json = null; }
        if (json === null) return true;
        if (json === seenJson) return seenWant;

        seenJson = json;
        let parsed = null;
        try { parsed = JSON.parse(json); } catch { parsed = null; }
        // 「厳密に true のときだけ有効」は inject.js の sanitize() と同じ考え方です。
        seenWant = parsed !== null && typeof parsed === 'object'
            ? parsed.enabled === true && parsed.forceMse === true
            : true;
        return seenWant;
    }

    /**
     * navigator.hardwareConcurrency（CPU のコア数）の読み取りを差し替える。
     *
     * Navigator.prototype にある本来の getter を Proxy で包み、戻り値だけを上限 SHOWN_CORES で
     * 頭打ちにします。
     *   - navigator そのものに独自のプロパティを生やさず、プロトタイプ側を差し替えるのは、
     *     「navigator 自身はこのプロパティを持たない」という本来の形を崩さないためです。
     *   - 新しい関数を作らず Proxy で包むのは、関数の名前・引数の数・文字列化した姿
     *     （[native code]）を本来の getter のまま保つためです。ページ側の不正検知などが
     *     「書き換えられた関数」とみなして、普通の視聴者を誤って疑うことがないようにしています。
     *
     * 実際の値は呼ばれるたびに本来の getter から読み、設定もそのつど確かめます。
     * TikTok は最初に読んだ結果を覚えて使い続けるため、効くのはページを開いたときの判定だけです。
     *
     * ※ Firefox は拡張機能の更新時に、開いているタブへスクリプトを読み込み直すことがあります
     *   （inject.js の冒頭を参照）。その場合は差し替えが二重になりますが、Firefox ではそもそも
     *   ここまで来ない（UA に "chrome/" が無い）ので問題になりません。
     * @returns {void}
     */
    function steer() {
        // 最上位のページだけ。iframe（他のサイトに埋め込まれた TikTok の動画など）は対象外です。
        // window.top は別オリジンでも比較だけなら例外になりません。
        if (window.top !== window) return;

        // Chromium 系のブラウザだけ。TikTok が WebCodecs 方式を選ぶのは Chrome だけだからです。
        // 判定は TikTok 自身の判定（UA を小文字にして "chrome/数字" を探す）にそろえています。
        if (!/chrome\/\d/i.test(navigator.userAgent)) return;

        const proto = Navigator.prototype;
        const desc  = Object.getOwnPropertyDescriptor(proto, 'hardwareConcurrency');
        if (typeof desc?.get !== 'function' || !desc.configurable) return;

        const capped = new Proxy(desc.get, {
            apply(target, receiver, args) {
                // receiver が Navigator でなければ、本来の getter と同じ例外がここで投げられます。
                const cores = Reflect.apply(target, receiver, args);
                return cores > SHOWN_CORES && wanted() ? SHOWN_CORES : cores;
            },
        });

        try {
            Object.defineProperty(proto, 'hardwareConcurrency', { ...desc, get: capped });
        } catch {
            // 差し替えられなければ、TikTok は WebCodecs 方式のまま（速度は変えられないだけ）です。
        }
    }

    // ページのスクリプトより先に動く必要があるため、読み込まれた時点ですぐに差し替えます
    // （manifest.json で document_start に指定してあります）。
    if (HOST.test(location.hostname)) steer();

    // =========================================================================
    // アダプター本体
    // =========================================================================

    /**
     * TikTok 用アダプターを生成する。
     * @returns {object} アダプターオブジェクト
     */
    function tiktok() {
        /** @type {HTMLVideoElement|null} 現在の video 要素 */
        let video   = null;
        /** @type {number} 最後に video を探した時刻 */
        let checkAt = -Infinity;

        /**
         * @type {object|string|null} 最後に見た再生ソース。
         * srcObject があればそのオブジェクト（MSE 方式の MediaSourceHandle など）、
         * 無ければ currentSrc の文字列（blob: の URL）です。
         */
        let source  = null;
        /** @type {number} 再生ソースが入れ替わった回数。media() の id に混ぜて、配信の切り替わりを知らせます */
        let swaps   = 0;
        /** @type {boolean} WebCodecs 方式を見つけたことを、デバッグログに出し終えたか */
        let warned  = false;

        /**
         * media() / status() の結果の入れ物。制御ループから頻繁に呼ばれるので、
         * 呼ぶたびに作らず中身だけ書き換えて返します。
         */
        const current = { id: '', live: false };
        const stat    = { latency: NaN, atHead: true };

        /**
         * 要素のうち、画面内に見えている部分の面積を求める。
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
         * いちばん大きく映っているライブの video を探す。毎フレーム呼ばれます。
         *
         * 探すのは LIVE のページにいるときだけです。LIVE 以外のページでは null を返し、
         * inject.js を低頻度の見張りモードのまま休ませます。
         * 探し直しは、つかんでいる video がページから外れたときと、RECHECK_MS ごとだけです。
         * @returns {HTMLVideoElement|null} 見つかった video 要素
         */
        function find() {
            if (!LIVE_PATH.test(location.pathname)) {
                video = null;
                return null;
            }

            const now = performance.now();
            if (video?.isConnected && now - checkAt < RECHECK_MS) return video;
            checkAt = now;

            // xgplayer の外枠の中を優先し、見つからなければページ全体から探します
            // （外枠のクラス名が変わっても、ひとまず動き続けられるようにするため）。
            let nodes = document.querySelectorAll(`${PLAYER} video`);
            if (!nodes.length) nodes = document.querySelectorAll('video');

            let best = null;
            let size = 0;
            for (const node of nodes) {
                // 再生中のものを優先するため、止まっているものは面積を半分に見積もります。
                const value = area(node) * (node.paused ? 0.5 : 1);
                if (value > size) { best = node; size = value; }
            }

            // 画面内に見えるものが無ければ、つかんでいる video を（まだページにあれば）使い続けます。
            video = best ?? (video?.isConnected ? video : null);
            return video;
        }

        /**
         * この video が WebCodecs 方式（MediaStream を映しているだけ）かどうか。
         * この方式では速度を変えられないので、制御の対象から外します。
         * @param {HTMLVideoElement} node 対象の video 要素
         * @returns {boolean} WebCodecs 方式なら true
         */
        function webcodecs(node) {
            const hit = node.srcObject instanceof MediaStream;
            if (hit && !warned && debugging()) {
                warned = true;
                console.log('[slipstreamlive]', 'tiktok: the WebCodecs player is in use, so playbackRate has no effect.'
                    + ' Turn on "Allow speed changes in Chrome" on the TikTok tab, then reload the page.');
            }
            return hit;
        }

        return {
            // TikTok LIVE には速度変更のメニューがないため、ユーザーの手動設定を気にする必要がありません。
            // TikTok 自身が速度を書き換えても、それは横取りした側で受け止めて無視します。
            respectUserRate: false,

            // FLV の映像が少しずつ途切れなく届くため、バッファはほぼ連続しています。隙間の許容は小さめ（0.5 秒）。
            gap: 0.5,

            badgeClass: '',
            badgeStyle: BADGE_STYLE_PLAIN,

            /**
             * 配信が切り替わったときの後始末。
             * 切り替わりの検知は media() が自分で行い、ほかに覚えている情報も無いため、何もしません。
             * @returns {void}
             */
            reset() { },

            /**
             * プレーヤーの外枠要素を返す（コントロールバーが見つからないときの、バッジの表示位置の基準）。
             * @returns {Element|null}
             */
            root: () => video?.closest(PLAYER) ?? video?.parentElement ?? null,

            video: find,

            /**
             * 現在再生中のメディアの情報を返す。
             *
             * ライブ判定の条件は 3 つすべてを満たすこと：
             *   1) LIVE のページにいる
             *   2) WebCodecs 方式ではない（MSE 方式でなければ速度を変えられないため）
             *   3) 動画の長さが無限（読み込み中で不明な場合も含む）
             * @returns {{ id: string, live: boolean }}
             */
            media() {
                const node = video;
                const path = location.pathname.toLowerCase();

                // 再生ソースが入れ替わったら「別の配信」とみなし、id を変えます。
                // LIVE フィード（/live）では URL を変えずに次の配信へ切り替わるうえ、
                // 同じ <video> を使い回すため、URL や要素だけでは切り替わりに気付けません。
                const src = node ? (node.srcObject ?? node.currentSrc) : null;
                if (src !== source) {
                    source = src;
                    swaps += 1;
                }

                const duration = node?.duration ?? NaN;
                current.id   = `${path}#${swaps}`;
                current.live = node !== null && LIVE_PATH.test(path) && !webcodecs(node)
                    && (Number.isNaN(duration) || duration >= ENDLESS);
                return current;
            },

            /**
             * 現在の遅延と、ライブ最前線にいるかを返す。
             * 遅延は「受信済みの末尾 − 再生位置」です（配信元からの総遅延は取得できないため）。
             * TikTok LIVE には巻き戻し（DVR）が無いので、atHead は常に true にします。
             * @returns {{ latency: number, atHead: boolean }}
             */
            status() {
                let latency = NaN;
                try {
                    const ranges = video?.buffered;
                    if (ranges?.length) latency = ranges.end(ranges.length - 1) - video.currentTime;
                } catch {
                    latency = NaN;
                }
                stat.latency = latency;
                stat.atHead  = true;
                return stat;
            },

            /**
             * このサイトが必要とするバッファの目安（秒）を返す。
             * TikTok LIVE は HTTP-FLV で、映像が 0.05〜0.2 秒ほどの小刻みで途切れなく届きます
             * （実測）。セグメント単位で届く HLS と違い、のこぎり波の 1 周期がごく短いため、
             * 統計の窓の下限と同じ 1 秒にしています。
             * @returns {number}
             */
            needs: () => 1,

            /**
             * バッジを差し込みたい場所（コントロールバー左側のボタンが並ぶ箱）を返す。
             *
             * video から上へたどり、再読み込み／再生ボタンを含む最初の祖先の中から探します。
             * 近い祖先から探すのは、同じページに別のプレーヤーがあっても取り違えないためです。
             * 配信ルームのコントロールバーはマウスを乗せたときだけ表示されるので、
             * バッジもそれに合わせて現れたり隠れたりします（YouTube と同じ動きです）。
             * @returns {Element|null} 見つからなければ null（本体側が代替の枠を作る）
             */
            host() {
                for (let node = video?.parentElement, depth = 0; node && depth < CLIMB; node = node.parentElement, depth++) {
                    for (const selector of CONTROLS) {
                        const icon = node.querySelector(selector);
                        if (icon?.parentElement) return icon.parentElement;
                    }
                }
                return null;
            },
        };
    }

    // このアダプターを「tiktok」という ID で登録する。
    registerSite('tiktok', HOST, tiktok);
})();
