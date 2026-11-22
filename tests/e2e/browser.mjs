// Drives the unpacked extension in a real, headless browser. Only Node's
// standard library is used.
//
//   Chrome (default): Chromium over the DevTools protocol. Pick the binary with
//     CHROME_PATH. Branded Google Chrome (137+) ignores --load-extension, so use
//     Chromium, Chrome for Testing or Brave.
//   Firefox (BROWSER=firefox): over WebDriver BiDi. Pick the binary with
//     FIREFOX_PATH (Firefox 140+).
//
// Both drivers return the same shapes, so the tests don't care which is running:
//   launch()  -> { kind, base, kill, targets(), open(url), activate(id), close(id) }
//   connect() -> { ev(expr, {gesture}), reload(), front(), acceptDialogs(), setFiles(selector, paths), close() }

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXT_DIR = resolve(fileURLToPath(new URL('../../extension', import.meta.url)));
export const BROWSER = process.env.BROWSER === 'firefox' ? 'firefox' : 'chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = {
  chrome: [
    'chromium', 'chromium-browser', 'brave', 'brave-browser', 'google-chrome-for-testing',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ],
  firefox: ['firefox', '/Applications/Firefox.app/Contents/MacOS/firefox'],
};

export function findBrowser() {
  const env = BROWSER === 'firefox' ? process.env.FIREFOX_PATH : process.env.CHROME_PATH;
  if (env) return env;
  for (const c of CANDIDATES[BROWSER]) {
    if (c.startsWith('/')) { if (existsSync(c)) return c; continue; }
    try {
      return execFileSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
    } catch {}
  }
  return null;
}

// Why the browser tests are skipped, or false if they can run.
export const skipReason = () => findBrowser()
  ? false
  : BROWSER === 'firefox' ? 'Firefox not found (set FIREFOX_PATH)' : 'no Chromium-based browser found (set CHROME_PATH)';

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

// Every exception and console error/warning seen on a connected target.
export const problems = [];

// `autoplayBlocked`: refuse sound until the page has had a click, like a site
// nobody has touched yet.
export function launch(opts = {}) {
  return BROWSER === 'firefox' ? launchFirefox(opts) : launchChrome(opts);
}

export function connect(target, label = target.url) {
  return target.bidi ? connectFirefox(target, label) : connectChrome(target, label);
}

// ---------------------------------------------------------------------------
// Chrome, over the DevTools protocol

async function launchChrome({ autoplayBlocked = false } = {}) {
  const exe = findBrowser();
  if (!exe) throw new Error('No Chromium-based browser found. Set CHROME_PATH (see tests/e2e/browser.mjs).');
  const profile = mkdtempSync(join(tmpdir(), 'bkb-profile-'));
  const proc = spawn(exe, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--load-extension=${EXT_DIR}`, `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1200,900',
    ...(autoplayBlocked ? ['--autoplay-policy=document-user-activation-required'] : []),
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
    kind: 'chrome', base: `chrome-extension://${extId}`, kill,
    targets: () => http('/json/list'),
    open: (url) => http(`/json/new?${encodeURIComponent(url)}`, 'PUT'),
    activate: (id) => http(`/json/activate/${id}`),
    close: (id) => http(`/json/close/${id}`),
  };
}

async function connectChrome(target, label) {
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
  return {
    ev,
    reload: () => cdp('Page.reload'),
    front: () => cdp('Page.bringToFront'),
    async acceptDialogs() {
      await cdp('Page.enable');
      handlers.push((m) => { if (m.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: true }); });
    },
    async setFiles(selector, files) {
      const { root } = (await cdp('DOM.getDocument')).result;
      const { nodeId } = (await cdp('DOM.querySelector', { nodeId: root.nodeId, selector })).result;
      await cdp('DOM.setFileInputFiles', { nodeId, files });
    },
    close: () => ws.close(),
  };
}

// ---------------------------------------------------------------------------
// Firefox, over WebDriver BiDi

const GECKO_ID = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
// Pinned so the tests know the extension's moz-extension:// address up front.
const FIREFOX_UUID = 'b45ca7b4-0000-4000-8000-000000000bcb';

