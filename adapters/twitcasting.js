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
 * ■ WebRTC 配信について
 *   ツイキャスの一部の配信は WebRTC（リアルタイム通信）で届きます。
 *   この方式にはバッファという概念が無く、速度を変えても意味がない
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
         * ツイキャスは PC 版・スマホ版・埋め込みで構造が違ううえ、
         * 過去のバージョンも混在するため、候補を多めに用意しています。
         */
        const ROOTS = ['.tc-player', '#player', '#player-container', '#playerarea', '#jsplayer',
            '.tw-player', '.tw-stream-player-video', '.video-container'];

        /**
         * バッジを差し込むコントロールバーの候補。
         * 末尾の 3 つは `[class*="..."]`（クラス名の部分一致）を使った、
         * 「名前は分からないがそれらしい要素」を拾うための最後の砦です。
         */
        const BARS = ['.tw-player-control', '.tw-movie-control-layout__inner', '.tw-movie-control-layout',
            '.tw-player-controls', '.tw-player-buttons', '.tw-stream-player-controller',
            '.vjs-control-bar', '[class*="player-control"]', '[class*="movie-control"]', '[class*="control-bar"]'];

        /** 遅延を追跡し、巻き戻し視聴中かどうかを判定する道具。 */
        const latency = tracker();

        /**
         * media() の結果の入れ物。制御ループから頻繁に呼ばれるので、
         * 呼ぶたびに作らず中身だけ書き換えて返します。
         * @type {{ id: string, live: boolean }}
         */
        const current = { id: '', live: false };

        /** @type {number} これまでに観測した動画の最大長（秒） */
        let span = NaN;
        /** @type {boolean} 動画の長さが伸び続けている＝ライブと判断できたか */
        let growing = false;

        /**
         * 覚えていた情報をすべて忘れる。
         * @returns {void}
         */
        const forget = () => {
            latency.reset();
            span = NaN;
            growing = false;
        };

        // <video> 要素の入れ替わりを見張る共通部品。
        const watcher = videoWatcher({
            roots: ROOTS,
            onSwap: forget,
            onStall: () => latency.reset(),
        });

        /**
         * この動画が WebRTC 配信かどうかを判定する。
         *
         * 通常の動画は src に URL が入りますが、WebRTC の場合は
         * srcObject に MediaStream オブジェクトが入ります。そこを見ています。
         * （MediaStream は最新の Chrome / Firefox なら必ず存在します）
         * @returns {boolean} WebRTC 配信なら true
         */
        const webrtc = () => watcher.video?.srcObject instanceof MediaStream;

        /**
         * 動画の長さから「ライブ配信かどうか」を推定する。
         *
         * 考え方：録画は長さが固定だが、ライブは時間とともに伸び続ける。
         *   - 長さが不明（NaN）           → 読み込み中かもしれないので、とりあえずライブ扱い
         *   - 長さが極端に大きい（ENDLESS 超）→ ライブ確定
         *   - 前回より GROWTH 秒以上伸びた   → ライブ確定（以後 growing を立てたまま）
         * @returns {boolean} ライブと推定されれば true
         */
        function endless() {
            const now = watcher.video?.duration ?? NaN;
            if (Number.isNaN(now)) return true;
            if (now >= ENDLESS) return true;

            // 前回の最大値より十分伸びていれば「伸び続けている」と判定。
            if (now > span + GROWTH) growing = true;

            // 観測した最大長を更新する。
            // `if (!(now <= span))` は `if (now > span)` とほぼ同じ意味ですが、
            // span が NaN のときも条件が成立する（NaN との比較は常に false になるため
            // 否定で true になる）点が違います。初回の代入をこれで賄っています。
            if (!(now <= span)) span = now;

            return growing;
        }

        return {
            // ツイキャスのプレーヤーには速度変更機能があるため、ユーザー操作を尊重します。
            respectUserRate: true,

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
             * バッジを差し込みたい場所（コントロールバー）を返す。
             * @returns {Element|null}
             */
            host: () => pick(BARS, watcher.root),
        };
    }

    // このアダプターを「twitcasting」という ID で登録する。
    registerSite('twitcasting', /(^|\.)twitcasting\.tv$/, twitcasting);
})();
