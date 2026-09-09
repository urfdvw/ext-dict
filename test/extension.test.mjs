/**
 * End-to-end test: loads the unpacked extension in Chromium, imports the
 * fixture dictionaries through the real UI and checks what the panel shows.
 *
 * Needs Playwright (`npm install`). Set CHROMIUM_PATH to use a Chromium that
 * Playwright did not download itself.
 *
 * Run with:  npm run test:e2e
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const fixtures = join(here, 'fixtures');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('# skipped: install Playwright to run the end-to-end test');
  process.exit(0);
}

let context;
let userDataDir;
let extensionId;

before(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'mdict-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

after(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

async function openPanel() {
  const page = await context.newPage();
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));
  await page.goto(`chrome-extension://${extensionId}/src/sidepanel.html`);
  return { page, problems };
}

async function openLibrary(page) {
  if (await page.isHidden('#library')) await page.click('#open-library');
  await page.waitForSelector('#library', { state: 'visible' });
}

async function closeLibrary(page) {
  if (await page.isVisible('#library')) await page.click('#close-library');
  await page.waitForSelector('#library', { state: 'hidden' });
}

async function importFixture(page, base) {
  await openLibrary(page);
  await page.setInputFiles('#files', [
    join(fixtures, `${base}.mdx`),
    join(fixtures, `${base}.mdd`),
  ]);
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.dict-name')].some((n) => n.textContent === name),
    base,
    { timeout: 30000 }
  );
}

/** Whatever the panel is currently telling the user: placeholder or toast. */
async function notice(page) {
  const parts = [];
  if (await page.isVisible('#placeholder')) parts.push(await page.textContent('#placeholder h1'));
  if (await page.isVisible('#toast')) parts.push(await page.textContent('#toast'));
  return parts.join(' | ');
}

function entryFrames(page) {
  return page.frames().filter((frame) => frame.url().startsWith('about:srcdoc'));
}

function entryFrame(page) {
  // The newest one: while an entry is being swapped in, the previous
  // document is still attached.
  return entryFrames(page).pop();
}

/**
 * Run something that makes the panel show an entry, and return that entry's
 * document once it has replaced the one that was on screen before.
 */
