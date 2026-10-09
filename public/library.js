// The project Library tab: upload files or write documents, inspect and
// download their exact retained versions, and resolve name collisions
// explicitly. Document drafts are kept as the user types; only Save publishes.
import { $, escape, icon, button, iconButton, toast, smallForm, id } from './ui.js';
import { request } from './api.js';
import { assetPreview, libraryFilename, nameConflict, previewType, splitExtension } from './library-format.js';
import { project } from './state.js';

const dialog = $('#library-dialog');
const previewBytes = 64 * 1024;
const library = { projectId: null, assets: [], drafts: [], loaded: false, error: '', query: '', uploads: [] };
let inspected = null;
// The open document editor: its draft as last kept on the server, plus local state.
let editing = null;

const base = (projectId = library.projectId) => `/api/projects/${encodeURIComponent(projectId)}/library`;
const contentURL = (versionId, inline = false) => `${base()}/versions/${encodeURIComponent(versionId)}/content${inline ? '?inline=1' : ''}`;
const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
export function formatSize(size) {
  let value = size; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit ? `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}` : `${size} ${size === 1 ? 'byte' : 'bytes'}`;
}
const savedAt = (value) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const extension = (filename) => splitExtension(filename)[1].slice(0, 5).toUpperCase() || 'FILE';
const archived = () => Boolean(project()?.archivedAt);

async function load() {
  const projectId = project()?.id;
  if (!projectId) return;
  if (library.projectId !== projectId) Object.assign(library, { projectId, assets: [], drafts: [], loaded: false, error: '', query: '', uploads: [] });
  try {
    const { assets, drafts } = await request(base(projectId));
    if (library.projectId !== projectId) return;
    Object.assign(library, { assets, drafts, loaded: true, error: '' });
  } catch (error) { library.error = error.message; }
}

export async function renderLibrary() {
  if (!$('#library')) return;
  if (library.projectId !== project()?.id || !library.loaded) { paint(); await load(); }
  paint();
}

const draftFor = (asset) => library.drafts.find((draft) => draft.assetId === asset.id);
// Text files and written documents open in the editor; the server checks the bytes are UTF-8.
const editable = (asset) => assetPreview(asset)?.kind === 'text';
function thumbnail(asset) {
  const preview = previewType(asset.filename);
  if (!asset.current.available) return `<div class="library-thumb unavailable">${icon('close')}<span>Unavailable</span></div>`;
  if (preview?.kind === 'image') return `<div class="library-thumb"><img src="${contentURL(asset.current.id, true)}" alt="" loading="lazy" draggable="false"></div>`;
  return `<div class="library-thumb file"><span>${escape(extension(asset.filename))}</span></div>`;
}
function assetMarkup(asset) {
  return `<li><button class="library-asset" data-action="library-inspect" data-id="${escape(asset.id)}" aria-label="Inspect ${escape(asset.filename)}">${thumbnail(asset)}
    <span class="library-name">${escape(asset.filename)}</span><span class="library-meta">v${asset.current.number} · ${formatSize(asset.current.size)}${asset.current.available ? '' : ' · <strong>Unavailable</strong>'}${draftFor(asset) ? ' · <em>Draft</em>' : ''}</span></button></li>`;
}
// A new document's draft is not a Library file until its first Save.
function draftMarkup(draft) {
  return `<li><button class="library-asset draft" data-action="library-edit-draft" data-id="${escape(draft.id)}" aria-label="Edit draft ${escape(draft.filename)}"><div class="library-thumb draft"><span>DRAFT</span></div>
    <span class="library-name">${escape(draft.filename)}</span><span class="library-meta">Unsaved draft</span></button></li>`;
}
const uploadState = {
  waiting: () => 'Waiting', uploading: (entry) => `Uploading ${Math.round((entry.progress || 0) * 100)}%`, cancelled: () => 'Cancelled',
  saved: (entry) => entry.message, failed: (entry) => entry.error,
};
function uploadMarkup(entry) {
  return `<li class="library-upload ${entry.status}" data-upload="${entry.id}"><span class="library-upload-name">${escape(entry.file.name)}</span>
    <span class="library-upload-state" role="status">${escape(uploadState[entry.status](entry))}</span>${entry.status === 'failed' && entry.retryable ? button('library-retry-upload', 'Retry', null, 'button small secondary', `data-id="${entry.id}"`) : ''}</li>`;
}
function paint() {
  const container = $('#library');
  if (!container) return;
  const search = library.query.toLocaleLowerCase().trim();
  const assets = library.assets.filter((asset) => asset.filename.toLocaleLowerCase().includes(search));
  const drafts = library.drafts.filter((draft) => !draft.assetId && draft.filename.toLocaleLowerCase().includes(search));
  const finished = library.uploads.length && library.uploads.every((entry) => !['waiting', 'uploading'].includes(entry.status));
  container.innerHTML = `<div class="library-head"><p class="library-hint">${archived() ? 'This project is archived. Its files stay readable and downloadable.' : 'Upload any file or write a document. Frameboard keeps the exact original and every saved version.'}</p>
      <div class="library-tools"><label class="search">${icon('search')}<input id="library-search" type="search" placeholder="Find a file…" aria-label="Find a file" value="${escape(library.query)}"></label>
      ${archived() ? '' : `${button('library-write', 'Write document', 'edit', 'button secondary')}<label class="button primary library-pick">${icon('upload')}Upload files<input id="library-files" type="file" multiple></label>`}</div></div>
    ${library.uploads.length ? `<section class="library-uploads" aria-label="Uploads"><div class="library-uploads-head"><h2>Uploads</h2>${finished ? button('library-clear-uploads', 'Clear', null, 'button small secondary') : ''}</div><ul>${library.uploads.map(uploadMarkup).join('')}</ul></section>` : ''}
    ${library.error ? `<p class="library-error" role="alert">${escape(library.error)}</p>` : ''}
    <div class="library-drop" data-library-drop>${!library.loaded && !library.error ? '<p class="library-empty">Loading files…</p>'
      : assets.length || drafts.length ? `<ul class="library-grid">${drafts.map(draftMarkup).join('')}${assets.map(assetMarkup).join('')}</ul>`
        : `<div class="library-empty">${icon(search ? 'search' : 'upload')}<p>${search ? 'No matching files' : 'No files yet'}</p><span>${search ? 'Try another search.' : archived() ? '' : 'Drop files here or choose Upload files.'}</span></div>`}</div>`;
}

