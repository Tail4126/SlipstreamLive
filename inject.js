// SPDX-License-Identifier: Apache-2.0 OR MIT
/* ================================================================================================
 * inject.js — 本体。バッファ残量を監視して再生速度と音量を制御する
 *             （MAIN world / document_start / すべてのフレームへ注入）
 *
 * 【どこから呼ばれるか】
 *   manifest.json の content_scripts（2 個目、world: "MAIN" のエントリ）の *最後* に読み込まれ、
 *   その場で自動実行される。誰かが呼び出す関数は持たず、起動すると自前のタイマー
 *   （setInterval）とメディアイベントによって永久に回り続ける。
 *
 *   このファイルより先に読み込まれているもの:
 *     shared/util.js   … 共通関数の置き土産（取り込んだ直後に globalThis から削除する）
 *     adapters/*.js    … サイト別アダプタの登録簿（同じく取り込み後に削除する）
 *   このファイルへ設定を渡してくるもの:
 *     content.js       … <html data-slpstrm='{...}'> 属性へ JSON を書き込む（ISOLATED world）
 *
 * 【何をするプログラムか】
 *   ライブ配信は「配信者が今しゃべっている瞬間」から数秒遅れて手元に届く。この遅れを
 *   縮めたければ少し早送りすればよいが、やりすぎると先読み済みの映像（バッファ）を
 *   使い切って再生が止まる。逆に安全を優先して遅れたままだと視聴体験が悪い。
 *   このファイルは 20 ミリ秒ごとにバッファ残量を見張り、次の 3 つの状態を行き来することで
 *   「なるべく遅れを詰めつつ、絶対に止めない」の両立を狙う。
 *
 *     状態       優先度  何をするか
 *     floor      最高    枯渇寸前。0.15 倍速まで落として一気に貯め直す（音量も絞る）
 *     speedup    低      余裕あり。加速して配信の最先端へ追いつく
 *     normal     ―       通常の 1.0 倍速
 *
 *   ただし配信の最先端に追いついてしまえば、それ以上詰められる遅れは存在しない。
 *   ライブ映像は実時間でしか作られないため、そこから先は倍率を上げても再生が
 *   セグメントの到着を追い越して止まるだけで、実効速度はかえって落ちる。
 *   Gain はこの「効かない加速」を実測から検出し、speedup を見送らせる。
 *
 * 【ファイルの構成】
 *   1. 定数
 *   2. 共通ユーティリティの取り込みとデバッグ
 *   3. アダプタの解決
 *   4. hijack   … 再生速度・音量の「所有権」をサイトから奪う仕組み（最重要）
 *   5. Badges   … プレイヤー上に出す情報バッジ
 *   6. sanitize … 設定値のフェイルセーフ検証
 *   7. 内部状態
 *   8. Auto     … バッファの谷を統計的に推定する自動しきい値モジュール（最重要）
 *   9. Gain     … 加速が実際に効いているかを検証するモジュール（最重要）
 *  10. Noise    … サイトが報告する遅延のばらつきを測るモジュール（デバッグ表示用）
 *  11. report   … デバッグログ出力
 *  12. 制御ロジック … buffer / tuning / purge / restart / settle / decide / repaint / tick
 *  13. タイマー制御 … schedule / sleep / wake と起動時のイベント登録
 * ================================================================================================ */
