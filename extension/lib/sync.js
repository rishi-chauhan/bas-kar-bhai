// Screen time from all your browsers, through the browser's own sync
// (Chrome sync, or Firefox Sync). We run no server and store nothing.
//
// How it works:
//   * Each browser ("device") has a random id and keeps tracking into its own
//     local usage, exactly as without sync.
//   * About once a minute it copies the last few days of its usage into ONE
//     item of chrome.storage.sync, keyed `d:<id>`. It never writes anyone
//     else's item, so devices can't overwrite each other or count twice.
//   * Everyone reads all the `d:` items and adds the other devices' time to
//     their own. That combined usage is what limits, the popup and the
//     history use.
//   * "Reset" has to reach devices that own their own numbers, so it is a
//     marker (`reset`) that every device applies to its own usage. Until a
//     device has done so, its old numbers are ignored.

import { todayKey, getUsage, IS_FIREFOX } from './common.js';

// How many days (today included) each device shares. The history shows 7.
export const SYNC_DAYS = 7;
// A device that hasn't synced for this long is dropped, to free space.
export const FORGET_AFTER_DAYS = 30;
// Push at most this often. Browsers allow ~30 sync writes a minute on average.
export const PUSH_EVERY_MS = 60 * 1000;
// Browsers cap one sync item at 8192 bytes (key + JSON). Stay under it.
export const ITEM_BUDGET = 7600;

export const DEVICE_PREFIX = 'd:';
export const RESET_KEY = 'reset';

export const SYNC_SERVICE = IS_FIREFOX ? 'Firefox Sync' : 'Chrome sync';

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)

export function itemBytes(key, value) {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}

// The item this device shares: the last SYNC_DAYS days of `usage`, whole
// seconds, trimmed to fit in one sync item. If it doesn't fit, older days go
// first, then the sites with the least time.
export function snapshot(usage, { id, name }, now = Date.now()) {
  const keys = [];
  for (let i = 0; i < SYNC_DAYS; i++) keys.push(todayKey(new Date(now - i * 86400000)));
  const days = {};
  for (const key of keys) {
    const day = {};
    for (const [host, secs] of Object.entries(usage[key] || {})) {
      const s = Math.round(secs);
      if (s > 0) day[host] = s;
    }
    if (Object.keys(day).length) days[key] = day;
  }
  const item = { name, seen: now, days };
  const fits = () => itemBytes(DEVICE_PREFIX + id, item) <= ITEM_BUDGET;
  // Oldest day first, but never today.
  for (const key of keys.slice(1).reverse()) {
    if (fits()) break;
    delete days[key];
  }
  const today = days[keys[0]];
  if (today) {
    const smallest = Object.keys(today).sort((a, b) => today[a] - today[b]);
    while (!fits() && smallest.length) delete today[smallest.shift()];
  }
  return item;
}

// Whether data last brought up to date at `at` predates a reset of `day`.
export function wipedBy(reset, at, day) {
  if (!reset) return false;
  if ((reset.all || 0) > at) return true;
  return reset.today?.day === day && reset.today.at > at;
}

// Local usage plus every other device's shared days, as one usage object.
// `items` is everything in chrome.storage.sync.
export function combine(usage, items, { id, applied = 0 }) {
  const reset = items[RESET_KEY];
  const out = {};
  for (const [day, hosts] of Object.entries(usage)) {
    if (!wipedBy(reset, applied, day)) out[day] = { ...hosts };
  }
  for (const [key, item] of Object.entries(items)) {
    if (!key.startsWith(DEVICE_PREFIX) || key === DEVICE_PREFIX + id || !item?.days) continue;
    for (const [day, hosts] of Object.entries(item.days)) {
      if (wipedBy(reset, item.seen || 0, day)) continue;
      const into = (out[day] ||= {});
      for (const [host, secs] of Object.entries(hosts)) into[host] = (into[host] || 0) + secs;
    }
  }
  return out;
}

// A reset marker this device hasn't applied yet, applied to `usage`.
// Returns null when there's nothing to do.
export function applyReset(usage, reset, applied = 0) {
  if (!reset) return null;
  const all = reset.all || 0;
  const today = reset.today?.at || 0;
  if (Math.max(all, today) <= applied) return null;
  const next = all > applied ? {} : { ...usage };
  if (today > applied) delete next[reset.today.day];
  return { usage: next, applied: Math.max(all, today, applied) };
}

// "Chrome on Linux", "Firefox on Mac", ...
export function defaultDeviceName(platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '') {
  const p = platform.toLowerCase();
  const os = p.includes('mac') ? 'Mac'
    : p.includes('win') ? 'Windows'
    : p.includes('cros') || p.includes('chrome os') ? 'ChromeOS'
    : p.includes('linux') ? 'Linux'
    : 'a computer';
  return `${IS_FIREFOX ? 'Firefox' : 'Chrome'} on ${os}`;
}

// ---------------------------------------------------------------------------
// Storage

// This browser's sync state, in chrome.storage.local (it never syncs itself):
// { enabled, id, name, applied, pushedAt, error }. `applied` = the newest
// reset marker this device has applied. Only the background writes it.
export async function getSyncState() {
  const { sync } = await chrome.storage.local.get('sync');
  return { enabled: false, applied: 0, pushedAt: 0, error: '', ...(sync || {}) };
}

async function saveSyncState(patch) {
  const next = { ...(await getSyncState()), ...patch };
  await chrome.storage.local.set({ sync: next });
  return next;
}

