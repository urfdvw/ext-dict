/**
 * The dictionary library: importing files, keeping their metadata, and
 * answering lookups across every enabled dictionary.
 */

import { INDEX_FORMAT, MDict } from './mdict.js';
import {
  STORE_DICTS,
  STORE_FILES,
  STORE_INDEXES,
  get,
  getAll,
  put,
  remove,
  requestPersistence,
} from './storage.js';

const MAX_LINK_HOPS = 5;

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function baseName(fileName) {
  const withoutExtension = fileName.replace(/\.(mdx|mdd)$/i, '');
  // Extra resource archives are named Dict.1.mdd, Dict.2.mdd, …
  return /\.mdd$/i.test(fileName) ? withoutExtension.replace(/\.\d+$/, '') : withoutExtension;
}

/** Group a user's file selection into one dictionary per .mdx file. */
export function groupFiles(files) {
  const groups = new Map();
  for (const file of files) {
    const key = baseName(file.name).toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: baseName(file.name), mdx: null, mdd: [] });
    const group = groups.get(key);
    if (/\.mdx$/i.test(file.name)) group.mdx = file;
    else if (/\.mdd$/i.test(file.name)) group.mdd.push(file);
  }
  const ready = [];
  const orphans = [];
  for (const group of groups.values()) {
    group.mdd.sort((a, b) => a.name.localeCompare(b.name));
    if (group.mdx) ready.push(group);
    else orphans.push(group);
  }
  return { groups: ready, orphans };
}

export async function listDictionaries() {
  const dicts = await getAll(STORE_DICTS);
  return dicts.sort((a, b) => a.createdAt - b.createdAt);
}

export async function setEnabled(id, enabled) {
  const dict = await get(STORE_DICTS, id);
  if (!dict) return;
  dict.enabled = enabled;
  await put(STORE_DICTS, dict);
}

export async function deleteDictionary(id) {
  const dict = await get(STORE_DICTS, id);
  if (!dict) return;
  for (const file of dict.files) {
    await remove(STORE_FILES, file.id);
    await remove(STORE_INDEXES, file.id);
  }
  await remove(STORE_DICTS, id);
}

/**
 * Store a group of files as one dictionary and index them in a worker.
 *
 * @param {{name: string, mdx: File, mdd: File[]}} group
 * @param {(update: object) => void} onProgress
 */
export async function importDictionary(group, onProgress = () => {}) {
  await requestPersistence();
  const id = newId();
  const files = [];
  const all = [
    { file: group.mdx, kind: 'mdx' },
    ...group.mdd.map((file) => ({ file, kind: 'mdd' })),
  ];
  for (let i = 0; i < all.length; i++) {
    const { file, kind } = all[i];
    const fileId = `${id}:${kind}:${i}`;
    onProgress({ id, name: group.name, phase: 'storing', detail: file.name, ratio: 0 });
    await put(STORE_FILES, { id: fileId, blob: file });
    files.push({ id: fileId, kind, fileName: file.name, size: file.size, status: 'pending' });
  }

  const record = {
    id,
    name: group.name,
    createdAt: Date.now(),
    enabled: true,
    entryCount: 0,
    title: '',
    description: '',
    files,
  };
  await put(STORE_DICTS, record);

  const worker = new Worker(new URL('../worker/indexer.js', import.meta.url), { type: 'module' });
  try {
    for (const file of files) {
      onProgress({ id, name: group.name, phase: 'indexing', detail: file.fileName, ratio: 0 });
      const summary = await runIndexJob(worker, file, (ratio, phase) =>
        onProgress({ id, name: group.name, phase, detail: file.fileName, ratio })
      );
      file.status = summary.error ? 'error' : 'ready';
      file.error = summary.error || undefined;
      if (file.kind === 'mdx' && !summary.error) {
        record.entryCount = summary.entryCount;
        record.title = summary.title;
        record.description = summary.description;
        record.version = summary.version;
        record.encoding = summary.encoding;
      }
      await put(STORE_DICTS, record);
    }
  } finally {
    worker.terminate();
  }

  const mdx = record.files.find((f) => f.kind === 'mdx');
  if (mdx.status === 'error') {
    await deleteDictionary(id);
    throw new Error(mdx.error);
  }
  onProgress({ id, name: group.name, phase: 'done', ratio: 1 });
  return record;
}

function runIndexJob(worker, file, onRatio) {
  return new Promise((resolve) => {
    const onMessage = (event) => {
      const message = event.data;
      if (message.fileId !== file.id) return;
      if (message.type === 'progress') {
        onRatio(message.ratio, message.phase);
        return;
      }
      worker.removeEventListener('message', onMessage);
      resolve(message.type === 'done' ? message.summary : { error: message.message });
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'index', fileId: file.id, isMdd: file.kind === 'mdd' });
  });
}

