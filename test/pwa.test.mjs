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
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const fixtures = join(here, 'fixtures');
const BASE_PATH = '/ext-dict'; // a GitHub project page lives under a subpath

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('# skipped: install Playwright to run the web app test');
  process.exit(0);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

let server;
let origin;
let browser;
let context;

before(async () => {
  server = createServer(async (request, response) => {
    let path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!path.startsWith(BASE_PATH)) {
      response.writeHead(404).end('outside the site');
      return;
    }
    path = path.slice(BASE_PATH.length) || '/';
    if (path.endsWith('/')) path += 'index.html';
    const file = join(root, normalize(path));
    if (!file.startsWith(root)) {
      response.writeHead(403).end('no');
      return;
    }
    try {
      await stat(file);
    } catch {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}${BASE_PATH}/`;

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  context = await browser.newContext();
});

after(async () => {
  await context?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

async function openApp(path = '') {
  const page = await context.newPage();
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));
  await page.goto(origin + path);
  await page.waitForSelector('#query');
  return { page, problems };
}

function entryFrames(page) {
  return page.frames().filter((frame) => frame.url().startsWith('about:srcdoc'));
}

async function afterNavigation(page, action, contains) {
  const before = new Set(entryFrames(page));
  await action();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const fresh = entryFrames(page).filter((frame) => !before.has(frame));
    if (fresh.length === 1 && entryFrames(page).length === 1) {
      try {
        const text = await fresh[0].textContent('body');
        if (text && (!contains || text.includes(contains))) return fresh[0];
      } catch {
        /* still loading */
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`no entry document containing “${contains}”`);
}

async function importFixture(page, base) {
  if (await page.isHidden('#library')) await page.click('#open-library');
  await page.waitForSelector('#library', { state: 'visible' });
  await page.setInputFiles('#files', [
    join(fixtures, `${base}.mdx`),
    join(fixtures, `${base}.mdd`),
  ]);
  await page.waitForSelector('.dict-name', { timeout: 30000 });
  await page.click('#close-library');
  await page.waitForSelector('#library', { state: 'hidden' });
}

test('the page serves a valid web app manifest and icons', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'app.webmanifest'), 'utf8'));
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
  const frame = await afterNavigation(
    page,
    async () => {
      await page.fill('#query', 'apple');
      await page.keyboard.press('Enter');
    },
    'a round fruit'
  );
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
    const frame = await afterNavigation(
      page,
      async () => {
        await page.fill('#query', 'cherry');
        await page.keyboard.press('Enter');
      },
      'a small red fruit'
    );
    assert.match(await frame.content(), /a small red fruit/);
  } finally {
    await context.setOffline(false);
  }
  await page.close();
});

test('the service worker caches every file the app loads', async () => {
  const { page } = await openApp();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const shell = await readFile(join(root, 'sw.js'), 'utf8');
  const listed = [...shell.matchAll(/'(\.\/[^']+)'/g)].map((m) => m[1]).filter((p) => p !== './');
  for (const path of listed) {
    const response = await fetch(new URL(path, origin));
    assert.equal(response.status, 200, `${path} is part of the site`);
  }
  await page.close();
});
