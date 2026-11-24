// Websites must not be able to use the blast overlay: it's web-accessible
// (so it can be framed on the offending site), but only runs for a real blast.
// Run with: npm run test:e2e

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skipReason, launch, serve, connect, waitFor, openOptions } from './browser.mjs';

const skip = skipReason();

if (skip) {
  test('security tests', { skip }, () => {});
} else {
  const fixtures = mkdtempSync(join(tmpdir(), 'bkb-evil-'));
  const web = await serve(fixtures);
  const b = await launch();

  try {
    const { o } = await openOptions(b);
    const real = await o.ev(`chrome.runtime.getURL('overlay/overlay.html')`);

    // A hostile page on a site with no limit: frames the overlay three ways and
    // tries to read the extension's files.
    writeFileSync(join(fixtures, 'evil.html'), `<!doctype html><title>evil</title>
      <iframe src="${real}?site=youtube.com&used=9999&limit=1" allow="autoplay"></iframe>
      <iframe src="${real}?test=1" allow="autoplay"></iframe>
      <iframe src="${real}?token=00000000-0000-4000-8000-000000000000" allow="autoplay"></iframe>
      <script>
        window.probe = Promise.all(['media/default.mp4', 'lib/common.js', 'overlay/overlay.js', 'overlay/overlay.html'].map((p) =>
          fetch('${b.base}/' + p).then((r) => [p, r.status], () => [p, 'blocked'])));
      </script>`);
    const evilT = await b.open(`http://localhost:${web.port}/evil.html`);
    const evil = await connect(evilT, 'evil page');
    // A new tab starts as a "complete" about:blank, so wait for the real page.
    await waitFor(() => evil.ev(`location.pathname === '/evil.html' && document.readyState === 'complete' && !!window.probe`), { what: 'evil page load' });

    await test('only overlay.html is reachable from websites', async () => {
      const probe = Object.fromEntries(await evil.ev('window.probe'));
      assert.deepEqual(probe, {
        'media/default.mp4': 'blocked', 'lib/common.js': 'blocked', 'overlay/overlay.js': 'blocked', 'overlay/overlay.html': 200,
      });
    });

    await test('forged details, a fake test flag and a made-up token all leave the overlay blank and silent', async () => {
      const frames = await waitFor(async () => {
        const f = (await b.targets()).filter((t) => t.type === 'iframe' && t.url.startsWith(real));
        return f.length === 3 && f;
      }, { what: 'three overlay frames' });
      await new Promise((r) => setTimeout(r, 1500));
      for (const t of frames) {
        const c = await connect(t, 'framed overlay');
        const state = await c.ev(`({ hidden: document.documentElement.hidden, playing: !document.getElementById('video').paused })`);
        c.close();
        assert.deepEqual(state, { hidden: true, playing: false }, t.url.split('?')[1]);
      }
      const audio = await o.ev(`chrome.runtime.sendMessage({ type: 'BKB_AUDIO_STATUS' }).then((r) => r.playing)`);
      assert.equal(audio, false, 'no background audio was started');
    });

    await test('a blast token cannot be claimed by another tab or reused', async () => {
      // Mint a token the way the worker does for a real blast on some other tab,
      // then try to claim it from the hostile page's framed overlay context.
      const r = await o.ev(`(async () => {
        const token = crypto.randomUUID();
        const { blastTokens = {} } = await chrome.storage.session.get('blastTokens');
        blastTokens[token] = { tabId: -12345, site: 'youtube.com', used: 1, limit: 1, expires: Date.now() + 60000 };
        await chrome.storage.session.set({ blastTokens });
        // The options page is a tab too, but not tab -12345.
        const first = await chrome.runtime.sendMessage({ type: 'BKB_CLAIM_BLAST', token });
        const second = await chrome.runtime.sendMessage({ type: 'BKB_CLAIM_BLAST', token });
        return { first: first.blast, second: second.blast };
      })()`);
      assert.deepEqual(r, { first: null, second: null });
    });
  } finally {
    b.kill();
    web.close();
    rmSync(fixtures, { recursive: true, force: true });
  }
}
