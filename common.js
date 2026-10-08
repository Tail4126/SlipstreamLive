// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * common.js — 隔離ワールドと設定画面で使う「共通の道具箱」
 * =============================================================================
 *
 * ■ このファイルは何をするもの？
 *   設定の保存／読み出しと、ログ出力という、content.js と popup.js の両方で
 *   必要になる基本機能をひとまとめにして提供します。
 *   直前に読み込まれた shared/schema.js の中身（設定の設計図）もここで合流させます。
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
 *   popup.html からも同じ順番で読み込まれます。
 *   ※ メインワールド側（inject.js とアダプター）では使いません。
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
     * 最新の Chrome（148 以降）と Firefox は、どちらも `browser` という名前で
     * 同じ API を提供しています（Manifest V3 の API はどちらも Promise を返します）。
     */
    const api = globalThis.browser;

    /**
     * ログ出力用のヘルパー（デバッグ用）。
     * - log.on   : 詳細ログを出すかどうかのスイッチ（既定は false ＝ 出さない）
     *              拡張機能側のコンソールで `SLPSTRM.log.on = true` とすると有効になります。
     * - log.say  : 開発中に見たい詳細ログ。log.on が true のときだけ出る
     * - log.warn : 異常時の警告。こちらは常に出る
     *
     * 先頭に必ず [slipstreamlive] を付けることで、コンソールの絞り込みで
     * この拡張機能のログだけを拾えるようにしています。
     */
    const log = {
        on: false,
        say(...args) { if (log.on) console.log('[slipstreamlive]', ...args); },
        warn(...args) { console.warn('[slipstreamlive]', ...args); },
    };

    /**
     * 値が「ふつうのオブジェクト（{ ... }）」かどうかを判定する。
     * null（typeof が 'object' になる）と配列は除外します。
     * 保存領域から読んだ値が壊れていないかの確認に使います。
     * @param {unknown} value 調べたい値
     * @returns {boolean} ふつうのオブジェクトなら true
     */
    const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

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
     * 設定の保存領域（storage.local）を扱いやすくしたラッパー。
     *
     * 素の API との違い：
     *   - 接続が切れていたら何もせず、安全な値を返す
     *   - 例外を握りつぶして警告に変えるので、呼び出し側で try/catch が不要
     *   - 値が無いとき・壊れているとき（オブジェクトでないとき）は空オブジェクト {} を返す
     */
    const store = {
        /**
         * 保存されている値を読み出す。
         *
         * 保存値がオブジェクトでない場合（手での書き換えや破損で文字列・配列などに
         * なっている場合）は {} として扱います。そのまま返すと、呼び出し側が
         * `{ ...value }` で展開したときに "abc" が { 0: 'a', 1: 'b', ... } のような
         * ゴミのキーに化けて、そのまま保存し直されてしまうためです。
         * @param {string} key 'settings' や 'ui' などの保存キー
         * @returns {Promise<Record<string, unknown>>} 保存値。無ければ空オブジェクト
         */
        async get(key) {
            if (!alive()) return {};
            try {
                const value = (await api.storage.local.get(key))[key];
                if (value === undefined) return {};
                if (isRecord(value)) return value;
                log.warn(`storage.get(${key}): 想定外の形式のため無視します`, value);
                return {};
            } catch (error) {
                log.warn(`storage.get(${key})`, error);
                return {};
            }
        },

        /**
         * 値を保存する。
         * @param {string} key 保存キー
         * @param {unknown} value 保存する値
         * @returns {Promise<void>}
         */
        async set(key, value) {
            if (!alive()) return;
            try {
                // `{ [key]: value }` は「変数 key の中身をプロパティ名にする」書き方
                // （計算されたプロパティ名）。key が 'ui' なら { ui: value } になります。
                await api.storage.local.set({ [key]: value });
            } catch (error) {
                log.warn(`storage.set(${key})`, error);
            }
        },
    };

    // 直前に読み込まれた shared/schema.js が置いていった設定スキーマを受け取ります。
    // 受け取ったらすぐ delete して、グローバル空間に一時変数を残さないようにします。
    const schema = globalThis.__slipstreamliveSchema;
    delete globalThis.__slipstreamliveSchema;
    if (!schema) log.warn('shared/schema.js が読み込まれていません');

    // ここで返したオブジェクトが、そのまま globalThis.SLPSTRM になります。
    // `...schema` はスプレッド構文で、schema の中身（KEYS, SITES, fix …）を
    // このオブジェクトの直下に展開する書き方です。
    return { api, store, log, isRecord, ...schema };
})();