async function afterNavigation(page, action, contains) {
  const before = new Set(entryFrames(page));
  await action();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const frames = entryFrames(page).filter((frame) => !before.has(frame));
    // One frame left means the swap is finished and nothing is being replaced.
    if (frames.length === 1 && entryFrames(page).length === 1) {
      const frame = frames[0];
      try {
        const text = await frame.textContent('body');
        if (text && (!contains || text.includes(contains))) return frame;
      } catch {
        /* still loading, or already replaced */
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`no new entry document${contains ? ` containing “${contains}”` : ''}`);
}

function showEntry(page, word, contains) {
  return afterNavigation(
    page,
    async () => {
      await page.fill('#query', word);
      await page.keyboard.press('Enter');
    },
    contains
  );
}

test('the service worker starts and the panel opens on the library screen', async () => {
  const { page, problems } = await openPanel();
  await page.waitForSelector('#library:not([hidden])');
  assert.ok(extensionId, 'extension loaded');
  assert.deepEqual(problems, []);
  await page.close();
});

test('importing an .mdx with its .mdd makes words searchable', async () => {
  const { page, problems } = await openPanel();
  await importFixture(page, 'v2-zlib');
  assert.match(await page.textContent('.dict-title'), /Test v2-zlib/, 'the dictionary title is shown');
  assert.match(await page.textContent('.dict:nth-child(1) .dict-meta:not(.dict-title)'), /11 entries/);
  assert.deepEqual(
    await page.$$eval('.dict:nth-child(1) .dict-file-name', (n) => n.map((x) => x.textContent)),
    ['v2-zlib.mdx', 'v2-zlib.mdd'],
    'both uploaded files are listed'
  );
  assert.deepEqual(
    await page.$$eval('.dict:nth-child(1) .dict-file-mark', (n) => n.map((x) => x.textContent)),
    ['✓', '✓'],
    'and both are marked as read'
  );

  await closeLibrary(page);
  await page.fill('#query', 'app');
  await page.waitForSelector('#suggestions:not([hidden]) li');
  const words = await page.$$eval('#suggestions li .word', (nodes) => nodes.map((n) => n.textContent));
  assert.deepEqual(words, ['Apple', 'apple tree']); // "apple"/"Apple" fold together

  const frame = await showEntry(page, 'banana', 'a long yellow fruit');
  assert.match(await frame.content(), /a long yellow fruit/);
  assert.deepEqual(problems, []);
  await page.close();
});

test('styles, images and @@@LINK redirects from the .mdd are resolved', async () => {
  const { page, problems } = await openPanel();
  await closeLibrary(page);

  const frame = await showEntry(page, 'apple', 'a round fruit');
  assert.equal(
    await frame.$eval('h1', (h) => getComputedStyle(h).color),
    'rgb(0, 128, 128)',
    'the stylesheet inside the .mdd is applied'
  );
  assert.match(await frame.$eval('img', (i) => i.src), /^data:image\/png;base64,/);
  assert.equal(await frame.$$eval('link', (n) => n.length), 0, 'no unresolved stylesheet links');

  const redirected = await showEntry(page, 'apple tree', 'a round fruit');
  assert.match(await redirected.content(), /a round fruit/, '@@@LINK= is followed');
  assert.deepEqual(problems, [], 'the entry document runs without errors');
  await page.close();
});

test('links inside an entry scroll to anchors and jump to other head words', async () => {
  const { page, problems } = await openPanel();
  await closeLibrary(page);

  const cherry = await showEntry(page, 'cherry', 'a small red fruit');
  await cherry.click('#anchor-link');
  await page.waitForTimeout(500);
  assert.equal(await page.inputValue('#query'), 'cherry', 'an in-page anchor stays put');
  assert.ok(await page.isHidden('#toast'), 'and does not report a failed lookup');

  const banana = await showEntry(page, 'banana', 'a long yellow fruit');
  const jumped = await afterNavigation(page, () => banana.click('#cross-link'), 'a small red fruit');
  assert.match(await jumped.content(), /a small red fruit/, 'entry:// opens the other word');
  assert.equal(await page.inputValue('#query'), 'cherry');
  await page.waitForSelector('#back:not([hidden])');
  await afterNavigation(page, () => page.click('#back'), 'a long yellow fruit');
  assert.equal(await page.inputValue('#query'), 'banana', 'back returns to the previous word');
  assert.deepEqual(problems, []);
  await page.close();
});

test('the panel stays light even when the browser prefers dark', async () => {
  const { page } = await openPanel();
  await page.emulateMedia({ colorScheme: 'dark' });
  await closeLibrary(page);
  assert.equal(await page.$eval('body', (b) => getComputedStyle(b).backgroundColor), 'rgb(255, 255, 255)');
  const frame = await showEntry(page, 'apple', 'a round fruit');
  assert.equal(
    await frame.$eval('body', (b) => getComputedStyle(b).backgroundColor),
    'rgb(255, 255, 255)',
    'and so does the entry, which dictionaries style for a light background'
  );
  await page.close();
});

test('looked-up words are kept in a recent list', async () => {
  const { page, problems } = await openPanel();
  await closeLibrary(page);
  await showEntry(page, 'banana', 'a long yellow fruit');
  await showEntry(page, 'date', 'a sweet dried fruit');

  await page.click('#show-history');
  await page.waitForSelector('#suggestions .list-header');
  const words = await page.$$eval('#suggestions li .word', (n) => n.map((x) => x.textContent));
  assert.deepEqual(words.slice(0, 2), ['date', 'banana'], 'newest first, no duplicates');

  // the header is the first child
  const reopened = await afterNavigation(
    page,
    () => page.click('#suggestions li:nth-child(3)'),
    'a long yellow fruit'
  );
  assert.match(await reopened.content(), /a long yellow fruit/);
  assert.equal(await page.inputValue('#query'), 'banana');

  // The list survives the panel being closed and opened again.
  await page.close();
  const second = await openPanel();
  await closeLibrary(second.page);
  await second.page.click('#show-history');
  await second.page.waitForSelector('#suggestions .list-header');
  assert.equal(await second.page.textContent('#suggestions li:nth-child(2) .word'), 'banana');

  await second.page.click('#suggestions .list-header .link-button');
  await second.page.waitForSelector('#suggestions', { state: 'hidden' });
  assert.deepEqual(problems, []);
  await second.page.close();
});

test('a word that is missing lands in the search box, ready to be edited', async () => {
  const { page, problems } = await openPanel();
  await closeLibrary(page);

  // An inflected form, the way it would arrive from a selection on a page.
  await page.fill('#query', 'cherries');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement.id === 'query');
  assert.match(await notice(page), /No entry for “cherries”/, 'the panel says so');
  assert.equal(await page.inputValue('#query'), 'cherries', 'the word stays in the box');
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    'query',
    'and the box has focus'
  );
  assert.deepEqual(
    await page.$eval('#query', (input) => [input.selectionStart, input.selectionEnd]),
    [8, 8],
    'with the caret at the end, so the ending can be trimmed'
  );

  // Editing the ending finds the head word the dictionary does have.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
  await page.waitForSelector('#suggestions:not([hidden]) li');
  assert.deepEqual(
    await page.$$eval('#suggestions li .word', (n) => n.map((x) => x.textContent)),
    ['cherry']
  );
  const found = await afterNavigation(page, () => page.keyboard.press('Enter'), 'a small red fruit');
  assert.match(await found.content(), /a small red fruit/);
  assert.deepEqual(problems, []);
  await page.close();
});

