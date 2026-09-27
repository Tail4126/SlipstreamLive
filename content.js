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
 */
(() => {
    'use strict';

    // common.js が用意した道具箱から、必要なものだけ取り出します。
    // `?? {}` を付けているのは、万一 common.js が読み込まれていなくても
    // ここでエラーにならず、次行の判定で静かに終了させるためです。
    const { api, store, log, siteOf, settingsOf } = globalThis.SLPSTRM ?? {};
    if (!siteOf || !settingsOf) return;

    // 今開いているページがどのサイトか判定。対応外なら何もせず終了します。
    const site = siteOf();
    if (!site) return;

    /** @type {string|null} data 属性に書き込む JSON 文字列。まだ未取得なら null */
    let json     = null;
    /** @type {MutationObserver|null} data 属性の消去・改変を監視する見張り役 */
    let observer = null;

    /**
     * 現在の設定 JSON を <html> の data-slpstrm 属性へ書き込む。
     *
     * あわせて MutationObserver（DOM の変化を監視する仕組み）を仕掛けます。
     * ページ側のスクリプトが属性を消したり書き換えたりしても、変化を検知して
     * write() が再び呼ばれ、自動的に正しい値へ書き戻される仕掛けです。
     *
     * 自分で書き込んだ変化でも見張り役は 1 回呼ばれますが、そのときは
     * 「中身が同じなら書かない」判定で素通りするため、無限ループにはなりません。
     * @returns {void}
     */
    function write() {
        const root = document.documentElement; // <html> 要素そのもの
        if (!root || json === null) return;

        // 中身が同じなら書き込まない。無駄な DOM 変更＝無駄な通知を防ぐためです。
        if (root.dataset.slpstrm !== json) root.dataset.slpstrm = json;

        if (!observer) {
            observer = new MutationObserver(write);
            // attributeFilter で「data-slpstrm 属性の変化だけ」に絞り、
            // 関係ない変更で何度も呼ばれないようにしています。
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

    /**
     * 「今このサイトを見ている」ことを記録する。
     *
     * これは設定画面（popup）のための情報です。ユーザーがツールバーの
     * アイコンを押したとき、直前に見ていたサイトのタブを自動で開くために使います。
     * @returns {Promise<void>}
     */
    async function announce() {
        // window.top !== window は「自分が iframe の中にいる」という意味。
        // 埋め込みプレーヤーが誤ってサイトを主張しないよう、最上位のページだけに限定します。
        // （別オリジンの親でも、この比較自体は例外になりません）
        // document.hidden は「タブが裏に隠れている」状態。
        if (window.top !== window || document.hidden) return;

        const ui = await store.get('ui');
        // 値が変わるときだけ書き込む（無駄な保存を避ける）。
        if (ui.seen !== site) await store.set('ui', { ...ui, seen: site });
    }

    // --- ここから下がイベント登録。実際の動作はこれらがきっかけで始まります ---

    // 設定画面で値が変更されたら、その場でページへ反映する。
    api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) apply(changes.settings.newValue ?? {});
    });

    // タブが表示状態に戻ったら「見ているサイト」を記録し直す。
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) announce();
    });

    // このスクリプトは HTML の解析開始直後（document_start）に動きます。
    // 万一その時点で <html> がまだ無かった場合に備え、読み込み段階が進んだ時点で
    // もう一度だけ書き込みを試みます（`once: true` は 1 回で自動解除する指定）。
    document.addEventListener('readystatechange', write, { once: true });

    // 起動時に保存済み設定を読み込む。
    // `json === null` の確認は、待っている間に onChanged が先に発火して
    // 新しい設定を書き込んでいた場合、古い値で上書きしないためのガードです。
    store.get('settings').then((data) => {
        if (json === null) apply(data);
    });

    announce();
})();
