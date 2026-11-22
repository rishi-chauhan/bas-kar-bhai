// Plays the blast's sound away from the website: on the built-in speakers
// (output devices are only reachable from a top-level extension page), or
// whenever the website's autoplay policy blocks sound in the overlay.
//
// Where it runs depends on the browser:
//   * Chrome: in the offscreen document (offscreen/offscreen.js).
//   * Firefox: right in the background page, which has a DOM there.
import { resolveVideoUrl } from './media-db.js';
import { createPlayer } from './youtube.js';
import { attachBoost, chooseOutput } from './loudness.js';
import { loopClip } from './loop.js';

let audio = null;
let audioCtx = null;
let currentUrl = null;
let ytPlayer = null;

export function stop() {
  generation++;
  audio?.pause();
  audio?.remove();
  audio = null;
  audioCtx?.close();
  audioCtx = null;
  ytPlayer?.destroy();
  ytPlayer = null;
  if (currentUrl?.startsWith('blob:')) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
}

// Whether a blast is sounding right now.
export function status() {
  if (ytPlayer) return { playing: ytPlayer.state === 1 };
  return { playing: !!audio && !audio.paused && audio.currentTime > 0 };
}

// Bumped by every play/stop, so a slow play() that got overtaken gives up.
let generation = 0;

// Resolves to { device }: the name of the output it's playing on, or null for the default.
export async function play({ video: choice, youtube, clip = null, boostDb = 0, outputMode = 'default', outputDevice = null }) {
  stop();
  const mine = ++generation;

  // YouTube's audio lives in a cross-origin frame: it can't be boosted or
  // re-routed, only played at its own 100%.
  if (choice === 'youtube' && youtube?.id) {
    ytPlayer = createPlayer(document.body, youtube, {
      loop: true,
      onReady: () => {
        ytPlayer.loud();
        ytPlayer.play();
      },
      onState: (state) => state === 1 && ytPlayer?.loud(),
    });
    return { device: null };
  }
  if (choice === 'youtube') choice = 'default';

  // A fresh element each time: an element can only be wired into Web Audio once.
  const el = (audio = document.createElement('audio'));
  document.body.append(el);
  loopClip(el, clip || {});
  const url = (currentUrl = await resolveVideoUrl(choice));
  if (mine !== generation) return { device: null };
  el.src = url;
  el.volume = 1;

  const output = await chooseOutput(outputMode, outputDevice);
  const sinkId = output?.id || '';
  const ctx = await attachBoost(el, { boostDb, sinkId });
  if (mine !== generation) {
    ctx?.close();
    return { device: null };
  }
  audioCtx = ctx;
  // No Web Audio (boost off)? The element can still pick the device itself.
  if (!ctx && sinkId) await el.setSinkId(sinkId).catch(() => {});
  await el.play();
  return { device: output?.label || null };
}
