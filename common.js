// SPDX-License-Identifier: Apache-2.0 OR MIT
/* ================================================================================================
 * common.js — ブラウザ拡張 API のラッパー（設定の保存・読み出し・多言語対応・ログ）
 *
 * 【どこから呼ばれるか】
 *   このファイルの関数を誰かが直接呼ぶのではなく、以下の 2 か所から読み込まれて自動実行される。
 *     1. manifest.json の content_scripts（ISOLATED world）… shared/schema.js の後、content.js の前
 *     2. popup.html の <script src="common.js" defer>      … shared/schema.js の後、popup.js の前
 *
 *   読み込まれると globalThis.SLPSTRM という 1 つの窓口オブジェクトを作る。
 *   以降 content.js と popup.js は SLPSTRM だけを見ればよい。
 *
 * 【役割分担】
 *   common.js        … 拡張 API（storage / i18n）のラッパーとロガー。このファイル
 *   shared/schema.js … 設定の設計図（KEYS / SITES）と値の検証。ここで SLPSTRM へ合流させる
 *   content.js       … 設定を <html data-slpstrm="..."> へ書き出す係
 *   adapters/*.js    … 「そのサイトを具体的にどう操作するか」（MAIN world 側の実装）
 *
 * 【読み込まれない場所】
 *   MAIN world（inject.js / adapters/*.js）では chrome.storage 等の拡張 API が使えないため、
 *   このファイルは読み込まれない。MAIN world 側の共通処理は shared/util.js が担当する。
 * ================================================================================================ */
globalThis.SLPSTRM = (() => {
    'use strict';

    // 拡張 API の参照。Firefox は browser、Chrome は chrome という名前で公開しているため両対応にする
    const api = globalThis.browser ?? globalThis.chrome;

    /* ============================================================================================
       デバッグ用ロガー
       --------------------------------------------------------------------------------------------
       通常は静かにしておき、開発者コンソールで SLPSTRM.log.on = true と打ったときだけ
       詳細ログを出す。警告（warn）は問題の見逃しを防ぐため常に出力する。
       ============================================================================================ */
    const log = {
        on: false,                                                          // 詳細ログを出すかどうかのスイッチ
        say(...args) { if (log.on) console.log('[slipstreamlive]', ...args); }, // 詳細ログ（既定では出力しない）
        warn(...args) { console.warn('[slipstreamlive]', ...args); },           // 警告ログ（常に出力する）
    };

    /**
     * 拡張機能のコンテキストがまだ生きているかを調べる。
     * 拡張機能を再読み込み・更新・無効化すると、開いたままのページに残った古いスクリプトからは
     * api.storage 自体が undefined になる（api.runtime.id も消える）。
     * これは異常ではなく「役目を終えた」だけなので、警告を出さず静かに諦める。
     */
    const alive = () => {
        try { return Boolean(api?.runtime?.id && api?.storage?.local); }
        catch { return false; }
    };

    /* ============================================================================================
       ストレージのラッパー
       --------------------------------------------------------------------------------------------
       拡張機能を再読み込み・更新すると、開きっぱなしのページに残った古いスクリプトは
       「コンテキストが失効した」状態になり、API 呼び出しが例外を投げるようになる。
       そのまま投げっぱなしにするとページ側の処理まで巻き込んで壊すため、
       ここで try/catch により握り潰し、常に安全側（空オブジェクトや無操作）へ倒す。
       ============================================================================================ */
    const store = {
        alive,

        /**
         * storage.local から 1 キー分のデータを読み出す。
         *
         * @param {string} key - storage 内のデータキー（'settings' または 'ui'）
         * @returns {Promise<Object>} 取得したオブジェクト。未保存や失敗時は空オブジェクト
         */
        async get(key) {
            if (!alive()) return {};
            try { return (await api.storage.local.get(key))[key] ?? {}; }
            catch (error) { log.warn(`storage.get(${key})`, error); return {}; }
        },

        /**
         * storage.local へ 1 キー分のデータを書き込む。
         * 書き込みが成功すると、同じ拡張機能の全ページで storage.onChanged が発火する。
         *
         * @param {string} key - storage 内のデータキー
         * @param {any} value - 保存する値
         * @returns {Promise<void>}
         */
        async set(key, value) {
            if (!alive()) return;
            try { await api.storage.local.set({ [key]: value }); }
            catch (error) { log.warn(`storage.set(${key})`, error); }
        },
    };

    /**
     * _locales/＊/messages.json から翻訳済みの文言を取り出す。
     * ブラウザの表示言語に合わせて自動的に辞書が選ばれる。
     *
     * @param {string} key - messages.json のメッセージキー（'appName' など）
     * @returns {string} 翻訳文字列。キーが未定義なら空文字
     */
    const msg = (key) => api.i18n.getMessage(key) || '';

    // shared/schema.js が置いた設計図を取り込み、globalThis からは消す。
    // こうすることで利用側（content.js / popup.js）は SLPSTRM 一つだけを参照すればよくなり、
    // ページ側スクリプトから設計図オブジェクトを触られる余地も無くなる
    const schema = globalThis.__slipstreamliveSchema;
    delete globalThis.__slipstreamliveSchema;
    if (!schema) log.warn('shared/schema.js が読み込まれていません');

    // スプレッド構文で schema の中身（KEYS / SITES / fix / settingsOf / siteOf）を平らに展開する
    return { api, store, msg, log, ...schema };
})();
