/**
 * Host page for dictionary entries.
 *
 * This page is declared sandboxed in the manifest, so entry markup — which
 * often carries its own scripts for tabs and collapsible sections — runs with
 * an opaque origin and no access to extension APIs. Each entry gets a fresh
 * nested document so that one dictionary's CSS cannot leak into the next.
 */

let frame = null;

function render(html) {
  const next = document.createElement('iframe');
  next.setAttribute('srcdoc', html);
  next.addEventListener('load', () => {
    // Keep the previous entry on screen until this one has painted.
    for (const old of document.querySelectorAll('iframe')) {
      if (old !== next) old.remove();
    }
    frame = next;
  });
  document.body.appendChild(next);
}

window.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.source === 'mdict-panel' && message.type === 'render') {
    render(message.html);
    return;
  }
  // Anything the entry document sends goes up to the panel.
  if (message.source === 'mdict-entry') {
    parent.postMessage(message, '*');
  }
});

parent.postMessage({ source: 'mdict-viewer', type: 'ready' }, '*');
