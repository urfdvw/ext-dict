/**
 * The few places where the Chrome extension and the hosted web app differ.
 *
 * The panel itself is the same code in both; it asks this module where to
 * keep small pieces of state, how to open an outside link, and how a lookup
 * request reaches it from elsewhere (the extension's context menu, or a
 * ?q= query in the web app's address bar).
 */

export const isExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

function webStore(backing) {
  return {
    async get(key) {
      try {
        const raw = backing.getItem(`mdict:${key}`);
        return raw == null ? undefined : JSON.parse(raw);
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      try {
        backing.setItem(`mdict:${key}`, JSON.stringify(value));
      } catch {
        /* private mode, or out of room */
      }
    },
    async remove(key) {
      try {
        backing.removeItem(`mdict:${key}`);
      } catch {
        /* nothing to undo */
      }
    },
  };
}

function extensionStore(area) {
  return {
    async get(key) {
      const values = await chrome.storage[area].get(key);
      return values[key];
    },
    async set(key, value) {
      try {
        await chrome.storage[area].set({ [key]: value });
      } catch {
        /* the panel closed mid-write */
      }
    },
    async remove(key) {
      try {
        await chrome.storage[area].remove(key);
      } catch {
        /* already gone */
      }
    },
  };
}

/** Survives restarts: the list of recent lookups. */
export const store = isExtension ? extensionStore('local') : webStore(localStorage);

/** Lives as long as the browsing session: the word last shown. */
export const session = isExtension ? extensionStore('session') : webStore(sessionStorage);

/** Open a link outside the panel. */
export function openExternal(url) {
  if (isExtension) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener,noreferrer');
}

function wordFromLocation() {
  const query = new URLSearchParams(location.search).get('q');
  const hash = location.hash.startsWith('#q=') ? decodeURIComponent(location.hash.slice(3)) : '';
  return (query || hash || '').trim();
}

/**
 * A word asked for before the panel was ready: parked by the extension's
 * service worker when the context menu was used, or given as ?q= / #q= in
 * the web app's address bar. Returns '' when there is none.
 */
export async function takeLookupRequest() {
  if (!isExtension) return wordFromLocation();
  const pending = await session.get('pendingQuery');
  if (!pending?.text) return '';
  await session.remove('pendingQuery');
  return pending.text;
}

/**
 * Words asked for while the panel is running.
 *
 * @param {(word: string) => void} handler
 */
export function onLookupRequest(handler) {
  if (!isExtension) {
    window.addEventListener('hashchange', () => {
      const word = wordFromLocation();
      if (word) handler(word);
    });
    return;
  }

  // Sent by the service worker when the panel is already open.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'lookup' && message.text) handler(message.text);
  });

  // The panel can become ready either side of the service worker parking a
  // word, so the stored value is watched as well as read at startup.
  chrome.storage.session.onChanged?.addListener(async (changes) => {
    if (!changes.pendingQuery?.newValue?.text) return;
    const word = await takeLookupRequest();
    if (word) handler(word);
  });
}
