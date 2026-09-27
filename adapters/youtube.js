// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * adapters/youtube.js — YouTube 専用の「アダプター」
 * =============================================================================
 *
 * ■ アダプターとは？
 *   inject.js（速度制御の本体）は、サイトごとの事情を一切知りません。
 *   代わりに「video 要素を取ってきて」「今ライブ？」といった決まった質問を投げ、
 *   その答えを返すのがアダプターの役目です。
 *
 *   こうしておくと、対応サイトを増やしたいときはアダプターを 1 つ足すだけで済み、
 *   本体のロジックには手を入れずに済みます（＝関心の分離）。
 *
 * ■ アダプターが必ず備えるべきもの（インターフェース）
 *   respectUserRate … ユーザーが手動で変えた再生速度を尊重するか
 *   gap             … バッファの「隙間」を無視してよい最大秒数
 *   badgeClass      … バッジに付ける、サイト純正のボタン用 CSS クラス
 *   badgeStyle      … バッジに追加で当てるインラインスタイル
 *   reset()         … 動画が切り替わったときに内部状態を捨てる
 *   root()          … プレーヤーの外枠要素を返す
 *   video()         … 現在の <video> 要素を返す
 *   media()         … 動画の識別子・ライブかどうかなどを返す
 *   status()        … 現在の遅延と、最前線にいるかを返す
 *   needs()         … このサイトが必要とするバッファの目安秒数
 *   host()          … バッジを差し込みたい場所（コントロールバー）を返す
 *
 * ■ YouTube の特徴
 *   #movie_player 要素に、内部 API（getVideoData など）が生えています。
 *   これを呼べば遅延やライブ判定を正確に取得できるため、他サイトより有利です。
 *   ただし非公開 API なので、いつ消えても壊れないよう safeCall で包んで呼びます。
 */
