// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * inject.js — 再生速度を制御する「本体」
 * =============================================================================
 *
 * ■ この拡張機能がやろうとしていること
 *   ライブ配信は、実際の出来事より数秒遅れて手元に届きます。この遅れを縮めるには
 *   少し速く再生すればよいのですが、速く再生するとバッファ（先読みして溜めてある
 *   動画）を早く消費するため、やりすぎると再生が止まってしまいます。
 *
 *   そこで「バッファに余裕があるときだけ、そっと加速する」という判断を
 *   1 秒間に約 50 回くり返しているのが、このファイルです。
 *
 * ■ 3 つの状態（state）を行き来する
 *   normal  … 等倍（1.00x）。何もしない平常状態。
 *   speedup … 加速中（既定 1.25x）。バッファに余裕があり、遅延を詰められるとき。
 *   floor   … 下限モード（0.15x）。バッファが尽きかけているときの緊急退避。
 *             完全に止まる（読み込み中のぐるぐる）よりは、超スローでも
 *             絵が動き続けたほうがマシ、という考え方です。
 *
 * ■ 中心となる 2 つの指標
 *   health（残量）… 現在位置から途切れずに再生できる秒数。これが 0 になると停止。
 *   latency（遅延）… ライブ最前線からどれだけ遅れているか。縮めたい対象。
 *
 * ■ 主な登場人物（この後に出てくるオブジェクト）
 *   hijack … video 要素の playbackRate / volume を横取りして操作する仕組み
 *   Badges … 画面上に速度・遅延・残量を表示するバッジ
 *   Auto   … バッファ残量を統計的に観測し、「安全に加速できる余裕」を自動推定する
 *   Gain   … 加速が実際に効いているかを検証し、無駄なら加速をやめる
 *   Noise  … 遅延のばらつきを記録する（デバッグ表示用）
 *   tick   … 上記すべてを 20 ミリ秒ごとに呼び出す司令塔
 *
 * ■ 速さのための約束事
 *   tick は制御中 1 秒間に約 50 回動くので、次のことを守っています。
 *   - 1 回の tick の中で、オブジェクトや配列をなるべく新しく作らない
 *     （結果の入れ物は使い回し、統計は shared/util.js の series() で足し引きだけにする）
 *   - サイトへの問い合わせ（adapter.media() / adapter.status()）は、
 *     判断に必要な鮮度（MEDIA_MS / STATUS_MS）を保てる範囲で間引く
 *   - 設定の属性は、変わったと分かったとき（MutationObserver の通知）だけ読み直す
 *
 * ■ このファイルが動く場所
 *   メインワールド（ページ本体と同じ実行環境）です。そのため
 *   YouTube プレーヤーの内部 API を呼べる代わりに、拡張機能の API は使えません。
 *   設定は content.js が <html> の data-slpstrm 属性に書いたものを読み取ります。
 */
