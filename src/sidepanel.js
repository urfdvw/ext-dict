/**
 * The side panel: search box, suggestion list, entry viewer and the
 * dictionary library screen.
 */

import {
  Library,
  deleteDictionary,
  groupFiles,
  importDictionary,
  listDictionaries,
  setEnabled,
} from './lib/library.js';
import { buildEntryDocument } from './lib/render.js';
import { usage } from './lib/storage.js';

const el = (id) => document.getElementById(id);
const ui = {
  back: el('back'),
  query: el('query'),
  clear: el('clear'),
  showHistory: el('show-history'),
  openLibrary: el('open-library'),
  tabs: el('tabs'),
  suggestions: el('suggestions'),
  placeholder: el('placeholder'),
  placeholderAdd: el('placeholder-add'),
  viewer: el('viewer'),
  library: el('library'),
  closeLibrary: el('close-library'),
  dropzone: el('dropzone'),
  files: el('files'),
  imports: el('imports'),
  dictList: el('dict-list'),
  storageNote: el('storage-note'),
  toast: el('toast'),
};

const hasChromeApis = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
const library = new Library();

const HISTORY_LIMIT = 100;

let options = [];
let optionRows = [];
let highlighted = -1;
let entry = { word: '', results: [], active: 0 };
let backStack = [];
let recent = [];
let pendingDocument = null;
let renderSeq = 0;
let deliverTimer = 0;
let toastTimer = 0;

/* ------------------------------------------------------------------ boot */

async function start() {
  wireEvents();
  await loadHistory();
  await reloadLibrary();
  await renderLibraryScreen();

  const pending = await takePendingQuery();
  if (pending) {
    lookUp(pending);
  } else if (library.isEmpty) {
    openLibraryScreen();
  } else {
    ui.query.focus();
  }
}

async function reloadLibrary() {
  await library.load();
  updatePlaceholder();
}

function updatePlaceholder(message) {
  const shown = !entry.results.length;
  ui.placeholder.hidden = !shown;
  if (!shown) return;
  const title = ui.placeholder.querySelector('h1');
  const text = ui.placeholder.querySelector('p');
  if (library.isEmpty) {
    title.textContent = 'No dictionary yet';
    text.innerHTML =
      'Add an <code>.mdx</code> file — and its <code>.mdd</code> companions, if it has any — to start looking words up.';
    ui.placeholderAdd.hidden = false;
  } else {
    const words = library.dictionaries.reduce((sum, d) => sum + d.mdx.size, 0);
    title.textContent = message || 'Ready';
    text.textContent = `${library.dictionaries.length} ${
      library.dictionaries.length === 1 ? 'dictionary' : 'dictionaries'
    }, ${words.toLocaleString()} head words. Type a word, or select text on a page and use “Look up in MDict”.`;
    ui.placeholderAdd.hidden = true;
  }
}

/* ---------------------------------------------------------------- search */

function onQueryInput() {
  const value = ui.query.value;
  ui.clear.hidden = !value;
  const text = value.trim();
  if (!text) {
    showHistory();
    return;
  }
  showSuggestions(library.suggest(text));
}

/** Draw the dropdown: either head-word matches or the recent words. */
function renderOptions(items, header) {
  options = items;
  optionRows = [];
  highlighted = items.length ? 0 : -1;
  ui.suggestions.innerHTML = '';
  if (header) ui.suggestions.append(header);

  for (const [i, item] of items.entries()) {
    const row = document.createElement('li');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === highlighted));
    const word = document.createElement('span');
    word.className = 'word';
    word.textContent = item.word;
    row.append(word);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'where';
      hint.textContent = item.hint;
      row.append(hint);
    }
    row.addEventListener('mousedown', (event) => {
      event.preventDefault(); // keep focus in the search box
      lookUp(item.word);
    });
    ui.suggestions.append(row);
    optionRows.push(row);
  }
  ui.suggestions.hidden = !items.length && !header;
}

function showSuggestions(list) {
  const many = library.dictionaries.length > 1;
  renderOptions(list.map((item) => ({ word: item.word, hint: many ? item.dicts.join(' · ') : '' })));
}

function showHistory() {
  if (!recent.length) {
    renderOptions([]);
    return;
  }
  const header = document.createElement('li');
  header.className = 'list-header';
  const label = document.createElement('span');
  label.textContent = 'Recent';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'link-button';
  clear.textContent = 'Clear';
  clear.addEventListener('mousedown', (event) => {
    event.preventDefault();
    clearHistory();
  });
  header.append(label, clear);
  renderOptions(
    recent.map((item) => ({ word: item.word, hint: timeAgo(item.at) })),
    header
  );
}

