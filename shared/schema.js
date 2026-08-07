// SPDX-License-Identifier: Apache-2.0 OR MIT
/* ================================================================================================
 * shared/schema.js — 設定の「設計図」と値の検証
 *                    （chrome.* などの拡張 API を一切使わない、純粋な JavaScript のみで構成）
 *
 * 【どこから呼ばれるか】
 *   このファイルの中の関数を誰かが直接呼ぶのではなく、以下の 2 か所から「読み込まれて」自動実行される。
 *     1. manifest.json の content_scripts（ISOLATED world）  … common.js / content.js より前
 *     2. popup.html の <script src="shared/schema.js" defer> … common.js / popup.js より前
 *
 *   読み込まれた瞬間に即時実行関数（IIFE）が動き、結果を globalThis.__slipstreamliveSchema へ置いて終わる。
 *   その置き土産を common.js が拾って SLPSTRM へ合流させ、globalThis からは削除する。
 *   したがって利用側は SLPSTRM.KEYS / SLPSTRM.settingsOf(...) のようにアクセスする。
 *
 * 【このファイルが提供するもの】
 *   KEYS       … どんな設定項目があるか（型・範囲・刻み幅・既定値）
 *   SITES      … どのサイトに対応するか（表示名とホスト名判定の正規表現）
 *   fix        … 保存値や入力値を「安全な値」へ丸める
 *   settingsOf … 保存データ全体から、あるサイト向けの実際に使う設定を組み立てる
 *   siteOf     … ホスト名から対応サイトの識別子を割り出す
 *
 * 【MAIN world 側との関係（重要）】
 *   Chrome では同じファイルパスを 2 つの content_scripts エントリに書くと片方が注入されないため、
 *   このファイルは MAIN world 側（inject.js / adapters/*.js）からは参照できない。
 *   そのため MAIN world 側の値検証は inject.js が持つ独自の保険テーブル GUARD_NUMBERS が担当する。
 *   両者の間で守るべき約束はただ一つ。
 *     「GUARD_NUMBERS の [下限, 上限] ⊇ KEYS.range の [min, max]」であること。
 *   ここが破れると、ポップアップで設定できるのに inject.js 側で弾かれる値が生まれてしまう。
 * ================================================================================================ */
