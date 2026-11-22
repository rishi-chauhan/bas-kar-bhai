# Bas Kar Bhai 🚨

[![Tests](https://github.com/rishi-chauhan/bas-kar-bhai/actions/workflows/test.yml/badge.svg)](https://github.com/rishi-chauhan/bas-kar-bhai/actions/workflows/test.yml)

*बस कर भाई — "enough, bro."*

A screen-time tracker with consequences. Set a daily limit for YouTube, Instagram, X, whatever eats your day. When you blow past it, **a video slams onto your screen and blasts at full volume**. Everyone around you hears it, you get embarrassed, and you close the tab. That's the whole idea.

It works in Chrome, Brave, Edge and other Chromium browsers, and in Firefox (140+) and Firefox-based browsers like Zen.

## Demo

https://github.com/user-attachments/assets/ae683ed9-98fa-4c89-b72c-3ecc9dd146eb

<p align="center"><sub>15 seconds. Turn the sound on.</sub></p>

## Screenshot

<p align="center">
  <img src="docs/settings.png" alt="The Bas Kar Bhai settings page: daily limits per site, the blast video picker with a preview of the bundled siren, loudness and speaker options, nag and snooze timings, and a 7-day usage chart" width="720" />
</p>

<p align="center"><sub>The settings page. The usage chart shows sample data.</sub></p>

## Features

- **Tracks time per website**, only while the tab is actually in front of you (focused window, not idle). A video playing with sound still counts, even if you haven't touched the keyboard.
- **Daily limits per site.** A limit on `youtube.com` also covers `m.youtube.com`, `music.youtube.com`, etc.
- **The blast:** a full-screen overlay with a loud siren/air-horn video. It pauses the page's own media, mounts inside fullscreen players, and keeps coming back every few minutes while you stay.
- **Begging is allowed, after the shame:** "5 min aur" only unlocks once the video has played through once. The video itself loops (between your start/stop times, if you set them) until you leave.
- **Use any YouTube video:** paste a link (youtu.be, watch, shorts, with or without `?t=`), optionally pick start/stop times. It plays at volume 100 inside the overlay.
- **Or bring your own file:** upload any video or audio clip (up to 60 MB).
- **Badge** on the toolbar icon shows minutes left on the current site (`!!` once you're over).
- **Popup** with today's usage, **settings page** with a 7-day history.
- **Private:** everything stays in your browser. No servers, no accounts, no analytics.

## Install

It isn't on the Chrome Web Store or Firefox Add-ons yet, so install it from the code.

### Chrome, Brave, Edge


1. Download the code: `git clone https://github.com/rishi-chauhan/bas-kar-bhai.git`, or use **Code → Download ZIP** on GitHub and unzip it.
2. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `extension/` folder inside the repo.
5. The settings page opens. Click **Find my speakers** (one-time microphone permission, see below), set your limits, turn the volume up, and hit **Test the blast**.

To update later, `git pull` (or download the ZIP again) and click the reload icon on the extension's card in `chrome://extensions`.

### Firefox, Zen and other Firefox-based browsers

Release Firefox only keeps extensions that Mozilla has signed, so until it's on Firefox Add-ons it loads as a temporary add-on, which stays until you restart the browser:

1. Download the code as above.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick `extension/manifest.json`.
4. The settings page opens. Set your limits, turn the volume up, and hit **Test the blast**.

To update, `git pull` and click **Reload** on the extension in `about:debugging`.

### Differences on Firefox

Everything works the same, except:

- **No "always on the speakers".** Firefox doesn't let extensions pick an output device for sound that plays in the background, so the blast plays on whatever you're listening on, Bluetooth headphones included. The settings page says so instead of showing the speaker picker, and it never asks for the microphone.
- **Sound in the overlay is never blocked.** Firefox's autoplay blocking doesn't apply to the extension's overlay, so the blast plays with sound right on the page, boost included.
- If you switch off the extension's access to all websites in `about:addons`, nothing gets tracked. The settings page warns you and has a button to turn it back on.

## Privacy and permissions

Nothing you do is sent anywhere. There are no servers, accounts, analytics or trackers. Your usage history and settings live in `chrome.storage.local`, and your uploaded clip lives in the extension's IndexedDB. Both are deleted when you remove the extension.

The only network requests the extension makes are to YouTube, and only if you choose a YouTube video for the blast (to show its title and to play it).

Why it asks for what it asks for:

| Permission | Why |
| --- | --- |
| Read your browsing history / access all sites (`tabs`, `<all_urls>`) | To see which site is in front of you, and to show the overlay on whatever site you're over the limit on. |
| `idle` | To stop counting when you walk away (unless a video is playing). |
| `storage`, `unlimitedStorage` | Settings, usage history, and your uploaded clip. |
| `alarms` | A 30-second tick so time is counted even with no tab events. |
| `scripting` | Injects the overlay into the offending tab. |
| `offscreen` (Chrome) | A hidden page that plays the sound when a site blocks autoplay, or to reach the built-in speakers. Firefox doesn't need it: its background page plays the sound itself. |
| `declarativeNetRequestWithHostAccess` | Adds a `Referer` header to the extension's own YouTube embeds so they play (details below). |
| Microphone (optional, asked once, Chrome only) | Chrome only reveals your speaker names after mic access. The mic is released immediately and nothing is recorded. |

## How loud is "full volume"?

No browser extension can change your **system** volume (there's no API for it, and extensions can't fake the volume keys). So Bas Kar Bhai squeezes out every bit of loudness it can within that limit:

- **Louder than 100%.** The bundled siren and uploaded files go through a Web Audio boost (+12 dB by default, up to +18 dB) and a limiter. Quiet phone-recorded clips come out far louder at the same system volume, without crackling.
- **Muted tab? Not anymore.** If you muted the site in the browser, it gets unmuted before the blast, and again if you try to mute it during the blast.
- **Always on the speakers** (not on Firefox, see [Differences on Firefox](#differences-on-firefox)). The blast plays on your built-in speakers, even while Bluetooth headphones are connected. Chrome only shows an extension your output devices after you allow microphone access, so the settings page asks once ("Find my speakers"). The mic is released immediately and nothing is recorded. The speakers are picked by name (e.g. "MacBook Pro Speakers", "Speakers (Realtek…)", "… Analog Stereo"), skipping headphones, HDMI monitors and virtual devices. If the guess is wrong you can pick the device yourself; if the mic is blocked or no speakers are found, it plays on the current output. Wired headphones usually share a device with the speakers, so they can't be skipped.
- **Sound always plays.** If the site blocks autoplay with sound, the picture plays muted in the overlay and the sound comes from a hidden extension page instead (Chrome's offscreen page, Firefox's background page), which isn't subject to that rule.

YouTube videos play at volume 100 but can't be boosted or sent to a specific device, because their audio lives inside YouTube's own player. For maximum damage, upload your clip as a file. If YouTube can't play at all (offline, video deleted, embedding disabled), the bundled siren plays instead.

## Project layout

```
extension/
  manifest.json        MV3 manifest, shared by Chrome and Firefox
  background.js        service worker (Chrome) / event page (Firefox): time tracking, limits, triggering the blast
  content/inject.js    injected into the offending tab; mounts the overlay iframe
  overlay/             the full-screen "BAS KAR BHAI!" overlay (extension page)
  offscreen/           Chrome's hidden page for the sound (lib/player.js does the playing)
  popup/               toolbar popup
  options/             settings page
  lib/                 shared helpers, loudness boost, YouTube player bridge, IndexedDB for custom videos, theme
  media/default.mp4    bundled blast video
  icons/
scripts/make_assets.py regenerates the default video and icons from scratch
tests/                 unit tests, plus browser tests that drive the real extension
docs/                  README screenshot, Firefox support notes
package.json           test scripts only
```

There's no build step and no dependencies: the `extension/` folder is loaded as-is in both browsers. `package.json` only holds the test scripts. Each browser ignores the other's manifest keys (`service_worker` vs `scripts`, `browser_specific_settings`), and the code checks for features (`chrome.offscreen`) rather than for the browser.

### How tracking works

The worker remembers which site is in front of you and since when (`chrome.storage.session`). On every tab switch, URL change, window focus change, idle change, and on a 30-second alarm, it credits the elapsed time to that site, then checks its limit. Single chunks are capped at 2 minutes, so a laptop that slept on YouTube doesn't come back with 8 hours of "usage".

Data lives in `chrome.storage.local` (settings and per-day usage, kept for 30 days). Custom videos live in the extension's IndexedDB.

### Why YouTube needs `declarativeNetRequest`

YouTube refuses to play embeds that arrive without a `Referer` header ("Error 153"), and pages inside an extension don't send one. The worker installs one rule that sets `Referer: https://<extension-id>.chromiumapp.org/` (on Firefox, the per-install extension UUID instead of the id), only on the extension's own embed requests (they carry a `bkb=1` marker). YouTube embeds on other websites are untouched. The player is controlled through YouTube's iframe `postMessage` protocol, since MV3 extensions can't load the remote IFrame API script.

### Regenerating assets

The default video and icons are synthesized entirely in code (no third-party media):

```bash
python3 scripts/make_assets.py
```

Needs Python 3 + Pillow, `ffmpeg` with libx264/aac, and the Noto Sans + Noto Sans Devanagari fonts.

## Roadmap

- [ ] Chrome Web Store listing
- [x] Firefox support
- [ ] Firefox Add-ons listing
- [ ] Schedules (limits only on weekdays / work hours)
- [ ] Weekly shame report

## Contributing

Bug reports, ideas and pull requests are welcome. Please [open an issue](https://github.com/rishi-chauhan/bas-kar-bhai/issues) first for anything bigger than a small fix, so we can agree on the approach.

To work on it: load `extension/` unpacked (see [Install](#install)), make your change, then hit the reload icon on the extension's card. Logs from the service worker show up under **Inspect views: service worker** on that card; the popup, settings page and overlay each have their own DevTools. In Firefox, use **Reload** and **Inspect** on the extension in `about:debugging`.

Changes should work in both Chrome and Firefox. Run the tests on both (see below).

Please run the tests before opening a pull request (see [Testing](#testing)), and add a test when you fix a bug or add a feature.

Please keep it dependency-free and private: no build tools, no remote code, no network calls beyond YouTube.

### Testing

The tests need Node.js 22 or newer and nothing else: no `npm install`.

```bash
npm test
```

That runs everything (about a minute). You can also run the parts on their own:

- `npm run test:unit`: the pure helpers (site matching, time and YouTube link parsing, speaker picking, clip looping, settings saves). Takes under a second, no browser needed.
- `npm run test:e2e`: loads the real extension into a headless browser and uses it the way a person would. It tracks time, goes over a limit, sits through the blast, snoozes, closes the tab, uploads a clip, picks a YouTube video, uses the popup and resets history. It also checks that websites can't trigger the overlay, and fails if any extension page logs an error.

The browser tests need a Chromium-based browser that still allows loading unpacked extensions from the command line: Chromium, [Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing) or Brave. Branded Google Chrome 137+ doesn't. They find one on your `PATH`; otherwise point `CHROME_PATH` at it:

```bash
CHROME_PATH=/path/to/chromium npm run test:e2e
```

To run them on Firefox (140+) instead, set `BROWSER=firefox`. It uses `firefox` from your `PATH`, or `FIREFOX_PATH`:

```bash
npm run test:e2e:firefox
```

`npm run lint:firefox` checks the extension with Mozilla's `web-ext` linter, the same checks Firefox Add-ons runs. It reports a few warnings about the Chrome-only parts (`offscreen`, `service_worker`); those are expected.

Without a browser, those tests are skipped. The YouTube steps are skipped when YouTube can't be reached. The browser runs muted, so nothing blasts while you test.

GitHub Actions runs the full suite on Chrome for Testing and on Firefox, plus the Firefox linter, on every push to `main` and on every pull request ([`.github/workflows/test.yml`](.github/workflows/test.yml)).

## License

[MIT](LICENSE)