(() => {
    'use strict';

    // shared/util.js とアダプターが置いた受け渡し用のグローバル変数を受け取り、
    // すぐに変数ごと削除します（ページ側の JavaScript から見えたままにしないための後始末）。
    //
    // 下の二重読み込みチェックより先に行うのが要点です。Firefox は拡張機能の更新時などに、
    // 開いているタブへこれらのスクリプトをもう一度読み込みます。チェックを先にすると、
    // 2 回目は削除せずに終了してしまい、受け渡し用の変数がページに残り続けます。
    const util  = globalThis.__slipstreamliveUtil;
    const sites = globalThis.__slipstreamliveSites ?? {};
    delete globalThis.__slipstreamliveUtil;
    delete globalThis.__slipstreamliveSites;

    // 二重に読み込まれた場合の保険。すでに動いていれば何もせず終了します。
    // （2 つの制御が同時に速度を書き換えると、確実に暴走するため）
    if (window.__slipstreamlive) return;
    window.__slipstreamlive = true;

    // =========================================================================
    // 定数（この拡張機能の「性格」を決める数値）
    // =========================================================================

    /** 動作中の判断間隔（ミリ秒）。20ms = 1 秒間に 50 回チェックする。 */
    const TICK_MS    = 20;

    /** 待機モードでの確認間隔（ミリ秒）。1 秒ごとに様子を見るだけにして負荷を抑える。 */
    const IDLE_MS    = 1000;

    /** バッジの表示更新間隔（ミリ秒）。判断ほど頻繁に描き替える必要はないため間引く。 */
    const PAINT_MS   = 100;

    /**
     * 再生中のメディア（動画 ID・ライブかどうか）を問い合わせ直す間隔（ミリ秒）。
     * 動画の切り替わりや広告の始まりを 0.1 秒以内に気付ければ十分なため、毎回は聞きません。
     * なお、動画の読み込み開始などのイベントが届いたときは、間隔を待たずに問い合わせます。
     */
    const MEDIA_MS   = 100;

    /**
     * 遅延（latency）と最前線にいるか（atHead）を問い合わせ直す間隔（ミリ秒）。
     * どちらもバッジ表示と、加速を見送っている状態からの復帰判定（0.2 秒以上の変化を見る）
     * にしか使わないため、0.1 秒ごとで足ります。YouTube では「詳細統計情報」を組み立てる
     * 重めの API なので、毎回呼ばないことの効果が大きい部分です。
     */
    const STATUS_MS  = 100;

    /** バッファ範囲の境界判定に使う許容誤差（秒）。わずかなズレを同一とみなす。 */
    const SLACK      = 0.1;

    /** 下限モードの再生速度。0.15 倍速まで落として時間を稼ぐ。 */
    const FLOOR_RATE = 0.15;

    /** 「ほぼ 1.00 倍」とみなす許容差。浮動小数点の誤差を吸収するため。 */
    const NEAR_ONE   = 0.001;

    /** 巻き戻して視聴中（DVR）のときにバッジへ表示する文字列。 */
    const DVR        = '(DVR)';

    /** 「これだけ溜まっていれば統計を待たず加速してよい」という残量（秒）。 */
    const AMPLE      = 20;

    /** 十分残量モードから降りるときに緩める量（秒）。境界での往復を防ぐ。 */
    const AMPLE_KEEP = 5;

    /** 十分残量ラインを、安全マージンから何秒上に置くか。 */
    const AMPLE_OVER = 10;

    /**
     * ヒステリシス（秒）。
     * 「入るときの基準」と「出るときの基準」にわざと差を付けるための値です。
     * これが無いと、しきい値ちょうどの付近で状態が高速に切り替わり（チャタリング）、
     * 速度が細かく上下してかえって見づらくなります。
     */
    const HYSTERESIS = 0.2;

    /** 加速を始めるまでの最短待ち時間（ミリ秒）。落ち着いてから動き出すため。 */
    const DWELL_MS   = 2000;

    /**
     * 自動しきい値スライダー（設定 speedupAuto）の段階ごとのパラメーター。
     * 配列の添字がそのまま段階（0=オフ / 1=安定 / 2=標準 / 3=積極的）です。
     *
     *   troughK      … 安全係数。標準偏差の何倍を安全マージンとして差し引くか。
     *                  大きいほど慎重（＝加速しにくい）。
     *   troughMs     … 「谷」を観測する時間窓の長さ（ミリ秒）。長いほど慎重。
     *   troughMargin … 最低限確保しておきたい余裕（秒）。
     *
     * 添字 0（オフ）にも値が入っているのは、参照時にエラーを出さないための保険です。
     */
    const AUTO_TUNING = [
        { troughK: 10, troughMs: 60000, troughMargin: 1.0 },
        { troughK: 10, troughMs: 60000, troughMargin: 1.0 },
        { troughK:  5, troughMs: 30000, troughMargin: 0.3 },
        { troughK:  3, troughMs:  5000, troughMargin: 0.1 },
    ];

    /** 状態ごとのバッジの文字色（白＝平常／赤＝加速中／青＝下限モード）。 */
    const COLOR = { normal: '#eee', speedup: '#ff8983', floor: '#83c1ff' };

    // shared/util.js の道具箱（冒頭で受け取り済み）が無ければ動けないので終了します。
    if (!util) return;

    const { clamp, toNum, series } = util;

    /**
     * デバッグモードかどうか。
     * 配信ページのコンソールで `window.__slipstreamliveDebug = true` と
     * 実行すると、内部状態のログが 1 秒ごとに出るようになります。
     *
     * この変数はページ側から自由に定義できるため、読むと例外を投げる仕掛け
     * （getter）を置かれても制御ループが巻き込まれないよう try/catch で囲みます。
     * @returns {boolean}
     */
    const debugging = () => {
        try { return window.__slipstreamliveDebug === true; }
        catch { return false; }
    };

    /**
     * デバッグログを出力する。
     * @param {...unknown} args console.log に渡す値
     * @returns {void}
     */
    const log = (...args) => { if (debugging()) console.log('[slipstreamlive]', ...args); };

    // 今のホスト名に合うアダプターを探します（sites は冒頭で受け取った登録済みの一覧）。
    // manifest.json でサイトごとに読み込むアダプターを分けているので、通常は 1 つだけです。
    // `([, site]) => ...` は配列の分割代入で、1 番目（ID）を読み飛ばして
    // 2 番目だけを受け取る書き方です。
    const found = Object.entries(sites).find(([, site]) => site.host.test(location.hostname));
    const adapter = found?.[1].create();

    // 対応していないページなら、ここで静かに終了します。
    if (!adapter) return;
    log('adapter', found[0], location.href);

    /**
     * video 要素のプロパティ（playbackRate / volume）を「横取り」する仕組みを作る。
     *
     * ■ なぜ横取りが必要？
     *   単純に video.playbackRate = 1.25 と書くだけでは 2 つの問題が起きます。
     *     1) ページ側のスクリプトが値を読むと 1.25 が見え、
     *        プレーヤーの UI に「1.25x」と表示されてしまう
     *     2) ページ側が「1 に戻す」処理を持っていると、勝手に上書きされて競合する
     *
     * ■ 解決方法
     *   その video 要素だけに、独自の getter / setter を上書きで定義します。
     *     - ページが値を「読む」  → 本来ページが設定したはずの値（wish）を返す
     *     - ページが値を「書く」  → wish として控えるだけで、実際の再生には反映しない
     *     - 実際に効かせる値      → output(wish, arg) で計算し、裏側からこっそり書き込む
     *
     *   結果として、ページからは「何も変わっていない」ように見えたまま、
     *   実際の再生速度だけを変えられます。
     *
     * ■ 各引数の役割
     * @param {string} prop 横取りするプロパティ名（'playbackRate' または 'volume'）
     * @param {(n: number) => number|null} valid 値の妥当性を検査する関数。不正なら null を返す
     * @param {(wish: number, arg: number) => number} output 実際に書き込む値を計算する関数
     * @returns {{
     *   release: () => void,
     *   actual: (node: HTMLMediaElement|null) => number,
     *   wished: (node: HTMLMediaElement|null) => number,
     *   apply: (node: HTMLMediaElement, next: number) => void
     * }} 横取り操作をまとめたオブジェクト
     */
    function hijack(prop, valid, output) {
        // HTMLMediaElement の「本来の」getter / setter を控えておきます。
        // 上書き後もこれを使えば、実際の値を読み書きできます。
        // （最新の Chrome / Firefox では、playbackRate も volume も
        //   プロトタイプ上のアクセサとして必ず定義されています）
        const { get, set } = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, prop);

        /**
         * 本来の getter で実際の値を読む。
         * @param {HTMLMediaElement} node 対象要素
         * @returns {number} 実際の値（読めなければ 1）
         */
        const read = (node) => { try { return get.call(node); } catch { return 1; } };

        /**
         * 本来の setter で実際の値を書く。同じ値なら書き込みません
         * （無駄な変更イベントでページ側の処理を誘発しないため）。
         * @param {HTMLMediaElement} node 対象要素
         * @param {number} value 書き込む値
         * @returns {void}
         */
        const write = (node, value) => { try { if (get.call(node) !== value) set.call(node, value); } catch { } };

        /** @type {HTMLMediaElement|null} 現在横取り中の要素 */
        let owned = null;
        /** @type {number} ページ側が設定したつもりの値（ページから読めるのはこの値） */
        let wish  = 1;
        /** @type {number} 現在こちらが指定している値（output の第 2 引数） */
        let arg   = 1;

        /**
         * 差し替え後の getter。ページ側にはこの値が見えます。
         * @returns {number} wish の値
         */
        const mine = () => wish;

        /**
         * 差し替え後の setter。ページ側が値を代入したときに呼ばれます。
         * @param {unknown} value ページが設定しようとした値
         * @returns {void}
         */
        const catcher = (value) => {
            let next = null;
            try { next = valid(Number(value)); } catch { return; }
            if (next === null) return; // 不正な値は無視する

            wish = next;
            // 横取り中なら、新しい wish をもとに実際の値を計算し直します。
            // （音量の場合、ユーザーが音量を変えたら音量下げの倍率を掛け直す必要があるため）
            if (owned) write(owned, output(wish, arg));
        };

        /**
         * 横取りを解除して、元の状態に戻す。
         *
         * delete で自前のプロパティを消すと、本来のプロトタイプ側の
         * getter / setter が再び有効になります。そのうえで、ページ側が
         * 期待している値（wish）を実際に書き戻して辻褄を合わせます。
         * @returns {void}
         */
        function release() {
            if (!owned) return;
            const node  = owned;
            const value = wish;

            // 先に状態を初期化するのは、delete や write の途中で
            // 例外が起きても中途半端な状態が残らないようにするためです。
            owned = null;
            wish  = 1;
            arg   = 1;

            try { delete node[prop]; } catch { }
            write(node, value);
        }

        return {
            release,

            /**
             * 実際に効いている値を読む（バッジ表示などに使う）。
             * @param {HTMLMediaElement|null} node 対象要素
             * @returns {number} 実際の値
             */
            actual: (node) => (node ? read(node) : 1),

            /**
             * ページ側が設定したつもりの値を読む。
             * ユーザーが自分で速度を変えたかどうかの判定に使います。
             * @param {HTMLMediaElement|null} node 対象要素
             * @returns {number} wish の値
             */
            wished: (node) => (node === owned ? wish : node ? read(node) : 1),

            /**
             * 指定した要素に、こちらの値を適用する（必要なら横取りを開始する）。
             * @param {HTMLMediaElement} node 対象要素
             * @param {number} next 適用したい値（output の第 2 引数になる）
             * @returns {void}
             */
            apply(node, next) {
                // 別の要素に切り替わったら、前の要素を解放してから始めます。
                if (node !== owned) {
                    release();
                    wish = valid(read(node)) ?? 1; // 現在値を wish の初期値にする
                }

                // まだ横取りしていなければ、getter / setter を差し替えます。
                // ページ側に消されたり差し替えられたりしても気付けるよう、毎回確かめます。
                // configurable: true を付けるのは、あとで delete して戻せるようにするため。
                if (Object.getOwnPropertyDescriptor(node, prop)?.get !== mine) {
                    try {
                        Object.defineProperty(node, prop, { configurable: true, get: mine, set: catcher });
                    } catch (error) {
                        // 差し替えを拒否された場合は諦め、通常動作に戻します。
                        log(`cannot hijack ${prop}`, error);
                        owned = null;
                        return;
                    }
                }

                owned = node;
                arg = next;
                write(node, output(wish, next));
            },
        };
    }

    /**
     * 再生速度の横取り。
     *   valid  … 有限かつ正の数だけを受け付ける
     *   output … ページの希望を無視し、こちらの指定速度をそのまま適用する
     */
    const Rate = hijack('playbackRate', (n) => (Number.isFinite(n) && n > 0 ? n : null), (wish, rate) => rate);

    /**
     * 音量の横取り。
     *   valid  … 0〜1 の範囲だけを受け付ける
     *   output … ユーザーの音量（wish）に、こちらの倍率（scale）を掛ける
     *            → ユーザーが音量を変えても、下げ幅の比率が保たれる
     */
    const Volume = hijack('volume', (n) => (n >= 0 && n <= 1 ? n : null), (wish, scale) => wish * scale);

    /**
     * 画面上のバッジ（速度・遅延・残量の表示）を管理するオブジェクト。
     *
     * ■ 表示場所は 2 通り
     *   1) サイト純正のコントロールバーの中（adapter.host() が返す場所）。見た目が自然。
     *   2) 見つからなければ、プレーヤーの左上に浮かべる独自の枠（shelf）。
     *
     * ■ 要素は初めて表示するときに作る
     *   バッジは既定でオフで、ライブ配信以外のページでは出番がありません。
     *   そこで要素は最初に show() が呼ばれたときに作り、それまでメモリを使わないようにしています。
     *
     * ■ pointer-events:none にしている理由
     *   バッジはあくまで表示専用なので、クリックが吸い取られて
     *   プレーヤーの操作を邪魔しないよう、マウス操作を透過させています。
     */
    const Badges = (() => {
        /** バッジの種類。表示順もこの並び順になります（face のキーとも対応します）。 */
        const NAMES   = ['playbackrate', 'latency', 'health'];

        /** 表示場所を探し直す間隔（ミリ秒）。毎回探すと重いため間引きます。 */
        const SLOT_MS = 1000;

        /**
         * バッジ 1 個ぶんの要素を作る。
         *
         * <button> を使っているのは、多くのサイトでコントロールバーの中身が
         * ボタン前提のスタイルになっているためです（並びが自然に揃う）。
         * ただし押せる必要はないので、クリックもフォーカスも無効にしています。
         * @param {string} name バッジの種類名
         * @returns {HTMLButtonElement} 生成した要素
         */
        function build(name) {
            const node = document.createElement('button');
            node.type          = 'button';
            node.className     = `_slipstreamlive_${name} ${adapter.badgeClass}`.trim();
            node.style.cssText = 'display:none;width:auto;height:auto;padding:0 8px;font-weight:normal;'
                + 'cursor:default;pointer-events:none;user-select:none;'
                + 'text-shadow:0 1px 2px #000c;'
                + adapter.badgeStyle;
            node.tabIndex      = -1; // Tab キーで選択されないようにする

            // 翻訳ツールに「1.25x」を翻訳されて壊されるのを防ぎます。
            node.setAttribute('translate', 'no');
            return node;
        }

        /**
         * 各バッジの要素と、いま表示している内容。
         * 内容を覚えておき、変わったところだけ DOM を書き換えます。
         * 文字は要素の中に 1 つだけ置いたテキストノード（label）の data を書き換えて更新します。
         * textContent に代入すると、そのたびに中のノードが作り直されるためです。
         * @type {{ name: string, node: HTMLButtonElement, label: Text, text: string|null, shown: boolean|null, color: string|null }[]|null}
         */
        let items = null;
        /** @type {HTMLButtonElement[]} 各バッジの要素だけを並べた配列（append にまとめて渡す用） */
        let nodes = [];
        /** @type {HTMLDivElement|null} コントロールバーが見つからないときに使う、代替の浮かせ枠 */
        let shelf = null;

        /** @type {HTMLElement|null} position を書き換えた要素（元に戻すために覚えておく） */
        let styled    = null;
        /** @type {string} 書き換える前のインライン指定（style 属性に無ければ空文字） */
        let styledWas = '';

        /** @type {HTMLElement|null} 現在バッジを置いている場所 */
        let host   = null;
        /** @type {number} 次に置き場所を探し直す時刻 */
        let slotAt = 0;

        /**
         * 要素がまだ無ければ作る（初めて表示するときに 1 回だけ）。
         * @returns {void}
         */
        function ensure() {
            if (items) return;
            items = NAMES.map((name) => {
                const node  = build(name);
                const label = node.appendChild(document.createTextNode(''));
                return { name, node, label, text: null, shown: null, color: null };
            });
            nodes = items.map((item) => item.node);
            shelf = document.createElement('div');
            shelf.className     = '_slipstreamlive_shelf';
            shelf.style.cssText = 'position:absolute;top:8px;left:8px;z-index:2147483000;'
                + 'display:flex;align-items:center;gap:2px;padding:2px 4px;border-radius:6px;'
                + 'background:#000000a6;pointer-events:none;';
        }

        /**
         * 書き換えた position の指定を元に戻す。
         * 拡張機能を切ったときにページのレイアウトを汚したままにしないための後始末です。
         *
         * 空文字で消すのではなく「書き換える前の値」に戻すのが要点です。
         * 元から style="position: static" と書かれていた要素を空文字にすると、
         * ページの CSS 側の指定（absolute など）が表に出てレイアウトが崩れるためです。
         * @returns {void}
         */
        function unstyle() {
            if (!styled) return;
            styled.style.position = styledWas;
            styled = null;
        }

        /**
         * バッジを置く場所を決めて返す。
         * @param {HTMLVideoElement|null} node 現在の video 要素
         * @returns {HTMLElement|null} 置き場所。決められなければ null
         */
        function slot(node) {
            // (1) サイト純正のコントロールバーがあれば最優先。代替枠は片付けます。
            const bar = adapter.host();
            if (bar) { shelf.remove(); unstyle(); return bar; }

            // (2) 無ければプレーヤーの外枠、それも無ければ video の親要素に浮かべます。
            const root = adapter.root();
            const box  = root?.isConnected ? root : node?.parentElement ?? null;
            if (!box?.isConnected) return null;

            if (shelf.parentElement !== box) {
                unstyle();

                // position:absolute は「position が static でない親」を基準に配置されます。
                // 親が static のままだとページ全体を基準に飛んでいってしまうため、
                // 一時的に relative に変更します（後で unstyle() で戻します）。
                if (getComputedStyle(box).position === 'static') {
                    styled    = box;
                    styledWas = box.style.position; // 元のインライン指定（多くは空文字）
                    box.style.position = 'relative';
                }
                box.append(shelf);
                log('badges on fallback shelf', box);
            }
            return shelf;
        }

        /**
         * バッジ 1 個の表示内容を更新する。
         *
         * 前回と同じ部分は書き換えません。DOM の書き換えは処理コストが高く、
         * 毎回無条件に書き替えると再描画が頻発して重くなるためです。
         * 文字・表示/非表示・色を別々に見て、変わったものだけを書き換えます
         * （遅延の数字は毎回変わりますが、表示/非表示や色はめったに変わりません）。
         * @param {{ node: HTMLElement, label: Text, text: string|null, shown: boolean|null, color: string|null }} item バッジ
         * @param {string} text 表示する文字列（空文字なら非表示）
         * @param {string} color 文字色
         * @returns {void}
         */
        function paint(item, text, color) {
            // ページ側に中身を消されていたら、文字のノードを戻してから書き直します。
            if (item.label.parentNode !== item.node) {
                item.node.replaceChildren(item.label);
                item.text = null;
            }
            if (item.text !== text) {
                item.text       = text;
                item.label.data = text;
            }
            const shown = text !== '';
            if (item.shown !== shown) {
                item.shown              = shown;
                item.node.style.display = shown ? 'inline-block' : 'none';
            }
            if (item.color !== color) {
                item.color            = color;
                item.node.style.color = color;
            }
        }

        return {
            /**
             * バッジをすべて画面から取り除く。
             * 表示設定を切ったときや、ライブ以外を再生し始めたときに呼びます。
             * @returns {void}
             */
            detach() {
                if (!items) return;
                for (const node of nodes) node.remove();
                shelf.remove();
                unstyle();
                host   = null;
                slotAt = 0;
            },

            /**
             * バッジを表示・更新する。
             * @param {HTMLVideoElement|null} node 現在の video 要素
             * @param {Record<string, { text: string, color: string }>} face 各バッジの表示内容
             * @returns {void}
             */
            show(node, face) {
                ensure();
                const now = performance.now();

                // isConnected が false ＝ ページの更新でバッジが消されたということ。
                let lost = false;
                for (const badge of nodes) if (!badge.isConnected) { lost = true; break; }

                // 消えていたとき、または探し直しの時間になったときだけ置き場所を確認します。
                if (lost || now >= slotAt) {
                    slotAt = now + SLOT_MS;
                    const next = slot(node);
                    if (next && (lost || next !== host)) {
                        host = next;
                        next.append(...nodes);
                    }
                }

                for (const item of items) {
                    const { text, color } = face[item.name];
                    paint(item, text, color);
                }
            },
        };
    })();

    // =========================================================================
    // 設定の受け取りと検証
    // =========================================================================

    /** ON/OFF として扱う設定キーの一覧。 */
    const GUARD_SWITCHES = [
        'enabled', 'showPlaybackRate', 'showLatency', 'showHealth',
        'speedup', 'floor', 'duck', 'premiere', 'recover',
    ];

    /**
     * 数値として扱う設定キーと、その [最小値, 最大値, 異常時の代替値]。
     *
     * shared/schema.js にも同じような範囲の定義がありますが、あちらは
     * 「設定画面での入力制限」、こちらは「受け取った値の最終検査」です。
     * このファイルは設定を DOM 属性経由で受け取るため、ページ側の
     * スクリプトが属性を書き換えて壊れた値を渡してくる可能性があります。
     * そこで、使う直前にもう一度確認しています（多層防御の考え方）。
     *
     * 異常時の代替値は、あえて schema.js の既定値とそろえていません。
     * 再生速度や音量を直接変える項目は「効果なし」の値（speedupRate = 1 倍、
     * duckVolume = 100%）にしてあり、壊れた値でページの速度や音量を勝手に変えないためです。
     */
    const GUARD_NUMBERS = {
        speedupRate:       [1,    4,    1],
        speedupThreshold:  [0,    100,  10],
        speedupAuto:       [0,    3,    2],
        floorThreshold:    [0,    10,   0.3],
        duckVolume:        [0,    100,  100],
    };

    /**
     * 受け取った設定オブジェクトを、安全に使える形へ整える。
     *
     * ここを通ったあとの設定は「すべてのキーが存在し、型も範囲も正しい」ことが
     * 保証されるので、以降のコードでは毎回の存在確認が不要になります。
     * @param {unknown} value JSON から復元した生の設定
     * @returns {Record<string, number|boolean>|null} 整えた設定。オブジェクトでなければ null
     */
    function sanitize(value) {
        if (!value || typeof value !== 'object') return null;

        const out = {};

        // ON/OFF は「厳密に true のときだけ true」とします。
        // 文字列の "false" などを誤って真と解釈しないための書き方です。
        for (const key of GUARD_SWITCHES) out[key] = value[key] === true;

        // 数値も「本物の数値のときだけ」採用します。
        // Number() で変換してから判定すると、null・空文字・false・[] がどれも 0 に化けて
        // 「有効な値」として通ってしまいます（例：duckVolume が null → 0 ＝ 下限モードで消音）。
        // それでは異常時に「効果なし」の代替値へ倒すという GUARD_NUMBERS の方針が守れません。
        for (const [key, [lo, hi, def]] of Object.entries(GUARD_NUMBERS)) {
            const num = value[key];
            out[key] = typeof num === 'number' && Number.isFinite(num) ? clamp(num, lo, hi) : def;
        }
        return out;
    }

    // =========================================================================
    // 実行中の状態を保持する変数
    // =========================================================================

    /** @type {Record<string, number|boolean>|null} 現在有効な設定。未取得なら null */
    let settings = null;
    /** @type {string|null} 前回読み取った設定 JSON。変化検出用 */
    let raw      = null;
    /** @type {boolean} 設定の属性が変わったかもしれない（次の tick で読み直す）か */
    let dirty    = true;
    /** @type {HTMLVideoElement|null} 現在制御している video 要素 */
    let video    = null;
    /** @type {{ id: string|null, live: boolean, premiere?: boolean }} 最後に問い合わせたメディアの情報 */
    let media    = { id: null, live: false, premiere: false };
    /** @type {string|null} 現在の動画の識別子。変われば別の配信とみなす */
    let mediaId  = null;
    /** @type {number} 次にメディアの情報を問い合わせる時刻 */
    let mediaAt  = -Infinity;
    /** @type {{ latency: number, atHead: boolean }} 最後に問い合わせた遅延の情報 */
    let status   = { latency: NaN, atHead: true };
    /** @type {number} 次に遅延の情報を問い合わせる時刻 */
    let statusAt = -Infinity;
    /** @type {boolean} 制御の対象（ライブ配信で、除外されたプレミア公開でもない）を再生中か */
    let live     = false;
    /** @type {'normal'|'speedup'|'floor'} 現在の制御状態 */
    let state    = 'normal';
    /** @type {number} 現在の状態になった時刻 */
    let stateAt  = -Infinity;
    /** @type {number} 次にバッジを描き替える時刻 */
    let paintAt  = 0;
    /** @type {boolean} 待機モード（ライブでない等で何もしていない状態）か */
    let idling   = true;

    /** @type {number|null} setInterval のタイマー ID */
    let timer  = null;
    /** @type {number} 現在のタイマー間隔（ミリ秒） */
    let period = 0;

    /**
     * バッファ残量を統計的に観測し、「安全に加速できる余裕」を推定するオブジェクト。
     *
     * ■ なぜ統計が必要？
     *   バッファ残量は一定ではなく、のこぎり波のように増減をくり返します。
     *   （新しい塊が届くと増え、再生で減り、また届いて増える…のくり返し）
     *   そのため、たまたま見た瞬間の値だけで判断すると、「山」の値を見て
     *   加速し、直後の「谷」で足りずに止まる、ということが起きます。
     *
     * ■ どう解決する？
     *   短期の平均と標準偏差から「谷の底の推定値」を求め、
     *   さらにその谷の値を長期に集めて平均・ばらつきを見ます。
     *   最終的に使うのは room = 谷の平均 − 安全係数 × 谷のばらつき という値で、
     *   これは「最悪の場合でもこれだけは残っているはず」という保守的な見積もりです。
     *
     * ■ drift（自己補正）という工夫
     *   加速すればバッファは早く減ります。その減少まで「配信が不安定になった」と
     *   誤解すると、加速するほど加速しづらくなるという矛盾が起きます。
     *   そこで自分の加速による消費量を drift として累積し、
     *   統計に入れる前に差し引いて「自分の影響を消した値」で評価しています。
     *
     * ■ 計算の速さ
     *   統計は series() が足し引きだけで持ち回るので、窓が 60 秒ぶん（約 3,000 個）
     *   埋まっていても 1 回の更新はほぼ一定の時間で済みます。結果は下の変数に
     *   書き込むだけで、毎回オブジェクトを作り直しません。
     */
    const Auto = (() => {
        /** 短期観測窓の最小の長さ（ミリ秒）。 */
        const MIN_MS   = 1000;
        /** 短期観測窓の最大の長さ（ミリ秒）。 */
        const MAX_MS   = 30000;
        /** サイトへ「必要なバッファ量」を問い合わせる間隔（ミリ秒）。 */
        const NEEDS_MS = 1000;
        /** 観測窓が「十分に埋まった」とみなす割合（0.5 = 半分以上）。 */
        const COVER    = 0.5;
        /** 統計として信頼するのに必要な最小サンプル数。 */
        const MIN_N    = 8;

        /**
         * 谷を推定するときに、標準偏差の何倍を差し引くか。
         * √3 ≒ 1.732 は、のこぎり波（一様分布に近い形）の標準偏差から
         * 振幅の下端を推定するときに現れる係数です。
         */
        const RAMP     = Math.sqrt(3);

        /** 「安定している」と判定するのに必要な観測時間（ミリ秒）。 */
        const SETTLE_MS    = 1000;
        /** 安定と判定する傾きの上限（秒/秒）。これより急に増減していれば不安定とみなす。 */
        const SETTLE_SLOPE = 0.9;
        /** 谷の履歴が有効と認める最小の蓄積時間（ミリ秒）。 */
        const TROUGH_MIN_MS = 1000;

        /** 短期のバッファ残量サンプル。 */
        const samples = series();
        /** 長期の「谷の推定値」の履歴。 */
        const troughs = series();
        /** 安定判定に使う、平均値の推移。 */
        const levels  = series();

        let windowMs  = MIN_MS;                   // 現在の短期窓の長さ
        let troughMs  = AUTO_TUNING[0].troughMs;  // 現在の長期窓の長さ
        let needsAt   = -Infinity;                // 最後に needs() を呼んだ時刻
        let needsSec  = NaN;                      // サイトが報告した必要バッファ量（秒）
        let drift     = 0;                        // 自分の加速による超過消費の累積（秒）
        let driftAt   = NaN;                      // drift を最後に更新した時刻
        let settleAt  = NaN;                      // 安定判定を開始した時刻

        // --- 直近の統計結果（NaN は「値が無い」ことを表します）---
        let n          = 0;     // 短期窓のサンプル数
        let avg        = NaN;   // 短期窓の平均（drift を差し引いた値）
        let sd         = NaN;   // 短期窓の標準偏差
        let calm       = false; // 安定しているか
        let troughN    = 0;     // 谷の履歴の個数
        let troughSpan = 0;     // 谷の履歴が溜まっている期間（ミリ秒）
        let troughAvg  = NaN;   // 谷の平均（drift を差し引いた値）
        let troughSd   = NaN;   // 谷の標準偏差

        /**
         * 自分の速度変更による超過消費を積み上げる。
         *
         * 1.25 倍速で 1 秒間再生すると、通常より 0.25 秒ぶん多くバッファを消費します。
         * その分を「(速度 - 1) × 経過時間」として累積していきます。
         * @param {number} rate 現在の再生速度。再生していないときは NaN
         * @param {number} now 現在時刻
         * @returns {void}
         */
        function accrue(rate, now) {
            // 一時停止中などは計測を中断します（driftAt を NaN にして次回から再開）。
            if (!Number.isFinite(rate)) { driftAt = NaN; return; }
            if (Number.isFinite(driftAt)) drift += ((rate - 1) * (now - driftAt)) / 1000;
            driftAt = now;
        }

        /**
         * バッファ残量の平均が「安定している」かどうかを判定する。
         *
         * 判定方法：直近 1 秒間で平均値がどれだけ変化したかを傾き（秒/秒）で求め、
         * それが SETTLE_SLOPE 以内に収まっていれば安定とみなします。
         * 読み込み直後のようにバッファが急激に増えている最中は、
         * まだ谷の推定が当てにならないため加速を控えます。
         * @param {number} mean 現在の平均残量
         * @param {number} now 現在時刻
         * @returns {boolean} 安定していれば true
         */
        function steady(mean, now) {
            if (!Number.isFinite(settleAt)) settleAt = now;
            levels.push(now, mean);
            levels.trim(now, SETTLE_MS);

            // 判定に足るだけの時間が経つまでは「まだ安定していない」と答えます。
            if (now - settleAt < SETTLE_MS) return false;

            const elapsed = levels.lastAt() - levels.firstAt();
            if (elapsed <= 0) return false;

            // (値の変化 ÷ 経過ミリ秒) × 1000 で「1 秒あたりの変化量」に直します。
            return Math.abs(((levels.lastValue() - levels.firstValue()) / elapsed) * 1000) <= SETTLE_SLOPE;
        }

        /**
         * 短期観測窓の長さを決める。
         *
         * サイトが「1 塊あたり何秒か」を教えてくれるので、その長さに合わせます。
         * 塊 1 個ぶんの増減をきちんと捉えられる窓にするのが狙いです。
         * @param {number} now 現在時刻
         * @returns {number} 窓の長さ（ミリ秒）
         */
        function windowFor(now) {
            if (now - needsAt >= NEEDS_MS) {
                needsAt = now;
                const needs = toNum(adapter.needs());
                if (needs > 0) {
                    needsSec = needs;
                    windowMs = clamp(needs * 1000, MIN_MS, MAX_MS);
                }
            }
            return windowMs;
        }

        /**
         * 短期サンプルから、平均・ばらつき・谷の推定値を計算する。
         * @param {number} now 現在時刻
         * @returns {number} 今回の谷の推定値。判断材料が足りなければ NaN
         */
        function measure(now) {
            n = samples.size;
            if (n === 0) {
                levels.clear();
                settleAt = NaN;
                avg  = NaN;
                sd   = NaN;
                calm = false;
                return NaN;
            }

            const mean   = samples.mean();
            sd           = samples.sd();
            calm         = steady(mean, now);
            const filled = samples.span() >= windowMs * COVER; // 窓が十分埋まったか
            avg          = mean - drift;                       // 自分の影響を差し引く

            // 谷の推定は「サンプル数が足りる」「窓が埋まっている」「安定している」
            // の 3 つがそろったときだけ。1 つでも欠ければ NaN（＝判断材料なし）にします。
            return n >= MIN_N && filled && calm ? avg - RAMP * sd : NaN;
        }

        /**
         * 谷の推定値を長期の履歴に積み、その平均とばらつきを求める。
         * @param {number} trough 今回の谷の推定値
         * @param {number} now 現在時刻
         * @returns {void}
         */
        function measureTrough(trough, now) {
            // 不安定になったら、それまでの谷の履歴は当てにならないので全部捨てます。
            if (!calm) troughs.clear();
            // 履歴には drift を足し戻した「生の値」で保存します。こうしておくと、
            // 取り出すときに常に「その時点の drift」で引けて、時間差の影響を受けません。
            else if (Number.isFinite(trough)) troughs.push(now, trough + drift);

            troughs.trim(now, troughMs);
            troughN    = troughs.size;
            troughSpan = troughs.span();
            troughAvg  = troughs.mean() - drift;
            troughSd   = troughs.sd();
        }

        return {
            /**
             * 観測データをすべて捨てて初期状態に戻す。
             * 配信が切り替わったときなどに呼びます。
             * @param {boolean} [release=false] true なら統計用に確保したメモリも手放す
             * @returns {void}
             */
            reset(release = false) {
                samples.clear(release);
                troughs.clear(release);
                levels.clear(release);
                needsAt    = -Infinity;
                troughMs   = AUTO_TUNING[0].troughMs;
                drift      = 0;
                driftAt    = NaN;
                settleAt   = NaN;
                n          = 0;
                avg        = NaN;
                sd         = NaN;
                calm       = false;
                troughN    = 0;
                troughSpan = 0;
                troughAvg  = NaN;
                troughSd   = NaN;
            },

            /**
             * 毎回の観測を取り込む。
             * @param {number} health 現在のバッファ残量（秒）
             * @param {number} rate 現在の再生速度。再生していないときは NaN
             * @param {number} now 現在時刻
             * @param {boolean} sampling 統計サンプルとして採用してよいタイミングか
             * @param {number} longMs 長期窓の長さ（ミリ秒）
             * @returns {void}
             */
            update(health, rate, now, sampling, longMs) {
                if (Number.isFinite(longMs) && longMs > 0) troughMs = longMs;

                // drift はサンプリングの有無にかかわらず、常に積み上げます
                // （時間の経過そのものを追うため）。
                accrue(rate, now);

                // イベント起因の割り込み実行では統計に入れません。
                // 一定間隔で採ったサンプルだけを使うことで、統計が偏るのを防ぎます。
                if (!sampling) return;

                if (Number.isFinite(health)) samples.push(now, health + drift);
                samples.trim(now, windowFor(now));

                measureTrough(measure(now), now);
            },

            /**
             * 「安全に使える余裕」を返す（この拡張機能で最も重要な指標）。
             *
             * 計算式：谷の平均 − 安全係数 k × 谷のばらつき
             * ばらつきが大きい（＝不安定な）配信ほど値が小さくなり、
             * 自動的に慎重な判断になります。
             * @param {number} k 安全係数（AUTO_TUNING の troughK）
             * @returns {number} 余裕（秒）。判断材料が足りなければ NaN
             */
            room: (k) => (troughSpan >= TROUGH_MIN_MS ? troughAvg - troughSd * k : NaN),

            /** サイトが報告した必要バッファ量（秒）。 */
            get needs() { return needsSec; },

            /**
             * 谷の履歴を捨てる。状態が切り替わった直後は挙動が変わるため、
             * 前の状態のデータを引きずらないようにします。
             * @returns {void}
             */
            shift() { troughs.clear(); },

            /**
             * 現在の内部状態一式を返す（デバッグ表示用。1 秒に 1 回しか呼ばれません）。
             * @returns {object} 統計のスナップショット
             */
            snapshot: () => ({
                n, avg, sd, calm, troughN, troughSpan, troughAvg, troughSd, windowMs, troughMs, drift,
            }),
        };
    })();

    /**
     * 加速が「実際に効いているか」を検証するオブジェクト。
     *
     * ■ 何のため？
     *   バッファに余裕があっても、遅延が縮まらない状況があります。
     *   たとえば配信側が最前線に達していて、これ以上先のデータが存在しない場合です。
     *   このとき加速を続けても、遅延は縮まらないのにバッファだけが減り、
     *   音程が上ずるだけで何の得もありません。
     *
     * ■ どう検証する？
     *   「加速によって詰められたはずの秒数（asked）」と
     *   「実際に再生位置が余分に進んだ秒数（got）」を突き合わせます。
     *   asked に対して got が半分未満なら空回りと判断し、加速を一時停止（futile）します。
     *
     * ■ 復帰の条件
     *   遅延が再び広がったとき、または一定時間（COOL_MS）経過したときに再開します。
     */
    const Gain = (() => {
        /** 判定を始めるのに必要な、最低限の「詰めようとした秒数」。 */
        const MIN_ASKED = 1.0;
        /** 実績がこの割合を下回ったら空回りとみなす（0.5 = 半分未満）。 */
        const RATIO = 0.5;
        /** 観測窓の基本の長さ（ミリ秒）。 */
        const WINDOW_MS  = 12000;
        /** 観測窓に持たせる余裕の倍率。 */
        const SPAN_SLACK = 1.5;
        /** 加速量が極端に小さいときの下限値（ゼロ除算を避けるため）。 */
        const BURN_MIN   = 0.05;
        /** 判定に必要な最小の観測期間（ミリ秒）。 */
        const MIN_SPAN_MS = 1500;
        /** 空回り判定から自動的に復帰するまでの時間（ミリ秒）。 */
        const COOL_MS = 30000;
        /** 復帰に必要な遅延の増加量を、必要バッファ量の何倍で見るか。 */
        const RECOVER_RATIO = 0.25;
        /** 復帰に必要な遅延の増加量の下限（秒）。 */
        const RECOVER_MIN   = 0.20;
        /** 復帰に必要な遅延の増加量の上限（秒）。 */
        const RECOVER_MAX   = 1.00;
        /** 1 回の計測で許容する最大の時間差（ミリ秒）。これを超えたら計測を捨てる。 */
        const MAX_STEP = 2000;

        /** 「詰めようとした秒数」の履歴。 */
        const asked = series();
        /** 「実際に詰められた秒数」の履歴。 */
        const got   = series();

        let at      = NaN;       // 前回計測した時刻
        let mark    = NaN;       // 前回計測時の再生位置
        let idle    = false;     // 空回り判定で加速を止めているか
        let idleAt  = -Infinity; // 空回り判定に入った時刻
        let idleLat = NaN;       // 空回り判定に入ったときの遅延

        /**
         * 計測履歴を捨てる。
         * @param {boolean} [release=false] true なら確保したメモリも手放す
         * @returns {void}
         */
        const drop = (release = false) => { asked.clear(release); got.clear(release); };

        return {
            /**
             * すべての状態を初期化する。
             * @param {boolean} [release=false] true なら確保したメモリも手放す
             * @returns {void}
             */
            reset(release = false) {
                drop(release);
                at      = NaN;
                mark    = NaN;
                idle    = false;
                idleAt  = -Infinity;
                idleLat = NaN;
            },

            /** 現在「加速しても無駄」と判定されているか。 */
            get futile() { return idle; },

            /**
             * 計測を 1 回ぶん進める。
             * @param {HTMLVideoElement} node 対象の video 要素
             * @param {number} rate 現在の再生速度
             * @param {number} latency 現在の遅延（秒）
             * @param {number} now 現在時刻
             * @returns {void}
             */
            update(node, rate, latency, now) {
                if (node.paused || node.seeking) {
                    // 停止中やシーク中は再生位置が不連続になるため、計測を中断します。
                    at = NaN; mark = NaN;
                } else {
                    const position = node.currentTime;
                    const step     = now - at;

                    // step が異常に大きいのは、タブが裏に回っていた等の可能性が高いので捨てます。
                    if (step > 0 && step <= MAX_STEP) {
                        // 期待値：(速度 - 1) × 経過秒数。1.25 倍速で 1 秒なら 0.25 秒。
                        const expected = ((Number.isFinite(rate) ? rate : 1) - 1) * step / 1000;
                        if (expected > 0) {
                            asked.push(now, expected);
                            // 実績：再生位置の進み − 経過時間。等倍なら 0 になる差分です。
                            got.push(now, (position - mark) - step / 1000);
                        }
                    }
                    at   = now;
                    mark = position;
                }

                // 観測窓の長さは加速量に応じて伸縮させます。加速が控えめなときは
                // 判定に必要な秒数が貯まるまで時間がかかるため、窓を長くとります。
                const burn     = Math.max(settings.speedupRate - 1, BURN_MIN);
                const windowMs = Math.max(WINDOW_MS, (MIN_ASKED / burn) * 1000 * SPAN_SLACK);
                asked.trim(now, windowMs);
                got.trim(now, windowMs);

                // --- 空回り判定中：復帰できるかどうかだけを見ます ---
                if (idle) {
                    const scale   = Auto.needs * RECOVER_RATIO;
                    const recover = Number.isFinite(scale) ? clamp(scale, RECOVER_MIN, RECOVER_MAX) : RECOVER_MAX;

                    // 遅延が再び広がった＝詰める余地が生まれたということ。
                    const behind = latency - idleLat >= recover;
                    if (behind || now - idleAt >= COOL_MS) { idle = false; drop(); log('speedup re-armed', { recover }); }
                    return;
                }

                // --- 通常時：空回りしていないかを確認します ---
                const want = asked.sum();
                const real = got.sum();

                // 3 つの条件がすべてそろったときだけ空回りと判定します。
                // `!(a >= b)` という書き方は、値が NaN のときも安全に「条件を満たさない」
                // 側へ倒れるため、判定を早期に打ち切れるという利点があります。
                if (!(want >= MIN_ASKED)) return;          // 十分に試したか
                if (!(asked.span() >= MIN_SPAN_MS)) return; // 十分な時間を見たか
                if (!(real < want * RATIO)) return;         // 実績が明らかに足りないか

                idle    = true;
                idleAt  = now;
                idleLat = latency;
                drop();
                log('speedup is futile; standing down',
                    { asked: want.toFixed(2), got: real.toFixed(2), windowMs: Math.round(windowMs) });
            },

            /**
             * 現在の状態を返す（デバッグ表示用）。
             * @returns {{ asked: number, got: number, futile: boolean }}
             */
            snapshot: () => ({ asked: asked.sum(), got: got.sum(), futile: idle }),
        };
    })();

    /**
     * 遅延のばらつきを記録するオブジェクト。
     *
     * 制御の判断そのものには使っておらず、デバッグログで
     * 「配信がどれくらい不安定か」を確認するための情報です。
     * 遅延を問い合わせ直したとき（STATUS_MS ごと）にだけ記録します。
     */
    const Noise = (() => {
        /** 観測窓の長さ（ミリ秒）。 */
        const WINDOW_MS = 5000;

        const samples = series();
        let prev  = NaN; // 前回の遅延
        let swing = 0;   // 直近で観測した最大の変化量（デバッグログでは jump として表示）

        return {
            /**
             * 記録を初期化する。
             * @param {boolean} [release=false] true なら確保したメモリも手放す
             * @returns {void}
             */
            reset(release = false) { samples.clear(release); prev = NaN; swing = 0; },

            /**
             * 遅延を 1 件記録する。
             * @param {number} latency 現在の遅延（秒）
             * @param {number} now 現在時刻
             * @returns {void}
             */
            update(latency, now) {
                if (!Number.isFinite(latency)) { prev = NaN; return; }
                samples.push(now, latency);
                if (Number.isFinite(prev)) swing = Math.max(swing, Math.abs(latency - prev));
                prev = latency;
                samples.trim(now, WINDOW_MS);
            },

            /**
             * 統計を取り出す。取り出すと jump（最大変化量）はリセットされます
             * ＝「前回の呼び出し以降の最大値」という意味になります。
             * @returns {{ avg: number, sd: number, jump: number, n: number }}
             */
            snapshot() {
                const peak = swing;
                swing = 0;
                return { avg: samples.mean(), sd: samples.sd(), jump: peak, n: samples.size };
            },
        };
    })();

    /** @type {number} 次にデバッグログを出す時刻 */
    let logAt = 0;

    /**
     * 内部状態を 1 行にまとめてコンソールへ出力する（デバッグ用、1 秒ごと）。
     *
     * 出力例：
     *   speedup  rate=1.25 now=8.32+0.00 health2.0s(avg=7.84 sd=1.20 n= 100) ...
     *
     * 各項目の読み方はリポジトリの TIPS.md に詳しい表があります。
     * @param {number} health 現在のバッファ残量（秒）
     * @param {number} ahead 隙間の先にある未再生バッファ（秒）
     * @param {number} now 現在時刻
     * @param {object} tuned 現在の調整パラメーター（tuning() の結果）
     * @returns {void}
     */
    function report(health, ahead, now, tuned) {
        // 時刻の確認を先にして、デバッグの印（ページ側の変数）を読むのは 1 秒に 1 回だけにします。
        if (now < logAt) return;
        logAt = now + 1000;
        if (!debugging()) return;

        // 桁をそろえて読みやすくするための整形ヘルパー。
        const fmt = (x) => (Number.isFinite(x) ? x.toFixed(2) : '----');
        const cnt = (x) => String(x).padStart(4);
        const sec = (ms) => (ms / 1000).toFixed(1);

        const { n, avg, sd, windowMs, troughMs, calm, troughN, troughSpan, troughAvg, troughSd, drift } = Auto.snapshot();
        const { auto, troughK, margin, ample } = tuned;
        const { asked, got, futile } = Gain.snapshot();
        const lat  = Noise.snapshot();
        const room = Auto.room(troughK);

        log(`${state.padEnd(8)} rate=${fmt(Rate.actual(video))} now=${fmt(health)}+${fmt(ahead)}`
            + ` health${sec(windowMs)}s(avg=${fmt(avg)} sd=${fmt(sd)} n=${cnt(n)})`
            + ` trough${sec(troughMs)}s(avg=${fmt(troughAvg)}s sd=${fmt(troughSd)}s n=${cnt(troughN)}`
            + ` span=${sec(troughSpan)}s)`
            + ` room=${fmt(troughAvg)}-${troughK}*${fmt(troughSd)}=${fmt(room)}s/${fmt(margin)}s`
            + ` ample=${fmt(ample)}s auto=${auto} drift=${fmt(drift)}s calm=${calm ? 'yes' : 'NO'}`
            + ` gain=${fmt(got)}/${fmt(asked)}s${futile ? ' FUTILE' : ''}`
            + ` lat=${fmt(lat.avg)}s(sd=${fmt(lat.sd)} jump=${fmt(lat.jump)} n=${cnt(lat.n)})`);
    }

    /**
     * buffer() の結果の入れ物。毎回作らずに使い回します（中身は次の buffer() まで有効）。
     * @type {{ health: number, ahead: number }}
     */
    const buf = { health: NaN, ahead: 0 };

    /**
     * 現在のバッファ状況を調べる（この拡張機能の一番の基礎データ）。
     *
     * ■ buffered とは
     *   video.buffered は「読み込み済みの時間範囲」のリストです。
     *   広告やシークの影響で、範囲が複数に分かれていることがあります。
     *
     *     [====現在位置===>====]      [========]
     *     └ health（連続再生できる分）┘   └ ahead（隙間の先）┘
     *
     * ■ 隙間の扱い
     *   隙間が adapter.gap 秒以内なら、実用上つながっているとみなして health に足します
     *   （プレーヤーが自動的に飛び越えて再生を続けられる程度の隙間、という判断）。
     *   それより大きい隙間の先は ahead として別に数え、判断には使いません。
     * @returns {{ health: number, ahead: number }} 残量と、隙間の先のバッファ量（秒）
     */
    function buffer() {
        buf.health = NaN;
        buf.ahead  = 0;

        let ranges;
        let at;

        // 要素が壊れている・すでに外されている場合に例外が出ることがあるため囲みます。
        try { ranges = video.buffered; at = video.currentTime; }
        catch { return buf; }

        const gap  = adapter.gap;
        let health = NaN; // 現在位置から連続して再生できる秒数
        let ahead  = 0;   // 隙間の先にあるバッファの合計
        let edge   = NaN; // 現時点で health が届いている終端の時刻

        for (let i = 0, count = ranges.length; i < count; i++) {
            const start = ranges.start(i);
            const end   = ranges.end(i);

            if (Number.isNaN(health)) {
                // まだ現在位置を含む範囲を見つけていない段階。
                if (at >= start - SLACK && at <= end) { health = end - Math.max(at, start); edge = end; }
                else if (start > at) ahead += end - start;
            } else if (start - edge <= gap) {
                // 隙間が十分小さいので、つながっているとみなして加算します。
                health += end - start;
                edge = end;
            } else {
                // 隙間が大きいので、ここから先は別扱い。
                ahead += end - start;
            }
        }
        buf.health = health;
        buf.ahead  = ahead;
        return buf;
    }

    /**
     * tuning() の結果の入れ物と、その結果がどの条件で計算されたかの控え。
     * 結果が変わるのは「設定が変わったとき」と「サイトの必要量が変わったとき」だけなので、
     * それ以外は前回の計算結果をそのまま返します。
     */
    const tune = { auto: 0, troughK: 0, troughMs: 0, margin: 0, ample: 0 };
    /** @type {object|null} tune を計算したときの設定オブジェクト */
    let tunedFor   = null;
    /** @type {number} tune を計算したときのサイトの必要量 */
    let tunedNeeds = NaN;

    /**
     * 現在の設定に応じた調整パラメーター一式を求める。
     * @returns {{ auto: number, troughK: number, troughMs: number, margin: number, ample: number }}
     */
    function tuning() {
        const needs = Auto.needs;
        // Object.is は NaN 同士も「同じ」と判定できる比較です（=== では NaN !== NaN）。
        if (tunedFor === settings && Object.is(tunedNeeds, needs)) return tune;
        tunedFor   = settings;
        tunedNeeds = needs;

        // 設定値が壊れていても配列の範囲を超えないよう、必ず丸めて収めます。
        const auto = clamp(Math.round(settings.speedupAuto), 0, AUTO_TUNING.length - 1);
        const { troughK, troughMs, troughMargin } = AUTO_TUNING[auto];

        // margin（確保しておきたい余裕）の決め方は 3 通り。上から順に当てはまるものを使います。
        //   1) 下限モードが有効 … 下限しきい値 + 段階ごとの余裕（下限に踏み込まない高さ）
        //   2) 自動 ON かつサイトが必要量を報告 … その値をそのまま使う
        //   3) それ以外 … 段階ごとの既定の余裕
        let margin = troughMargin;
        if (settings.floor) margin = settings.floorThreshold + troughMargin;
        else if (auto && needs > 0) margin = needs;

        tune.auto     = auto;
        tune.troughK  = troughK;
        tune.troughMs = troughMs;
        tune.margin   = margin;
        // ample（統計を待たずに加速してよい残量ライン）は、必ず AMPLE 秒以上になります。
        tune.ample    = Math.max(AMPLE, margin + AMPLE_OVER);
        return tune;
    }

    /**
     * 「今どの状態であるべきか」を判断する、この拡張機能の頭脳にあたる関数。
     *
     * 判断は上から順に、優先度の高いものから確認していきます。
     * ヒステリシス（境界での往復防止）は、すでにその状態にいるときだけ基準を緩める形で
     * 効かせます（`state === '…' ? HYSTERESIS : 0` の部分）。
     * @param {number} health 現在のバッファ残量（秒）
     * @param {object} tuned tuning() が返した調整パラメーター
     * @returns {'normal'|'speedup'|'floor'} あるべき状態
     */
    function decide(health, tuned) {
        // 残量が読めないときは、何もしないのが最も安全。
        if (!Number.isFinite(health)) return 'normal';

        // (1) 最優先：バッファが尽きかけていれば、無条件で下限モードへ。
        if (settings.floor && health <= settings.floorThreshold + (state === 'floor' ? HYSTERESIS : 0)) return 'floor';

        // (2) 加速機能が切られていれば通常速度。
        if (!settings.speedup) return 'normal';

        // (3) 加速しても無駄と分かっているなら見送る。
        if (Gain.futile) return 'normal';

        const speeding = state === 'speedup';

        // (4) 近道：残量が十分に多ければ、統計の判断を待たずに加速してよい。
        //     抜けるときは AMPLE_KEEP 秒ぶん低い基準を使い、頻繁な切り替わりを防ぎます。
        if (tuned.auto && health >= tuned.ample - (speeding ? AMPLE_KEEP : 0)) return 'speedup';

        // (5) 手動モード：ユーザーが決めたしきい値と、生の残量をそのまま比較。
        if (!tuned.auto) return health >= settings.speedupThreshold ? 'speedup' : 'normal';

        // (6) 自動モード：統計から求めた「安全な余裕」が、必要な余裕を上回るかで判断。
        //     room が NaN（判断材料不足）のときは比較が false になり、加速しません。
        const need = tuned.margin + HYSTERESIS - (speeding ? HYSTERESIS : 0);
        return Auto.room(tuned.troughK) >= need ? 'speedup' : 'normal';
    }

    /**
     * 学習してきた観測データをすべて捨てる。
     * @param {boolean} [release=false] true なら統計用に確保したメモリも手放す
     * @returns {void}
     */
    function purge(release = false) {
        Auto.reset(release);
        Gain.reset(release);
        Noise.reset(release);
    }

    /**
     * 観測データを捨て、状態も通常へ戻す（仕切り直し）。
     * 配信が切り替わったときなどに呼びます。遅延の情報も次の tick で問い合わせ直します。
     * @param {boolean} [release=false] true なら統計用に確保したメモリも手放す
     * @returns {void}
     */
    function restart(release = false) {
        purge(release);
        state    = 'normal';
        stateAt  = -Infinity;
        statusAt = -Infinity;
    }

    /**
     * 状態を切り替える。ただし、加速を始めるときだけは慎重に扱います。
     *
     * ■ なぜ加速開始だけ待つ？
     *   加速は「始めた直後にバッファが足りなくなる」のが最悪の展開です。
     *   そこで通常 → 加速のときだけ DWELL_MS の様子見期間を設け、
     *   一時的に条件を満たしただけでは動き出さないようにしています。
     *   逆に、加速をやめる・下限へ逃げるといった安全側の変更は即座に行います。
     * @param {'normal'|'speedup'|'floor'} want 移行したい状態
     * @param {number} now 現在時刻
     * @param {boolean} [force=false] true なら様子見をせず即座に切り替える
     * @returns {void}
     */
    function settle(want, now, force = false) {
        if (want === state) return;

        const opening = state === 'normal' && want === 'speedup';
        if (opening && !force && now - stateAt < DWELL_MS) return;

        // 状態が変われば残量の挙動も変わるため、谷の履歴は捨てて集め直します。
        // （加速開始時は、直前まで貯めたデータがそのまま有効なので残します）
        if (!opening) Auto.shift();

        state   = want;
        stateAt = now;
    }

    /**
     * 現在の状態に対応する再生速度を返す。
     * @returns {number} 再生速度
     */
    function rateOf() {
        switch (state) {
            case 'speedup': return settings.speedupRate;
            case 'floor':   return FLOOR_RATE;
            default:        return 1;
        }
    }

    /**
     * 現在の状態に対応する音量の倍率を返す。
     *
     * 下限モードの 0.15 倍速では音声が極端に間延びして不快な音になるため、
     * 設定に応じて音量を絞ります（1 = そのまま、0.3 = 30% の音量）。
     * @returns {number} 音量の倍率
     */
    const duckOf = () => (state === 'floor' && settings.duck ? settings.duckVolume / 100 : 1);

    /**
     * 遅延バッジに表示する文字列を作る。
     * @param {{ latency: number, atHead: boolean }} stat アダプターが返した遅延情報
     * @returns {string} 表示文字列
     */
    function latencyText(stat) {
        const { latency, atHead } = stat;

        // 巻き戻して視聴中なら、遅延秒数ではなく (DVR) と表示します。
        // これは表示だけの区別で、制御は止めません。巻き戻した後の「追っかけ再生」でも、
        // バッファに余裕があれば加速して最前線へ戻るのが仕様です。
        if (atHead === false) return DVR;

        // Math.max(0, ...) は、計測誤差でわずかにマイナスになった値を 0 に丸めるため。
        return Number.isFinite(latency) ? `${Math.max(0, latency).toFixed(2)}s` : '';
    }

    /**
     * 残量バッジに表示する文字列を作る。
     * 隙間の先のバッファが 1 秒以上あるときだけ「+3s」のように併記します。
     * @param {number} health 現在のバッファ残量（秒）
     * @param {number} ahead 隙間の先のバッファ量（秒）
     * @returns {string} 表示文字列
     */
    function healthText(health, ahead) {
        if (!Number.isFinite(health)) return '';
        return `${health.toFixed(2)}s${ahead >= 1 ? ` +${Math.round(ahead)}s` : ''}`;
    }

    /**
     * バッジ 3 種の表示内容の入れ物。repaint() が中身を書き換えて Badges.show() へ渡します
     * （描くたびに作り直さないため）。キーは Badges の NAMES と対応します。
     */
    const faces = {
        playbackrate: { text: '', color: COLOR.normal },
        latency:      { text: '', color: COLOR.normal },
        health:       { text: '', color: COLOR.normal },
    };

    /**
     * バッジ 3 種の表示内容を組み立てて更新する。
     * 3 つとも表示しない設定なら、要素ごと画面から取り除きます。
     * @param {number} health 現在のバッファ残量（秒）
     * @param {number} ahead 隙間の先のバッファ量（秒）
     * @param {{ latency: number, atHead: boolean }} stat 遅延情報
     * @returns {void}
     */
    function repaint(health, ahead, stat) {
        const { showPlaybackRate, showLatency, showHealth } = settings;
        if (!showPlaybackRate && !showLatency && !showHealth) return Badges.detach();

        const color = COLOR[state];
        // 内部の希望値ではなく「実際に効いている速度」を表示します。
        faces.playbackrate.text  = showPlaybackRate ? `${Rate.actual(video).toFixed(2)}x` : '';
        faces.playbackrate.color = color;
        faces.latency.text       = showLatency ? latencyText(stat) : '';
        faces.health.text        = showHealth ? healthText(health, ahead) : '';
        faces.health.color       = color;
        Badges.show(video, faces);
    }

    /**
     * その video が「実際に映像を消費している」かどうか。
     * readyState >= 3（HAVE_FUTURE_DATA）は、次のフレームを再生できるだけの
     * データがそろっている状態を表します。
     * @param {HTMLVideoElement} node 対象の video 要素
     * @returns {boolean} 消費中なら true
     */
    const consuming = (node) => !node.paused && !node.seeking && node.readyState >= 3;

    /**
     * 再生が詰まった（waiting イベント）ときに、状況をログへ残す。
     * 動作そのものは変えず、不具合報告時の手がかりを残すのが目的です。
     * @returns {void}
     */
    function stalled() {
        if (!live || !video || video.seeking || !debugging()) return;
        log('stall', {
            site:        found[0],
            currentTime: video.currentTime,
            readyState:  video.readyState,
            health:      buffer().health,
        });
    }

    /**
     * 定期実行を待たずに、その場で 1 回判断を走らせる。
     *
     * 高頻度モード（20ms ごと）で動いていて、タブも表示されているときは何もしません。
     * 次のタイマーが 20ms 以内に来るので、割り込んでも得るものが無いためです。
     * タブが裏に回ってタイマーが間引かれている間や、待機中は、その場で判断します。
     * @returns {void}
     */
    function pump() {
        if (period === TICK_MS && !document.hidden) return;
        run(false);
    }

    /**
     * シーク後の処理。再生位置が飛ぶと過去の観測が無意味になるため、
     * 学習内容を捨ててから判断をやり直します。
     * @returns {void}
     */
    function jump() { purge(); pump(); }

    /**
     * video 要素に登録するイベントと、その処理の対応表。
     *
     * タイマーによる 20ms ごとの判断に加えてイベントでも起動するのは、
     * タブが裏に回ってタイマーが間引かれても、バッファの増減に反応するためです。
     */
    const MEDIA_HOOKS = [
        ['timeupdate', pump],    // 再生位置が進んだ
        ['progress',   pump],    // データを読み込んだ
        ['seeked',     jump],    // シークが完了した
        ['waiting',    pump],    // 再生が詰まった（即座に対処したい）
        ['waiting',    stalled], // 同上（こちらはログ用）
    ];

    /**
     * video 要素へのイベント登録／解除をまとめて行う。
     *
     * 文字列でメソッド名を切り替えているのは、同じ処理を
     * 登録用と解除用の 2 か所に書かずに済ませるためです。
     * @param {HTMLVideoElement|null} node 対象の video 要素
     * @param {boolean} on true なら登録、false なら解除
     * @returns {void}
     */
    function drive(node, on) {
        if (!node) return;
        const bind = on ? 'addEventListener' : 'removeEventListener';
        for (const [type, handler] of MEDIA_HOOKS) node[bind](type, handler);
    }

    /**
     * <html> の data-slpstrm 属性から最新の設定を読み取る。
     *
     * 呼ばれるのは、属性が変わったと見張り役（settingsObserver）が知らせたときだけです。
     * 文字列のまま前回と比較し、変化がなければ何もしません（JSON.parse を省くため）。
     * @returns {void}
     */
    function refresh() {
        dirty = false;
        const json = document.documentElement?.dataset.slpstrm ?? null;
        if (json === raw) return;

        raw = json;
        let parsed = null;
        try { parsed = JSON.parse(json); } catch { parsed = null; }

        // 必ず sanitize() を通してから採用します（値が壊れていても安全に動くように）。
        settings = sanitize(parsed);
        log('settings', settings);
    }

    /**
     * 制御する video 要素を乗り換える。
     * 古い要素の横取りとイベントを必ず解除します。これを怠ると、
     * 画面に無い要素を操作し続けることになります。
     * @param {HTMLVideoElement|null} next 新しい video 要素
     * @returns {void}
     */
    function adopt(next) {
        Rate.release();
        Volume.release();
        drive(video, false);
        drive(next, true);
        video    = next;
        mediaId  = null;
        mediaAt  = -Infinity;
    }

    /**
     * 再生中のメディアの情報を、必要なときだけ問い合わせ直す（MEDIA_MS ごと）。
     * 別の配信に切り替わっていたら、学習内容をすべて捨てて最初からやり直します。
     * @param {number} now 現在時刻
     * @returns {void}
     */
    function syncMedia(now) {
        if (now < mediaAt) return;
        mediaAt = now + MEDIA_MS;
        media   = adapter.media();

        if (media.id !== mediaId) {
            mediaId = media.id;
            adapter.reset();
            restart();
            // アダプターは結果の入れ物を使い回すので、ログには写しを渡します。
            if (debugging()) log('media', { ...media });
        }
    }

    /**
     * 1 回ぶんの判断と制御を行う、この拡張機能の司令塔。
     * 通常は 20 ミリ秒ごとに、待機中は 1 秒ごとに呼ばれます。
     *
     * ■ 処理の流れ
     *   設定を読む → 対象の video を確認 → ライブかどうか確認
     *   → 観測（残量・遅延）→ 状態を判断 → 速度と音量を適用 → バッジを更新
     *
     *   条件を満たさない場合は途中で sleep() を呼び、
     *   待機モード（低頻度）へ移って CPU の消費を抑えます。
     * @param {boolean} sampling 統計サンプルとして採用してよい呼び出しか
     *        （タイマーによる等間隔の呼び出しなら true、イベント起因なら false）
     * @returns {void}
     */
    function tick(sampling) {
        if (dirty) refresh();

        // 拡張機能が無効、または設定をまだ受け取っていなければ待機します。
        if (!settings?.enabled) return sleep(settings === null ? IDLE_MS : 0);

        const now = performance.now();

        // --- 対象の video 要素を確認する ---
        const next = adapter.video();
        if (next !== video) adopt(next);

        // --- プレーヤーが落ちていないか見張る（対応するアダプターは Twitch のみ）---
        // ライブ判定より前に置くのが要点です。プレーヤーが落ちると duration も
        // LIVE 表示も崩れてライブと判定できなくなるため、判定の後ろに置くと
        // sleep() へ抜けてしまい、復帰処理まで到達しません。
        const healed = settings.recover ? adapter.heal?.() : null;
        if (healed) {
            // 死んだ要素に 0.15 倍速と音量ダッキングを残したまま
            // 新しいストリームを掴まないよう、横取りを解除して学習内容も捨てます。
            Rate.release();
            Volume.release();
            restart();
            mediaAt = -Infinity;
            log('recover', healed);
        }

        if (!video) return sleep();

        // --- 再生中のメディアを確認する ---
        syncMedia(now);

        // 制御の対象になるのはライブ配信だけです（録画は遅延を詰める意味がないため）。
        // プレミア公開は、設定で明示的に許可されていない限り対象外です。
        // live はこの 2 つをまとめた「制御の対象か」を表し、stalled() のログにも使います。
        live = media.live && (!media.premiere || settings.premiere);
        if (!live) return sleep();

        // --- ここから本格的な制御。高頻度モードへ切り替えます ---
        idling = false;
        schedule(TICK_MS);

        const tuned = tuning();
        const { health, ahead } = buffer();
        if (now >= statusAt) {
            statusAt = now + STATUS_MS;
            status   = adapter.status();
            Noise.update(status.latency, now);
        }
        const rate = Rate.actual(video);

        // 各観測オブジェクトへ最新の情報を渡します。
        // 再生していないときの速度は NaN として渡し、drift の計測を止めます。
        Auto.update(health, consuming(video) ? rate : NaN, now, sampling, tuned.troughMs);
        Gain.update(video, rate, status.latency, now);
        report(health, ahead, now, tuned);

        // --- ユーザーが自分で速度を変えていないかを確認する ---
        // 尊重する設定のサイトで、ページ側の希望値が 1.00 から離れていれば、
        // ユーザーが手動で変えたということ。その場合は手を引きます。
        if (adapter.respectUserRate && Math.abs(Rate.wished(video) - 1) > NEAR_ONE) {
            Rate.release();
            settle('normal', now, true);
        } else {
            // 様子見（DWELL_MS）が掛かるのは加速を始めるとき（通常 → 加速）だけで、
            // 加速をやめる・下限へ逃げるといった安全側の切り替えは settle() が常に即座に行います。
            // 手動モード（auto が 0）は設定どおりに動かすため、加速の開始も様子見しません。
            settle(decide(health, tuned), now, !tuned.auto);

            // 通常速度に戻すときは、横取り自体を解除してページに完全に返します。
            if (state === 'normal' && adapter.respectUserRate) Rate.release();
            else Rate.apply(video, rateOf());
        }

        // --- 音量（下限モード時のみ絞る）---
        const duck = duckOf();
        if (duck < 1) Volume.apply(video, duck);
        else Volume.release();

        // --- バッジの更新（判断より低い頻度で十分）---
        if (now < paintAt) return;
        paintAt = now + PAINT_MS;
        repaint(health, ahead, status);
    }

    /**
     * tick() を安全に呼び出すラッパー。
     *
     * 例外を握りつぶすのは、サイト側の予期しない変更で 1 回失敗しても、
     * タイマーごと止まってしまわないようにするためです
     * （次の呼び出しで復帰できる可能性が高い）。
     * @param {boolean} sampling 統計サンプルとして採用してよい呼び出しか
     * @returns {void}
     */
    function run(sampling) {
        try { tick(sampling); }
        catch (error) { log('tick failed', error); }
    }

    /** 高頻度モードのタイマーから呼ぶ関数（統計サンプルとして採用する）。 */
    const onFastTimer = () => run(true);
    /** 待機モードのタイマーから呼ぶ関数（統計サンプルには採用しない）。 */
    const onIdleTimer = () => run(false);

    /**
     * 実行間隔を切り替える。
     *
     * 同じ間隔なら何もしません。毎回タイマーを作り直すと、
     * 一定間隔で呼ばれるはずのサンプリングが崩れてしまうためです。
     * @param {number} ms 新しい間隔（ミリ秒）。0 なら停止
     * @returns {void}
     */
    function schedule(ms) {
        if (ms === period) return;
        if (timer !== null) clearInterval(timer);

        // 高頻度モード（TICK_MS）での呼び出しだけを統計サンプルとして扱います。
        timer  = ms > 0 ? setInterval(ms === TICK_MS ? onFastTimer : onIdleTimer, ms) : null;
        period = ms;
        log('timer', ms ? `${ms}ms` : 'stopped');
    }

    /**
     * 待機モードへ移る（＝制御をやめて低頻度の見張りに戻る）。
     *
     * 大事なのは、必ず横取りを解除してから離れることです。
     * これを忘れると、拡張機能が手を引いたのに速度が変わったままになります。
     * 統計用に確保したメモリも、このときに手放します。
     * @param {number} [ms=IDLE_MS] 待機中の確認間隔。0 ならタイマーを完全に止める
     * @returns {void}
     */
    function sleep(ms = IDLE_MS) {
        // 後片付けは、待機モードへ入る最初の 1 回だけ行います。
        if (!idling) {
            idling = true;
            Rate.release();
            Volume.release();
            Badges.detach();
            restart(true);
            paintAt = 0;
            live    = false;
        }
        schedule(ms);

        // ms が 0（＝完全停止）のときは、video 要素への参照も手放します。
        if (ms) return;
        drive(video, false);
        video = null;
    }

    /**
     * 「何か起きたかもしれない」ときに、判断を 1 回走らせる。
     * すでに高頻度モードで動いていれば、次のタイマーに任せて何もしません。
     * @returns {void}
     */
    function wake() {
        if (period === TICK_MS) return;
        run(false);
    }

    /**
     * 動画の読み込みや再生開始が起きたときの処理。
     * メディアが切り替わった可能性があるので、次の判断では間隔（MEDIA_MS）を待たずに
     * メディアの情報を問い合わせ直します。
     * @returns {void}
     */
    function onMediaEvent() {
        mediaAt = -Infinity;
        wake();
    }

    // =========================================================================
    // イベントの登録（ここから実際に動き始めます）
    // =========================================================================

    // 動画の読み込みや再生開始をきっかけに起動します。
    // 第 3 引数の true は「キャプチャフェーズで受け取る」指定です。
    // これらのイベントは通常は上位要素へ伝わらない（バブリングしない）ため、
    // document でまとめて受け取るにはこの指定が必要になります。
    for (const type of ['loadstart', 'loadedmetadata', 'durationchange', 'play', 'playing']) {
        document.addEventListener(type, onMediaEvent, true);
    }

    /** @type {Element|null} 設定属性の見張りを仕掛け済みの <html> 要素 */
    let watched = null;

    /**
     * 設定の変更（data-slpstrm 属性の書き換え）を見張る役。
     * 変化があれば「読み直しが必要」の印を付け、見張り先を確認し直したうえで、
     * 判断を 1 回走らせます。
     */
    const settingsObserver = new MutationObserver(() => {
        dirty = true;
        watchSettings();
        wake();
    });

    /**
     * 設定属性の見張りを仕掛ける（<html> が差し替えられていれば付け替える）。
     *
     * 見張るのは <html> の data-slpstrm 属性と、document 直下の子要素の 2 つです。
     * 後者は <html> 要素そのものが差し替えられた（document.open() など）ときに、
     * 新しい <html> へ見張りを付け替えるためです。content.js も同じ仕組みで
     * 新しい <html> へ設定を書き込み直します。
     * @returns {void}
     */
    function watchSettings() {
        const root = document.documentElement;
        if (root === watched) return;
        watched = root;
        settingsObserver.disconnect();
        settingsObserver.observe(document, { childList: true });
        if (root) settingsObserver.observe(root, { attributes: true, attributeFilter: ['data-slpstrm'] });
    }

    watchSettings();

    // タブが表示状態に戻ったとき。裏に回っている間はタイマーの精度が落ちるため、
    // 戻ってきた時点で最新の状況を確認し直します。
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) run(false);
    });

    // 最初は待機モード（1 秒間隔）で開始します。ライブ配信を検出した時点で、
    // tick() が自動的に高頻度モード（20 ミリ秒間隔）へ切り替えます。
    schedule(IDLE_MS);
})();
