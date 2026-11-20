import {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  getUsage,
  todayKey,
  normalizeSite,
  secondsForSite,
  formatDuration,
} from '../lib/common.js';
import { saveCustomVideo, loadCustomVideo, deleteCustomVideo, resolveVideoUrl } from '../lib/media-db.js';
import { parseYouTubeUrl, parseTime, fetchVideoInfo, createPlayer } from '../lib/youtube.js';
import { BOOST_LEVELS, listOutputDevices } from '../lib/loudness.js';

const $ = (id) => document.getElementById(id);
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const QUICK_ADD = [
  ['youtube.com', 30], ['instagram.com', 15], ['x.com', 15], ['facebook.com', 15],
  ['reddit.com', 20], ['netflix.com', 45], ['linkedin.com', 15], ['twitch.tv', 30],
];
const SITE_COLORS = ['#ff2d55', '#ffd60a', '#2f80ed', '#17b26a', '#9b51e0', '#f2994a'];

let settings = await getSettings();
let previewUrl = null;
let ytPlayer = null;

// ---------------------------------------------------------------------------
// Limits

function renderLimits() {
  $('limits').replaceChildren(
    ...settings.limits.map((limit, i) => {
      const li = document.createElement('li');
      const site = el('span', 'site', limit.site);
      const minutes = document.createElement('input');
      minutes.type = 'number';
      minutes.min = '1';
      minutes.max = '1440';
      minutes.value = limit.minutes;
      minutes.setAttribute('aria-label', `Minutes per day for ${limit.site}`);
      minutes.addEventListener('change', async () => {
        const v = clampInt(minutes.value, 1, 1440, limit.minutes);
        minutes.value = v;
        const limits = settings.limits.map((l, j) => (j === i ? { ...l, minutes: v } : l));
        await update({ limits });
      });
      const remove = el('button', 'ghost small', 'Remove');
      remove.addEventListener('click', () => update({ limits: settings.limits.filter((_, j) => j !== i) }));
      li.append(site, minutes, el('span', 'muted', 'min/day'), remove);
      return li;
    })
  );

  $('chips').replaceChildren(
    ...QUICK_ADD.filter(([s]) => !settings.limits.some((l) => l.site === s)).map(([s, m]) => {
      const b = el('button', 'small', `+ ${s}`);
      b.type = 'button';
      b.addEventListener('click', () => addLimit(s, m));
      return b;
    })
  );
}

async function addLimit(rawSite, minutes) {
  const site = normalizeSite(rawSite);
  const err = $('addError');
  if (!site) {
    err.textContent = "That doesn't look like a website. Try something like reddit.com";
    err.hidden = false;
    return false;
  }
  err.hidden = true;
  const limits = settings.limits.filter((l) => l.site !== site);
  limits.push({ site, minutes: clampInt(minutes, 1, 1440, 20) });
  await update({ limits });
  toast(`${site} is on the list`);
  return true;
}

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await addLimit($('addSite').value, $('addMinutes').value)) $('addSite').value = '';
});

// ---------------------------------------------------------------------------
// Video

async function renderVideo() {
  for (const r of document.querySelectorAll('input[name="video"]')) r.checked = r.value === settings.video;
  const custom = await loadCustomVideo().catch(() => null);
  $('customRadio').disabled = !custom;
  $('customName').textContent = custom ? custom.name : 'No custom video yet.';
  $('removeCustom').hidden = !custom;

  const yt = settings.youtube;
  $('youtubeRadio').disabled = !yt;
  if (yt) {
    if (document.activeElement !== $('ytUrl')) $('ytUrl').value = yt.url;
    $('ytStart').value = yt.start ? formatClock(yt.start) : '';
    $('ytEnd').value = yt.end ? formatClock(yt.end) : '';
    const span = yt.end ? `${formatClock(yt.start)}–${formatClock(yt.end)}` : `from ${formatClock(yt.start)}`;
    $('ytInfo').textContent = `${yt.title ? `“${yt.title}”` : yt.id} · plays ${span}`;
  }

  // Preview whatever is selected.
  ytPlayer?.destroy();
  ytPlayer = null;
  const showYt = settings.video === 'youtube' && yt;
  $('preview').hidden = !!showYt;
  $('ytPreview').hidden = !showYt;
  if (showYt) {
    $('preview').removeAttribute('src');
    ytPlayer = createPlayer($('ytPreview'), yt, { controls: true, autoplay: false });
  } else {
    if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
    previewUrl = await resolveVideoUrl(settings.video);
    $('preview').src = previewUrl;
  }
}