// Uploads stream the File itself, so large files never load into memory.
function send(entry) {
  const query = new URLSearchParams({ filename: entry.filename, operation: entry.operation });
  if (entry.collision) query.set('collision', entry.collision);
  if (entry.assetId) query.set('asset', entry.assetId);
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base(entry.projectId)}/uploads?${query}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      entry.progress = event.lengthComputable ? event.loaded / event.total : 0;
      const state = document.querySelector(`[data-upload="${entry.id}"] .library-upload-state`);
      if (state) state.textContent = uploadState.uploading(entry);
    };
    xhr.onload = () => { let body = {}; try { body = JSON.parse(xhr.responseText); } catch { /* Reported below. */ } resolve({ status: xhr.status, body }); };
    xhr.onerror = () => resolve({ status: 0, body: { error: 'The upload was interrupted. Retry to send the same file again.' } });
    xhr.send(entry.file);
  });
}
// Create new is the default; Replace saves a new version of the file holding the name.
function chooseCollision(conflict, holder, skip = 'Skip this file.') {
  return new Promise((resolve) => {
    let choice = 'cancel';
    const option = (value, label, detail, checked = false, disabled = false) => `<label class="collision-option"><input type="radio" name="collision" value="${value}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span>${label}<small>${escape(detail)}</small></span></label>`;
    smallForm({
      title: `A file named ${conflict.filename} already exists`,
      description: 'Library',
      fields: `<fieldset class="collision-options"><legend class="sr-only">What to do with this upload</legend>${option('create', 'Create new', `Saves as ${conflict.suggested} · a separate file`, true)}${option('replace', 'Replace', holder ? `Saves v${holder.current.number + 1} of ${conflict.filename}; older versions are kept.` : 'The file with this name is still uploading.', false, !holder)}${option('cancel', 'Cancel', skip)}</fieldset>`,
      submit: 'Continue',
      onSubmit: (data) => { choice = data.get('collision'); },
    });
    $('#form-dialog').addEventListener('close', () => resolve(choice), { once: true });
  });
}

