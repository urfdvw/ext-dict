/**
 * End-to-end test for the hosted web app.
 *
 * The repository is served the way GitHub Pages serves it — as static files
 * under a project path — and the app is driven in a plain browser tab, with
 * no extension loaded.
 *
 * Needs Playwright (`npm install`). Set CHROMIUM_PATH to use a Chromium that
 * Playwright did not download itself.
 *
 * Run with:  npm run test:pwa
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  afterNavigation,
  importFixture,
  launchOptions,
  loadPlaywright,
  repoRoot,
  serveRepository,
  showEntry,
  watchForProblems,
} from './panel.mjs';

const BASE_PATH = '/ext-dict'; // a GitHub project page lives under a subpath

const chromium = await loadPlaywright();
if (!chromium) {
  console.log('# skipped: install Playwright to run the web app test');
  process.exit(0);
}

let site;
let origin;
let browser;
let context;

before(async () => {
  site = await serveRepository(BASE_PATH);
  origin = site.origin;
  browser = await chromium.launch(launchOptions());
  context = await browser.newContext();
});

after(async () => {
  await context?.close();
  await browser?.close();
  await site?.close();
});

/** Open the web app in a tab, with no extension loaded. */
async function openApp(path = '') {
  const page = await context.newPage();
  const problems = watchForProblems(page);
  await page.goto(origin + path);
  await page.waitForSelector('#query');
  return { page, problems };
}

test('the page serves a valid web app manifest and icons', async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'app.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './', 'relative, so it works under a project path');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.ok(
    manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'),
    'a maskable icon is needed for Android home screens'
  );
  for (const icon of manifest.icons) {
    const response = await fetch(new URL(icon.src, origin));
    assert.equal(response.status, 200, `${icon.src} is served`);
    assert.equal(response.headers.get('content-type'), 'image/png');
  }
});

test('the app runs a dictionary lookup with no extension APIs', async () => {
  const { page, problems } = await openApp();
  assert.equal(await page.evaluate(() => typeof chrome?.runtime?.id), 'undefined');
  await page.waitForSelector('#library:not([hidden])'); // opens on the library, being empty

  await importFixture(page, 'v2-zlib');
  const frame = await showEntry(page, 'apple', 'a round fruit');
  assert.equal(
    await frame.$eval('h1', (h) => getComputedStyle(h).color),
    'rgb(0, 128, 128)',
    'the .mdd stylesheet is applied here too'
  );
  assert.match(await frame.$eval('img', (i) => i.src), /^data:image\/png;base64,/);
  assert.deepEqual(problems, []);
  await page.close();
});

test('?q= looks a word up on load, and recent lookups persist', async () => {
  const { page } = await openApp('?q=banana');
  await afterNavigation(page, async () => {}, 'a long yellow fruit');
  assert.equal(await page.inputValue('#query'), 'banana');

  await page.close();
  const again = await openApp();
  await again.page.click('#show-history');
  await again.page.waitForSelector('#suggestions .list-header');
  assert.equal(await again.page.textContent('#suggestions li:nth-child(2) .word'), 'banana');
  await again.page.close();
});

test('the service worker keeps the app working offline', async () => {
  const { page } = await openApp();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 15000,
  });

  await context.setOffline(true);
  try {
    await page.reload();
    await page.waitForSelector('#query', { timeout: 15000 });
    // The dictionary is in IndexedDB, so lookups still work with no network.
    const frame = await showEntry(page, 'cherry', 'a small red fruit');
    assert.match(await frame.content(), /a small red fruit/);
  } finally {
    await context.setOffline(false);
  }
  await page.close();
});

test('the service worker precaches every file the web app ships', async () => {
  const shell = await readFile(join(repoRoot, 'sw.js'), 'utf8');
  const precached = new Set([...shell.matchAll(/'(\.\/[^']*)'/g)].map((match) => match[1]));

  const page = await readFile(join(repoRoot, 'index.html'), 'utf8');
  const manifest = JSON.parse(await readFile(join(repoRoot, 'app.webmanifest'), 'utf8'));
  const libraries = (await readdir(join(repoRoot, 'src', 'lib'))).map((name) => `./src/lib/${name}`);

  const needed = [
    './',
    './index.html',
    './app.webmanifest',
    './src/app.js',
    './src/sidepanel.js',
    './src/sidepanel.css',
    './src/viewer.html',
    './src/worker/indexer.js',
    ...libraries,
    // Whatever the page and the manifest point at, icons included.
    ...[...page.matchAll(/(?:href|src)="(\.\/icons\/[^"]+)"/g)].map((match) => match[1]),
    ...manifest.icons.map((icon) => icon.src),
  ];

  for (const path of new Set(needed)) {
    assert.ok(precached.has(path), `sw.js should precache ${path}`);
    const response = await fetch(new URL(path, origin));
    assert.equal(response.status, 200, `${path} is served`);
  }

  // Nothing listed should be missing from the site.
  for (const path of precached) {
    const response = await fetch(new URL(path, origin));
    assert.equal(response.status, 200, `sw.js lists ${path}, which is not there`);
  }
});
