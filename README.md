# Bas Kar Bhai 🚨

*बस कर भाई — "enough, bro."*

A screen-time tracker with consequences. Set a daily limit for YouTube, Instagram, X, whatever eats your day. When you blow past it, **a video slams onto your screen and blasts at full volume**. Everyone around you hears it, you get embarrassed, and you close the tab. That's the whole idea.

Right now it's a Chrome extension (works in Chrome, Brave, Edge and other Chromium browsers). A phone version is on the roadmap.

## Features

- **Tracks time per website**, only while the tab is actually in front of you (focused window, not idle). A video playing with sound still counts, even if you haven't touched the keyboard.
- **Daily limits per site.** A limit on `youtube.com` also covers `m.youtube.com`, `music.youtube.com`, etc.
- **The blast:** a full-screen overlay with a loud siren/air-horn video. It pauses the page's own media, mounts inside fullscreen players, and keeps coming back every few minutes while you stay.
- **Begging is allowed, after the shame:** "5 min aur" only unlocks once the video has finished.
- **Bring your own video:** upload any video or audio clip (up to 60 MB).
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

Browsers aren't allowed to change your **system** volume, so the video plays at 100% of whatever your computer is set to. To make sure it actually makes a sound:

- It plays unmuted inside the page when Chrome allows it (you've clicked on the site at some point, which you almost always have).
- If the site's autoplay policy blocks sound, the picture plays muted and the sound comes from a hidden extension page instead, which isn't subject to that policy.

Raising the system volume itself would need a native helper app (desktop) or the phone app. See the roadmap.

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
  lib/                 shared helpers, IndexedDB storage for custom videos, theme
  media/default.mp4    bundled blast video
  icons/
scripts/make_assets.py regenerates the default video and icons from scratch
```

### How tracking works

The worker remembers which site is in front of you and since when (`chrome.storage.session`). On every tab switch, URL change, window focus change, idle change, and on a 30-second alarm, it credits the elapsed time to that site, then checks its limit. Single chunks are capped at 2 minutes, so a laptop that slept on YouTube doesn't come back with 8 hours of "usage".

Data lives in `chrome.storage.local` (settings and per-day usage, kept for 30 days). Custom videos live in the extension's IndexedDB.

### Regenerating assets

The default video and icons are synthesized entirely in code (no third-party media):

```bash
python3 scripts/make_assets.py
```

Needs Python 3 + Pillow, `ffmpeg` with libx264/aac, and the Noto Sans + Noto Sans Devanagari fonts.

## Roadmap

- [ ] Android app (UsageStats for tracking, overlay + max media volume for the blast)
- [ ] Optional native helper on desktop to crank the system volume before the blast
- [ ] Firefox build
- [ ] Schedules (limits only on weekdays / work hours)
- [ ] Weekly shame report

## License

MIT
