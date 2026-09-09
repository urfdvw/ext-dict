/**
 * Reader for MDict dictionary files (.mdx dictionaries and .mdd resource
 * archives), format versions 1.2 and 2.0.
 *
 * Parsing is split in two halves so that a whole dictionary never has to be
 * held in memory:
 *
 *   buildIndex(blob)  walks the header, the key blocks and the record block
 *                     table once and returns a small, structured-cloneable
 *                     index (head words + where their record lives).
 *   new MDict(blob, index)  answers lookups by inflating the single record
 *                     block a head word points into.
 *
 * Dictionaries that scramble their key index (header attribute Encrypted=2)
 * are unscrambled on the fly. Dictionaries whose records are encrypted with a
 * registration key (Encrypted=1) are rejected.
 */

import { lzoDecompress } from './lzo1x.js';
import { ripemd128 } from './ripemd128.js';

export class MDictError extends Error {}

/** Bumped whenever the shape of a stored index changes. */
export const INDEX_FORMAT = 1;

const textDecoders = new Map();
function decodeWith(encoding, bytes) {
  let dec = textDecoders.get(encoding);
  if (!dec) {
    dec = new TextDecoder(encoding, { fatal: false });
    textDecoders.set(encoding, dec);
  }
  return dec.decode(bytes);
}

function normalizeEncoding(name) {
  const key = String(name || '').toUpperCase().replace(/[-_\s]/g, '');
  if (key === 'UTF16' || key === 'UTF16LE') return 'utf-16le';
  if (key === 'GBK' || key === 'GB2312' || key === 'GB18030') return 'gb18030';
  if (key === 'BIG5' || key === 'BIG5HKSCS') return 'big5';
  if (key === '' || key === 'UTF8') return 'utf-8';
  return 'utf-8';
}

/** Sequential reader over a Blob (or File). */
class BlobCursor {
  constructor(blob) {
    this.blob = blob;
    this.pos = 0;
  }
  async read(length) {
    if (this.pos + length > this.blob.size) {
      throw new MDictError('Unexpected end of file — the dictionary looks truncated.');
    }
    const buf = await this.blob.slice(this.pos, this.pos + length).arrayBuffer();
    this.pos += length;
    return new Uint8Array(buf);
  }
  skip(length) {
    this.pos += length;
  }
}

/** Big-endian unsigned integer reader for the 4- or 8-byte "number" fields. */
class NumberReader {
  constructor(bytes, width) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.width = width;
    this.pos = 0;
  }
  next() {
    const value = readNumber(this.view, this.pos, this.width);
    this.pos += this.width;
    return value;
  }
}

