// The project Library tab: organize files in nested folders, upload files and
// folders or write documents, inspect and download their exact retained
// versions, and resolve name collisions explicitly. Rename, move and removal
// keep identities. Restoring an older version saves it as a new current one;
// a project copy is a separate file. Document drafts are kept as the user
// types; only Save publishes.
import { $, escape, icon, button, iconButton, toast, smallForm, id } from './ui.js';
import { request, send as sendJSON } from './api.js';
import { assetPreview, comparePaths, libraryFilename, libraryPaths, searchLibrary, folderHolders, nameConflict, splitExtension, sourceKey } from './library-format.js';
import { project, state } from './state.js';

const dialog = $('#library-dialog');
const previewBytes = 64 * 1024;
// folder is the open folder's ID; null is the Library root.
const library = { projectId: null, folders: [], assets: [], drafts: [], folder: null, loaded: false, error: '', query: '', uploads: [] };
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
// A picker's choices: the Library's folders and files by path, without the
// sources already chosen. A folder sends every file in it, in path order.
export function libraryChoices(listing, chosen) {
  const paths = libraryPaths(listing);
  return [
    ...listing.folders.map((folder) => ({ source: { kind: 'folder', id: folder.id }, label: paths.folders.get(folder.id), detail: 'folder · every file in it' })),
    ...listing.assets.map((asset) => ({ source: { kind: 'asset', id: asset.id }, label: paths.assets.get(asset.id), detail: `v${asset.current.number} · ${formatSize(asset.current.size)}${asset.current.available ? '' : ' · unavailable'}` })),
  ].filter((entry) => !chosen.has(sourceKey(entry.source))).sort((a, b) => comparePaths(a.label, b.label));
}
const savedAt = (value) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const extension = (filename) => splitExtension(filename)[1].slice(0, 5).toUpperCase() || 'FILE';
const archived = () => Boolean(project()?.archivedAt);

async function load() {
  const projectId = project()?.id;
  if (!projectId) return;
  if (library.projectId !== projectId) Object.assign(library, { projectId, folders: [], assets: [], drafts: [], folder: null, loaded: false, error: '', query: '', uploads: [] });
  try {
    const { folders, assets, drafts } = await request(base(projectId));
    if (library.projectId !== projectId) return;
    Object.assign(library, { folders, assets, drafts, loaded: true, error: '' });
    // The open folder was removed, perhaps in another tab.
    if (!folders.some((folder) => folder.id === library.folder)) library.folder = null;
  } catch (error) { library.error = error.message; }
}

export async function renderLibrary() {
  if (!$('#library')) return;
  if (library.projectId !== project()?.id || !library.loaded) { paint(); await load(); }
  paint();
}

