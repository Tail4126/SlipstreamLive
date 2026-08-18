// SPDX-License-Identifier: Apache-2.0 OR MIT
/* ================================================================================================
 * adapters/youtube.js — YouTube 用のプレイヤー操作アダプタ
 *
 * 【どこから呼ばれるか】
 *   manifest.json の content_scripts（MAIN world）から shared/util.js の次に読み込まれ、
 *   その場で自動実行される。実行時に行うのは registerSite() による自己登録だけで、
 *   DOM には一切触れない（document_start 時点では DOM がまだ存在しないため）。
 *
 *   実際にアダプタが作られるのは、最後に読み込まれる inject.js が
 *   ホスト名を照合して create()（＝下の youtube 関数）を呼んだときである。
 *   以降、inject.js のメインループが毎回このアダプタのメソッドを呼び出す。
 *
 * 【アダプタとは何か】
 *   inject.js は「バッファに余裕があれば加速し、枯渇寸前なら最低速度まで落とす」という
 *   サイトに依存しない共通のルールだけを持ち、「この <video> はどこにあるのか」
 *   「今ライブなのか」「遅延は何秒か」といったサイトごとに違う部分をアダプタへ丸投げしている。
 *   サイトを追加したいときはこのファイルと同じ形のアダプタを 1 つ書き足せばよい、
 *   という構造になっている。
 *
 * 【YouTube ならではの事情】
 *   YouTube は公式プレイヤー（#movie_player）が便利な API メソッドを大量に公開しているため、
 *   DOM を推測で漁る必要がほとんど無く、3 サイトの中でもっとも素直に実装できる。
 *
 * 【補足】
 *   表示名・既定値などの設定まわりの情報は shared/schema.js が持っている（このファイルには無い）。
 * ================================================================================================ */
