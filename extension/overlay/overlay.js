import { getSettings, formatDuration } from '../lib/common.js';
import { resolveVideoUrl } from '../lib/media-db.js';
import { createPlayer } from '../lib/youtube.js';

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
let ytPlayer = null;

const settings = await getSettings();

// --- Words ---------------------------------------------------------------
if (isTest) {
  $('stats').textContent = "This is a test. When it's real, it'll show up on the site you've been wasting time on.";
  closeTabBtn.textContent = 'Close preview';
  snoozeBtn.hidden = true;
  $('fine').hidden = true;
} else {
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

// Begging for more time is only allowed after sitting through the shame.
function unlockSnooze() {
  if (!snoozeBtn.disabled) return;
  snoozeBtn.disabled = false;
  $('fine').textContent = 'Fine. But we will be back.';
}

// Sound couldn't start in the page, so the extension's hidden offscreen page
// plays it instead.
function soundFromBackground(choice) {
  if (audioInBackground) return;
  audioInBackground = true;
  $('soundHint').hidden = false;
  chrome.runtime.sendMessage({ type: 'BKB_PLAY_AUDIO', video: choice, youtube: settings.youtube }).catch(() => {});
}

// --- A video file (bundled or uploaded) -----------------------------------
async function playFile(choice) {
  video.hidden = false;
  video.addEventListener('ended', unlockSnooze, { once: true });
  video.addEventListener('error', () => setTimeout(unlockSnooze, 3000), { once: true });
  video.src = await resolveVideoUrl(choice);
  video.volume = 1;
  video.muted = false;
  try {
    await video.play();
  } catch {
    // The site hasn't had a click yet, so Chrome blocks sound in the page.
    video.muted = true;
    video.play().catch(() => {});
    soundFromBackground(choice);
  }
}

// --- A YouTube video -------------------------------------------------------
function playYouTube(yt) {
  video.hidden = true;
  let gaveUp = false;

  const giveUp = () => {
    // Offline, deleted video, embedding turned off... the siren never fails.
    if (gaveUp) return;
    gaveUp = true;
    ytPlayer?.destroy();
    ytPlayer = null;
    playFile('default');
  };

  // Did the browser let it play with sound? YouTube either refuses to start
  // or starts muted when the site's autoplay policy says no.
  let verdict = null;
  const decide = () => {
    if (verdict || gaveUp || !ytPlayer) return;
    if (ytPlayer.state === 1 && ytPlayer.muted === false) verdict = 'loud';
    else if (ytPlayer.state === 1 && ytPlayer.muted === true) verdict = 'muted';
    if (verdict === 'muted') soundFromBackground('youtube');
  };

  ytPlayer = createPlayer($('screen'), yt, {
    onReady() {
      ytPlayer.loud();
      ytPlayer.play();
      // Still not playing after a few seconds (and not just buffering): blocked.
      setTimeout(() => {
        decide();
        if (verdict || gaveUp || !ytPlayer || ytPlayer.state === 3) return;
        verdict = 'blocked';
        ytPlayer.mute();
        ytPlayer.play();
        soundFromBackground('youtube');
      }, 5000);
    },
    onState(state) {
      if (state === 1) {
        if (!audioInBackground) ytPlayer?.loud();
        // Give YouTube a beat to report its muted flag.
        setTimeout(decide, 600);
      }
      if (state === 0) unlockSnooze();
    },
    onError: giveUp,
  });

  // No answer from YouTube at all (offline, blocked): use the siren.
  setTimeout(() => !ytPlayer?.connected && giveUp(), 8000);
  // Long video with no "Stop at"? You've suffered enough after a minute.
  setTimeout(unlockSnooze, 60000);
}

if (settings.video === 'youtube' && settings.youtube?.id) playYouTube(settings.youtube);
else await playFile(settings.video);

// --- Buttons --------------------------------------------------------------
function stopEverything() {
  video.pause();
  ytPlayer?.destroy();
  ytPlayer = null;
  if (audioInBackground) return chrome.runtime.sendMessage({ type: 'BKB_STOP_AUDIO' }).catch(() => {});
}

function dismiss() {
  stopEverything();
  window.parent.postMessage({ bkb: 'close' }, '*');
}

closeTabBtn.addEventListener('click', async () => {
  if (isTest) return dismiss();
  await stopEverything();
  await chrome.runtime.sendMessage({ type: 'BKB_CLOSE_TAB' });
});

snoozeBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'BKB_SNOOZE', site });
  dismiss();
});

closeTabBtn.focus();
