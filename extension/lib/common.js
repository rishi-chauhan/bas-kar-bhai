// Shared helpers used by the background worker, popup, options and overlay.

export const DEFAULT_SETTINGS = {
  enabled: true,
  limits: [
    { site: 'youtube.com', minutes: 30 },
    { site: 'instagram.com', minutes: 15 },
    { site: 'x.com', minutes: 15 },
    { site: 'facebook.com', minutes: 15 },
  ],
  // While you stay on a site past its limit, the video replays this often.
  nagEveryMinutes: 2,
  // "5 more minutes, please" buys you this much peace.
  snoozeMinutes: 5,
  // 'default' = bundled siren video, 'custom' = the one you uploaded,
  // 'youtube' = a YouTube link (see `youtube`).
  video: 'default',
  // { id, start, end, title, url } when a YouTube link is set.
  youtube: null,
  // Pause whatever the page itself is playing so the blast is the only sound.
  pausePageMedia: true,
  // Extra loudness for the bundled/uploaded video (see lib/loudness.js).
  boostDb: 12,
  // { id, label } of an output device to always blast on, or null for default.
  outputDevice: null,
};

// Usage older than this many days is dropped.
export const KEEP_DAYS = 30;

export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Hostname without "www.", or null for pages we don't track (chrome://, file://, ...).
export function hostFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

// Turn whatever the user typed ("https://www.YouTube.com/feed") into "youtube.com".
export function normalizeSite(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/:\d+$/, '');
  s = s.replace(/^www\./, '');
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(s) || s === 'localhost' ? s : '';
}

// A limit on "youtube.com" also covers "m.youtube.com", "music.youtube.com", etc.
export function siteMatches(host, site) {
  return host === site || host.endsWith('.' + site);
}

export function findLimit(host, limits) {
  if (!host) return null;
  return limits.find((l) => siteMatches(host, l.site)) || null;
}

// Seconds spent today on a site, summing all of its subdomains.
export function secondsForSite(dayUsage, site) {
  let total = 0;
  for (const [host, secs] of Object.entries(dayUsage || {})) {
    if (siteMatches(host, site)) total += secs;
  }
  return total;
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getUsage() {
  const { usage } = await chrome.storage.local.get('usage');
  return usage || {};
}
