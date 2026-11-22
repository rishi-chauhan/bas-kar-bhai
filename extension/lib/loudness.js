// Making the blast louder than "volume 100%" allows, without touching the
// system volume (which no extension can do).
//
//   media element -> gain (+N dB) -> compressor/limiter -> output device
//
// The gain pushes quiet clips up; the compressor squashes the peaks so the
// result is as loud as possible without turning into crackle. Optionally the
// whole thing plays on a chosen output device (e.g. laptop speakers while
// Bluetooth headphones are connected).

export const BOOST_LEVELS = [
  { db: 0, label: 'Off (plain 100%)' },
  { db: 6, label: 'Loud (+6 dB)' },
  { db: 12, label: 'Very loud (+12 dB)' },
  { db: 18, label: 'Ear-splitting (+18 dB)' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Routes `media` through the boost chain. Returns the AudioContext, or null if
// nothing was attached (no boost wanted, or the browser wouldn't start audio
// here, in which case `media` is left untouched and still plays normally).
// Must be called at most once per media element.
export async function attachBoost(media, { boostDb = 0, sinkId = '' } = {}) {
  if (!boostDb && !sinkId) return null;

  // Firefox can't point an AudioContext at a device (it ignores `sinkId`), so
  // there the boosted sound leaves through an <audio> element that can.
  const ctxSink = sinkId && 'setSinkId' in AudioContext.prototype ? sinkId : '';
  let ctx;
  try {
    ctx = new AudioContext(ctxSink ? { sinkId: ctxSink, latencyHint: 'playback' } : { latencyHint: 'playback' });
  } catch {
    // Device unplugged or not allowed: fall back to the default output.
    if (!boostDb) return null;
    ctx = new AudioContext({ latencyHint: 'playback' });
  }

  // The site's autoplay rules apply to AudioContext too. If it won't start,
  // hooking the element up would silence it, so back off.
  if (ctx.state !== 'running') await Promise.race([ctx.resume(), sleep(400)]);
  if (ctx.state !== 'running') {
    ctx.close();
    return null;
  }

  const source = ctx.createMediaElementSource(media);
  const gain = ctx.createGain();
  gain.gain.value = 10 ** (boostDb / 20);

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;

  source.connect(gain).connect(limiter);
  if (sinkId && !ctxSink && (await routeToDevice(ctx, limiter, sinkId))) return ctx;
  limiter.connect(ctx.destination);
  return ctx;
}

// Plays `node`'s output on device `sinkId` through an <audio> element, which
// is stopped along with `ctx`. Returns false if the device can't be used.
async function routeToDevice(ctx, node, sinkId) {
  const stream = ctx.createMediaStreamDestination();
  const out = new Audio();
  try {
    await out.setSinkId(sinkId);
  } catch {
    return false;
  }
  node.connect(stream);
  out.srcObject = stream.stream;
  out.play().catch(() => {});
  const close = ctx.close.bind(ctx);
  ctx.close = () => {
    out.pause();
    out.srcObject = null;
    return close();
  };
  return true;
}

// ---------------------------------------------------------------------------
// Output devices
//
// Browsers hide output devices (empty ids and labels) until the extension has
// microphone permission, and gives no "this is the built-in speaker" flag,
// only a name. So: ask for the mic once, then pick the speakers by name.

// Names that look like built-in / wired speakers.
const SPEAKER_HINTS = /speaker|built-?in|internal|analog|realtek|hd audio|high definition|laptop|notebook/i;
// Names that look like headphones, Bluetooth gear, monitors/TVs or virtual devices.
const NOT_SPEAKER_HINTS =
  /head(phone|set)|earphone|ear ?buds?|\bbuds\b|airpods|hands-?free|bluetooth|\bbt\b|hdmi|displayport|\bdp\b|monitor|\btv\b|\b(wh|wf)-|xm\d|bose|jbl|beats|sennheiser|jabra|usb|virtual|loopback|cable|dummy|null|steam|discord|zoom|teams/i;

function speakerScore(label) {
  return (SPEAKER_HINTS.test(label) ? 2 : 0) - (NOT_SPEAKER_HINTS.test(label) ? 3 : 0);
}

// Best guess at the built-in speakers among `outputs` ({id, label}), or null
// if nothing looks like a speaker (e.g. a desktop with only headphones).
export function pickSpeaker(outputs) {
  let best = null;
  let bestScore = 0;
  for (const d of outputs) {
    const score = speakerScore(d.label || '');
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

// Output devices currently connected, without prompting. Returns null if the
// mic permission hasn't been granted (browsers hide the devices until then).
export async function currentOutputs() {
  try {
    // Firefox holds the answer back until the page is on screen, which a
    // background page never is: don't wait forever.
    const devices = await Promise.race([navigator.mediaDevices.enumerateDevices(), sleep(1500).then(() => [])]);
    const all = devices.filter((d) => d.kind === 'audiooutput');
    if (!all.some((d) => d.label)) return null;
    return all
      .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ id: d.deviceId, label: d.label || 'Unnamed output' }));
  } catch {
    return null;
  }
}

// Asks for the mic permission (released immediately, nothing is recorded) and
// returns the connected outputs.
export async function requestOutputs() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  return (await currentOutputs()) || [];
}

// Which device the blast should play on, given the settings:
//   mode 'auto'    -> the built-in speakers
//   mode 'manual'  -> `device`, or the speakers if it's not connected
//   mode 'default' -> whatever the system is using
// Returns {id, label} or null for the default output.
export async function chooseOutput(mode, device) {
  if (mode === 'default') return null;
  const outputs = await currentOutputs();
  if (!outputs) return null;
  if (mode === 'manual' && device?.id) {
    // Ids can change between sessions; the name is a decent fallback.
    const match = outputs.find((d) => d.id === device.id) || outputs.find((d) => d.label === device.label);
    if (match) return match;
  }
  return pickSpeaker(outputs);
}

// The mic permission state for this extension: 'granted', 'denied' or 'prompt'.
export async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    return 'prompt';
  }
}
