// Custom videos are too big for chrome.storage, so they live in the
// extension's own IndexedDB. Every extension page (options, overlay,
// offscreen) shares the same origin, so they all see the same database.

const DB_NAME = 'bas-kar-bhai';
const STORE = 'media';
const CUSTOM_KEY = 'custom-video';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function saveCustomVideo(blob, name) {
  return run('readwrite', (s) => s.put({ blob, name, savedAt: Date.now() }, CUSTOM_KEY));
}

export async function loadCustomVideo() {
  return (await run('readonly', (s) => s.get(CUSTOM_KEY))) || null;
}

export function deleteCustomVideo() {
  return run('readwrite', (s) => s.delete(CUSTOM_KEY));
}

const DEFAULT_VIDEO_URL = chrome.runtime.getURL('media/default.mp4');

// URL of the video to play, honouring the user's choice. Falls back to the
// bundled video if the custom one is missing.
export async function resolveVideoUrl(choice) {
  if (choice === 'custom') {
    const rec = await loadCustomVideo().catch(() => null);
    if (rec?.blob) return URL.createObjectURL(rec.blob);
  }
  return DEFAULT_VIDEO_URL;
}
