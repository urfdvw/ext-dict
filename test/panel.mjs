/**
 * Helpers shared by the two browser test suites.
 *
 * The extension's side panel and the hosted web app run the same panel, so
 * the code that drives it is the same too: only how the page is opened
 * differs, and that stays in each suite.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = dirname(here);
export const fixtures = join(here, 'fixtures');

/** Playwright, or null when it is not installed. */
export async function loadPlaywright() {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch {
    return null;
  }
}

export function launchOptions() {
  return { executablePath: process.env.CHROMIUM_PATH || undefined, headless: true };
}

/* --------------------------------------------------------- static server */

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Serve the repository the way GitHub Pages serves a project site: static
 * files under a path prefix, and nothing outside the directory.
 *
 * @param {string} basePath e.g. "/ext-dict"
 * @returns {Promise<{origin: string, close: () => Promise<void>}>}
 */
export async function serveRepository(basePath) {
  const server = createServer(async (request, response) => {
    let path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!path.startsWith(basePath)) {
      response.writeHead(404).end('outside the site');
      return;
    }
    path = path.slice(basePath.length) || '/';
    if (path.endsWith('/')) path += 'index.html';
    const file = join(repoRoot, normalize(path));
    if (!file.startsWith(repoRoot)) {
      response.writeHead(403).end('no');
      return;
    }
    try {
      await stat(file);
    } catch {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(file)] || 'application/octet-stream',
    });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}${basePath}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* ------------------------------------------------------------ the panel */

/** Collect console errors and uncaught exceptions from a page. */
export function watchForProblems(page) {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));
  return problems;
}

export async function openLibrary(page) {
  if (await page.isHidden('#library')) await page.click('#open-library');
  await page.waitForSelector('#library', { state: 'visible' });
}

export async function closeLibrary(page) {
  if (await page.isVisible('#library')) await page.click('#close-library');
  await page.waitForSelector('#library', { state: 'hidden' });
}

/** Add one of the fixture dictionaries through the library screen. */
export async function importFixture(page, base, { close = true } = {}) {
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
  if (close) await closeLibrary(page);
}

/** Whatever the panel is currently telling the user: placeholder or toast. */
export async function notice(page) {
  const parts = [];
  if (await page.isVisible('#placeholder')) parts.push(await page.textContent('#placeholder h1'));
  if (await page.isVisible('#toast')) parts.push(await page.textContent('#toast'));
  return parts.join(' | ');
}

export function entryFrames(page) {
  return page.frames().filter((frame) => frame.url().startsWith('about:srcdoc'));
}

export function entryFrame(page) {
  // The newest one: while an entry is being swapped in, the previous
  // document is still attached.
  return entryFrames(page).pop();
}

/**
 * Run something that makes the panel show an entry, and return that entry's
 * document once it has replaced the one that was on screen before.
 */
export async function afterNavigation(page, action, contains) {
  const before = new Set(entryFrames(page));
  await action();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const fresh = entryFrames(page).filter((frame) => !before.has(frame));
    // One frame left means the swap is finished and nothing is being replaced.
    if (fresh.length === 1 && entryFrames(page).length === 1) {
      try {
        const text = await fresh[0].textContent('body');
        if (text && (!contains || text.includes(contains))) return fresh[0];
      } catch {
        /* still loading, or already replaced */
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`no new entry document${contains ? ` containing “${contains}”` : ''}`);
}

/** Search for a word and wait for its entry. */
export function showEntry(page, word, contains) {
  return afterNavigation(
    page,
    async () => {
      await page.fill('#query', word);
      await page.keyboard.press('Enter');
    },
    contains
  );
}