async function upload(entry) {
  // Asking before sending avoids streaming a large file only to be refused.
  let conflict = !entry.collision && nameConflict(entry.filename, library.assets);
  for (;;) {
    if (conflict) {
      entry.status = 'waiting'; paint();
      const choice = await chooseCollision(conflict, library.assets.find((asset) => asset.id === conflict.assetId));
      if (choice === 'cancel') { entry.status = 'cancelled'; return; }
      Object.assign(entry, { collision: choice, assetId: choice === 'replace' ? conflict.assetId : undefined });
      conflict = null;
    }
    entry.status = 'uploading'; entry.progress = 0; paint();
    const { status, body } = await send(entry);
    if (status === 201) {
      entry.status = 'saved';
      entry.message = body.outcome === 'replaced' ? `Replaced · v${body.version.number}` : body.asset.filename === entry.filename ? 'Saved' : `Saved as ${body.asset.filename}`;
      return;
    }
    // The name was taken meanwhile, perhaps in another tab: nothing was saved, so ask.
    if (status === 409 && body.conflict && !entry.collision) { await load(); conflict = body.conflict; continue; }
    // Retrying repeats the same operation and choice, so a saved file is never duplicated.
    Object.assign(entry, { status: 'failed', error: body.error || 'The upload failed.', retryable: status === 0 || status >= 500 });
    return;
  }
}
// One file at a time; each keeps its own success or failure.
let uploading = Promise.resolve();
const enqueue = (entries) => {
  uploading = uploading.then(async () => {
    for (const entry of entries.filter((item) => item.status === 'waiting')) {
      if (library.projectId !== entry.projectId) { entry.status = 'cancelled'; continue; }
      await load();
      await upload(entry);
      await load();
      paint();
    }
  });
  return uploading;
};
export function uploadLibraryFiles(files) {
  if (archived()) return toast('Unarchive this project to upload files.');
  const projectId = library.projectId;
  const entries = [...files].map((file) => {
    const entry = { id: id(), file, projectId, operation: id(), status: 'waiting' };
    try { entry.filename = libraryFilename(file.name); } catch (error) { Object.assign(entry, { status: 'failed', error: error.message }); }
    return entry;
  });
  library.uploads.push(...entries);
  paint();
  return enqueue(entries);
}