function moveHighlight(delta) {
  if (!options.length) return;
  highlighted = (highlighted + delta + options.length) % options.length;
  for (const [i, row] of optionRows.entries()) {
    row.setAttribute('aria-selected', String(i === highlighted));
    if (i === highlighted) row.scrollIntoView({ block: 'nearest' });
  }
}

function onQueryKeyDown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (ui.suggestions.hidden) onQueryInput();
    else moveHighlight(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveHighlight(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const chosen = highlighted >= 0 ? options[highlighted]?.word : null;
    lookUp(chosen || ui.query.value);
  } else if (event.key === 'Escape') {
    if (!ui.suggestions.hidden) ui.suggestions.hidden = true;
    else ui.query.value = '';
  }
}

/* --------------------------------------------------------------- history */

async function loadHistory() {
  if (!hasChromeApis || !chrome.storage?.local) return;
  const { history: stored } = await chrome.storage.local.get('history');
  if (Array.isArray(stored)) recent = stored;
}

function saveHistory() {
  if (hasChromeApis && chrome.storage?.local) {
    chrome.storage.local.set({ history: recent }).catch(() => {});
  }
}

function rememberWord(word) {
  const folded = word.toLowerCase();
  recent = [{ word, at: Date.now() }, ...recent.filter((item) => item.word.toLowerCase() !== folded)];
  recent.length = Math.min(recent.length, HISTORY_LIMIT);
  saveHistory();
}

function clearHistory() {
  recent = [];
  saveHistory();
  showHistory();
  toast('History cleared');
}

