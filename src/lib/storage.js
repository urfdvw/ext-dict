/**
 * IndexedDB storage for the dictionary library.
 *
 * Three stores:
 *   dicts    one record per dictionary (name, which files belong to it)
 *   files    the uploaded .mdx / .mdd blobs, keyed by file id
 *   indexes  the parsed key index for each file, keyed by the same file id
 */

const DB_NAME = 'mdict-side-panel';
const DB_VERSION = 1;

export const STORE_DICTS = 'dicts';
export const STORE_FILES = 'files';
export const STORE_INDEXES = 'indexes';

let dbPromise = null;

export function openDatabase() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_DICTS)) db.createObjectStore(STORE_DICTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_INDEXES)) db.createObjectStore(STORE_INDEXES, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function run(store, mode, action) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = action(tx.objectStore(store));
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        if (request) {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        } else {
          tx.oncomplete = () => resolve();
        }
      })
  );
}

export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const getAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const put = (store, value) => run(store, 'readwrite', (s) => s.put(value));
export const remove = (store, key) => run(store, 'readwrite', (s) => s.delete(key));

/** Ask the browser not to evict the dictionaries when disk gets tight. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* not fatal */
  }
  return false;
}

export async function usage() {
  try {
    const { usage: used = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {};
    return { used, quota };
  } catch {
    return { used: 0, quota: 0 };
  }
}
