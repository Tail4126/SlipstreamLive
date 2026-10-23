// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * content.js — 設定をページ側へ橋渡しする「連絡係」
 * =============================================================================
 *
 * ■ 前提知識：2 つの「世界」
 *   拡張機能のスクリプトは、同じページ上でも 2 種類の実行環境で動きます。
 *
 *     1) 隔離ワールド（ISOLATED）… このファイル。
 *        storage などの拡張 API を使えるが、
 *        ページ自身の JavaScript 変数には触れない。
 *
 *     2) メインワールド（MAIN）… inject.js。
 *        ページ本体と同じ場所で動くので YouTube プレーヤーの内部 API を呼べるが、
 *        拡張 API（設定の読み書き）は一切使えない。
 *
 *   つまり「設定を読める側」と「設定を使いたい側」が分断されています。
 *   このファイルは、その 2 つをつなぐ役割を担います。
 *
 * ■ どうやってつなぐ？
 *   両者が唯一共有できるもの、それが「HTML そのもの（DOM）」です。
 *   そこで設定を JSON 文字列にして <html> タグの属性（data-slpstrm）へ書き込み、
 *   inject.js 側はその属性を読む、という方式にしています。
 *
 *     <html data-slpstrm='{"enabled":true,"speedupRate":1.25, ...}'>
 *
 * ■ 処理の流れ
 *   保存領域から設定を読む → サイト用に整える → JSON 化 → data 属性へ書き込む
 *   （設定が変更されたら、その都度書き直す）
 *   拡張機能の無効化・削除・更新で本体との接続が切れたら、「無効」を書き込んで制御を止めさせる
 */
(() => {
    'use strict';

    // common.js が用意した道具箱から、必要なものだけ取り出します。
    // `?? {}` を付けているのは、万一 common.js が読み込まれていなくても
    // ここでエラーにならず、次行の判定で静かに終了させるためです。
    const { api, store, log, alive, siteOf, settingsOf } = globalThis.SLPSTRM ?? {};
    if (!siteOf || !settingsOf) return;

    /**
     * 本体との接続が切れているかを確かめる間隔（ミリ秒）。
     * 拡張機能の無効化・削除・更新から、ページの速度が元に戻るまでの最長の時間になります。
     */
    const LIVENESS_MS = 2000;

    /**
     * 本体との接続が切れたときに、ページ側へ書き込む設定。
     * inject.js はこれを「拡張機能全体が無効」と受け取り、横取りしていた速度と音量を
     * ページへ返して完全に止まります（adapters/tiktok.js のコア数の見せかけも止まります）。
     */
    const STOPPED = JSON.stringify({ enabled: false });

    // 今開いているページがどのサイトか判定。対応外なら何もせず終了します。
    const site = siteOf();
    if (!site) return;

    /** @type {string|null} data 属性に書き込む JSON 文字列。まだ未取得なら null */
    let json    = null;
    /** @type {Element|null} 属性の見張りを仕掛け済みの <html> 要素 */
    let watched = null;
    /** @type {boolean} 本体との接続が切れ、ページ側へ「無効」を伝え終えたか（以後は何も書き込まない） */
    let dead    = false;

    /**
     * DOM の変化を見張る役（MutationObserver）。見張っているのは次の 2 つです。
     *   - <html> の data-slpstrm 属性 … ページ側のスクリプトに消されたり
     *                                    書き換えられたりしたら書き戻すため
     *   - document 直下の子要素       … <html> 要素そのものが差し替えられたとき
     *                                    （document.open() など）に、新しい <html> へ
     *                                    書き込み直して見張りも付け替えるため
     * 変化があると write() が呼ばれます。
     */
    const observer = new MutationObserver(write);
    observer.observe(document, { childList: true });

    /**
     * 現在の設定 JSON を <html> の data-slpstrm 属性へ書き込む。
     *
     * ページ側のスクリプトが属性を消したり書き換えたりしても、見張り役が変化を
     * 検知して write() が再び呼ばれ、自動的に正しい値へ書き戻される仕掛けです。
     *
     * 自分で書き込んだ変化でも見張り役は 1 回呼ばれますが、そのときは
     * 「中身が同じなら書かない」判定で素通りするため、無限ループにはなりません。
     * @returns {void}
     */
    function write() {
        const root = document.documentElement; // <html> 要素そのもの
        if (!root || json === null || dead) return;

        // 中身が同じなら書き込まない。無駄な DOM 変更＝無駄な通知を防ぐためです。
        if (root.dataset.slpstrm !== json) root.dataset.slpstrm = json;

        // <html> が初めて見つかったとき、または差し替えられたときだけ見張りを付け直します。
        // disconnect() で古い <html> の見張りを外してから、document と新しい <html> を見張ります。
        // attributeFilter で「data-slpstrm 属性の変化だけ」に絞り、
        // 関係ない変更で何度も呼ばれないようにしています。
        if (root !== watched) {
            watched = root;
            observer.disconnect();
            observer.observe(document, { childList: true });
            observer.observe(root, { attributes: true, attributeFilter: ['data-slpstrm'] });
        }
    }

    /**
     * 保存データを受け取り、このサイト用に整えてから書き込む。
     * @param {Record<string, unknown>} data storage から読んだ生の設定データ
     * @returns {void}
     */
    function apply(data) {
        json = JSON.stringify(settingsOf(data, site));
        log.say('settings', site, json);
        write();
    }

    // --- ここから下がイベント登録。実際の動作はこれらがきっかけで始まります ---

    // 設定画面で値が変更されたら、その場でページへ反映する。
    api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) apply(changes.settings.newValue);
    });

    // 起動時に保存済み設定を読み込む。
    // `json === null` の確認は、待っている間に onChanged が先に発火して
    // 新しい設定を書き込んでいた場合、古い値で上書きしないためのガードです。
    store.get('settings').then((data) => {
        if (json === null) apply(data);
    });

    /**
     * 本体との接続が切れたら、ページ側の制御を止める。
     *
     * ■ なぜ必要？
     *   拡張機能が無効化・削除・更新されると、このスクリプトは本体との接続を失います。
     *   ところがページ側の inject.js はページ自身のスクリプトとして動いているため、
     *   最後に受け取った設定のまま、ページを再読み込みするまで速度を変え続けます。
     *   設定画面で全体をオフにしても、もうこのタブには届きません。
     *   （Chromium で拡張機能を再読み込みして確かめたところ、1.25 倍のまま動き続けました）
     *   そこで接続が切れたことに気付いたら、「無効」の設定を書き込んで手を引かせます。
     *   更新の場合も、新しい版はページを再読み込みしたときから動きます。
     *
     * ■ 見張りを止める理由
     *   属性の見張り役は、ページに属性を書き換えられると自分の設定を書き戻します。
     *   接続が切れた後もそれを続けると、古い設定を守り続けてしまうため、先に外します。
     *
     * ■ Firefox では
     *   拡張機能が無効化・削除されると、このスクリプトはその場で取り除かれ、ここも動きません。
     *   更新のときは、新しい版のこのスクリプトが開いているタブへ読み込まれ、設定を書き直します。
     */
    const liveness = setInterval(() => {
        if (alive()) return;
        clearInterval(liveness);
        observer.disconnect();
        dead = true;
        const root = document.documentElement;
        if (root && root.dataset.slpstrm !== STOPPED) root.dataset.slpstrm = STOPPED;
    }, LIVENESS_MS);
})();