$('ytForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('ytError');
  const fail = (text) => {
    err.textContent = text;
    err.hidden = false;
  };
  err.hidden = true;

  const parsed = parseYouTubeUrl($('ytUrl').value);
  if (!parsed) return fail("That doesn't look like a YouTube link. Try https://youtu.be/… or a youtube.com/watch?v=… link.");
  const start = $('ytStart').value.trim() ? parseTime($('ytStart').value) : parsed.start;
  const end = $('ytEnd').value.trim() ? parseTime($('ytEnd').value) : 0;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return fail('Times look like 0:12, 1:05 or 75 (seconds).');
  if (end && end <= start) return fail('"Stop at" has to be after "Start at".');

  let title = '';
  try {
    title = (await fetchVideoInfo(parsed.id)).title;
  } catch (error) {
    if (String(error.message).includes('embedding disabled')) {
      return fail("The uploader doesn't allow this video to be embedded, so it can't play here. Pick another one.");
    }
    // Offline or YouTube hiccup: save anyway, the title is just cosmetic.
  }

  const url = `https://youtu.be/${parsed.id}${start ? `?t=${start}` : ''}`;
  await update({ youtube: { id: parsed.id, start, end, title, url }, video: 'youtube' });
  $('ytUrl').value = url;
  await renderVideo();
  toast(title ? `“${title}” it is` : 'YouTube video saved');
});

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

for (const radio of document.querySelectorAll('input[name="video"]')) {
  radio.addEventListener('change', () => update({ video: radio.value }).then(renderVideo));
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MAX_VIDEO_BYTES) return toast('Keep it under 60 MB, bhai');
  await saveCustomVideo(file, file.name);
  await update({ video: 'custom' });
  await renderVideo();
  toast('Custom video saved');
});

$('removeCustom').addEventListener('click', async () => {
  await deleteCustomVideo();
  await update({ video: 'default' });
  await renderVideo();
});

$('test').addEventListener('click', () => {
  $('preview').pause();
  ytPlayer?.pause();
  const frame = document.createElement('iframe');
  frame.className = 'test-frame';
  frame.allow = 'autoplay';
  frame.src = chrome.runtime.getURL('overlay/overlay.html?test=1');
  document.body.append(frame);
});

window.addEventListener('message', (e) => {
  if (e.data?.bkb !== 'close') return;
  for (const f of document.querySelectorAll('.test-frame')) if (f.contentWindow === e.source) f.remove();
});

// ---------------------------------------------------------------------------
// Loudness

$('boost').replaceChildren(
  ...BOOST_LEVELS.map(({ db, label }) => {
    const o = document.createElement('option');
    o.value = String(db);
    o.textContent = label;
    return o;
  })
);
$('boost').addEventListener('change', (e) => update({ boostDb: Number(e.target.value) }));

function renderOutputs(devices = []) {
  const saved = settings.outputDevice;
  const list = [...devices];
  if (saved?.id && !list.some((d) => d.id === saved.id)) list.push({ ...saved, label: `${saved.label} (not connected)` });
  const base = document.createElement('option');
  base.value = '';
  base.textContent = 'Whatever is playing now (default)';
  $('output').replaceChildren(
    base,
    ...list.map((d) => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.label;
      return o;
    })
  );
  $('output').value = saved?.id || '';
  $('output').dataset.devices = JSON.stringify(devices);
}

async function renderLoudness() {
  $('boost').value = String(settings.boostDb);
  renderOutputs();
  // Already allowed the mic once? Then list speakers without asking again.
  const perm = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
  if (perm?.state === 'granted') renderOutputs(await listOutputDevices().catch(() => []));
}

$('pickOutput').addEventListener('click', async () => {
  const err = $('outputError');
  err.hidden = true;
  try {
    const devices = await listOutputDevices();
    renderOutputs(devices);
    toast(devices.length ? `Found ${devices.length} output${devices.length === 1 ? '' : 's'}. Pick your speakers.` : 'No outputs found');
  } catch {
    err.textContent = 'Microphone access was blocked, so Chrome won\'t list your speakers. Allow it from the icon in the address bar and try again.';
    err.hidden = false;
  }
});