function timeAgo(at) {
  const minutes = Math.floor((Date.now() - (at || 0)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} d ago` : new Date(at).toLocaleDateString();
}

/* ---------------------------------------------------------------- lookup */

async function lookUp(word, { record = true } = {}) {
  const text = String(word || '').trim();
  if (!text) return;
  if (library.isEmpty) {
    openLibraryScreen();
    return;
  }
  let results;
  try {
    results = await library.lookup(text);
  } catch (error) {
    toast(`Could not read the dictionary: ${error?.message || error}`);
    return;
  }
  if (!results.length) {
    const near = library.suggest(text, 30);
    showSuggestions(near);
    toast(near.length ? `No exact match for “${text}”` : `“${text}” is not in your dictionaries`);
    return;
  }
  if (record && entry.word && entry.word !== text) backStack.push(entry.word);
  ui.back.hidden = backStack.length === 0;
  entry = { word: text, results, active: 0 };
  ui.query.value = text;
  ui.clear.hidden = false;
  ui.suggestions.hidden = true;
  renderTabs();
  await renderActiveEntry();
  rememberLastWord(text);
  rememberWord(entry.results[0].word || text);
}

function renderTabs() {
  ui.tabs.innerHTML = '';
  if (entry.results.length < 2) {
    ui.tabs.hidden = true;
    return;
  }
  for (const [i, result] of entry.results.entries()) {
    const tab = document.createElement('button');
    tab.className = 'tab';
    tab.type = 'button';
    tab.textContent = result.dictName;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(i === entry.active));
    tab.addEventListener('click', () => {
      entry.active = i;
      renderTabs();
      renderActiveEntry();
    });
    ui.tabs.append(tab);
  }
  ui.tabs.hidden = false;
}

async function renderActiveEntry() {
  const result = entry.results[entry.active];
  if (!result) return;
  const dictionary = library.byId(result.dictId);
  try {
    const html = await buildEntryDocument(result.html, (path) =>
      dictionary ? dictionary.resource(path) : Promise.resolve(null)
    );
    sendToViewer(html);
  } catch (error) {
    // Better a bare entry than none at all.
    sendToViewer(`<!doctype html><meta charset="utf-8"><body>${result.html}</body>`);
    toast(`Some parts of this entry could not be loaded: ${error?.message || error}`);
  }
  updatePlaceholder();
}

/**
 * Hand a document to the viewer. The frame may still be loading — and its
 * greeting can arrive before this page is listening — so the document is
 * resent until the viewer acknowledges it.
 */
function sendToViewer(html) {
  pendingDocument = { seq: ++renderSeq, html };
  deliverToViewer();
}

function deliverToViewer() {
  clearTimeout(deliverTimer);
  if (!pendingDocument) return;
  ui.viewer.contentWindow?.postMessage(
    { source: 'mdict-panel', type: 'render', seq: pendingDocument.seq, html: pendingDocument.html },
    '*'
  );
  deliverTimer = setTimeout(deliverToViewer, 200);
}

function goBack() {
  const previous = backStack.pop();
  ui.back.hidden = backStack.length === 0;
  if (previous) lookUp(previous, { record: false });
}

/* -------------------------------------------------------- entry messages */

async function onViewerMessage(event) {
  if (event.source !== ui.viewer.contentWindow) return;
  const message = event.data || {};
  if (message.source === 'mdict-viewer') {
    if (message.type === 'ready') deliverToViewer();
    if (message.type === 'rendered' && pendingDocument?.seq === message.seq) {
      pendingDocument = null;
      clearTimeout(deliverTimer);
    }
    return;
  }
  if (message.source !== 'mdict-entry') return;

  if (message.type === 'key') {
    if (message.key === '/' || message.key === 'Escape') ui.query.focus();
    return;
  }
  if (message.type !== 'navigate') return;

  const href = String(message.href || '');
  if (/^https?:/i.test(href)) {
    if (hasChromeApis) chrome.tabs.create({ url: href });
    return;
  }
  if (/^sound:\/\//i.test(href) || /\.(mp3|ogg|wav|m4a|spx)$/i.test(href)) {
    playSound(href);
    return;
  }
  if (/^entry:\/\//i.test(href)) {
    const target = safeDecode(href.replace(/^entry:\/\//i, '')).replace(/^#/, '');
    if (target) lookUp(target);
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return; // some other scheme; ignore
  lookUp(safeDecode(href.replace(/\.[a-z]+$/i, '')));
}

async function playSound(href) {
  const result = entry.results[entry.active];
  const dictionary = result ? library.byId(result.dictId) : null;
  if (!dictionary) return;
  const bytes = await dictionary.resource(href);
  if (!bytes) {
    toast('That sound file is not in the dictionary’s .mdd');
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes]));
  const audio = new Audio(url);
  audio.addEventListener('ended', () => URL.revokeObjectURL(url));
  audio.play().catch(() => URL.revokeObjectURL(url));
}

/* --------------------------------------------------------------- library */

function openLibraryScreen() {
  ui.library.hidden = false;
  renderLibraryScreen();
}

async function renderLibraryScreen() {
  const dicts = await listDictionaries();
  ui.dictList.innerHTML = '';
  for (const dict of dicts) {
    ui.dictList.append(dictionaryRow(dict));
  }
  if (!dicts.length) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = 'Nothing added yet.';
    ui.dictList.append(li);
  }
  const { used, quota } = await usage();
  ui.storageNote.textContent = quota
    ? `Using ${formatSize(used)} of the ${formatSize(quota)} this browser profile allows. Dictionaries stay on this computer.`
    : 'Dictionaries stay on this computer.';
}

function dictionaryRow(dict) {
  const li = document.createElement('li');
  li.className = `dict${dict.enabled ? '' : ' disabled'}`;

  const main = document.createElement('div');
  main.className = 'dict-main';
  const name = document.createElement('div');
  name.className = 'dict-name';
  name.textContent = dict.name;
  main.append(name);

  const title = plainText(dict.title);
  if (title && title.toLowerCase() !== dict.name.toLowerCase()) {
    const subtitle = document.createElement('div');
    subtitle.className = 'dict-meta dict-title';
    subtitle.textContent = title;
    main.append(subtitle);
  }

  const meta = document.createElement('div');
  meta.className = 'dict-meta';
  const size = dict.files.reduce((sum, file) => sum + file.size, 0);
  meta.textContent = `${dict.entryCount.toLocaleString()} entries · ${formatSize(size)}`;
  main.append(meta);

  // Every file of the dictionary is listed, so it is obvious whether the
  // .mdd made it in alongside the .mdx.
  const files = document.createElement('ul');
  files.className = 'dict-files';
  for (const file of dict.files) {
    const row = document.createElement('li');
    row.className = `dict-file ${file.status}`;
    const mark = document.createElement('span');
    mark.className = 'dict-file-mark';
    mark.textContent = { ready: '✓', error: '✕' }[file.status] || '…';
    const label = document.createElement('span');
    label.className = 'dict-file-name';
    label.textContent = file.fileName;
    const size = document.createElement('span');
    size.className = 'dict-file-size';
    size.textContent = formatSize(file.size);
    row.append(mark, label, size);
    if (file.status === 'error') {
      const why = document.createElement('div');
      why.className = 'dict-file-error';
      why.textContent = file.error || 'could not be read';
      row.append(why);
    }
    files.append(row);
  }
  main.append(files);

  const actions = document.createElement('div');
  actions.className = 'dict-actions';
  const toggle = document.createElement('label');
  toggle.className = 'switch';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = dict.enabled;
  checkbox.addEventListener('change', async () => {
    await setEnabled(dict.id, checkbox.checked);
    await reloadLibrary();
    await renderLibraryScreen();
  });
  toggle.append(checkbox, document.createTextNode('On'));

  const remove = document.createElement('button');
  remove.className = 'link-button';
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', async () => {
    if (!confirm(`Remove “${dict.name}” and its files from this browser?`)) return;
    await deleteDictionary(dict.id);
    if (entry.results.some((r) => r.dictId === dict.id)) {
      entry = { word: '', results: [], active: 0 };
      renderTabs();
    }
    await reloadLibrary();
    await renderLibraryScreen();
    toast(`Removed ${dict.name}`);
  });

  actions.append(toggle, remove);
  li.append(main, actions);
  return li;
}

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => /\.(mdx|mdd)$/i.test(f.name));
  if (!files.length) {
    toast('Pick .mdx or .mdd files');
    return;
  }
  const { groups, orphans } = groupFiles(files);
  for (const orphan of orphans) {
    toast(`${orphan.name}: an .mdd needs its .mdx file too`);
  }

  ui.imports.hidden = groups.length === 0;
  for (const group of groups) {
    const row = importRow(group.name);
    ui.imports.append(row.li);
    try {
      await importDictionary(group, (update) => row.update(update));
      row.done();
      await reloadLibrary();
      await renderLibraryScreen();
    } catch (error) {
      row.fail(error?.message || String(error));
    }
  }
  ui.files.value = '';
}

function importRow(name) {
  const li = document.createElement('li');
  const label = document.createElement('div');
  label.textContent = `${name} — reading…`;
  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('span');
  fill.style.width = '0%';
  bar.append(fill);
  li.append(label, bar);

  const phases = { storing: 'copying', keys: 'indexing head words', records: 'reading records', done: 'done' };
  return {
    li,
    update({ phase, ratio, detail }) {
      label.textContent = `${name} — ${phases[phase] || phase}${detail ? ` (${detail})` : ''}`;
      fill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio || 0)) * 100)}%`;
    },
    done() {
      label.textContent = `${name} — added`;
      fill.style.width = '100%';
      setTimeout(() => {
        li.remove();
        ui.imports.hidden = ui.imports.children.length === 0;
      }, 1500);
    },
    fail(message) {
      label.className = 'error';
      label.textContent = `${name} — ${message}`;
      bar.remove();
    },
  };
}

