# Slipstream Live

🌐 English | [日本語](README.ja.md)

📘 **[User manual](https://tail4126.github.io/SlipstreamLive/manual.html)** — installation, every setting, and troubleshooting, with screenshots.

> **Live streams always run a few seconds behind. Slipstream Live quietly closes that gap for you.**

**Slipstream Live** is a browser extension for **YouTube Live**, **Twitch**, and **TwitCasting**.

It watches how much video your browser has buffered and nudges the playback speed up or down to
keep you close to the live edge — **without** the video stopping to buffer.

Install it and that's it. There's nothing else to do while you watch.

---

## 🤔 What problem does this solve?

When you watch a live stream, what you see is always a few seconds behind what the streamer is
actually doing right now. That gap grows every time your connection hiccups, and it never
shrinks on its own.

You *could* fix this yourself by setting playback speed to 1.25x for a while — but then you have to
watch the buffer and slow back down before it runs out, or the video freezes on that spinning
circle.

Slipstream Live does that watching for you, about 50 times per second.

| Situation | What Slipstream Live does |
| :--- | :--- |
| You've fallen behind, and plenty of video is loaded ahead | Speeds up a little (1.25x) until you catch up |
| Loaded video is almost gone | Drops to 0.15x and lowers the volume, to avoid a full freeze |
| Everything is fine | Does nothing — plain 1.00x |

---

## ✨ Features

* 🌐 **Three platforms** — YouTube, Twitch, and TwitCasting, each with its own tuned defaults.
* 🚀 **Automatic catch-up** — speeds up only when it's actually safe to do so.
* 🧠 **Learns each stream** — figures out the right safety margin by itself, so you don't have to guess a number.
* 🛡️ **Freeze avoidance** — a last-resort 0.15x mode that keeps the picture moving while the buffer refills.
* 🔊 **Volume ducking** — quiets the distorted audio that extreme slow-motion produces.
* 📊 **Optional on-screen badges** — current speed, live latency, and buffer health, right in the player.
* 🌍 **9 UI languages** — English, 日本語, 한국어, Deutsch, Español, Français, Português (BR), 简体中文, 繁體中文.
* 🔒 **No network access, no tracking** — see [PRIVACY.md](PRIVACY.md).

---

## 🛠️ Installation

### 🌐 Chrome / Edge / Brave / other Chromium browsers

Install directly from the **[Chrome Web Store](https://chromewebstore.google.com/detail/ecbonmgnfkfkfempebmojjpkgbekkjdf)**.

<details>
<summary>Installing from source (for developers / manual installation)</summary>

1. Download this repository as a ZIP and extract it (or `git clone` it).
2. Type `chrome://extensions` into the address bar and press Enter.
3. Turn on **Developer mode** with the toggle in the top-right corner.
4. Click **Load unpacked** and pick the extracted folder — the one containing `manifest.json`.

> The extension stays installed until you remove it. You can pin its icon to the toolbar from
> the puzzle-piece menu.

</details>

### 🦊 Firefox

Install directly from **[Firefox Add-ons](https://addons.mozilla.org/firefox/addon/slipstream-live/)**.

Also available on **Firefox for Android** (v142.0 or later) — open the same page in
Firefox for Android and tap **Add to Firefox**.

<details>
<summary>Installing from source (for developers / manual installation)</summary>

**A. Temporary install (easiest, but disappears when you close Firefox)**

1. Type `about:debugging#/runtime/this-firefox` into the address bar.
2. Click **Load Temporary Add-on…**.
3. Select the **`manifest.json`** file inside the extracted folder.

**B. Permanent install (Developer Edition / Nightly only)**

1. ZIP up the contents of the folder.
2. Open `about:config` and set `xpinstall.signatures.required` to **`false`**.
3. Open `about:addons` → ⚙️ gear icon → **Install Add-on From File…** → choose your ZIP.

</details>

### ✅ Check that it works

Open a **live** stream on [YouTube](https://www.youtube.com/), [Twitch](https://www.twitch.tv/),
or [TwitCasting](https://twitcasting.tv/), click the Slipstream Live icon, and turn on
**Show playback rate**. A small `1.00x` should appear in the player's control bar, changing
colour as Slipstream Live works.

---

## 🕹️ Using it

Click the toolbar icon to open the settings popup. It has two panels:

* **Site settings** — tabs for YouTube / Twitch / TwitCasting. Each site remembers its own values,
  and the popup automatically opens the tab for the site you're currently on.
* **All sites** — the master switch and the on-screen badges.

Every row has a **?** button with a plain-language explanation, and each section has a
**Reset** button that puts that section back to its defaults. The link in the bottom-right corner
opens the [user manual](https://tail4126.github.io/SlipstreamLive/manual.html), which walks through the same screen with figures.

### The badges (off by default)

| Badge | Example | Meaning |
| :--- | :--- | :--- |
| Playback rate | `1.25x` | Current real speed. The colour tells you which mode is active. |
| Latency | `1.50s` | How far behind the live edge you are. Shows `(DVR)` if you've rewound. |
| Buffer health | `2.50s` | Seconds of video loaded ahead of you. A `+3s` suffix means there's more video loaded past a gap. |

---

## 🔄 The three modes

| Mode | Priority | Badge colour | Speed | When it kicks in |
| :--- | :---: | :---: | :---: | :--- |
| **Floor** | Highest | Blue (`#83c1ff`) | **0.15x** (fixed) | Buffer is about to run out. Emergency brake, plus volume ducking. |
| **Speedup** | Low | Red (`#ff8983`) | 1.25x | Buffer is comfortably deep. Catches up to the live edge. |
| **Normal** | — | White (`#eee`) | 1.00x | Nothing to do. |

Higher-priority modes always win. The 0.15x floor speed isn't configurable on purpose — it's a
safety net, not a preference.

Each threshold carries hysteresis in the direction of the current mode, so playback rate and volume
don't chatter when the buffer sits exactly on a boundary. The width follows the **Auto-adjust
buffer threshold** level: **0.1 s** at Off and Standard, **0.05 s** at Aggressive.

**What Slipstream Live leaves alone:** archived videos (VODs), clips, and ad breaks are never
touched — only live playback is controlled. TwitCasting's low-latency mode is excluded too: it
delivers video over WebRTC, which has no read-ahead buffer to measure and ignores `playbackRate`
entirely. Those streams are already close to real time, so there's nothing to catch up on.

**On YouTube and TwitCasting**, if *you* pick a speed other than 1.00x in the player menu,
Slipstream Live hands control back to you and stops adjusting. (Twitch has no such menu, so Slipstream Live
stays in charge there — and also stops Twitch's own built-in catch-up from fighting with it.)

---

## ⚙️ Settings

### Site settings (per platform)

| Setting | Range | YouTube | Twitch | TwitCasting | What it does |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Speed up when delayed** | ON / OFF | ON | ON | ON | Master switch for catching up. |
| **Speed-up playback rate** | 1.05x–4.00x | 1.25x | 1.25x | 1.25x | How fast to catch up (0.05 steps). Higher = faster, but eats buffer. |
| **Auto-adjust buffer threshold** | Off / Standard / Aggressive | Standard | Standard | Standard | Let Slipstream Live decide when it's safe to speed up. **Recommended.** |
| **Speed-up buffer threshold** | 0.1–100.0s | 10.0s | 10.0s | 10.0s | Only used when auto-adjust is **Off**: speed up once this much video is loaded. |
| **Maximum slowdown on buffer depletion** | ON / OFF | ON | ON | ON | Master switch for the 0.15x emergency brake. |
| **Maximum slowdown threshold** | 0.0–10.0s | 0.80s *(FF 1.00s)* | 2.00s *(FF 0.50s)* | 0.10s *(FF 0.30s)* | Drop to 0.15x while buffer health is below this. |
| **Lower volume during maximum slowdown** | ON / OFF | ON | ON | ON | Ducks the audio while at 0.15x. |
| **Volume during maximum slowdown** | 0–100% | 30% | 30% | 30% | Percentage of *your* current volume (5% steps). 100 = no change, 0 = mute. |

*FF = the default used on Firefox, which reports buffer levels differently. Note the direction is
not uniform: the Firefox defaults are larger on YouTube and TwitCasting, but smaller on Twitch.*

> **Why is Twitch's threshold so much higher?** Twitch sometimes stops delivering video for
> around 10 seconds at a time. The larger defaults give Slipstream Live room to react before playback
> actually stalls.

#### The three auto-adjust levels

| Level | Trough window | Safety factor | Added margin | Hysteresis | Character |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Off** | — | — | — | 0.1s | No estimation; uses **Speed-up buffer threshold** as-is. |
| **Standard** | 30s | 5 | 0.3s | 0.1s | Long window, large factor — cautious. The default. |
| **Aggressive** | 5s | 3 | 0.1s | 0.05s | Short window; reacts quickly to recent headroom and closes the gap harder. |

### All-sites settings

| Setting | Default | What it does |
| :--- | :---: | :--- |
| **Change playback speed** | ON | Master switch. Off = Slipstream Live does nothing at all. |
| **Show playback rate** | OFF | Shows the speed badge in the player. |
| **Show latency** | OFF | Shows how far behind live you are. |
| **Show buffer health** | OFF | Shows how many seconds are loaded ahead. |

---

## 💡 How it works

### The short version

Every 20 milliseconds, Slipstream Live measures **buffer health** — how many seconds of video are
loaded and ready to play — and picks one of the three modes based on that number.

The tricky part is knowing when it's safe to speed up. Buffer health is never a steady number:
video arrives in chunks ("segments"), so the buffer jumps up when a chunk lands, then drains
steadily until the next one. Plotted over time it looks like a sawtooth.

If Slipstream Live sampled at a random moment and happened to catch a **peak**, it would assume
there's plenty of room, speed up, and then hit the very next **trough** with nothing left —
freezing the video. So instead of trusting any single reading, it estimates where the *troughs*
actually are.

### The maths (optional reading)

<details>
<summary>How the trough is estimated without knowing the segment length</summary>

If you sample a sawtooth wave at random times, your readings are spread evenly across
`[trough, trough + S]`, where `S` is the segment length. For a uniform distribution:

$$avg = trough + \frac{S}{2}, \qquad sd = \frac{S}{2\sqrt{3}}$$

Solving the second equation for `S` and substituting into the first makes `S` cancel out entirely:

$$trough = avg - \sqrt{3} \times sd$$

So a short-term average and standard deviation are enough to locate the trough — no knowledge of
the stream's chunk size required. The sampling window adapts to each stream (roughly the segment
duration, clamped to 1–30 seconds), and the estimate is withheld until there are at least 8 samples
covering half the window, so an incomplete cycle can't produce a falsely optimistic answer.

Two further corrections keep the estimate honest:

* **Known-input compensation.** When Slipstream Live itself runs at 1.25x, the buffer drains for a
  reason that has nothing to do with the connection. It accumulates its own excess consumption,
  `D(t) = ∫(rate − 1)dt`, and stores every sample in compensated coordinates (`health + D(t)`), so
  its own speed changes don't bias the trough or inflate the standard deviation. Without this, the
  system oscillates: speed up → headroom collapses → return to 1.00x → headroom recovers → repeat.
* **Stationarity gate.** During start-up or recovery from a stall, the buffer *level* itself moves
  fast, and the standard deviation would measure that drift rather than the sawtooth amplitude.
  The slope of the compensated average reduces exactly to `(fetch rate − 1)`, so it isolates the
  connection. While that slope exceeds 0.9 s/s, no trough is recorded and the trough history is
  discarded outright — one contaminated sample would otherwise pollute the statistics for the rest
  of the window. The slope itself is measured over a full second of history; over any shorter
  interval, tiny wobbles in the average get amplified and the gate would report "never stationary".

Samples are collected only on the evenly-spaced timer ticks. The loop also runs on `timeupdate`,
`progress` and `waiting`, but `waiting` fires precisely when the buffer empties, so feeding those
readings into the statistics would skew the distribution toward the trough and break the uniform
assumption. Event-driven ticks update `D(t)` only. Likewise, while playback is paused, seeking, or
waiting on data (`readyState < 3`), the buffer isn't being consumed at the nominal rate, so `D(t)`
is not accrued for that interval either.

Those trough estimates are then collected over a long window (30 s at Standard, 5 s at Aggressive)
and reduced by a safety factor `K` (5 at Standard, 3 at Aggressive) to get the usable headroom:

$$room = troughAvg - K \times troughSd$$

`room` stays `NaN` until the trough history spans at least 1 seconds — a single sample would have
a standard deviation of zero and pass through with no safety margin at all. Speeding up is allowed
only while `room` stays above the buffer level you've asked Slipstream Live to protect (your maximum
slowdown threshold, plus the level's added margin; just the margin if that mode is off). Because
`K` is large, headroom only opens up when the troughs are *consistent* — an unstable connection
naturally suppresses speed-ups. And while there isn't enough data yet, `room` is `NaN`, every
comparison against it is false, and Slipstream Live falls back to doing nothing.

</details>

Badges are redrawn at most 10 times per second, and all statistics are smoothed, so the speed
doesn't visibly oscillate.

When there's nothing to control, the loop drops to a 1-second search mode, and after 5 seconds
without finding a target it stops the timer entirely and waits on media events instead. It also
runs once immediately when the tab becomes visible again.

---

## ❓ Troubleshooting

**It never speeds up.**
Auto-adjust is deliberately cautious: on an unstable connection it will decide that speeding up
isn't safe. Try switching **Auto-adjust buffer threshold** to **Aggressive** first. If that still
isn't enough, set it to **Off** and configure **Speed-up buffer threshold** manually (try 15–20
seconds and work down).

**It drops to 0.15x too often.**
Raise the manual threshold, or lower **Speed-up playback rate** so the buffer drains more slowly.
Lowering **Maximum slowdown threshold** delays the brake, but increases the chance of an actual
freeze.

**Nothing happens at all.**
Check that **Change playback speed** is ON, that you're on a *live* stream rather than a VOD or
clip, and that you haven't set a manual playback speed in the player menu.

**Nothing happens on TwitCasting.**
Check whether the stream is playing in low-latency mode. Low-latency streams arrive over WebRTC
and are outside Slipstream Live's scope — turn low latency off in the player settings if you want
Slipstream Live to manage the stream.

**The badges don't appear.**
They're off by default — turn them on in the **All sites** panel. If a site's control bar can't be
found, Slipstream Live falls back to a small dark strip in the top-left corner of the player.

**Twitch video itself freezes or errors out (unrelated to Slipstream Live)**
Slipstream Live only adjusts playback *speed*, so if the video stops completely or shows an
"Error #XXXX" code, that's almost always a Twitch or Chrome issue rather than Slipstream Live. Try
these steps in order:

1. Check [status.twitch.com](https://status.twitch.com/) for an ongoing Twitch outage
2. Open the same stream in an **Incognito window** (`Ctrl+Shift+N`, `Cmd+Shift+N` on Mac) — if
   that fixes it, the cause is an extension or cached data
3. Turn off all extensions, especially **ad blockers** (Twitch embeds ads directly into the video
   stream, so ad blockers are one of the most common causes of playback errors)
4. Update Chrome via `chrome://settings/help` (official support only covers the two most recent
   versions)
5. Clear your cache and cookies with `Ctrl+Shift+Delete` (`Cmd+Shift+Delete` on Mac)

Still stuck — especially if the screen freezes or goes black? Try toggling **Hardware
acceleration** in `chrome://settings/system` and restarting Chrome. Switch it back if that doesn't
help; it's a diagnostic step, not something to leave changed.

Twitch's own troubleshooting resources are worth a look too:

1. Playback Issue Troubleshooting
[https://help.twitch.tv/s/article/playback-issue-troubleshooting](https://help.twitch.tv/s/article/playback-issue-troubleshooting)
2. Supported Browsers
[https://help.twitch.tv/s/article/supported-browsers](https://help.twitch.tv/s/article/supported-browsers)
3. How to File a Video Playback Issue
[https://help.twitch.tv/s/article/how-to-file-a-video-playback-issue](https://help.twitch.tv/s/article/how-to-file-a-video-playback-issue)
4. Twitch Status
[https://status.twitch.com/](https://status.twitch.com/)

---

## 🌐 Requirements

* **Manifest version:** V3
* **Google Chrome / Chromium-based browsers:** v128 or later
* **Mozilla Firefox:** v140.0 or later
* **Firefox for Android:** v142.0 or later

---

## 🔒 Privacy

Slipstream Live makes **no network requests whatsoever**. It asks for only two permissions:

* `storage` — to save your settings locally on your device.
* `activeTab` — to see which supported site the popup was opened on, so it can pick the right tab.

No analytics, no telemetry, no identifiers, no ads. Full details in [PRIVACY.md](PRIVACY.md).

---

## 👩💻 For developers

### Project layout

```
manifest.json          Extension manifest (MV3)
popup.html/.css/.js    Settings UI (also serves as the options page)
common.js              Wrapper around storage / i18n APIs
content.js             ISOLATED world: pushes settings into <html data-slpstrm="...">
inject.js              MAIN world: the control loop (buffer → mode → speed/volume)
adapters/              Per-site glue: youtube.js, twitch.js, twitcasting.js
shared/schema.js       Single source of truth for settings (types, ranges, defaults)
shared/util.js         Small time-series, statistics and DOM helpers
_locales/              UI translations for 9 languages
docs/                  GitHub Pages: landing page, privacy policy, user manual (en/ja) + images/
```

MAIN-world scripts can't reach `chrome.storage`, so settings cross the world boundary as a JSON
string on a `data-` attribute. Page scripts can tamper with that attribute, so `inject.js` always
re-validates what it reads against its own independent bounds.

### Adding a site

Write one adapter exposing `video()` / `media()` / `status()` / `needs()` / `root()` / `host()` /
`reset()` plus `respectUserRate` / `gap` / `badgeClass` / `badgeStyle`, register it, and add
matching entries to `SITES` in `shared/schema.js` and to `manifest.json`. `inject.js` itself
doesn't need to change.

Content scripts get injected into every frame (`all_frames: true`), so a single page ends up
running several independent instances. Frames without a `<video>` stop their timer after a
5-second grace period, which is why `timer stopped` shows up frequently in the debug log even when
the main frame is working fine.

### Debugging

Run this in the *page* console (not the extension's console):

```js
window.__slipstreamliveDebug = true;
```

Once per second you'll get the current mode, the real playback rate, buffer health, the short-term
statistics, the trough statistics, the `room` formula, the accumulated excess consumption `drift`,
and the stationarity verdict `calm`. Buffer figures shown as `----` mean `health` is `NaN`, usually
because `video.buffered` is empty. A persistent `calm=NO` means the stationarity gate is rejecting
samples, so no trough history builds up and `room` stays `----` as well.

To preview any UI language without changing your browser settings, open the settings page with a
query string, e.g. `popup.html?locale=de`.

---

## License

Licensed under either of

* Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)
* MIT License ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)

at your option.

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in
the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any
additional terms or conditions.
