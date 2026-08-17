// SPDX-License-Identifier: Apache-2.0 OR MIT
/* ================================================================================================
 * background.js — アンインストール時にアンケートを開くためだけの常駐スクリプト
 *
 * 【どこから呼ばれるか】
 *   manifest.json の background エントリ。Chrome ではサービスワーカー、Firefox ではイベントページ
 *   として、インストール・更新・ブラウザ起動のたびに読み込まれ、その場で自動実行される。
 *   ほかのファイルから呼ばれることはなく、公開する関数も持たない。
 *
 * 【何をするか】
 *   runtime.setUninstallURL() へアンケートの URL を登録するだけ。登録内容はブラウザ側に残るので、
 *   拡張機能が削除された時点でブラウザがその URL を新しいタブで開く。削除後に自前のコードは
 *   動けないため、こちらの仕事は登録だけで完結する。何度登録しても副作用は無い。
 *
 * 【プライバシー】
 *   URL は全ユーザー共通の固定値であり、識別子・設定内容・視聴していた配信の情報は一切付けない。
 *   拡張機能自身がどこかへ送信することもない（PRIVACY.md の §3 を参照）。
 * ================================================================================================ */
'use strict';

// 拡張 API の参照。Firefox は browser、Chrome は chrome（common.js と同じ流儀）
const api = globalThis.browser ?? globalThis.chrome;

// アンインストール後に開くアンケートフォーム
const SURVEY_URL = 'https://forms.gle/d6kbXD7QREL1VSmk9';

// 失敗しても本体の動作には影響しないので、警告だけ出して握り潰す。
// await にしているのは、Chrome の同期例外と Firefox の Promise 拒否を 1 か所で受けるため
(async () => {
    try { await api.runtime.setUninstallURL(SURVEY_URL); }
    catch (error) { console.warn('[slipstreamlive] setUninstallURL', error); }
})();