function readNumber(view, offset, width) {
  if (width === 4) return view.getUint32(offset, false);
  const hi = view.getUint32(offset, false);
  const lo = view.getUint32(offset + 4, false);
  const value = hi * 4294967296 + lo;
  if (!Number.isSafeInteger(value)) {
    throw new MDictError('Dictionary contains an offset too large to handle.');
  }
  return value;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decompress one key/record block. Blocks start with a 4-byte compression
 * type followed by a 4-byte adler32 of the payload.
 */
async function decompressBlock(block, decompressedSize) {
  const type = block[0] | (block[1] << 8) | (block[2] << 16) | (block[3] << 24);
  const payload = block.subarray(8);
  switch (type) {
    case 0:
      return payload;
    case 1:
      return lzoDecompress(payload, decompressedSize);
    case 2:
      return inflate(payload);
    default:
      throw new MDictError(`Unsupported block compression type ${type}.`);
  }
}

/**
 * Undo the key-index scrambling used by dictionaries with Encrypted=2. The
 * key is derived from the block's own checksum, so no password is involved.
 */
function decryptKeyIndex(block) {
  const seed = new Uint8Array(8);
  seed.set(block.subarray(4, 8));
  seed.set([0x95, 0x36, 0x00, 0x00], 4);
  const key = ripemd128(seed);

  const out = new Uint8Array(block.length);
  out.set(block.subarray(0, 8));
  let previous = 0x36;
  for (let i = 8; i < block.length; i++) {
    const byte = block[i];
    const swapped = ((byte >> 4) | (byte << 4)) & 0xff;
    out[i] = swapped ^ previous ^ ((i - 8) & 0xff) ^ key[(i - 8) % key.length];
    previous = byte;
  }
  return out;
}

function parseHeaderText(text) {
  const attrs = {};
  const re = /([A-Za-z0-9_]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    attrs[m[1]] = m[2]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }
  return attrs;
}

function encryptionFlags(attrs) {
  const raw = String(attrs.Encrypted ?? '').trim();
  if (raw === '' || /^no$/i.test(raw)) return 0;
  if (/^yes$/i.test(raw)) return 1;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Read and validate the file header. Returns header attributes and layout. */
export async function readHeader(blob) {
  const cursor = new BlobCursor(blob);
  const lengthBytes = await cursor.read(4);
  const headerLength = new DataView(lengthBytes.buffer).getUint32(0, false);
  if (headerLength === 0 || headerLength + 8 > blob.size) {
    throw new MDictError('This does not look like an MDict file.');
  }
  const headerBytes = await cursor.read(headerLength);
  cursor.skip(4); // adler32 of the header text
  // The header is UTF-16LE and ends with a NUL character.
  const text = decodeWith('utf-16le', headerBytes.subarray(0, headerLength - 2));
  const attrs = parseHeaderText(text);
  if (!attrs.GeneratedByEngineVersion && !attrs.Title && !attrs.Encoding) {
    throw new MDictError('This does not look like an MDict file.');
  }
  const version = parseFloat(attrs.GeneratedByEngineVersion || '2.0');
  if (!(version >= 1) || version >= 3) {
    throw new MDictError(
      `MDict engine version ${attrs.GeneratedByEngineVersion} is not supported (only 1.x and 2.x).`
    );
  }
  const encrypted = encryptionFlags(attrs);
  return {
    attrs,
    version,
    encrypted,
    numberWidth: version >= 2 ? 8 : 4,
    keySectionOffset: 4 + headerLength + 4,
  };
}

function decodeKeyBlockInfo(info, { version, numberWidth, encoding }) {
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const sizeWidth = version >= 2 ? 2 : 1;
  const textTerm = version >= 2 ? 1 : 0;
  const charWidth = encoding === 'utf-16le' ? 2 : 1;
  const blocks = [];
  let i = 0;
  while (i < info.length) {
    i += numberWidth; // entries in this block, recomputed while splitting
    for (const _ of [0, 1]) { // first and last head word of the block
      const chars = sizeWidth === 2 ? view.getUint16(i, false) : view.getUint8(i);
      i += sizeWidth + (chars + textTerm) * charWidth;
    }
    const compressedSize = readNumber(view, i, numberWidth);
    i += numberWidth;
    const decompressedSize = readNumber(view, i, numberWidth);
    i += numberWidth;
    blocks.push({ compressedSize, decompressedSize });
  }
  return blocks;
}

function splitKeyBlock(block, { numberWidth, encoding }, keys, offsets) {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const charWidth = encoding === 'utf-16le' ? 2 : 1;
  let i = 0;
  while (i + numberWidth < block.length) {
    const recordOffset = readNumber(view, i, numberWidth);
    i += numberWidth;
    const start = i;
    let end = block.length;
    for (let j = start; j + charWidth <= block.length; j += charWidth) {
      if (block[j] === 0 && (charWidth === 1 || block[j + 1] === 0)) {
        end = j;
        break;
      }
    }
    keys.push(decodeWith(encoding, block.subarray(start, end)).trim());
    offsets.push(recordOffset);
    i = end + charWidth;
  }
}

/**
 * Parse a dictionary and return its index.
 *
 * The returned object is plain data (strings and typed arrays) so it can be
 * posted from a worker and stored in IndexedDB as-is.
 *
 * @param {Blob} blob the .mdx or .mdd file
 * @param {{isMdd?: boolean, onProgress?: (p: {phase: string, ratio: number}) => void}} options
 */
export async function buildIndex(blob, { isMdd = false, onProgress = () => {} } = {}) {
  const header = await readHeader(blob);
  if (header.encrypted & 1) {
    throw new MDictError(
      'This dictionary is encrypted with a registration key and cannot be read.'
    );
  }
  const { version, numberWidth } = header;
  const encoding = isMdd ? 'utf-16le' : normalizeEncoding(header.attrs.Encoding);
  const layout = { version, numberWidth, encoding };

  const cursor = new BlobCursor(blob);
  cursor.pos = header.keySectionOffset;

  // --- key section header -------------------------------------------------
  const fieldCount = version >= 2 ? 5 : 4;
  const numbers = new NumberReader(await cursor.read(fieldCount * numberWidth), numberWidth);
  const numKeyBlocks = numbers.next();
  numbers.next(); // total number of entries
  const keyBlockInfoDecompressedSize = version >= 2 ? numbers.next() : 0;
  const keyBlockInfoSize = numbers.next();
  const keyBlocksSize = numbers.next();
  if (version >= 2) cursor.skip(4); // adler32 of the block above

  // --- key block info -----------------------------------------------------
  let keyBlockInfo = await cursor.read(keyBlockInfoSize);
  if (version >= 2) {
    if (header.encrypted & 2) keyBlockInfo = decryptKeyIndex(keyBlockInfo);
    keyBlockInfo = await decompressBlock(keyBlockInfo, keyBlockInfoDecompressedSize);
  }
  const keyBlockSizes = decodeKeyBlockInfo(keyBlockInfo, layout);
  if (keyBlockSizes.length !== numKeyBlocks) {
    throw new MDictError('Key index is inconsistent; the file may be damaged.');
  }

  // --- key blocks ---------------------------------------------------------
  const keys = [];
  const offsetList = [];
  let blockPos = 0;
  const keyBlocksBytes = await cursor.read(keyBlocksSize);
  for (let b = 0; b < keyBlockSizes.length; b++) {
    const { compressedSize, decompressedSize } = keyBlockSizes[b];
    const raw = keyBlocksBytes.subarray(blockPos, blockPos + compressedSize);
    blockPos += compressedSize;
    splitKeyBlock(await decompressBlock(raw, decompressedSize), layout, keys, offsetList);
    if ((b & 15) === 0) onProgress({ phase: 'keys', ratio: b / keyBlockSizes.length });
  }

  // --- record block table -------------------------------------------------
  const recordHeader = new NumberReader(await cursor.read(4 * numberWidth), numberWidth);
  const numRecordBlocks = recordHeader.next();
  recordHeader.next(); // number of entries
  recordHeader.next(); // size of the record block info table
  recordHeader.next(); // total size of all record blocks
  const infoBytes = await cursor.read(numRecordBlocks * 2 * numberWidth);
  const infoView = new DataView(infoBytes.buffer, infoBytes.byteOffset, infoBytes.byteLength);

  const blockFileOffset = new Float64Array(numRecordBlocks);
  const blockCompressedSize = new Float64Array(numRecordBlocks);
  const blockDataOffset = new Float64Array(numRecordBlocks);
  const blockDataSize = new Float64Array(numRecordBlocks);
  let fileOffset = cursor.pos; // record blocks follow the info table
  let dataOffset = 0;
  for (let b = 0; b < numRecordBlocks; b++) {
    const compressedSize = readNumber(infoView, b * 2 * numberWidth, numberWidth);
    const decompressedSize = readNumber(infoView, (b * 2 + 1) * numberWidth, numberWidth);
    blockFileOffset[b] = fileOffset;
    blockCompressedSize[b] = compressedSize;
    blockDataOffset[b] = dataOffset;
    blockDataSize[b] = decompressedSize;
    fileOffset += compressedSize;
    dataOffset += decompressedSize;
  }
  onProgress({ phase: 'records', ratio: 1 });

  // --- entry extents ------------------------------------------------------
  // A record ends where the next one starts; head words are stored in record
  // order, but sort defensively so that ends are correct either way.
  const total = keys.length;
  const order = new Uint32Array(total);
  for (let i = 0; i < total; i++) order[i] = i;
  const startsSorted = Float64Array.from(offsetList).sort();
  const lengths = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    const start = offsetList[i];
    let lo = 0;
    let hi = total;
    while (lo < hi) { // first offset strictly greater than this one
      const mid = (lo + hi) >> 1;
      if (startsSorted[mid] > start) hi = mid;
      else lo = mid + 1;
    }
    lengths[i] = (lo < total ? startsSorted[lo] : dataOffset) - start;
  }

  // --- sort by head word for lookup --------------------------------------
  // Only the sorted head words are kept; their folded form is cheap enough to
  // recompute during the handful of comparisons a binary search makes, and
  // keeping a second copy of every head word around is not.
  const folded = keys.map((k) => k.toLowerCase());
  const sorted = Array.from(order).sort((a, b) => {
    if (folded[a] < folded[b]) return -1;
    if (folded[a] > folded[b]) return 1;
    return a - b;
  });
  const sortedKeys = new Array(total);
  const recordOffset = new Float64Array(total);
  const recordLength = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    const src = sorted[i];
    sortedKeys[i] = keys[src];
    recordOffset[i] = offsetList[src];
    recordLength[i] = lengths[src];
  }
  onProgress({ phase: 'done', ratio: 1 });

  return {
    format: INDEX_FORMAT,
    isMdd,
    version,
    numberWidth,
    encoding,
    attrs: header.attrs,
    title: header.attrs.Title || '',
    description: header.attrs.Description || '',
    keys: sortedKeys,
    recordOffset,
    recordLength,
    blockFileOffset,
    blockCompressedSize,
    blockDataOffset,
    blockDataSize,
  };
}

