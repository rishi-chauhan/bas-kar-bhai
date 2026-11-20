import { getSettings, formatDuration } from '../lib/common.js';
import { resolveVideoUrl } from '../lib/media-db.js';

const params = new URLSearchParams(location.search);
const isTest = params.has('test');
const site = params.get('site') || 'this site';
const usedSec = Number(params.get('used') || 0);
const limitMin = Number(params.get('limit') || 0);

const $ = (id) => document.getElementById(id);
const video = $('video');
const closeTabBtn = $('closeTab');
const snoozeBtn = $('snooze');
let audioInBackground = false;

const settings = await getSettings();

// --- Words ---------------------------------------------------------------
if (isTest) {
  $('stats').textContent = "This is a test. When it's real, it'll show up on the site you've been wasting time on.";
  closeTabBtn.textContent = 'Close preview';
  snoozeBtn.hidden = true;
  $('fine').hidden = true;
} else {
  $('stats').innerHTML = '';
  $('stats').append(
    "You've spent ",
    bold(formatDuration(usedSec)),
    ' on ',
    bold(site),
    ' today. Your limit was ',
    bold(formatDuration(limitMin * 60)),
    '.'
  );
  snoozeBtn.textContent = `${settings.snoozeMinutes} min aur, please 🙏`;
}

function bold(text) {
  const b = document.createElement('b');
  b.textContent = text;
  return b;
}

// --- Video, as loud as the browser allows ---------------------------------
video.src = await resolveVideoUrl(settings.video);
video.volume = 1;
video.muted = false;

try {
  await video.play();
} catch {
  // The site hasn't had a click yet, so Chrome blocks sound in the page.
  // Play the picture muted here and the sound from the extension itself.
  video.muted = true;
  video.play().catch(() => {});
  audioInBackground = true;
  $('soundHint').hidden = false;
  chrome.runtime.sendMessage({ type: 'BKB_PLAY_AUDIO', video: settings.video }).catch(() => {});
}

// Begging for more time is only allowed after sitting through the shame.
const unlockSnooze = () => {
  snoozeBtn.disabled = false;
  $('fine').textContent = 'Fine. But we will be back.';
};
video.addEventListener('ended', unlockSnooze, { once: true });
video.addEventListener('error', () => setTimeout(unlockSnooze, 3000), { once: true });

// --- Buttons --------------------------------------------------------------
function dismiss() {
  video.pause();
  if (audioInBackground) chrome.runtime.sendMessage({ type: 'BKB_STOP_AUDIO' }).catch(() => {});
  window.parent.postMessage({ bkb: 'close' }, '*');
}

closeTabBtn.addEventListener('click', async () => {
  if (isTest) return dismiss();
  if (audioInBackground) await chrome.runtime.sendMessage({ type: 'BKB_STOP_AUDIO' }).catch(() => {});
  await chrome.runtime.sendMessage({ type: 'BKB_CLOSE_TAB' });
});

snoozeBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'BKB_SNOOZE', site });
  dismiss();
});

closeTabBtn.focus();
