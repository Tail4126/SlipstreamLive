// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * shared/schema.js — 「設定の設計図（スキーマ）」を定義するファイル
 * =============================================================================
 *
 * ■ このファイルは何をするもの？
 *   この拡張機能には「加速する速度」「下限しきい値」などたくさんの設定項目が
 *   あります。それらの
 *     - どんな名前のキーがあるか
 *     - 初期値（既定値）はいくつか
 *     - 入力できる最小値・最大値・刻み幅はいくつか
 *     - サイトごとに違う値を持つのか、全サイト共通なのか
 *   といった「仕様そのもの」を、このファイル 1 か所にまとめています。
 *
 * ■ なぜ 1 か所にまとめるの？
 *   設定画面（popup.js）と、ページへ設定を渡す処理（content.js）は
 *   別のファイルですが、両方が同じルールを知っていないと食い違いが起きます。
 *   「既定値を変えたいときはこのファイルだけ直せばよい」状態を作るのが目的です。
 *
 * ■ 読み込まれる場所
 *   manifest.json の content_scripts で、common.js より先に読み込まれます。
 *   また popup.html からも同じ順番で読み込まれます。
 *
 * ■ 全体が (() => { ... })(); で囲まれている理由
 *   これは IIFE（即時実行関数式）と呼ばれる書き方で、「定義した瞬間に実行する
 *   使い捨ての関数」です。中で宣言した変数（FIREFOX や SITES など）が
 *   同じ環境で動く他のファイルの変数と衝突しないよう、カプセル化するために使います。
 */