$('output').addEventListener('change', async (e) => {
  const id = e.target.value;
  const devices = JSON.parse(e.target.dataset.devices || '[]');
  const device = devices.find((d) => d.id === id) || (settings.outputDevice?.id === id ? settings.outputDevice : null);
  await update({ outputDevice: id && device ? { id, label: device.label.replace(/ \(not connected\)$/, '') } : null });
  toast(id ? `Blasting on ${device.label} from now on` : 'Back to the default output');
});

// ---------------------------------------------------------------------------
// Behaviour

function renderBehaviour() {
  $('nag').value = settings.nagEveryMinutes;
  $('snooze').value = settings.snoozeMinutes;
  $('pauseMedia').checked = settings.pausePageMedia;
  $('enabled').checked = settings.enabled;
}

$('nag').addEventListener('change', (e) =>
  update({ nagEveryMinutes: (e.target.value = clampInt(e.target.value, 1, 120, DEFAULT_SETTINGS.nagEveryMinutes)) })
);
$('snooze').addEventListener('change', (e) =>
  update({ snoozeMinutes: (e.target.value = clampInt(e.target.value, 1, 120, DEFAULT_SETTINGS.snoozeMinutes)) })
);
$('pauseMedia').addEventListener('change', (e) => update({ pausePageMedia: e.target.checked }));
$('enabled').addEventListener('change', (e) => update({ enabled: e.target.checked }));

// ---------------------------------------------------------------------------
// History

async function renderHistory() {
  const usage = await getUsage();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({ key: todayKey(d), date: d });
  }
  const sites = settings.limits.map((l) => l.site).slice(0, SITE_COLORS.length);
  const rows = days.map(({ key, date }) => {
    const day = usage[key] || {};
    const total = Object.values(day).reduce((a, b) => a + b, 0);
    const parts = sites.map((s) => secondsForSite(day, s));
    const other = Math.max(0, total - parts.reduce((a, b) => a + b, 0));
    return { key, date, total, parts, other };
  });
  const max = Math.max(60, ...rows.map((r) => r.total));

  const nodes = rows.map((r) => {
    const row = el('div', 'day');
    const label = i18nDay(r.date, r.key === todayKey());
    const stack = el('div', 'stack');
    stack.title = r.parts.map((s, i) => `${sites[i]}: ${formatDuration(s)}`).concat(`other: ${formatDuration(r.other)}`).join('\n');
    r.parts.forEach((secs, i) => secs > 0 && stack.append(seg(secs, max, SITE_COLORS[i])));
    if (r.other > 0) stack.append(seg(r.other, max, 'var(--muted)'));
    row.append(el('span', 'label', label), stack, el('span', 'total', formatDuration(r.total)));
    return row;
  });

  const legend = el('div', 'legend');
  sites.forEach((s, i) => legend.append(legendItem(s, SITE_COLORS[i])));
  legend.append(legendItem('everything else', 'var(--muted)'));

  $('history').replaceChildren(...nodes, legend);
}

function seg(secs, max, color) {
  const s = document.createElement('span');
  s.style.width = `${(secs / max) * 100}%`;
  s.style.background = color;
  return s;
}

function legendItem(text, color) {
  const span = document.createElement('span');
  const swatch = document.createElement('i');
  swatch.style.background = color;
  span.append(swatch, text);
  return span;
}

function i18nDay(date, isToday) {
  if (isToday) return 'Today';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Reset

$('resetToday').addEventListener('click', async () => {
  if (!confirm("Reset today's tracked time? Your limits start fresh.")) return;
  const usage = await getUsage();
  delete usage[todayKey()];
  await chrome.storage.local.set({ usage, nag: null });
  renderHistory();
  toast("Today's time wiped. Fresh start, don't waste it.");
});

$('resetAll').addEventListener('click', async () => {
  if (!confirm('Delete ALL tracked history? This cannot be undone.')) return;
  await chrome.storage.local.set({ usage: {}, nag: null });
  renderHistory();
  toast('History deleted');
});

// ---------------------------------------------------------------------------
// Helpers

async function update(patch) {
  settings = await saveSettings(patch);
  renderLimits();
  renderHistory();
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
}

// Keep in sync if the popup flips the switch while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    renderBehaviour();
    renderLimits();
  }
});

renderLimits();
renderBehaviour();
renderVideo();
renderLoudness();
renderHistory();