(() => {
    'use strict';

    // Firefox かどうかの判定。サイト別の既定値を出し分けるためだけに使う（拡張 API に依存しない方法）
    const FIREFOX = navigator.userAgent.includes('Firefox');

    /**
     * 設計図の不備（既定値の書き忘れなど）を開発者コンソールへ知らせる。
     * common.js の log はこの時点ではまだ存在しないため、console を直接使う。
     *
     * @param {...any} args - console.warn へそのまま渡す引数
     * @returns {void}
     */
    const warn = (...args) => console.warn('[slipstreamlive]', ...args);

    /* ============================================================================================
       設定スキーマ（＝設定項目の一覧表）
       --------------------------------------------------------------------------------------------
       各項目に書けるプロパティ:
         scope … 'common' なら全サイト共通の設定。省略した項目はサイトごとに個別設定できる。
         range … [最小値, 最大値, 刻み幅] の数値設定。省略した項目は ON/OFF のブール値。
         def   … 既定値。共通設定なら値そのもの、サイト別設定ならサイト識別子ごとの値。
         ff    … Firefox でのみ既定値を変えたいサイトだけ上書き指定する。

       しきい値（Threshold）の単位はすべて「秒」。
       再生位置から先読みできているバッファの長さ（health）と比較して制御状態を決める。
       ============================================================================================ */
    const KEYS = {
        // --- 全サイト共通設定 -------------------------------------------------------------------
        enabled:          { scope: 'common', def: true },  // 拡張機能全体のマスタースイッチ
        showPlaybackRate: { scope: 'common', def: false }, // 現在の再生倍率をプレイヤー上に表示するか
        showLatency:      { scope: 'common', def: false }, // 配信の最先端からの遅れ（秒）を表示するか
        showHealth:       { scope: 'common', def: false }, // バッファ残量（秒）を表示するか

        // --- サイト別設定: 早送り（遅れているとき配信に追いつく） -------------------------------
        speedup:          { def: { youtube: true, twitch: true, twitcasting: true } },  // 早送り機能の ON/OFF

        // 早送り時の再生倍率。1.05 倍から 4.00 倍まで 0.05 刻み
        speedupRate:      { range: [1.05, 4, 0.05], def: { youtube: 1.25, twitch: 1.25, twitcasting: 1.25 } },

        // 手動モードのとき、早送りを始めるのに必要なバッファ残量（秒）
        speedupThreshold: { range: [0.1, 100, 0.1], def: { youtube: 10, twitch: 10, twitcasting: 10 } },

        // 上のしきい値を配信の遅延設定に合わせて自動計算するか（inject.js の Auto モジュールが担当）。
        // 0 = 自動調整しない（手動しきい値を使う）
        // 1 = 標準（谷のばらつきに厳しく、境界も広めに取る）
        // 2 = 積極的（遅れをより詰める）
        speedupAuto:      { range: [0, 2, 1], def: { youtube: 1, twitch: 1, twitcasting: 1 } },

        // --- サイト別設定: 下限（枯渇寸前はほぼ停止させて貯め直す） -----------------------------
        floor:            { def: { youtube: true, twitch: true, twitcasting: true } },  // 下限機能の ON/OFF

        // 下限状態へ突入するバッファ残量（秒）。
        floorThreshold: {
            range: [0, 10, 0.1],
            def: { youtube: 0.8, twitch: 2.0, twitcasting: 0.1 },
            ff:  { youtube: 1.0, twitch: 0.5, twitcasting: 0.3 },
        },

        // --- サイト別設定: ダッキング（下限状態のとき音量を絞る） -------------------------------
        duck:             { def: { youtube: true, twitch: true, twitcasting: true } },  // 音量を下げるか

        // 下限状態のときの音量割合（%）。100 なら変化なし、0 なら無音
        duckVolume:       { range: [0, 100, 5], def: { youtube: 30, twitch: 30, twitcasting: 30 } },
    };

    /* ============================================================================================
       SITES — サポート対象サイトの定義
       --------------------------------------------------------------------------------------------
         label … ポップアップ UI のタブに表示する名前
         host  … 現在のホスト名がそのサイトかどうかを判定する正規表現

       正規表現の (^|\.) は「先頭ぴったり」または「サブドメイン区切りのドット」を意味する。
       これにより www.youtube.com は一致し、evil-youtube.com は一致しない。

       ※ MAIN world 側の adapters/*.js も同じ内容の正規表現を持っている。
          world をまたいでコードを共有できない制約のため、意図的に二重管理としている。
          片方だけ直すと動作がずれるので、変更時は必ず両方を直すこと。
       ============================================================================================ */
    const SITES = {
        youtube:     { label: 'YouTube',     host: /(^|\.)(youtube\.com|youtube-nocookie\.com)$/ },
        twitch:      { label: 'Twitch',      host: /(^|\.)twitch\.tv$/ },
        twitcasting: { label: 'TwitCasting', host: /(^|\.)twitcasting\.tv$/ },
    };

    /* ============================================================================================
       検証と既定値の解決
       ============================================================================================ */

    /**
     * その設定キーを保存すべきバケット（保存先の区画）名を返す。
     * 共通設定なら 'common'、サイト別設定ならサイト識別子そのもの。
     *
     * @param {string} site - 対象サイト識別子（'youtube' など）
     * @param {string} key  - 対象設定キー（'speedupRate' など）
     * @returns {string} 保存先バケット名
     */
    const bucketOf = (site, key) => (KEYS[key].scope === 'common' ? 'common' : site);

    /**
     * 設定キーの既定値を取得する。
     * サイト別設定では Firefox 用の上書き（ff）があればそちらを優先する。
     *
     * @param {string} site - 対象サイト識別子
     * @param {string} key  - 対象設定キー
     * @returns {boolean|number} 既定値
     */
    function defaultOf(site, key) {
        const spec = KEYS[key];         // その設定キーの定義（型・範囲・既定値）
        if (spec.scope === 'common') return spec.def;

        // ?? は「左辺が null / undefined のときだけ右辺を使う」演算子。
        // Firefox 用の上書きが無ければ通常の既定値へ落ちる
        const value = (FIREFOX ? spec.ff?.[site] : undefined) ?? spec.def[site];
        if (value !== undefined) return value;

        // ここへ来るのは設計図の書き忘れ。動作は止めず、無難な値で代替する
        warn(`KEYS.${key}.def に ${site} の既定値がありません`);
        return spec.range ? spec.range[0] : false;
    }

    /**
     * 保存値や入力値を「安全に使える値」へ補正する。
     * ブール値の設定は true / false 以外を弾き、数値の設定は次の 3 段階で整える。
     *
     *   1. 刻み幅 step で丸める      … Math.round(num / step) * step
     *   2. [min, max] の範囲に収める … Math.min(Math.max(値, min), max)
     *   3. 浮動小数点の誤差を落とす  … Number(値.toFixed(3))
     *
     * 3 が必要なのは、0.1 刻みの丸めなどで 0.30000000000000004 のような値が生まれるため。
     *
     * @param {string} site  - 対象サイト識別子
     * @param {string} key   - 対象設定キー
     * @param {any}    value - 補正したい値（storage の生値や入力欄の文字列）
     * @returns {boolean|number|undefined} 補正済みの値。未知のキーなら undefined
     */
    function fix(site, key, value) {
        const spec = KEYS[key];                     // その設定キーの定義
        if (!spec) return undefined;                // 設計図に無いキーは扱わない

        const fallback = defaultOf(site, key);      // 値が壊れていたときに使う既定値
        if (!spec.range) return typeof value === 'boolean' ? value : fallback;

        const [min, max, step] = spec.range;        // 数値設定の 最小値 / 最大値 / 刻み幅
        const num = Number.parseFloat(value);       // 文字列で来る場合があるので数値化する
        if (!Number.isFinite(num)) return fallback; // NaN や Infinity なら既定値へ

        return Number(Math.min(Math.max(Math.round(num / step) * step, min), max).toFixed(3));
    }

    /**
     * storage から読み出した保存データ全体から、対象サイトで実際に使う設定オブジェクトを組み立てる。
     * 保存されていないキーは undefined となるが、fix() が既定値へ差し替えるため必ず全キーが埋まる。
     *
     * @param {Object} data - storage の 'settings' キーから読み出した全データ
     * @param {string} site - カレントサイト識別子
     * @returns {Object} 全キーが補正済みの実効設定
     */
    const settingsOf = (data, site) => Object.fromEntries(
        Object.keys(KEYS).map((key) => [key, fix(site, key, data?.[bucketOf(site, key)]?.[key])]));

    /**
     * ホスト名から、対応しているサイトの識別子を割り出す。
     *
     * @param {string} [host=location.hostname] - 判定したいホスト名
     * @returns {string|null} サイト識別子。非対応サイトなら null
     */
    const siteOf = (host = location.hostname) =>
        Object.keys(SITES).find((site) => SITES[site].host.test(host)) ?? null;

    // 置き土産として globalThis へ登録する。common.js がこれを SLPSTRM へ取り込み、直後に削除する。
    // ??= は「まだ値が入っていないときだけ代入する」演算子で、二重読み込み時の上書きを防ぐ
    globalThis.__slipstreamliveSchema ??= { KEYS, SITES, fix, settingsOf, siteOf };
})();