const draftFor = (asset) => library.drafts.find((draft) => draft.assetId === asset.id);
// Text files and written documents open in the editor; the server checks the bytes are UTF-8.
const editable = (asset) => assetPreview(asset.filename, asset.current)?.kind === 'text';
function thumbnail(asset) {
  const preview = assetPreview(asset.filename, asset.current);
  if (!asset.current.available) return `<div class="library-thumb unavailable">${icon('close')}<span>Unavailable</span></div>`;
  if (preview?.kind === 'image') return `<div class="library-thumb"><img src="${contentURL(asset.current.id, true)}" alt="" loading="lazy" draggable="false"></div>`;
  return `<div class="library-thumb file"><span>${escape(extension(asset.filename))}</span></div>`;
}
const manage = (kind, item, name) => archived() ? '' : `<button type="button" class="library-manage" data-action="library-manage" data-kind="${kind}" data-id="${escape(item.id)}" aria-label="Manage ${escape(name)}" title="Rename, move or remove">${icon('more')}</button>`;
// While searching, a tile shows where it lives.
function assetMarkup(asset, path) {
  return `<li class="library-item"><button class="library-asset" data-action="library-inspect" data-id="${escape(asset.id)}" aria-label="Inspect ${escape(asset.filename)}">${thumbnail(asset)}
    <span class="library-name">${escape(asset.filename)}</span><span class="library-meta">${path ? `${escape(path)} · ` : ''}v${asset.current.number} · ${formatSize(asset.current.size)}${asset.current.available ? '' : ' · <strong>Unavailable</strong>'}${draftFor(asset) ? ' · <em>Draft</em>' : ''}</span></button>${manage('asset', asset, asset.filename)}</li>`;
}
function folderMarkup(folder, paths, path) {
  const files = library.assets.filter((asset) => paths.assets.get(asset.id).startsWith(paths.folders.get(folder.id))).length;
  return `<li class="library-item"><button class="library-asset library-folder" data-action="library-open-folder" data-id="${escape(folder.id)}" aria-label="Open folder ${escape(folder.name)}"><div class="library-thumb folder">${icon('folder')}</div>
    <span class="library-name">${escape(folder.name)}</span><span class="library-meta">${path ? `${escape(path)} · ` : ''}${files} ${files === 1 ? 'file' : 'files'}</span></button>${manage('folder', folder, folder.name)}</li>`;
}
function crumbs(paths) {
  const chain = [];
  for (let folder = library.folders.find((entry) => entry.id === library.folder); folder; folder = library.folders.find((entry) => entry.id === folder.parentId)) chain.unshift(folder);
  return `<nav class="library-crumbs" aria-label="Folder">${button('library-open-folder', 'Library', null, 'library-crumb', 'data-id=""')}${chain.map((folder) => `<span aria-hidden="true">/</span>${button('library-open-folder', escape(folder.name), null, 'library-crumb', `data-id="${escape(folder.id)}" title="${escape(paths.folders.get(folder.id))}"`)}`).join('')}</nav>`;
}
// A new document's draft is not a Library file until its first Save.
function draftMarkup(draft) {
  return `<li class="library-item"><button class="library-asset draft" data-action="library-edit-draft" data-id="${escape(draft.id)}" aria-label="Edit draft ${escape(draft.filename)}"><div class="library-thumb draft"><span>Draft</span></div>
    <span class="library-name">${escape(draft.filename)}</span><span class="library-meta">Unsaved draft</span></button></li>`;
}
const uploadState = {
  waiting: () => 'Waiting', uploading: (entry) => `Uploading ${Math.round((entry.progress || 0) * 100)}%`, cancelled: () => 'Cancelled',
  saved: (entry) => entry.message, failed: (entry) => entry.error,
};
function uploadMarkup(entry) {
  return `<li class="library-upload ${entry.status}" data-upload="${entry.id}"><span class="library-upload-name">${escape(entry.label)}</span>
    <span class="library-upload-state" role="status">${escape(uploadState[entry.status](entry))}</span>${entry.status === 'failed' && entry.retryable ? button('library-retry-upload', 'Retry', null, 'button small secondary', `data-id="${entry.id}"`) : ''}</li>`;
}
function paint() {
  const container = $('#library');
  if (!container) return;
  const search = library.query.trim();
  const paths = libraryPaths(library);
  // Search covers every folder and file path; otherwise show the open folder.
  const tiles = search
    ? searchLibrary(library, search).map((entry) => entry.kind === 'folder' ? folderMarkup(entry.item, paths, paths.folders.get(entry.item.parentId) || 'Library') : assetMarkup(entry.item, paths.folders.get(entry.item.folderId) || 'Library'))
    : [...library.folders.filter((folder) => folder.parentId === library.folder).map((folder) => folderMarkup(folder, paths)),
      ...library.assets.filter((asset) => asset.folderId === library.folder).map((asset) => assetMarkup(asset))];
  // A new document's draft is saved at the root, so it shows there and in search.
  const drafts = library.drafts.filter((draft) => !draft.assetId && (search ? draft.filename.toLocaleLowerCase().includes(search.toLocaleLowerCase()) : library.folder === null));
  const finished = library.uploads.length && library.uploads.every((entry) => !['waiting', 'uploading'].includes(entry.status));
  container.innerHTML = `<div class="library-head"><p class="library-hint">${archived() ? 'This project is archived. Its files stay readable and downloadable.' : 'Upload any file or folder, or write a document. Frameboard keeps the exact original and every saved version.'}</p>
      <div class="library-tools"><label class="search">${icon('search')}<input id="library-search" type="search" placeholder="Find a file or folder…" aria-label="Find a file or folder" value="${escape(library.query)}"></label>
      ${button('library-removed', 'Removed files', null, 'button secondary')}
      ${archived() ? '' : `${button('library-write', 'Write document', 'edit', 'button secondary')}${button('library-new-folder', 'New folder', 'folder', 'button secondary')}<label class="button secondary library-pick">${icon('folder')}Upload folder<input id="library-folder-files" type="file" webkitdirectory multiple></label>
      <label class="button primary library-pick">${icon('upload')}Upload files<input id="library-files" type="file" multiple></label>`}</div></div>
    ${library.uploads.length ? `<section class="library-uploads" aria-label="Uploads"><div class="library-uploads-head"><h2>Uploads</h2>${finished ? button('library-clear-uploads', 'Clear', null, 'button small secondary') : ''}</div><ul>${library.uploads.map(uploadMarkup).join('')}</ul></section>` : ''}
    ${library.error ? `<p class="library-error" role="alert">${escape(library.error)}</p>` : ''}
    ${search ? '' : crumbs(paths)}
    <div class="library-drop" data-library-drop>${!library.loaded && !library.error ? '<p class="library-empty">Loading files…</p>'
      : tiles.length || drafts.length ? `<ul class="library-grid">${drafts.map(draftMarkup).join('')}${tiles.join('')}</ul>`
        : `<div class="library-empty">${icon(search ? 'search' : 'upload')}<p>${search ? 'No matching files or folders' : library.folder ? 'This folder is empty' : 'No files yet'}</p><span>${search ? 'Try another search.' : archived() ? '' : 'Drop files or folders here, or choose Upload.'}</span></div>`}</div>`;
}