/** Random-access reader built on top of an index produced by buildIndex(). */
export class MDict {
  /**
   * @param {Blob} blob the file the index was built from
   * @param {object} index result of buildIndex()
   * @param {{cacheBlocks?: number}} [options]
   */
  constructor(blob, index, { cacheBlocks = 8 } = {}) {
    this.blob = blob;
    this.index = index;
    this.cacheLimit = cacheBlocks;
    this.cache = new Map();
  }

  get size() {
    return this.index.keys.length;
  }

  keyAt(i) {
    return this.index.keys[i];
  }

  foldedAt(i) {
    return this.index.keys[i].toLowerCase();
  }

  /** Index of the first head word whose folded form is >= `folded`. */
  lowerBound(folded) {
    let lo = 0;
    let hi = this.size;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.foldedAt(mid) < folded) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** All entry indices whose head word matches `word`, ignoring case. */
  findAll(word) {
    const folded = String(word).trim().toLowerCase();
    const out = [];
    for (let i = this.lowerBound(folded); i < this.size; i++) {
      if (this.foldedAt(i) !== folded) break;
      out.push(i);
    }
    return out;
  }

  /** Head words starting with `prefix`, ignoring case. */
  prefixSearch(prefix, limit = 50) {
    const folded = String(prefix).trim().toLowerCase();
    const out = [];
    if (!folded) return out;
    for (let i = this.lowerBound(folded); i < this.size && out.length < limit; i++) {
      if (!this.foldedAt(i).startsWith(folded)) break;
      out.push(i);
    }
    return out;
  }

