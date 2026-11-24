# Firefox support

The same `extension/` folder runs in Chrome and in Firefox 140+ (and Firefox-based
browsers such as Zen). There's still no build step, no separate repo and no fork.
This page records how it works and what we learned along the way, so future changes
keep both browsers working.

## One manifest for both browsers

| Key | Chrome | Firefox |
|---|---|---|
| `background.service_worker` | used | ignored (lint warning) |
| `background.scripts` + `type: module` | ignored (121+) | used, as an event page |
| `browser_specific_settings.gecko` | ignored | add-on id, `strict_min_version: 140.0`, `data_collection_permissions: none` |
| `offscreen` permission | used | ignored (lint warning) |

`npm run lint:firefox` (Mozilla's `web-ext lint`) reports 0 errors. Its 6 warnings
all point at those Chrome-only parts.

The add-on id `bas-kar-bhai@rishi-chauhan` becomes permanent once the add-on is
published on Firefox Add-ons (AMO), so change it before the first upload if you
want a different one.

## What's different in the code

The code checks for features, not for browser names, except for `IS_FIREFOX` in `lib/common.js`
(used for `CAN_PICK_OUTPUT` and for naming the sync service in the UI).

- **Background sound** (`lib/player.js`). Chrome plays it in an offscreen document.
  Firefox has no offscreen documents, but its background page has a DOM, so
  `background.js` imports the player and plays the sound right there
  (`HAS_OFFSCREEN`).
- **Event page lifetime.** Firefox unloads an idle background page, and the sound
  goes with it (we verified this with a 2-second idle timeout). While the background
  is playing, the overlay sends `BKB_KEEPALIVE` every 10 seconds. Firefox's default
  timeout is 30 seconds.
- **No speaker choice** (`CAN_PICK_OUTPUT` in `lib/common.js`). Firefox never answers
  `enumerateDevices()` in a page that isn't on screen, so the background page can't
  see output devices. On Firefox, `getSettings()` always reports
  `outputMode: 'default'`. The options page shows a note instead of the speaker
  picker and never asks for the microphone, and the popup has no speaker notice.
  `currentOutputs()` also gives up after 1.5 seconds, so nothing can hang on it.
- **Boost + device routing** (`lib/loudness.js`). Where `AudioContext` can't
  `setSinkId`, the boosted sound leaves through an `<audio>` element that can. This is
  unused on Firefox today, but it's correct if a later Firefox lets us pick devices.
- **Autoplay.** Firefox's autoplay blocking doesn't apply to the extension's overlay
  frame. On a page nobody has clicked, an ordinary web page's `AudioContext` stays
  suspended while the overlay's runs. So on Firefox the blast plays with sound, and
  with the boost, right in the overlay, and the background player is only a
  fallback.
- **YouTube Referer** (`lib/youtube.js`). Firefox's `runtime.id` looks like
  `name@author`, which isn't a valid hostname label, so the rule uses the per-install
  extension UUID instead.
- **Test preview** (`overlay.js`). Firefox has no `location.ancestorOrigins`, so the
  "is my parent one of our pages?" check falls back to reading the parent's origin,
  which throws for any other site.
- **Sync across computers** (`lib/sync.js`). Both browsers have `storage.sync` with the
  same limits (100 KB in total, 8 KB per item, 512 items), so the code is the same. On
  Firefox, the data travels with Firefox Sync when the user is signed in and "Add-ons"
  is ticked in the sync settings. Firefox matches the data up by add-on id, which is why
  the id in `browser_specific_settings` matters. Without an account, `storage.sync`
  still works, just locally, and that's what the tests use. Firefox syncs on its own
  schedule (every few minutes), not right away like Chrome. Chrome and Firefox never
  see each other's data.
- **Site access** (options page). Firefox lets users switch off "access to all
  websites" in `about:addons`. When that happens the options page shows a card with a
  button to turn it back on.

## Tests

The browser tests run on both browsers from one set of test files.
`tests/e2e/browser.mjs` has a Chrome driver (DevTools protocol) and a Firefox driver
(WebDriver BiDi over Node's built-in `WebSocket`, still standard library only). Both
offer the same interface.

```bash
npm test                     # Chrome (CHROME_PATH or Chromium/Brave on PATH)
npm run test:e2e:firefox     # Firefox (FIREFOX_PATH or firefox on PATH)
```

Firefox driver workarounds, in case they ever break:

- `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` (set only on the throwaway test browser) is needed
  to run code in extension pages.
- BiDi can't navigate to, activate, or set files on `moz-extension://` pages. So the
  driver opens extension pages with `chrome.tabs.create` from the options page (which
  opens by itself on install). It activates them with `chrome.tabs.update`, and
  uploads files by serving them on localhost and filling the input with a
  `DataTransfer`.
- The extension UUID is pinned with the `extensions.webextensions.uuids` pref, so the
  `moz-extension://` address is known up front.
- Firefox's background page isn't reachable over BiDi, so errors logged there aren't
  checked. Both drivers ask the background whether sound is playing through the
  `BKB_AUDIO_STATUS` message instead of inspecting the offscreen page.

CI runs the suite on Chrome for Testing and on Firefox stable, then runs `web-ext lint`.

## Still to do

- Publish on Firefox Add-ons: `npm run build:firefox` makes the zip in `dist/`. No
  source upload is needed because there's no build step.
- Manual check with two real computers signed in to the same Mozilla account: sync
  (the tests only cover one browser, with the other computer's data faked).
- Manual check on real hardware: Bluetooth headphones connected, blast on Firefox
  (expected: it plays in the headphones, as the settings page says).
