// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * shared/util.js — メインワールド側で使う「汎用ツール集」
 * =============================================================================
 *
 * ■ このファイルは何をするもの？
 *   inject.js と 3 つのサイトアダプター（youtube / twitch / twitcasting）が
 *   共通して使う小さな部品を集めたファイルです。
 *   数値の丸め、時系列データの記録、<video> 要素の探索などが入っています。
 *
 * ■ 読み込まれる場所
 *   メインワールド（ページ本体と同じ実行環境）で、アダプターより先に読み込まれます。
 *   ここには拡張機能の API を使うコードは一切ありません（使えないため）。
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
     * new Set([...]) を使っているのは、scope が document だったときに
     * 同じ場所を二重に探すのを避けるためです。
     * @param {string[]} selectors 試す CSS セレクターの配列（優先度順）
     * @param {ParentNode|null} [scope=document] 探す起点となる要素
     * @returns {Element|null} 見つかった要素。無ければ null
     */
    function pick(selectors, scope = document) {
        for (const root of new Set([scope ?? document, document])) {
            for (const selector of selectors) {
                const node = root.querySelector(selector);
                if (node) return node;
            }
        }
        return null;
    }

    /**
     * 時系列データを記録する「シリーズ」オブジェクトを作る。
     *
     * これはクロージャという仕組みを使った書き方です。内部の `list` は
     * 外から直接触れず、返されたメソッド経由でのみ操作できます
     * （＝うっかり壊されない、安全なデータの入れ物になる）。
     *
     * サンプルは必ず古い順（時刻の昇順）に push される前提です。
     * @returns {{
     *   first: () => { at: number, value: number }|undefined,
     *   last: () => { at: number, value: number }|undefined,
     *   span: () => number,
     *   clear: () => void,
     *   push: (at: number, value: number) => void,
     *   trim: (now: number, ms: number) => void,
     *   stats: () => { n: number, avg: number, sd: number }
     * }} 時系列データ操作用のオブジェクト
     */
    function series() {
        /** @type {{ at: number, value: number }[]} サンプルの配列（古い順） */
        const list = [];

        return {
            /** 最も古いサンプルを返す。 */
            first: () => list[0],

            /** 最も新しいサンプルを返す（`at(-1)` は「末尾の要素」）。 */
            last: () => list.at(-1),

            /** 記録が何ミリ秒ぶん溜まっているかを返す（最新の時刻 − 最古の時刻）。 */
            span: () => (list.length ? list.at(-1).at - list[0].at : 0),

            /** すべて捨てる。動画が切り替わったときなどに使う。 */
            clear() { list.length = 0; },

            /** サンプルを 1 件追加する。 */
            push(at, value) { list.push({ at, value }); },

            /**
             * 直近 ms ミリ秒ぶんだけ残して、古いものを捨てる（スライディングウィンドウ）。
             *
             * 配列は古い順に並んでいるので、「まだ新しい」最初のサンプルの位置が
             * そのまま「捨てる個数」になります。それを splice でまとめて削除します
             * （1 個ずつ削るより高速）。1 つも新しいものが無ければ全部捨てます。
             * @param {number} now 現在時刻（performance.now() の値）
             * @param {number} ms 残しておきたい期間（ミリ秒）
             */
            trim(now, ms) {
                const keep = list.findIndex((sample) => now - sample.at <= ms);
                list.splice(0, keep === -1 ? list.length : keep);
            },

            /**
             * 個数・平均・標準偏差を計算して返す。
             *
             * 標準偏差（sd）は「値のばらつき具合」を表す指標です。
             * この拡張機能では「バッファ残量がどれくらい安定しているか」を見るために使い、
             * ばらつきが大きいときほど安全マージンを厚くとる判断に利用します。
             * @returns {{ n: number, avg: number, sd: number }} 個数・平均・標準偏差
             */
            stats() {
                const n = list.length;
                if (n === 0) return { n: 0, avg: NaN, sd: NaN };

                // 1 周目：合計を出して平均を求める
                const avg = list.reduce((sum, sample) => sum + sample.value, 0) / n;

                // 2 周目：平均との差を 2 乗して足し、分散を求める（`**` はべき乗の演算子）
                const variance = list.reduce((acc, sample) => acc + (sample.value - avg) ** 2, 0) / n;

                // 分散の平方根が標準偏差
                return { n, avg, sd: Math.sqrt(variance) };
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
     * @param {number} [slack=2.5] 最前線とみなす許容差（秒）
     * @returns {{ reset: () => void, read: (latency: number) => { latency: number, atHead: boolean } }}
     */
    function tracker(slack = 2.5) {
        const EASE = 0.1;      // low を 1 秒あたり何秒ぶん緩めるか
        let low    = Infinity; // 観測した最小の遅延（初期値は「まだ無い」を表す無限大）
        let at     = 0;        // low を最後に更新した時刻

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
                return { latency, atHead: !(latency - low > slack) };
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
     * @param {object|null|undefined} target 呼び出し先のオブジェクト
     * @param {string} name メソッド名
     * @param {*} fallback 呼べなかった場合に返す値
     * @param {...unknown} args メソッドへ渡す引数
     * @returns {*} 戻り値。呼べなければ fallback
     */
    function safeCall(target, name, fallback, ...args) {
        try {
            return typeof target?.[name] === 'function' ? target[name](...args) : fallback;
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
     *   ということが起こります。そこで毎回 find() で最新の要素を確認します。
     * @param {{ roots: string[], onSwap?: () => void, onStall?: () => void }} options
     *        roots   … プレーヤーの外枠を探すためのセレクター候補（優先度順）
     *        onSwap  … video 要素が入れ替わったときに呼ばれる関数
     *        onStall … 再生が詰まった（waiting イベント）ときに呼ばれる関数
     * @returns {{ root: Element|null, video: HTMLVideoElement|null, find: () => HTMLVideoElement|null }}
     */
    function videoWatcher({ roots, onSwap, onStall }) {
        const RETRY_MS = 1000;      // 仮の外枠で代用しているときに、本物を再探索する間隔
        let root       = null;      // プレーヤーの外枠要素
        let video      = null;      // 現在の video 要素
        let improvised = false;     // root が「間に合わせ」で決めた要素かどうか
        let retryAt    = -Infinity; // 最後に再探索した時刻

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
                // 外枠が消えた場合、または間に合わせの外枠を使っていて再探索の時間が来た場合に探し直します。
                if (!root?.isConnected || (improvised && now - retryAt >= RETRY_MS)) {
                    retryAt = now;
                    const found = pick(roots);
                    if (found) {
                        root       = found;
                        improvised = false;
                    } else if (!root?.isConnected) {
                        root       = null;
                        improvised = false;
                    }
                }

                // (2) 外枠の中から video を探す。見つからなければページ全体から探す。
                const next = root?.querySelector('video') ?? document.querySelector('video');

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
