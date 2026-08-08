# Privacy Policy / プライバシーポリシー

**Last updated / 最終更新:** 2026-08-08

> **Note on Language / 言語に関する注記**
> このポリシーは英語で書いたものが正式版で、日本語訳は参考用です。両者の内容にズレがあった場合は英語版を優先します。
> This policy is written in English; the Japanese version is provided for convenience. If the two disagree, the English version wins.

---

## At a glance / 概要

| Question / 質問 | Answer / 回答 |
| :--- | :--- |
| Does it collect personal data? / 個人情報を収集しますか？ | **No / いいえ** |
| Does it make network requests? / 外部と通信しますか？ | **No — none at all / いいえ（一切ありません）** |
| Does it use analytics or telemetry? / 解析・テレメトリはありますか？ | **No / ありません** |
| Does it record browsing history? / 閲覧履歴を記録しますか？ | **No / いいえ** |
| Where are settings stored? / 設定の保存先は？ | Locally, on your device only / お使いの端末内のみ |
| Are settings synced across devices? / 端末間で同期されますか？ | **No / されません** |
| Does it load remote code? / 外部コードを読み込みますか？ | **No / いいえ** |
| Can I delete everything? / 完全に削除できますか？ | Yes — uninstalling removes all data / はい。アンインストールで全て消えます |
| Firefox data collection declaration / Firefox のデータ収集宣言 | `none` — nothing is collected / 収集なし |

---

## English Version (Official / 正本)

### Overview

This policy explains what data the **Slipstream Live** browser extension (the "Extension") touches and how.

The Extension runs entirely on your device. It doesn't collect, transmit, store remotely, or sell any personal data, browsing history, or activity of any kind. It never contacts an external server — the only code it runs is what's bundled inside the extension itself.

---

### 1. What gets stored, and what doesn't

#### 1.1 Saved to local storage

| Item | Example | Why |
| :--- | :--- | :--- |
| Per-site settings | Playback rate, buffer thresholds, feature toggles for YouTube / Twitch / TwitCasting | So your preferences apply on each site |
| Global settings | Master switch, badge display | So your preferences apply everywhere |
| Popup tab state | `youtube`, `twitch`, or `twitcasting` | So the popup opens on the right tab next time |

The "popup tab state" is just a short label for which of the three supported sites you last had open. No URLs, titles, channel names, video IDs, timestamps — nothing like that. And for any site outside the supported three, nothing is recorded at all.

#### 1.2 Only ever in memory (never saved)

| Item | Why |
| :--- | :--- |
| Playback position | To measure how much video is buffered ahead |
| Buffer health | To decide whether to speed up, slow down, or leave it alone |
| Stream latency | To show the optional latency badge |

This exists only while the video is playing, gets used to compute a speed adjustment, and is discarded right after. None of it is ever written to disk or sent anywhere.

---

### 2. Permissions and site access

Two permissions, nothing more:

| Permission | Why |
| :--- | :--- |
| **`storage`** | To save and load your settings via `chrome.storage.local` / `browser.storage.local`. Local rather than synced, on purpose — so your settings stay on your device. |
| **`activeTab`** | Used only when you open the popup, to check the active tab's hostname and pick the right settings panel. The hostname itself is discarded immediately; only the three-way site label (see §1.1) might get saved. |

Content scripts only run on these sites — nowhere else:

```
https://www.youtube.com/*          https://www.twitch.tv/*
https://m.youtube.com/*            https://player.twitch.tv/*
https://www.youtube-nocookie.com/* https://clips.twitch.tv/*
https://twitcasting.tv/*           https://*.twitcasting.tv/*
```

Live-chat frames are excluded on purpose. On these pages, the Extension only looks at the video player's buffer state and adjusts speed/volume. It doesn't touch page content, form inputs, cookies, credentials, or account info.

---

### 3. External communication and tracking

* **No network requests** — not to a developer server, an analytics provider, an ad network, a CDN, anything.
* **No remote code** — everything that runs ships inside the package. Nothing gets downloaded or evaluated at runtime.
* **No tracking** — no analytics, no telemetry, no unique IDs, no fingerprinting, no tracking cookies, no ads.

---

### 4. Third parties

There's nothing to share, sell, or hand over, because nothing is collected or transmitted in the first place — including in a business transfer scenario.

The Extension also isn't acting as a data processor for YouTube, Twitch, or TwitCasting. Using those sites is still governed by their own privacy policies.

---

### 5. Keeping and deleting data

Settings stay on your device until you remove them. You can:

* hit **Reset** in the settings popup to restore defaults, or
* uninstall the Extension, which wipes its local storage along with it.

Since no copy exists anywhere else, there's no separate deletion request to make.

---

### 6. Children's privacy

Not directed at children, and no personal data is collected from anyone regardless of age.

---

### 7. Changes to this policy

