# MDict Side Panel

Look words up in your own MDict dictionaries — the `.mdx` files and their
`.mdd` resource archives — in the browser. Everything is parsed locally;
nothing is uploaded anywhere.

It comes in two forms that share all of their code:

- a **Chrome extension** that puts the dictionary in the browser side panel,
  with a right-click lookup for selected text;
- a **web app** you can host on GitHub Pages, installable to a desktop or
  phone home screen and usable offline.

![the extension icon](icons/icon48.png)

## What it does

- **Side panel lookup.** Type a word and get live suggestions from every
  dictionary you have added, then the full entry with the dictionary's own
  styling.
- **Right-click lookup.** Select text on any page, right-click, and choose
  *Look up "…" in MDict*. The panel opens with the entry already on screen.
- **Your own dictionaries.** Add one or more `.mdx` files, each with the
  `.mdd` archives that came with it (`Dict.mdd`, `Dict.1.mdd`, …). Images,
  stylesheets, scripts and sounds stored in the `.mdd` are inlined into the
  entry as it is displayed.
- **Several dictionaries at once.** When more than one dictionary defines a
  word, each gets a tab. The *Dictionaries* screen lists every file that was
  added, so it is clear whether the `.mdd` arrived with its `.mdx`, and
  dictionaries can be switched off without deleting them.
- **Words that are not there.** A word with no entry is left in the search
  box with the caret at its end and the box focused, so an inflected form
  (`cherries`, `running`) can be trimmed back to the head word the
  dictionary actually lists; suggestions appear as you edit.
- **Recent lookups.** Words you have looked up are kept in a list that opens
  from the clock button, or whenever the search box is empty.
- **Cross-references.** `entry://` links jump to another head word,
  `@@@LINK=` redirects are followed, `sound://` links play, and ordinary
  links open in a new tab.

The panel is always light, because dictionaries bring their own light
stylesheets and a dark frame around them reads badly.

Dictionary files are stored in the browser's IndexedDB on your computer and
are read on demand — only the key index is held in memory, so a large
dictionary does not have to be loaded in full to be searched.

## Install the extension

The extension is not packaged for the Chrome Web Store; load it unpacked:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Pin the extension, click its icon to open the panel, then add an `.mdx`
   file (with any `.mdd` files that belong to it) on the *Dictionaries*
   screen.

Chrome 116 or newer is required for the side panel API.

## Host the web app

The repository root is the web app, so GitHub Pages can serve it as it is:

1. Push this repository to GitHub.
2. Open **Settings → Pages**, and under *Build and deployment* choose
   **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Open the address Pages gives you — `https://<user>.github.io/<repo>/`.

Every path in the app is relative, so it works under a project path without
configuration. Browsers offer to install it (Chrome's address-bar install
button, or *Add to Home Screen* on a phone); once installed it opens in its
own window and works with no network at all — the app shell is precached by
a service worker and the dictionaries already live in the browser.

A word can be handed to the app in the address bar as
`https://<user>.github.io/<repo>/?q=serendipity`, which is enough for a
bookmarklet or a phone shortcut.

Dictionaries are stored per browser profile and per origin: the extension
and the hosted app each keep their own copy, and adding a dictionary to one
does not add it to the other.

To try it locally, `npm run serve` and open <http://localhost:8000/> —
service workers are allowed on localhost.

## Supported files

| | |
|---|---|
| Formats | MDict `.mdx` and `.mdd`, engine versions 1.2 and 2.0 |
| Compression | none, zlib, LZO1X |
| Encodings | UTF-8, UTF-16, GBK/GB18030, Big5 |
| Key index | plain, and the scrambled form (`Encrypted="2"`) many dictionaries use |
| Not supported | dictionaries whose records need a registration key (`Encrypted="1"`), MDict 3.0 files |

An unsupported file is reported on the *Dictionaries* screen instead of
failing silently.

## How it is put together

```
manifest.json          MV3 manifest: side panel, context menu, sandboxed viewer
src/background.js      extension service worker: context menu, opening the panel
index.html             the web app's page
app.webmanifest        web app manifest: name, icons, standalone display
sw.js                  web app service worker: precached shell, offline
src/app.js             web app entry point
src/sidepanel.html|js  the panel: search, suggestions, tabs, library screen
src/sidepanel.css      one stylesheet for both
src/lib/shell.js       the panel markup both pages mount
src/lib/platform.js    the few differences between extension and web app
src/viewer.html        sandboxed page that hosts entry markup
src/worker/indexer.js  builds a dictionary's index off the main thread
src/lib/mdict.js       MDict container parser and random-access reader
src/lib/lzo1x.js       LZO1X decompressor for older dictionaries
src/lib/ripemd128.js   key derivation for scrambled key indexes
src/lib/render.js      inlines .mdd resources into an entry document
src/lib/library.js     import, metadata, and lookups across dictionaries
src/lib/storage.js     IndexedDB wrapper
```

The panel is one piece of code with two hosts. `src/lib/shell.js` holds its
markup and `src/lib/platform.js` holds everything that differs between them
— where small settings are kept, how an outside link is opened, and how a
word asked for elsewhere arrives — so neither copy can drift from the other.

Entry markup is never inserted into the panel itself. It is rendered inside a
sandboxed extension page (opaque origin, no extension APIs), which in turn
hosts one throwaway document per entry, so a dictionary's scripts and styles
cannot reach the panel or leak into the next entry.

## Development

```sh
npm test                         # parser tests, no browser needed
npm install && npm run test:e2e  # drives the real extension in Chromium
npm run test:pwa                 # serves the repo and drives the web app,
                                 # including a reload with the network off
npm run serve                    # http://localhost:8000/ for hand testing
npm run fixtures                 # regenerate test/fixtures (needs python3)
```

`test/fixtures/*.md[xd]` are small dictionaries written by
`tools/make_test_dict.py`, covering both engine versions, all three
compressions and each supported encoding. `test/fixtures/expected.json`
records what an independent MDict reader ([mdict-utils]) reads back from
them, so the parser is checked against a second implementation rather than
against itself.

[mdict-utils]: https://pypi.org/project/mdict-utils/
