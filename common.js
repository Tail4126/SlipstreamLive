// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * common.js — 拡張機能のどこからでも使う「共通の道具箱」
 * =============================================================================
 *
 * ■ このファイルは何をするもの？
 *   設定の保存/読み出し、ログ出力、多言語テキストの取得といった、
 *   いろいろな場所で必要になる基本機能をひとまとめにして提供します。
 *
 * ■ 使い方
 *   このファイルを読み込むと `globalThis.SLPSTRM` という名前で道具箱が
 *   置かれるので、他のファイル（content.js / popup.js）はこう書いて取り出します。
 *
 *     const { api, store, log } = globalThis.SLPSTRM;
 *
 *   これは「分割代入」という書き方で、オブジェクトの中から必要なものだけを
 *   同じ名前の変数として取り出すショートカットです。
 *
 * ■ 読み込まれる場所
 *   shared/schema.js の直後、content.js の直前（manifest.json で指定）。
 *   popup.html からも読み込まれます。
 *
 * ■ 「拡張コンテキスト」という注意点
 *   拡張機能が更新・再読み込み・削除されると、すでに開いているページに残った
 *   スクリプトは「本体との通信手段を失った幽霊」状態になります。
 *   その状態で API を呼ぶと例外が飛ぶため、下の alive() で毎回確認しています。
 */
globalThis.SLPSTRM = (() => {
    'use strict';

    /**
     * ブラウザ拡張の API 本体。
     * Firefox は `browser`、Chrome / Edge は `chrome` という名前で提供しているため、
     * 存在するほうを選んで、以降はブラウザの違いを意識せずに書けるようにします。
     * （`??` は「左が null / undefined なら右を使う」演算子）
     */
    const api = globalThis.browser ?? globalThis.chrome;

    /**
     * ログ出力用のヘルパー。
     * - log.on   : 通常ログを出すかどうかのスイッチ（既定は false ＝ 出さない）
     * - log.say  : 開発中に見たい詳細ログ。log.on が true のときだけ出る
     * - log.warn : 異常時の警告。こちらは常に出る
     */
    const log = {
        on: false,
        say(...args) { if (log.on) console.log('[slipstreamlive]', ...args); },
        warn(...args) { console.warn('[slipstreamlive]', ...args); },
    };

    /**
     * 拡張機能との接続がまだ生きているかを確認する。
     * 切れているのに API を呼ぶと例外になるので、その手前で止めるための関数です。
     * try/catch で囲んでいるのは、確認する行為自体が例外を投げる場合があるためです。
     * @returns {boolean} 生きていれば true
     */
    const alive = () => {
        try { return Boolean(api?.runtime?.id && api?.storage?.local); }
        catch { return false; }
    };

    /**
     * 設定の保存領域（chrome.storage.local）を扱いやすくしたラッパー。
     *
     * 素の API との違い：
     *   - 接続が切れていたら何もせず、安全な値を返す
     *   - 例外を握りつぶして警告に変えるので、呼び出し側で try/catch が不要
     *   - 値が無いときは undefined ではなく空オブジェクト {} を返す
     */
    const store = {
        alive,

        /**
         * 保存されている値を読み出す。
         * @param {string} key 'settings' や 'ui' などの保存キー
         * @returns {Promise<Record<string, unknown>>} 保存値。無ければ空オブジェクト
         */
        async get(key) {
            if (!alive()) return {};
            try { return (await api.storage.local.get(key))[key] ?? {}; }
            catch (error) { log.warn(`storage.get(${key})`, error); return {}; }
        },

        /**
         * 値を保存する。
         * @param {string} key 保存キー
         * @param {unknown} value 保存する値
         * @returns {Promise<void>}
         */
        async set(key, value) {
            if (!alive()) return;
            // `{ [key]: value }` は「変数 key の中身をプロパティ名にする」書き方
            // （計算されたプロパティ名）。key が 'ui' なら { ui: value } になります。
            try { await api.storage.local.set({ [key]: value }); }
            catch (error) { log.warn(`storage.set(${key})`, error); }
        },
    };

    /**
     * 表示言語に合わせた文言を取り出す。
     * 実際の文章は _locales/<言語>/messages.json に入っていて、
     * ブラウザの言語設定に応じて自動的に切り替わります。
     * @param {string} key messages.json のキー名
     * @returns {string} 対応する文言。見つからなければ空文字
     */
    const msg = (key) => api.i18n.getMessage(key) || '';

    // 直前に読み込まれた shared/schema.js が置いていった設定スキーマを受け取ります。
    // 受け取ったらすぐ delete して、グローバル空間に痕跡を残さないようにします。
    const schema = globalThis.__slipstreamliveSchema;
    delete globalThis.__slipstreamliveSchema;
    if (!schema) log.warn('shared/schema.js が読み込まれていません');

    // ここで返したオブジェクトが、そのまま globalThis.SLPSTRM になります。
    // `...schema` はスプレッド構文で、schema の中身（KEYS, SITES, fix …）を
    // このオブジェクトの直下に展開する書き方です。
    return { api, store, msg, log, ...schema };
})();