/* ----------------------------------------------------------------- misc */

/** A dictionary's own title, with any markup taken out. */
function plainText(value, limit = 80) {
  const text = String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function toast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 2600);
}

async function takePendingQuery() {
  if (!hasChromeApis || !chrome.storage?.session) return '';
  const { pendingQuery, lastWord } = await chrome.storage.session.get(['pendingQuery', 'lastWord']);
  if (pendingQuery?.text) {
    await chrome.storage.session.remove('pendingQuery');
    return pendingQuery.text;
  }
  return lastWord || '';
}

function rememberLastWord(word) {
  if (hasChromeApis && chrome.storage?.session) {
    chrome.storage.session.set({ lastWord: word }).catch(() => {});
  }
}

function wireEvents() {
  ui.query.addEventListener('input', onQueryInput);
  ui.query.addEventListener('keydown', onQueryKeyDown);
  ui.query.addEventListener('focus', onQueryInput);
  ui.clear.addEventListener('click', () => {
    ui.query.value = '';
    ui.clear.hidden = true;
    ui.query.focus();
    showHistory();
  });
  ui.showHistory.addEventListener('click', () => {
    ui.query.value = '';
    ui.clear.hidden = true;
    ui.query.focus();
    showHistory();
    if (!recent.length) toast('No lookups yet');
  });
  ui.back.addEventListener('click', goBack);
  ui.openLibrary.addEventListener('click', openLibraryScreen);
  ui.closeLibrary.addEventListener('click', () => {
    ui.library.hidden = true;
    if (!library.isEmpty) ui.query.focus();
  });
  ui.placeholderAdd.addEventListener('click', openLibraryScreen);
  ui.files.addEventListener('change', (event) => importFiles(event.target.files));

  ui.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    ui.dropzone.classList.add('hover');
  });
  ui.dropzone.addEventListener('dragleave', () => ui.dropzone.classList.remove('hover'));
  ui.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    ui.dropzone.classList.remove('hover');
    if (event.dataTransfer?.files?.length) importFiles(event.dataTransfer.files);
  });

  document.addEventListener('click', (event) => {
    // A click anywhere else closes the dropdown — except on the controls
    // whose whole job is to open it.
    const keepsOpen = event.target.closest?.('#suggestions, #query, #show-history, #clear');
    if (!keepsOpen) ui.suggestions.hidden = true;
  });

  window.addEventListener('message', onViewerMessage);

  if (hasChromeApis) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'lookup' && message.text) lookUp(message.text);
    });
    // The panel can finish loading either before or after the word that
    // opened it is parked in session storage, so watch for both.
    chrome.storage.session.onChanged?.addListener((changes) => {
      const text = changes.pendingQuery?.newValue?.text;
      if (!text) return;
      chrome.storage.session.remove('pendingQuery');
      lookUp(text);
    });
  }
}

start();
