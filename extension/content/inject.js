// Injected into the offending tab by the background worker. It mounts the
// overlay (an extension page) in a full-screen iframe on top of everything.
// Safe to inject more than once.

(() => {
  if (window.__basKarBhai) return;
  window.__basKarBhai = true;

  const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  let frame = null;
  let mediaTimer = null;

  // Shut up whatever the page is playing (and keep it shut — YouTube loves
  // auto-playing the next video).
  function pausePageMedia() {
    for (const el of document.querySelectorAll('video, audio')) {
      if (!el.paused) el.pause();
    }
  }

  function show(query, pauseMedia) {
    if (frame) return;

    if (pauseMedia) {
      pausePageMedia();
      mediaTimer = setInterval(pausePageMedia, 1000);
    }

    frame = document.createElement('iframe');
    frame.src = `${chrome.runtime.getURL('overlay/overlay.html')}?${query}`;
    frame.allow = 'autoplay; fullscreen';
    frame.setAttribute(
      'style',
      [
        'position:fixed', 'inset:0', 'width:100vw', 'height:100vh', 'border:0', 'margin:0',
        'padding:0', 'z-index:2147483647', 'display:block', 'opacity:1', 'visibility:visible',
        'background:transparent', 'color-scheme:normal',
      ].map((rule) => `${rule} !important`).join(';')
    );

    // A fullscreen video hides everything outside the fullscreen element, so
    // mount inside it — or leave fullscreen if we can't.
    const fs = document.fullscreenElement;
    let host = document.documentElement;
    if (fs && fs.tagName !== 'VIDEO' && fs.tagName !== 'IFRAME') host = fs;
    else if (fs) document.exitFullscreen().catch(() => {});

    host.appendChild(frame);
    frame.addEventListener('load', () => frame?.focus());
  }

  function hide() {
    clearInterval(mediaTimer);
    mediaTimer = null;
    frame?.remove();
    frame = null;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'BKB_SHOW') show(msg.query, msg.pauseMedia);
  });

  window.addEventListener('message', (event) => {
    if (event.origin !== EXT_ORIGIN || !frame || event.source !== frame.contentWindow) return;
    if (event.data?.bkb === 'close') hide();
  });
})();
