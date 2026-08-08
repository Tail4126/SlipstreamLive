# Contributing to Slipstream Live

🌐 English | [日本語](#日本語)

Thanks for the interest. This is a one-person project, so reading this first will save us both some time.

## Licensing of contributions

**Unless you say otherwise, anything you submit for inclusion here — as defined under Apache-2.0 — gets dual licensed as Apache-2.0 OR MIT, no extra terms attached.**

Opening a PR means you're confirming you have the right to submit that code under those terms. No CLA to sign.

Every new source file needs an SPDX header on line one:

| File type | Header |
| :--- | :--- |
| `.js` | `// SPDX-License-Identifier: Apache-2.0 OR MIT` |
| `.css` | `/* SPDX-License-Identifier: Apache-2.0 OR MIT */` |
| `.html` | `<!-- SPDX-License-Identifier: Apache-2.0 OR MIT -->` |

JSON files (`manifest.json`, `_locales/*/messages.json`) don't need one — a comment would break them.

## Ground rules

These aren't preferences, they're hard constraints. A PR that breaks one of these can't be merged as-is.

* **No network requests, period.** PRIVACY.md promises the extension never talks to a server. No `fetch`, no `XMLHttpRequest`, no remote fonts, no CDN links, no analytics, no telemetry.
* **No dependencies, no build step.** The repo *is* the extension — clone it and load it unpacked, that's it. No npm, no bundler, no transpiler.
* **No new permissions** beyond `storage` and `activeTab` without discussing it in an issue first.
* **Manifest V3 only.** Chrome 128+ / Firefox 140.0+ (Firefox for Android 142.0+).
* **Live playback only.** VODs, clips, and ad breaks stay untouched.

## Before writing code

Open an issue first for anything beyond a typo or an obvious bug fix — especially new settings, new sites, or default changes. Agreeing on the shape of something before it's written beats rejecting a finished PR.

## Development setup

Nothing to install.

* **Chromium:** `chrome://extensions` → Developer mode → **Load unpacked** → pick the repo folder.
* **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `manifest.json`.

For debug output, run this in the **page** console — not the extension's:

```js
window.__slipstreamliveDebug = true;
```

Once a second you'll get the current mode, the real playback rate, buffer health, short-term and trough stats, the `room` formula, the accumulated excess consumption `drift`, and the stationarity verdict `calm`.

To preview a UI language without touching your browser settings, open the settings page with a query string — e.g. `popup.html?locale=de`.

## Adding a site

Write one adapter exposing `video()` / `media()` / `status()` / `needs()` / `root()` / `host()` / `reset()`, plus `respectUserRate` / `gap` / `badgeClass` / `badgeStyle`. Register it, then add matching entries to `SITES` in `shared/schema.js` and to `manifest.json`. `inject.js` shouldn't need any changes.

Include the reasoning behind any site-specific defaults you pick, especially thresholds — those numbers end up in the README tables.

## Adding or fixing a translation

Start from `_locales/en/messages.json`. Translate only the `message` values, leave keys and any `__MSG_*__` placeholders alone. All nine locales need to carry the same key set.

## Things that have to change together

Some facts live in more than one file. Change only one and the project starts contradicting itself.

| If you change… | Also update… |
| :--- | :--- |
| A control mode, or a badge colour | `inject.js` (`COLOR` and the control states) · `_locales/*/messages.json` (`showPlaybackRateDesc`) · the mode tables in `README.md` / `README.ja.md` · `CHANGELOG.md` |
| A setting, its range, or a default | `shared/schema.js` · the settings tables in `README.md` / `README.ja.md` · the descriptions in `_locales/*/messages.json` |
| What gets stored, or which permissions are used | `PRIVACY.md` — the body **and** the "Last updated" date, in the same commit |

## Pull requests

* One logical change per PR.
* Add an entry under `## [未リリース]` in `CHANGELOG.md`, using the existing headings (`追加` / `変更` / `非推奨` / `削除` / `修正` / `セキュリティ`). English is fine for the entries.
* Say which browsers and which of the three sites you actually tested on. "Chrome only" is a fine answer — just say so.
* Match the surrounding style: plain modern JavaScript, no framework, no clever abstractions for their own sake.

## Security

Don't open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md) for the private reporting process.

---

<a name="日本語"></a>

# 日本語

興味を持ってもらえて嬉しいです。個人でひとりで回している小さなプロジェクトなので、お互い時間を無駄にしないためにも、まずこれを読んでおいてください。

## 貢献のライセンス

**あなたが明示的に別段の指定をしない限り、本作品への取り込みを目的として意図的に提出されたいかなる貢献（Contribution）も、Apache-2.0 ライセンスでの定義に従い、追加の条項や条件なしに Apache-2.0 OR MIT のデュアルライセンスが適用されるものとします。**

プルリクエストを送った時点で、そのコードを上記の条件で提出する権利を持っていることを表明したとみなします。CLA への署名は不要です。

新しいソースファイルには、1行目に SPDX 識別子を入れてください。

| 種類 | 記載する行 |
| :--- | :--- |
| `.js` | `// SPDX-License-Identifier: Apache-2.0 OR MIT` |
| `.css` | `/* SPDX-License-Identifier: Apache-2.0 OR MIT */` |
| `.html` | `<!-- SPDX-License-Identifier: Apache-2.0 OR MIT -->` |

JSON ファイル（`manifest.json`、`_locales/*/messages.json`）は対象外です。コメントを入れると JSON として壊れるので。

## 守ってほしい前提

これは好みの話じゃなく制約です。ここに引っかかるプルリクエストは、そのままではマージできません。

* **外部通信は一切なし。** PRIVACY.md で「どのサーバーとも通信しない」とはっきり書いています。`fetch`、`XMLHttpRequest`、外部フォント、CDN リンク、アクセス解析、テレメトリ、どれも禁止です。
* **依存もビルド工程もなし。** リポジトリがそのまま拡張機能です。clone したものをそのまま「パッケージ化されていない拡張機能を読み込む」で使えます。npm・バンドラ・トランスパイラは入れません。
* **`storage` と `activeTab` 以外の権限は追加しません。** 必要になったら、まず Issue で相談してください。
* **Manifest V3 のみ。** Chrome 128 以降 / Firefox 140.0 以降（Firefox for Android は 142.0 以降）。
* **ライブ再生のみを制御。** VOD・クリップ・広告には触りません。

## コードを書く前に

誤字修正や明らかなバグ修正以外は、先に Issue を立ててください。特に設定項目の追加、対応サイトの追加、既定値の変更あたりは要相談です。書く前に方向性をすり合わせたほうが、出来上がったプルリクエストを却下するよりずっと楽なので。

## 開発環境

インストールするものはありません。

* **Chromium 系:** `chrome://extensions` → デベロッパーモード → **パッケージ化されていない拡張機能を読み込む** → リポジトリのフォルダを選択
* **Firefox:** `about:debugging#/runtime/this-firefox` → **一時的なアドオンを読み込む…** → `manifest.json` を選択

デバッグ出力を見たいときは、拡張機能側じゃなくページ側のコンソールで次を実行してください。

```js
window.__slipstreamliveDebug = true;
```

1秒ごとに、現在のモード・実際の再生速度・バッファ残量・短期統計と谷の統計・`room` の計算式・超過消費の累積 `drift`・定常判定 `calm` が出力されます。

ブラウザの言語設定を変えずに各言語の表示を確認したいときは、設定画面を `popup.html?locale=de` のようにクエリ付きで開けます。

## サイトを追加する

`video()` / `media()` / `status()` / `needs()` / `root()` / `host()` / `reset()` と、`respectUserRate` / `gap` / `badgeClass` / `badgeStyle` を公開するアダプタを1つ書いてください。登録したら、`shared/schema.js` の `SITES` と `manifest.json` にも対応する項目を追加します。`inject.js` は触らずに済むはずです。

サイトごとの既定値、特にしきい値を決めたときは、その根拠も書いてください。README の表に載る数字になるので。

## 翻訳の追加・修正

起点は `_locales/en/messages.json` です。`message` の値だけ訳して、キーと `__MSG_*__` プレースホルダはそのままにしてください。9 言語すべて、キーの集合を揃える必要があります。

## まとめて直すべき箇所

同じ事実が複数のファイルにまたがって書かれている箇所があります。片方だけ直すと、プロジェクトの中で話が食い違ってしまいます。

| 変更する対象 | 一緒に更新するもの |
| :--- | :--- |
| 制御モード、バッジの色 | `inject.js` の `COLOR` と制御状態 ・ `_locales/*/messages.json` の `showPlaybackRateDesc` ・ README.md / README.ja.md の制御モード表 ・ `CHANGELOG.md` |
| 設定項目、その範囲、既定値 | `shared/schema.js` ・ README.md / README.ja.md の設定一覧表 ・ `_locales/*/messages.json` の説明文 |
| 保存内容、使用する権限 | `PRIVACY.md` の本文**および**「最終更新」日を、同じコミットで |

## プルリクエスト

* 1つのプルリクエストにつき、意味のある変更は1つに。
* `CHANGELOG.md` の `## [未リリース]` 配下に、既存の見出し（`追加` / `変更` / `非推奨` / `削除` / `修正` / `セキュリティ`）を使って追記してください。本文は英語でも構いません。
* どのブラウザと、3サイトのうちどれで実際に動かして確認したかを書いてください。「Chrome だけ」でも問題ありません、そう書いてあれば十分です。
* 周りのコードのスタイルに合わせてください。素の現代的な JavaScript、フレームワークなし、抽象化のための抽象化もなしで。

## セキュリティ

脆弱性は公開 Issue で報告しないでください。非公開の報告手順は [SECURITY.md](SECURITY.md) にあります。