This may get updated as the Extension changes or as store requirements change. The "Last updated" date above will move accordingly, and anything significant also gets a note in [CHANGELOG.md](CHANGELOG.md). The current version always lives in `PRIVACY.md` in the source repo.

---

### 8. Contact

Questions, privacy concerns, bug reports — open a GitHub issue, or reach out through the Chrome Web Store / Firefox Add-ons support section.

---
---

## 日本語版 (Japanese / 参考訳)

### 概要

このポリシーでは、ブラウザ拡張機能「**Slipstream Live**」（以下「本拡張機能」）がどんなデータを扱うのか、扱わないのかを説明します。

本拡張機能は端末内だけで完結して動きます。個人情報や閲覧履歴、利用状況を収集・送信・外部保存・販売することは一切ありません。外部サーバーとの通信も一切なく、実行されるのは拡張機能に同梱されたコードだけです。

---

### 1. 保存するデータ・しないデータ

#### 1.1 ローカルストレージに保存するもの

| 内容 | 例 | 理由 |
| :--- | :--- | :--- |
| サイト別設定 | YouTube / Twitch / ツイキャスごとの再生速度、しきい値、機能のオン・オフ | 各サイトで設定を反映させるため |
| 全体設定 | マスタースイッチ、バッジ表示 | どのサイトでも設定を反映させるため |
| ポップアップのタブ状態 | `youtube` / `twitch` / `twitcasting` | 次回ポップアップを開いたとき同じタブを表示するため |

「ポップアップのタブ状態」は、対応3サイトのうちどれを直近に開いていたかを示す短いラベルにすぎません。URL、タイトル、チャンネル名、動画ID、日時などは一切記録しません。対応サイト以外については何も記録しません。

#### 1.2 メモリ上だけで扱うもの（保存しない）

| 内容 | 理由 |
| :--- | :--- |
| 再生位置 | バッファの先読み量を測るため |
| バッファ残量 | 加速・減速・そのままにするかを判断するため |
| 配信の遅延 | 任意機能である遅延バッジの表示のため |

これらは再生中だけメモリ上に存在し、速度計算に使われた直後に破棄されます。保存も送信もされません。

---

### 2. 権限とサイトアクセス

要求する権限は2つだけです。

| 権限 | 理由 |
| :--- | :--- |
| **`storage`** | 設定を `chrome.storage.local` / `browser.storage.local` に保存・読み込みするため。設定を端末外に出さないよう、あえて同期ストレージではなくローカルストレージを使っています。 |
| **`activeTab`** | ポップアップを開いた瞬間だけ使い、アクティブなタブのホスト名を見て該当する設定パネルを選びます。ホスト名自体はすぐ破棄され、保存されうるのは3択のサイトラベル（§1.1参照）だけです。 |

コンテンツスクリプトが動くのは以下のサイトだけです。

```
https://www.youtube.com/*          https://www.twitch.tv/*
https://m.youtube.com/*            https://player.twitch.tv/*
https://www.youtube-nocookie.com/* https://clips.twitch.tv/*
https://twitcasting.tv/*           https://*.twitcasting.tv/*
```

ライブチャットのフレームはあえて対象外にしています。これらのページで行うのは、プレイヤーのバッファ状態を見て速度・音量を調整することだけです。ページ内容やフォーム入力、Cookie、認証情報、アカウント情報には触れません。

---

### 3. 外部通信・トラッキング

* **通信なし** — 開発者のサーバーにも、解析サービスにも、広告ネットワークにも、CDNにも、どこにも接続しません。
* **外部コードなし** — 動くコードは全部パッケージ内にあります。実行時に何かをダウンロードしたり評価したりはしません。
* **トラッキングなし** — 解析、テレメトリ、識別子、フィンガープリンティング、トラッキングCookie、広告、どれも使いません。

---

### 4. 第三者への提供

そもそも何も収集・送信していないので、渡せるものがありません。事業譲渡があった場合も同じです。

また本拡張機能はYouTube・Twitch・ツイキャスの処理者として動くものでもありません。これらのサービスの利用には、それぞれのプライバシーポリシーが適用されます。

---

### 5. データの保持と削除

設定は消すまで端末内に残ります。消し方は2通り。

* 設定画面の **「リセット」** で初期状態に戻す
* 拡張機能をアンインストールする（ローカルストレージごと消えます）

どこにも複製がないので、開発者への削除依頼は不要です。

---

### 6. 子どものプライバシー

子ども向けの拡張機能ではなく、年齢に関わらず個人情報は集めていません。

---

### 7. ポリシーの改定

機能変更やストア側の要件変更に応じて更新することがあります。その際は冒頭の「最終更新」日を更新し、重要な変更は [CHANGELOG.md](CHANGELOG.md) にも記載します。最新版は常にソースリポジトリの `PRIVACY.md` にあります。

---

### 8. お問い合わせ

質問、プライバシーに関する懸念、不具合報告はGitHubのIssue、またはChrome Web Store / Firefox Add-onsのサポート欄からどうぞ。