async function preview(asset) {
  const node = $('#library-preview', dialog);
  const type = assetPreview(asset);
  if (!asset.current.available) { node.innerHTML = '<p class="library-preview-note">This version’s bytes are unavailable. Repair it with the exact original file below.</p>'; return; }
  if (type?.kind === 'image') { node.innerHTML = `<img src="${contentURL(asset.current.id, true)}" alt="${escape(asset.filename)}">`; return; }
  if (type?.kind !== 'text') { node.innerHTML = '<p class="library-preview-note">No preview for this file type. Download it to open the exact original.</p>'; return; }
  try {
    const response = await fetch(contentURL(asset.current.id, true));
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not load the preview.');
    // Reads only the start of a long file, then stops the download.
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    while (size < previewBytes) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; }
    await reader.cancel();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const text = new TextDecoder().decode(bytes.subarray(0, previewBytes));
    if (inspected?.id !== asset.id) return;
    node.innerHTML = `<pre>${escape(text)}</pre>${asset.current.size > previewBytes ? '<p class="library-preview-note">Showing the first 64 KB.</p>' : ''}`;
  } catch (error) { node.innerHTML = `<p class="library-preview-note">${escape(error.message)}</p>`; }
}
function versionMarkup(version) {
  return `<li class="library-version ${version.available ? '' : 'unavailable'}"><div><strong>v${version.number}</strong>${version.current ? ' <span class="library-badge">Current</span>' : ''}${version.available ? '' : ' <span class="library-badge danger">Unavailable</span>'}
    <small>${formatSize(version.size)} · ${escape(savedAt(version.committedAt))}</small><small class="library-hash" title="SHA-256">${escape(version.hash)}</small>${version.available ? '' : `<small class="library-version-error">${escape(version.error)}</small>`}</div>
    <div class="library-version-actions">${version.available ? `<a class="button small secondary" href="${contentURL(version.id)}" download>${icon('download')}Download</a>` : ''}${button('library-verify', 'Check bytes', null, 'button small secondary', `data-id="${version.id}"`)}${!version.available && !archived() ? `<label class="button small secondary">Repair…<input type="file" data-repair="${version.id}" hidden></label>` : ''}</div></li>`;
}
async function inspect(assetId) {
  try { inspected = await request(`${base()}/assets/${encodeURIComponent(assetId)}`); } catch (error) { inspected = null; return toast(error.message); }
  const asset = inspected; const draft = draftFor(asset);
  dialog.innerHTML = `<div class="library-inspector"><div class="small-dialog-header"><h2 id="library-heading">${escape(asset.filename)}</h2>${iconButton('library-close', 'Close file details', 'close')}</div>
    <p class="library-preview-label">Saved v${asset.current.number}${draft ? ' · <span class="library-badge draft">Unsaved draft</span> Prompts and downloads use the saved version until you save the draft.' : ''}</p>
    <div id="library-preview" class="library-preview"></div>
    <div class="library-actions">${asset.current.available ? `<a class="button primary" href="${contentURL(asset.current.id)}" download>${icon('download')}Download v${asset.current.number}</a>` : ''}${editable(asset) && (draft || !archived()) ? button(draft ? 'library-edit-draft' : 'library-edit', draft ? 'Continue draft' : 'Edit', 'edit', 'button secondary', draft ? `data-id="${escape(draft.id)}"` : `data-id="${escape(asset.id)}"`) : ''}${archived() ? '' : `<label class="button secondary">${icon('upload')}Replace…<input type="file" id="library-replace" hidden></label>`}</div>
    <h3 class="library-versions-heading">Versions</h3><ul class="library-versions">${asset.versions.map(versionMarkup).join('')}</ul></div>`;
  if (!dialog.open) dialog.showModal();
  void preview(asset);
}
async function refreshInspected() {
  if (dialog.open && inspected) await inspect(inspected.id);
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action^="library-"]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'library-inspect') void inspect(target.dataset.id);
  if (action === 'library-close') dialog.close();
  if (action === 'library-write') void startDraft({ filename: libraryFilename(availableName('Untitled.md')), text: '' });
  if (action === 'library-edit') void startDraft({ assetId: target.dataset.id });
  if (action === 'library-edit-draft') void openDraft(target.dataset.id);
  if (action === 'library-save-draft') void saveDraft();
  if (action === 'library-discard-draft') discardDraft();
  if (action === 'library-keep-mine') void keepMine();
  if (action === 'library-load-theirs') void loadTheirs();
  if (action === 'library-clear-uploads') { library.uploads = library.uploads.filter((entry) => ['waiting', 'uploading'].includes(entry.status)); paint(); }
  if (action === 'library-retry-upload') {
    const entry = library.uploads.find((item) => item.id === target.dataset.id);
    if (entry) { entry.status = 'waiting'; paint(); void enqueue([entry]); }
  }
  if (action === 'library-verify') {
    target.disabled = true;
    try { await request(`${base()}/versions/${encodeURIComponent(target.dataset.id)}/verify`, { method: 'POST' }); toast('The recorded hash and size match.'); }
    catch (error) { toast(error.message); }
    await load(); paint(); await refreshInspected();
  }
});
document.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.id === 'library-files') { void uploadLibraryFiles(target.files); target.value = ''; }
  if (target.id === 'library-replace' && target.files[0] && inspected) {
    // Replace keeps this file's name and identity; the chosen file's own name is not used.
    const asset = inspected;
    const entry = { id: id(), file: target.files[0], projectId: library.projectId, operation: id(), status: 'waiting', filename: asset.filename, collision: 'replace', assetId: asset.id };
    target.value = '';
    dialog.close();
    library.uploads.push(entry); paint();
    void enqueue([entry]);
  }
  if (target.dataset.repair && target.files[0]) {
    try {
      await request(`${base()}/versions/${encodeURIComponent(target.dataset.repair)}/repair`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: target.files[0] });
      toast('Version repaired with its exact original bytes.');
    } catch (error) { toast(error.message); }
    target.value = '';
    await load(); paint(); await refreshInspected();
  }
});
document.addEventListener('input', (event) => {
  if (['library-draft-text', 'library-draft-name'].includes(event.target.id)) return draftInput();
  if (event.target.id !== 'library-search') return;
  library.query = event.target.value;
  paint();
  const input = $('#library-search');
  input.focus(); input.setSelectionRange(library.query.length, library.query.length);
});
// The close event arrives as a separate task: ignore it if the dialog was reopened first.
dialog.addEventListener('close', () => { if (dialog.open) return; inspected = null; if (editing) void closeEditor(); });
dialog.addEventListener('keydown', (event) => {
  if (editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveDraft(); }
});

// Another tab changed this project's Library.
export function libraryActivity(entry) {
  if (!['asset', 'library_draft'].includes(entry.entity) || entry.projectId !== library.projectId) return;
  void load().then(() => { paint(); });
}
export const hasLibraryUploads = () => library.uploads.some((entry) => ['waiting', 'uploading'].includes(entry.status)) || Boolean(editing && (editing.timer || editing.writing));