(() => {
    'use strict';

    // 二重注入の防止ガード。iframe の入れ子や拡張機能の再読み込みで 2 回走ると、
    // タイマーが二重に回って速度制御が競合するため、必ず 1 ページ 1 インスタンスに保つ
    if (window.__slipstreamlive) return;
    window.__slipstreamlive = true;

    /* ============================================================================================
       定数
       ============================================================================================ */

    const TICK_MS    = 20;              // メイン制御ループの周期（ミリ秒）。裏に回ったタブではブラウザに間引かれて実際はもっと遅くなる
    const PAINT_MS   = 100;             // バッジ再描画の最小間隔（ミリ秒）。毎 tick 描画すると重いうえ数字がちらつく
    const SLACK      = 0.1;             // 再生位置がバッファ区間の先頭より僅かに手前でも「その区間を再生中」とみなす許容誤差（秒）
    const FLOOR_RATE = 0.15;            // floor 状態の再生倍率。_locales の floorDesc に書いてある説明文と必ず一致させること
    const NEAR_ONE   = 0.001;           // 再生速度を「実質 1.0 倍」とみなす許容誤差。浮動小数点の比較を安全に行うため
    const DVR        = '(DVR)';         // 追っかけ再生中にレイテンシバッジへ出す表記。MAIN world では i18n API を使えないため直書きする

    /*
       谷の統計を待たずに加速してよいと判断するバッファ残量。

       Auto の推定は「のこぎり波の谷が floor の下限を割らないか」を精密に見極めるための仕組みであり、
       残量がその下限より桁違いに多い場面では、そもそも判断材料として不要になる。
       手動シークで急速に先読みが進むと取り込み速度が跳ね上がって calm が false へ張り付き、
       谷の履歴が貯まらないまま room が NaN になるため、60 秒あっても等倍のまま止まってしまう。
       この近道はその状態を埋めるためだけのもので、通常の低遅延配信では発動しない高さに置く。
    */
    const AMPLE      = 20;              // 統計を待たずに加速してよい残量（秒）
    const AMPLE_KEEP = 5;               // 近道から降りるときの緩衝（秒）。のこぎり波の振幅で往復しない幅を取る
    const AMPLE_OVER = 10;              // margin からの最低上乗せ（秒）。floorThreshold を大きくした場合の保険

    /*
       境界での往復（チャタリング）を抑える 2 つの仕掛け。

       HYSTERESIS … 今の状態に留まる側へしきい値をずらす量（秒）。
       DWELL_MS   … 状態を切り替えてから、次の切り替えを許すまでの最小時間（ミリ秒）。

       ヒステリシスだけでは足りない。判定に使う room は実測で 1 秒あたり 0.5 秒ほどの幅で
       揺れており、しきい値のすぐ近くにいる限り、幅をどれだけ広げても境界はいつか踏まれる。
       値の側の対策には原理的な限界があるので、「一度決めたらしばらく動かさない」という
       時間軸の制約を併用する。0.5〜1 Hz の振動はこれで確実に潰れる。

       DWELL_MS を課すのは normal → speedup、すなわち「加速を始める」遷移だけである。
       介入を強める方向だけを慎重にし、弱める方向・安全側へ戻る方向は一切待たせない。

         normal → speedup … 待つ。往復が実測で問題になったのはこの入口だけ
         speedup → normal … 待たない。危ないと判断した後も 2 秒 1.25 倍を続けると
                             0.5 秒ぶん余計にバッファを食い、枯渇を自分で招く
         → floor          … 待たない。枯渇は目前であり、遅らせてよい判断ではない
         floor →          … 待たない。0.15 倍と音量ダッキングは強い介入なので、
                             1 ミリ秒でも短くしたい。既定値では floor 進入から
                             およそ 0.25 秒で脱出条件を満たすため、2 秒縛ると
                             1.5 秒ぶん余計に遅れる（追いつく機能が遅れを増やす）

       待たせない遷移を往復から守るのはヒステリシスだけになるが、これで足りる。実測で
       揺れが問題になったのは room（谷の統計から作る推定値）と margin の比較であって、
       floor が見ている health は生の観測値そのものであり、揺れの性質がまるで違う。

       そして、この 2 つが掛かるのは自動しきい値モード（段階 1 以上）だけである。どちらも
       room が 0.5 秒幅で揺れることへの対策であり、手動モードの判定は「ユーザーが決めた 1 本の線」
       と「生の観測値」を比べるだけの単純なものである。ここへ幅や待ちを足すと、設定した数字と
       実際の挙動が一致しなくなる。

         ヒステリシス … 入口へ足せば設定値が実際には「加速をやめる線」になり、出口から引けば
                        「加速をやめる線」が設定値より 0.2 秒低くなる。どちらへ倒しても、
                        ユーザーが指定した 1 つの数字が 2 本の線に分裂してしまう
         最小滞在時間 … 「閾値を超えているのに加速しない 2 秒」が生まれる

       そこで手動モードは両方とも掛けず、閾値ちょうどで加速し、下回った瞬間に戻す。
       のこぎり波 1 周期ごとに倍率が切り替わる場面は増えるが、予測しやすさを優先した判断である
       （0.15 倍の floor は別の判定なので、そちらのヒステリシスは手動モードでも従来どおり効く）。
    */
    const HYSTERESIS = 0.2;
    const DWELL_MS   = 2000;

    /*
       speedupAuto（0 / 1 / 2）の段階ごとの制御パラメータ。
         troughK      … 谷のばらつきに対する安全余裕係数。大きいほど慎重（加速しにくくなる）
         troughMs     … 推定した谷を貯める長期窓の長さ（ミリ秒）。短いほど直近の状況に素早く追従するが、
                        標本数が減るぶん推定はばらつきやすくなる
         troughMargin … 確保したいバッファ下限へ上乗せする余裕（秒）。tuning() の margin に使う。
                        ただし floor が OFF の段階 1・2 では、下限そのものを adapter.needs() へ
                        置き換えるため参照されない（tuning 参照）

       段階 0 は自動しきい値そのものを使わないため、ここの値は制御に影響しない
       （それでも段階 1 と同じ値を並べておくのは、表の欠けを避けて参照を単純に保つため）。
       段階 1 は「長い窓 × 大きい k」で慎重に、段階 2 は「短い窓 × 小さい k」で
       直近の余裕に素早く反応させる、という対比になっている。
    */
    const AUTO_TUNING = [
        { troughK: 5, troughMs: 30000, troughMargin: 0.5 }, // 0: 自動調整なし（手動しきい値）
        { troughK: 5, troughMs: 30000, troughMargin: 0.3 }, // 1: 標準
        { troughK: 3, troughMs:  5000, troughMargin: 0.1 }, // 2: 積極的
    ];

    // バッジの状態別カラー（normal=白 / speedup=赤 / floor=青）。
    const COLOR = { normal: '#eee', speedup: '#ff8983', floor: '#83c1ff' };

    /* ============================================================================================
       共有ユーティリティの取り込み
       --------------------------------------------------------------------------------------------
       shared/util.js が globalThis へ置いた共通関数を取り込み、直後に削除する。
       adapters/*.js は読み込み時点で自分の関数スコープ内に参照を確保済みなので、
       ここで消してもそちらは動き続ける。消す目的は、ページ本体のスクリプトから
       本拡張の内部関数を触られる余地を残さないこと。
       ============================================================================================ */

    const util = globalThis.__slipstreamliveUtil;
    delete globalThis.__slipstreamliveUtil;
    if (!util) return;                  // 読み込み順が壊れている場合は安全に終了

    const { clamp, toNum, series } = util;

    /* ============================================================================================
       デバッグ
       --------------------------------------------------------------------------------------------
       通常は何も出力しない。開発者コンソールで window.__slipstreamliveDebug = true と打つと
       内部状態の詳細ログが 1 秒ごとに流れるようになる。
       ============================================================================================ */

    /**
     * デバッグログを出す設定になっているかを判定する。
     * 実行のたびに参照するので、途中でオン・オフを切り替えられる。
     *
     * @returns {boolean} デバッグ出力が有効なら true
     */
    const debugging = () => window.__slipstreamliveDebug === true;

    /**
     * デバッグログを 1 行出力する（無効時は何もしない）。
     *
     * @param {...any} args - console.log へそのまま渡す引数
     * @returns {void}
     */
    const log = (...args) => { if (debugging()) console.log('[slipstreamlive]', ...args); };

    /* ============================================================================================
       アダプタの解決
       --------------------------------------------------------------------------------------------
       adapters/*.js が登録した一覧から、今開いているホスト名に合うものを 1 つ選んで生成する。
       ============================================================================================ */

    const sites = globalThis.__slipstreamliveSites ?? {};
    delete globalThis.__slipstreamliveSites; // 選択後はグローバルから消して外部干渉を防ぐ

    const found = Object.entries(sites).find(([, site]) => site.host.test(location.hostname));
    const adapter = found?.[1].create(); // アダプタ本体（サイト固有の操作を担当する）
    if (!adapter) return;                // 対応サイトでなければ何もせず終了

    log('adapter', found[0], location.href);

    /* ============================================================================================
       【最重要】再生速度・音量の所有権制御（hijack）
       --------------------------------------------------------------------------------------------
       ■ 何が問題なのか
         video.playbackRate と video.volume は、本拡張だけのものではない。
         サイト側のプレイヤーもユーザーも同じプロパティを書き換える「共有資源」である。
         ここを単純に上書きすると、次の 2 つの困った現象が起きる。

           1. 速度の奪い合い
              本拡張が 1.25 にする → サイト側が 1.0 に戻す → 本拡張がまた 1.25 に…
              という応酬が毎フレーム発生し、映像がガタつき、UI の表示も暴れる。

           2. 音量の永久汚染
              floor 状態で音量を 30% に絞ると、サイト側はそれを「ユーザーがそう望んだ音量」と
              誤解する。結果、音量スライダーが 30% の位置へ動き、localStorage にも保存され、
              次に開いたときも 30% のまま、という取り返しのつかない事態になる。

       ■ どう解決するか
         プロパティへのアクセスを二重化し、「サイトから見える値」と「実際に効いている値」を
         別々に持つ。この二重化のことを、このファイルでは hijack（乗っ取り）と呼んでいる。

           wish（論理値）… <video> 要素そのものに独自の getter / setter を定義して保持する。
                            サイトが video.volume を読むと必ずこの値が返るので、
                            サイトから見れば「何も変わっていない」ように見える。
                            サイトが書き込んでも wish が更新されるだけで、実際の再生には影響しない。

           物理値        … HTMLMediaElement.prototype がもともと持っている本来の getter / setter を
                            call() で直接呼んで書き込む。要素に定義した独自アクセサを通らないため、
                            サイトに気づかれずに確実な制御ができる。

         つまりサイトには嘘の値を見せ続け、裏で本物を操作する構造になっている。

       ■ output(wish, arg) の役割
         「サイトの希望（wish）」と「拡張機能の要求（arg）」から、実際に書き込む物理値を計算する。
         速度と音量で扱いが違うため、関数として外から差し込めるようにしている。

           Rate（再生速度）  : (wish, rate) => rate
                               実速度は拡張が完全に決めてしまう。wish は再生には使わず、
                               「ユーザーが手動で 1.0 以外を選んだか」を検知して
                               制御を譲るかどうかの判断材料にするためだけに記録する。

           Volume（音量）    : (wish, scale) => wish * scale
                               ユーザーの希望音量にダッキング倍率を掛ける。この形にしておけば、
                               音量を絞っている最中でもユーザーのスライダー操作は正しく効く
                               （wish が変われば物理値も追従して変わる）。

       ■ なぜ document_start が必須なのか
         ページ本体のスクリプトが 1 行も走る前にこのファイルが動くため、
         HTMLMediaElement.prototype はブラウザ標準のまま手つかずである。
         そこから取り出した本来の getter / setter は「誰にも細工されていない本物」だと保証できる。
         もしサイト側が先にプロトタイプを書き換えていたら、その細工ごと掴んでしまうことになる。
       ============================================================================================ */

    /**
     * HTMLMediaElement のプロパティを乗っ取り、拡張機能主導の制御へ切り替える仕組みを作る。
     *
     * 戻り値のオブジェクトは 4 つの操作を提供する。
     *   apply(node, next) … 対象要素を乗っ取って制御パラメータを適用する
     *   release()         … 乗っ取りを解除し、元の状態へ戻す
     *   actual(node)      … 実際に効いている物理値を読む（バッジ表示用）
     *   wished(node)      … サイト／ユーザーが希望している論理値を読む（制御を譲る判断用）
     *
     * @param {string}                           prop   - 乗っ取る対象。'playbackRate' または 'volume'
     * @param {function(number): (number|null)}  valid  - 値の検証。不正なら null を返す関数
     * @param {function(number, number): number} output - (wish, arg) から物理値を計算する関数
     * @returns {{ apply: Function, release: Function, actual: Function, wished: Function }} 制御オブジェクト
     */
    function hijack(prop, valid, output) {
        // ブラウザ標準の本来の getter / setter を取り出す。
        // ページのスクリプトが走る前なので、細工されていない純正品であることが保証されている。
        // 万一取得できなくても分割代入で例外にならないよう、空オブジェクトを受け皿にしておく
        const { get, set } = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, prop) ?? {};
        if (typeof get !== 'function' || typeof set !== 'function') {
            log(`cannot hijack ${prop}: accessor not found`);
            return { release() { }, actual: () => 1, wished: () => 1, apply() { } };
        }

        /**
         * 自前アクセサを迂回して、物理値を直接読む。
         *
         * @param {HTMLMediaElement} node - 対象要素
         * @returns {number} 物理値。読めなければ 1
         */
        const read = (node) => { try { return get.call(node); } catch { return 1; } };

        /**
         * 自前アクセサを迂回して、物理値を直接書く。
         * 同じ値なら書き込みを省く。無駄な代入はサイト側の変更イベントを誘発するため
         *
         * @param {HTMLMediaElement} node  - 対象要素
         * @param {number}           value - 書き込む物理値
         * @returns {void}
         */
        const write = (node, value) => { try { if (get.call(node) !== value) set.call(node, value); } catch { } };

        let owned = null;               // 現在乗っ取り中の <video> 要素（未乗っ取りなら null）
        let wish  = 1;                  // サイト／ユーザーが希望している論理値
        let arg   = 1;                  // 拡張機能が要求する制御パラメータ（速度倍率 または 音量スケール）

        /**
         * 自前 getter。サイトが video[prop] を読んだときに呼ばれ、常に wish を返す。
         * 同時に「このプロパティをまだ自分が握っているか」を確認するための目印も兼ねている
         * （後述の apply() で、getter がこの関数かどうかを比べて乗っ取りの生存を判定する）。
         *
         * @returns {number} サイトへ見せる論理値
         */
        const mine = () => wish;

        /**
         * 自前 setter。サイトが video[prop] = value を実行したときに呼ばれる罠。
         * 実際には書き込ませず、希望値として記録するだけに留める。
         *
         * @param {any} value - サイトが書き込もうとした値
         * @returns {void}
         */
        const catcher = (value) => {
            // Symbol や valueOf が例外を投げるオブジェクトを渡されても、ページ側へ例外を返さない。
            // ここはサイトのコードから直接呼ばれる罠なので、投げるとサイトの処理まで巻き込んで壊す
            let next = null;
            try { next = valid(Number(value)); } catch { return; }
            if (next === null) return;  // 不正値は黙って無視する

            wish = next;
            if (owned) write(owned, output(wish, arg)); // 希望が変わったので物理値を計算し直す
        };

        /**
         * 乗っ取りを解除し、元のプロパティ構造と希望値を復元する。
         *
         * 独自に定義した own property を delete することで、隠れていた
         * プロトタイプ本来の getter / setter が再び表に出てくる。そのうえで
         * 直前の希望値を物理プロパティへ書き戻せば、サイトから見て何事もなかった状態に戻る。
         *
         * @returns {void}
         */
        function release() {
            if (!owned) return;

            const node  = owned;        // 解除対象の要素（先に控えておく）
            const value = wish;         // 書き戻す希望値（先に控えておく）
            owned = null;
            wish  = 1;
            arg   = 1;

            try { delete node[prop]; } catch { } // own property を削除してプロトタイプを露出させる
            write(node, value);                  // 直前の希望値を物理プロパティへ書き戻す
        }

        return {
            release,

            /**
             * その要素に実際に効いている物理値を読む。
             *
             * @param {HTMLMediaElement|null} node - 対象要素
             * @returns {number} 物理値。要素が無ければ 1
             */
            actual: (node) => (node ? read(node) : 1),

            /**
             * サイト／ユーザーが希望している論理値を読む。
             * 乗っ取り中でない要素については物理値がそのまま希望値なので、それを返す。
             *
             * @param {HTMLMediaElement|null} node - 対象要素
             * @returns {number} 論理値。要素が無ければ 1
             */
            wished: (node) => (node === owned ? wish : node ? read(node) : 1),

            /**
             * 対象要素を乗っ取り、制御パラメータ next を適用する。
             *
             * 処理の流れ:
             *   1. 前回と違う要素なら、まず前の要素の乗っ取りを解除し、新しい要素の現在値を希望値とする
             *   2. まだ仕掛けていない、またはページ側に own property を再定義され奪い返された場合は仕掛け直す
             *      （getter が mine かどうかで判定できる。ページが定義し直せば別の関数になっているはず）
             *   3. 制御パラメータを記録し、output() で計算した物理値を書き込む
             *
             * @param {HTMLMediaElement} node - 対象の <video> 要素
             * @param {number}           next - 速度倍率（Rate の場合）または 音量スケール（Volume の場合）
             * @returns {void}
             */
            apply(node, next) {
                if (node !== owned) {
                    release();
                    wish = valid(read(node)) ?? 1; // 新しい要素の現在値を初期希望値として引き継ぐ
                }

                if (Object.getOwnPropertyDescriptor(node, prop)?.get !== mine) {
                    try {
                        Object.defineProperty(node, prop, { configurable: true, get: mine, set: catcher });
                    } catch (error) {
                        // 定義を拒まれたら所有権を主張しない。owned を残すと wished() が古い希望値を
                        // 返し続け、ユーザー操作の検出が狂う
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

    // 再生速度の制御オブジェクト。有限かつ正の数だけを有効とし、実速度は wish と無関係に rate をそのまま使う
    const Rate = hijack('playbackRate', (n) => (Number.isFinite(n) && n > 0 ? n : null), (wish, rate) => rate);

    // 音量の制御オブジェクト。0〜1 の範囲だけを有効とし、実音量は 希望音量 × ダッキング倍率 とする
    const Volume = hijack('volume', (n) => (n >= 0 && n <= 1 ? n : null), (wish, scale) => wish * scale);

    /* ============================================================================================
       バッジ OSD（プレイヤー上に重ねて出す小さな情報表示）
       --------------------------------------------------------------------------------------------
       再生倍率・遅延・バッファ残量の 3 つを、可能ならサイトのコントロールバーの中へ差し込む。
       差し込み先が見つからない場合は、画面左上に独自の黒い帯を出してそこへ並べる。
       ============================================================================================ */
    const Badges = (() => {
        const NAMES   = ['playbackrate', 'latency', 'health']; // バッジの種類と表示順
        const SLOT_MS = 1000;                                  // 差し込み先を再評価する間隔（ミリ秒）

        /**
         * バッジ 1 個分のボタン要素を作る。
         * button にしているのは、サイト側のコントロールバー用スタイルを借りやすくするため。
         * ただし実際には押せないよう pointer-events と tabIndex を無効化してある。
         *
         * @param {string} name - バッジの種類（'playbackrate' / 'latency' / 'health'）
         * @returns {HTMLButtonElement} 生成した要素
         */
        function build(name) {
            const node = document.createElement('button');
            node.type          = 'button';
            node.className     = `_slipstreamlive_${name} ${adapter.badgeClass}`.trim();
            node.style.cssText = 'display:none;width:auto;height:auto;padding:0 8px;font-weight:normal;'
                + 'cursor:default;pointer-events:none;user-select:none;'
                + 'text-shadow:0 1px 2px #000c;'  // 明るい映像の上でも文字が読めるよう影を付ける
                + adapter.badgeStyle;
            node.tabIndex      = -1;              // キーボードのフォーカス対象から外す
            node.setAttribute('translate', 'no'); // ブラウザの自動翻訳に数字をいじられないようにする
            return node;
        }

        // 種類名 → バッジ要素 の対応表
        const nodes = new Map(NAMES.map((name) => [name, build(name)]));

        // コントロールバーが見つからないときに使う、フォールバック用の黒い帯
        const shelf = document.createElement('div');
        shelf.className     = '_slipstreamlive_shelf';
        shelf.style.cssText = 'position:absolute;top:8px;left:8px;z-index:2147483000;'
            + 'display:flex;align-items:center;gap:2px;padding:2px 4px;border-radius:6px;'
            + 'background:#000000a6;pointer-events:none;';

        let styled = null;              // position を書き換えたページ側の要素（後始末で元へ戻す）

        /**
         * 帯 UI のために書き換えたページ側の position を元へ戻す。
         * ページの DOM へ加えた変更を残したまま立ち去らないための後始末。
         *
         * @returns {void}
         */
        function unstyle() {
            if (!styled) return;
            styled.style.position = '';
            styled = null;
        }

        /**
         * バッジの差し込み先を決めて、必要なら帯 UI を設置する。
         * コントロールバーが取れればそれを優先し、取れなければ帯をプレイヤーへ貼り付ける。
         *
         * @param {HTMLVideoElement|null} video - 現在の <video> 要素
         * @returns {Element|null} 差し込み先の要素。どこにも置けなければ null
         */
        function slot(video) {
            const bar = adapter.host(); // サイト UI 上のコントロールバー
            if (bar) { shelf.remove(); unstyle(); return bar; }

            // 切り離された要素を器にすると、バッジが永久に見えないまま再試行を繰り返す
            const root = adapter.root();
            const box  = root?.isConnected ? root : video?.parentElement ?? null;
            if (!box?.isConnected) return null;

            if (shelf.parentElement !== box) {
                unstyle();
                // 親要素が position: static のままだと絶対配置の基準にならず、帯が画面の隅へ飛んでしまう
                if (getComputedStyle(box).position === 'static') {
                    box.style.position = 'relative';
                    styled = box;
                }
                box.append(shelf);
                log('badges on fallback shelf', box);
            }
            return shelf;
        }

        /**
         * バッジ 1 個の内容を更新する。前回と同じ内容なら DOM を触らない。
         * PAINT_MS = 100 ミリ秒、つまり毎秒 10 回の更新でも無駄な再描画を起こさないための最適化。
         *
         * @param {HTMLElement} node - 対象のバッジ要素
         * @param {string} text - 表示する文字列（空文字なら非表示にする）
         * @param {string} color - 文字色
         * @returns {void}
         */
        function paint(node, text, color) {
            const stamp = `${text}|${color}`; // 内容が変わったかを比べるための指紋
            if (node._slipstreamlive === stamp) return;
            node._slipstreamlive   = stamp;

            node.style.display     = text ? 'inline-block' : 'none';
            node.textContent       = text;
            node.style.color       = color;
        }

        let host   = null;              // 現在バッジを載せている親要素
        let slotAt = 0;                 // 次に差し込み先を再評価する時刻（ミリ秒）

        return {
            /**
             * バッジをすべて DOM から取り外す（機能 OFF 時や制御対象外になったとき）。
             *
             * @returns {void}
             */
            detach() {
                for (const node of nodes.values()) node.remove();
                shelf.remove();
                unstyle();              // ページ側へ加えた position の変更も戻す
                host   = null;
                slotAt = 0;             // 再表示のときは待たずに差し込み先を引き直す
            },

            /**
             * バッジを表示・更新する。
             *
             * 定期的に差し込み先を再評価しているのは、いったん帯 UI へ退避した後で
             * コントロールバーが生成された場合に、そちらへ引っ越せるようにするため。
             * また、プレイヤーが作り直されてバッジが DOM から切り離された場合も検知して復帰する。
             *
             * @param {HTMLVideoElement|null} video - 現在の <video> 要素
             * @param {Object}                face  - 各バッジの { text, color }（キーは NAMES と同じ）
             * @returns {void}
             */
            show(video, face) {
                const all  = [...nodes.values()];                   // バッジ要素の配列（まとめて移動させるため）
                const now  = performance.now();
                const lost = all.some((node) => !node.isConnected); // プレイヤー作り直しなどで切り離された

                if (lost || now >= slotAt) {
                    slotAt = now + SLOT_MS;
                    const next = slot(video);
                    if (next && (lost || next !== host)) {
                        host = next;
                        next.append(...all); // 既存の要素ごと引っ越す（作り直しは不要）
                    }
                }

                for (const [name, node] of nodes) paint(node, face[name].text, face[name].color);
            },
        };
    })();

    /* ============================================================================================
       設定値のフェイルセーフ検証
       --------------------------------------------------------------------------------------------
       data-slpstrm 属性には content.js が shared/schema.js の KEYS に基づいて整形済みの値を
       書き込む。しかし MAIN world ではページ側のスクリプトも同じ属性を書き換えられるため、
       ここでもう一度、独立した基準でクランプし直す。

       ※ 下の表は KEYS.range の写しではなく、「壊れた値が来たときに安全側へ倒す」ための
         独立した保険である。たとえば speedupRate の破損時の既定値が 1 なのは、
         「よく分からない値なら加速しない」という最も安全な選択をするため。

       守るべき約束: 下表の [下限, 上限] ⊇ KEYS.range の [min, max]
                     ここが破れると、ポップアップで設定できるのにこちらで弾かれる値が生まれる。
       ============================================================================================ */

    // ON / OFF のスイッチ系。true 以外はすべて false 扱いにする
    const GUARD_SWITCHES = [
        'enabled', 'showPlaybackRate', 'showLatency', 'showHealth',
        'speedup', 'floor', 'duck',
    ];

    // 数値系。キー: [下限, 上限, 値が壊れていたときの既定値]
    const GUARD_NUMBERS = {
        speedupRate:       [1,    4,    1],   // 早送り倍率（破損時は 1 = 加速しない）
        speedupThreshold:  [0,    100,  10],  // 手動早送りのバッファしきい値（秒）
        speedupAuto:       [0,    2,    1],   // 自動しきい値の段階（0 = 使わない）
        floorThreshold:    [0,    10,   0.3], // floor へ入るバッファしきい値（秒）
        duckVolume:        [0,    100,  100], // floor 中の音量割合（%。破損時は 100 = 絞らない）
    };

    /**
     * 設定オブジェクトを検証・クランプして、必ず全キーが揃った安全な形に整える。
     * 未知のキーは捨てられ、欠けているキーは既定値で埋まるので、
     * 呼び出し側は settings.xxx が undefined になる心配をせずに済む。
     *
     * なお floorThreshold の下限が 0 であることは tuning() の margin 計算が前提にしている。
     *
     * @param {any} value - JSON.parse した結果（何が入っているか分からない）
     * @returns {Object|null} 整えた設定オブジェクト。オブジェクトですらなければ null
     */
    function sanitize(value) {
        if (!value || typeof value !== 'object') return null;

        const out = {};                             // 整えた結果を入れる箱
        for (const key of GUARD_SWITCHES) out[key] = value[key] === true;

        for (const [key, [lo, hi, def]] of Object.entries(GUARD_NUMBERS)) {
            const num = Number(value[key]);
            out[key] = Number.isFinite(num) ? clamp(num, lo, hi) : def;
        }

        return out;
    }

    /* ============================================================================================
       内部状態
       ============================================================================================ */
    let settings = null;     // 整形済みの実効設定。まだ読み込めていなければ null
    let raw      = null;     // 直近に読み取った data-slpstrm の生 JSON 文字列。変化検出に使う
    let video    = null;     // 現在監視している <video> 要素
    let mediaId  = null;     // 現在再生中のメディアの識別 ID。変化したら「別の動画になった」と判断する
    let live     = false;    // 直近の tick で判定した「ライブ配信中かどうか」。stalled() のログ条件に使う
    let state    = 'normal'; // 現在の制御状態。'normal' | 'speedup' | 'floor' のいずれか
    let stateAt  = -Infinity; // 現在の制御状態へ移った時刻（ミリ秒）。DWELL_MS の起点
    let paintAt  = 0;        // 次にバッジを描画してよい時刻（ミリ秒）
    let idling   = true;     // 制御を休止中かどうか。休止へ入った瞬間に一度だけ後始末をするためのフラグ

    const IDLE_MS  = 1000;   // 休止中（制御対象が無い・ライブでない）の見張り周期（ミリ秒）

    let timer  = null;       // 現在のタイマー ID（null なら完全停止中）
    let period = 0;          // 現在の周期（ミリ秒）。0 は停止を意味する

    /* ============================================================================================
       【最重要】speedupAuto（自動しきい値）の推定モジュール
       --------------------------------------------------------------------------------------------
       ■ 何を解こうとしているのか
         「バッファが何秒たまっていたら早送りしてよいか」を、配信ごとに自動で決めたい。
         ユーザーに「10 秒」などと手で入れさせる方式（手動モード）もあるが、
         適切な値は配信の方式や回線状況で大きく変わるため、当てるのが難しい。

       ■ なぜ瞬間値では判断できないのか
         バッファ残量（health）は一定ではなく、のこぎり波を描いて上下している。
         映像は「セグメント」という数秒単位の塊で届くため、

             セグメントが届いた瞬間  … 残量が S 秒分ドンと増える（山）
             その後の再生中          … 残量が時間とともに一定の速さで減る
             次のセグメントが届く直前 … 残量が最も少なくなる（谷）

         という周期を延々と繰り返す。ここで瞬間値だけを見て判断すると、
         たまたま山の頂上を見た瞬間に「余裕がある」と誤解して加速し、
         その直後の谷で枯渇して再生が止まる、という最悪の結果になりかねない。
         安全に加速するには、山ではなく「谷（trough）」がどこにあるかを知る必要がある。

       ■ 統計モデル（セグメント長 S を知らなくても谷を求める）
         のこぎり波の 1 周期からでたらめなタイミングで残量を測ると、その値は
         区間 [trough, trough + S] の一様分布に従う（どの高さも等しく出やすい）。
         一様分布には次の性質があるので、

             avg = trough + S / 2
             sd  = S / (2 * Math.sqrt(3))

         2 番目の式を S について解いて 1 番目へ代入すると、未知数 S が消えて次の式が得られる。

             trough = avg - Math.sqrt(3) * sd        // 定数 RAMP = Math.sqrt(3) ≒ 1.732

         つまり短い時間の「平均」と「標準偏差」さえ測れば、セグメント長を一切知らなくても
         谷の位置を推定できる。これがこのモジュールの核心である。

       ■ さらに安全側へ寄せる（room の計算）
         推定した谷そのものも、回線状況によって時々刻々とばらつく。そこで谷の推定値を
         長期窓（AUTO_TUNING[段階].troughMs）に貯め、その平均 troughAvg と標準偏差 troughSd を求め、
         ばらつきに対する安全余裕 troughK を掛けて差し引いた値を、実効的な余裕バッファとする。

             room = troughAvg - troughSd * troughK

         troughK を大きくするほど「谷が安定していないうちは加速しない」という安全志向が強まる。
         谷が毎回ほぼ同じ高さ（troughSd ≒ 0）でなければ room は伸びず、
         回線が不安定な状況では自然と加速が抑制される。

       ■ 標本が足りないときの扱い
         観測した時間が 1 周期に満たないと、山だけ・谷だけを見てしまって標準偏差が
         過小評価され、谷を実際より高く見積もる（＝危険側に外す）。
         そこで最小標本数 MIN_N と窓の充填率 COVER を満たすまで trough を NaN のままにする。
         NaN はどんな比較をしても false になるため、decide() の判定は自動的に 'normal' へ落ちる。
         「分からないときは何もしない」が数値の性質だけで実現される仕組みになっている。

       ■ 自分の速度変更が統計を汚す問題（既知入力の補償）
         この拡張自身が倍率を変えると、残量は自分の操作のせいで一方向に動く。1.25 倍で
         30 秒走れば残量は 7.5 秒ぶん減るが、これは回線が不安定だからではなく仕様どおりの動作である。
         ところが窓の中に傾き m の直線的な変化が乗ると、観測される統計は二重に狂う。

             平均   … 現在値より m * T / 2 だけ古い（高い）方向へずれる    → 谷を高く見積もる＝危険側
             標準偏差 … sd_obs^2 ≒ sd_true^2 + m^2 * T^2 / 12 に水増しされる → room を削る＝過剰に慎重

         長期窓が 30 秒のとき m = 0.25 なら平均が 3.75 秒ずれ、sd に 2.17 秒が上乗せされる。
         後者は troughK 倍されて効くため、差し引きでは room が大きく削られる。結果として
         「加速する → room が枯れる → 通常速度へ戻る → 窓が均される → また加速する」
         という自励振動を起こす。自分の操作が自分の観測を汚す、閉ループ特有の罠である。

         しかし倍率は自分で決めた値なので完全に既知である。そこで超過消費を累積し、

             D(t) = ∫ (rate(τ) - 1) dτ

         各標本を「現在時点まで持ち越した等価値」へ直してから統計を取る。

             v*i = vi - ( D(now) - D(ti) )

         つまり 3 秒前に 1.25 倍で測った標本は、その後 0.75 秒ぶん余計に減っているとみなす。
         回線側の取り込み速度を知る必要はない。既知の分だけを引くので、残った変動は
         そのままセグメント到着のばらつき（＝本来測りたいもの）になる。

       ■ 補償の実装（配列を写像し直さないための工夫）
         v*i = ( vi + D(ti) ) - D(now) であり、D(now) は窓の全標本に共通の定数である。
         定数を足し引きしても標準偏差は変わらないので、

             貯めるとき … value = health + D(t)     （補償座標で保存する）
             読むとき   … avg = 平均 - D(now)、sd はそのまま

         とすれば、毎 tick 配列を作り直さずに補償済みの統計が得られる。谷の履歴も同じ扱いにする。
         窓が長いほどドリフトの影響は大きいので、むしろ谷の側への適用のほうが効果が大きい。

         なお D は長時間の視聴で数千秒に達しうるが、stats() は平均を引いてから二乗和を取る
         2 パス方式なので精度は落ちない（倍精度の相対誤差は約 2.2e-16）。
       ============================================================================================ */

    const Auto = (() => {
        const MIN_MS   = 1000;          // 短期窓の下限（ミリ秒）
        const MAX_MS   = 30000;         // 短期窓の上限（ミリ秒）
        const NEEDS_MS = 1000;          // adapter.needs() を呼び直す間隔（ミリ秒）
        const COVER    = 0.5;           // 谷の推定を許可する窓の充填率（半分以上埋まっていること）
        const MIN_N    = 8;             // 谷の推定を許可する最小標本数
        const RAMP     = Math.sqrt(3);  // 一様分布の 半振幅 ÷ 標準偏差 の比（約 1.732）

        const SETTLE_MS    = 1000;      // 定常かどうかを判定するために水準の履歴を見る時間（ミリ秒）
        const SETTLE_SLOPE = 0.9;       // 定常とみなすバッファ水準の変化率の上限（秒／秒）

        // 谷の履歴がこの時間ぶん貯まるまで room を出さない（ミリ秒）。
        // 標本が 1 個だと標準偏差が 0 になり、安全余裕がまったく引かれないまま
        // room = trough として素通りしてしまうため、件数ではなく時間で下限を設ける
        const TROUGH_MIN_MS = 1000;

        // 統計がまだ何も取れていないことを表す初期値
        const EMPTY = {
            n: 0, avg: NaN, sd: NaN, trough: NaN, calm: false,
            troughN: 0, troughSpan: 0, troughAvg: NaN, troughSd: NaN,
        };

        const samples = series();                // 短期のバッファ残量の標本（value は補償座標）
        const troughs = series();                // 推定された谷の履歴（value は補償座標）
        const levels  = series();                // 補償座標の短期平均の履歴。定常性の判定に使う

        let windowMs  = MIN_MS;                  // 現在の短期窓の長さ（ミリ秒）
        let troughMs  = AUTO_TUNING[0].troughMs; // 現在の長期窓の長さ（ミリ秒）。update() が段階に応じて差し替える
        let needsAt   = -Infinity;               // 前回 adapter.needs() を呼んだ時刻（ミリ秒）
        let needsSec  = NaN;                     // 直近に取得したアダプタ固有の目安バッファ秒数（秒）
        let view      = EMPTY;                   // 直近の統計結果のキャッシュ
        let drift     = 0;                       // 1.0 倍からの超過消費の累積 D(t)（秒）。加速中は増え、減速中は減る
        let driftAt   = NaN;                     // 前回 drift を積算した時刻（ミリ秒）。NaN なら今回の積算は見送る
        let settleAt  = NaN;                     // 水準履歴を数え始めた時刻（ミリ秒）。NaN なら次回 steady() で初期化する

        /**
         * 1.0 倍からの超過消費 D(t) = ∫(rate - 1)dt を、前回の呼び出しからの経過分だけ積算する。
         *
         * 倍率を変えるのは tick() だけであり、tick と tick の間で倍率は決して動かない。
         * したがって区間内を定数とみなす長方形近似は、近似ではなく厳密な値になる。
         * 裏タブでタイマーが間引かれて経過時間が伸びても、この性質は変わらないので上限は設けない。
         *
         * rate が NaN のとき（一時停止中など、バッファが減らない状況）は積算を見送り、
         * 次回も見送れるよう driftAt を NaN へ戻す。そうしないと再開した最初の 1 回で、
         * 止まっていた時間ぶんをまとめて積んでしまう。
         *
         * @param {number} rate - この区間で実際に効いていた再生倍率。積算を見送るなら NaN
         * @param {number} now  - 現在時刻（performance.now() 由来のミリ秒）
         * @returns {void}
         */
        function accrue(rate, now) {
            if (!Number.isFinite(rate)) { driftAt = NaN; return; }

            if (Number.isFinite(driftAt)) drift += ((rate - 1) * (now - driftAt)) / 1000;
            driftAt = now;
        }

        /**
         * 配信が「定常」か、すなわちのこぎり波モデルを当てはめてよい状態かを判定する。
         *
         * ■ なぜ必要か
         *   バッファが空から満ちていく起動直後、スタールからの復帰直後、一時停止中などは、
         *   水準そのものが一方向へ速く動く。この区間を切り出して測ると、標準偏差は
         *   のこぎり波の振幅ではなく水準の移動量を測ってしまい、谷の推定が丸ごと壊れる。
         *   しかも壊れた谷は長期窓に居座り、その後 troughMs のあいだ統計を汚しつづける。
         *
         * ■ 何を見るか
         *   補償座標（health + D(t)）の傾きは、式を展開すると
         *
         *       d(health + D)/dt = (取り込み速度 - 再生倍率) + (再生倍率 - 1) = 取り込み速度 - 1
         *
         *   となり、自分の速度変更の影響がきれいに消える。つまり残った傾きは純粋に
         *   「回線が供給過剰か供給不足か」だけを表す。ライブの最先端を追えている定常状態では
         *   取り込み速度は平均 1.0 なので傾きは 0 付近に落ち着き、起動中は +5 前後、
         *   一時停止中は +1 前後まで跳ねる。SETTLE_SLOPE はこの差を分ける位置に置いてある。
         *
         * ■ 傾きの測り方（履歴が貯まるまで判定しないこと）
         *   渡される mean は短期窓（≒ セグメント 1 周期）の平均なので、のこぎり波成分は
         *   その時点ですでに均されている。あとは SETTLE_MS 離れた 2 点を結べば十分な精度が出る。
         *
         *   逆に言えば、履歴が SETTLE_MS ぶん貯まる前に判定してはならない。tick 1 回ぶん
         *   （20 ミリ秒）の差から傾きを出すと、短期平均が 1 標本の出入りで動くわずかな量が
         *   0.02 で割られて数 秒/秒 に化けてしまう。すると定常な配信でも calm が false へ
         *   振れ続け、measureTrough() が毎回 troughs を捨てるため谷の履歴がまったく貯まらず、
         *   room が永久に NaN のまま＝自動しきい値モードで一度も加速しない、という状態になる。
         *
         * @param {number} mean - 短期窓の平均（補償座標のまま。drift を引く前の値）
         * @param {number} now  - 現在時刻（performance.now() 由来のミリ秒）
         * @returns {boolean} 定常とみなせるなら true
         */
        function steady(mean, now) {
            if (!Number.isFinite(settleAt)) settleAt = now;  // 履歴の起点。reset() 後や標本が途切れた後に引き直す

            levels.push(now, mean);
            levels.trim(now, SETTLE_MS);

            // 履歴が SETTLE_MS ぶん貯まるまでは「判定できない」＝定常ではない、として扱う
            if (now - settleAt < SETTLE_MS) return false;

            const first   = levels.first();
            const last    = levels.last();
            const elapsed = last.at - first.at;              // 実際に手元にある履歴の長さ（ミリ秒）
            if (elapsed <= 0) return false;                  // 0 除算の回避（履歴が 1 点しか無い場合）

            return Math.abs(((last.value - first.value) / elapsed) * 1000) <= SETTLE_SLOPE;
        }

        /**
         * 短期窓の長さ（ミリ秒）を必要に応じて更新して返す。
         *
         * 窓の長さはセグメント長に合わせたい。短すぎると 1 周期を捉えられず、
         * 長すぎると配信状況の変化への追従が遅れるため、アダプタが返す目安値を基準にする。
         * adapter.needs() の呼び出しはサイトによっては重いので、NEEDS_MS 間隔に制限する。
         *
         * @param {number} now - 現在時刻（performance.now() 由来のミリ秒）
         * @returns {number} 短期窓の長さ（ミリ秒）
         */
        function windowFor(now) {
            if (now - needsAt >= NEEDS_MS) {
                needsAt = now;
                const needs = toNum(adapter.needs()); // アダプタ固有の目安バッファ秒数
                if (needs > 0) {
                    needsSec = needs;            // Gain がサイトの時間尺度として参照する
                    windowMs = clamp(needs * 1000, MIN_MS, MAX_MS);
                }
            }
            return windowMs;
        }

        /**
         * 短期窓の標本から 平均・標準偏差・谷 を求める。
         *
         *   trough = avg - RAMP * sd
         *
         * 標本は補償座標（health + D(t)）で入っているので、平均から D(now) を引いて
         * 現在時点の座標へ戻す。標準偏差は定数の足し引きで変わらないため、そのまま使える。
         *
         * 谷を出すには次の 3 つがすべて揃っている必要がある。ひとつでも欠ければ NaN を返して
         * 判断を保留する（NaN はどんな比較でも false になるので、自動的に加速しない側へ倒れる）。
         *
         *   標本数   … MIN_N 以上あるか
         *   充填率   … 窓が COVER の割合まで埋まっているか
         *   定常性   … 水準が動いている最中でないか（steady 参照）
         *
         * @param {number} now - 現在時刻（performance.now() 由来のミリ秒）
         * @returns {{ n: number, avg: number, sd: number, calm: boolean, trough: number }} 短期統計（現在時点の座標）
         */
        function measure(now) {
            const { n, avg, sd } = samples.stats();
            if (n === 0) {
                levels.clear();         // 標本が無いなら水準も追えない。履歴を捨ててやり直す
                settleAt = NaN;         // 起点も引き直す（次の steady() が今の時刻で初期化する）
                return EMPTY;
            }

            const calm   = steady(avg, now);                    // 判定は補償座標のまま行う（drift を引く前の avg を渡す）
            const filled = samples.span() >= windowMs * COVER;   // 窓が十分埋まったか
            const mean   = avg - drift;                          // 補償座標の平均を、現在時点の座標へ引き戻す

            return { n, avg: mean, sd, calm, trough: n >= MIN_N && filled && calm ? mean - RAMP * sd : NaN };
        }

        /**
         * 推定した谷を長期窓へ積み、その平均と標準偏差を求める。
         *
         * 短期窓と同じく補償座標（trough + D(t)）で保存し、読み出すときに D(now) を引く。
         * 長期窓は 5〜30 秒と長く、ドリフトの影響が最も強く出るのがここなので、適用を忘れないこと。
         *
         * 定常でない期間を挟んだら、それ以前の観測は今の状況を代表しないので履歴ごと捨てる。
         * 汚れた谷を 1 つ混ぜるだけで、以降 troughMs のあいだ標準偏差が膨らみ続けるため、
         * 「怪しいものは入れない」ではなく「怪しくなったら全部やり直す」まで踏み込む必要がある。
         *
         * @param {number}  trough - 今回推定された谷（推定できなければ NaN）
         * @param {boolean} calm   - 配信が定常とみなせるか
         * @param {number}  now    - 現在時刻（ミリ秒）
         * @returns {{ troughN: number, troughSpan: number, troughAvg: number, troughSd: number }} 谷の長期統計
         */
        function measureTrough(trough, calm, now) {
            if (!calm) troughs.clear();
            else if (Number.isFinite(trough)) troughs.push(now, trough + drift);

            troughs.trim(now, troughMs);

            const { n, avg, sd } = troughs.stats();
            return {
                troughN: n,
                troughSpan: troughs.span(),     // 履歴が実際に張っている時間（ミリ秒）
                troughAvg: avg - drift,
                troughSd: sd,
            };
        }

        return {
            /**
             * 標本と内部状態をすべて捨てる。
             * 別の配信へ切り替わったときや制御を中断したときに呼び、
             * 古い配信の統計が新しい配信の判断に混ざらないようにする。
             *
             * @returns {void}
             */
            reset() {
                samples.clear();
                troughs.clear();
                levels.clear();
                needsAt  = -Infinity;
                troughMs = AUTO_TUNING[0].troughMs;
                view     = EMPTY;
                drift    = 0;
                driftAt  = NaN;
                settleAt = NaN;
            },

            /**
             * 毎 tick 呼び出して、最新のバッファ残量を記録し統計を更新する。
             *
             * 【sampling を分けている理由】
             *   tick() はタイマーだけでなく timeupdate / progress / waiting でも走る。
             *   なかでも waiting は「バッファが尽きた瞬間」に集中して発火するため、
             *   これを標本に混ぜると分布が谷側へ強く偏り、のこぎり波を一様分布とみなす前提が崩れる。
             *   そこで統計に使う標本は等間隔のタイマー駆動のときだけ採り、
             *   イベント駆動の tick では超過消費 D(t) の積算だけを行う。
             *   D(t) の積算は区間ごとに倍率が一定であれば厳密なので、呼ばれる間隔が不揃いでも正しい。
             *
             * @param {number}  health   - 現在のバッファ残量（秒）。取得できなければ NaN
             * @param {number}  rate     - 前回の tick からこの瞬間まで効いていた再生倍率。NaN なら積算を見送る
             * @param {number}  now      - 現在時刻（performance.now() 由来のミリ秒）
             * @param {boolean} sampling - 統計へ標本を積んでよいか（タイマー駆動なら true）
             * @param {number}  longMs   - 谷を貯める長期窓の長さ（ミリ秒。AUTO_TUNING の troughMs）
             * @returns {void}
             */
            update(health, rate, now, sampling, longMs) {
                // 段階を切り替えた直後は窓の長さも即座に入れ替わる。短くなった場合は
                // 次の trim() が古い谷をまとめて捨てるので、追加の後始末は要らない
                if (Number.isFinite(longMs) && longMs > 0) troughMs = longMs;

                accrue(rate, now);      // 先に D(now) を確定させる。以降の補償はすべてこの値が基準になる
                if (!sampling) return;  // イベント駆動の tick では統計を更新しない（標本の偏りを避ける）

                if (Number.isFinite(health)) samples.push(now, health + drift);

                // windowFor() の呼び出しには windowMs を更新する副作用があるため、必ず先に評価させる
                samples.trim(now, windowFor(now));

                const current = measure(now); // 短期統計（平均・標準偏差・定常性・今回の谷）
                view = { ...current, ...measureTrough(current.trough, current.calm, now) };
            },

            /**
             * 早送りを許可してよい実効的な余裕バッファ量（秒）を返す。
             *
             *   room = troughAvg - troughSd * k
             *
             * 安全余裕係数 k は speedupAuto の段階によって変わるため、呼び出し側から受け取る。
             * 谷の履歴が TROUGH_MIN_MS ぶん貯まるまでは NaN を返す。
             *
             * @param {number} k - 谷のばらつきに対する安全余裕係数（AUTO_TUNING の troughK）
             * @returns {number} 実効余裕バッファ量（秒）。判断できなければ NaN
             */
            room: (k) => (view.troughSpan >= TROUGH_MIN_MS ? view.troughAvg - view.troughSd * k : NaN),

            /**
             * アダプタが返した目安バッファ秒数（セグメント長の目安）。
             *
             * この値の取得は windowFor() が NEEDS_MS 間隔で行っており、ここはその結果を
             * 見せているだけである。Gain は見送りを解除するしきい値の尺度として、tuning() は
             * floor が OFF のときの下限として、それぞれこの値を参照する。
             * 同じ値を 3 か所から別々に取りに行くと、片方だけ間隔が違うといった食い違いが
             * 起きうるので、取得箇所は 1 つに寄せておく。
             *
             * reset() で捨てないのは、これが配信ではなくサイトの性質だからである
             * （配信が変われば次の tick で取り直される）。
             *
             * @returns {number} 目安バッファ秒数（秒）。まだ取得できていなければ NaN
             */
            get needs() { return needsSec; },

            /**
             * 谷の履歴だけを捨てる（短期窓と水準履歴はそのまま残す）。
             *
             * 制御状態が切り替わるとバッファの水準そのものが動き出すため、遷移をまたいだ
             * 谷の履歴は 1 本の系列として扱えない。長期窓（最大 30 秒）の中に遷移前後の
             * 2 つの水準が同居すると、troughSd が本来のばらつきではなく水準の移動量を
             * 測ってしまい、room = troughAvg - troughSd * k が大きく沈む。これが
             * 「加速 → room 枯渇 → 通常速度 → 窓が入れ替わる → また加速」という
             * troughMs と同じ周期の自励振動を生んでいた。
             *
             * @returns {void}
             */
            shift() { troughs.clear(); },

            /**
             * デバッグログ用に、内部の統計値をまとめて取り出す。
             *
             * @returns {Object} 統計値と、現在の短期窓長・長期窓長・超過消費
             */
            snapshot: () => ({ ...view, windowMs, troughMs, drift }),
        };
    })();

    /* ============================================================================================
       【最重要】加速の実効性の検証（Gain）
       --------------------------------------------------------------------------------------------
       ■ 何が問題なのか
         ライブ配信の映像は実時間でしか作られない。つまり手元へ届く速さの上限は 1.0 倍であり、
         これは回線やブラウザの性能とは無関係の、配信という仕組みそのものの制約である。
         先読みの貯金がある間は 1.25 倍で走って遅れを詰められるが、貯金を使い切って
         配信の最先端に追いついた時点で、それ以上詰められる遅れは存在しなくなる。

         ところがそこで倍率を 1.25 のままにしておくと、次のセグメントが届くまでの
         わずかな時間ごとに再生が追い越して止まる。止まっては進み、を繰り返すため
         実効速度は 1.0 倍（ときにそれ以下）へ落ち、得られるものは何も無いのに
         カクつきだけが残る。バッジには 1.25x と出ているのに等倍にしか感じられない、
         という状態はこれである。

       ■ なぜバッファ残量では気づけないのか
         この状態は「枯渇」ではない。止まるたびに読み込みが追いつくので、残量は
         2〜4 秒あたりで安定してしまう。谷の統計から見ると健全そのもので、room は
         margin を上回りつづける。つまり残量をいくら精密に測っても、この状態は
         原理的に検出できない。残量は原因ではなく結果だからである。

       ■ どう検出するか
         倍率は自分で決めた値なので、加速によって何秒ぶん詰められるはずかは分かる。

             要求 = ∫ (rate - 1) dt

         一方、実際に詰められた量は再生位置の進み方から直接測れる。

             実績 = Δ再生位置 - Δ実時間

         この 2 つを短い窓で比べ、実績が要求の半分にも満たなければ、加速は
         機能していないと判断して speedup を見送る。残量・遅延・サイトの実装に
         一切依存しない、結果だけを見る判定である。

       ■ 停止中を除外してはいけない
         Auto の drift 積算は readyState を見て停止中を除外している。あちらは
         「バッファが減っていない区間を消費として数えない」ための処置であり正しい。
         しかしこちらでは逆で、止まっている時間こそが失われている量そのものなので、
         除外すると損失が丸ごと見えなくなる。除くのは一時停止とシークだけでよい。

       ■ 見送りをいつ解くか
         時間切れ（COOL_MS）に加えて、遅延が見送り時点より一定量ぶん増えたら
         即座に解除する。この一定量はサイトの時間尺度に合わせて決める（RECOVER_* を参照）。
         回線の乱れなどで新たに遅れが生まれた場合は、詰めるべき遅れが
         実際に存在するので、待たずに加速へ戻ってよい。
       ============================================================================================ */

    const Gain = (() => {
        /*
           判定に必要な要求量（秒）。時間ではなく秒数で決めているのは、こうすると
           倍率によらず SN 比が一定になるためである。Δ再生位置 の測定誤差は倍率に
           よらずほぼ一定なので、要求量を固定すれば比 got/asked の推定精度も揃う。
        */
        const MIN_ASKED = 1.0;

        /*
           要求に対する実績の割合。これを下回れば無駄と判断する。
           このモジュールの定数の中で、唯一これだけが実測に裏付けを持つ。
           これまでの計測では比がはっきり二極化していた。

             Twitch 平衡状態（100 標本）   EFF 1.026   比 0.10
             Twitch 固定 1.25 倍（46 標本） EFF 1.020   比 0.08
             Twitch 正常 ×3                EFF 1.24    比 0.98〜1.00
             VOD 1.25 倍 ×6                EFF 1.25    比 0.97〜1.00
             YouTube 4 倍                  ―          比 0.68〜0.77

           0.10 以下と 0.68 以上の間が空いており、0.5 はほぼその中央にある。
           上側の余裕（0.18）を下側（0.40）より薄く取っているのは意図的で、
           効いている加速を誤って止めるほうが実害が大きいため。
        */
        const RATIO = 0.5;

        /*
           要求と実績を突き合わせる時間窓の下限（ミリ秒）と、倍率に応じて伸ばすときの余裕。

           窓に貯められる要求量の上限は (rate - 1) × 窓長 である。窓を固定してしまうと
           低い倍率では上限が MIN_ASKED に届かず、どれだけ無駄でも判定が永久に下りない
           （12 秒に固定した場合、1.083 倍未満がこれに当たる。設定の下限は 1.05 倍）。

           そこで MIN_ASKED を必ず貯められる長さを確保する。SPAN_SLACK は、加速が
           連続していない（間に通常速度が挟まる）場合に備えた余裕である。
           BURN_MIN が 0.05 なので窓は最長でも 30 秒にしかならず、上限は要らない。

           BURN_MIN は割る側の下限。設定の下限である 1.05 倍より窓を伸ばさないためであり、
           同時に sanitize() が破損時に返す speedupRate = 1（= 0 除算）への備えでもある。
        */
        const WINDOW_MS  = 12000;
        const SPAN_SLACK = 1.5;
        const BURN_MIN   = 0.05;        // 倍率 1.05（設定の下限）の余分な消費（秒／秒）

        /*
           判定を下すのに必要な最低の観測時間（ミリ秒）。

           要求量だけを条件にすると、高い倍率では窓が短くなりすぎる。4.00 倍なら
           MIN_ASKED は 0.33 秒で貯まるが、その間に独立した観測はほとんど無く、
           通常のセグメント待ちが 1 回挟まっただけで無駄と誤判定しかねない。

           標本は窓の中で複数回の加速をまたいで残るため、1 回の加速が短くても
           数回ぶんを合わせればこの時間には届く。
        */
        const MIN_SPAN_MS = 1500;

        /*
           見送りを自動で解除するまでの時間（ミリ秒）。実測の裏付けは無く、判断で置いている。
           再試行 1 回のコストは MIN_ASKED / (rate - 1) 秒（既定倍率で 4 秒）なので、
           30 秒なら無駄な加速の占有率がおよそ 1 割に収まる、という程度の根拠である。
           実際には後述の遅延増加による再武装が先に効くことが多く、影響は小さい。
        */
        const COOL_MS = 30000;

        /*
           見送り時点からこれだけ遅延が増えたら即座に解除する量を決める係数と範囲。

           ■ なぜ絶対値ではいけないのか
             定常時の遅延はサイトとブラウザで 12 倍も違う（実測）。

               Chrome  / Twitch      5.05s
               Firefox / YouTube     2.55s
               Firefox / Twitch      1.45s
               Firefox / ツイキャス   0.79s
               Chrome  / ツイキャス   0.40s

             ここへ一律の秒数を課すと意味が揃わない。たとえば 0.75 秒なら、Twitch では
             遅延の 15% で反応するのに対しツイキャスでは 95%、つまり「遅延がほぼ倍に
             ならないと再武装しない」ことになる。同じ Twitch でもブラウザによって
             3.5 倍違う（低遅延モードの有無）ため、サイトどころかブラウザ間でも揃わない。

           ■ 何を基準に取るか
             adapter.needs() はサイトが返すセグメント長の目安であり、そのサイトにおける
             遅延の自然な単位そのものである。「セグメント 1/4 個ぶん遅れたら詰め直す価値が
             ある」という尺度に置き換えると、どのサイトでも同じ意味になる。

           ■ 下限と上限の根拠（すべて実測）
             定常時の遅延ノイズは全 6 環境で sd ≤ 0.11、通常の変化量は 0.2 未満だった。
             一方、実際にリバッファが起きた瞬間の変化量は 0.81 と 0.93 で、明確に分離している。
             下限 0.20 はノイズ上限のおよそ 2 倍。

             ただしノイズとは別に、実イベントの無い数十秒周期のゆるやかな揺らぎがあり、
             その振幅は Twitch で 0.35〜0.36 だった。下限を 0.2 まで下げてよいのは
             揺らぎの小さいツイキャス側だけなので、needs() 連動が必要になる。

               Twitch 低遅延  needs=2    → 0.50（揺らぎ 0.36 の上）
               Twitch 標準    needs=4    → 1.00（上限で頭打ち）
               ツイキャス      needs=0.5  → 0.20（下限で底打ち、揺らぎ 0.05 の 4 倍）
        */
        const RECOVER_RATIO = 0.25;
        const RECOVER_MIN   = 0.20;
        const RECOVER_MAX   = 1.00;

        /*
           1 区間として認める最大の経過時間（ミリ秒）。動作条件から決まる。
           tick 間隔は通常 20 ミリ秒だが、制御対象が無いときは 1000 ミリ秒の見張り周期へ
           落ちるため、上限はそれを確実に超えている必要がある。一方でタブの休止や
           スリープ復帰のような長い断絶は区間として数えたくない。その間を取っている。
        */
        const MAX_STEP = 2000;

        const asked = series();         // 加速によって詰められるはずだった秒数
        const got   = series();         // 実際に詰められた秒数（負にもなりうる）

        let at      = NaN;              // 前回の観測時刻（ミリ秒）。NaN なら今回は区間を作らない
        let mark    = NaN;              // 前回の再生位置（秒）
        let idle    = false;            // 加速を見送っているか
        let idleAt  = -Infinity;        // 見送りを始めた時刻（ミリ秒）
        let idleLat = NaN;              // 見送りを始めた時点の遅延（秒）

        /**
         * 時系列窓に入っている値の合計を求める。series は合計を直接持たないので平均から戻す。
         *
         * @param {Object} win - series() が返す時系列窓
         * @returns {number} 合計値。空なら 0
         */
        const total = (win) => { const { n, avg } = win.stats(); return n ? n * avg : 0; };

        /**
         * 要求と実績の履歴を捨てる。判定を下した直後は、その材料を持ち越さない。
         *
         * @returns {void}
         */
        const drop = () => { asked.clear(); got.clear(); };

        return {
            /**
             * すべての観測と見送り状態を初期化する。配信が変わったときや休止時に呼ぶ。
             *
             * @returns {void}
             */
            reset() {
                drop();
                at      = NaN;
                mark    = NaN;
                idle    = false;
                idleAt  = -Infinity;
                idleLat = NaN;
            },

            /** @returns {boolean} 加速を見送るべきなら true */
            get futile() { return idle; },

            /**
             * 毎 tick 呼び出して、要求と実績を積み、必要なら見送りを開始・解除する。
             *
             * @param {HTMLMediaElement} node    - 監視中の <video>
             * @param {number}           rate    - 前回の tick からこの瞬間まで効いていた再生倍率
             * @param {number}           latency - 現在の遅延（秒）。取得できなければ NaN
             * @param {number}           now     - 現在時刻（performance.now() 由来のミリ秒）
             * @returns {void}
             */
            update(node, rate, latency, now) {
                if (node.paused || node.seeking) {
                    // 再生していない区間は測れない。基準点を捨てて次の区間から数え直す
                    at = NaN; mark = NaN;
                } else {
                    const step = now - at;      // 区間の長さ（ミリ秒）。at が NaN なら NaN になる
                    if (step > 0 && step <= MAX_STEP) {
                        const want = ((Number.isFinite(rate) ? rate : 1) - 1) * step / 1000;
                        // 加速していない区間は要求も実績も 0 なので、窓へ入れる意味が無い
                        if (want > 0) {
                            asked.push(now, want);
                            got.push(now, (node.currentTime - mark) - step / 1000);
                        }
                    }
                    at   = now;
                    mark = node.currentTime;
                }

                // 倍率が低いほど窓を伸ばし、MIN_ASKED を貯められない死角を作らない
                const burn     = Math.max(settings.speedupRate - 1, BURN_MIN);
                const windowMs = Math.max(WINDOW_MS, (MIN_ASKED / burn) * 1000 * SPAN_SLACK);

                asked.trim(now, windowMs);
                got.trim(now, windowMs);

                if (idle) {
                    /*
                       新たに遅れが生まれたなら、詰めるべきものがあるので待たずに再挑戦する。

                       しきい値はサイトの時間尺度に合わせる（RECOVER_* の説明を参照）。
                       needs がまだ取れていないときは上限を使う。サイトの尺度が分からない
                       うちは鈍い側へ倒したほうが、無意味な再武装を招かずに済む。
                    */
                    const scale   = Auto.needs * RECOVER_RATIO;    // NaN のこともある
                    const recover = Number.isFinite(scale) ? clamp(scale, RECOVER_MIN, RECOVER_MAX) : RECOVER_MAX;

                    const behind = latency - idleLat >= recover;   // どちらかが NaN なら false になる
                    if (behind || now - idleAt >= COOL_MS) { idle = false; drop(); log('speedup re-armed', { recover }); }
                    return;
                }

                const want = total(asked);  // 加速で詰められるはずだった秒数の合計
                const real = total(got);    // 実際に詰められた秒数の合計

                // どちらの条件も否定形で書いている。値が NaN になったとき、肯定形
                // （want < MIN_ASKED で return）では比較が false になって素通りし、
                // 判断材料が無いまま見送りへ進んでしまう。ここでの安全側は
                // 「見送らない」なので、NaN は必ず return へ落ちなければならない
                if (!(want >= MIN_ASKED)) return;                   // 要求量がまだ足りない
                if (!(asked.span() >= MIN_SPAN_MS)) return;         // 観測時間がまだ短い
                if (!(real < want * RATIO)) return;                 // 効いているので何もしない

                idle    = true;
                idleAt  = now;
                idleLat = latency;
                drop();
                log('speedup is futile; standing down',
                    { asked: want.toFixed(2), got: real.toFixed(2), windowMs: Math.round(windowMs) });
            },

            /**
             * デバッグログ用に、要求・実績・見送り状態を取り出す。
             *
             * @returns {{ asked: number, got: number, futile: boolean }}
             */
            snapshot: () => ({ asked: total(asked), got: total(got), futile: idle }),
        };
    })();

    /* ============================================================================================
       遅延ノイズの計測
       --------------------------------------------------------------------------------------------
       Gain は「見送り時点から遅延が一定量ぶん増えたら再挑戦する」という判断をするが、
       サイトが報告する遅延そのものがどれだけばらつくかを知らないと、その一定量を
       決めようがない。ノイズがしきい値を超えるサイトでは、遅れていないのに
       再武装を繰り返すことになる。

       そこで、Gain が実際に比較している値をそのまま観測して統計を取る。見るべきは 2 つ。

         sd   … 短い窓での標準偏差。遅延そのもののばらつき
         jump … 隣り合う観測どうしの差の最大値。Gain は差分と比較するので、
                こちらがしきい値を超えていれば偽の再武装が起きうる

       観測はデバッグの有無によらず常に回す。値を読むのは report() だけである。
       ============================================================================================ */

    const Noise = (() => {
        const WINDOW_MS = 5000;         // 統計を取る窓（ミリ秒）

        const samples = series();       // 遅延そのもの（秒）

        let prev = NaN;                 // 前回の遅延（秒）
        let jump = 0;                   // 前回の報告以降で最大の変化量（秒）

        return {
            /** すべての観測を捨てる。 @returns {void} */
            reset() { samples.clear(); prev = NaN; jump = 0; },

            /**
             * 遅延を 1 点観測する。有限値でなければ何もしない。
             *
             * @param {number} latency - adapter.status() が返した遅延（秒）
             * @param {number} now     - 現在時刻（performance.now() 由来のミリ秒）
             * @returns {void}
             */
            update(latency, now) {
                if (!Number.isFinite(latency)) { prev = NaN; return; }

                samples.push(now, latency);
                if (Number.isFinite(prev)) jump = Math.max(jump, Math.abs(latency - prev));
                prev = latency;

                samples.trim(now, WINDOW_MS);
            },

            /**
             * デバッグログ用に、遅延の平均・ばらつき・最大変化量を取り出す。
             *
             * jump は「前回この関数を呼んでから」の最大値であり、呼ぶたびに 0 へ戻す。
             * ログは 1 秒ごとなので、1 秒ぶんの最大変化量が毎行に出ることになる。
             * series に添字アクセスが無いため窓ごとの最大は取れないが、
             * 報告間隔ごとの最大が毎行残れば、目視でも最大値は追える。
             *
             * update() は常に回るのにこの関数はデバッグ時しか呼ばれないため、デバッグを
             * 途中で有効にした直後の 1 行だけ、それまでに溜まった最大値が出る。
             * 2 行目からは正しい値になるので、そのままにしてある。
             *
             * @returns {{ avg: number, sd: number, jump: number, n: number }}
             */
            snapshot() {
                const { n, avg, sd } = samples.stats();
                const peak = jump;
                jump = 0;
                return { avg, sd, jump: peak, n };
            },
        };
    })();

    /* ============================================================================================
       デバッグログ出力
       ============================================================================================ */
    let logAt = 0;                      // 次にデバッグログを出してよい時刻（ミリ秒）

    /**
     * 1 秒周期で、内部の統計とバッファ計算の詳細をコンソールへ出力する。
     * デバッグが無効なら即座に戻るため、通常運用では実質的な負荷にならない。
     *
     * @param {number} health - 現在のバッファ残量（秒）
     * @param {number} ahead  - 隙間の先にあるバッファ秒数
     * @param {number} now    - 現在時刻（ミリ秒）
     * @param {Object} tune   - tuning() が解決した制御パラメータ
     * @returns {void}
     */
    function report(health, ahead, now, tune) {
        if (!debugging() || now < logAt) return;
        logAt = now + 1000;

        const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : '----'); // NaN を '----' として見やすく整える
        const { n, avg, sd, windowMs, troughMs, calm, troughN, troughSpan, troughAvg, troughSd, drift } = Auto.snapshot();
        const { auto, troughK, margin, ample } = tune;
        const { asked, got, futile } = Gain.snapshot();
        const lat  = Noise.snapshot();
        const room = Auto.room(troughK);

        log(`${state.padEnd(8)} rate=${fmt(Rate.actual(video))} now=${fmt(health)}+${fmt(ahead)}`
            + ` health${(windowMs / 1000).toFixed(1)}s(avg=${fmt(avg)} sd=${fmt(sd)} n=${String(n).padStart(4)})`
            + ` trough${(troughMs / 1000).toFixed(1)}s(avg=${fmt(troughAvg)}s sd=${fmt(troughSd)}s n=${String(troughN).padStart(4)}`
            + ` span=${(troughSpan / 1000).toFixed(1)}s)`
            + ` room=${fmt(troughAvg)}-${troughK}*${fmt(troughSd)}=${fmt(room)}s/${fmt(margin)}s`
            + ` ample=${fmt(ample)}s auto=${auto} drift=${fmt(drift)}s calm=${calm ? 'yes' : 'NO'}`
            + ` gain=${fmt(got)}/${fmt(asked)}s${futile ? ' FUTILE' : ''}`
            + ` lat=${fmt(lat.avg)}s(sd=${fmt(lat.sd)} jump=${fmt(lat.jump)} n=${String(lat.n).padStart(4)})`);
    }

    /* ============================================================================================
       制御ロジック
       ============================================================================================ */

    /**
     * <video> のバッファ領域（buffered）を解析して、2 種類の秒数を求める。
     *
     * buffered は「読み込み済みの時間区間」の配列で、シークや広告のせいで
     * 途中に隙間（gap）が空くことがある。たとえば [0-30秒] と [45-60秒] のように。
     * 大事なのは「今の再生位置から途切れずに再生し続けられる長さ」なので、
     * 再生位置を含む区間から始めて、アダプタが許す小さな隙間だけは繋げて数える。
     *
     * @returns {{ health: number, ahead: number }}
     *   health : 再生位置から途切れずに再生できるバッファ秒数（取得できなければ NaN）
     *   ahead  : 隙間の向こう側にある未再生バッファの合計秒数（参考表示用）
     */
    function buffer() {
        let ranges;                     // buffered（読み込み済み区間の一覧）
        let at;                         // 現在の再生位置（秒）

        try { ranges = video.buffered; at = video.currentTime; }
        catch { return { health: NaN, ahead: 0 }; } // 要素の初期化直後などは例外が出ることがある

        let health = NaN;               // 連続して再生できる長さ（秒）
        let ahead  = 0;                 // 隙間の先にあるバッファの合計（秒）
        let edge   = NaN;               // ここまで連続していると確定した時刻（秒）

        for (let i = 0; i < ranges.length; i++) {
            const start = ranges.start(i); // この区間の開始時刻（秒）
            const end   = ranges.end(i);   // この区間の終了時刻（秒）

            if (Number.isNaN(health)) {
                // まだ再生位置を含む区間が見つかっていない状態
                // at が start より僅かに手前のときは start から数える。end - at のままだと
                // 実際の区間長より最大 SLACK 秒ぶん過大評価してしまう
                if (at >= start - SLACK && at <= end) { health = end - Math.max(at, start); edge = end; }
                else if (start > at) ahead += end - start;
            } else if (start - edge <= adapter.gap) {
                // 隙間がアダプタの許容範囲内なら、連続したバッファとみなして繋げる
                health += end - start;
                edge = end;
            } else {
                ahead += end - start;
            }
        }

        return { health, ahead };
    }

    /**
     * 現在の speedupAuto 段階と、その段階の制御パラメータ一式を解決する。
     *
     * data-slpstrm はページ側からも書き換えられるため、段階は必ず範囲へ丸め込む。
     * 以前は段階の解決・AUTO_TUNING の参照・下限の計算が別々の関数へ散らばっており、
     * 1 tick のあいだに同じ計算を 4 回繰り返していた。ここで 1 度だけ解いて呼び出し側へ配る。
     *
     * margin は「バッファののこぎり波の谷が、ここより下がってはいけない」という下限（秒）であり、
     * 自動しきい値モードで加速の可否を判断するときの目標値になる。決め方は 3 通り。
     *
     *   floor ON            … floorThreshold + troughMargin。0.15 倍の緊急ブレーキが受け止める高さ
     *   floor OFF + 自動調整 … adapter.needs()。ブレーキが無い以上、谷が 0 を割った瞬間に映像が止まる。
     *                          サイトが返すセグメント長の目安を下限に据え、1 個ぶんを死守する
     *   floor OFF + 手動     … troughMargin。この場合 margin は加速の判定には使われず、
     *                          speedup から降りるときの猶予の基準（tick の bail）としてのみ働く
     *
     * 2 番目を needs にしているのは、従来ここが troughMargin（0.1〜0.5 秒）だけになり、
     * 「ブレーキを切ったほうが下限が低い」という逆転が起きていたためである。
     * needs はまだ取得できていないと NaN になるが、needs > 0 の比較が false になるので、
     * 起動直後の数 tick は自動的に従来式へ落ちる。
     *
     * ample は「谷の推定を待たずに加速してよい」と判断する残量（秒）。margin より必ず高くなるよう取る。
     *
     * margin は早送り倍率を参照しない。倍率が高いほど 1 回の加速は短く終わるが、それは
     * speedup から即座に降りられること（settle 参照）と、加速が実際には効いていない状況を
     * 検出する Gain とで受け止める。
     *
     * @returns {{auto: number, troughK: number, troughMs: number, margin: number, ample: number}}
     */
    function tuning() {
        const auto  = clamp(Math.round(settings.speedupAuto), 0, AUTO_TUNING.length - 1);
        const spec  = AUTO_TUNING[auto];
        const needs = Auto.needs;   // アダプタが返す目安バッファ秒数（秒）。未取得なら NaN

        const margin = settings.floor    ? settings.floorThreshold + spec.troughMargin
                     : auto && needs > 0 ? needs
                     :                     spec.troughMargin;

        // ample は margin より必ず AMPLE_OVER 秒以上高くする。
        // floorThreshold を上限の 10 秒まで上げた場合でも、近道が margin に近づきすぎないようにするため
        return { auto, ...spec, margin, ample: Math.max(AMPLE, margin + AMPLE_OVER) };
    }

    /**
     * バッファ残量から、次に取るべき制御状態を判定する。
     * 上から順に「緊急度の高いもの」を先に判定し、当てはまった時点で確定させる。
     *
     * 早送りの判定は 3 通りある。
     *   近道（段階 1 以上）              … 残量 health が ample を上回るなら、谷の統計を待たずに加速する
     *   自動しきい値モード（段階 1 以上）… Auto が推定した実効余裕 room が、確保したい下限 margin を上回るか
     *   手動モード（段階 0）             … 今この瞬間の残量 health が、ユーザーが設定したしきい値に達したか
     *
     * 手動モードにはヒステリシスも最小滞在時間も掛からない（HYSTERESIS の説明を参照）。
     * 以前は入口へ 0.2 秒を上乗せしていたため、実際の判定線が 入口＝閾値＋0.2 秒 ／ 出口＝閾値
     * となり、「閾値を超えているのに加速しない帯」ができていた。今は閾値ちょうどで加速し、
     * 下回った瞬間に戻る。自動モードでは従来どおり、入口を 0.2 秒高くして安全側へ倒す。
     *
     * ただし Gain が「加速しても進めていない」と判断している間は、3 通りのいずれにも
     * 進ませない。配信の最先端に追いついた状態では、残量がいくらあっても詰められる遅れが
     * 残っていないためである（Gain の説明を参照）。
     *
     * @param {number} health - 現在のバッファ残量（秒）
     * @param {Object} tune   - tuning() が解決した制御パラメータ
     * @returns {string} 'floor' | 'speedup' | 'normal'
     */
    function decide(health, tune) {
        if (!Number.isFinite(health)) return 'normal';      // 測れないなら何もしないのが最も安全

        const { auto, troughK, margin, ample } = tune;

        // 今の状態に「留まる側」へしきい値を HYSTERESIS だけずらす。
        // 境界ちょうどで状態が往復すると、倍率と音量が細かく揺れて映像も音も荒れる
        const stay = (name) => (state === name ? HYSTERESIS : 0);

        if (settings.floor && health <= settings.floorThreshold + stay('floor')) return 'floor';
        if (!settings.speedup)                                                   return 'normal';

        // 加速しても実際には進めていないと分かっている間は、残量に関係なく見送る。
        // 配信の最先端に追いついた状態がこれにあたり、続けても止まってはまた進む
        // 動きが増えるだけで、詰められる遅れはもう残っていない
        if (Gain.futile)                                                         return 'normal';

        // 自動しきい値モードだけの近道。残量そのものが ample を超えていれば、
        // 谷の推定がまだ／もう使えなくても加速して構わない。
        // 降りる側は AMPLE_KEEP ぶん低く取る。ヒステリシス（0.05〜0.1 秒）はのこぎり波の
        // 振幅より桁が小さく、境界上で 1 セグメント周期ごとに往復してしまうため専用の幅を使う
        if (auto && health >= ample - (state === 'speedup' ? AMPLE_KEEP : 0)) return 'speedup';

        // 手動モードは、ユーザーが決めた 1 本の線と生の観測値を比べるだけにする。
        // ヒステリシスも最小滞在時間（tick 参照）も掛けないので、設定した数字ちょうどで加速が
        // 始まり、下回った瞬間に戻る。speedupThreshold に倍率補正を掛けないのも同じ理由で、
        // 高い倍率を使うなら、しきい値も自分で上げてもらう
        if (!auto) return health >= settings.speedupThreshold ? 'speedup' : 'normal';

        // 自動モードの margin は内部の推定値（tuning 参照）なので、入口を HYSTERESIS ぶん
        // 高くして安全側へ倒す。room は判断できないあいだ NaN であり、比較は false になる
        return Auto.room(troughK) >= margin + HYSTERESIS - stay('speedup') ? 'speedup' : 'normal';
    }

    /**
     * 統計だけをすべて捨てる。制御状態やバッジには触れない。
     * シーク直後のように「観測は無効になったが、制御はそのまま続けたい」場面で使う。
     *
     * @returns {void}
     */
    function purge() {
        Auto.reset();
        Gain.reset();
        Noise.reset();
    }

    /**
     * 制御を初期状態へ戻す。統計に加えて、制御状態そのものも捨てる。
     * 別の配信へ切り替わったときと、制御を休止するときの両方で必要になる後始末。
     *
     * stateAt を -Infinity に置いているのは、次の判断を DWELL_MS だけ待たせないため。
     * 最小滞在時間は「同じ配信を見続けている最中の往復」を止めるための仕掛けであり、
     * 配信が変わった直後の最初の 1 回まで縛る理由は無い。
     * 0 ではなく -Infinity なのは、performance.now() が DWELL_MS に満たないうち
     * （ページを開いた直後の 2 秒間）に配信が確定した場合でも確実に通すため。
     *
     * @returns {void}
     */
    function restart() {
        purge();
        state   = 'normal';
        stateAt = -Infinity;
    }

    /**
     * decide() が出した希望の状態を、最小滞在時間（DWELL_MS）の制約に通してから確定させる。
     *
     * ヒステリシスはしきい値を「今の状態に留まる側」へずらす仕組みなので、判定に使う値が
     * その幅より大きく揺れていると効かない。実測では room が 0.5 秒幅で揺れており、
     * 0.2 秒のヒステリシスでは境界を跨ぐ往復を止めきれない。そこで値の側の対策に加えて、
     * 時間の側の制約を掛ける。
     *
     * 待たせるのは「加速を始める」遷移だけであり、それも自動しきい値モードに限る
     * （DWELL_MS の説明を参照）。介入を弱める方向、安全側へ戻る方向、そして手動モードの判断は、
     * 常に即座へ移す。どれも呼び出し側が force で指示する。
     *
     * 【谷の履歴を捨てる条件】
     *   遷移の前後ではバッファの水準が動くため、原則として長期窓は作り直す（Auto.shift 参照）。
     *   ただし「加速を始める」ときだけは残す。理由は 2 つある。
     *
     *   ひとつは、残しても汚れないこと。加速中の水準低下は自分の倍率が原因であり、
     *   drift 補償がきれいに打ち消す。実測でも加速中の troughSd は 0.2 前後に収まっており、
     *   破綻していたのは脱出後の再充填（取り込み速度が上がるため補償の対象外）の側だけだった。
     *
     *   もうひとつは、捨てると成立しなくなること。捨てた直後は room が TROUGH_MIN_MS の
     *   あいだ NaN に戻り、その間 decide() は必ず 'normal' を返す。脱出は待たせないので、
     *   加速へ入った次の tick で即座に降りる空回りになってしまう。
     *
     * @param {string}  want    - decide() が返した希望の状態
     * @param {number}  now     - 現在時刻（performance.now() 由来のミリ秒）
     * @param {boolean} [force] - 最小滞在時間を無視して即座に移すか
     * @returns {void}
     */
    function settle(want, now, force = false) {
        if (want === state) return;

        const opening = state === 'normal' && want === 'speedup';   // 加速を始める遷移
        if (opening && !force && now - stateAt < DWELL_MS) return;

        if (!opening) Auto.shift();
        state   = want;
        stateAt = now;
    }

    /**
     * 現在の状態に対応する目標再生倍率を返す。
     *
     * @returns {number} 再生倍率
     */
    function rateOf() {
        switch (state) {
            case 'speedup': return settings.speedupRate;
            case 'floor':   return FLOOR_RATE;
            default:        return 1;
        }
    }

    /**
     * 音量のダッキング倍率を返す。1.0 なら絞らない。
     * 極端に減速しているときは音が不快に歪むため、floor 状態の間だけ音量を下げる。
     *
     * @returns {number} 音量スケール（0〜1）
     */
    const duckOf = () => (state === 'floor' && settings.duck ? settings.duckVolume / 100 : 1);

    /**
     * レイテンシバッジに表示する文字列を作る。
     * 巻き戻して視聴中（追っかけ再生）のときは遅延の数値に意味が無いので (DVR) と出す。
     *
     * @param {{ latency: number, atHead: boolean }} status - adapter.status() の結果
     * @returns {string} 表示文字列（表示するものが無ければ空文字）
     */
    function latencyText(status) {
        const { latency, atHead } = status;

        if (atHead === false) return DVR;

        // 再生位置が seekable の末尾を僅かに追い越すと負になる。表示だけ 0 で止める
        return Number.isFinite(latency) ? `${Math.max(0, latency).toFixed(2)}s` : '';
    }

    /**
     * バッファ残量バッジに表示する文字列を作る。
     * 隙間の向こうにも 1 秒以上のバッファがあれば「+3s」のように併記する。
     *
     * @param {number} health - 連続再生できるバッファ秒数
     * @param {number} ahead  - 隙間の先にあるバッファ秒数
     * @returns {string} 表示文字列（測れなければ空文字）
     */
    function healthText(health, ahead) {
        if (!Number.isFinite(health)) return '';
        return `${health.toFixed(2)}s${ahead >= 1 ? ` +${Math.round(ahead)}s` : ''}`;
    }

    /**
     * 3 つのバッジをまとめて再描画する。
     * 3 つとも表示 OFF なら、DOM を汚さないようバッジごと取り外す。
     *
     * @param {number} health - 連続再生できるバッファ秒数
     * @param {number} ahead  - 隙間の先にあるバッファ秒数
     * @param {{ latency: number, atHead: boolean }} status - adapter.status() の結果
     * @returns {void}
     */
    function repaint(health, ahead, status) {
        const { showPlaybackRate, showLatency, showHealth } = settings;
        if (!showPlaybackRate && !showLatency && !showHealth) return Badges.detach();

        Badges.show(video, {
            playbackrate: {
                text: showPlaybackRate ? `${Rate.actual(video).toFixed(2)}x` : '',
                color: COLOR[state],    // 状態が一目で分かるよう色を変える
            },
            latency: {
                text: showLatency ? latencyText(status) : '',
                color: COLOR.normal,    // 遅延表示は状態と無関係なので常に白
            },
            health: {
                text: showHealth ? healthText(health, ahead) : '',
                color: COLOR[state],
            },
        });
    }

    /**
     * その <video> が今まさにバッファを消費しているかを判定する。
     *
     * 一時停止中・シーク中・データ待ち（readyState < HAVE_FUTURE_DATA）のあいだは
     * 再生位置が進まないため、バッファは倍率どおりには減らない。
     * この区間まで「倍率ぶん消費した」と数えると超過消費 D(t) が実態からずれ、
     * 補償が過剰になって谷の推定が狂う。
     *
     * @param {HTMLMediaElement} node - 対象要素
     * @returns {boolean} 消費中なら true
     */
    const consuming = (node) => !node.paused && !node.seeking && node.readyState >= 3;

    /**
     * バッファ枯渇によるストール（waiting イベント）をログに記録する。
     *
     * ユーザー自身のシーク操作でも waiting は発生するため、それは除外する
     * （shared/util.js の videoWatcher の onStall と同じ考え方）。また VOD・クリップ・広告など
     * 非ライブ再生時のバッファリングはここでは対象外とし、live フラグ（毎 tick 更新）で絞り込む。
     *
     * @returns {void}
     */
    function stalled() {
        if (!live || !video || video.seeking) return;
        const { health } = buffer();
        log('stall', {
            site:        found[0],
            currentTime: video.currentTime,
            readyState:  video.readyState,
            health,
        });
    }

    /**
     * シーク完了時に統計を作り直す。
     *
     * シークは health を不連続に飛ばすため、窓に古い標本と新しい標本が混在すると
     * 平均も標準偏差も傾きも意味を失う。捨ててやり直すほうが復帰が速い。
     *
     * @returns {void}
     */
    function jump() { purge(); run(false); }

    /**
     * メディアイベント用のリスナー。発火のタイミングが偏っているため統計には使わない。
     *
     * @returns {void}
     */
    function pump() { run(false); }

    /*
       <video> へ張るリスナーの一覧（イベント種別 → ハンドラ）。
       裏タブではタイマーが大きく間引かれるため、これらのイベントでも tick を蹴って
       制御が完全に止まるのを防ぐ。waiting だけは pump と stalled の 2 つを張る。
       seeked だけは pump ではなく jump を張り、統計を作り直させる。
    */
    const MEDIA_HOOKS = [
        ['timeupdate', pump],
        ['progress',   pump],
        ['seeked',     jump],
        ['waiting',    pump],
        ['waiting',    stalled],
    ];

    /**
     * <video> へメディアイベントのリスナーをまとめて登録／解除する。
     *
     * @param {HTMLMediaElement|null} node - 対象要素
     * @param {boolean}               on   - true なら登録、false なら解除
     * @returns {void}
     */
    function drive(node, on) {
        if (!node) return;
        const bind = on ? 'addEventListener' : 'removeEventListener';
        for (const [type, handler] of MEDIA_HOOKS) node[bind](type, handler);
    }

    /**
     * <html data-slpstrm="..."> から最新の設定を読み込む。
     * 属性の文字列が前回と同じなら、JSON の解析ごと省いて負荷を抑える。
     *
     * @returns {void}
     */
    function refresh() {
        const json = document.documentElement?.dataset.slpstrm ?? null;
        if (json === raw) return;

        raw = json;

        let parsed = null;              // JSON.parse の結果（壊れていれば null のまま）
        try { parsed = JSON.parse(json); } catch { parsed = null; }

        settings = sanitize(parsed);
        log('settings', settings);
    }

    /**
     * メイン制御ロジック。20 ミリ秒ごと、およびメディアイベントのたびに実行される。
     *
     * 処理の流れ:
     *   1. 設定を読み直す。無効なら休止して終了
     *   2. 監視すべき <video> を確認し、変わっていたら乗っ取りを解除して付け替える
     *   3. 再生中のメディアを確認し、変わっていたら状態と統計をリセットする
     *   4. ライブでなければ休止して終了（録画・クリップ・広告は制御しない）
     *   5. 制御パラメータを解決し、バッファと遅延を測り、Auto / Gain / Noise を更新する
     *   6. 制御状態を決めて再生速度を適用する
     *   7. 必要ならダッキングを適用する
     *   8. PAINT_MS ごとにバッジを描画する
     *
     * @param {boolean} sampling - 統計へ標本を積んでよいか（等間隔のタイマー駆動なら true）
     * @returns {void}
     */
    function tick(sampling) {
        refresh();
        // 機能 OFF は MutationObserver が確実に拾うので、ここだけは完全停止してよい（sleep 参照）。
        // ただし settings が null なのは「まだ content.js から届いていない」だけかもしれないので、
        // 止めてよいのは enabled: false が明示されているときに限る
        if (!settings?.enabled) return sleep(settings === null ? IDLE_MS : 0);

        const next = adapter.video();   // 今このページで制御すべき <video>
        if (next !== video) {
            Rate.release();
            Volume.release();
            drive(video, false);
            drive(next, true);
            video   = next;
            mediaId = null;             // 中身も変わったはずなので、メディア判定をやり直させる
        }
        if (!video) return sleep();

        const media = adapter.media();  // { id, live }
        live = media.live;              // stalled() がストールをログすべきか判断するのに使う
        if (media.id !== mediaId) {
            mediaId = media.id;
            adapter.reset();
            restart();
            log('media', media);
        }
        if (!media.live) return sleep();    // 録画・クリップ・広告は制御しない

        idling = false;
        schedule(TICK_MS);                  // ← ここで全速へ引き上げる

        const now  = performance.now();
        const tune = tuning();          // 段階と制御パラメータを、この tick 中で 1 度だけ解く
        const { health, ahead } = buffer();
        const stat = adapter.status();  // 遅延と追っかけ判定。Gain・Noise・バッジで使い回す

        // Rate.actual() は物理値を直接読むので、ユーザーがプレイヤー UI で選んだ倍率や
        // 乗っ取りに失敗した場合も含めた「実際に効いていた倍率」が得られる。
        // この行は Rate.apply() より前にあるため、読める値は前回の tick から今まで効いていた倍率になる。
        // 再生位置が進まない状況ではバッファが減らないので、NaN を渡して超過消費の積算を見送らせる
        const rate = Rate.actual(video);
        Auto.update(health, consuming(video) ? rate : NaN, now, sampling, tune.troughMs);

        // Gain は Auto と違い、停止している時間を除外してはならない。
        // 止まっている時間こそが加速で失われている量そのものだからである
        Gain.update(video, rate, stat.latency, now);
        Noise.update(stat.latency, now);

        report(health, ahead, now, tune);

        // ユーザーがプレイヤー UI で 1.0 倍以外の速度を選んでいたら、その意思を尊重して手を引く。
        // Rate.wished() は hijack が記録している「サイトから見えている値」なので、
        // 拡張機能自身が設定した速度と混同することなくユーザー操作だけを検出できる
        if (adapter.respectUserRate && Math.abs(Rate.wished(video) - 1) > NEAR_ONE) {
            Rate.release();
            settle('normal', now, true);    // ユーザーの明示的な操作なので待たせない
        } else {
            const want = decide(health, tune);

            /*
               最小滞在時間を無視する 2 つの場合。

               bail … speedup から降りる判断は、実測の残量が守りたい下限を割っているなら待たせない。
                      room は谷の統計から作る予測だが、health は観測そのものである。後者が割れて
                      いるなら予測が外れたということで、最小滞在時間を守りながら 0.25 s/s の
                      超過消費を続ける理由は無い。健全なときは room >= margin が成り立って
                      speedup に入っているので、この条件が誤って発動することはない。
               手動 … 段階 0 は常に待たせない。最小滞在時間はヒステリシスと同じく room の揺れへの
                      対策であり、手動モードではどちらも掛けない。「閾値に達したら加速、下回ったら
                      戻る」という見たままの動きを優先する（DWELL_MS の説明を参照）。
            */
            const bail = state === 'speedup' && want !== 'speedup' && health < tune.margin;
            settle(want, now, bail || !tune.auto);

            // 通常速度に戻ったなら、乗っ取ったままにせず所有権をサイトへ返す。
            // ただし respectUserRate が false のサイト（Twitch）は、返すと
            // サイト側の自動加速が復活してしまうため、乗っ取ったまま 1.0 を維持する
            if (state === 'normal' && adapter.respectUserRate) Rate.release();
            else Rate.apply(video, rateOf());
        }

        const duck = duckOf();          // 音量スケール（1.0 なら絞らない）
        if (duck < 1) Volume.apply(video, duck);
        else Volume.release();

        if (now < paintAt) return;
        paintAt = now + PAINT_MS;
        repaint(health, ahead, stat);
    }

    /* ============================================================================================
       タイマー制御
       ============================================================================================ */

    /**
     * tick() を例外から守るためのラッパー。
     * サイト側の仕様変更などで tick() が例外を投げても、setInterval のタイマーごと
     * 止まってしまわないよう、ここですべて受け止める。
     *
     * @param {boolean} sampling - 統計へ標本を積んでよいか
     * @returns {void}
     */
    function run(sampling) {
        try { tick(sampling); }
        catch (error) { log('tick failed', error); }
    }

    /**
     * メインループの周期を切り替える。0 を渡すとタイマーごと停止する。
     * 同じ周期なら張り替えないので、毎 tick 呼んでも無駄が出ない。
     *
     * @param {number} ms - 新しい周期（ミリ秒）。0 なら停止
     * @returns {void}
     */
    function schedule(ms) {
        if (ms === period) return;
        if (timer !== null) clearInterval(timer);
        // 統計の標本は等間隔の高速タイマーからだけ採る（見張り中の粗い間隔は混ぜない）
        timer  = ms > 0 ? setInterval(() => run(ms === TICK_MS), ms) : null;
        period = ms;
        log('timer', ms ? `${ms}ms` : 'stopped');
    }

    /**
     * 制御対象が無い（あるいはライブでない）ときの休止処理。
     * 既定ではタイマーを止めず、IDLE_MS の見張り周期へ落とすだけにする。
     *
     * 【タイマーを止めない理由】
     *   復帰の合図をメディアイベントに頼れない場合があるため。YouTube と Twitch は広告を
     *   本編と同じ <video> で再生するので、広告が終わっても要素の再ロードも一時停止も起きず、
     *   loadstart / play / playing のいずれも発火しない。変わるのは ad-showing クラスや
     *   広告 UI といった DOM の状態だけであり、これは待ち受けようが無い。
     *   一方で見張りの費用は小さい。休止中の tick は refresh()（属性文字列の比較）と
     *   adapter.video() / adapter.media() だけで終わり、注入先も manifest の matches により
     *   対象サイトのフレームに限られる（広告の iframe は別オリジンなので入らない）。
     *
     * ms に 0 を渡したときだけ完全停止する。これは機能 OFF 専用で、その場合の復帰の合図は
     * <html data-slpstrm> の書き換え、すなわち MutationObserver が確実に拾う変化に限られる。
     *
     * 後始末（乗っ取りの解除・バッジの撤去・統計の破棄）は休止へ入った最初の 1 回だけ行う。
     * 毎 tick やるのが無駄というだけでなく、再開時に古い配信の標本を残さないためでもある。
     *
     * @param {number} [ms=IDLE_MS] - 休止中の周期（ミリ秒）。0 なら完全停止
     * @returns {void}
     */
    function sleep(ms = IDLE_MS) {
        if (!idling) {
            idling = true;

            Rate.release();
            Volume.release();
            Badges.detach();
            restart();
            paintAt = 0;                // 再開したら待たずにバッジを描き直す
            live    = false;            // 休止中はストールをログしない
        }

        schedule(ms);
        if (ms) return;                 // 見張りを続けるなら <video> は掴んだままでよい

        drive(video, false);    // イベント駆動も切らないと timeupdate で回り続ける
        video = null;           // 次回の tick に掴み直させる
    }

    /**
     * 外部イベントから tick を前倒しで 1 回走らせる。
     * 見張り周期（IDLE_MS）の待ち時間を潰して復帰を速めるためのもので、
     * すでに全速で回っているときは何もしない。連続発火するイベントに繋いでも安全。
     *
     * @returns {void}
     */
    function wake() {
        if (period === TICK_MS) return;
        run(false);
    }

    // 再生開始を見張り周期より速く知るためのイベント。
    // メディアイベントはバブリングしないため、必ずキャプチャ段階で拾う
    for (const type of ['loadstart', 'loadedmetadata', 'durationchange', 'play', 'playing']) {
        document.addEventListener(type, wake, true);
    }

    // 設定変更（content.js による data-slpstrm の書き換え）で復帰する。
    // 機能 OFF のあいだはタイマーごと止まっていて refresh() が走らないため、
    // ここを見張らないと ON にしても起きられない。
    // document_start では <html> がまだ無いことがあるため、その場合は生成後に張り直す
    (function observeSettings() {
        const root = document.documentElement;
        if (root) new MutationObserver(wake).observe(root, { attributes: true, attributeFilter: ['data-slpstrm'] });
        else document.addEventListener('DOMContentLoaded', observeSettings, { once: true });
    })();

    // 裏タブではタイマーが間引かれる。表に戻った瞬間に一度走らせて復帰を早める
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) run(false);
    });

    schedule(IDLE_MS);      // まず見張りモードで起動する（拡張機能の再読み込み時も拾える）
})();
