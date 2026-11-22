import { getSettings, formatDuration } from '../lib/common.js';
import { resolveVideoUrl } from '../lib/media-db.js';
import { createPlayer } from '../lib/youtube.js';
import { attachBoost } from '../lib/loudness.js';
import { loopClip } from '../lib/loop.js';
import { $, el } from '../lib/dom.js';

// This page has to be web-accessible so it can be framed on the offending
// site, which means any website could frame it too. So it only runs when the
// extension itself opened it: a real blast carries a one-time token that the
// worker issued for this very tab, and a test preview must sit inside one of
// our own pages.
const params = new URLSearchParams(location.search);
const isTest = params.has('test') && framedByExtension();
const blastInfo = isTest ? {} : await claimBlast(params.get('token'));
if (!blastInfo) {
  document.documentElement.hidden = true;
  throw new Error('[bas-kar-bhai] overlay opened without a valid blast token');
}
const site = blastInfo.site || 'this site';
const usedSec = Number(blastInfo.used || 0);
const limitMin = Number(blastInfo.limit || 0);

// Is the direct parent one of our own pages? (Firefox has no
// location.ancestorOrigins; reading a cross-origin parent's location throws.)
function framedByExtension() {
  if (window.parent === window) return false;
  if (location.ancestorOrigins) return location.ancestorOrigins[0] === location.origin;
  try {
    return window.parent.location.origin === location.origin;
  } catch {
    return false;
  }
}

async function claimBlast(token) {
  if (!token) return null;
  const res = await chrome.runtime.sendMessage({ type: 'BKB_CLAIM_BLAST', token }).catch(() => null);
  return res?.ok ? res.blast || null : null;
}

const video = $('video');
const closeTabBtn = $('closeTab');
const snoozeBtn = $('snooze');
let audioInBackground = false;
let keepAlive = null;
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
  return el('b', '', text);
}

// Begging for more time is only allowed after sitting through the shame.
function unlockSnooze() {
  if (!snoozeBtn.disabled) return;
  snoozeBtn.disabled = false;
  $('fine').textContent = 'Fine. But we will be back.';
}

// The extension plays the sound in the background instead of this frame: to
// reach the built-in speakers, or because the site blocked sound.
// Resolves to the background's answer ({ ok, device }).
async function soundFromBackground(choice) {
  if (audioInBackground) return { ok: true };
  audioInBackground = true;
  const res = await chrome.runtime
    .sendMessage({
      type: 'BKB_PLAY_AUDIO',
      video: choice,
      youtube: settings.youtube,
      clip: clipFor(choice),
      boostDb: settings.boostDb,
      outputMode: choice === 'youtube' ? 'default' : settings.outputMode,
      outputDevice: settings.outputDevice,
    })
    .catch((err) => ({ ok: false, error: String(err) }));
  if (res?.ok) {
    // Firefox unloads an idle background page, sound and all.
    keepAlive ||= setInterval(() => chrome.runtime.sendMessage({ type: 'BKB_KEEPALIVE' }).catch(() => {}), 10000);
    $('soundHint').textContent = res.device ? `🔊 blasting on ${res.device}` : '🔊 sound playing in the background';
    $('soundHint').hidden = false;
  } else {
    audioInBackground = false;
  }
  return res || { ok: false };
}

// Start/stop times for a file: only the uploaded one has them.
function clipFor(choice) {
  return choice === 'custom' ? settings.customClip : null;
}

// --- A video file (bundled or uploaded) -----------------------------------
async function playFile(choice) {
  video.hidden = false;
  const clip = clipFor(choice) || {};
  // Plays on repeat; one full lap earns you the right to beg.
  loopClip(video, clip, unlockSnooze);
  video.addEventListener('error', () => setTimeout(unlockSnooze, 3000), { once: true });
  video.src = await resolveVideoUrl(choice);
  video.volume = 1;

  // Speakers wanted: output devices are only reachable from the extension's
  // top-level page, so the sound goes there and the picture plays silently here.
  if (settings.outputMode !== 'default') {
    video.muted = true;
    video.play().catch(() => {});
    if ((await soundFromBackground(choice)).ok) return;
    // That failed somehow: fall back to playing the sound right here.
    video.pause();
    video.currentTime = clip.start || 0;
  }

  video.muted = false;
  try {
    await video.play();
  } catch {
    // The site hasn't had a click yet, so the browser blocks sound in the page.
    video.muted = true;
    video.play().catch(() => {});
    soundFromBackground(choice);
    return;
  }
  // Playing with sound: now push it past 100%.
  await attachBoost(video, { boostDb: settings.boostDb });
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
    loop: true,
    onLap: unlockSnooze,
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
  clearInterval(keepAlive);
  keepAlive = null;
  chrome.runtime.sendMessage({ type: 'BKB_BLAST_DONE' }).catch(() => {});
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
