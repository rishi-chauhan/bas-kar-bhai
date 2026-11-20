# Bas Kar Bhai 🚨

*बस कर भाई — "enough, bro."*

A screen-time tracker with consequences. Set a daily limit for YouTube, Instagram, X, whatever eats your day. When you blow past it, **a video slams onto your screen and blasts at full volume**. Everyone around you hears it, you get embarrassed, and you close the tab. That's the whole idea.

Right now it's a Chrome extension (works in Chrome, Brave, Edge and other Chromium browsers). A phone version is on the roadmap.

## Features

- **Tracks time per website**, only while the tab is actually in front of you (focused window, not idle). A video playing with sound still counts, even if you haven't touched the keyboard.
- **Daily limits per site.** A limit on `youtube.com` also covers `m.youtube.com`, `music.youtube.com`, etc.
- **The blast:** a full-screen overlay with a loud siren/air-horn video. It pauses the page's own media, mounts inside fullscreen players, and keeps coming back every few minutes while you stay.
- **Begging is allowed, after the shame:** "5 min aur" only unlocks once the video has finished.
- **Use any YouTube video:** paste a link (youtu.be, watch, shorts, with or without `?t=`), optionally pick start/stop times. It plays at volume 100 inside the overlay.
- **Or bring your own file:** upload any video or audio clip (up to 60 MB).
- **Badge** on the toolbar icon shows minutes left on the current site (`!!` once you're over).
- **Popup** with today's usage, **settings page** with a 7-day history.
- **Private:** everything stays in your browser. No servers, no accounts, no analytics.

## Install (developer mode)

1. Clone this repo.
2. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the `extension/` folder.
5. The settings page opens. Set your limits, turn the volume up, and hit **Test the blast**.

## How loud is "full volume"?

No browser extension can change your **system** volume (there's no API for it, and extensions can't fake the volume keys). So Bas Kar Bhai squeezes out every bit of loudness it can within that limit:

- **Louder than 100%.** The bundled siren and uploaded files go through a Web Audio boost (+12 dB by default, up to +18 dB) and a limiter. Quiet phone-recorded clips come out far louder at the same system volume, without crackling.
- **Muted tab? Not anymore.** If you muted the site in the browser, it gets unmuted before the blast, and again if you try to mute it during the blast.
- **Skip the headphones (opt-in).** Pick your laptop speakers in settings and the blast plays there even while Bluetooth headphones are connected. Chrome only lists output devices after you allow microphone access; the mic is released immediately and nothing is recorded. Wired headphones usually share a device with the speakers, so they can't be bypassed.
- **Sound always plays.** If the site blocks autoplay with sound, the picture plays muted in the overlay and the sound comes from a hidden extension page instead, which isn't subject to that rule.

YouTube videos play at volume 100 but can't be boosted or sent to a specific device, because their audio lives inside YouTube's own player. For maximum damage, upload your clip as a file. If YouTube can't play at all (offline, video deleted, embedding disabled), the bundled siren plays instead.

## Project layout

```
extension/
  manifest.json        MV3 manifest
  background.js        service worker: time tracking, limits, triggering the blast
  content/inject.js    injected into the offending tab; mounts the overlay iframe
  overlay/             the full-screen "BAS KAR BHAI!" overlay (extension page)
  offscreen/           hidden page that plays audio when the site blocks autoplay
  popup/               toolbar popup
  options/             settings page
  lib/                 shared helpers, loudness boost, YouTube player bridge, IndexedDB for custom videos, theme
  media/default.mp4    bundled blast video
  icons/
scripts/make_assets.py regenerates the default video and icons from scratch
```

### How tracking works

The worker remembers which site is in front of you and since when (`chrome.storage.session`). On every tab switch, URL change, window focus change, idle change, and on a 30-second alarm, it credits the elapsed time to that site, then checks its limit. Single chunks are capped at 2 minutes, so a laptop that slept on YouTube doesn't come back with 8 hours of "usage".

Data lives in `chrome.storage.local` (settings and per-day usage, kept for 30 days). Custom videos live in the extension's IndexedDB.

### Why YouTube needs `declarativeNetRequest`

YouTube refuses to play embeds that arrive without a `Referer` header ("Error 153"), and pages inside an extension don't send one. The worker installs one rule that sets `Referer: https://<extension-id>.chromiumapp.org/`, only on the extension's own embed requests (they carry a `bkb=1` marker). YouTube embeds on other websites are untouched. The player is controlled through YouTube's iframe `postMessage` protocol, since MV3 extensions can't load the remote IFrame API script.

### Regenerating assets

The default video and icons are synthesized entirely in code (no third-party media):

```bash
python3 scripts/make_assets.py
```

Needs Python 3 + Pillow, `ffmpeg` with libx264/aac, and the Noto Sans + Noto Sans Devanagari fonts.

## Roadmap

- [ ] Android app (UsageStats for tracking, overlay + max media volume for the blast)
- [ ] Firefox build
- [ ] Schedules (limits only on weekdays / work hours)
- [ ] Weekly shame report

## License

MIT
