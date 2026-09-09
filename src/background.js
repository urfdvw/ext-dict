/**
 * Service worker: opens the side panel and wires up the right-click lookup.
 */

const MENU_ID = 'mdict-lookup';

// Clicking the toolbar icon opens the panel.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Look up “%s” in MDict',
      contexts: ['selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const text = (info.selectionText || '').trim();
  if (!text) return;
  await openPanel(tab?.windowId, text);
});

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'open-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await openPanel(tab?.windowId);
});

/**
 * Open the side panel and hand it a word. The panel may still be loading, so
 * the word is also parked in session storage for it to pick up on start.
 */
async function openPanel(windowId, text) {
  // Opening has to start in the same task as the user gesture, so it goes
  // first and everything else waits on it.
  const opening =
    windowId != null
      ? chrome.sidePanel.open({ windowId }).catch((error) => {
          console.warn('Could not open the side panel:', error);
        })
      : Promise.resolve();
  if (text) {
    // A panel that is still starting up picks the word up from here.
    await chrome.storage.session.set({ pendingQuery: { text, at: Date.now() } });
  }
  await opening;
  if (text) {
    // Reaches a panel that was already open; harmless when nothing listens.
    chrome.runtime.sendMessage({ type: 'lookup', text }).catch(() => {});
  }
}
