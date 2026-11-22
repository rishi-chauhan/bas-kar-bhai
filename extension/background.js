// Bas Kar Bhai — background service worker (Chrome) / event page (Firefox).
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

// Runs every time the worker starts. Missing settings need no setup: every
// reader merges in DEFAULT_SETTINGS (see getSettings).
async function setup() {
  chrome.idle.setDetectionInterval(IDLE_AFTER_SECONDS);
  if (!(await chrome.alarms.get(TICK_ALARM))) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  // Lets YouTube embeds play inside our pages (see lib/youtube.js).
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [REFERER_RULE_ID],
    addRules: [refererRule()],
  });
}
const ready = setup().catch((err) => console.warn('[bas-kar-bhai] setup failed', err));

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ready;
  if (reason === 'install') chrome.runtime.openOptionsPage();
  refresh();
});
chrome.runtime.onStartup.addListener(() => refresh());

// ---------------------------------------------------------------------------
// Events that can change what you're looking at

chrome.tabs.onActivated.addListener(() => refresh());
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.mutedInfo?.muted) keepUnmuted(tabId);
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
// counted twice. Errors are logged here, so callers never see a rejection.
let queue = Promise.resolve();
function serial(fn) {
  queue = queue.then(fn).catch((err) => console.warn('[bas-kar-bhai]', err));
  return queue;
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

  const nag = await getNag(day);
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

// When the blast may next fire on each site today: { day, next: { [site]: ms } }.
async function getNag(day) {
  const { nag } = await chrome.storage.local.get('nag');
  return nag?.day === day ? nag : { day, next: {} };
}

async function snooze(site) {
  const settings = await getSettings();
  const nag = await getNag(todayKey());
  nag.next[site] = Date.now() + settings.snoozeMinutes * 60000;
  await chrome.storage.local.set({ nag });
}

// ---------------------------------------------------------------------------
// The blast

async function blast(tabId, info) {
  try {
    const query = new URLSearchParams({ token: await issueBlastToken(tabId, info) }).toString();
    // A tab you muted in the browser would swallow the blast. Not today.
    await unmuteForBlast(tabId);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/inject.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'BKB_SHOW', query, pauseMedia: info.pauseMedia });
  } catch (err) {
    // Some pages (browser stores, PDFs, ...) don't allow scripts.
    console.warn('[bas-kar-bhai] could not show overlay on tab', tabId, err);
  }
}

// The overlay page is web-accessible (it has to be framed on the offending
// site), so any website could frame it. It only plays when it can trade a
// token for the blast details, and a token works once, only for the tab it
// was issued for, and only for a short while.
const BLAST_TOKEN_TTL_MS = 60 * 1000;

async function issueBlastToken(tabId, { site, used, limit }) {
  const now = Date.now();
  const token = crypto.randomUUID();
  const { blastTokens = {} } = await chrome.storage.session.get('blastTokens');
  for (const [t, b] of Object.entries(blastTokens)) if (b.expires < now) delete blastTokens[t];
  blastTokens[token] = { tabId, site, used, limit, expires: now + BLAST_TOKEN_TTL_MS };
  await chrome.storage.session.set({ blastTokens });
  return token;
}

async function claimBlast(token, tabId) {
  const { blastTokens = {} } = await chrome.storage.session.get('blastTokens');
  const b = blastTokens[token];
  if (!b) return { blast: null };
  delete blastTokens[token];
  await chrome.storage.session.set({ blastTokens });
  if (b.tabId !== tabId || b.expires < Date.now()) return { blast: null };
  return { blast: { site: b.site, used: b.used, limit: b.limit } };
}

// Unmute the tab, and keep it unmuted for a while in case you reach for
// "Mute site" mid-blast.
const UNMUTE_GUARD_MS = 90 * 1000;

// `blasting` maps tab id -> until when that tab must stay unmuted.
async function unmuteForBlast(tabId) {
  const now = Date.now();
  const { blasting = {} } = await chrome.storage.session.get('blasting');
  for (const [id, until] of Object.entries(blasting)) if (until < now) delete blasting[id];
  blasting[tabId] = now + UNMUTE_GUARD_MS;
  await chrome.storage.session.set({ blasting });
  const tab = await chrome.tabs.get(tabId);
  if (tab.mutedInfo?.muted) await chrome.tabs.update(tabId, { muted: false });
}

// Called when a tab gets muted: undo it if that tab is mid-blast.
async function keepUnmuted(tabId) {
  const { blasting = {} } = await chrome.storage.session.get('blasting');
  if ((blasting[tabId] || 0) > Date.now()) chrome.tabs.update(tabId, { muted: false }).catch(() => {});
}

// If the page refuses to autoplay sound in the overlay, the extension plays
// it somewhere invisible instead (see lib/player.js). Chrome needs an
// offscreen document for that. Firefox has none, but its background page has
// a DOM, so it plays right here.
const HAS_OFFSCREEN = !!chrome.offscreen;
let localPlayer = null;
const player = () => (localPlayer ||= import('./lib/player.js'));

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

async function playAudio({ video, youtube, clip, boostDb, outputMode, outputDevice }) {
  const opts = { video, youtube, clip, boostDb, outputMode, outputDevice };
  if (!HAS_OFFSCREEN) return (await player()).play(opts);
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PLAY', ...opts });
  if (res && !res.ok) throw new Error(res.error);
  return { device: res?.device ?? null };
}

async function endBlast(tabId) {
  if (tabId == null) return;
  const { blasting = {} } = await chrome.storage.session.get('blasting');
  delete blasting[tabId];
  await chrome.storage.session.set({ blasting });
}

async function stopAudio() {
  if (!HAS_OFFSCREEN) return localPlayer && (await localPlayer).stop();
  if (await chrome.offscreen.hasDocument()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP' });
  }
}

// Whether the background sound is playing: { playing }.
async function audioStatus() {
  if (!HAS_OFFSCREEN) return localPlayer ? (await localPlayer).status() : { playing: false };
  if (!(await chrome.offscreen.hasDocument())) return { playing: false };
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STATUS' });
  return { playing: !!res?.playing };
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
    case 'BKB_CLAIM_BLAST':
      return reply(claimBlast(String(msg.token || ''), sender.tab?.id));
    case 'BKB_REFRESH':
      return reply(refresh());
    case 'BKB_SNOOZE':
      return reply(snooze(msg.site));
    case 'BKB_CLOSE_TAB':
      return reply(sender.tab?.id != null ? chrome.tabs.remove(sender.tab.id) : Promise.resolve());
    case 'BKB_PLAY_AUDIO':
      return reply(playAudio(msg));
    case 'BKB_STOP_AUDIO':
      return reply(stopAudio());
    case 'BKB_AUDIO_STATUS':
      return reply(audioStatus());
    // Sent by the overlay while the background plays the sound, so Firefox
    // doesn't unload its idle background page mid-blast.
    case 'BKB_KEEPALIVE':
      return reply(Promise.resolve());
    case 'BKB_BLAST_DONE':
      return reply(endBlast(sender.tab?.id));
  }
});