/** One opened dictionary: the .mdx reader plus its resource archives. */
class OpenDictionary {
  constructor(record, mdx, resources) {
    this.record = record;
    this.id = record.id;
    this.name = record.name;
    this.mdx = mdx;
    this.resources = resources;
  }

  suggest(prefix, limit) {
    return this.mdx.prefixSearch(prefix, limit).map((i) => this.mdx.keyAt(i));
  }

  /** Entry text for `word`, following @@@LINK= redirects. */
  async entry(word) {
    let target = word;
    for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
      const hits = this.mdx.findAll(target);
      if (!hits.length) return null;
      const parts = [];
      for (const hit of hits) parts.push(await this.mdx.textAt(hit));
      const link = /^@@@LINK=([\s\S]*?)\s*$/.exec(parts[0].trim());
      if (link && parts.length === 1) {
        target = link[1].trim();
        continue;
      }
      return { word: this.mdx.keyAt(hits[0]), html: parts.join('\n<hr class="mdict-homograph-rule">\n') };
    }
    return null;
  }

  /** Look a file up in the .mdd archives. Returns bytes or null. */
  async resource(path) {
    const candidates = resourceKeys(path);
    for (const archive of this.resources) {
      for (const candidate of candidates) {
        const hits = archive.findAll(candidate);
        if (hits.length) return archive.recordAt(hits[0]);
      }
    }
    return null;
  }
}

function resourceKeys(path) {
  const cleaned = String(path)
    .replace(/^(sound|entry|file):\/\//i, '')
    .split(/[?#]/)[0]
    .replace(/\//g, '\\')
    .replace(/^\\+/, '');
  const names = new Set([`\\${cleaned}`]);
  try {
    names.add(`\\${decodeURIComponent(cleaned)}`);
  } catch {
    /* not percent-encoded */
  }
  // Some dictionaries reference "sub/dir/pic.png" but store only "pic.png".
  for (const name of [...names]) {
    const tail = name.split('\\').pop();
    if (tail) names.add(`\\${tail}`);
  }
  return [...names];
}

/** All enabled dictionaries, ready for lookups. */
export class Library {
  constructor() {
    this.dictionaries = [];
  }

  async load() {
    const records = await listDictionaries();
    const opened = [];
    for (const record of records) {
      if (!record.enabled) continue;
      const mdxFile = record.files.find((f) => f.kind === 'mdx' && f.status === 'ready');
      if (!mdxFile) continue;
      const mdx = await openReader(mdxFile.id);
      if (!mdx) continue;
      const resources = [];
      for (const file of record.files) {
        if (file.kind !== 'mdd' || file.status !== 'ready') continue;
        const reader = await openReader(file.id);
        if (reader) resources.push(reader);
      }
      opened.push(new OpenDictionary(record, mdx, resources));
    }
    this.dictionaries = opened;
    return this;
  }

  get isEmpty() {
    return this.dictionaries.length === 0;
  }

  byId(id) {
    return this.dictionaries.find((d) => d.id === id) || null;
  }

  /** Merged head-word suggestions across dictionaries, best prefix first. */
  suggest(query, limit = 60) {
    const seen = new Map();
    const perDict = Math.max(10, Math.ceil(limit / Math.max(1, this.dictionaries.length)) * 2);
    for (const dict of this.dictionaries) {
      for (const word of dict.suggest(query, perDict)) {
        const key = word.toLowerCase();
        if (!seen.has(key)) seen.set(key, { word, dicts: [] });
        const entry = seen.get(key);
        if (!entry.dicts.includes(dict.name)) entry.dicts.push(dict.name);
      }
    }
    const folded = query.trim().toLowerCase();
    // Alphabetical, the way a dictionary reads, but with an exact hit on top.
    return [...seen.values()]
      .sort((a, b) => {
        const exact =
          (a.word.toLowerCase() === folded ? 0 : 1) - (b.word.toLowerCase() === folded ? 0 : 1);
        if (exact) return exact;
        return a.word.toLowerCase().localeCompare(b.word.toLowerCase()) || a.word.localeCompare(b.word);
      })
      .slice(0, limit);
  }

  /** Every dictionary that defines `word`, in library order. */
  async lookup(word) {
    const results = [];
    for (const dict of this.dictionaries) {
      const entry = await dict.entry(word);
      if (entry) results.push({ dictId: dict.id, dictName: dict.name, ...entry });
    }
    return results;
  }
}

async function openReader(fileId) {
  const [file, index] = await Promise.all([get(STORE_FILES, fileId), get(STORE_INDEXES, fileId)]);
  if (!file || !index) return null;
  if (index.index?.format !== INDEX_FORMAT) {
    console.warn(`Index for ${fileId} was built by an older version; add the file again.`);
    return null;
  }
  return new MDict(file.blob, index.index);
}
