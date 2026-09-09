/**
 * Turns the HTML stored in a dictionary entry into a self-contained document
 * for the sandboxed viewer: stylesheets, images, sounds and scripts that live
 * in the .mdd archives are inlined, and links are handed to the panel.
 */

const MIME_TYPES = {
  css: 'text/css',
  js: 'text/javascript',
  png: 'image/png',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  spx: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  eot: 'application/vnd.ms-fontobject',
};

/** Decode a text resource, honouring a byte-order mark when there is one. */
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  return new TextDecoder('utf-8').decode(bytes);
}

export function mimeFor(path) {
  const ext = String(path).split(/[?#]/)[0].split('.').pop().toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

export function toDataUrl(bytes, mime) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** True for references the panel resolves against the .mdd archives. */
function isLocalReference(url) {
  return !!url && !/^(https?:|data:|blob:|about:|javascript:|mailto:|#|entry:|sound:)/i.test(url);
}

const BASE_STYLE = `
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; padding: 12px 14px 32px; background: #fff; color: #16181d;
         font: 15px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
         overflow-wrap: break-word; }
  img, video { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #1a63d8; }
  hr.mdict-homograph-rule { border: 0; border-top: 1px dashed #c9ced8; margin: 18px 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1e22; color: #e6e8ec; }
    a { color: #7fb0ff; }
    hr.mdict-homograph-rule { border-top-color: #3a3f4a; }
  }
`;

// Runs inside the entry document; forwards navigation to the panel.
const BRIDGE_SCRIPT = `
  document.addEventListener('click', function (event) {
    var node = event.target;
    while (node && node.nodeName !== 'A') node = node.parentNode;
    if (!node) return;
    var href = node.getAttribute('href') || '';
    if (!href) return;
    event.preventDefault();
    // Links into the entry itself, written either as "#name" or
    // "entry://#name", are scrolled to here.
    var lower = href.toLowerCase();
    if (href.charAt(0) === '#' || lower.indexOf('entry://#') === 0) {
      var name = href.slice(href.indexOf('#') + 1);
      var target = name
        ? document.getElementById(name) || document.getElementsByName(name)[0]
        : document.body;
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    parent.postMessage({ source: 'mdict-entry', type: 'navigate', href: href }, '*');
  }, true);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' || event.key === '/') {
      parent.postMessage({ source: 'mdict-entry', type: 'key', key: event.key }, '*');
    }
  });
`;

/**
 * @param {string} html entry markup as stored in the dictionary
 * @param {(path: string) => Promise<Uint8Array|null>} resolve .mdd lookup
 * @returns {Promise<string>} a complete HTML document
 */
export async function buildEntryDocument(html, resolve) {
  const cache = new Map();
  const load = async (path) => {
    if (!cache.has(path)) cache.set(path, await resolve(path).catch(() => null));
    return cache.get(path);
  };

  const doc = new DOMParser().parseFromString(`<div id="mdict-root">${html}</div>`, 'text/html');
  const root = doc.getElementById('mdict-root');
  const styles = [];

  for (const link of [...doc.querySelectorAll('link[href]')]) {
    const href = link.getAttribute('href');
    const rel = (link.getAttribute('rel') || '').toLowerCase();
    if (rel && !rel.includes('stylesheet')) continue;
    if (isLocalReference(href)) {
      const bytes = await load(href);
      if (bytes) styles.push(await inlineCssUrls(decodeText(bytes), load));
    }
    link.remove();
  }

  for (const style of [...doc.querySelectorAll('style')]) {
    styles.push(await inlineCssUrls(style.textContent || '', load));
    style.remove();
  }

  const scripts = [];
  for (const script of [...doc.querySelectorAll('script')]) {
    const src = script.getAttribute('src');
    if (isLocalReference(src)) {
      const bytes = await load(src);
      if (bytes) scripts.push(decodeText(bytes));
    } else if (!src) {
      scripts.push(script.textContent || '');
    }
    script.remove();
  }

  for (const element of [...root.querySelectorAll('[src]')]) {
    const src = element.getAttribute('src');
    if (!isLocalReference(src)) continue;
    const bytes = await load(src);
    if (bytes) element.setAttribute('src', toDataUrl(bytes, mimeFor(src)));
    else element.removeAttribute('src');
  }

  for (const element of [...root.querySelectorAll('[style*="url("]')]) {
    element.setAttribute('style', await inlineCssUrls(element.getAttribute('style'), load));
  }

  for (const anchor of [...root.querySelectorAll('a[href]')]) {
    anchor.removeAttribute('target');
  }

  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${BASE_STYLE}</style>`,
    styles.map((css) => `<style>${css}</style>`).join(''),
    '</head><body>',
    root.innerHTML,
    scripts.map((code) => `<script>${code}<\/script>`).join(''),
    `<script>${BRIDGE_SCRIPT}<\/script>`,
    '</body></html>',
  ].join('');
}

/** Replace url(...) references in CSS with inlined data URLs. */
async function inlineCssUrls(css, load) {
  const references = [...String(css).matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)];
  let out = String(css);
  for (const match of references) {
    const target = match[2].trim();
    if (!isLocalReference(target)) continue;
    const bytes = await load(target);
    if (bytes) out = out.split(match[0]).join(`url("${toDataUrl(bytes, mimeFor(target))}")`);
  }
  return out;
}
