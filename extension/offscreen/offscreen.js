// Invisible page that plays the blast's sound when the overlay can't
// (the website's autoplay policy blocked unmuted playback).
// Offscreen pages only get chrome.runtime, so settings arrive in the message.
import { resolveVideoUrl } from '../lib/media-db.js';
import { createPlayer } from '../lib/youtube.js';

const audio = document.getElementById('audio');
let currentUrl = null;
let ytPlayer = null;

function stop() {
  audio.pause();
  audio.currentTime = 0;
  ytPlayer?.destroy();
  ytPlayer = null;
}

async function play(choice, youtube) {
  stop();
  if (choice === 'youtube') {
    if (youtube?.id) {
      ytPlayer = createPlayer(document.body, youtube, {
        onReady: () => {
          ytPlayer.loud();
          ytPlayer.play();
        },
        onState: (state) => state === 1 && ytPlayer?.loud(),
      });
      return;
    }
    choice = 'default';
  }
  if (currentUrl?.startsWith('blob:')) URL.revokeObjectURL(currentUrl);
  currentUrl = await resolveVideoUrl(choice);
  audio.src = currentUrl;
  audio.volume = 1;
  audio.muted = false;
  await audio.play();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;

  if (msg.type === 'PLAY') {
    play(msg.video, msg.youtube).then(
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