async function launchFirefox({ autoplayBlocked = false, prefs: extraPrefs = {} } = {}) {
  const exe = findBrowser();
  if (!exe) throw new Error('Firefox not found. Set FIREFOX_PATH (see tests/e2e/browser.mjs).');
  const profile = mkdtempSync(join(tmpdir(), 'bkb-ff-profile-'));
  const prefs = {
    'extensions.webextensions.uuids': JSON.stringify({ [GECKO_ID]: FIREFOX_UUID }),
    // 1 = block audible autoplay until the page has had a click; 0 = allow.
    'media.autoplay.default': autoplayBlocked ? 1 : 0,
    'media.autoplay.blocking_policy': 0,
    'media.volume_scale': '0.0',
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.aboutwelcome.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false,
    'app.update.disabledForTesting': true,
    ...extraPrefs,
  };
  writeFileSync(join(profile, 'user.js'), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));

  const proc = spawn(exe, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port=0', '--width=1200', '--height=900'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Lets the tests run code in extension pages (a throwaway test profile only).
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  });
  const kill = () => { proc.kill(); setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1000); };
  const wsUrl = await new Promise((r) => {
    let err = '';
    const timer = setTimeout(() => r(null), 30000);
    proc.stderr.on('data', (d) => {
      err += d;
      const m = err.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); r(m[1]); }
    });
    proc.on('exit', () => r(null));
  });
  if (!wsUrl) { kill(); throw new Error(`${exe} did not start WebDriver BiDi`); }

  const bidi = await bidiClient(`${wsUrl}/session`);
  await bidi.send('session.new', { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } } });
  await bidi.send('session.subscribe', { events: ['log.entryAdded', 'browsingContext.userPromptOpened'] });
  await bidi.send('webExtension.install', { extensionData: { type: 'path', path: EXT_DIR } });

  const targets = async () => {
    const out = [];
    const walk = (ctxs, parentId) => {
      for (const c of ctxs || []) {
        out.push({ id: c.context, url: c.url, type: parentId ? 'iframe' : 'page', parentId, bidi });
        walk(c.children, c.context);
      }
    };
    walk((await bidi.send('browsingContext.getTree', {})).contexts);
    return out;
  };
  return {
    kind: 'firefox', base: `moz-extension://${FIREFOX_UUID}`,
    kill: () => { bidi.close(); kill(); },
    targets,
    async open(url) {
      // BiDi may not navigate to extension pages, but extension pages may open
      // them. The options page opens by itself on install, so start from that.
      if (url.startsWith(`moz-extension://${FIREFOX_UUID}/`)) {
        const before = new Set((await targets()).map((t) => t.id));
        const opener = await waitFor(async () => (await targets()).find((t) => t.type === 'page' && t.url.startsWith(`moz-extension://${FIREFOX_UUID}/`)), { timeout: 15000, what: 'an extension page' });
        const r = await bidi.send('script.evaluate', { expression: `chrome.tabs.create({ url: ${JSON.stringify(url)} }).then(() => true)`, target: { context: opener.id }, awaitPromise: true });
        if (r.type === 'exception') throw new Error(`could not open ${url}: ${r.exceptionDetails.text}`);
        return waitFor(async () => (await targets()).find((t) => t.type === 'page' && !before.has(t.id) && t.url === url), { what: `tab for ${url}` });
      }
      const { context } = await bidi.send('browsingContext.create', { type: 'tab' });
      await bidi.send('browsingContext.navigate', { context, url, wait: 'none' });
      return { id: context, url, type: 'page', bidi };
    },
    activate: (id) => activateContext(bidi, id),
    close: (id) => bidi.send('browsingContext.close', { context: id }).catch(() => {}),
  };
}

// BiDi won't switch to extension tabs, but they can switch to themselves.
async function activateContext(bidi, context) {
  try {
    await bidi.send('browsingContext.activate', { context });
  } catch (err) {
    if (!/privileged/.test(err.message)) throw err;
    await bidi.send('script.evaluate', {
      expression: 'chrome.tabs.getCurrent().then((t) => chrome.tabs.update(t.id, { active: true })).then(() => true)',
      target: { context }, awaitPromise: true,
    });
  }
}

