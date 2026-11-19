// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * adapters/twitcasting.js — TwitCasting（ツイキャス）専用の「アダプター」
 * =============================================================================
 *
 * ■ ツイキャスならではの難しさ
 *   YouTube のような内部 API も、Twitch のような React ツリーもありません。
 *   使えるのは <video> 要素そのものだけです。そのため、
 *     - 遅延      … seekable（シーク可能範囲）の末尾から推定
 *     - ライブ判定 … 動画の長さ（duration）が伸び続けているかで推定
 *   というように、標準の情報だけで工夫して判断しています。
 *
 * ■ 配信の届き方は 3 通り（2026 年 11 月に PlayerPage2.js で確認）
 *   1) 低遅延 fMP4 … 既定。MSE（Worker 側の MediaSource）で届き、バッファは 0.2〜0.4 秒ほど。
 *   2) HLS         … 環境によって使われる通常の方式。
 *   3) WebRTC      … プレーヤーの設定で「超低遅延(β)」を入れたとき。
 *   WebRTC にはバッファという概念が無く、速度を変えても意味がない
 *   （むしろ音声が壊れる）ため、対象外として扱います。
 *
 * ■ アダプターの役割については adapters/youtube.js の冒頭コメントを参照。
 */
(() => {
    'use strict';

    const util = globalThis.__slipstreamliveUtil;
    if (!util) return;

    const { pick, tracker, seekableLatency, videoWatcher, registerSite,
        ENDLESS, BADGE_STYLE_PLAIN } = util;

    /** 録画ページ（/ユーザー名/movie/数字）の URL を見分ける正規表現。 */
    const MOVIE = /\/movie\/\d+/;

    /**
     * 「動画の長さが伸びた」と判断するのに必要な増加量（秒）。
     * 小さすぎる変化はノイズなので、これ以上増えて初めてライブと見なします。
     */
    const GROWTH = 0.25;

    /**
     * TwitCasting 用アダプターを生成する。
     * @returns {object} アダプターオブジェクト
     */
    function twitcasting() {
        /**
         * プレーヤーの外枠を探すためのセレクター候補（優先度順）。
         *
         * 2026 年 11 月のライブページの構造（外側 → 内側）：
         *   div.tw-player > div.tw-player__body > div#player > div.tc-player
         *     > div.tw-stream-movie-layout__movie > div.tw-stream-player > video.tw-stream-player-video
         * <video> とコントロールの両方を含むいちばん内側の枠は `.tc-player` です。
         */
        const ROOTS = ['.tc-player', '#player'];

        /**
         * バッジを差し込む場所の候補（優先度順）。
         *
         * コントロールバーは次の作りです（2026 年 11 月）：
         *   div.tw-movie-control-layout
         *     > div.tw-movie-control-layout__inner（横並び。左右の両端に寄せる）
         *         > div.tw-movie-control-layout__bottom-item（左：音量）
         *         > div.tw-movie-control-layout__bottom-item（右：設定・シアター・全画面）
         * 1 つ目の候補は文書順で最初に当たる「左の組」で、バッジは音量の右隣に並びます。
         *
         * `.tw-player-control` を候補にしてはいけません。このクラスはバーではなく、音量の部品と
         * 個々のボタンに付いていて、最初に当たるのは音量の部品（`.tw-volume-control`）そのものです。
         * そこへ入れると、バッジが音量スライダーの部品の内側に入り込んでしまいます。
         */
        const BARS = ['.tw-movie-control-layout__bottom-item', '.tw-movie-control-layout__inner'];

        /** 遅延を追跡し、巻き戻し視聴中かどうかを判定する道具。 */
        const latency = tracker();

        /**
         * media() の結果の入れ物。制御ループから頻繁に呼ばれるので、
         * 呼ぶたびに作らず中身だけ書き換えて返します。
         * @type {{ id: string, live: boolean }}
         */
        const current = { id: '', live: false };

        /** @type {number} 最初に観測した動画の長さ（秒）。まだ観測していなければ NaN */
        let first = NaN;
        /** @type {boolean} 動画の長さが伸び続けている＝ライブと判断できたか */
        let growing = false;

        /**
         * 覚えていた情報をすべて忘れる。
         * @returns {void}
         */
        const forget = () => {
            latency.reset();
            first = NaN;
            growing = false;
        };

        // <video> 要素の入れ替わりを見張る共通部品。
        const watcher = videoWatcher({
            roots: ROOTS,
            onSwap: forget,
            onStall: () => latency.reset(),
        });

        /**
         * この動画が WebRTC 配信（超低遅延(β)）かどうかを判定する。
         *
         * WebRTC のときは srcObject に MediaStream が入ります。既定の低遅延 fMP4 でも srcObject は
         * 使われますが、入るのは MediaSourceHandle（Worker 側の MediaSource）なので区別できます。
         * @returns {boolean} WebRTC 配信なら true
         */
        const webrtc = () => watcher.video?.srcObject instanceof MediaStream;

        /**
         * 動画の長さから「ライブ配信かどうか」を推定する。
         *
         * 考え方：録画は長さが固定だが、ライブは時間とともに伸び続ける。
         *   - 長さが不明（NaN）               → 読み込み中かもしれないので、とりあえずライブ扱い
         *   - 長さが極端に大きい（ENDLESS 超）  → ライブ確定
         *   - 最初に観測した長さより GROWTH 秒を超えて伸びた → ライブ確定（以後 growing を立てたまま）
         *
         * ■ 「前回より」ではなく「最初より」伸びたかを見る理由
         *   この関数は、待機中は 1 秒ごと、動画のイベント（timeupdate や progress）が届くたびには
         *   0.1〜0.25 秒ごとに呼ばれます。前回の値と比べると、1 回あたりの伸びは呼ばれる間隔ぶん
         *   （0.25 秒以下）にしかならず、長さが少しずつ滑らかに伸びる配信では、いつまでも
         *   GROWTH を超えずにライブと判定できませんでした（Chromium で、0.25 秒ごとの timeupdate と
         *   一緒に長さを伸ばして確かめると、6 秒たっても制御が始まりませんでした）。
         *   最初の値と比べれば、呼ばれる間隔に関係なく、伸びた分がそのまま積み上がります。
         *
         * 長さが 0 以下のときは、まだ読み込みが始まっていないとみなし、最初の値にしません
         * （0 から本来の長さへ変わっただけの録画を、伸びたと取り違えないためです）。
         * @returns {boolean} ライブと推定されれば true
         */
        function endless() {
            const now = watcher.video?.duration ?? NaN;
            if (Number.isNaN(now)) return true;
            if (now >= ENDLESS) return true;
            if (!(now > 0)) return growing;

            if (Number.isNaN(first)) first = now;
            if (now - first > GROWTH) growing = true;
            return growing;
        }

        return {
            // ライブのプレーヤーには再生速度のメニューがありません（設定にあるのは画質・超低遅延(β)・
            // アイテム・テロップ・リスナーコラボの表示だけ。速度を選べるのは録画ページで、録画は
            // もともと制御の対象外です）。そのため、尊重すべき「ユーザーが選んだ速度」はありません。
            //
            // 一方で、ツイキャス自身のプレーヤーは、遅れが大きいときに playbackRate を 1.02 にして
            // 追いつこうとします（PlayerPage2.js の adjustPlaybackRate）。ここを true にしていると、
            // その 1.02 を「ユーザーが選んだ速度」と取り違えて、ページが 1.00 に戻すまで加速も
            // 最低速度も止めてしまいます。false にして、Twitch・Kick・DAZN と同じように
            // ページからの書き込みを横取りし、この拡張機能の判断を優先します。
            respectUserRate: false,

            // バッファはほぼ連続しているので、隙間の許容は小さめ（0.5 秒）。
            gap: 0.5,

            badgeClass: '',
            badgeStyle: BADGE_STYLE_PLAIN,

            reset: forget,
            root: () => watcher.root,
            video: () => watcher.find(),

            /**
             * 現在再生中のメディアの情報を返す。
             *
             * ライブ判定の条件は 3 つすべてを満たすこと：
             *   1) WebRTC 配信ではない
             *   2) URL が録画ページ（/movie/数字）ではない
             *   3) 動画の長さが伸び続けている
             * @returns {{ id: string, live: boolean }}
             */
            media() {
                const path   = location.pathname;
                current.id   = path.toLowerCase();
                current.live = !webrtc() && !MOVIE.test(path) && endless();
                return current;
            },

            /**
             * 現在の遅延と、ライブ最前線にいるかを返す。
             * 遅延を教えてくれる API が無いため、seekable から推定します
             * （tracker は結果の入れ物を使い回します）。
             * @returns {{ latency: number, atHead: boolean }}
             */
            status: () => latency.read(seekableLatency(watcher.video)),

            /**
             * このサイトが必要とするバッファの目安（秒）を返す。
             * ツイキャスは低遅延志向でセグメントが短いため、0.5 秒としています。
             * @returns {number}
             */
            needs: () => 0.5,

            /**
             * バッジを差し込みたい場所（コントロールバーの左の組）を返す。
             * @returns {Element|null}
             */
            host: () => pick(BARS, watcher.root),
        };
    }

    // このアダプターを「twitcasting」という ID で登録する。
    registerSite('twitcasting', /(^|\.)twitcasting\.tv$/, twitcasting);
})();