(() => {
    'use strict';

    // shared/util.js が置いた道具箱を参照します（ここでは delete しません。
    // 後続のアダプターと inject.js もまだ使うため、削除は inject.js が担当します）。
    const util = globalThis.__slipstreamliveUtil;
    if (!util) return;

    const { pick, toNum, safeCall, registerSite } = util;

    /**
     * YouTube 用アダプターを生成する。
     *
     * この関数が返すオブジェクトが、inject.js から使われる「窓口」になります。
     * 内側の変数（player, video など）はクロージャで保持され、外からは触れません。
     * @returns {object} アダプターオブジェクト
     */
    function youtube() {
        /** @type {Element|null} YouTube プレーヤー本体（#movie_player） */
        let player = null;
        /** @type {HTMLVideoElement|null} 現在の video 要素 */
        let video  = null;

        // --- 動画ごとに 1 度だけ調べる情報（getPlayerResponse の videoDetails 由来）---
        /** @type {string|null} 下の 2 つを確認し終えた動画の ID */
        let checkedId    = null;
        /** @type {boolean} その動画がプレミア公開かどうか */
        let premiere     = false;
        /** @type {string} その動画の遅延モード（…ULTRA_LOW / …LOW / それ以外） */
        let latencyClass = '';

        /**
         * YouTube プレーヤーの内部 API を安全に呼び出すショートカット。
         * メソッドが存在しなければ undefined が返るだけで、例外にはなりません。
         * @param {string} name 呼び出すメソッド名
         * @param {...unknown} args 渡す引数
         * @returns {*} 戻り値。呼べなければ undefined
         */
        const call = (name, ...args) => safeCall(player, name, undefined, ...args);

        /**
         * 動画 ID ごとに 1 度だけ videoDetails を調べ、プレミア判定と遅延モードを覚える。
         *
         * ■ 動画 ID を照合してから採用する理由
         *   動画が切り替わった直後は、getVideoData() はもう新しい動画を指しているのに、
         *   getPlayerResponse() には前の動画の応答が残っていることがあります。
         *   それをそのまま覚えると、新しい動画の再生中ずっと前の動画の判定を使い続けます
         *   （例：プレミア公開の直後に見た本物のライブを「プレミア」と取り違え、
         *    その配信のあいだ一切制御しなくなる）。
         *   そこで videoId が一致しない応答は捨て、次の呼び出しで取り直します。
         *   videoId そのものが無い応答は照合のしようがないので、そのまま採用します。
         *
         * ■ 確認が取れるまでの扱い
         *   新しい動画の情報を確認できるまでは、前の動画の判定は使わず
         *   「プレミアではない／遅延モード不明」として扱います（初回読み込み時と同じ扱い）。
         * @param {string|null} id 現在の動画 ID
         * @returns {void}
         */
        function inspect(id) {
            if (id === checkedId) return;

            premiere     = false;
            latencyClass = '';

            const details = call('getPlayerResponse')?.videoDetails;
            if (!details || (details.videoId ?? id) !== id) return;

            checkedId    = id;
            // isLiveContent が true = 本物のライブ配信。
            // false なら、ライブ扱いだが中身は録画＝プレミア公開。
            premiere     = details.isLiveContent !== true;
            latencyClass = String(details.latencyClass ?? '');
        }

        return {
            // YouTube はプレーヤー UI に速度変更メニューがあります。
            // ユーザーが自分で 2 倍速などにしていたら、拡張機能は手を引きます。
            respectUserRate: true,

            // YouTube のバッファはほぼ連続しているため、隙間の許容は小さめ（0.5 秒）。
            gap: 0.5,

            // 'ytp-button' は YouTube 純正のボタン用クラス。これを付けると
            // 見た目がプレーヤーのコントロールに自然になじみます。
            badgeClass: 'ytp-button',
            badgeStyle: '',

            /**
             * 動画が切り替わったときの後始末。
             * 覚えていた動画ごとの情報を捨て、次の media() で調べ直させます。
             * @returns {void}
             */
            reset() { checkedId = null; },

            /**
             * プレーヤーの外枠要素を返す（バッジの表示位置の基準に使われる）。
             * @returns {Element|null}
             */
            root: () => player,

            /**
             * 現在の <video> 要素を返す。毎フレーム呼ばれます。
             * @returns {HTMLVideoElement|null} 見つかった video 要素
             */
            video() {
                // (1) 通常の視聴ページには #movie_player があります。
                // (2) 無ければ埋め込みプレーヤーなどの代替を探します
                //     （覚えている要素がページから消えたときだけ探し直す）。
                const main = document.querySelector('#movie_player');
                if (main) player = main;
                else if (!player?.isConnected) player = pick(['.html5-video-player']);

                // (3) 覚えていた video が消えた／プレーヤーの外に出たら探し直します。
                if (!video?.isConnected || !player?.contains(video)) {
                    video = player?.querySelector('video') ?? null;
                }
                return video;
            },

            /**
             * 現在再生中のメディアの情報を返す。
             *
             * inject.js は id の変化を見て「別の動画に切り替わった」と判断し、
             * 学習してきた統計をリセットします。
             * @returns {{ id: string|null, live: boolean, premiere: boolean }}
             */
            media() {
                const data = call('getVideoData');

                // 'ad-showing' クラスが付いている間は広告を再生中。
                const ad   = player?.classList.contains('ad-showing') === true;

                // 広告中は動画 ID を 'ad' に固定します。こうすると広告の開始と終了が
                // 「動画の切り替わり」として扱われ、統計が自動的にリセットされます。
                const id   = ad ? 'ad' : (data?.video_id ?? null);
                const live = !ad && data?.isLive === true;

                // プレミア公開（事前に用意した動画を同時視聴するもの）の判定。
                // 判定にコストのかかる API なので、ライブのときだけ、動画ごとに 1 度だけ調べます。
                if (live) inspect(id);
                return { id, live, premiere: live && premiere };
            },

            /**
             * 現在の遅延と、ライブ最前線にいるかどうかを返す。
             * YouTube は「統計情報」API から実測値を教えてくれます。
             * @returns {{ latency: number, atHead: boolean }}
             */
            status: () => ({
                latency: toNum(call('getStatsForNerds')?.live_latency_secs),
                // isAtLiveHead が明示的に false のときだけ「巻き戻して視聴中」と判断します。
                atHead: call('getProgressState')?.isAtLiveHead !== false,
            }),

            /**
             * このサイトが必要とするバッファの目安（秒）を返す。
             *
             * 統計の観測窓の長さを決めるのに使います。動画は「セグメント」という
             * 小さな塊で配信されるため、その 1 個ぶんの長さが目安になります。
             * （inject.js はライブ再生中にだけ、media() の後で呼び出します）
             * @returns {number} 目安の秒数
             */
            needs() {
                // (1) セグメント長が取れれば、それが一番正確。
                const segment = toNum(call('getVideoStats')?.segduration);
                if (segment > 0) return segment;

                // (2) 取れなければ、media() で調べておいた遅延モードから推定します。
                if (latencyClass.endsWith('ULTRA_LOW')) return 1; // 超低遅延
                if (latencyClass.endsWith('LOW')) return 2;       // 低遅延
                return 5;                                          // 通常（不明な場合も含む）
            },

            /**
             * バッジを差し込みたい場所（コントロールバー内）を返す。
             * 上から順に試し、最初に見つかった場所を使います。
             * YouTube の UI 変更に耐えられるよう、候補を複数用意しています。
             * @returns {Element|null} 見つからなければ null（本体側が代替の枠を作る）
             */
            host: () => pick([
                'player-time-display .ytwPlayerTimeDisplayLiveDot', // 新 UI のライブ表示
                '.ytp-time-display .ytp-time-wrapper',              // 時間表示の隣
                '.ytp-chrome-controls .ytp-left-controls',          // 左側コントロール群
            ], player),
        };
    }

    // このアダプターを「youtube」という ID で登録します。
    // ホスト名が正規表現に一致したページで、inject.js が youtube() を呼び出します。
    registerSite('youtube', /(^|\.)(youtube\.com|youtube-nocookie\.com)$/, youtube);
})();
