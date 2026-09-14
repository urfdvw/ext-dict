/**
 * The panel's markup.
 *
 * Both hosts — the extension's side panel page and the web app's index page —
 * are empty shells that mount this, so the two cannot drift apart.
 */

export const PANEL_MARKUP = `
<header class="bar">
  <button id="back" class="icon-button" title="Back" hidden aria-label="Back">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
  </button>
  <div class="search">
    <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </svg>
    <input
      id="query"
      type="search"
      placeholder="Search the dictionary"
      autocomplete="off"
      spellcheck="false"
      aria-label="Search word"
    />
    <button id="clear" class="icon-button subtle" title="Clear" hidden aria-label="Clear">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  </div>
  <button id="show-history" class="icon-button" title="Recent lookups" aria-label="Recent lookups">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  </button>
  <button id="open-library" class="icon-button" title="Dictionaries" aria-label="Dictionaries">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5.5h6a2 2 0 012 2V19a2.5 2.5 0 00-2-1.4H4zM20 5.5h-6a2 2 0 00-2 2V19a2.5 2.5 0 012-1.4h6z" />
    </svg>
  </button>
</header>

<nav id="tabs" class="tabs" hidden></nav>

<main class="stage">
  <ul id="suggestions" class="suggestions" hidden></ul>

  <section id="placeholder" class="placeholder">
    <h1>No dictionary yet</h1>
    <p>Add an <code>.mdx</code> file — and its <code>.mdd</code> companions, if it has any — to start looking words up.</p>
    <button id="placeholder-add" class="primary">Add a dictionary</button>
  </section>

  <iframe id="viewer" title="Dictionary entry" referrerpolicy="no-referrer"></iframe>
</main>

<section id="library" class="library" hidden aria-label="Dictionaries">
  <header class="library-bar">
    <h2>Dictionaries</h2>
    <button id="close-library" class="icon-button" title="Close" aria-label="Close">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  </header>

  <div class="library-body">
    <label class="dropzone" id="dropzone">
      <input id="files" type="file" accept=".mdx,.mdd" multiple hidden />
      <strong>Add dictionary files</strong>
      <span>Pick an <code>.mdx</code> file together with any <code>.mdd</code> files that came with it, or drop them here.</span>
    </label>

    <ul id="imports" class="imports" hidden></ul>
    <ul id="dict-list" class="dict-list"></ul>
    <p id="storage-note" class="note"></p>
  </div>
</section>

<div id="toast" class="toast" hidden role="status"></div>
`;

/** Ids in the markup above, and the names the panel knows them by. */
const ELEMENTS = {
  back: 'back',
  query: 'query',
  clear: 'clear',
  showHistory: 'show-history',
  openLibrary: 'open-library',
  tabs: 'tabs',
  suggestions: 'suggestions',
  placeholder: 'placeholder',
  placeholderAdd: 'placeholder-add',
  viewer: 'viewer',
  library: 'library',
  closeLibrary: 'close-library',
  dropzone: 'dropzone',
  files: 'files',
  imports: 'imports',
  dictList: 'dict-list',
  storageNote: 'storage-note',
  toast: 'toast',
};

/**
 * Put the markup on the page and fill `ui` with its elements.
 *
 * @param {Record<string, HTMLElement>} ui filled in place
 */
export function mountPanel(ui) {
  document.body.innerHTML = PANEL_MARKUP;
  for (const [name, id] of Object.entries(ELEMENTS)) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`The panel markup is missing #${id}.`);
    ui[name] = element;
  }
  return ui;
}
