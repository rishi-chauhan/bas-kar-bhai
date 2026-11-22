// Drives the unpacked extension in a real, headless Chromium-based browser
// over the DevTools protocol. Only Node's standard library is used.
//
// Pick the browser with CHROME_PATH. Branded Google Chrome (137+) ignores
// --load-extension, so use Chromium, Chrome for Testing or Brave.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXT_DIR = resolve(fileURLToPath(new URL('../../extension', import.meta.url)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  'chromium', 'chromium-browser', 'brave', 'brave-browser', 'google-chrome-for-testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
];

export function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const c of CANDIDATES) {
    if (c.startsWith('/')) { if (existsSync(c)) return c; continue; }
    try {
      return execFileSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
    } catch {}
  }
  return null;
}

// A tiny static file server for the "websites" the tests visit.
export async function serve(dir) {
  const types = { '.html': 'text/html', '.mp4': 'video/mp4', '.js': 'text/javascript' };
  const server = createServer((req, res) => {
    let file = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (file.endsWith('/')) file = join(file, 'index.html');
    try {
      if (!file.startsWith(dir)) throw new Error('outside');
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => server.close() };
}

export async function launch({ flags = [] } = {}) {
  const exe = findBrowser();
  if (!exe) throw new Error('No Chromium-based browser found. Set CHROME_PATH (see tests/e2e/browser.mjs).');
  const profile = mkdtempSync(join(tmpdir(), 'bkb-profile-'));
  const proc = spawn(exe, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--load-extension=${EXT_DIR}`, `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1200,900', ...flags,
  ], { stdio: 'ignore' });

  const portFile = join(profile, 'DevToolsActivePort');
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || undefined;
  }
  const kill = () => { proc.kill(); setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500); };
  if (!port) { kill(); throw new Error(`${exe} did not start`); }

  const http = async (path, method = 'GET') => {
    const text = await (await fetch(`http://127.0.0.1:${port}${path}`, { method })).text();
    try { return JSON.parse(text); } catch { return text; }
  };
  let extId;
  for (let i = 0; i < 60 && !extId; i++) {
    await sleep(250);
    const t = (await http('/json/list')).find((t) => t.url.startsWith('chrome-extension://'));
    extId = t && new URL(t.url).host;
  }
  if (!extId) {
    kill();
    throw new Error(`The extension did not load in ${exe}. Branded Google Chrome ignores --load-extension; use Chromium, Chrome for Testing or Brave.`);
  }
  return {
    extId, base: `chrome-extension://${extId}`, kill,
    targets: () => http('/json/list'),
    open: (url) => http(`/json/new?${encodeURIComponent(url)}`, 'PUT'),
    activate: (id) => http(`/json/activate/${id}`),
    close: (id) => http(`/json/close/${id}`),
  };
}

// Every exception and console error/warning seen on a connected target.
export const problems = [];

export async function connect(target, label = target.url) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const handlers = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      problems.push(`[${label}] ${d.exception?.description?.split('\n')[0] || d.text}`);
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      problems.push(`[${label}] console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
    for (const h of handlers) h(m);
  };
  const cdp = (method, params = {}) => new Promise((r) => {
    const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params }));
  });
  // Evaluates `expression` in the page (top-level await works via async IIFEs).
  const ev = async (expression, { gesture = false } = {}) => {
    const m = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture });
    const ex = m.result?.exceptionDetails;
    if (ex) throw new Error(`eval failed in ${label}: ${ex.exception?.description || ex.text}`);
    return m.result?.result?.value;
  };
  await cdp('Runtime.enable');
  return { cdp, ev, on: (h) => handlers.push(h), close: () => ws.close() };
}

export async function waitFor(fn, { timeout = 8000, every = 200, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

// Is YouTube reachable? The YouTube tests skip themselves when it isn't.
export async function online() {
  try {
    const res = await fetch('https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=aqz-KE-bpKQ', { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}
