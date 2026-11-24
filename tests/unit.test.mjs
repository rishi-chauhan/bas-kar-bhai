// Unit tests for the extension's pure helpers. Run with: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough of the extension API for the modules to load outside a browser.
globalThis.chrome = { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', getURL: (p) => `chrome-extension://x/${p}` } };

const lib = (name) => import(new URL(`../extension/lib/${name}`, import.meta.url));
const common = await lib('common.js');
const yt = await lib('youtube.js');
const loud = await lib('loudness.js');
const { loopClip } = await lib('loop.js');

test('todayKey pads month and day', () => {
  assert.equal(common.todayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(common.todayKey(new Date(2026, 11, 31)), '2026-12-31');
});

test('hostFromUrl strips www, ignores non-web pages', () => {
  assert.equal(common.hostFromUrl('https://www.YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(common.hostFromUrl('http://m.youtube.com/'), 'm.youtube.com');
  assert.equal(common.hostFromUrl('http://localhost:8080/x'), 'localhost');
  for (const u of ['chrome://extensions', 'file:///tmp/a', 'chrome-extension://x/y', 'about:blank', '', null, undefined, 'not a url'])
    assert.equal(common.hostFromUrl(u), null, String(u));
});

test('normalizeSite accepts what people type, rejects junk', () => {
  const ok = {
    'https://www.YouTube.com/feed': 'youtube.com', 'reddit.com': 'reddit.com', ' X.com ': 'x.com',
    'news.ycombinator.com/item?id=1': 'news.ycombinator.com', 'example.com:8080': 'example.com', 'localhost': 'localhost',
    'www.twitch.tv#x': 'twitch.tv',
  };
  for (const [i, o] of Object.entries(ok)) assert.equal(common.normalizeSite(i), o, i);
  for (const bad of ['', 'not a site', 'youtube', 'http://', '...', 'a b.com', null]) assert.equal(common.normalizeSite(bad), '', String(bad));
});

test('siteMatches covers subdomains but not lookalikes', () => {
  assert.ok(common.siteMatches('youtube.com', 'youtube.com'));
  assert.ok(common.siteMatches('music.youtube.com', 'youtube.com'));
  assert.ok(!common.siteMatches('notyoutube.com', 'youtube.com'));
  assert.ok(!common.siteMatches('youtube.com.evil.io', 'youtube.com'));
});

test('findLimit and secondsForSite', () => {
  const limits = [{ site: 'youtube.com', minutes: 30 }, { site: 'x.com', minutes: 15 }];
  assert.deepEqual(common.findLimit('m.youtube.com', limits), limits[0]);
  assert.equal(common.findLimit('github.com', limits), null);
  assert.equal(common.findLimit(null, limits), null);
  const day = { 'youtube.com': 100, 'music.youtube.com': 50.5, 'x.com': 10, 'notyoutube.com': 999 };
  assert.equal(common.secondsForSite(day, 'youtube.com'), 150.5);
  assert.equal(common.secondsForSite(undefined, 'youtube.com'), 0);
});

test('formatDuration', () => {
  assert.equal(common.formatDuration(0), '0s');
  assert.equal(common.formatDuration(-5), '0s');
  assert.equal(common.formatDuration(59.4), '59s');
  assert.equal(common.formatDuration(60), '1m');
  assert.equal(common.formatDuration(3599), '59m');
  assert.equal(common.formatDuration(3600), '1h 0m');
  assert.equal(common.formatDuration(4141), '1h 9m');
});

test('parseTime', () => {
  const cases = { '': 0, '90': 90, '75.9': 75, '1:30': 90, '1:02:03': 3723, '1m30s': 90, '2h': 7200, '45s': 45, '1h1m1s': 3661 };
  for (const [i, o] of Object.entries(cases)) assert.equal(yt.parseTime(i), o, i);
  assert.equal(yt.parseTime(null), 0);
  for (const bad of ['abc', '1:', '1::2', 'm', '-5']) assert.ok(Number.isNaN(yt.parseTime(bad)), bad);
});

test('parseYouTubeUrl handles every link shape', () => {
  const id = 'aqz-KE-bpKQ';
  const cases = {
    [id]: [id, 0],
    [`https://youtu.be/${id}`]: [id, 0],
    [`https://youtu.be/${id}?t=42`]: [id, 42],
    [`youtu.be/${id}?si=abc&t=1m5s`]: [id, 65],
    [`https://www.youtube.com/watch?v=${id}&t=90s`]: [id, 90],
    [`https://m.youtube.com/watch?v=${id}`]: [id, 0],
    [`https://music.youtube.com/watch?v=${id}&list=x`]: [id, 0],
    [`https://www.youtube.com/shorts/${id}`]: [id, 0],
    [`https://www.youtube.com/embed/${id}?start=12`]: [id, 12],
    [`https://www.youtube.com/live/${id}`]: [id, 0],
    [`https://www.youtube-nocookie.com/embed/${id}`]: [id, 0],
  };
  for (const [i, [oid, start]] of Object.entries(cases)) assert.deepEqual(yt.parseYouTubeUrl(i), { id: oid, start }, i);
  for (const bad of ['', 'https://vimeo.com/123', 'https://youtube.com/watch?v=short', 'https://evil.com/watch?v=' + id, 'https://youtube.com/channel/abc', 'https://youtu.be/']) {
    assert.equal(yt.parseYouTubeUrl(bad), null, bad);
  }
  assert.deepEqual(yt.parseYouTubeUrl(`https://youtu.be/${id}?t=garbage`), { id, start: 0 });
});

test('refererRule only targets our own embeds', () => {
  const r = yt.refererRule();
  assert.equal(r.id, yt.REFERER_RULE_ID);
  assert.match(r.condition.urlFilter, /youtube-nocookie\.com\/embed\/\*bkb=1$/);
  assert.deepEqual(r.condition.resourceTypes, ['sub_frame']);
  assert.equal(r.action.requestHeaders[0].value, `https://${chrome.runtime.id}.chromiumapp.org/`);
});

test('refererRule uses a valid hostname on Firefox', () => {
  const saved = globalThis.chrome.runtime;
  globalThis.chrome.runtime = { id: 'bas-kar-bhai@rishi-chauhan', getURL: (p) => `moz-extension://0d3c5a1e-1111-4222-8333-944455556666/${p}` };
  try {
    const value = yt.refererRule().action.requestHeaders[0].value;
    assert.equal(value, 'https://0d3c5a1e-1111-4222-8333-944455556666.chromiumapp.org/');
    assert.equal(new URL(value).username, '');
  } finally {
    globalThis.chrome.runtime = saved;
  }
});

test('pickSpeaker prefers built-in speakers, skips headphones/HDMI/virtual', () => {
  const pick = (labels) => loud.pickSpeaker(labels.map((label, i) => ({ id: String(i), label })))?.label ?? null;
  assert.equal(pick(['WH-1000XM4', 'MacBook Pro Speakers']), 'MacBook Pro Speakers');
  assert.equal(pick(['AirPods Pro', 'Speakers (Realtek(R) Audio)', 'LG HDR 4K (NVIDIA High Definition Audio)']), 'Speakers (Realtek(R) Audio)');
  assert.equal(pick(['Ryzen HD Audio Controller Analog Stereo', 'Jabra Evolve2']), 'Ryzen HD Audio Controller Analog Stereo');
  assert.equal(pick(['HDMI / DisplayPort 1', 'Bose QC45', 'Virtual Cable']), null);
  assert.equal(pick(['Steam Streaming Speakers']), null);
  assert.equal(pick([]), null);
  for (const b of loud.BOOST_LEVELS) assert.ok(Number.isFinite(b.db) && b.label);
});

test('chooseOutput modes', async () => {
  const devices = [
    { kind: 'audiooutput', deviceId: 'default', label: 'Default' },
    { kind: 'audiooutput', deviceId: 'a', label: 'AirPods' },
    { kind: 'audiooutput', deviceId: 'b', label: 'Built-in Speakers' },
    { kind: 'audioinput', deviceId: 'm', label: 'Mic' },
  ];
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { enumerateDevices: async () => devices } }, configurable: true });
  assert.equal(await loud.chooseOutput('default', null), null);
  assert.equal((await loud.chooseOutput('auto', null)).id, 'b');
  assert.equal((await loud.chooseOutput('manual', { id: 'a', label: 'AirPods' })).id, 'a');
  assert.equal((await loud.chooseOutput('manual', { id: 'stale', label: 'AirPods' })).id, 'a', 'falls back to the name');
  assert.equal((await loud.chooseOutput('manual', { id: 'gone', label: 'Gone' })).id, 'b', 'falls back to speakers');
  devices.forEach((d) => (d.label = ''));
  assert.equal(await loud.chooseOutput('auto', null), null, 'no mic permission -> default output');
});

test('loopClip jumps back to start at the end time and on ended', () => {
  const listeners = {};
  const media = {
    duration: 20, currentTime: 0, readyState: 1, loop: true, plays: 0,
    addEventListener: (t, f) => (listeners[t] = f), removeEventListener: (t) => delete listeners[t],
    play() { this.plays++; return Promise.resolve(); },
  };
  let laps = 0;
  const stop = loopClip(media, { start: 5, end: 8 }, () => laps++);
  assert.equal(media.loop, false);
  assert.equal(media.currentTime, 5, 'seeks to start once metadata is there');
  media.currentTime = 7.9; listeners.timeupdate();
  assert.equal(laps, 0);
  media.currentTime = 8.01; listeners.timeupdate();
  assert.equal(media.currentTime, 5); assert.equal(laps, 1);
  media.currentTime = 20; listeners.ended();
  assert.equal(media.currentTime, 5); assert.equal(laps, 2);
  stop();
  assert.deepEqual(Object.keys(listeners), []);

  // A start past the end of a short file plays from 0 instead of looping on nothing.
  const m2 = { ...media, duration: 3, currentTime: 0, addEventListener() {}, removeEventListener() {} };
  loopClip(m2, { start: 10 });
  assert.equal(m2.currentTime, 0);
});

test('saveSettings keeps both of two back-to-back changes', async () => {
  // Fake storage with slow reads, so overlapping read-merge-write cycles would clobber each other.
  let stored = {};
  globalThis.chrome.storage = {
    local: {
      get: async (key) => { await new Promise((r) => setTimeout(r, 20)); return { [key]: structuredClone(stored[key]) }; },
      set: async (obj) => { await new Promise((r) => setTimeout(r, 5)); Object.assign(stored, structuredClone(obj)); },
    },
  };
  try {
    await Promise.all([common.saveSettings({ nagEveryMinutes: 9 }), common.saveSettings({ snoozeMinutes: 7 })]);
    const s = await common.getSettings();
    assert.equal(s.nagEveryMinutes, 9);
    assert.equal(s.snoozeMinutes, 7);
    assert.equal(s.boostDb, common.DEFAULT_SETTINGS.boostDb, 'untouched settings keep their defaults');
  } finally {
    delete globalThis.chrome.storage;
  }
});

// --- sync across browsers (lib/sync.js)

const sync = await lib('sync.js');
const NOW = new Date(2026, 10, 24, 15, 0).getTime();
const DAY = (ago) => common.todayKey(new Date(NOW - ago * 86400000));

test('snapshot shares the last 7 days in whole seconds', () => {
  const usage = { [DAY(0)]: { 'a.com': 10.4, 'b.com': 0.2 }, [DAY(6)]: { 'c.com': 5 }, [DAY(7)]: { 'old.com': 99 } };
  const item = sync.snapshot(usage, { id: 'me', name: 'Laptop' }, NOW);
  assert.deepEqual(item, { name: 'Laptop', seen: NOW, days: { [DAY(0)]: { 'a.com': 10 }, [DAY(6)]: { 'c.com': 5 } } });
});

test('snapshot fits in one sync item: oldest days go first, then the smallest sites', () => {
  const big = (n, secs) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`site-number-${i}.example.com`, secs + i]));
  const usage = {};
  for (let i = 0; i < 7; i++) usage[DAY(i)] = big(60, 100);
  const item = sync.snapshot(usage, { id: 'me', name: 'Laptop' }, NOW);
  assert.ok(sync.itemBytes('d:me', item) <= sync.ITEM_BUDGET);
  assert.ok(item.days[DAY(0)], 'today is kept');
  assert.ok(!item.days[DAY(6)], 'the oldest day went first');

  // Even today alone too big: the biggest sites survive.
  const huge = sync.snapshot({ [DAY(0)]: big(400, 100) }, { id: 'me', name: 'x' }, NOW);
  const kept = Object.keys(huge.days[DAY(0)]);
  assert.ok(sync.itemBytes('d:me', huge) <= sync.ITEM_BUDGET && kept.length > 50 && kept.length < 400);
  assert.ok(kept.includes('site-number-399.example.com') && !kept.includes('site-number-0.example.com'));
});

