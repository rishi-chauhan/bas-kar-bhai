// Invisible page that plays the blast's sound: on the built-in speakers
// (output devices are only reachable from a top-level extension page), or
// whenever the website's autoplay policy blocks sound in the overlay.
// Offscreen pages only get chrome.runtime, so settings arrive in the message.
import { resolveVideoUrl } from '../lib/media-db.js';
import { createPlayer } from '../lib/youtube.js';
import { attachBoost, chooseOutput } from '../lib/loudness.js';
import { loopClip } from '../lib/loop.js';

let audio = null;
let audioCtx = null;
let currentUrl = null;
let ytPlayer = null;

function stop() {
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

// Resolves to { device }: the name of the output it's playing on, or null for the default.
async function play({ video: choice, youtube, clip = null, boostDb = 0, outputMode = 'default', outputDevice = null }) {
  stop();

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
  audio = document.createElement('audio');
  document.body.append(audio);
  loopClip(audio, clip || {});
  currentUrl = await resolveVideoUrl(choice);
  audio.src = currentUrl;
  audio.volume = 1;

  const output = await chooseOutput(outputMode, outputDevice);
  const sinkId = output?.id || '';
  audioCtx = await attachBoost(audio, { boostDb, sinkId });
  // No Web Audio (boost off)? The element can still pick the device itself.
  if (!audioCtx && sinkId) await audio.setSinkId(sinkId).catch(() => {});
  await audio.play();
  return { device: output?.label || null };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;

  if (msg.type === 'PLAY') {
    play(msg).then(
      (result) => sendResponse({ ok: true, ...result }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (msg.type === 'STOP') {
    stop();
    sendResponse({ ok: true });
  }
});
