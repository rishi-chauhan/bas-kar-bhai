// Bas Kar Bhai — background service worker.
//
// How tracking works:
//   * "current" (in chrome.storage.session) remembers which host is in front
//     of you and since when. It survives the worker being suspended.
//   * On every relevant event (tab switch, URL change, window focus, idle
//     change) and on a 30-second alarm, we "refresh": add the time since
//     `since` to today's usage for that host, then work out what is in front
//     of you now.
//   * After each refresh we check the limit for the active site and, if it's
//     blown, inject the overlay that blasts the video.

import {
  DEFAULT_SETTINGS,
  KEEP_DAYS,
  todayKey,
  hostFromUrl,
  findLimit,
  secondsForSite,
  getSettings,
  getUsage,
} from './lib/common.js';
import { refererRule, REFERER_RULE_ID } from './lib/youtube.js';

const TICK_ALARM = 'bkb-tick';
// No keyboard/mouse input for this long = "idle" (unless the tab is playing audio).
const IDLE_AFTER_SECONDS = 120;
// Never credit more than this in one go. Protects against laptop sleep, where
// `since` is hours old but you weren't actually scrolling.
const MAX_CHUNK_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Setup

async function ensureSetup() {
  chrome.idle.setDetectionInterval(IDLE_AFTER_SECONDS);
  const alarm = await chrome.alarms.get(TICK_ALARM);
  if (!alarm) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  // Lets YouTube embeds play inside our pages (see lib/youtube.js).
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [REFERER_RULE_ID],
    addRules: [refererRule()],
  });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await ensureSetup();
  if (reason === 'install') chrome.runtime.openOptionsPage();
  refresh();
});

chrome.runtime.onStartup.addListener(() => {
  ensureSetup();
  refresh();
});

ensureSetup();

// ---------------------------------------------------------------------------
// Events that can change what you're looking at

chrome.tabs.onActivated.addListener(() => refresh());
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (tab.active && (info.url || info.status === 'complete' || 'audible' in info)) refresh();
});
chrome.tabs.onRemoved.addListener(() => refresh());
chrome.windows.onFocusChanged.addListener(() => refresh());
chrome.idle.onStateChanged.addListener(() => refresh());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) refresh();
});

// ---------------------------------------------------------------------------
// Tracking

// Events arrive in bursts; run refreshes one at a time so time is never
// counted twice.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch((err) => console.warn('[bas-kar-bhai]', err));
  return run;
}

function refresh() {
  return serial(async () => {
    const now = Date.now();
    await flush(now);
    const active = await detectActive();
    await chrome.storage.session.set({ current: active ? { ...active, since: now } : null });
    if (active) await checkLimit(active, now);
  });
}

// What site is actually in front of the user right now, or null.
async function detectActive() {
  const idleState = await chrome.idle.queryState(IDLE_AFTER_SECONDS);
  if (idleState === 'locked') return null;

  let win;
  try {
    win = await chrome.windows.getLastFocused({ windowTypes: ['normal', 'popup'] });
  } catch {
    return null;
  }
  if (!win?.focused) return null;

  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  const host = hostFromUrl(tab?.url);
  if (!host) return null;

  // Not touching the keyboard? Only counts if the tab is making noise —
  // watching a 40-minute video essay is still procrastinating.
  if (idleState === 'idle' && !tab.audible) return null;

  return { host, tabId: tab.id };
}

// Credit the time since the last refresh to whatever was in front.
async function flush(now) {
  const { current } = await chrome.storage.session.get('current');
  if (!current) return;
  const elapsedMs = Math.min(now - current.since, MAX_CHUNK_MS);
  if (elapsedMs <= 0) return;

  const usage = await getUsage();
  const day = todayKey(new Date(now));
  const dayUsage = (usage[day] ||= {});
  const prev = dayUsage[current.host] || 0;
  dayUsage[current.host] = Math.round((prev + elapsedMs / 1000) * 10) / 10;

  const cutoff = todayKey(new Date(now - KEEP_DAYS * 86400000));
  for (const key of Object.keys(usage)) if (key < cutoff) delete usage[key];

  await chrome.storage.local.set({ usage });
}

// ---------------------------------------------------------------------------
// Limits