// Uploads stream the File itself, so large files never load into memory.
function send(entry) {
  const query = new URLSearchParams({ filename: entry.filename, operation: entry.operation });
  if (entry.folderId) query.set('folder', entry.folderId);
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
// Create new is the default; Replace saves a new version of the file holding
// the name. A copy is always a separate file, so it offers no Replace.
// An open form (such as Copy to project) closes before the question opens.
export async function chooseCollision(conflict, holder, skip = 'Skip this file.', { replace = true } = {}) {
  const form = $('#form-dialog');
  if (form.open) { const closed = new Promise((resolve) => form.addEventListener('close', resolve, { once: true })); form.close(); await closed; }
  return new Promise((resolve) => {
    let choice = 'cancel';
    const option = (value, label, detail, checked = false, disabled = false) => `<label class="collision-option"><input type="radio" name="collision" value="${value}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span>${label}<small>${escape(detail)}</small></span></label>`;
    smallForm({
      title: `A file named ${conflict.filename} already exists`,
      description: 'Library',
      fields: `<fieldset class="collision-options"><legend class="sr-only">What to do with this upload</legend>${option('create', 'Create new', `Saves as ${conflict.suggested} · a separate file`, true)}${!replace ? '' : option('replace', 'Replace', holder ? `Saves v${holder.current.number + 1} of ${conflict.filename}; older versions are kept.` : conflict.assetId ? 'The file with this name is still uploading.' : 'A folder has this name; only a file can be replaced.', false, !holder)}${option('cancel', 'Cancel', skip)}</fieldset>`,
      submit: 'Continue',
      onSubmit: (data) => { choice = data.get('collision'); },
    });
    $('#form-dialog').addEventListener('close', () => resolve(choice), { once: true });
  });
}

// A project's folders as <option>s in path order, after the Library root.
export function folderOptions(listing) {
  const paths = libraryPaths(listing);
  return [...listing.folders].sort((a, b) => comparePaths(paths.folders.get(a.id), paths.folders.get(b.id)))
    .map((entry) => `<option value="${escape(entry.id)}">${escape(paths.folders.get(entry.id))}</option>`).join('');
}
// Finds or creates a dropped folder path inside parentId; repeating it finds the same folders.
const ensureFolderPath = async (projectId, parentId, names) => (await sendJSON('POST', `${base(projectId)}/folders/paths`, { parentId, names })).id;
async function upload(entry) {
  // A dropped folder's files land in the same folders, found or created once
  // per path. A retry keeps the folder its first attempt chose.
  if (entry.folderId === undefined) {
    try { entry.folderId = entry.folderNames.length ? await ensureFolderPath(entry.projectId, entry.parentId, entry.folderNames) : entry.parentId; }
    catch (error) { Object.assign(entry, { status: 'failed', error: error.message, retryable: !error.status || error.status >= 500 }); return; }
    await load();
  }
  // Asking before sending avoids streaming a large file only to be refused.
  let conflict = !entry.collision && nameConflict(entry.filename, folderHolders(library, entry.folderId));
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
// Items carry a path relative to the open folder ("Thumbnails/refs/a.png").
// Each file publishes atomically with its own collision choice and retry;
// dropped folders holding no files are still created.
function uploadLibraryItems(items, folderPaths = []) {
  if (archived()) return toast('Unarchive this project to upload files.');
  const projectId = library.projectId; const parentId = library.folder;
  const entries = items.map(({ file, path }) => {
    const parts = path.split('/').filter(Boolean);
    const entry = { id: id(), file, label: parts.join('/'), projectId, parentId, operation: id(), status: 'waiting' };
    try { entry.filename = libraryFilename(parts.pop()); entry.folderNames = parts.map((name) => libraryFilename(name, 'folder')); }
    catch (error) { Object.assign(entry, { status: 'failed', error: error.message }); }
    return entry;
  });
  const empty = folderPaths.filter((folderPath) => !items.some((item) => item.path.startsWith(`${folderPath}/`)));
  if (empty.length) {
    uploading = uploading.then(async () => {
      for (const folderPath of empty) {
        try { await ensureFolderPath(projectId, parentId, folderPath.split('/')); }
        catch (error) { toast(`${folderPath}: ${error.message}`); }
      }
      await load(); paint();
    });
  }
  library.uploads.push(...entries);
  paint();
  return enqueue(entries);
}
export const uploadLibraryFiles = (files) => uploadLibraryItems([...files].map((file) => ({ file, path: file.webkitRelativePath || file.name })));
// Dropped folders are read recursively. Entries must be taken during the drop event.
export function dropLibraryItems(dataTransfer, files) {
  const entries = [...dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some((entry) => entry.isDirectory)) return uploadLibraryFiles(files);
  const items = []; const folderPaths = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) { items.push({ file: await new Promise((resolve, reject) => entry.file(resolve, reject)), path: prefix + entry.name }); return; }
    folderPaths.push(prefix + entry.name);
    const reader = entry.createReader();
    for (let batch; (batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))).length;) {
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  return (async () => {
    try { for (const entry of entries) await walk(entry, ''); }
    catch (error) { return toast(`Could not read the dropped folder. ${error.message}`); }
    return uploadLibraryItems(items, folderPaths);
  })();
}

