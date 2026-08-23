// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * background.js — バックグラウンドで動く「裏方」スクリプト
 * =============================================================================
 *
 * ■ このファイルは何をするもの？
 *   ページとは無関係に、拡張機能そのものに紐づいて動くスクリプトです。
 *   Manifest V3 では「Service Worker」と呼ばれ、必要なときだけ起動して
 *   仕事が終わると自動で停止します（常駐しません）。
 *
 *   この拡張機能では、やることは 1 つだけです。
 *   「アンインストールされたときに開くページ（アンケート）」を登録します。
 *
 * ■ 動くタイミング
 *   ブラウザ起動時や拡張機能のインストール／更新時に一度だけ呼び出されます。
 */
'use strict';

/**
 * ブラウザ拡張の API 本体。
 * Firefox は `browser`、Chrome / Edge は `chrome` なので、あるほうを使います。
 */
const api = globalThis.browser ?? globalThis.chrome;

/** アンインストール時に開くアンケートフォームの URL。 */
const SURVEY_URL = 'https://forms.gle/d6kbXD7QREL1VSmk9';

/**
 * アンインストール時に開く URL を登録する処理。
 *
 * 全体が (async () => { ... })(); で囲まれているのは、
 * トップレベルで `await` を使うために「即時実行の async 関数」にしているためです。
 *
 * try/catch が必要な理由：この API は一部のブラウザや設定（プライベートウィンドウ等）で
 * 使えないことがあります。失敗しても拡張機能の本来の機能には影響しないので、
 * 警告を出すだけにとどめ、処理を止めないようにしています。
 */
(async () => {
    try { await api.runtime.setUninstallURL(SURVEY_URL); }
    catch (error) { console.warn('[slipstreamlive] setUninstallURL', error); }
})();