(() => {
    'use strict';

    // shared/util.js の置き土産を取り込む。inject.js が globalThis から削除する前に確保しておく
    const util = globalThis.__slipstreamliveUtil;
    if (!util) return;                              // 読み込み順が壊れている場合は登録せず終了

    const { pick, toNum, safeCall, registerSite } = util;

    /**
     * YouTube 用アダプタの本体を生成する。
     *
     * @returns {Object} inject.js が使うアダプタ（respectUserRate / gap / video() / media() など）
     */
    function youtube() {
        // 掴んでいるプレイヤー要素（通常は #movie_player）
        let player = null;

        // プレイヤー内部の <video> 要素
        let video = null;

        // 配信の遅延種別を表す文字列（'...LATENCY_ULTRA_LOW' など）。
        // これを取得する getPlayerResponse() は重い処理なので、一度取れたら動画が変わるまで使い回す
        let latencyClass = '';

        // プレミア公開かどうかの判定結果と、その判定が対応する動画 ID。
        // 判定にはやはり重い getPlayerResponse() が要るので、動画ごとに 1 度だけ問い合わせる
        let premiere   = false;
        let premiereId = null;

        /**
         * プレイヤーの内部 API メソッドを安全に呼ぶための短縮形。
         * メソッドが存在しない・例外を投げるといった場合は undefined が返る。
         *
         * @param {string} name - プレイヤー API のメソッド名
         * @param {...any} args - メソッドへ渡す引数
         * @returns {any} 戻り値。呼び出せなければ undefined
         */
        const call = (name, ...args) => safeCall(player, name, undefined, ...args);

        return {
            // YouTube はプレイヤー UI に速度変更メニューがある。
            // ユーザーが手動で 1.0 倍以外を選んだときは、拡張機能は制御を譲って手を引く
            respectUserRate: true,

            // 連続したバッファとみなす隙間の許容値（秒）。数フレーム分のごく小さな途切れを想定
            gap: 0.5,

            // バッジ（プレイヤー上の小さな表示）に流用する YouTube 既存のボタン用クラス
            badgeClass: 'ytp-button',
            badgeStyle: '',                         // クラスで十分なので追加スタイルは不要

            /**
             * 別の動画へ切り替わったときに、キャッシュしていた遅延種別を捨てる。
             *
             * プレミア公開の判定結果（premiere / premiereId）はここでは捨てない。
             * あちらは動画 ID を鍵にして media() が自分で判定し直すため捨てる必要が無く、
             * かつ reset() は media() より後に呼ばれるので、ここで捨てると動画が変わるたびに
             * getPlayerResponse() を 1 回余計に呼ぶことになる。
             *
             * @returns {void}
             */
            reset() { latencyClass = ''; },

            /**
             * バッジの表示位置を決める際の「器」となるプレイヤー要素を返す。
             *
             * @returns {Element|null} プレイヤー要素
             */
            root: () => player,

            /**
             * 監視対象の <video> 要素を取得する。
             * YouTube はページ遷移でプレイヤーごと差し替わるため、毎回確認し直す。
             *
             * 【#movie_player を毎回最優先で掴み直す理由】
             *   ホーム画面のサムネイルにマウスを乗せると出るプレビュー用プレイヤー
             *   （#inline-preview-player.html5-video-player）は、watch ページへ遷移した後も
             *   DOM に残り続ける。そのため「掴んでいる要素がまだ DOM にあるか」だけで判定すると
             *   プレビュー側を掴んだまま離さず、本来の動画を制御できなくなってしまう。
             *
             * @returns {HTMLVideoElement|null} 監視対象の <video>。見つからなければ null
             */
            video() {
                const main = document.querySelector('#movie_player');    // 通常の視聴ページのプレイヤー

                if (main) {
                    if (player !== main) { player = main; latencyClass = ''; }
                } else if (!player?.isConnected) {
                    player = pick(['.html5-video-player']);              // 埋め込み・モバイル向けの保険
                }

                if (!video?.isConnected || !player?.contains(video)) {
                    video = player?.querySelector('video') ?? null;
                }
                return video;
            },

            /**
             * 再生中のコンテンツの識別 ID・ライブ配信かどうか・プレミア公開かどうかを返す。
             *
             * 【広告を弾く理由】
             *   YouTube は広告を本編と同じ <video> で再生するが、getVideoData() は
             *   広告中も本編の video_id と isLive をそのまま返し続ける。そのため API だけでは
             *   広告を見分けられず、広告のバッファ（尺のぶん丸ごと読み込み済み → 末尾で枯渇）を
             *   本編の指標として読んでしまい、加速と最低速を往復することになる。
             *   プレイヤーの ad-showing クラスだけが広告区間と正確に一致するので、これを使う。
             *   ad-created は一度広告が入ると残り続けるため使ってはいけない。
             *
             * 【プレミア公開の見分け方】
             *   プレミア公開は「あらかじめ用意した録画を、決まった時刻からライブとして流す」機能で、
             *   再生中は isLive が true になり、本物のライブ配信と区別が付かない。
             *   区別できるのは videoDetails.isLiveContent のほうで、こちらは
             *   「素材そのものがライブとして作られたか」を表す。
             *
             *       本物のライブ配信 … isLive: true  / isLiveContent: true
             *       プレミア公開     … isLive: true  / isLiveContent: false
             *       通常の動画       … isLive: false / isLiveContent: false
             *
             *   すでに isLive が true のときだけ引くので、判定は isLiveContent を見るだけでよい。
             *   getPlayerResponse() は重いため、動画 ID が変わったときにだけ呼び直す。
             *
             *   問い合わせはこの return と同じ tick の中で済むので、「まだ判定が付いていない」
             *   状態が続くのは getPlayerResponse() 自体が使えないときに限られる。その場合は
             *   premiereId を進めず次の tick で取り直しつつ、premiere は false のまま
             *   （＝通常のライブ配信として扱う）を選んでいる。逆に倒すと、この API が読めない
             *   プレイヤーでは YouTube のライブ配信すべてが制御対象から外れてしまい、
             *   「プレミア公開に少し手を出す」よりはるかに影響が大きいためである。
             *
             * @returns {{ id: string|null, live: boolean, premiere: boolean }} 再生中のコンテンツ
             */
            media() {
                const data = call('getVideoData');
                const ad   = player?.classList.contains('ad-showing') === true;
                const id   = ad ? 'ad' : (data?.video_id ?? null);
                const live = !ad && data?.isLive === true;

                if (live && id !== premiereId) {
                    const details = call('getPlayerResponse')?.videoDetails;
                    if (details) {
                        premiere   = details.isLiveContent !== true;
                        premiereId = id;
                    }
                }

                return { id, live, premiere: live && premiere };
            },

            /**
             * 配信の遅延（秒）と、追っかけ再生（DVR）中かどうかを返す。
             * YouTube は両方とも公式 API で取得できるため、util.js のトラッカーは使わない。
             *
             * @returns {{ latency: number, atHead: boolean }} atHead が false なら巻き戻して視聴中
             */
            status: () => ({
                latency: toNum(call('getStatsForNerds')?.live_latency_secs),
                atHead: call('getProgressState')?.isAtLiveHead !== false,
            }),

            /**
             * 自動しきい値（speedupAuto）が使う「この配信で目安となるバッファ量」を秒で返す。
             *
             *   1. セグメント長（segduration）が取れればそれをそのまま使うのが最も正確
             *   2. 取れなければ配信の遅延クラスから推定する
             *      ULTRA_LOW（超低遅延）→ 1 秒 ／ LOW（低遅延）→ 2 秒 ／ それ以外（通常）→ 5 秒
             *
             * セグメントとは、配信映像を数秒ずつに切り分けた配信単位のこと。
             * inject.js の Auto はこの値を「統計をとる時間窓の長さ」の基準に使う。
             *
             * @returns {number} 目安となるバッファ量（秒）
             */
            needs() {
                const segment = toNum(call('getVideoStats')?.segduration);
                if (segment > 0) return segment;

                // ||= は「左辺が空文字などの偽値のときだけ代入する」演算子。取得済みなら再取得しない
                latencyClass ||= String(call('getPlayerResponse')?.videoDetails?.latencyClass ?? '');

                if (latencyClass.endsWith('ULTRA_LOW')) return 1;
                if (latencyClass.endsWith('LOW')) return 2;
                return 5;
            },

            /**
             * バッジを差し込む場所（コントロールバー内のスロット）を探す。
             * 新 UI → 旧 UI → 左側コントロール群、の順に候補を試す。
             *
             * @returns {Element|null} 差し込み先の要素。見つからなければ null（帯 UI へ退避する）
             */
            host: () => pick([
                'player-time-display .ytwPlayerTimeDisplayLiveDot',
                '.ytp-time-display .ytp-time-wrapper',
                '.ytp-chrome-controls .ytp-left-controls',
            ], player ?? document),
        };
    }

    registerSite('youtube', /(^|\.)(youtube\.com|youtube-nocookie\.com)$/, youtube);
})();
