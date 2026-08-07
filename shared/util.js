// SPDX-License-Identifier: Apache-2.0 OR MIT
/* ================================================================================================
 * shared/util.js — MAIN world 側の共通ユーティリティ（拡張 API に依存しない純粋な関数の詰め合わせ）
 *
 * 【どこから呼ばれるか】
 *   manifest.json の content_scripts（2 個目、world: "MAIN" のエントリ）の *先頭* で読み込まれ、
 *   その場で自動実行される。誰かが呼び出す関数は持たず、
 *   globalThis.__slipstreamliveUtil という置き土産を作って終わる。
 *
 *   その置き土産を、後から読み込まれる以下のファイルが取り込んで使う。
 *     adapters/youtube.js / twitch.js / twitcasting.js … 読み込み時に参照を確保しておく
 *     inject.js                                        … 参照を確保したうえで globalThis から削除する
 *
 *   最後に inject.js が削除するのは、ページ本体のスクリプトから本拡張の内部関数を
 *   触られないようにするため。adapters は各自の関数スコープ（IIFE）内に参照を持っているので、
 *   globalThis から消えても問題なく動き続ける。
 *
 * 【ISOLATED world から参照してはいけない理由】
 *   Chrome では同じファイルパスを 2 つの content_scripts エントリに書くと、片方（実測では MAIN 側）が
 *   注入されないという挙動がある。そのため common.js / content.js からは決して読み込まないこと。
 *   ISOLATED 側の共通処理は shared/schema.js と common.js が担当する。
 * ================================================================================================ */
