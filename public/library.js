// The project Library tab: upload files, inspect and download their exact
// retained versions, and resolve name collisions explicitly.
import { $, escape, icon, button, iconButton, toast, smallForm, id } from './ui.js';
import { request } from './api.js';
import { availableFilename, libraryFilename, previewType } from './library-format.js';
import { project } from './state.js';

const dialog = $('#library-dialog');
const previewBytes = 64 * 1024;
const library = { projectId: null, assets: [], loaded: false, error: '', query: '', uploads: [] };
let inspected = null;

const base = (projectId = library.projectId) => `/api/projects/${encodeURIComponent(projectId)}/library`;
const contentURL = (versionId, inline = false) => `${base()}/versions/${encodeURIComponent(versionId)}/content${inline ? '?inline=1' : ''}`;
const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
export function formatSize(size) {
  let value = size; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit ? `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}` : `${size} ${size === 1 ? 'byte' : 'bytes'}`;
}
const savedAt = (value) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const extension = (filename) => { const dot = filename.lastIndexOf('.'); return dot > 0 ? filename.slice(dot + 1).slice(0, 5).toUpperCase() : 'FILE'; };
const archived = () => Boolean(project()?.archivedAt);

async function load() {
  const projectId = project()?.id;
  if (!projectId) return;
  if (library.projectId !== projectId) Object.assign(library, { projectId, assets: [], loaded: false, error: '', query: '', uploads: [] });
  try {
    const { assets } = await request(base(projectId));
    if (library.projectId !== projectId) return;
    Object.assign(library, { assets, loaded: true, error: '' });
  } catch (error) { library.error = error.message; }
}

export async function renderLibrary() {
  if (!$('#library')) return;
  if (library.projectId !== project()?.id || !library.loaded) { paint(); await load(); }
  paint();
}

function thumbnail(asset) {
  const preview = previewType(asset.filename);
  if (!asset.current.available) return `<div class="library-thumb unavailable">${icon('close')}<span>Unavailable</span></div>`;
  if (preview?.kind === 'image') return `<div class="library-thumb"><img src="${contentURL(asset.current.id, true)}" alt="" loading="lazy" draggable="false"></div>`;
  return `<div class="library-thumb file"><span>${escape(extension(asset.filename))}</span></div>`;
}
function assetMarkup(asset) {
  return `<li><button class="library-asset" data-action="library-inspect" data-id="${escape(asset.id)}" aria-label="Inspect ${escape(asset.filename)}">${thumbnail(asset)}
    <span class="library-name">${escape(asset.filename)}</span><span class="library-meta">v${asset.current.number} · ${formatSize(asset.current.size)}${asset.current.available ? '' : ' · <strong>Unavailable</strong>'}</span></button></li>`;
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
  const finished = library.uploads.length && library.uploads.every((entry) => !['waiting', 'uploading'].includes(entry.status));
  container.innerHTML = `<div class="library-head"><p class="library-hint">${archived() ? 'This project is archived. Its files stay readable and downloadable.' : 'Upload any file. Frameboard keeps the exact original and every version.'}</p>
      <div class="library-tools"><label class="search">${icon('search')}<input id="library-search" type="search" placeholder="Find a file…" aria-label="Find a file" value="${escape(library.query)}"></label>
      ${archived() ? '' : `<label class="button primary library-pick">${icon('upload')}Upload files<input id="library-files" type="file" multiple></label>`}</div></div>
    ${library.uploads.length ? `<section class="library-uploads" aria-label="Uploads"><div class="library-uploads-head"><h2>Uploads</h2>${finished ? button('library-clear-uploads', 'Clear', null, 'button small secondary') : ''}</div><ul>${library.uploads.map(uploadMarkup).join('')}</ul></section>` : ''}
    ${library.error ? `<p class="library-error" role="alert">${escape(library.error)}</p>` : ''}
    <div class="library-drop" data-library-drop>${!library.loaded && !library.error ? '<p class="library-empty">Loading files…</p>'
      : assets.length ? `<ul class="library-grid">${assets.map(assetMarkup).join('')}</ul>`
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
function chooseCollision(conflict, holder) {
  return new Promise((resolve) => {
    let choice = 'cancel';
    const option = (value, label, detail, checked = false, disabled = false) => `<label class="collision-option"><input type="radio" name="collision" value="${value}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span>${label}<small>${escape(detail)}</small></span></label>`;
    smallForm({
      title: `A file named ${conflict.filename} already exists`,
      description: 'Library',
      fields: `<fieldset class="collision-options"><legend class="sr-only">What to do with this upload</legend>${option('create', 'Create new', `Saves as ${conflict.suggested} · a separate file`, true)}${option('replace', 'Replace', holder ? `Saves v${holder.current.number + 1} of ${conflict.filename}; older versions are kept.` : 'The file with this name is still uploading.', false, !holder)}${option('cancel', 'Cancel', 'Skip this file.')}</fieldset>`,
      submit: 'Continue',
      onSubmit: (data) => { choice = data.get('collision'); },
    });
    $('#form-dialog').addEventListener('close', () => resolve(choice), { once: true });
  });
}

const conflictFor = (filename) => {
  const holder = library.assets.find((asset) => asset.filename === filename);
  return holder && { assetId: holder.id, filename, suggested: availableFilename(filename, library.assets.map((asset) => asset.filename)) };
};
async function upload(entry) {
  // Asking before sending avoids streaming a large file only to be refused.
  let conflict = !entry.collision && conflictFor(entry.filename);
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
let uploading = Promise.resolve();
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
  // One file at a time; each keeps its own success or failure.
  uploading = uploading.then(async () => {
    await load();
    for (const entry of entries.filter((item) => item.status === 'waiting')) {
      if (library.projectId !== projectId) { entry.status = 'cancelled'; continue; }
      await upload(entry);
      await load();
      paint();
    }
  });
  return uploading;
}

async function preview(asset) {
  const node = $('#library-preview', dialog);
  const type = previewType(asset.filename);
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
  const asset = inspected;
  dialog.innerHTML = `<div class="library-inspector"><div class="small-dialog-header"><h2 id="library-heading">${escape(asset.filename)}</h2>${iconButton('library-close', 'Close file details', 'close')}</div>
    <div id="library-preview" class="library-preview"></div>
    <div class="library-actions">${asset.current.available ? `<a class="button primary" href="${contentURL(asset.current.id)}" download>${icon('download')}Download</a>` : ''}${archived() ? '' : `<label class="button secondary">${icon('upload')}Replace…<input type="file" id="library-replace" hidden></label>`}</div>
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
  if (action === 'library-clear-uploads') { library.uploads = library.uploads.filter((entry) => ['waiting', 'uploading'].includes(entry.status)); paint(); }
  if (action === 'library-retry-upload') {
    const entry = library.uploads.find((item) => item.id === target.dataset.id);
    if (entry) { entry.status = 'waiting'; paint(); uploading = uploading.then(async () => { await upload(entry); await load(); paint(); }); }
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
    uploading = uploading.then(async () => { await upload(entry); await load(); paint(); });
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
  if (event.target.id !== 'library-search') return;
  library.query = event.target.value;
  paint();
  const input = $('#library-search');
  input.focus(); input.setSelectionRange(library.query.length, library.query.length);
});
dialog.addEventListener('close', () => { inspected = null; });

// Another tab changed this project's Library.
export function libraryActivity(entry) {
  if (entry.entity !== 'asset' || entry.projectId !== library.projectId) return;
  void load().then(() => { paint(); });
}
export const hasLibraryUploads = () => library.uploads.some((entry) => ['waiting', 'uploading'].includes(entry.status));
