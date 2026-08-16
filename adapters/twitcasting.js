// SPDX-License-Identifier: Apache-2.0 OR MIT
/* ================================================================================================
 * adapters/twitcasting.js — ツイキャス（TwitCasting）用のプレイヤー操作アダプタ
 *
 * 【どこから呼ばれるか】
 *   manifest.json の content_scripts（MAIN world）から adapters/twitch.js の次に読み込まれ、
 *   自動実行されて registerSite() で自己登録するだけ。
 *   実際にアダプタが作られるのは inject.js がホスト名を照合して create() を呼んだとき。
 *
 * 【ツイキャスならではの事情】
 *   ツイキャスは公開プレイヤー API を持たず、Twitch のように内部オブジェクトを掘り出す
 *   手掛かりもない。そこで使える情報は次の 2 つだけに絞られる。
 *     1. URL のパス（/{ユーザー名}/movie/{番号} なら録画、それ以外は配信の可能性）
 *     2. <video> の duration（尺）が時間とともに伸びていくかどうか
 *   ライブ配信では映像が届くたびに尺が伸び続けるので、その「伸び」を観測して判定する。
 *
 * 【低遅延配信について】
 *   ツイキャスの「低遅延」モードは HLS ではなく WebRTC で映像が届く。この場合 <video> は
 *   MediaSource ではなく MediaStream（srcObject）で駆動され、buffered と seekable が
 *   どちらも空になる。先読みバッファという概念そのものが存在しないため残量を測れず、
 *   さらに MediaStream の再生では playbackRate が仕様上無視されるので、速度制御は
 *   原理的に成立しない。そこで media() の段階で制御対象から明示的に外している。
 *   （duration は Infinity を返すため、これを弾かないとライブ判定を通過してしまい、
 *     health が NaN のまま制御ループだけが 20 ミリ秒周期で空回りし続ける。）
 *
 * 【設計方針】
 *   ツイキャスは HTML のクラス名がよく変わるため、ライブ判定のような根幹部分は
 *   クラス名にまったく依存させていない。クラス名を使うのは、バッジの表示場所という
 *   「外れても致命的でない部分」だけに留め、そこも候補を大量に並べて保険をかけている。
 * ================================================================================================ */