async function bidiClient(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const handlers = new Set();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { r, j, method } = pending.get(m.id);
      pending.delete(m.id);
      if (m.type === 'error') j(new Error(`${method}: ${m.error}: ${m.message}`));
      else r(m.result);
      return;
    }
    if (m.type === 'event') for (const h of handlers) h(m.method, m.params);
  };
  return {
    send: (method, params = {}) => new Promise((r, j) => {
      const n = ++id; pending.set(n, { r, j, method }); ws.send(JSON.stringify({ id: n, method, params }));
    }),
    on: (h) => { handlers.add(h); return () => handlers.delete(h); },
    close: () => ws.close(),
  };
}

// BiDi's serialized values -> plain JS.
function fromRemote(r) {
  if (!r) return undefined;
  switch (r.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'number':
      return typeof r.value === 'string' ? { NaN, '-0': -0, Infinity, '-Infinity': -Infinity }[r.value] : r.value;
    case 'array': case 'set': return (r.value || []).map(fromRemote);
    case 'object': case 'map':
      return Object.fromEntries((r.value || []).map(([k, v]) => [typeof k === 'string' ? k : fromRemote(k), fromRemote(v)]));
    default: return 'value' in r ? r.value : {};
  }
}

async function connectFirefox(target, label) {
  const { bidi, id: context } = target;
  let acceptDialogs = false;
  const off = bidi.on((method, p) => {
    if (method === 'log.entryAdded' && p.source?.context === context && ['error', 'warn'].includes(p.level)) {
      problems.push(p.type === 'console' ? `[${label}] console.${p.level === 'warn' ? 'warning' : p.level}: ${p.text}` : `[${label}] ${p.text}`);
    }
    if (method === 'browsingContext.userPromptOpened' && p.context === context && acceptDialogs) {
      bidi.send('browsingContext.handleUserPrompt', { context, accept: true }).catch(() => {});
    }
  });
  const evaluate = (expression, { gesture = false, own = false } = {}) => bidi.send('script.evaluate', {
    expression, target: { context }, awaitPromise: true, userActivation: gesture,
    resultOwnership: own ? 'root' : 'none', serializationOptions: { maxObjectDepth: 20, maxDomDepth: 0 },
  });
  return {
    async ev(expression, opts) {
      const m = await evaluate(expression, opts);
      if (m.type === 'exception') throw new Error(`eval failed in ${label}: ${m.exceptionDetails.text}`);
      return fromRemote(m.result);
    },
    reload: () => bidi.send('browsingContext.reload', { context, wait: 'none' }),
    front: () => activateContext(bidi, context),
    acceptDialogs: () => { acceptDialogs = true; },
    async setFiles(selector, files) {
      const m = await evaluate(`document.querySelector(${JSON.stringify(selector)})`, { own: true });
      try {
        await bidi.send('input.setFiles', { context, element: { sharedId: m.result.sharedId }, files });
      } catch (err) {
        // Not allowed on extension pages: hand the page the files over HTTP instead.
        if (!/privileged/.test(err.message)) throw err;
        await setFilesByFetch(this, selector, files);
      }
    },
    close: off,
  };
}

async function setFilesByFetch(conn, selector, files) {
  // Serves exactly these files, at /0, /1, ...
  const server = createServer((req, res) => {
    const file = files[Number(req.url.slice(1))];
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': extname(file) === '.mp4' ? 'video/mp4' : 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const web = { close: () => server.close() };
  try {
    const list = files.map((f, i) => [`http://127.0.0.1:${server.address().port}/${i}`, f.split(/[\\/]/).pop()]);
    await conn.ev(`(async () => {
      const dt = new DataTransfer();
      for (const [url, name] of ${JSON.stringify(list)}) {
        const blob = await (await fetch(url)).blob();
        dt.items.add(new File([blob], name, { type: blob.type }));
      }
      const input = document.querySelector(${JSON.stringify(selector)});
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  } finally {
    web.close();
  }
}

// ---------------------------------------------------------------------------

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