test('a missing word from the right-click lookup is editable too', async () => {
  const { page } = await openPanel();
  await closeLibrary(page);
  // What the service worker does when the context menu is used.
  await page.evaluate(() =>
    chrome.storage.session.set({ pendingQuery: { text: 'Geese', at: Date.now() } })
  );
  await page.waitForFunction(() => document.getElementById('query').value === 'Geese');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'query');
  assert.deepEqual(
    await page.$eval('#query', (input) => [input.selectionStart, input.selectionEnd]),
    [5, 5]
  );
  assert.match(await notice(page), /No entry for “Geese”/);
  await page.close();
});

test('a second dictionary shows up as its own tab', async () => {
  const { page, problems } = await openPanel();
  await importFixture(page, 'v1-lzo');
  await closeLibrary(page);

  const frame = await showEntry(page, 'cherry', 'a small red fruit');
  assert.match(await frame.content(), /a small red fruit/);
  await page.waitForSelector('#tabs:not([hidden]) .tab');
  const tabs = await page.$$eval('#tabs .tab', (nodes) => nodes.map((n) => n.textContent));
  assert.deepEqual(tabs, ['v2-zlib', 'v1-lzo']);

  const second = await afterNavigation(
    page,
    () => page.click('#tabs .tab:nth-child(2)'),
    'a small red fruit'
  );
  assert.match(await second.content(), /a small red fruit/);
  assert.deepEqual(problems, []);
  await page.close();
});

test('turning a dictionary off removes it from lookups, and it can be deleted', async () => {
  const { page } = await openPanel();
  await openLibrary(page);
  await page.waitForSelector('.dict');
  await page.uncheck('.dict:nth-child(2) input[type=checkbox]');
  await closeLibrary(page);

  await page.fill('#query', 'cherry');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  assert.ok(await page.isHidden('#tabs'), 'only one dictionary answers now');

  page.on('dialog', (dialog) => dialog.accept());
  await openLibrary(page);
  await page.click('.dict:nth-child(2) .link-button');
  await page.waitForFunction(() => document.querySelectorAll('.dict').length === 1);
  await page.click('.dict:nth-child(1) .link-button');
  await page.waitForSelector('#dict-list .note');
  await page.close();
});

test('a file that is not a dictionary is reported without breaking the panel', async () => {
  const { page } = await openPanel();
  await openLibrary(page);
  await page.setInputFiles('#files', [
    { name: 'broken.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from('nonsense'.repeat(64)) },
  ]);
  await page.waitForSelector('.imports .error', { timeout: 20000 });
  assert.match(await page.textContent('.imports .error'), /does not look like an MDict file/);
  assert.equal(await page.$$eval('.dict', (n) => n.length), 0);
  await page.close();
});
