// Plays a <video>/<audio> element on repeat between `start` and `end`
// (seconds; end 0 = the real end of the file). The built-in `loop` attribute
// always jumps back to 0:00, so we do the jumping ourselves.
// `onLap` runs every time it wraps around. Returns a function that stops it.
export function loopClip(media, { start = 0, end = 0 } = {}, onLap) {
  start = Math.max(0, Number(start) || 0);
  end = Math.max(0, Number(end) || 0);

  const toStart = () => {
    // A start past the end of a short file would loop forever on nothing.
    const s = Number.isFinite(media.duration) && start >= media.duration ? 0 : start;
    if (Math.abs(media.currentTime - s) > 0.05) media.currentTime = s;
  };
  const lap = () => {
    toStart();
    media.play().catch(() => {});
    onLap?.();
  };
  const onTime = () => {
    if (end > start && media.currentTime >= end) lap();
  };
  const onMeta = () => toStart();

  media.loop = false;
  media.addEventListener('loadedmetadata', onMeta);
  media.addEventListener('timeupdate', onTime);
  media.addEventListener('ended', lap);
  if (media.readyState >= 1) toStart();

  return () => {
    media.removeEventListener('loadedmetadata', onMeta);
    media.removeEventListener('timeupdate', onTime);
    media.removeEventListener('ended', lap);
  };
}
