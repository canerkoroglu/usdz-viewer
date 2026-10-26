// IndexedDB persistence for gallery preview thumbnails.
// Every operation degrades gracefully: if IndexedDB is unavailable (private
// mode, storage disabled, quota) previews simply are not persisted.

const DB_NAME = 'usdz-viewer';
const STORE = 'thumbs';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** Load every stored thumbnail into `target` (a Map: name -> entry). */
export async function loadAllThumbs(target) {
  const db = await openDb();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        target.set(cursor.key, cursor.value);
        cursor.continue();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Persist one thumbnail entry under `name` (fire-and-forget). */
export async function putThumb(name, entry) {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry, name);
  } catch {
    /* quota / private mode — the in-memory copy still works */
  }
}