(() => {
    'use strict';

    /* ============================================================================================
       数値ヘルパー
       ============================================================================================ */

    /**
     * 数値 n を [lo, hi] の範囲に押し込める（範囲外なら端の値にする）。
     *
     * @param {number} n - 対象の数値
     * @param {number} lo - 下限
     * @param {number} hi - 上限
     * @returns {number} 範囲内に収めた数値
     */
    const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

    /**
     * 何が来ても「使える有限の数値」か「NaN」のどちらかに変換する。
     * プレイヤーの内部 API は文字列・null・undefined を返すことがあるため、その受け皿。
     *
     * NaN を返すのには意味がある。NaN はどんな比較をしても false になるので、
     * 呼び出し側が「値が取れなかったから制御しない」という安全側の判断へ自然に倒れる。
     *
     * @param {any} value - 変換したい値
     * @returns {number} 有限数値。変換できなければ NaN
     */
    function toNum(value) {
        const num = Number.parseFloat(value);
        return Number.isFinite(num) ? num : NaN;
    }

    /* ============================================================================================
       DOM ヘルパー
       ============================================================================================ */

    /**
     * CSS セレクタの配列を上から順に試し、最初に見つかった要素を返す。
     *
     * 動画サイトは HTML 構造をよく変えるうえ、新旧の UI が混在することもある。
     * そこで「本命 → 次点 → 保険」と候補を並べておき、当たったものを使う方式にしている。
     * まず scope の中を探し、そこで見つからなければ document 全体をもう一周する。
     *
     * @param {string[]}   selectors        - CSS セレクタの配列（優先度の高い順）
     * @param {ParentNode} [scope=document] - 優先して探索する範囲
     * @returns {Element|null} 見つかった要素。どれも当たらなければ null
     */
    function pick(selectors, scope = document) {
        // new Set([...]) で重複を除く。scope が document のときに 2 周する無駄を省くため
        for (const root of new Set([scope ?? document, document])) {
            for (const selector of selectors) {
                const node = root.querySelector(selector);
                if (node) return node;
            }
        }
        return null;
    }

    /* ============================================================================================
       統計と時系列の窓
       ============================================================================================ */

    /**
     * 標本の配列 [{ at, value }, ...] から 件数・平均・母標準偏差 を求める。
     *
     *   avg = sum(value) / n
     *   sd  = Math.sqrt(sum((value - avg) ** 2) / n)
     *
     * 平均と分散を 1 回のループでまとめて計算する方法（二乗和から引く式）もあるが、
     * 値が大きいときに桁落ちで精度が落ちるため、あえて 2 回に分けて回している。
     *
     * @param {Array<{value: number}>} list - 標本の配列
     * @returns {{ n: number, avg: number, sd: number }} 空配列なら { n: 0, avg: NaN, sd: NaN }
     */
    function stats(list) {
        const n = list.length;          // 標本数
        if (n === 0) return { n: 0, avg: NaN, sd: NaN };

        let sum = 0;                    // 値の合計（1 パス目で使う）
        let acc = 0;                    // 偏差の二乗和（2 パス目で使う）

        for (const sample of list) sum += sample.value;
        const avg = sum / n;            // 平均

        for (const sample of list) acc += (sample.value - avg) ** 2;
        return { n, avg, sd: Math.sqrt(acc / n) };
    }

    /**
     * 時間窓 ms を過ぎた古い標本を、配列の先頭から捨てる（元の配列を直接書き換える破壊的な操作）。
     * 標本は時刻の昇順で push されている前提なので、先頭から順に見て古いものだけ落とせばよい。
     *
     * @param {Array<{at: number}>} list - 時刻昇順に並んだ標本配列
     * @param {number}              now  - 現在時刻（performance.now() 由来のミリ秒）
     * @param {number}              ms   - 保持したい時間窓の長さ（ミリ秒）
     * @returns {void}
     */
    function sliceWindow(list, now, ms) {
        let drop = 0;
        while (drop < list.length && now - list[drop].at > ms) drop++;
        if (drop > 0) list.splice(0, drop);
    }

    /**
     * 「時刻付きの標本を時間窓で保持し、統計を返す」振る舞いをまとめた小さな入れ物。
     *
     * inject.js の Auto は 短期窓（バッファ残量）・谷の履歴・水準の履歴 の 3 か所で、
     * まったく同じ「push → sliceWindow → stats → 端の差で時間幅を取る」を書き分けていた。
     * その重複をここへ寄せている。生の配列を外へ出さないので、
     * 「時刻昇順に push されている」という stats / sliceWindow の前提も破られにくくなる。
     *
     * @returns {Object} 時系列窓
     */
    function series() {
        const list = [];                // 時刻昇順に並んだ標本 [{ at, value }, ...]

        return {
            /** @returns {number} 現在保持している標本数 */
            get size() { return list.length; },

            /** @returns {{at: number, value: number}|undefined} いちばん古い標本 */
            first: () => list[0],

            /** @returns {{at: number, value: number}|undefined} いちばん新しい標本 */
            last: () => list[list.length - 1],

            /** @returns {number} 手元の標本が実際に張っている時間（ミリ秒）。空なら 0 */
            span: () => (list.length ? list[list.length - 1].at - list[0].at : 0),

            /** 標本をすべて捨てる。 @returns {void} */
            clear() { list.length = 0; },

            /**
             * 標本を 1 個積む。
             *
             * @param {number} at    - 観測時刻（performance.now() 由来のミリ秒）
             * @param {number} value - 観測値
             * @returns {void}
             */
            push(at, value) { list.push({ at, value }); },

            /**
             * 時間窓 ms より古い標本を捨てる。
             *
             * @param {number} now - 現在時刻（ミリ秒）
             * @param {number} ms  - 保持したい時間窓の長さ（ミリ秒）
             * @returns {void}
             */
            trim(now, ms) { sliceWindow(list, now, ms); },

            /** @returns {{ n: number, avg: number, sd: number }} 件数・平均・母標準偏差 */
            stats: () => stats(list),
        };
    }

    /* ============================================================================================
       遅延の基準線トラッカー
       ============================================================================================ */

    /**
     * 「今このユーザーは配信の最先端を見ているのか、それとも巻き戻して追っかけ再生しているのか」を
     * 判定するための小さな装置を作る（Twitch とツイキャス用）。
     *
     * 【なぜ必要か】
     *   遅延の生の値（例: 3.2 秒）だけでは、それが普通なのか異常なのか判断できない。
     *   配信の設定や回線状況によって「その配信にとっての普通の遅延」は大きく変わるからである。
     *   そこで観測した最小の遅延 low を「その配信の基準線」とみなし、
     *   そこから slack 秒以上遅れていたら巻き戻し中（追っかけ再生）と判断する。
     *
     * 【基準線が固定されない工夫】
     *   low を一度きりの最小値にしてしまうと、配信全体の遅延がじわじわ増えたときに
     *   ずっと「巻き戻し中」と誤判定してしまう。そこで毎秒 EASE 秒ずつ基準線を緩める（甘くする）。
     *
     *     low = Math.min(low + EASE * 経過秒数, latency)
     *
     * @param {number} [slack=2.5] - 基準線からこれ以上遅れたら巻き戻し中とみなす秒数
     * @returns {{ reset: function(): void, read: function(number): Object }} トラッカー
     */
    function tracker(slack = 2.5) {
        const EASE = 0.1;               // 1 秒あたり基準線を緩める量（秒／秒）
        let low    = Infinity;          // これまでに観測した最小の遅延（秒）＝基準線
        let at     = 0;                 // 前回 read() を呼んだ時刻（ミリ秒）

        return {
            /**
             * 基準線をリセットする（配信の切り替わりやバッファ枯渇の直後に呼ぶ）。
             *
             * @returns {void}
             */
            reset() {
                low = Infinity;
                at  = performance.now();
            },

            /**
             * 最新の遅延を渡して、基準線を更新しつつ「最先端にいるか」を判定する。
             *
             * @param {number} latency - 測定された現在のレイテンシ（秒）。取得できなければ NaN
             * @returns {{ latency: number, atHead: boolean }} atHead が false なら追っかけ再生中
             */
            read(latency) {
                const now = performance.now();
                if (Number.isFinite(latency)) {
                    low = Math.min(low + (EASE * (now - at)) / 1000, latency);
                    at  = now;
                }

                // latency が NaN のときは (NaN > slack) が false になるため、自動的に atHead: true となる。
                // 「判定できないなら最先端扱いにして余計な表示を出さない」という安全側の設計
                return { latency, atHead: !(latency - low > slack) };
            },
        };
    }

    /* ============================================================================================
       アダプタ共通の定数
       ============================================================================================ */

    /**
     * 動画の duration（尺）がこの値以上なら「終わりの決まっていないライブ配信」とみなす。
     * 100 万秒 ≒ 約 11.5 日で、通常の録画動画がこの長さになることはない。
     *
     * ※ 本来ライブ配信の duration は Infinity になるが、Firefox は Infinity ではなく
     *    INT64_MAX マイクロ秒という極端に大きな有限値を返すため、しきい値方式で両方を吸収する。
     */
    const ENDLESS = 1e6;

    /**
     * プレイヤー既存のボタン用 CSS クラスを流用できないサイト向けの、素のバッジスタイル。
     * YouTube は 'ytp-button' を借りられるが、Twitch とツイキャスは借りられる適当なクラスが無い。
     */
    const BADGE_STYLE_PLAIN = 'background:none;border:none;font-size:13px;font-family:inherit;'
        + 'line-height:1;align-self:center;white-space:nowrap';

    /* ============================================================================================
       プレイヤー操作のヘルパー
       ============================================================================================ */

    /**
     * オブジェクトのメソッドを「存在しない場合」と「例外を投げた場合」の両方に耐える形で呼び出す。
     *
     * サイト側のプレイヤー API はあくまで内部実装であり、公式に約束されたものではない。
     * サイト更新でメソッドごと消えることもあれば、再生していない状態で呼ぶと例外を投げることもある。
     * そのため、これらの呼び出しは必ずこのラッパー経由で行うルールにしている。
     *
     * @param {Object|null} target   - 呼び出し対象のオブジェクト
     * @param {string}      name     - メソッド名
     * @param {any}         fallback - メソッドが無い、または例外が出たときに返す値
     * @param {...any}      args     - メソッドへ渡す引数
     * @returns {any} メソッドの戻り値、または fallback
     */
    function safeCall(target, name, fallback, ...args) {
        try {
            return typeof target?.[name] === 'function' ? target[name](...args) : fallback;
        } catch { return fallback; }
    }

    /**
     * <video> の seekable（シーク可能な範囲）の末尾と現在再生位置から、遅延量（秒）を求める。
     * 公式の「レイテンシ取得 API」を持たないサイト向けの汎用手段。
     *
     *   delay = seekable.end(seekable.length - 1) - video.currentTime
     *
     * seekable の末尾は「配信としていま到達している最先端の時刻」に相当するので、
     * そこから現在の再生位置を引けば、どれだけ遅れて見ているかが分かる。
     *
     * @param {HTMLVideoElement|null} video - 対象の <video> 要素
     * @returns {number} レイテンシ（秒）。取得できなければ NaN
     */
    function seekableLatency(video) {
        try {
            const ranges = video?.seekable;
            return ranges?.length ? ranges.end(ranges.length - 1) - video.currentTime : NaN;
        } catch { return NaN; }
    }

    /**
     * プレイヤーのルート要素と <video> 要素を探し出し、差し替わりを追いかけ続ける監視役を作る。
     *
     * 動画サイトはページ遷移（SPA 遷移）や広告の明け際にプレイヤーごと DOM を作り直すことがある。
     * そのたびに掴んでいた <video> は無効になるため、次の 4 つをまとめて面倒みる。
     *
     *   1. 掴んでいたルート要素が DOM から外れていたら、セレクタ配列で探し直す
     *   2. その配下（見つからなければ document 全体）から <video> を取得する
     *   3. <video> が別物に差し替わったら waiting リスナーを付け替え、onSwap で持ち主へ知らせる
     *   4. ルート要素がその <video> を含んでいない場合は、<video> の親要素を器として代用する
     *
     * @param {Object}           options           - 設定オブジェクト
     * @param {string[]}         options.roots     - プレイヤールートの候補セレクタ（優先度順）
     * @param {function(): void} [options.onSwap]  - <video> が差し替わった直後に呼ばれる
     * @param {function(): void} [options.onStall] - waiting（読み込み待ち）発生時に呼ばれる
     * @returns {{ root: Element|null, video: HTMLVideoElement|null, find: function(): HTMLVideoElement|null }}
     */
    function videoWatcher({ roots, onSwap, onStall }) {
        const RETRY_MS = 1000;          // 代用中に本来のルートを探し直す間隔（ミリ秒）

        let root       = null;          // 現在掴んでいるプレイヤーのルート要素
        let video      = null;          // 現在掴んでいる <video> 要素
        let improvised = false;         // root が <video> の親要素による「代用」かどうか
        let retryAt    = -Infinity;     // 次に代用からの復帰を試みてよい時刻（ミリ秒）

        // バッファ枯渇による読み込み停止。ユーザー自身のシーク操作でも waiting は出るため、それは除外する
        const stalled = () => { if (video && !video.seeking) onStall?.(); };

        return {
            get root() { return root; }, // 外からは読み取り専用として公開する
            get video() { return video; },

            /**
             * ルート要素と <video> を解決し直して、監視対象を最新の状態にする。
             *
             * 代用ルート（<video> の親要素）を掴んでいる間も RETRY_MS ごとに本来のルートを探し直す。
             * こうしないと、プレイヤーの UI が後から組み上がった場合に代用のまま固定されてしまい、
             * バッジがコントロールバーへ引っ越せなくなる。
             *
             * @returns {HTMLVideoElement|null} 最新の <video> 要素。見つからなければ null
             */
            find() {
                const now = performance.now();
                if (!root?.isConnected || (improvised && now - retryAt >= RETRY_MS)) {
                    retryAt = now;
                    const found = pick(roots); // DOM から外れていたら／代用中なら探し直す
                    if (found) { root = found; improvised = false; }
                    else if (!root?.isConnected) { root = null; improvised = false; }
                }

                // querySelector はどちらも見つからなければ null を返すので、追加の既定値は要らない
                const next = root?.querySelector('video') ?? document.querySelector('video');
                if (next !== video) {
                    video?.removeEventListener('waiting', stalled);
                    video = next;
                    video?.addEventListener('waiting', stalled);
                    onSwap?.();
                }

                // セレクタが空振りした場合や、<video> を含まない要素を掴んでしまった場合は親要素で代用する。
                // ルート要素はバッジの表示位置を決める「器」としても使うため、必ず <video> を含む必要がある
                if (video && (!root || root === video || !root.contains(video))) {
                    root       = video.parentElement;
                    improvised = true;
                }

                return video;
            },
        };
    }

    /**
     * サイトアダプタをグローバルのレジストリ（登録簿）へ登録する。
     * 各 adapters/*.js が読み込まれた時点で自分自身を登録し、後から起動する inject.js が
     * ホスト名に一致するものを 1 つ選んで使う、という流れになっている。
     *
     * @param {string}             id     - サイト識別子（'youtube' など）
     * @param {RegExp}             host   - ホスト名を判定する正規表現
     * @param {function(): Object} create - アダプタ本体を生成するファクトリ関数
     * @returns {void}
     */
    function registerSite(id, host, create) {
        (globalThis.__slipstreamliveSites ??= {})[id] = { host, create };
    }

    // MAIN world のグローバルへ置き土産を登録する（inject.js が取り込んだ直後に削除する）。
    // ??= は「まだ値が入っていないときだけ代入する」演算子で、二重読み込み時の上書きを防ぐ
    globalThis.__slipstreamliveUtil ??= {
        clamp, toNum, pick, series, tracker,
        ENDLESS, BADGE_STYLE_PLAIN, safeCall, seekableLatency, videoWatcher, registerSite,
    };
})();