// --- Written documents -------------------------------------------------------
// The editor keeps a draft on the server as the user types (app data, included
// in backups). Save publishes exactly that kept text as a new retained version.
const draftURL = (draftId) => `${base()}/drafts${draftId ? `/${encodeURIComponent(draftId)}` : ''}`;
const availableName = (name) => nameConflict(name, [...library.assets, ...library.drafts])?.suggested ?? name;
async function call(method, url, body) {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).catch(() => null);
  if (!response) return { status: 0, body: { error: 'Frameboard could not be reached. Your draft is still here; try again.' } };
  let result = {};
  try { result = await response.json(); } catch { /* Reported below. */ }
  return { status: response.status, body: result };
}

async function startDraft(input) {
  if (archived()) return toast('Unarchive this project to write documents.');
  const { status, body } = await call('POST', draftURL(), input);
  if (status >= 300) return toast(body.error || 'Could not start the draft.');
  await load(); paint();
  edit(body);
}
async function openDraft(draftId) {
  try { edit(await request(draftURL(draftId))); } catch (error) { toast(error.message); await load(); paint(); }
}
function edit(draft) {
  editing = { draft, text: draft.text, filename: draft.filename, timer: null, writing: null, saving: false, notice: '', conflict: false, operation: null };
  inspected = null;
  renderEditor();
  if (!dialog.open) dialog.showModal();
  $('#library-draft-text').focus();
}
const savedAsset = () => editing.draft.assetId && library.assets.find((asset) => asset.id === editing.draft.assetId);
function draftState() {
  const asset = savedAsset();
  const saved = asset ? `Unsaved draft · the Library and downloads use saved v${asset.current.number}` : 'Unsaved draft · not in the Library until you save';
  return editing.notice || (editing.writing || editing.timer ? `${saved} · Keeping draft…` : saved);
}
function renderEditor() {
  const asset = savedAsset(); const locked = archived() || editing.saving;
  dialog.innerHTML = `<div class="library-editor"><div class="small-dialog-header"><h2 id="library-heading">${escape(asset ? asset.filename : 'New document')}</h2>${iconButton('library-close', 'Close document', 'close')}</div>
    ${asset ? '' : `<label class="form-label" for="library-draft-name">File name</label><input class="form-input" id="library-draft-name" value="${escape(editing.filename)}" maxlength="255" autocomplete="off" ${locked ? 'disabled' : ''}>`}
    <label class="sr-only" for="library-draft-text">Document text</label><textarea id="library-draft-text" class="library-draft-text" spellcheck="true" placeholder="Write or paste a guide, script or notes…" ${locked ? 'readonly' : ''}>${escape(editing.text)}</textarea>
    <p class="library-draft-state ${editing.notice ? 'notice' : ''}" role="status">${escape(draftState())}</p>
    ${editing.conflict ? `<div class="library-draft-conflict" role="alert"><span>This draft changed in another tab.</span>${button('library-load-theirs', 'Use the other tab’s text', null, 'button small secondary')}${button('library-keep-mine', 'Keep this text', null, 'button small secondary')}</div>` : ''}
    <div class="library-editor-footer">${asset?.current.available ? `<a class="text-button" href="${contentURL(asset.current.id)}" download>${icon('download')}Download saved v${asset.current.number}</a>` : '<span></span>'}
      <div>${archived() ? '' : `${button('library-discard-draft', 'Discard draft', null, 'button secondary', locked ? 'disabled' : '')}${button('library-save-draft', editing.saving ? 'Saving…' : 'Save', null, 'button primary', locked || editing.conflict ? 'disabled' : '')}`}</div></div></div>`;
}
function paintState() {
  const node = $('.library-draft-state', dialog);
  if (node) { node.textContent = draftState(); node.classList.toggle('notice', Boolean(editing.notice)); }
}

