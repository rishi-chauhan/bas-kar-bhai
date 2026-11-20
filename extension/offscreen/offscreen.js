// Invisible page that plays the blast's audio when the overlay can't
// (the website's autoplay policy blocked unmuted playback).
import { resolveVideoUrl } from '../lib/media-db.js';

const audio = document.getElementById('audio');
let currentUrl = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;

  if (msg.type === 'PLAY') {
    (async () => {
      if (currentUrl?.startsWith('blob:')) URL.revokeObjectURL(currentUrl);
      currentUrl = await resolveVideoUrl(msg.video);
      audio.src = currentUrl;
      audio.volume = 1;
      audio.muted = false;
      await audio.play();
    })().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (msg.type === 'STOP') {
    audio.pause();
    audio.currentTime = 0;
    sendResponse({ ok: true });
  }
});
