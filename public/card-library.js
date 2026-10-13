// The card editor's Library files: Project Library files and folders this card
// names, which every lane run sends after its playbook's own. Saved with the
// card like its gallery; each run sends their current versions.
import { $, escape, icon, button, smallForm, toast } from './ui.js';
import { locateCard, cardChanged, flushCards, loadLibraryListing } from './state.js';
import { libraryChoices, libraryPickerFields } from './library.js';
import { libraryPaths, parseSourceKey, sourceKey, uniqueSources } from './library-format.js';

// The open card's project listing; null until it loads.
let listing = null; let listingProject = null;

export function cardLibraryMarkup() {
  return `<section class="card-library" aria-labelledby="card-library-heading"><div class="field-heading"><h2 id="card-library-heading">Library files</h2><span id="card-library-count"></span></div><div id="card-library-list"></div>
    ${button('card-library-add', 'Add Library files…', 'plus', 'button small secondary')}<p class="field-help">Every lane run sends these after its playbook's Library files, at their current versions.</p></section>`;
}

export function mountCardLibrary() {
  const found = locateCard();
  if (!found) return;
  if (listingProject !== found.project.id) { listing = null; listingProject = found.project.id; }
  renderCardLibrary();
  void refreshListing();
}

async function refreshListing() {
  const projectId = listingProject;
  try {
    const loaded = await loadLibraryListing({ id: projectId });
    if (projectId !== listingProject) return;
    listing = loaded;
  } catch (error) { if (projectId === listingProject) listing = { error: error.message }; }
  renderCardLibrary();
}

// Each source by its current Library path; a folder with its file count. A
// source the Library no longer lists stays shown, by ID, until removed: a
// lane run refuses it rather than skipping it.
export function renderCardLibrary() {
  const list = $('#card-library-list');
  const found = locateCard();
  if (!list || !found) return;
  const sources = found.card.library ?? [];
  $('#card-library-count').textContent = sources.length ? `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}` : '';
  const paths = listing?.folders ? libraryPaths(listing) : null;
  const items = sources.map((source) => {
    const key = sourceKey(source); const noun = source.kind === 'folder' ? 'folder' : 'file';
    const path = source.kind === 'folder' ? paths?.folders.get(source.id) : paths?.assets.get(source.id);
    const count = path && source.kind === 'folder' && listing.assets.filter((asset) => paths.assets.get(asset.id).startsWith(path)).length;
    const name = path ? `${escape(path)}${source.kind === 'folder' ? ` <small>· ${count ? `${count} file${count === 1 ? '' : 's'}` : 'no files'}</small>` : ''}`
      : paths ? `<strong class="card-library-missing">Unavailable ${noun}</strong> <small>${escape(key)} · Lane runs are refused until it is removed.</small>` : `<small>${escape(key)}</small>`;
    return `<li><span>${icon(source.kind === 'folder' ? 'folder' : 'text')}<span>${name}</span></span><button type="button" class="text-button" data-action="card-library-remove" data-key="${escape(key)}">Remove<span class="sr-only"> ${escape(path ?? key)}</span></button></li>`;
  });
  list.innerHTML = `${items.length ? `<ol class="card-library-files">${items.join('')}</ol>` : '<p class="field-help">None yet. Runs send only the playbook\'s Library files.</p>'}
    ${listing?.error ? `<p class="card-library-missing">The Library could not be loaded: ${escape(listing.error)}</p>` : ''}`;
}

function setSources(cardId, update) {
  const found = locateCard(cardId);
  if (!found) return;
  found.card.library = update(found.card.library ?? []);
  cardChanged(found.card);
  renderCardLibrary();
  flushCards();
}

async function pickSources() {
  const found = locateCard();
  if (!found) return;
  const cardId = found.card.id;
  await refreshListing();
  if (listing?.error) throw new Error(listing.error);
  const available = libraryChoices(listing, new Set((found.card.library ?? []).map(sourceKey)));
  smallForm({ title: 'Add Library files', description: available.length ? 'Chosen files and folders join the end of this card\'s list. Every lane run sends their current versions; a folder sends every file in it.' : 'Everything in the Library is already on this card, or the Library is empty.',
    fields: libraryPickerFields(available),
    // The card may have changed while the picker was open; a source already listed keeps its place.
    submit: 'Add', onSubmit: async (data) => setSources(cardId, (current) => uniqueSources([...current, ...data.getAll('source').map(parseSourceKey).filter(Boolean)])) });
}

// Library changes in this or another tab rename, add or remove what is shown.
export function cardLibraryActivity(entry) {
  if (!['asset', 'folder'].includes(entry.entity) || entry.projectId !== listingProject || !$('#card-library-list')) return;
  void refreshListing();
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action^="card-library-"]');
  if (!target || !locateCard()) return;
  try {
    if (target.dataset.action === 'card-library-add') await pickSources();
    if (target.dataset.action === 'card-library-remove') setSources(locateCard().card.id, (current) => current.filter((source) => sourceKey(source) !== target.dataset.key));
  } catch (error) { toast(error.message); }
});