  async blockAt(b) {
    const cached = this.cache.get(b);
    if (cached) {
      this.cache.delete(b);
      this.cache.set(b, cached); // refresh LRU position
      return cached;
    }
    const start = this.index.blockFileOffset[b];
    const raw = new Uint8Array(
      await this.blob.slice(start, start + this.index.blockCompressedSize[b]).arrayBuffer()
    );
    const data = await decompressBlock(raw, this.index.blockDataSize[b]);
    this.cache.set(b, data);
    if (this.cache.size > this.cacheLimit) {
      this.cache.delete(this.cache.keys().next().value);
    }
    return data;
  }

  blockFor(dataOffset) {
    const offsets = this.index.blockDataOffset;
    if (!offsets.length) throw new MDictError('This dictionary has no records.');
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= dataOffset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Raw bytes of entry `i`. */
  async recordAt(i) {
    if (i < 0 || i >= this.size) throw new MDictError('No such entry.');
    const offset = this.index.recordOffset[i];
    const b = this.blockFor(offset);
    const block = await this.blockAt(b);
    const start = offset - this.index.blockDataOffset[b];
    const end = Math.min(start + this.index.recordLength[i], block.length);
    return block.subarray(start, end);
  }

  /** Entry `i` decoded as text, with the trailing NUL some dictionaries add. */
  async textAt(i) {
    const bytes = await this.recordAt(i);
    let text = decodeWith(this.index.encoding, bytes);
    if (text.charCodeAt(text.length - 1) === 0) text = text.slice(0, -1);
    return text;
  }
}
