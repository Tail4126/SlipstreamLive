// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * shared/util.js — メインワールド側で使う「汎用ツール集」
 * =============================================================================
 *
 * ■ このファイルは何をするもの？
 *   inject.js とサイトアダプター（youtube / twitch / twitcasting）が
 *   共通して使う小さな部品を集めたファイルです。
 *   数値の丸め、時系列データの記録、<video> 要素の探索などが入っています。
 *
 * ■ 読み込まれる場所
 *   メインワールド（ページ本体と同じ実行環境）で、アダプターより先に読み込まれます。
 *   ここには拡張機能の API を使うコードは一切ありません（使えないため）。
 *
 * ■ 速さについて
 *   ここの部品の多くは、inject.js の制御ループから 1 秒間に約 50 回呼ばれます。
 *   そのため「呼ばれるたびにオブジェクトや配列を作らない」「データ量に比例して
 *   遅くならない」ことを優先した作りにしています。
 *
 * ■ 受け渡しの仕組み
 *   最後に globalThis.__slipstreamliveUtil へ道具一式を置きます。
 *   inject.js がそれを受け取ったあと、変数ごと削除して痕跡を消します
 *   （メインワールドのグローバル変数はページ側のスクリプトからも見えるため）。
 */
(() => {
    'use strict';

    /**
     * 数値を指定の範囲内に収める（クランプ処理）。
     * 例: clamp(1.5, 0, 1) → 1 ／ clamp(-3, 0, 1) → 0
     * @param {number} n 対象の数値
     * @param {number} lo 下限
     * @param {number} hi 上限
     * @returns {number} lo 以上 hi 以下に収めた値
     */
    const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

    /**
     * 何でも受け取って「使える数値」に変換する。
     * 数値にできない場合は NaN（Not a Number）を返すので、
     * 受け取った側は Number.isFinite() で有効性を判定できます。
     * @param {unknown} value 変換したい値
     * @returns {number} 数値。変換できなければ NaN
     */
    function toNum(value) {
        const num = Number.parseFloat(value);
        return Number.isFinite(num) ? num : NaN;
    }

    /**
     * 複数の CSS セレクターを順番に試して、最初に見つかった要素を返す。
     *
     * 動画サイトは HTML 構造をしばしば変更するため、「本命 → 代替 →
     * さらに代替」と候補を並べておき、どれか当たればよい、という設計にしています。
     *
     * scope（探す起点）で見つからなければ document 全体でも探します。
     * scope に null を渡した場合は、最初から document 全体を探します。
     * @param {string[]} selectors 試す CSS セレクターの配列（優先度順）
     * @param {ParentNode|null} [scope=document] 探す起点となる要素
     * @returns {Element|null} 見つかった要素。無ければ null
     */
    function pick(selectors, scope = document) {
        const root = scope ?? document;
        for (const selector of selectors) {
            const node = root.querySelector(selector);
            if (node) return node;
        }
        if (root === document) return null;
        for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (node) return node;
        }
        return null;
    }

    /**
     * series() が合計を一から計算し直す間隔（追加・削除の回数）。
     * 理由は series() の「丸め誤差について」を参照してください。
     */
    const REBASE_EVERY = 1024;

    /** series() が最初に確保する長さ（サンプル数）。足りなくなったら 2 倍ずつ広げます。 */
    const SERIES_FIRST_CAPACITY = 64;

    /**
     * 時系列データを記録する「シリーズ」オブジェクトを作る。
     *
     * ■ 仕組み：リングバッファ
     *   決まった長さの配列を「輪」のように使い回します。新しいサンプルは末尾に書き、
     *   古いサンプルは先頭の位置（head）を 1 つ進めるだけで捨てます。
     *   普通の配列で先頭を捨てる（splice）と、残りを全部 1 つずつ前へずらす必要があり、
     *   データが多いほど遅くなりますが、この方式なら量に関係なく一瞬で済みます。
     *
     *   時刻と値は Float64Array（数値専用の配列）に分けて持ちます。サンプルごとに
     *   { at, value } のようなオブジェクトを作らないので、メモリを食わず、
     *   ゴミ集め（GC）の手間も生みません。
     *
     * ■ 仕組み：合計の持ち回り
     *   合計・平均・標準偏差は、サンプルを足し引きするたびに「合計」と「2 乗の合計」を
     *   更新しておき、そこから計算します。毎回すべてのサンプルを足し直さないので、
     *   制御ループのたびに統計を求めても負担になりません。
     *
     * ■ 丸め誤差について
     *   小数の足し引きを長く続けると、ごくわずかな誤差が積み重なります。そこで
     *   (1) 値から基準値（base ≒ 平均）を引いてから足し合わせ、桁あふれによる誤差を抑える
     *   (2) REBASE_EVERY 回ごとに基準値を取り直し、合計を一から計算し直す
     *   という 2 つの手当てをしています。結果は全サンプルを毎回足し直す方式と、
     *   判断に影響しない桁（10 の -9 乗程度以下）まで一致します。
     *
     * サンプルは必ず古い順（時刻の昇順）に push される前提です。
     * 有限でない値（NaN など）が窓の中に 1 つでもある間は、平均・標準偏差・合計が NaN になります。
     * @returns {{
     *   readonly size: number,
     *   firstAt: () => number, firstValue: () => number,
     *   lastAt: () => number, lastValue: () => number,
     *   span: () => number,
     *   clear: (release?: boolean) => void,
     *   push: (at: number, value: number) => void,
     *   trim: (now: number, ms: number) => void,
     *   sum: () => number, mean: () => number, sd: () => number
     * }} 時系列データ操作用のオブジェクト
     */
    function series() {
        /** @type {number} 確保済みの長さ。最初は 0 で、初めて追加したときに確保します */
        let cap  = 0;
        /** @type {Float64Array} 各サンプルの時刻 */
        let at   = new Float64Array(0);
        /** @type {Float64Array} 各サンプルの値 */
        let val  = new Float64Array(0);
        let head = 0; // 最も古いサンプルの位置
        let size = 0; // 入っているサンプルの数
        let bad  = 0; // 窓の中にある有限でない値の数
        let base = 0; // 足し合わせる前に引く基準値
        let sum  = 0; // Σ(値 − base)（有限の値だけ）
        let sq   = 0; // Σ(値 − base)²（有限の値だけ）
        let dirt = 0; // 前回、合計を計算し直してからの追加・削除の回数

        /**
         * 古い順で i 番目のサンプルが、配列のどこにあるかを返す。
         * 末尾を越えたら先頭へ折り返します（これが「輪」の部分）。
         * @param {number} i 古い順の番号（0 が最も古い）
         * @returns {number} 配列上の位置
         */
        const slot = (i) => {
            const j = head + i;
            return j < cap ? j : j - cap;
        };

        /**
         * 配列を 2 倍の長さに広げる。中身は古い順に先頭から詰め直します。
         * @returns {void}
         */
        function grow() {
            const next    = cap ? cap * 2 : SERIES_FIRST_CAPACITY;
            const nextAt  = new Float64Array(next);
            const nextVal = new Float64Array(next);
            for (let i = 0; i < size; i++) {
                const j = slot(i);
                nextAt[i]  = at[j];
                nextVal[i] = val[j];
            }
            at   = nextAt;
            val  = nextVal;
            head = 0;
            cap  = next;
        }

        /**
         * 基準値を今の平均に取り直し、合計を一から計算し直す（丸め誤差のリセット）。
         *
         * 輪の中身は「head から配列の末尾まで」と「配列の先頭から折り返した残り」の
         * 2 区間に分かれているので、区間ごとにまっすぐ回します（1 個ずつ位置を計算しないため）。
         * @returns {void}
         */
        function rebase() {
            const end  = Math.min(head + size, cap); // 1 区間目の終わり（この位置は含まない）
            const wrap = head + size - end;          // 2 区間目（先頭から折り返した部分）の個数

            let total = 0;
            let count = 0;
            for (let j = head; j < end; j++) {
                const v = val[j];
                if (Number.isFinite(v)) { total += v; count += 1; }
            }
            for (let j = 0; j < wrap; j++) {
                const v = val[j];
                if (Number.isFinite(v)) { total += v; count += 1; }
            }

            base = count ? total / count : 0;
            sum  = 0;
            sq   = 0;
            for (let j = head; j < end; j++) {
                const v = val[j];
                if (!Number.isFinite(v)) continue;
                const d = v - base;
                sum += d;
                sq  += d * d;
            }
            for (let j = 0; j < wrap; j++) {
                const v = val[j];
                if (!Number.isFinite(v)) continue;
                const d = v - base;
                sum += d;
                sq  += d * d;
            }
            dirt = 0;
        }

        return {
            /** 入っているサンプルの数。 */
            get size() { return size; },

            /** 最も古いサンプルの時刻（無ければ NaN）。 */
            firstAt: () => (size ? at[head] : NaN),

            /** 最も古いサンプルの値（無ければ NaN）。 */
            firstValue: () => (size ? val[head] : NaN),

            /** 最も新しいサンプルの時刻（無ければ NaN）。 */
            lastAt: () => (size ? at[slot(size - 1)] : NaN),

            /** 最も新しいサンプルの値（無ければ NaN）。 */
            lastValue: () => (size ? val[slot(size - 1)] : NaN),

            /** 記録が何ミリ秒ぶん溜まっているかを返す（最新の時刻 − 最古の時刻）。 */
            span: () => (size ? at[slot(size - 1)] - at[head] : 0),

            /**
             * すべて捨てる。動画が切り替わったときなどに使う。
             * @param {boolean} [release=false] true なら確保した配列も手放す（待機に入るときなど）
             * @returns {void}
             */
            clear(release = false) {
                head = 0;
                size = 0;
                bad  = 0;
                base = 0;
                sum  = 0;
                sq   = 0;
                dirt = 0;
                if (release && cap) {
                    cap = 0;
                    at  = new Float64Array(0);
                    val = new Float64Array(0);
                }
            },

            /**
             * サンプルを 1 件追加する。
             * @param {number} t 時刻（performance.now() の値）
             * @param {number} v 値
             * @returns {void}
             */
            push(t, v) {
                if (size === cap) grow();
                const j = slot(size);
                at[j]  = t;
                val[j] = v;
                size  += 1;

                if (!Number.isFinite(v)) { bad += 1; return; }
                // 最初の 1 件の値を基準値にします（以後は rebase() が平均へ取り直します）。
                if (size - bad === 1) { base = v; sum = 0; sq = 0; }
                const d = v - base;
                sum += d;
                sq  += d * d;
                if (++dirt >= REBASE_EVERY) rebase();
            },

            /**
             * 直近 ms ミリ秒ぶんだけ残して、古いものを捨てる（スライディングウィンドウ）。
             * 古い順に並んでいるので、先頭から「古すぎる」ものを順に外していくだけです。
             * @param {number} now 現在時刻（performance.now() の値）
             * @param {number} ms 残しておきたい期間（ミリ秒）
             * @returns {void}
             */
            trim(now, ms) {
                while (size > 0 && now - at[head] > ms) {
                    const v = val[head];
                    if (Number.isFinite(v)) {
                        const d = v - base;
                        sum -= d;
                        sq  -= d * d;
                        dirt += 1;
                    } else {
                        bad -= 1;
                    }
                    head  = head + 1 === cap ? 0 : head + 1;
                    size -= 1;
                }
                if (size === 0) {
                    head = 0;
                    sum  = 0;
                    sq   = 0;
                    dirt = 0;
                } else if (dirt >= REBASE_EVERY) {
                    rebase();
                }
            },

            /**
             * 値の合計を返す（無ければ 0）。
             * @returns {number}
             */
            sum: () => (bad ? NaN : size ? sum + base * size : 0),

            /**
             * 平均を返す（無ければ NaN）。
             * @returns {number}
             */
            mean: () => (bad || !size ? NaN : base + sum / size),

            /**
             * 標準偏差を返す（無ければ NaN）。
             *
             * 標準偏差（sd）は「値のばらつき具合」を表す指標です。
             * この拡張機能では「バッファ残量がどれくらい安定しているか」を見るために使い、
             * ばらつきが大きいときほど安全マージンを厚くとる判断に利用します。
             * 分散 ＝ 「2 乗の平均」−「平均の 2 乗」で、その平方根が標準偏差です。
             * 計算誤差でわずかに負になった分散は 0 として扱います。
             * @returns {number}
             */
            sd() {
                if (bad || !size) return NaN;
                const m = sum / size;
                const variance = sq / size - m * m;
                return Math.sqrt(variance > 0 ? variance : 0);
            },
        };
    }

    /**
     * 遅延（ライブ最前線からの遅れ）を追跡し、「今は最前線にいるか」を判定する。
     *
     * ■ 何のため？
     *   遅延バッジに「(DVR)」と表示するための判定です。ユーザーが自分でシークバーを
     *   戻して過去の場面を見ている（DVR 視聴）とき、遅延の秒数はもう「通信の遅れ」を
     *   表さないため、数字の代わりに (DVR) と出します。
     *
     *   ※ この判定は表示専用で、速度制御には使っていません。巻き戻したあとの
     *     「追っかけ再生」でも、バッファに余裕があれば加速して最前線へ戻るのが
     *     この拡張機能の仕様です（CHANGELOG 1.1.0 の ample 近道を参照）。
     *
     * ■ 仕組み
     *   これまでに観測した「最小の遅延」を low として覚えておきます。
     *   ただし固定してしまうと配信側の変化に追従できないので、
     *   時間の経過とともに毎秒 EASE 秒ずつ緩めて（値を大きくして）いきます。
     *   現在の遅延がその low より slack 秒以上大きければ「巻き戻して見ている」と判断します。
     *   シークしても low は残したままにするのが要点です（残すからこそ巻き戻しに気付けます）。
     *
     * ■ 結果の入れ物について
     *   read() は毎回同じオブジェクトに結果を書き込んで返します（呼ぶたびに作らないため）。
     *   受け取った側は、次に read() を呼ぶまでの間に値を読み終える前提です。
     * @param {number} [slack=2.5] 最前線とみなす許容差（秒）
     * @returns {{ reset: () => void, read: (latency: number) => { latency: number, atHead: boolean } }}
     */
    function tracker(slack = 2.5) {
        const EASE = 0.1;      // low を 1 秒あたり何秒ぶん緩めるか
        let low    = Infinity; // 観測した最小の遅延（初期値は「まだ無い」を表す無限大）
        let at     = 0;        // low を最後に更新した時刻
        const out  = { latency: NaN, atHead: true };

        return {
            /** 記録をまっさらに戻す。動画が切り替わったときなどに呼ぶ。 */
            reset() {
                low = Infinity;
                at  = performance.now();
            },

            /**
             * 現在の遅延を渡して、判定結果を受け取る。
             * @param {number} latency 現在の遅延（秒）。不明なら NaN
             * @returns {{ latency: number, atHead: boolean }} atHead が true なら最前線付近
             */
            read(latency) {
                const now = performance.now();
                if (Number.isFinite(latency)) {
                    // 経過時間ぶんだけ low を緩めたうえで、今回の値と小さいほうを採用。
                    low = Math.min(low + (EASE * (now - at)) / 1000, latency);
                    at  = now;
                }
                // 差が slack 以内なら最前線とみなす。
                // latency が NaN のときは比較が false になり、atHead は true になります
                // （＝判断材料が無いときは「最前線にいる」とみなして通常の表示を続ける）。
                out.latency = latency;
                out.atHead  = !(latency - low > slack);
                return out;
            },
        };
    }

    /**
     * 「実質的に無限」とみなす秒数のしきい値。
     * ライブ配信は動画の長さ（duration）が非常に大きな値、あるいは Infinity になるため、
     * これを超えていれば録画ではなくライブと判定する材料になります。
     */
    const ENDLESS = 1e6;

    /**
     * サイト独自のボタンデザインに合わせられないときに使う、素朴なバッジのスタイル。
     * 背景も枠線も消し、親要素のフォントをそのまま継承する指定です。
     */
    const BADGE_STYLE_PLAIN = 'background:none;border:none;font-size:13px;font-family:inherit;'
        + 'line-height:1;align-self:center;white-space:nowrap';

    /**
     * 「あるかどうか分からないメソッド」を安全に呼び出す。
     *
     * 動画サイトの内部 API は予告なく変更・削除されます。存在しないメソッドを
     * 呼ぶと例外で処理全体が止まってしまうため、
     *   1) 本当に関数か確認してから呼ぶ
     *   2) それでも例外が出たら握りつぶして fallback を返す
     * という二重の防御をしています。
     * メソッドの取り出しは 1 回だけにしています（取り出し自体に処理が仕込まれている
     * 場合に、確認用と呼び出し用で 2 回動かさないため）。
     * @param {object|null|undefined} target 呼び出し先のオブジェクト
     * @param {string} name メソッド名
     * @param {*} fallback 呼べなかった場合に返す値
     * @param {...unknown} args メソッドへ渡す引数
     * @returns {*} 戻り値。呼べなければ fallback
     */
    function safeCall(target, name, fallback, ...args) {
        try {
            const method = target?.[name];
            return typeof method === 'function' ? method.apply(target, args) : fallback;
        } catch {
            return fallback;
        }
    }

    /**
     * <video> 要素の seekable 情報から遅延（秒）を推定する。
     *
     * seekable は「シーク可能な時間範囲」のリストです。その末尾＝配信の最新地点なので、
     * そこから現在の再生位置を引けば「どれだけ遅れているか」が分かります。
     * サイトが遅延を教えてくれない場合（TwitCasting など）の代替手段です。
     * @param {HTMLVideoElement|null|undefined} video 対象の video 要素
     * @returns {number} 推定した遅延（秒）。求められなければ NaN
     */
    function seekableLatency(video) {
        try {
            const ranges = video?.seekable;
            return ranges?.length ? ranges.end(ranges.length - 1) - video.currentTime : NaN;
        } catch {
            return NaN;
        }
    }

    /**
     * ページ内の <video> 要素を探し続け、入れ替わりを検知する「見張り役」を作る。
     *
     * ■ なぜ必要？
     *   動画サイトはページ遷移や広告の挿入で <video> 要素をまるごと差し替えます。
     *   一度つかんだ参照を持ち続けると、いつのまにか画面に無い要素を操作していた、
     *   ということが起こります。そこで find() のたびに最新の要素を確認します。
     *
     * ■ 探し直す頻度（速さのための工夫）
     *   find() は制御中 1 秒間に約 50 回呼ばれます。そのたびに DOM を探すのは無駄なので、
     *   - つかんでいる video がページから外れた／外枠の外に出たときは、その場で探し直す
     *   - そうでなければ RECHECK_MS ごとにだけ探し直す（手前に新しい video が
     *     差し込まれた場合に、そちらへ乗り換えるため）
     *   という使い分けをしています。外枠の探索も、見つかっていない間は RETRY_MS ごとに間引きます。
     * @param {{ roots: string[], onSwap?: () => void, onStall?: () => void }} options
     *        roots   … プレーヤーの外枠を探すためのセレクター候補（優先度順）
     *        onSwap  … video 要素が入れ替わったときに呼ばれる関数
     *        onStall … 再生が詰まった（waiting イベント）ときに呼ばれる関数
     * @returns {{ root: Element|null, video: HTMLVideoElement|null, find: () => HTMLVideoElement|null }}
     */
    function videoWatcher({ roots, onSwap, onStall }) {
        const RETRY_MS   = 1000;      // 外枠が無い・間に合わせのときに、本物を探し直す間隔
        const RECHECK_MS = 500;       // つかんでいる video が健在でも、念のため探し直す間隔
        let root         = null;      // プレーヤーの外枠要素
        let video        = null;      // 現在の video 要素
        let improvised   = false;     // root が「間に合わせ」で決めた要素かどうか
        let retryAt      = -Infinity; // 最後に外枠を探した時刻
        let checkAt      = -Infinity; // 最後に video を探した時刻

        /**
         * 再生が詰まったときのハンドラ。
         * ユーザー操作によるシーク中は正常な待機なので通知しません。
         * @returns {void}
         */
        const stalled = () => {
            if (video && !video.seeking) onStall?.();
        };

        return {
            /** 現在のプレーヤー外枠要素（読み取り専用）。 */
            get root() { return root; },

            /** 現在の video 要素（読み取り専用）。 */
            get video() { return video; },

            /**
             * 最新の video 要素を探して返す。毎フレーム呼ばれる想定です。
             * @returns {HTMLVideoElement|null} 見つかった video 要素
             */
            find() {
                const now = performance.now();

                // (1) 外枠を確認する。
                // isConnected は「その要素がまだページ上に存在するか」を表すプロパティ。
                // 外枠が消えた場合はその場で、見つかっていない／間に合わせの場合は
                // RETRY_MS ごとに探し直します。
                const lost = root !== null && !root.isConnected;
                if (lost || ((root === null || improvised) && now - retryAt >= RETRY_MS)) {
                    retryAt = now;
                    const found = pick(roots);
                    if (found) {
                        root       = found;
                        improvised = false;
                        checkAt    = -Infinity; // 外枠が変わったので video も探し直す
                    } else if (lost) {
                        root       = null;
                        improvised = false;
                    }
                }

                // (2) video を確認する。外枠の中から探し、無ければページ全体から探します。
                let next = video;
                if (!video?.isConnected || !root?.contains(video) || now - checkAt >= RECHECK_MS) {
                    checkAt = now;
                    next = root?.querySelector('video') ?? document.querySelector('video');
                }

                // (3) 前回と違う要素なら「入れ替わった」ということ。
                // 古い要素のイベント登録を外し、新しい要素に付け替えます。
                // これを怠ると、消えた要素への参照が残り続けてメモリリークの原因になります。
                if (next !== video) {
                    video?.removeEventListener('waiting', stalled);
                    video = next;
                    video?.addEventListener('waiting', stalled);
                    onSwap?.();
                }

                // (4) 外枠が見つからない／video を含んでいない場合は、
                // video の親要素を間に合わせの外枠として使います（バッジの表示位置に必要）。
                if (video && (!root || root === video || !root.contains(video))) {
                    root       = video.parentElement;
                    improvised = true;
                }

                return video;
            },
        };
    }

    /**
     * サイトアダプターを登録する。
     *
     * 各アダプターファイル（adapters/youtube.js など）が最後にこれを呼ぶことで、
     * inject.js から「対応サイト一覧」として参照できるようになります。
     * `??=` は「まだ無ければ空オブジェクトを作る」書き方です。
     * @param {string} id サイト ID（'youtube' など）
     * @param {RegExp} host このアダプターを使うホスト名の判定用正規表現
     * @param {() => object} create アダプター本体を生成する関数
     * @returns {void}
     */
    function registerSite(id, host, create) {
        (globalThis.__slipstreamliveSites ??= {})[id] = { host, create };
    }

    // 道具一式を受け渡し用のグローバル変数に置きます。
    // inject.js がこれを受け取った直後、変数ごと削除します。
    globalThis.__slipstreamliveUtil ??= {
        clamp, toNum, pick, series, tracker,
        ENDLESS, BADGE_STYLE_PLAIN, safeCall, seekableLatency, videoWatcher, registerSite,
    };
})();