async function preview(asset) {
  const node = $('#library-preview', dialog);
  const type = assetPreview(asset.filename, asset.current);
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
function versionMarkup(version, asset) {
  const restoredFrom = version.restoredFrom && asset.versions.find((entry) => entry.id === version.restoredFrom);
  const restorable = !version.current && version.available && !archived() && !asset.removedAt;
  return `<li class="library-version ${version.available ? '' : 'unavailable'}"><div><strong>v${version.number}</strong>${version.current ? ' <span class="library-badge">Current</span>' : ''}${version.available ? '' : ' <span class="library-badge danger">Unavailable</span>'}
    <small>${formatSize(version.size)} · ${escape(savedAt(version.committedAt))}${restoredFrom ? ` · restored from v${restoredFrom.number}` : ''}</small><small class="library-hash" title="SHA-256">${escape(version.hash)}</small>${version.available ? '' : `<small class="library-version-error">${escape(version.error)}</small>`}</div>
    <div class="library-version-actions">${version.available ? `<a class="button small secondary" href="${contentURL(version.id)}" download>${icon('download')}Download</a>` : ''}${restorable ? button('library-restore', 'Restore', null, 'button small secondary', `data-id="${version.id}"`) : ''}${button('library-verify', 'Check bytes', null, 'button small secondary', `data-id="${version.id}"`)}${!version.available && !archived() ? `<label class="button small secondary">Repair…<input type="file" data-repair="${version.id}" hidden></label>` : ''}</div></li>`;
}
async function inspect(assetId) {
  try { inspected = await request(`${base()}/assets/${encodeURIComponent(assetId)}`); } catch (error) { inspected = null; return toast(error.message); }
  const asset = inspected; const draft = draftFor(asset); const removed = Boolean(asset.removedAt);
  const location = removed ? 'Removed from the Library. Every version is kept.' : libraryPaths(library).folders.get(asset.folderId) || 'Library';
  dialog.innerHTML = `<div class="library-inspector"><div class="small-dialog-header"><h2 id="library-heading">${escape(asset.filename)}</h2>${iconButton('library-close', 'Close file details', 'close')}</div>
    <p class="library-location">${removed ? '<span class="library-badge danger">Removed</span> ' : ''}${escape(location)}${asset.copiedFrom ? ` · copied from ${escape(projectName(asset.copiedFrom.projectId))}` : ''}</p>
    <p class="library-preview-label">Saved v${asset.current.number}${draft ? ' · <span class="library-badge draft">Unsaved draft</span> Prompts and downloads use the saved version until you save the draft.' : ''}</p>
    <div id="library-preview" class="library-preview"></div>
    <div class="library-actions">${asset.current.available ? `<a class="button primary" href="${contentURL(asset.current.id)}" download>${icon('download')}Download v${asset.current.number}</a>` : ''}${!removed && editable(asset) && (draft || !archived()) ? button(draft ? 'library-edit-draft' : 'library-edit', draft ? 'Continue draft' : 'Edit', 'edit', 'button secondary', draft ? `data-id="${escape(draft.id)}"` : `data-id="${escape(asset.id)}"`) : ''}${archived() || removed ? '' : `<label class="button secondary">${icon('upload')}Replace…<input type="file" id="library-replace" hidden></label>${button('library-copy', 'Copy to project…', null, 'button secondary')}`}</div>
    <h3 class="library-versions-heading">Versions</h3><ul class="library-versions">${asset.versions.map((version) => versionMarkup(version, asset)).join('')}</ul></div>`;
  if (!dialog.open) dialog.showModal();
  void preview(asset);
}
async function refreshInspected() {
  if (dialog.open && inspected) await inspect(inspected.id);
}

// Removed files stay inspectable and downloadable, but are never offered again.
async function showRemoved() {
  let assets;
  try { ({ assets } = await request(`${base()}/removed`)); } catch (error) { return toast(error.message); }
  inspected = null;
  dialog.innerHTML = `<div class="library-inspector"><div class="small-dialog-header"><h2 id="library-heading">Removed files</h2>${iconButton('library-close', 'Close removed files', 'close')}</div>
    <p class="library-location">Removed files are kept with every version, and work already queued keeps what it captured. They are never offered again.</p>
    ${assets.length ? `<ul class="library-versions">${assets.map((asset) => `<li class="library-version"><div><strong>${escape(asset.path)}</strong><small>${asset.versionCount} ${asset.versionCount === 1 ? 'version' : 'versions'} · removed ${escape(savedAt(asset.removedAt))}</small></div>
      <div class="library-version-actions">${button('library-inspect', 'Inspect', null, 'button small secondary', `data-id="${escape(asset.id)}"`)}</div></li>`).join('')}</ul>` : '<p class="library-preview-note">No removed files.</p>'}</div>`;
  if (!dialog.open) dialog.showModal();
}

const projectName = (projectId) => state.projects.find((entry) => entry.id === projectId)?.name ?? 'another project';
// Restoring saves the older content as a new current version; every version stays.
function restore(versionId) {
  const asset = inspected; const version = asset?.versions.find((entry) => entry.id === versionId);
  if (!version) return;
  // One operation per confirmation, so resubmitting after a failure never saves twice.
  const operation = id();
  smallForm({
    title: `Restore v${version.number} of ${asset.filename}?`, submit: 'Restore',
    description: `Saves v${asset.current.number + 1} with the content of v${version.number}. Every version is kept, and work already queued keeps what it captured.`,
    onSubmit: async () => {
      const result = await sendJSON('POST', `${base()}/assets/${encodeURIComponent(asset.id)}/restore`, { versionId, baseVersionId: asset.current.id, operation });
      toast(result.outcome === 'unchanged' ? `v${result.version.number} already has this content.` : `Saved v${result.version.number} from v${version.number}.`);
      await reload(); await refreshInspected();
    },
  });
}
// A project copy is a new, separate file holding only the current version;
// it keeps nothing of the source's history and outlives its removal.
function copyToProject() {
  const asset = inspected;
  const targets = state.projects.filter((entry) => entry.id !== library.projectId && !entry.archivedAt);
  if (!asset) return;
  if (!targets.length) return toast('Create another active project to copy into.');
  const operation = id();
  smallForm({
    title: `Copy ${asset.filename} to another project`, submit: 'Copy',
    description: `Copies v${asset.current.number} only, as a separate file with its own history.`,
    fields: `<label class="form-label" for="library-copy-project">Project</label><select class="form-input" id="library-copy-project" name="project">${targets.map((entry) => `<option value="${escape(entry.id)}">${escape(entry.name)}</option>`).join('')}</select>
      <label class="form-label" for="library-copy-folder">Folder</label><select class="form-input" id="library-copy-folder" name="folder"><option value="">Library</option></select>
      ${nameInput('Filename', asset.filename)}`,
    onSubmit: async (data) => {
      const body = { targetProjectId: data.get('project'), folderId: data.get('folder') || null, filename: data.get('name'), operation };
      const url = `${base()}/assets/${encodeURIComponent(asset.id)}/copy`;
      let result = await call('POST', url, body);
      if (result.status === 409 && result.body.conflict) {
        const choice = await chooseCollision(result.body.conflict, null, 'Copy nothing.', { replace: false });
        if (choice !== 'create') return;
        result = await call('POST', url, { ...body, collision: 'create' });
      }
      if (result.status !== 201) throw new Error(result.body.error || 'Could not copy this file.');
      toast(`Copied to ${projectName(body.targetProjectId)} as ${result.body.asset.filename}.`);
    },
  });
  const projectSelect = $('#library-copy-project'); const folderSelect = $('#library-copy-folder');
  const folders = async () => {
    const projectId = projectSelect.value;
    folderSelect.innerHTML = '<option value="">Library</option>';
    try {
      const listing = await request(base(projectId));
      if (projectSelect.value !== projectId) return;
      folderSelect.innerHTML += folderOptions(listing);
    } catch (error) { toast(error.message); }
  };
  projectSelect.addEventListener('change', folders);
  void folders();
}
const nameInput = (label, value = '') => `<label class="form-label" for="name-input">${label}</label><input class="form-input" id="name-input" name="name" value="${escape(value)}" maxlength="255" required autocomplete="off">`;
const reload = async () => { await load(); paint(); };
function newFolder() {
  const parentId = library.folder;
  smallForm({ title: 'New folder', description: `Inside ${libraryPaths(library).folders.get(parentId) || 'Library'}`, fields: nameInput('Folder name'), submit: 'Create folder',
    onSubmit: async (data) => { await sendJSON('POST', `${base()}/folders`, { name: data.get('name'), parentId }); await reload(); } });
}
const libraryItem = (kind, itemId) => (kind === 'folder' ? library.folders : library.assets).find((entry) => entry.id === itemId);
// Rename and move in one form; a name taken in the destination is refused, never merged.
function organize(kind, itemId) {
  const folder = kind === 'folder'; const item = libraryItem(kind, itemId);
  if (!item) return;
  const paths = libraryPaths(library); const name = folder ? item.name : item.filename; const current = folder ? item.parentId : item.folderId;
  // A folder cannot move into itself or anything inside it.
  const targets = library.folders.filter((entry) => !folder || !paths.folders.get(entry.id).startsWith(paths.folders.get(item.id)))
    .sort((a, b) => comparePaths(paths.folders.get(a.id), paths.folders.get(b.id)));
  smallForm({
    title: `Organize ${name}`, description: 'Renaming or moving keeps its identity and every version.',
    fields: `${nameInput(folder ? 'Folder name' : 'Filename', name)}<label class="form-label" for="library-destination">Location</label><select class="form-input" id="library-destination" name="destination">
      <option value="">Library</option>${targets.map((entry) => `<option value="${escape(entry.id)}" ${entry.id === current ? 'selected' : ''}>${escape(paths.folders.get(entry.id))}</option>`).join('')}</select>`,
    submit: 'Save',
    extra: button('library-remove', 'Remove…', 'trash', 'button secondary library-remove', `data-kind="${kind}" data-id="${escape(item.id)}"`),
    onSubmit: async (data) => {
      const destination = data.get('destination') || null;
      await sendJSON('PATCH', `${base()}/${folder ? 'folders' : 'assets'}/${encodeURIComponent(item.id)}`, folder ? { name: data.get('name'), parentId: destination } : { filename: data.get('name'), folderId: destination });
      await reload();
    },
  });
}
function remove(kind, itemId) {
  const folder = kind === 'folder'; const item = libraryItem(kind, itemId);
  if (!item) return;
  smallForm({
    title: `Remove ${folder ? item.name : item.filename}?`, submit: 'Remove', danger: true,
    description: `${folder ? 'This folder and everything in it will' : 'This file will'} no longer be offered for new work. Every version stays retained, and work already queued keeps what it captured. Remembered selections of ${folder ? 'it' : 'this file'} need correcting.`,
    onSubmit: async () => { await sendJSON('DELETE', `${base()}/${folder ? 'folders' : 'assets'}/${encodeURIComponent(item.id)}`); await reload(); },
  });
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
  if (action === 'library-open-folder') { library.folder = target.dataset.id || null; library.query = ''; paint(); }
  if (action === 'library-new-folder') newFolder();
  if (action === 'library-manage') organize(target.dataset.kind, target.dataset.id);
  if (action === 'library-remove') remove(target.dataset.kind, target.dataset.id);
  if (action === 'library-removed') void showRemoved();
  if (action === 'library-restore') restore(target.dataset.id);
  if (action === 'library-copy') copyToProject();
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
  if (target.id === 'library-files' || target.id === 'library-folder-files') { void uploadLibraryFiles(target.files); target.value = ''; }
  if (target.id === 'library-replace' && target.files[0] && inspected) {
    // Replace keeps this file's name and identity; the chosen file's own name is not used.
    const asset = inspected;
    const entry = { id: id(), file: target.files[0], label: asset.filename, projectId: library.projectId, operation: id(), status: 'waiting', filename: asset.filename, folderId: asset.folderId, collision: 'replace', assetId: asset.id };
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
  if (!['asset', 'folder', 'library_draft'].includes(entry.entity) || entry.projectId !== library.projectId) return;
  void load().then(() => { paint(); });
}
export const hasLibraryUploads = () => library.uploads.some((entry) => ['waiting', 'uploading'].includes(entry.status)) || Boolean(editing && (editing.timer || editing.writing));


// --- Written documents -------------------------------------------------------
// The editor keeps a draft on the server as the user types (app data, included
// in backups). Save publishes exactly that kept text as a new retained version.
const draftURL = (draftId) => `${base()}/drafts${draftId ? `/${encodeURIComponent(draftId)}` : ''}`;
// New documents are saved at the Library root.
const availableName = (name) => nameConflict(name, [...folderHolders(library, null), ...library.drafts])?.suggested ?? name;
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
    const conflict = nameConflict(current.draft.filename, folderHolders(library, null));
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
