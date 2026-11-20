// Invisible page that plays the blast's sound when the overlay can't: the
// website's autoplay policy blocked it, or the sound must go to a specific
// output device (only reachable from a top-level extension page).
// Offscreen pages only get chrome.runtime, so settings arrive in the message.
import { resolveVideoUrl } from '../lib/media-db.js';
import { createPlayer } from '../lib/youtube.js';
import { attachBoost, findSinkId } from '../lib/loudness.js';

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

async function play({ video: choice, youtube, boostDb = 0, outputDevice = null }) {
  stop();

  // YouTube's audio lives in a cross-origin frame: it can't be boosted or
  // re-routed, only played at its own 100%.
  if (choice === 'youtube' && youtube?.id) {
    ytPlayer = createPlayer(document.body, youtube, {
      onReady: () => {
        ytPlayer.loud();
        ytPlayer.play();
      },
      onState: (state) => state === 1 && ytPlayer?.loud(),
    });
    return;
  }
  if (choice === 'youtube') choice = 'default';

  // A fresh element each time: an element can only be wired into Web Audio once.
  audio = document.createElement('audio');
  document.body.append(audio);
  currentUrl = await resolveVideoUrl(choice);
  audio.src = currentUrl;
  audio.volume = 1;

  const sinkId = await findSinkId(outputDevice);
  audioCtx = await attachBoost(audio, { boostDb, sinkId });
  // No Web Audio (boost off)? The element can still pick the device itself.
  if (!audioCtx && sinkId) await audio.setSinkId(sinkId).catch(() => {});
  await audio.play();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;

  if (msg.type === 'PLAY') {
    play(msg).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (msg.type === 'STOP') {
    stop();
    sendResponse({ ok: true });
  }
});
