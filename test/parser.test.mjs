/**
 * Parser tests.
 *
 * The fixtures in test/fixtures are written by tools/make_test_dict.py and
 * expected.json holds what an independent MDict reader (mdict-utils) reads
 * back from them, so these tests check the parser against a second opinion
 * rather than against itself.
 *
 * Run with:  node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildIndex, MDict, MDictError } from '../src/lib/mdict.js';
import { lzoDecompress } from '../src/lib/lzo1x.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const expected = JSON.parse(await readFile(join(fixtures, 'expected.json'), 'utf8'));

async function open(name) {
  const bytes = await readFile(join(fixtures, name));
  const blob = new Blob([bytes]);
  const index = await buildIndex(blob, { isMdd: name.endsWith('.mdd') });
  return { blob, index, dict: new MDict(blob, index) };
}

const files = (await readdir(fixtures)).filter((f) => /\.(mdx|mdd)$/.test(f)).sort();
assert.ok(files.length >= 12, 'fixtures are present');
assert.ok(files.includes('v2-scrambled.mdx'), 'the Encrypted="2" fixture is present');

for (const name of files) {
  const isMdd = name.endsWith('.mdd');

  test(`${name}: every entry matches the reference reader`, async () => {
    const { dict } = await open(name);
    const want = new Map(expected[name]);
    assert.equal(dict.size, want.size, 'entry count');

    for (let i = 0; i < dict.size; i++) {
      const key = dict.keyAt(i);
      assert.ok(want.has(key), `unexpected head word ${JSON.stringify(key)}`);
      if (isMdd) {
        const bytes = await dict.recordAt(i);
        assert.equal(Buffer.from(bytes).toString('hex'), want.get(key), `bytes of ${key}`);
      } else {
        assert.equal(await dict.textAt(i), want.get(key), `text of ${key}`);
      }
    }
  });
}

test('head words are sorted case-insensitively', async () => {
  const { dict } = await open('v2-zlib.mdx');
  for (let i = 1; i < dict.size; i++) {
    assert.ok(dict.foldedAt(i - 1) <= dict.foldedAt(i), `${dict.keyAt(i - 1)} <= ${dict.keyAt(i)}`);
  }
});

test('lookup is case-insensitive and finds every homograph', async () => {
  const { dict } = await open('v2-zlib.mdx');
  const hits = dict.findAll('APPLE');
  assert.equal(hits.length, 2, 'apple and Apple');
  assert.deepEqual(new Set(hits.map((i) => dict.keyAt(i))), new Set(['apple', 'Apple']));
  assert.equal(dict.findAll('  apple  ').length, 2, 'query is trimmed');
  assert.equal(dict.findAll('pear').length, 0);
});

test('prefix search returns matches in order and honours the limit', async () => {
  const { dict } = await open('v2-zlib.mdx');
  const words = dict.prefixSearch('ap').map((i) => dict.keyAt(i));
  assert.deepEqual(words, ['Apple', 'apple', 'apple tree', 'apricot']);
  assert.equal(dict.prefixSearch('ap', 2).length, 2);
  assert.deepEqual(dict.prefixSearch('zzz'), []);
  assert.deepEqual(dict.prefixSearch(''), []);
});

test('non-ASCII head words survive every encoding', async () => {
  for (const name of ['v2-zlib.mdx', 'v2-utf16.mdx', 'v2-gbk.mdx', 'v1-zlib.mdx']) {
    const { dict } = await open(name);
    const hits = dict.findAll('汉字');
    assert.equal(hits.length, 1, name);
    assert.match(await dict.textAt(hits[0]), /Chinese characters/, name);
  }
});

test('resource archives key their files with a leading backslash', async () => {
  const { dict } = await open('v2-zlib.mdd');
  assert.deepEqual(dict.index.keys, ['\\bg.png', '\\pic.png', '\\test.css']);
  const css = await dict.recordAt(dict.findAll('\\test.css')[0]);
  assert.match(Buffer.from(css).toString('utf8'), /color: teal/);
});

test('the record block cache keeps its size bounded', async () => {
  const bytes = await readFile(join(fixtures, 'v2-zlib.mdx'));
  const blob = new Blob([bytes]);
  const dict = new MDict(blob, await buildIndex(blob), { cacheBlocks: 1 });
  for (let i = 0; i < dict.size; i++) await dict.recordAt(i);
  assert.equal(dict.cache.size, 1);
});

test('a scrambled key index (Encrypted="2") is unscrambled', async () => {
  const { dict, index } = await open('v2-scrambled.mdx');
  assert.equal(index.attrs.Encrypted, '2');
  assert.equal(dict.size, 11);
  assert.match(await dict.textAt(dict.findAll('grape')[0]), /grows in bunches/);
  const resources = await open('v2-scrambled.mdd');
  assert.deepEqual(resources.index.keys, ['\\bg.png', '\\pic.png', '\\test.css']);
});

test('a dictionary that needs a registration key is refused with a clear message', async () => {
  // Same fixture, but with the record-encryption flag the reader cannot handle.
  const bytes = await readFile(join(fixtures, 'v2-zlib.mdx'));
  const patched = Buffer.from(bytes);
  const header = patched.subarray(4, 4 + patched.readUInt32BE(0));
  const text = header.toString('utf16le');
  const changed = Buffer.from(text.replace('Encrypted="No"', 'Encrypted="1" '), 'utf16le');
  changed.copy(header);
  await assert.rejects(() => buildIndex(new Blob([patched])), /registration key/);
});

test('a file that is not an MDict file is rejected clearly', async () => {
  const junk = new Blob([Buffer.from('not a dictionary, just some text file'.repeat(10))]);
  await assert.rejects(() => buildIndex(junk), MDictError);
  await assert.rejects(() => buildIndex(new Blob([Buffer.alloc(0)])), MDictError);
});

test('LZO blocks decode exactly like the reference implementation', async () => {
  // Round-trip through the fixture that stores its blocks as LZO.
  const { dict } = await open('v2-lzo.mdx');
  const want = new Map(expected['v2-lzo.mdx']);
  assert.equal(await dict.textAt(dict.findAll('banana')[0]), want.get('banana'));
  assert.throws(() => lzoDecompress(new Uint8Array([]), 4), /malformed/);
});
