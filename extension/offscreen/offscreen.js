// Chrome's invisible page for the blast's sound (see lib/player.js).
// Offscreen pages only get chrome.runtime, so settings arrive in the message.
import { play, stop, status } from '../lib/player.js';

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

  if (msg.type === 'STATUS') sendResponse({ ok: true, ...status() });
});