(() => {
    // 'use strict' は「厳格モード」の宣言。うっかりミス（変数の宣言忘れなど）を
    // エラーとして知らせてくれるので、付けておくのが安全です。
    'use strict';

    /**
     * 実行中のブラウザが Firefox かどうか。
     * Firefox は動画バッファの挙動が Chrome と少し違うため、
     * 一部の既定値だけ Firefox 用に差し替えます（後述の `ff` プロパティ）。
     *
     * 判定には拡張機能自身の URL の形式を使います（Firefox は moz-extension://、
     * Chrome は chrome-extension://）。User-Agent 文字列は、ブラウザの設定や
     * 偽装用の拡張機能で書き換えられることがあり、当てにならないためです。
     * このファイルは拡張機能の API が使える場所（content.js と設定画面）でしか読み込まれません。
     * @type {boolean}
     */
    const FIREFOX = globalThis.browser?.runtime?.getURL?.('').startsWith('moz-extension:') === true;

    /**
     * 警告ログを出すための小さなヘルパー。
     * 先頭に必ず [slipstreamlive] を付けることで、
     * ブラウザのコンソールで自分の拡張機能のログだけを絞り込めるようにしています。
     * @param {...unknown} args console.warn にそのまま渡す値
     * @returns {void}
     */
    const warn = (...args) => console.warn('[slipstreamlive]', ...args);

    /**
     * 対応サイトの一覧。
     * - label: 設定画面のタブに表示する名前
     * - host : そのサイトかどうかを判定する正規表現（ホスト名と照合する）
     *
     * 正規表現 `/(^|\.)twitch\.tv$/` の意味：
     *   `(^|\.)`     … 先頭、または「.」の直後（＝サブドメインを許可）
     *   `twitch\.tv` … 文字としての "twitch.tv"（`\.` は「.」そのもの）
     *   `$`          … ここで文字列が終わる
     *   → "twitch.tv" と "player.twitch.tv" は一致し、"nottwitch.tv" は一致しません。
     * @type {Record<string, { label: string, host: RegExp }>}
     */
    const SITES = {
        youtube:     { label: 'YouTube',     host: /(^|\.)(youtube\.com|youtube-nocookie\.com)$/ },
        twitch:      { label: 'Twitch',      host: /(^|\.)twitch\.tv$/ },
        twitcasting: { label: 'TwitCasting', host: /(^|\.)twitcasting\.tv$/ },
    };

    /** 対応サイト ID の一覧（['youtube', 'twitch', 'twitcasting']）。何度も使うので 1 度だけ作ります。 */
    const SITE_IDS = Object.keys(SITES);

    /**
     * 「全サイトに同じ既定値を配る」ためのヘルパー。
     * 例: all(true) → { youtube: true, twitch: true, twitcasting: true }
     *
     * Object.fromEntries は [キー, 値] の配列をオブジェクトに変換する関数です。
     * SITES から鍵を起こすので、対応サイトを増やしても書き足しが要りません。
     * @param {unknown} value 全サイトに配りたい値
     * @returns {Record<string, unknown>} サイト ID をキーにしたオブジェクト
     */
    const all = (value) => Object.fromEntries(SITE_IDS.map((site) => [site, value]));

    /**
     * 設定項目の一覧（このファイルの心臓部）。
     *
     * 各項目が持てるプロパティ：
     *   scope : 'common' なら全サイト共通の設定。省略時はサイトごとに個別の値を持つ。
     *   def   : 既定値。共通設定ならそのままの値、サイト別ならサイト ID をキーにしたオブジェクト。
     *   range : [最小値, 最大値, 刻み幅]。これがある項目は数値、無い項目は ON/OFF（真偽値）。
     *   ff    : Firefox のときだけ def を上書きする値。
     *
     * 各項目の意味：
     *   enabled          … 拡張機能全体の ON/OFF
     *   showPlaybackRate … 再生速度バッジを表示するか
     *   showLatency      … 遅延バッジを表示するか
     *   showHealth       … バッファ残量バッジを表示するか
     *   speedup          … 追いつくための「加速」機能を使うか
     *   speedupRate      … 加速時の再生速度（1.25 = 1.25 倍速）
     *   speedupThreshold … 手動モードのとき、何秒ぶん溜まっていたら加速してよいか
     *   speedupAuto      … 自動しきい値の積極度（0=オフ / 1=安定 / 2=標準 / 3=積極的）
     *   floor            … バッファ切れ寸前に超低速へ落とす「下限」機能を使うか
     *   floorThreshold   … 残量が何秒を切ったら下限モードに入るか
     *   duck             … 下限モード中に音量を下げるか
     *   duckVolume       … 下げたときの音量（％）
     *   premiere         … YouTube のプレミア公開でも動作させるか
     *   recover          … Twitch のプレイヤーがエラーで止まったとき、自動で復帰させるか
     * @type {Record<string, { scope?: string, def: unknown, range?: number[], ff?: Record<string, number> }>}
     */
    const KEYS = {
        // --- 全サイト共通の設定（scope: 'common'）------------------------------
        enabled:          { scope: 'common', def: true },
        showPlaybackRate: { scope: 'common', def: false },
        showLatency:      { scope: 'common', def: false },
        showHealth:       { scope: 'common', def: false },

        // --- サイトごとに個別に保存される設定 ----------------------------------
        speedup:          { def: all(true) },
        speedupRate:      { range: [1.05, 4, 0.05], def: all(1.25) },
        speedupThreshold: { range: [0.1, 100, 0.1], def: all(10) },
        speedupAuto:      { range: [0, 3, 1], def: all(2) },
        floor:            { def: all(true) },

        // floorThreshold だけはサイトごとに最適値が違うため、個別に既定値を持たせています。
        // さらに Firefox の Twitch はバッファの読み取り方が異なるので ff で上書きします。
        floorThreshold: {
            range: [0, 10, 0.1],
            def: { youtube: 0.8, twitch: 2.0, twitcasting: 0.3 },
            ff:  { twitch: 0.5 },
        },

        duck:             { def: all(true) },
        duckVolume:       { range: [0, 100, 5], def: all(30) },
        premiere:         { def: all(false) },

        // recover は Twitch のアダプターにしか実装が無いため、他サイトは既定 OFF のまま置きます。
        // （heal() を持たないサイトでは、ON にしても何も起きません。）
        recover:          { def: { youtube: false, twitch: true, twitcasting: false } },
    };

    /** 設定キーの一覧。settingsOf() が呼ばれるたびに作り直さないよう、1 度だけ作ります。 */
    const KEY_NAMES = Object.keys(KEYS);

    /**
     * その設定キーを「どの保存先（バケット）」に入れるかを返す。
     * 共通設定なら 'common'、サイト別ならサイト ID そのものが保存先になります。
     *
     * 保存されるデータのイメージ：
     *   { common: { enabled: true }, youtube: { speedupRate: 1.25 }, twitch: { ... } }
     * @param {string} site サイト ID（'youtube' など）
     * @param {string} key 設定キー（'enabled' など）
     * @returns {string} 保存先の名前
     */
    const bucketOf = (site, key) => (KEYS[key].scope === 'common' ? 'common' : site);

    /**
     * 指定サイトにおける、その設定キーの既定値を求める。
     * Firefox 用の上書き（ff）があればそれを優先します。
     * @param {string} site サイト ID
     * @param {string} key 設定キー
     * @returns {number|boolean} 既定値
     */
    function defaultOf(site, key) {
        const spec = KEYS[key];

        // 共通設定は def がそのまま既定値。
        if (spec.scope === 'common') return spec.def;

        // Firefox 用の値があればそれを、無ければ通常の既定値を採用します。
        const value = (FIREFOX ? spec.ff?.[site] : undefined) ?? spec.def[site];
        if (value !== undefined) return value;

        // ここに来るのは KEYS の定義漏れ（＝プログラム側のバグ）なので、
        // 黙って進まず警告を出したうえで、無難な値にフォールバックします。
        warn(`KEYS.${key}.def に ${site} の既定値がありません`);
        return spec.range ? spec.range[0] : false;
    }

    /**
     * 保存されている値を「安全に使える正しい値」に整える。
     *
     * 保存データは手で書き換えられたり、壊れていたりする可能性があります。
     * また設定画面の入力欄の値は文字列で届きます。そのままだと NaN や範囲外の値で
     * 誤動作するので、ここで必ず通してから使います（いわゆるサニタイズ処理）。
     *
     * 数値の場合の処理：刻み幅に丸める → 最小・最大に収める → 小数誤差を整える
     * @param {string} site サイト ID
     * @param {string} key 設定キー
     * @param {unknown} value 保存されていた生の値
     * @returns {number|boolean|undefined} 整えた値。未知のキーなら undefined
     */
    function fix(site, key, value) {
        // 知らないキーは扱わない。
        // `KEYS[key]` だけで判定すると、'toString' や 'constructor' のような
        // 全オブジェクト共通の名前まで「定義あり」と誤認してしまうため、
        // KEYS 自身が持つキーかどうかを Object.hasOwn で確かめます。
        if (!Object.hasOwn(KEYS, key)) return undefined;
        const spec = KEYS[key];

        const fallback = defaultOf(site, key);

        // range が無い＝ON/OFF 項目。真偽値でなければ既定値に戻します。
        if (!spec.range) return typeof value === 'boolean' ? value : fallback;

        // ここからは数値項目の処理。
        const [min, max, step] = spec.range;
        const num = Number.parseFloat(value);

        // 数値に変換できない（空文字や文字列など）なら既定値へ。
        if (!Number.isFinite(num)) return fallback;

        // 1) Math.round(num / step) * step … 刻み幅の倍数に丸める
        // 2) Math.min / Math.max          … 最小値〜最大値の範囲に収める
        // 3) toFixed(3) + Number()        … 0.30000000000000004 のような
        //                                   浮動小数点の誤差を消して数値に戻す
        return Number(Math.min(Math.max(Math.round(num / step) * step, min), max).toFixed(3));
    }

    /**
     * 保存データ全体から、「あるサイト向けの完全な設定オブジェクト」を組み立てる。
     *
     * 未保存の項目は既定値で、壊れた項目は fix() で補正された状態になるので、
     * 受け取った側は「必ず全キーが正しい値で入っている」前提で使えます。
     * @param {Record<string, Record<string, unknown>>|null|undefined} data storage に入っている生データ
     * @param {string} site サイト ID
     * @returns {Record<string, number|boolean>} そのサイト用に整えた設定一式
     */
    const settingsOf = (data, site) => Object.fromEntries(
        KEY_NAMES.map((key) => [key, fix(site, key, data?.[bucketOf(site, key)]?.[key])]));

    /**
     * ホスト名から、対応サイトのどれに当たるかを判定する。
     * @param {string} [host=location.hostname] 判定したいホスト名
     * @returns {string|null} サイト ID。対応外なら null
     */
    const siteOf = (host = location.hostname) =>
        SITE_IDS.find((site) => SITES[site].host.test(host)) ?? null;

    // 組み立てた道具一式を、いったんグローバルの一時変数に置きます。
    // この直後に読み込まれる common.js がこれを受け取り、変数ごと削除します。
    // `??=` は「左が null / undefined のときだけ代入する」演算子で、
    // 二重読み込み時に上書きしてしまうのを防いでいます。
    globalThis.__slipstreamliveSchema ??= { KEYS, SITES, fix, settingsOf, siteOf };
})();