test('combine adds other devices, never this one, and skips non-device keys', () => {
  const local = { [DAY(0)]: { 'a.com': 10 } };
  const items = {
    'd:me': { seen: NOW, days: { [DAY(0)]: { 'a.com': 999 } } },
    'd:pc': { seen: NOW, days: { [DAY(0)]: { 'a.com': 5, 'b.com': 7 }, [DAY(1)]: { 'a.com': 1 } } },
    'd:broken': null,
    other: { days: { [DAY(0)]: { 'a.com': 1000 } } },
  };
  const out = sync.combine(local, items, { id: 'me' });
  assert.deepEqual(out, { [DAY(0)]: { 'a.com': 15, 'b.com': 7 }, [DAY(1)]: { 'a.com': 1 } });
  assert.deepEqual(local, { [DAY(0)]: { 'a.com': 10 } }, 'local usage is not modified');
});

test('a reset hides data from before it until each device applies it', () => {
  const local = { [DAY(0)]: { 'a.com': 10 }, [DAY(1)]: { 'a.com': 3 } };
  const items = {
    reset: { today: { day: DAY(0), at: NOW } },
    'd:stale': { seen: NOW - 1000, days: { [DAY(0)]: { 'a.com': 50 }, [DAY(1)]: { 'a.com': 4 } } },
    'd:fresh': { seen: NOW + 1000, days: { [DAY(0)]: { 'a.com': 2 } } },
  };
  assert.deepEqual(sync.combine(local, items, { id: 'me', applied: 0 }), { [DAY(1)]: { 'a.com': 7 }, [DAY(0)]: { 'a.com': 2 } });
  assert.deepEqual(sync.combine(local, items, { id: 'me', applied: NOW }), { [DAY(0)]: { 'a.com': 12 }, [DAY(1)]: { 'a.com': 7 } });
  // "Delete all" hides every day from before it.
  items.reset.all = NOW + 500;
  assert.deepEqual(sync.combine(local, items, { id: 'me', applied: NOW }), { [DAY(0)]: { 'a.com': 2 } });
});

test('applyReset wipes what the marker says, once', () => {
  const usage = { [DAY(0)]: { 'a.com': 10 }, [DAY(1)]: { 'a.com': 3 } };
  assert.equal(sync.applyReset(usage, undefined, 0), null);
  assert.deepEqual(sync.applyReset(usage, { today: { day: DAY(0), at: 5 } }, 0), { usage: { [DAY(1)]: { 'a.com': 3 } }, applied: 5 });
  assert.equal(sync.applyReset(usage, { today: { day: DAY(0), at: 5 } }, 5), null, 'already applied');
  assert.deepEqual(sync.applyReset(usage, { all: 9, today: { day: DAY(0), at: 5 } }, 5), { usage: {}, applied: 9 });
});

test('defaultDeviceName names the browser and the OS', () => {
  assert.equal(sync.defaultDeviceName('Linux x86_64'), 'Chrome on Linux');
  assert.equal(sync.defaultDeviceName('macOS'), 'Chrome on Mac');
  assert.equal(sync.defaultDeviceName('Win32'), 'Chrome on Windows');
  assert.equal(sync.defaultDeviceName(''), 'Chrome on a computer');
});
