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

  let ctx;
  try {
    ctx = new AudioContext(sinkId ? { sinkId, latencyHint: 'playback' } : { latencyHint: 'playback' });
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

  source.connect(gain).connect(limiter).connect(ctx.destination);
  return ctx;
}

// Finds the saved output device among the ones currently connected. Device
// ids can change, so fall back to matching the label. Returns '' (default
// output) if it's not connected right now.
export async function findSinkId(saved) {
  if (!saved?.id) return '';
  try {
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const match = outputs.find((d) => d.deviceId === saved.id) || outputs.find((d) => d.label && d.label === saved.label);
    return match && match.deviceId !== 'default' ? match.deviceId : '';
  } catch {
    return '';
  }
}

// Lists output devices. Chrome only reveals them after the microphone
// permission is granted, so this asks for it (and immediately lets go of the
// mic, nothing is recorded).
export async function listOutputDevices() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d) => ({ id: d.deviceId, label: d.label || 'Unnamed output' }));
}
