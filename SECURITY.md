# Security Policy / セキュリティポリシー

## English

### Supported versions

| Version | Supported |
| :--- | :---: |
| 1.0.0 (latest) | ✅ |
| Older releases | ❌ |

I only patch the latest release. If you're running an older build, update first and check whether the issue still shows up before reporting it.

### Reporting a vulnerability

**Don't open a public issue for a security problem.** That's basically the same as publishing the exploit.

Use GitHub's private reporting instead:

1. Open the **Security** tab on this repository.
2. Click **Report a vulnerability**.
3. Fill out the form.

This creates a private advisory that only you and I can see.

It helps if you include:

* Extension version, browser + version, and OS.
* Which of the three supported sites (YouTube, Twitch, TwitCasting) it affects, if it's site-specific.
* Steps to reproduce, and what an attacker could actually pull off.
* A proof of concept, if you have one.

### What to expect

This is a one-person hobby project, so I can't promise a response time. Realistically, here's how it usually goes:

* I'll acknowledge it within about a week.
* Once I understand the report, I'll assess how severe it is and give you a rough plan.
* I'll ship a fix as a patch release, and credit you in the release notes if you'd like.

Haven't heard anything after two weeks? Feel free to nudge the advisory thread.

### Scope

**In scope** — anything in this repository: the content scripts, the MAIN-world control loop, the site adapters, the settings page, and the manifest. Specifically:

* A page script escaping the MAIN/ISOLATED world boundary, or reaching the extension's internal helpers.
* A page script sneaking out-of-range values through the `data-` attribute into the control loop.
* Anything that makes the extension send network requests, load remote code, or transmit user data — [PRIVACY.md](PRIVACY.md) says it never does any of that.
* A page reading or changing the extension's stored settings without the user doing anything.

**Out of scope**

* Bugs in YouTube, Twitch, TwitCasting, or the browser itself — report those to whoever makes them.
* Breakage from one of those sites changing their DOM. That's a normal bug, not a security issue — use the [issue tracker](../../issues) for that.
* Anything that already assumes arbitrary code execution on your machine, or a malicious extension running alongside this one.
* Issues that only show up in a fork or a modified build.

### Disclosure

Give me a reasonable amount of time to ship a fix before you publish details. Once the fix is out, write about it however you like — I'll publish the advisory with credit to you.

---

## 日本語

### サポート対象バージョン

| バージョン | サポート |
| :--- | :---: |
| 1.0.0（最新） | ✅ |
| それ以前 | ❌ |

修正を出すのは最新版だけです。古いビルドを使っている場合は、報告の前にまず更新して、症状が直らないか確認してください。

### 脆弱性の報告方法

**セキュリティ関連の問題は公開 Issue に書かないでください。** それをやると、実質エクスプロイトを公開しているようなものです。

代わりに GitHub の非公開報告機能を使ってください。

1. このリポジトリの **Security** タブを開く
2. **Report a vulnerability** をクリック
3. フォームに記入する

これで、報告者と自分だけが見られる非公開のアドバイザリが作られます。

書いてもらえると助かるのは次のあたりです。

* 拡張機能のバージョン、ブラウザとそのバージョン、OS
* サイト固有の問題なら、対象サイト（YouTube / Twitch / ツイキャス）
* 再現手順と、悪用されたときに何ができてしまうか
* 実証コードがあればそれも

### 対応の目安

一人で趣味でやっているプロジェクトなので、対応期限は約束できません。だいたいの流れはこんな感じです。

* 1 週間くらいで受け取った旨を返信します
* 内容を理解したら、深刻度とだいたいの対応方針を伝えます
* パッチ版として修正を出します。名前を出してほしければリリースノートに書きます

2 週間経っても反応がなければ、アドバイザリのスレッドで催促してもらって大丈夫です。

### 報告の範囲

**対象** — このリポジトリに含まれるものすべて（コンテンツスクリプト、MAIN world の制御ループ、各サイトアダプタ、設定画面、マニフェスト）。特に次のようなものが対象です。

* ページ側のスクリプトが MAIN / ISOLATED の境界を越えたり、拡張機能の内部ヘルパーに触れたりできてしまう経路
* ページ側のスクリプトが `data-` 属性経由で範囲外の値を制御ループに流し込める経路
* 拡張機能が外部と通信したり、外部コードを読み込んだり、ユーザーデータを送信したりしてしまうもの（[PRIVACY.md](PRIVACY.md) では「一切やらない」と明言している部分です）
* ユーザーが何もしていないのに、ページ側が保存済みの設定を読み書きできてしまうもの

**対象外**

* YouTube・Twitch・ツイキャス、またはブラウザ自体のバグ。それぞれの開発元に報告してください
* サイト側の DOM 変更で動かなくなる不具合。これは普通のバグなので [Issue](../../issues) にお願いします
* 端末上ですでに任意コード実行が成立している、または悪意のある別の拡張機能が同居していることが前提のもの
* フォークや改変版でしか起きないもの

### 公表について

詳細を公表する前に、修正版を出す時間を少しもらえると助かります。修正版が出たあとは、記事でも何でも自由に書いてもらって構いません。アドバイザリも謝辞付きで公開します。
