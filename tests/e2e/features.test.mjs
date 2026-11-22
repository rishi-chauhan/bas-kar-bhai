// End-to-end tests of every user-facing feature, in a real headless browser.
// Run with: npm run test:e2e   (see tests/e2e/browser.mjs for picking the browser)
//
// Steps run in order and build on each other (the same browser profile and
// usage data throughout), like one long session of someone using the extension.

import { test } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXT_DIR, skipReason, launch, serve, connect, waitFor, sleep, problems, online } from './browser.mjs';

const skip = skipReason();
const youtubeSkip = skip || ((await online()) ? false : 'YouTube is not reachable');
const LIMITED = '127.0.0.1';

function check(cond, msg, detail) {
  if (!cond) throw new Error(`${msg}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`);
  return detail;
}
// One test step. Whatever the step returns is printed as a diagnostic.
const t = (name, fn, opts = {}) => test(name, { skip, timeout: 60000, ...opts }, async (ctx) => {
  const detail = await fn();
  if (detail !== undefined && detail !== true) ctx.diagnostic(JSON.stringify(detail).slice(0, 300));
});
// A step that needs to reach YouTube.
const ty = (name, fn) => t(name, fn, { skip: youtubeSkip });

if (skip) {
  test('feature tests', { skip }, () => {});
} else {
  // The "websites" the tests visit, plus files to upload.
  const fixtures = mkdtempSync(join(tmpdir(), 'bkb-site-'));
  copyFileSync(join(EXT_DIR, 'media/default.mp4'), join(fixtures, 'clip.mp4'));
  copyFileSync(join(EXT_DIR, 'media/default.mp4'), join(fixtures, 'my-clip.mp4'));
  writeFileSync(join(fixtures, 'huge.mp4'), '');
  truncateSync(join(fixtures, 'huge.mp4'), 61 * 1024 * 1024);
  writeFileSync(join(fixtures, 'index.html'), `<!doctype html><title>limited</title>
    <h1>time-wasting site</h1><video id="pv" src="clip.mp4" muted loop autoplay playsinline width="320"></video>
    <div id="fs" style="background:#ccc;height:200px">fullscreen me</div>`);
  writeFileSync(join(fixtures, 'other.html'), '<!doctype html><title>other</title><p>unlimited site');

  const web = await serve(fixtures);
  const PAGE = `http://127.0.0.1:${web.port}/`;
  // Block autoplay-with-sound like a page nobody has clicked yet, so the
  // background-sound fallback is exercised every time.
  const b = await launch({ autoplayBlocked: true });

  try {
    // Watch Chrome's service worker for errors the whole time. (Firefox's
    // background page isn't reachable over WebDriver BiDi.)
    if (b.kind === 'chrome') {
      const swT = await waitFor(async () => (await b.targets()).find((t) => t.type === 'service_worker' && t.url.startsWith(b.base)), { what: 'service worker' });
      await connect(swT, 'service worker');
    }

    const optT = await b.open(`${b.base}/options/options.html`);
    const o = await connect(optT, 'options');
    // Any real dialog is accepted (the reset buttons' confirm() is stubbed below for determinism).
    await o.acceptDialogs();
    await waitFor(() => o.ev(`document.getElementById('limits').children.length > 0`), { what: 'options render' });

    const ev = o.ev;
    // Reload the settings page and wait for the *new* document to finish rendering.
    async function reloadOptions() {
      await o.ev(`window.__stale = true`);
      await o.reload();
      await waitFor(() => o.ev(`!window.__stale && document.querySelectorAll('#history .day').length === 7 && document.getElementById('limits').children.length > 0`), { what: 'options reload' });
    }
    const refresh = () => ev(`chrome.runtime.sendMessage({ type: 'BKB_REFRESH' }).then((r) => r.ok)`);
    const local = (key) => ev(`chrome.storage.local.get('${key}').then((r) => r['${key}'])`);
    const settings = () => ev(`chrome.storage.local.get('settings').then((r) => r.settings)`);
    const setSettings = (patch) => ev(`(async () => { const { settings: s } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...s, ...${JSON.stringify(patch)} } }); return true; })()`);
    const today = () => ev(`(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })()`);
    const usageOf = async (host) => ((await local('usage')) || {})[await today()]?.[host] || 0;
    const badge = (tabId) => ev(`chrome.action.getBadgeText({ tabId: ${tabId} })`);
    const tabMuted = (tabId) => ev(`chrome.tabs.get(${tabId}).then((t) => !!t.mutedInfo?.muted)`);
    const tabIdFor = (url) => waitFor(() => ev(`chrome.tabs.query({}).then((ts) => (ts.find((t) => t.url === ${JSON.stringify(url)}) || {}).id)`), { what: 'tab id' });

    async function openPage(path = '') {
      const url = PAGE + path;
      const t = await b.open(url);
      const p = await connect(t, 'page ' + path);
      await b.activate(t.id);
      await p.front();
      await waitFor(() => p.ev(`document.readyState === 'complete'`), { what: 'page load' });
      return { t, p, tabId: await tabIdFor(url) };
    }
    const overlayCount = (p) => p.ev(`document.querySelectorAll('iframe[src*="/overlay/overlay.html"]').length`);
    async function overlayFrame(pageTarget, seen = new Set()) {
      const t = await waitFor(async () => (await b.targets()).find((t) => t.type === 'iframe' && t.url.includes('/overlay/overlay.html?token=') && !seen.has(t.id) && (!t.parentId || t.parentId === pageTarget.id)), { what: 'overlay frame target' });
      seen.add(t.id);
      const f = await connect(t, 'overlay');
      await waitFor(() => f.ev(`document.getElementById('stats').textContent.length > 0`), { what: 'overlay stats' });
      return f;
    }
    // Is the sound playing in the background (Chrome's offscreen page, Firefox's background page)?
    const backgroundPlaying = () => ev(`chrome.runtime.sendMessage({ type: 'BKB_AUDIO_STATUS' }).then((r) => r.playing)`);

    await ev(`(async () => { await chrome.storage.local.set({ settings: { ...(await chrome.storage.local.get('settings')).settings,
      limits: [{ site: '${LIMITED}', minutes: 2 }], outputMode: 'default', boostDb: 12 }, usage: {}, nag: null }); return true; })()`);

    // ------------------------------------------------------------------ tracking
    const pg = await openPage('');
    await t('time is credited to the site in front of you', async () => {
      await refresh();
      const before = await usageOf(LIMITED);
      await sleep(4000);
      await refresh();
      const got = (await usageOf(LIMITED)) - before;
      return check(got >= 3 && got <= 6, 'expected ~4s', { credited: got });
    });
    await t('badge counts down the minutes left', async () => check((await badge(pg.tabId)) === '2m', 'badge', await badge(pg.tabId)));

    await t('sites without a limit are tracked but get no badge', async () => {
      const other = `http://localhost:${web.port}/other.html`;
      const t = await b.open(other);
      const p = await connect(t, 'other');
      await b.activate(t.id); await p.front();
      await sleep(800); await refresh(); await sleep(2500); await refresh();
      const tabId = await tabIdFor(other);
      const r = { localhost: await usageOf('localhost'), badge: await badge(tabId) };
      p.close(); await b.close(t.id);
      await b.activate(pg.t.id); await pg.p.front(); await sleep(500); await refresh();
      return check(r.localhost >= 1.5 && r.badge === '', 'unlimited site', r);
    });

    await t('page video is playing before the blast', async () => check(await waitFor(() => pg.p.ev(`!document.getElementById('pv').paused`), { what: 'page video playing' }), 'playing'));
    await ev(`chrome.tabs.update(${pg.tabId}, { muted: true }).then(() => true)`);

    await t('a slept laptop is capped at 2 minutes per chunk', async () => {
      const before = await usageOf(LIMITED);
      await ev(`chrome.storage.session.set({ current: { host: '${LIMITED}', tabId: ${pg.tabId}, since: Date.now() - 600000 } }).then(() => true)`);
      await refresh();
      const got = (await usageOf(LIMITED)) - before;
      return check(got >= 119 && got <= 121, 'expected 120s', { credited: got });
    });

    // ------------------------------------------------------------------ blast
    const seen = new Set();
    let f;
    await t('going over the limit mounts the overlay', async () => {
      await waitFor(async () => (await overlayCount(pg.p)) === 1, { what: 'overlay iframe' });
      f = await overlayFrame(pg.t, seen);
      const stats = await f.ev(`document.getElementById('stats').textContent`);
      return check(stats.includes(LIMITED) && stats.includes('Your limit was 2m'), 'stats', stats);
    });
    await t('badge shows !! once over', async () => check((await badge(pg.tabId)) === '!!', 'badge', await badge(pg.tabId)));
    await t('a tab muted in the browser gets unmuted for the blast', async () => check(!(await tabMuted(pg.tabId)), 'still muted'));
    await t('muting mid-blast is undone', async () => {
      await ev(`chrome.tabs.update(${pg.tabId}, { muted: true }).then(() => true)`);
      return check(await waitFor(async () => !(await tabMuted(pg.tabId)), { timeout: 4000, what: 'unmute' }), 'unmuted');
    });
    await t("the page's own video is paused and kept paused", async () => {
      await waitFor(() => pg.p.ev(`document.getElementById('pv').paused`), { what: 'paused' });
      await pg.p.ev(`document.getElementById('pv').play().catch(() => {}), true`);
      await sleep(1600);
      return check(await pg.p.ev(`document.getElementById('pv').paused`), 'page video resumed during blast');
    });
    const overlaySound = () => f.ev(`({ muted: document.getElementById('video').muted, playing: !document.getElementById('video').paused, hint: document.getElementById('soundHint').hidden ? null : document.getElementById('soundHint').textContent })`);
    if (b.kind === 'chrome') {
      await t('sound blocked in the page -> it plays in the background instead', async () => {
        await waitFor(backgroundPlaying, { what: 'background audio playing' });
        const r = await overlaySound();
        return check(r.muted && r.playing && r.hint, 'overlay picture plays muted with a hint', r);
      });
    } else {
      // Firefox's autoplay blocking doesn't apply to extension frames, so the
      // overlay plays with sound even on a page nobody has clicked.
      await t('sound blocked in the page -> the overlay still plays with sound', async () => {
        const r = await waitFor(async () => { const r = await overlaySound(); return r.playing && r; }, { what: 'overlay playing' });
        return check(!r.muted && !r.hint && !(await backgroundPlaying()), 'overlay plays with sound itself', r);
      });
    }
    await t('"5 min aur" is locked until the video plays through once', async () => {
      const locked = await f.ev(`document.getElementById('snooze').disabled`);
      check(locked, 'snooze should start disabled');
      await waitFor(() => f.ev(`!document.getElementById('snooze').disabled`), { timeout: 12000, what: 'snooze unlock after one lap' });
      return f.ev(`document.getElementById('fine').textContent`);
    });
    await t('the next blast is scheduled nagEveryMinutes out', async () => {
      const nag = await local('nag');
      const inMin = (nag.next[LIMITED] - Date.now()) / 60000;
      return check(inMin > 1.5 && inMin <= 2, 'about 2 minutes', { inMin });
    });
    await t('refreshing while the overlay is up never stacks a second one', async () => {
      await ev(`chrome.storage.local.set({ nag: null }).then(() => true)`);
      await refresh(); await sleep(800);
      return check((await overlayCount(pg.p)) === 1, 'overlay count', await overlayCount(pg.p));
    });
    await t('snooze closes the overlay, stops the sound and gives 5 minutes', async () => {
      await f.ev(`document.getElementById('snooze').click(), true`, { gesture: true });
      await waitFor(async () => (await overlayCount(pg.p)) === 0, { what: 'overlay removed' });
      await waitFor(async () => !(await backgroundPlaying()), { what: 'background audio stopped' });
      const nag = await local('nag');
      const inMin = (nag.next[LIMITED] - Date.now()) / 60000;
      return check(inMin > 4.5 && inMin <= 5, 'about 5 minutes', { inMin });
    });
    await t('the page can play again after the overlay is gone', async () => {
      await pg.p.ev(`document.getElementById('pv').play().catch(() => {}), true`, { gesture: true });
      await sleep(1600);
      return check(!(await pg.p.ev(`document.getElementById('pv').paused`)), 'still being paused');
    });
    await t('no blast while snoozed', async () => {
      await refresh(); await sleep(1000);
      return check((await overlayCount(pg.p)) === 0, 'blasted during snooze');
    });
    await t('once the snooze runs out, it blasts again', async () => {
      await ev(`chrome.storage.local.set({ nag: null }).then(() => true)`);
      await refresh();
      await waitFor(async () => (await overlayCount(pg.p)) === 1, { what: 'second overlay' });
      f = await overlayFrame(pg.t, seen);
      return true;
    });
    await t('"Close this tab" closes the tab', async () => {
      await f.ev(`document.getElementById('closeTab').click(), true`, { gesture: true });
      await waitFor(async () => !(await b.targets()).some((t) => t.id === pg.t.id), { what: 'tab closed' });
      await waitFor(async () => !(await backgroundPlaying()), { what: 'background audio stopped' });
      return true;
    });

    // ------------------------------------------------------------------ fullscreen
    await t('inside a fullscreen element, the overlay mounts in it', async () => {
      const p2 = await openPage('?fs');
      await p2.p.ev(`document.getElementById('fs').requestFullscreen().then(() => true)`, { gesture: true });
      await ev(`chrome.storage.local.set({ nag: null }).then(() => true)`); await refresh();
      const r = await waitFor(() => p2.p.ev(`(() => { const f = document.querySelector('iframe[src*="/overlay/overlay.html"]'); return f && { parent: f.parentElement.id, fs: document.fullscreenElement?.id }; })()`), { what: 'overlay in fullscreen' });
      p2.p.close(); await b.close(p2.t.id);
      return check(r.parent === 'fs' && r.fs === 'fs', 'mounted in fullscreen element', r);
    });
    await t('a fullscreen <video> is exited so the overlay is visible', async () => {
      const p3 = await openPage('?fsvideo');
      await p3.p.ev(`document.getElementById('pv').requestFullscreen().then(() => true)`, { gesture: true });
      await ev(`chrome.storage.local.set({ nag: null }).then(() => true)`); await refresh();
      const r = await waitFor(() => p3.p.ev(`(() => { const f = document.querySelector('iframe[src*="/overlay/overlay.html"]'); return f && !document.fullscreenElement && { parent: f.parentElement.tagName }; })()`), { what: 'fullscreen exited' });
      p3.p.close(); await b.close(p3.t.id);
      return check(r.parent === 'HTML', 'mounted on the page', r);
    });

    // ------------------------------------------------------------------ settings that change the blast
    await t('"Armed" off: still tracks and shows !!, but never blasts', async () => {
      await setSettings({ enabled: false });
      const p4 = await openPage('?disarmed');
      await ev(`chrome.storage.local.set({ nag: null }).then(() => true)`); await refresh(); await sleep(1500);
      const r = { overlays: await overlayCount(p4.p), badge: await badge(p4.tabId) };
      p4.p.close(); await b.close(p4.t.id);
      await setSettings({ enabled: true });
      return check(r.overlays === 0 && r.badge === '!!', 'disarmed', r);
    });
    await t('"pause page media" off leaves the page playing', async () => {
      await setSettings({ pausePageMedia: false });
      const p5 = await openPage('?nopause');
      await waitFor(() => p5.p.ev(`!document.getElementById('pv').paused`), { what: 'page video playing' });
      await ev(`chrome.storage.local.set({ nag: null }).then(() => true)`); await refresh();
      await waitFor(async () => (await overlayCount(p5.p)) === 1, { what: 'overlay' });
      await sleep(1500);
      const playing = !(await p5.p.ev(`document.getElementById('pv').paused`));
      await ev(`chrome.runtime.sendMessage({ type: 'BKB_STOP_AUDIO' })`);
      p5.p.close(); await b.close(p5.t.id);
      await setSettings({ pausePageMedia: true });
      return check(playing, 'page video was paused anyway');
    });
    await t('the background player plays and stops on request', async () => {
      await ev(`chrome.runtime.sendMessage({ type: 'BKB_PLAY_AUDIO', video: 'default', boostDb: 12, outputMode: 'default' })`);
      await waitFor(backgroundPlaying, { what: 'background audio playing' });
      await ev(`chrome.runtime.sendMessage({ type: 'BKB_STOP_AUDIO' })`);
      return check(await waitFor(async () => !(await backgroundPlaying()), { what: 'background audio stopped' }), 'stopped');
    });

    // Firefox can't pick an output device for extensions, so there is no speakers mode.
    const chromeOnly = b.kind === 'chrome' ? {} : { skip: 'Firefox has no speakers mode' };
    await t('speakers mode ("auto") always plays the sound in the background', async () => {
      await setSettings({ outputMode: 'auto' });
      const p6 = await openPage('?auto');
      await ev(`chrome.storage.local.set({ nag: null }).then(() => true)`); await refresh();
      await waitFor(async () => (await overlayCount(p6.p)) === 1, { what: 'overlay' });
      const f6 = await overlayFrame(p6.t, seen);
      await waitFor(backgroundPlaying, { what: 'background audio' });
      const r = await f6.ev(`({ muted: document.getElementById('video').muted, hint: document.getElementById('soundHint').textContent })`);
      await f6.ev(`document.getElementById('closeTab').click(), true`, { gesture: true });
      await waitFor(async () => !(await b.targets()).some((t) => t.id === p6.t.id), { what: 'tab closed' });
      await setSettings({ outputMode: 'default' });
      return check(r.muted, 'overlay video should be muted (sound comes from the background)', r);
    }, chromeOnly);
    await t('Firefox: the speaker picker is replaced by a note, and settings say "whatever I\'m listening on"', async () => {
      await setSettings({ outputMode: 'auto' });
      await reloadOptions();
      const r = await ev(`(async () => ({ picker: !document.querySelector('.speakers').hidden, note: !document.getElementById('noSpeakers').hidden,
        setup: !document.getElementById('setup').hidden, mode: (await import('../lib/common.js').then((m) => m.getSettings())).outputMode }))()`);
      await setSettings({ outputMode: 'default' });
      return check(!r.picker && r.note && !r.setup && r.mode === 'default', 'no speakers mode', r);
    }, b.kind === 'firefox' ? {} : { skip: 'Firefox only' });

    // ------------------------------------------------------------------ settings page
    await reloadOptions();
    await b.activate(optT.id); await o.front();

    await t('add a limit from a messy URL', async () => {
      await ev(`document.getElementById('addSite').value = 'https://www.Reddit.com/r/all'; document.getElementById('addMinutes').value = '25'; document.getElementById('addForm').requestSubmit(), true`);
      const s = await waitFor(async () => (await settings()).limits.find((l) => l.site === 'reddit.com'), { what: 'reddit limit' });
      return check(s.minutes === 25 && (await ev(`document.getElementById('addSite').value`)) === '', 'saved and cleared', s);
    });
    await t('quick-add chip adds a limit', async () => {
      await ev(`[...document.querySelectorAll('#chips button')].find((b) => b.textContent.includes('netflix.com')).click(), true`);
      return waitFor(async () => (await settings()).limits.find((l) => l.site === 'netflix.com'), { what: 'netflix limit' });
    });
    await t('minutes are clamped to 1-1440', async () => {
      await ev(`(() => { const i = document.querySelector('#limits li:last-child input'); i.value = '0'; i.dispatchEvent(new Event('change')); return true; })()`);
      const l = await waitFor(async () => (await settings()).limits.find((l) => l.site === 'netflix.com' && l.minutes === 1), { what: 'clamped' });
      return l;
    });
    await t('remove a limit', async () => {
      await ev(`document.querySelector('#limits li:last-child button').click(), true`);
      return check(await waitFor(async () => !(await settings()).limits.some((l) => l.site === 'netflix.com'), { what: 'removed' }), 'removed');
    });
    await t('replay and snooze minutes are clamped to 1-120', async () => {
      await ev(`(() => { for (const [id, v] of [['nag', '999'], ['snooze', '0']]) { const i = document.getElementById(id); i.value = v; i.dispatchEvent(new Event('change')); } return true; })()`);
      const s = await waitFor(async () => { const s = await settings(); return s.nagEveryMinutes === 120 && s.snoozeMinutes === 1 && s; }, { what: 'clamped' });
      await setSettings({ nagEveryMinutes: 2, snoozeMinutes: 5 });
      return { nag: s.nagEveryMinutes, snooze: s.snoozeMinutes };
    });
    await t('boost and output pickers save', async () => {
      await ev(`(() => { const b = document.getElementById('boost'); b.value = '18'; b.dispatchEvent(new Event('change'));
        const o = document.getElementById('output'); o.value = 'default'; o.dispatchEvent(new Event('change')); return true; })()`);
      const s = await waitFor(async () => { const s = await settings(); return s.boostDb === 18 && s.outputMode === 'default' && s; }, { what: 'saved' });
      return { boostDb: s.boostDb, outputMode: s.outputMode, setupCardHidden: await ev(`document.getElementById('setup').hidden`) };
    });

    // --- custom video
    const fileInput = (path) => o.setFiles('#file', [path]);
    await t('a file over 60 MB is refused', async () => {
      await fileInput(join(fixtures, 'huge.mp4'));
      const t = await waitFor(() => ev(`!document.getElementById('toast').hidden && document.getElementById('toast').textContent`), { what: 'toast' });
      return check(t.includes('60 MB') && (await settings()).video !== 'custom', 'refused', t);
    });
    await t('upload a custom video', async () => {
      await fileInput(join(fixtures, 'my-clip.mp4'));
      await waitFor(async () => (await settings()).video === 'custom', { what: 'custom selected' });
      const r = await waitFor(() => ev(`(() => { const p = document.getElementById('preview'); return p.src.startsWith('blob:') && { name: document.getElementById('customName').textContent,
        checked: document.getElementById('customRadio').checked, clipForm: !document.getElementById('clipForm').hidden, remove: !document.getElementById('removeCustom').hidden }; })()`), { what: 'custom preview' });
      return check(r.name === 'my-clip.mp4' && r.checked && r.clipForm && r.remove, 'custom video UI', r);
    });
    await t('clip time errors', async () => {
      const submit = (a, z) => ev(`(async () => { document.getElementById('clipStart').value = '${a}'; document.getElementById('clipEnd').value = '${z}';
        document.getElementById('clipForm').requestSubmit(); await new Promise((r) => setTimeout(r, 300)); const e = document.getElementById('clipError'); return e.hidden ? '' : e.textContent; })()`);
      await waitFor(() => ev(`Number.isFinite(document.getElementById('preview').duration)`), { what: 'preview metadata' });
      const r = { backwards: await submit('0:03', '0:01'), tooLate: await submit('9:00', ''), junk: await submit('abc', '') };
      return check(r.backwards.includes('after') && r.tooLate.includes('only 0:06') && r.junk.includes('Times look like'), 'errors', r);
    });
    await t('clip times save and the preview loops between them', async () => {
      await ev(`(() => { document.getElementById('clipStart').value = '0:02'; document.getElementById('clipEnd').value = '0:04'; document.getElementById('clipForm').requestSubmit(); return true; })()`);
      const s = await waitFor(async () => (await settings()).customClip, { what: 'clip saved' });
      // Wait for the re-render that follows the save, so we play the final preview element state.
      await waitFor(() => ev(`document.getElementById('clipInfo').textContent === 'plays 0:02–0:04 on repeat' && !document.getElementById('toast').hidden`), { what: 'clip re-render' });
      await sleep(500);
      await waitFor(() => ev(`document.getElementById('preview').src.startsWith('blob:') && document.getElementById('preview').readyState >= 1`), { what: 'preview reloaded' });
      await ev(`(() => { const p = document.getElementById('preview'); p.muted = true; return p.play().then(() => true); })()`, { gesture: true });
      const times = [];
      for (let i = 0; i < 10; i++) { await sleep(500); times.push(await ev(`document.getElementById('preview').currentTime`)); }
      await ev(`document.getElementById('preview').pause(), true`);
      const info = await ev(`document.getElementById('clipInfo').textContent`);
      return check(s.start === 2 && s.end === 4 && info === 'plays 0:02–0:04 on repeat' && times.every((t) => t >= 1.9 && t <= 4.3) && times.some((t, i) => i && t < times[i - 1]), 'loop', { s, info, times: times.map((t) => t.toFixed(1)) });
    });
    await t('the blast uses the uploaded clip and loops it', async () => {
      const p7 = await openPage('?custom');
      await ev(`chrome.storage.local.set({ nag: null }).then(() => true)`); await refresh();
      await waitFor(async () => (await overlayCount(p7.p)) === 1, { what: 'overlay' });
      const f7 = await overlayFrame(p7.t, seen);
      await waitFor(() => f7.ev(`!document.getElementById('video').paused`), { what: 'overlay playing' });
      const times = [];
      for (let i = 0; i < 8; i++) { await sleep(500); times.push(await f7.ev(`document.getElementById('video').currentTime`)); }
      const src = await f7.ev(`document.getElementById('video').src.slice(0, 5)`);
      await f7.ev(`document.getElementById('closeTab').click(), true`, { gesture: true });
      await waitFor(async () => !(await b.targets()).some((t) => t.id === p7.t.id), { what: 'tab closed' });
      return check(src === 'blob:' && times.every((t) => t >= 1.9 && t <= 4.3), 'custom clip in blast', { src, times: times.map((t) => t.toFixed(1)) });
    });
    await t('remove the custom video', async () => {
      await b.activate(optT.id); await o.front();
      await ev(`document.getElementById('removeCustom').click(), true`);
      const s = await waitFor(async () => { const s = await settings(); return s.video === 'default' && s; }, { what: 'back to default' });
      const r = await waitFor(() => ev(`document.getElementById('customName').textContent === 'No custom video yet.' && document.getElementById('preview').src.endsWith('/media/default.mp4') && document.getElementById('customRadio').disabled`), { what: 'UI reset' });
      return check(r && s.customClip === null, 'removed', { customClip: s.customClip });
    });

    // --- YouTube
    await t('YouTube link errors', async () => {
      const submit = (url, a = '', z = '') => ev(`(async () => { document.getElementById('ytUrl').value = ${JSON.stringify(url)}; document.getElementById('ytStart').value = '${a}'; document.getElementById('ytEnd').value = '${z}';
        document.getElementById('ytForm').requestSubmit(); await new Promise((r) => setTimeout(r, 400)); const e = document.getElementById('ytError'); return e.hidden ? '' : e.textContent; })()`);
      const r = { notYt: await submit('https://vimeo.com/1'), backwards: await submit('https://youtu.be/aqz-KE-bpKQ', '0:40', '0:30') };
      return check(r.notYt.includes("doesn't look like a YouTube link") && r.backwards.includes('after'), 'errors', r);
    });
    await ty('a YouTube link saves with its title and times', async () => {
      await ev(`(() => { document.getElementById('ytUrl').value = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=30s'; document.getElementById('ytStart').value = ''; document.getElementById('ytEnd').value = '0:40'; document.getElementById('ytForm').requestSubmit(); return true; })()`);
      const s = await waitFor(async () => { const s = await settings(); return s.video === 'youtube' && s.youtube; }, { timeout: 10000, what: 'youtube saved' });
      const ui = await waitFor(() => ev(`!!document.querySelector('#ytPreview iframe') && !document.getElementById('ytPreview').hidden && document.getElementById('preview').hidden && document.getElementById('ytInfo').textContent`), { what: 'yt preview' });
      return check(s.id === 'aqz-KE-bpKQ' && s.start === 30 && s.end === 40 && s.title && s.url === 'https://youtu.be/aqz-KE-bpKQ?t=30' && ui.includes('0:30–0:40'), 'saved', { s, ui });
    });
    const testFrame = async () => {
      await ev(`document.getElementById('test').click(), true`, { gesture: true });
      return waitFor(() => ev(`(() => { const d = document.querySelector('.test-frame')?.contentDocument; return d && d.getElementById('stats')?.textContent.length > 0; })()`), { what: 'test frame' });
    };
    const inTest = (expr) => ev(`(() => { const d = document.querySelector('.test-frame').contentDocument; return ${expr}; })()`);
    await ty('"Test the blast" plays the YouTube video', async () => {
      await testFrame();
      await sleep(9000);
      const r = await inTest(`({ yt: !!d.querySelector('#screen iframe'), sirenFallback: !d.getElementById('video').hidden, snoozeHidden: d.getElementById('snooze').hidden })`);
      await inTest(`d.getElementById('closeTab').click()`);
      await waitFor(() => ev(`!document.querySelector('.test-frame')`), { what: 'test frame closed' });
      return check(r.yt && !r.sirenFallback && r.snoozeHidden, 'youtube test', r);
    });
    await t('a broken YouTube video falls back to the siren', async () => {
      await setSettings({ video: 'youtube', youtube: { id: 'xxxxxxxxxxx', start: 0, end: 0, title: '', url: 'https://youtu.be/xxxxxxxxxxx' } });
      await testFrame();
      const r = await waitFor(() => inTest(`!d.getElementById('video').hidden && d.getElementById('video').src.endsWith('/media/default.mp4') && !d.querySelector('#screen iframe')`), { timeout: 15000, what: 'siren fallback' });
      await inTest(`d.getElementById('closeTab').click()`);
      await waitFor(() => ev(`!document.querySelector('.test-frame')`), { what: 'test frame closed' });
      await setSettings({ video: 'default', youtube: null });
      return r;
    });

    // --- popup
    await t('popup shows today, limits worst-first, other sites, and the speaker notice', async () => {
      await setSettings({ outputMode: 'auto' });
      const t = await b.open(`${b.base}/popup/popup.html`);
      const p = await connect(t, 'popup');
      const r = await waitFor(() => p.ev(`(() => { const rows = [...document.querySelectorAll('#limits li .site')].map((e) => e.textContent); return rows.length && {
        total: document.getElementById('total').textContent, rows, over: document.querySelector('#limits li').classList.contains('over'),
        others: [...document.querySelectorAll('#others li .site')].map((e) => e.textContent), notice: !document.getElementById('speakerNotice').hidden, armed: document.getElementById('enabled').checked }; })()`), { what: 'popup render' });
      await p.ev(`(() => { const c = document.getElementById('enabled'); c.click(); return true; })()`);
      const off = await waitFor(async () => (await settings()).enabled === false, { what: 'disarmed from popup' });
      const synced = await waitFor(() => ev(`document.getElementById('enabled').checked === false`), { what: 'options page in sync' });
      await p.ev(`document.getElementById('enabled').click(), true`);
      await waitFor(async () => (await settings()).enabled === true, { what: 're-armed' });
      p.close(); await b.close(t.id);
      await setSettings({ outputMode: 'default' });
      // No speakers mode on Firefox, so nothing to nag about there.
      return check(r.rows[0] === LIMITED && r.over && r.others.includes('localhost') && r.notice === (b.kind === 'chrome') && r.armed && off && synced, 'popup', r);
    });

    // --- history and reset
    await t('7-day history and reset buttons', async () => {
      await b.activate(optT.id); await o.front();
      await reloadOptions();
      const todayTotal = await ev(`[...document.querySelectorAll('#history .day')].pop().querySelector('.total').textContent`);
      await ev(`(async () => { const { usage } = await chrome.storage.local.get('usage'); usage['2000-01-01'] = { 'old.com': 5 }; await chrome.storage.local.set({ usage }); return true; })()`);
      await ev(`window.__asked = []; window.confirm = (m) => (window.__asked.push(m), true), true`);
      await ev(`document.getElementById('resetToday').click(), true`);
      const afterToday = await waitFor(async () => { const u = await local('usage'); return !u[await today()] && u; }, { what: 'today reset' });
      await ev(`document.getElementById('resetAll').click(), true`);
      await waitFor(async () => Object.keys(await local('usage')).length === 0, { what: 'all reset' });
      const asked = await ev(`window.__asked`);
      return check(todayTotal !== '0s' && afterToday['2000-01-01'] && asked.length === 2 && /today/i.test(asked[0]) && /ALL/.test(asked[1]), 'reset', { todayTotal, asked });
    });

    await t('no errors or warnings in any extension page or the service worker', async () => {
      const seenProblems = [...new Set(problems)];
      return check(seenProblems.length === 0, 'problems seen', seenProblems);
    });
  } finally {
    b.kill();
    web.close();
    rmSync(fixtures, { recursive: true, force: true });
  }
}