// Everything in sync storage, or {} when it can't be read.
async function syncItems() {
  try {
    return await chrome.storage.sync.get(null);
  } catch (err) {
    console.warn('[bas-kar-bhai] could not read sync storage', err);
    return {};
  }
}

// Today's (and recent days') usage, including other devices when sync is on.
export async function getCombinedUsage() {
  const [usage, state] = await Promise.all([getUsage(), getSyncState()]);
  if (!state.enabled || !state.id) return usage;
  return combine(usage, await syncItems(), state);
}

// Every device sharing time, this one first:
// [{ id, name, seen, today (seconds), self }]. Empty while sync is off.
export async function listDevices(now = Date.now()) {
  const state = await getSyncState();
  if (!state.enabled || !state.id) return [];
  const [items, usage] = await Promise.all([syncItems(), getUsage()]);
  const day = todayKey(new Date(now));
  const sum = (hosts) => Object.values(hosts || {}).reduce((a, b) => a + b, 0);
  const reset = items[RESET_KEY];
  const self = { id: state.id, name: state.name, seen: now, self: true, today: wipedBy(reset, state.applied, day) ? 0 : sum(usage[day]) };
  const others = Object.entries(items)
    .filter(([key, item]) => key.startsWith(DEVICE_PREFIX) && key !== DEVICE_PREFIX + state.id && item?.days)
    .map(([key, item]) => ({
      id: key.slice(DEVICE_PREFIX.length),
      name: item.name || 'Unnamed browser',
      seen: item.seen || 0,
      self: false,
      today: wipedBy(reset, item.seen || 0, day) ? 0 : sum(item.days[day]),
    }))
    .sort((a, b) => b.seen - a.seen);
  return [self, ...others];
}

// ---------------------------------------------------------------------------
// Background only. Call these one at a time (the background's queue), since
// they read and write local usage.

// Give this browser an id and a name the first time it runs.
export async function ensureDevice() {
  const state = await getSyncState();
  if (state.id) return state;
  return saveSyncState({ id: crypto.randomUUID(), name: defaultDeviceName() });
}

// Apply a reset another device asked for.
export async function applyPendingReset() {
  const state = await getSyncState();
  if (!state.enabled) return;
  const { [RESET_KEY]: reset } = await chrome.storage.sync.get(RESET_KEY);
  const done = applyReset(await getUsage(), reset, state.applied);
  if (!done) return;
  await chrome.storage.local.set({ usage: done.usage, nag: null });
  await saveSyncState({ applied: done.applied });
}

// Share this device's usage, if sync is on and the last push is old enough.
export async function maybePush(now = Date.now(), { force = false } = {}) {
  const state = await getSyncState();
  if (!state.enabled || !state.id) return;
  if (!force && now - state.pushedAt < PUSH_EVERY_MS) return;
  try {
    await applyPendingReset();
    const item = snapshot(await getUsage(), state, now);
    const items = await chrome.storage.sync.get(null);
    const stale = Object.entries(items)
      .filter(([key, it]) => key.startsWith(DEVICE_PREFIX) && key !== DEVICE_PREFIX + state.id && (it?.seen || 0) < now - FORGET_AFTER_DAYS * 86400000)
      .map(([key]) => key);
    if (stale.length) await chrome.storage.sync.remove(stale);
    await chrome.storage.sync.set({ [DEVICE_PREFIX + state.id]: item });
    await saveSyncState({ pushedAt: now, error: '' });
  } catch (err) {
    console.warn('[bas-kar-bhai] sync failed', err);
    // Try again on the next tick rather than in a minute.
    await saveSyncState({ error: String(err?.message || err) });
  }
}

// Turn sharing on or off, and/or rename this browser.
export async function configureSync({ enabled, name }) {
  const state = await ensureDevice();
  const patch = {};
  if (typeof name === 'string') patch.name = name.trim().slice(0, 40) || defaultDeviceName();
  if (typeof enabled === 'boolean') patch.enabled = enabled;
  // Resets from before you joined aren't meant for you.
  if (enabled && !state.enabled) {
    const { [RESET_KEY]: reset } = await chrome.storage.sync.get(RESET_KEY).catch(() => ({}));
    patch.applied = Math.max(state.applied, reset?.all || 0, reset?.today?.at || 0);
    patch.error = '';
  }
  const next = await saveSyncState(patch);
  if (next.enabled) await maybePush(Date.now(), { force: true });
  // Leaving: take your time out of everyone else's totals.
  else if (enabled === false) await chrome.storage.sync.remove(DEVICE_PREFIX + state.id).catch(() => {});
  return next;
}

// Stop counting a device that no longer exists (it comes back if it's still
// syncing).
export async function forgetDevice(id) {
  const state = await getSyncState();
  if (!id || id === state.id) return;
  await chrome.storage.sync.remove(DEVICE_PREFIX + id);
}

// Wipe today's time, or all of it, here and (with sync on) on every device.
export async function resetUsage(kind, now = Date.now()) {
  const usage = kind === 'all' ? {} : await getUsage();
  if (kind !== 'all') delete usage[todayKey(new Date(now))];
  await chrome.storage.local.set({ usage, nag: null });
  const state = await getSyncState();
  if (!state.enabled) return;
  const { [RESET_KEY]: prev = {} } = await chrome.storage.sync.get(RESET_KEY);
  const reset = kind === 'all' ? { ...prev, all: now } : { ...prev, today: { day: todayKey(new Date(now)), at: now } };
  await chrome.storage.sync.set({ [RESET_KEY]: reset });
  await saveSyncState({ applied: now });
  await maybePush(now, { force: true });
}
