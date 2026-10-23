// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * common.js — 隔離ワールドと設定画面で使う「共通の道具箱」
 * =============================================================================
 *
 * ■ このファイルは何をするもの？
 *   設定の保存／読み出しと、ログ出力という、content.js と popup.js の両方で
 *   必要になる基本機能をひとまとめにして提供します。
 *   古い版で保存された設定を新しい形へ書き換える「移行」もここで 1 度だけ行います（migrate）。
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
     * 保存されている設定の形の版。移行を 1 つ足すたびに 1 つ増やします。
     *   1 … 1.5.0 まで（保存領域に settingsVersion が無い状態）
     *   2 … 手動モードの閾値が「開始」と「終了」の 2 つになった版
     */
    const SETTINGS_VERSION = 2;

    /**
     * 版 1 → 2 の移行：「加速するバッファ閾値」を自分で変えていたユーザーの動きを保つ。
     *
     * 1.5.0 までの手動モードは、1 本の閾値（speedupThreshold）を境に加速と通常を切り替えていました。
     * 新しい版ではこれが「開始」になり、「終了」（speedupStopThreshold、既定 9 秒）が加わります。
     * 何もしないと、閾値を 20 秒などにしていた人は「終了」が既定の 9 秒になり、
     * 加速が残量 9 秒まで続くように動きが変わってしまいます。
     * そこで、閾値を保存していたサイトに限り、「終了」を「開始」と同じ値にして保存します。
     * 同じ値なら、判定は 1.5.0 までの「1 本の線」と完全に一致します。
     *
     * 閾値を変えていなかった（保存値が無い）サイトには何もせず、新しい既定値（10 秒 / 9 秒）を使います。
     * 「終了」がすでに保存されているサイトにも触れません（ユーザーが自分で決めた値のため）。
     * @param {Record<string, unknown>} settings 保存されている設定データ全体（その場で書き換えます）
     * @returns {boolean} 書き換えたなら true
     */
    function splitManualThreshold(settings) {
        let changed = false;
        for (const bucket of Object.values(settings)) {
            if (!isRecord(bucket)) continue;
            if (!Object.hasOwn(bucket, 'speedupThreshold')) continue;
            if (Object.hasOwn(bucket, 'speedupStopThreshold')) continue;
            bucket.speedupStopThreshold = bucket.speedupThreshold;
            changed = true;
        }
        return changed;
    }

    /**
     * 保存されていた版の値を、移行の判定に使える整数へ直す。
     * 版が記録されていない（1.5.0 まで）・壊れている場合は 1 とみなします。
     * @param {unknown} value 保存されていた settingsVersion
     * @returns {number} 版
     */
    const versionOf = (value) => (Number.isInteger(value) && value >= 1 ? value : 1);

    /**
     * 済んでいない移行を行い、移行済みの版（settingsVersion）を記録する。
     *
     * ■ なぜ background.js ではなくここで行う？
     *   更新直後に必ず動くのは、新しい版のファイルから読み込まれる設定画面とページ側の
     *   スクリプト（このファイル）です。Chromium で 1.5.0 から更新する場面を再現したところ、
     *   バックグラウンドのスクリプトは古い版のまま動き続け、更新時に新しいコードが走るとは
     *   限りませんでした。また background.js にイベントリスナーを足すと、Firefox で
     *   アンインストール時のアンケートの登録が動かなくなります（background.js 冒頭の注意）。
     *   設定を読む側（store.get）が、読んだ版が古いときだけここを呼ぶので、
     *   どの経路で起動しても古い形の設定を使うことがありません。
     *
     * ■ 書き込む直前に読み直す理由
     *   別のタブや設定画面が先に移行を済ませ、ユーザーがすでに値を変えていることがあります。
     *   store.get() で読んだ古い内容のまま書き戻すと、その変更を消してしまうため、
     *   ここで改めて読み、まだ移行されていないときだけ、読んだばかりの内容から書き換えます。
     *
     * ■ 何度呼ばれても安全
     *   版が記録済みなら何もしません。複数のタブで同時に動いても、書き込む内容は同じです。
     *   新しくインストールした場合も、保存値が無いので書き換えずに版だけを記録します。
     *   記録しておかないと、インストール後に「開始」だけを変えたユーザーの設定を、
     *   1.5.0 から来た設定と取り違えて書き換えてしまうためです。
     *   保存値の形式が壊れている場合（settings がオブジェクトでないなど）は書き換えずに版だけを進めます。
     *   読み出す側（shared/schema.js の settingsOf）が既定値で補うためです。
     * @returns {Promise<void>}
     */
    async function migrate() {
        try {
            const { settings, settingsVersion } = await api.storage.local.get(['settings', 'settingsVersion']);
            const from = versionOf(settingsVersion);
            if (from >= SETTINGS_VERSION) return;

            const next = { settingsVersion: SETTINGS_VERSION };
            if (isRecord(settings) && from < 2 && splitManualThreshold(settings)) next.settings = settings;

            // 設定と版を 1 回の書き込みでまとめて保存し、片方だけ書かれた状態が残らないようにします。
            await api.storage.local.set(next);
            log.say('settings migrated', from, '→', SETTINGS_VERSION);
        } catch (error) {
            log.warn('migrate', error);
        }
    }

    /**
     * この画面（またはページ）で始めた移行の Promise。移行は 1 か所につき 1 回で足りるので、
     * 設定画面のように store.get() が同時に何度も呼ばれても、ここで 1 つにまとめます。
     * @type {Promise<void>|null}
     */
    let migration = null;

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
         *
         * 値と一緒に設定の版（settingsVersion）も 1 回の問い合わせで読み、版が古いときだけ
         * 移行（migrate）を済ませてから読み直します。移行済みなら問い合わせは 1 回で済むので、
         * ページを開いてから設定が届くまでの時間は、移行の仕組みが無かったときと変わりません。
         * @param {string} key 'settings' や 'ui' などの保存キー
         * @returns {Promise<Record<string, unknown>>} 保存値。無ければ空オブジェクト
         */
        async get(key) {
            if (!alive()) return {};
            try {
                const got = await api.storage.local.get([key, 'settingsVersion']);
                let value = got[key];
                if (versionOf(got.settingsVersion) < SETTINGS_VERSION) {
                    await (migration ??= migrate());
                    value = (await api.storage.local.get(key))[key];
                }
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
    return { api, store, log, isRecord, alive, ...schema };
})();
