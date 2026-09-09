/**
 * Worker that turns an uploaded .mdx/.mdd blob into a searchable index,
 * so that importing a large dictionary does not block the panel.
 */

import { buildIndex } from '../lib/mdict.js';
import { STORE_FILES, STORE_INDEXES, get, put } from '../lib/storage.js';

self.addEventListener('message', async (event) => {
  const { type, fileId, isMdd } = event.data || {};
  if (type !== 'index') return;
  try {
    const file = await get(STORE_FILES, fileId);
    if (!file) throw new Error('The uploaded file is no longer in storage.');
    let lastPost = 0;
    const index = await buildIndex(file.blob, {
      isMdd,
      onProgress: ({ phase, ratio }) => {
        const now = Date.now();
        if (now - lastPost < 100) return;
        lastPost = now;
        self.postMessage({ type: 'progress', fileId, phase, ratio });
      },
    });
    await put(STORE_INDEXES, { id: fileId, index });
    self.postMessage({
      type: 'done',
      fileId,
      summary: {
        entryCount: index.keys.length,
        title: index.title,
        description: index.description,
        version: index.version,
        encoding: index.encoding,
      },
    });
  } catch (error) {
    self.postMessage({ type: 'error', fileId, message: error?.message || String(error) });
  }
});
