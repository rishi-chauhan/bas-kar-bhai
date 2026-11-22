// YouTube support: parse links, build embed URLs, and drive the embedded
// player over postMessage (the official IFrame API script is remote code,
// which MV3 extensions can't load, so we speak its message protocol directly).

// Marker on our own embed URLs. The background worker adds a Referer header
// only to requests carrying it. Without a Referer, YouTube refuses to play
// embeds inside extension pages ("Error 153").
const EMBED_MARKER = 'bkb=1';
const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
export const REFERER_RULE_ID = 1;

export function refererRule() {
  return {
    id: REFERER_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'referer', operation: 'set', value: `https://${chrome.runtime.id}.chromiumapp.org/` },
      ],
    },
    condition: {
      urlFilter: `||youtube-nocookie.com/embed/*${EMBED_MARKER}`,
      resourceTypes: ['sub_frame'],
    },
  };
}

// "1m30s", "90", "1:30" -> 90
export function parseTime(value) {
  if (value == null || value === '') return 0;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.floor(Number(s));
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (m && m[0]) return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  return NaN;
}

// Accepts youtu.be/ID, youtube.com/watch?v=ID, /shorts/ID, /embed/ID, /live/ID,
// music.youtube.com, m.youtube.com, a bare 11-char ID. Returns {id, start} or null.
export function parseYouTubeUrl(input) {
  const raw = String(input || '').trim();
  if (/^[\w-]{11}$/.test(raw)) return { id: raw, start: 0 };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
      if (m) id = m[2];
    }
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const start = parseTime(url.searchParams.get('t') || url.searchParams.get('start') || 0);
  return { id, start: Number.isFinite(start) ? start : 0 };
}

function embedUrl({ id, start = 0, end = 0 }, { controls = false, autoplay = true } = {}) {
  const p = new URLSearchParams({
    autoplay: autoplay ? '1' : '0',
    controls: controls ? '1' : '0',
    disablekb: controls ? '0' : '1',
    enablejsapi: '1',
    rel: '0',
    playsinline: '1',
    iv_load_policy: '3',
    fs: '0',
  });
  if (start > 0) p.set('start', String(start));
  if (end > start) p.set('end', String(end));
  return `${EMBED_ORIGIN}/embed/${id}?${p}&${EMBED_MARKER}`;
}

// The video's title, for showing the user what they picked.
export async function fetchVideoInfo(id) {
  const res = await fetch(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`
  );
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'embedding disabled' : `HTTP ${res.status}`);
  const data = await res.json();
  return { title: data.title };
}

// Embeds a player in `container` and returns a small controller.
//   onState(state): -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
//   onError(code): 2 bad id, 5 HTML5 error, 100 not found, 101/150 embedding disabled
//   loop: replay video.start..video.end forever; onLap() runs on every wrap.
export function createPlayer(
  container,
  video,
  { controls = false, autoplay = true, loop = false, onReady, onState, onError, onLap } = {}
) {
  const frame = document.createElement('iframe');
  frame.allow = 'autoplay; encrypted-media';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.src = embedUrl(video, { controls, autoplay });
  frame.title = 'YouTube video';
  container.append(frame);

  let connected = false;
  let state = -1;
  let muted = null;
  let currentTime = 0;
  let lapping = false;
  const start = Math.max(0, Number(video.start) || 0);
  const end = Number(video.end) > start ? Number(video.end) : 0;
  const post = (message) => frame.contentWindow?.postMessage(JSON.stringify(message), EMBED_ORIGIN);
  const send = (func, args = []) => post({ event: 'command', func, args, id: 1, channel: 'widget' });

  const onMessage = (event) => {
    if (event.source !== frame.contentWindow || event.origin !== EMBED_ORIGIN) return;
    let data;
    try {
      data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (!connected) {
      connected = true;
      onReady?.();
    }
    if (typeof data.info?.muted === 'boolean') muted = data.info.muted;
    if (typeof data.info?.currentTime === 'number') {
      currentTime = data.info.currentTime;
      if (lapping && (!end || currentTime < end - 0.5)) lapping = false;
      // The embed's `end` only reliably stops the first play-through, so
      // watch the clock too.
      if (loop && end && currentTime >= end && !lapping) lap();
    }
    const next =
      data.event === 'onStateChange' ? data.info : data.event === 'infoDelivery' ? data.info?.playerState : undefined;
    if (typeof next === 'number' && next !== state) {
      state = next;
      onState?.(state);
      if (loop && state === 0 && !lapping) lap();
    }
    if (data.event === 'onError') onError?.(data.info);
  };
  window.addEventListener('message', onMessage);

  function lap() {
    lapping = true;
    send('seekTo', [start, true]);
    send('playVideo');
    onLap?.();
  }

  // The player only talks back after we say we're listening.
  const handshake = setInterval(() => {
    if (connected) return clearInterval(handshake);
    post({ event: 'listening', id: 1, channel: 'widget' });
  }, 200);
  setTimeout(() => clearInterval(handshake), 15000);

  return {
    get state() { return state; },
    get muted() { return muted; },
    get connected() { return connected; },
    play: () => send('playVideo'),
    pause: () => send('pauseVideo'),
    mute: () => send('mute'),
    // Unmuted at volume 100.
    loud() { send('unMute'); send('setVolume', [100]); },
    destroy() {
      clearInterval(handshake);
      window.removeEventListener('message', onMessage);
      frame.remove();
    },
  };
}