function draftInput() {
  if (!editing || editing.saving) return;
  editing.text = $('#library-draft-text').value;
  if ($('#library-draft-name')) editing.filename = $('#library-draft-name').value;
  editing.notice = '';
  clearTimeout(editing.timer);
  editing.timer = setTimeout(() => { editing.timer = null; void keep(); }, 500);
  paintState();
}
// Writes run one at a time; each names the revision it replaces.
function keep(current = editing) {
  if (!current || current.conflict) return Promise.resolve();
  clearTimeout(current.timer); current.timer = null;
  const prior = current.writing ?? Promise.resolve();
  const write = prior.then(async () => {
    if (current.conflict || (current.text === current.draft.text && current.filename === current.draft.filename)) return;
    const text = current.text; const filename = current.filename;
    let input;
    try { input = { text, revision: current.draft.revision, ...(current.draft.assetId ? {} : { filename: libraryFilename(filename) }) }; }
    catch (error) { current.notice = `Not kept: ${error.message}`; return; }
    const { status, body } = await call('PUT', draftURL(current.draft.id), input);
    if (status === 200) { current.draft = { ...body, text }; current.notice = ''; return; }
    if (status === 409 && body.conflict?.draftRevision) { current.conflict = true; return; }
    current.notice = `Draft not kept: ${body.error || 'try again.'} Keep this window open and type to retry.`;
  });
  current.writing = write;
  return write.finally(() => {
    if (current.writing === write) current.writing = null;
    if (editing !== current) return;
    if (current.conflict && !$('.library-draft-conflict', dialog)) renderEditor(); else paintState();
  });
}
async function keepMine() {
  try { editing.draft.revision = (await request(draftURL(editing.draft.id))).revision; } catch (error) { return toast(error.message); }
  editing.conflict = false; editing.draft.text = null;
  await keep(); renderEditor();
}
async function loadTheirs() {
  try { editing.draft = await request(draftURL(editing.draft.id)); } catch (error) { return toast(error.message); }
  Object.assign(editing, { text: editing.draft.text, filename: editing.draft.filename, conflict: false, notice: '' });
  renderEditor();
}

async function saveDraft(options = {}) {
  const current = editing;
  if (!current || current.saving || archived()) return;
  await keep();
  if (current.conflict || current.notice) return paintState();
  const asset = savedAsset();
  let choice = options.collision ? { collision: options.collision, asset: options.asset } : {};
  if (!asset && !options.collision) {
    await load();
    const conflict = nameConflict(current.draft.filename, library.assets);
    if (conflict) {
      const collision = await chooseCollision(conflict, library.assets.find((entry) => entry.id === conflict.assetId), 'Keep editing the draft.');
      if (collision === 'cancel') return;
      choice = { collision, asset: collision === 'replace' ? conflict.assetId : undefined };
    }
  }
  // Retrying the same kept text repeats one operation, so a save is never duplicated.
  const attempt = JSON.stringify([current.draft.revision, choice, options.baseVersionId ?? null]);
  if (current.operation?.attempt !== attempt) current.operation = { id: id(), attempt };
  current.saving = true; renderEditor();
  const { status, body } = await call('POST', `${draftURL(current.draft.id)}/save`, { revision: current.draft.revision, operation: current.operation.id, ...choice, baseVersionId: options.baseVersionId });
  current.saving = false;
  if (editing !== current) return;
  if (status === 200) {
    current.operation = null;
    toast(body.outcome === 'unchanged' ? `No changes to save; v${body.version.number} is current.` : `Saved ${body.asset.filename} · v${body.version.number}`);
    editing = null;
    await load(); paint();
    return inspect(body.asset.id);
  }
  if (status === 409 && body.conflict?.currentVersion) {
    current.notice = body.error; renderEditor();
    return confirmOverwrite(body.conflict.currentVersion, body.error);
  }
  // Someone took the name meanwhile: nothing was saved, so ask again.
  if (status === 409 && body.conflict?.assetId) { await load(); renderEditor(); return saveDraft(); }
  if (status === 409 && body.conflict?.draftRevision) { current.conflict = true; return renderEditor(); }
  const kept = asset ? ` Saved v${asset.current.number} is still current.` : '';
  current.notice = `Not saved: ${body.error || 'the save failed.'} Your draft is kept.${kept}`;
  renderEditor();
}
function confirmOverwrite(version, message) {
  smallForm({ title: 'A newer version was saved', description: `${message} Saving your draft adds v${version.number + 1}; v${version.number} and older versions are kept.`,
    submit: 'Save my draft anyway', onSubmit: () => { setTimeout(() => saveDraft({ baseVersionId: version.id })); } });
}
function discardDraft() {
  const current = editing;
  smallForm({ title: 'Discard this draft?', description: savedAsset() ? 'The saved version stays in the Library unchanged.' : 'This document has never been saved, so its text will be lost.', submit: 'Discard draft', danger: true,
    onSubmit: async () => {
      clearTimeout(current.timer); current.timer = null; current.conflict = true;
      await current.writing;
      await request(draftURL(current.draft.id), { method: 'DELETE' });
      if (editing === current) { editing = null; dialog.close(); }
      await load(); paint();
    } });
}
// Closing keeps any text typed since the last write.
async function closeEditor() {
  const current = editing;
  editing = null;
  if (current.timer) await keep(current);
  await load(); paint();
}