async function checkLimit(active, now) {
  const settings = await getSettings();
  const limit = findLimit(active.host, settings.limits);
  if (!limit) {
    setBadge(active.tabId, '');
    return;
  }

  const day = todayKey(new Date(now));
  const used = secondsForSite((await getUsage())[day], limit.site);
  const left = limit.minutes * 60 - used;
  if (left > 0) {
    setBadge(active.tabId, `${Math.ceil(left / 60)}m`, '#1f1f1f');
    return;
  }
  setBadge(active.tabId, '!!', '#ff2d55');
  if (!settings.enabled) return;

  let { nag } = await chrome.storage.local.get('nag');
  if (!nag || nag.day !== day) nag = { day, next: {} };
  if (now < (nag.next[limit.site] || 0)) return;

  nag.next[limit.site] = now + settings.nagEveryMinutes * 60000;
  await chrome.storage.local.set({ nag });

  await blast(active.tabId, {
    site: limit.site,
    used: Math.round(used),
    limit: limit.minutes,
    pauseMedia: settings.pausePageMedia,
  });
}

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

async function snooze(site) {
  const settings = await getSettings();
  const day = todayKey();
  let { nag } = await chrome.storage.local.get('nag');
  if (!nag || nag.day !== day) nag = { day, next: {} };
  nag.next[site] = Date.now() + settings.snoozeMinutes * 60000;
  await chrome.storage.local.set({ nag });
}

// ---------------------------------------------------------------------------
// The blast

async function blast(tabId, info) {
  const query = new URLSearchParams({
    site: info.site,
    used: String(info.used),
    limit: String(info.limit),
  }).toString();
  try {
    // A tab you muted in the browser would swallow the blast. Not today.
    await unmuteForBlast(tabId);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/inject.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'BKB_SHOW', query, pauseMedia: info.pauseMedia });
  } catch (err) {
    // Some pages (Chrome Web Store, PDFs, ...) don't allow scripts.
    console.warn('[bas-kar-bhai] could not show overlay on tab', tabId, err);
  }
}

// Unmute the tab, and keep it unmuted for a while in case you reach for
// "Mute site" mid-blast.
const UNMUTE_GUARD_MS = 90 * 1000;

async function unmuteForBlast(tabId) {
  const { blasting = {} } = await chrome.storage.session.get('blasting');
  blasting[tabId] = Date.now() + UNMUTE_GUARD_MS;
  await chrome.storage.session.set({ blasting });
  const tab = await chrome.tabs.get(tabId);
  if (tab.mutedInfo?.muted) await chrome.tabs.update(tabId, { muted: false });
}

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.mutedInfo?.muted) return;
  const { blasting = {} } = await chrome.storage.session.get('blasting');
  if ((blasting[tabId] || 0) > Date.now()) chrome.tabs.update(tabId, { muted: false }).catch(() => {});
});

// If the page refuses to autoplay sound in the overlay, an offscreen
// document (an invisible extension page) plays the audio instead.
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreen ||= chrome.offscreen
    .createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play the "limit reached" sound on the built-in speakers, or when the page blocks autoplay.',
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function playOffscreen({ video, youtube, clip, boostDb, outputMode, outputDevice }) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen', type: 'PLAY', video, youtube, clip, boostDb, outputMode, outputDevice,
  });
  if (res && !res.ok) throw new Error(res.error);
  return { device: res?.device ?? null };
}

async function endBlast(tabId) {
  if (tabId == null) return;
  const { blasting = {} } = await chrome.storage.session.get('blasting');
  delete blasting[tabId];
  await chrome.storage.session.set({ blasting });
}

async function stopOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP' });
  }
}

// ---------------------------------------------------------------------------
// Messages from the overlay, popup and options page

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;

  const reply = (p) => {
    p.then(
      (result) => sendResponse({ ok: true, ...(result && typeof result === 'object' ? result : {}) }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true; // keep the channel open for the async reply
  };

  switch (msg.type) {
    case 'BKB_REFRESH':
      return reply(refresh());
    case 'BKB_SNOOZE':
      return reply(snooze(msg.site));
    case 'BKB_CLOSE_TAB':
      return reply(sender.tab?.id != null ? chrome.tabs.remove(sender.tab.id) : Promise.resolve());
    case 'BKB_PLAY_AUDIO':
      return reply(playOffscreen(msg));
    case 'BKB_STOP_AUDIO':
      return reply(stopOffscreen());
    case 'BKB_BLAST_DONE':
      return reply(endBlast(sender.tab?.id));
  }
});
