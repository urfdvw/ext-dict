/**
 * Entry point for the hosted web app.
 *
 * It is the same panel the extension runs, plus the service worker that
 * keeps the app usable without a network — the dictionaries themselves are
 * already local, in IndexedDB.
 */

document.documentElement.classList.add('web-app');

import('./sidepanel.js');

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(new URL('../sw.js', import.meta.url))
      .catch((error) => console.warn('Offline support is unavailable:', error));
  });
}