(() => {
    'use strict';

    const util = globalThis.__slipstreamliveUtil;
    if (!util) return;                              // 読み込み順が壊れている場合は登録せず終了

    const { pick, tracker, seekableLatency, videoWatcher, registerSite,
        ENDLESS, BADGE_STYLE_PLAIN } = util;

    // ライブ判定で「尺が伸びた」とみなすのに必要な最小の伸長幅（秒）。
    // 小さすぎると計測誤差を伸びと誤認するため、余裕を持たせている
    const GROWTH = 0.25;

    /**
     * ツイキャス用アダプタの本体を生成する。
     *
     * @returns {Object} inject.js が使うアダプタ
     */
    function twitcasting() {
        /* --- DOM セレクタ ---------------------------------------------------------------------- */

        // プレイヤーコンテナの候補（優先度順）。すべて外れたら <video> の親要素で代用される
        const ROOTS = ['.tc-player', '#player', '#player-container', '#playerarea', '#jsplayer',
            '.tw-player', '.tw-stream-player-video', '.video-container'];

        // コントロールバーの候補。後半は [class*="..."] による部分一致で、命名変更にある程度耐える。
        // すべて外れた場合は inject.js が画面左上へ独自の帯 UI を出す
        const BARS = ['.tw-player-control', '.tw-movie-control-layout__inner', '.tw-movie-control-layout',
            '.tw-player-controls', '.tw-player-buttons', '.tw-stream-player-controller',
            '.vjs-control-bar', '[class*="player-control"]', '[class*="movie-control"]', '[class*="control-bar"]'];

        /* --- 内部状態 -------------------------------------------------------------------------- */

        // 遅延の基準線トラッカー。追っかけ再生中かどうかの判定に使う
        const latency = tracker();

        // 直近に観測した video.duration（秒）。次回の値と比べて伸びたかどうかを見る
        let span = NaN;

        // 一度でも duration の伸びを観測できたか。true になったらライブ確定として扱う
        let growing = false;

        /**
         * 観測状態をすべてリセットする。配信が切り替わると尺の連続性が失われるため。
         *
         * @returns {void}
         */
        const forget = () => {
            latency.reset();
            span = NaN;
            growing = false;
        };

        // プレイヤールートと <video> の追跡役（shared/util.js が提供）
        const watcher = videoWatcher({
            roots: ROOTS,
            onSwap: forget,
            onStall: () => latency.reset(),         // 読み込み停止後は遅延が跳ねるので基準線を引き直す
        });

        /**
         * <video> が MediaStream（WebRTC）で駆動されているかを判定する。
         *
         * 低遅延配信ではここが true になる。true の場合は buffered / seekable がどちらも空で、
         * バッファ残量を測る手段が存在しない。加えて MediaStream の再生では playbackRate が
         * 仕様上無視されるため、制御を試みても意味がない。
         *
         * MediaStream が未定義の実行環境も理論上ありうるので、typeof で存在を確かめてから
         * instanceof を評価する（未定義のまま instanceof を書くと例外になる）。
         *
         * @returns {boolean} MediaStream 再生なら true
         */
        const webrtc = () => typeof MediaStream !== 'undefined'
            && watcher.video?.srcObject instanceof MediaStream;

        /**
         * duration の推移から、これがライブ配信かどうかを判定する。
         *
         *   1. NaN（メタデータ未ロード）なら判定できないので、いったんライブ扱いにして保留する
         *   2. ENDLESS（100 万秒）以上なら無条件にライブ（Infinity や巨大値が返るケース）
         *   3. now > span + GROWTH で伸びを検出したらライブ確定
         *      （配信中は映像が届くたびに尺が伸びていくため）
         *
         * @returns {boolean} ライブ配信とみなせるなら true
         */
        function endless() {
            const now = watcher.video?.duration ?? NaN;     // 現時点の尺（秒）

            if (Number.isNaN(now)) return true;
            if (now >= ENDLESS) return true;

            if (now > span + GROWTH) growing = true;

            // 条件をあえて否定形で書いている。span が NaN のとき (now <= NaN) は false になるので、
            // !(false) すなわち true となり、初回でも span が正しく初期化される
            if (!(now <= span)) span = now;
            return growing;
        }

        return {
            // ツイキャスには公式の速度変更 UI があるため、ユーザーが手動で選んだ速度は尊重する
            respectUserRate: true,

            // 連続したバッファとみなす隙間の許容値（秒）
            gap: 0.5,

            badgeClass: '',                         // 流用できるボタン用クラスが無い
            badgeStyle: BADGE_STYLE_PLAIN,          // 代わりに素のスタイルを直接あてる

            reset: forget,

            /**
             * バッジの器となるプレイヤールート要素を返す。
             *
             * @returns {Element|null}
             */
            root: () => watcher.root,

            /**
             * 監視対象の <video> を取得する（探索は videoWatcher に任せきりでよい）。
             *
             * @returns {HTMLVideoElement|null}
             */
            video: () => watcher.find(),

            /**
             * メディアの識別 ID とライブ判定を返す。
             * WebRTC 判定・URL パスによる録画判定・duration の伸長判定を組み合わせる。
             *
             *   MediaStream 再生（低遅延配信） … 制御が成立しないので必ず対象外
             *   /{ユーザー名}/movie/{番号}      … 録画（VOD）なので必ず制御対象外
             *   それ以外（/{ユーザー名} や /g:{グループID} など）… endless() の判定に委ねる
             *
             * live が false になると inject.js は休止するが、タイマーは 1 秒周期で回り続ける。
             * したがってユーザーが低遅延をオフに切り替えれば、追加の仕掛けなしに制御が再開される。
             *
             * @returns {{ id: string, live: boolean }}
             */
            media: () => ({
                id: location.pathname.toLowerCase(),
                live: !webrtc()
                    && !/\/movie\/\d+/.test(location.pathname)
                    && endless(),
            }),

            /**
             * 遅延（秒）を求め、基準線トラッカーを通して追っかけ再生の判定を付けて返す。
             * 公式 API が無いため、seekable の末尾と再生位置の差から計算する。
             *
             * @returns {{ latency: number, atHead: boolean }}
             */
            status: () => latency.read(seekableLatency(watcher.video)),

            /**
             * 自動しきい値が使う目安バッファ量（秒）。
             * ツイキャスは元々きわめて低遅延な配信方式のため、固定で 0.5 秒とする。
             *
             * @returns {number}
             */
            needs: () => 0.5,

            /**
             * バッジを差し込むコントロールバー内のスロットを探す。
             *
             * @returns {Element|null}
             */
            host: () => pick(BARS, watcher.root ?? document),
        };
    }

    registerSite('twitcasting', /(^|\.)twitcasting\.tv$/, twitcasting);
})();
