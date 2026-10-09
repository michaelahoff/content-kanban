// The project Library: uploaded files with stable asset identities and
// immutable versions. Bytes live in retained storage; names are labels.
import { createHash } from 'node:crypto';
import { availableFilename, comparePaths, fileFormat, formatSampleBytes, libraryFilename, nameConflict, splitExtension, sourceKey } from './public/library-format.js';
import { libraryKinds } from './store-retained.js';
import { imageFormat } from './image-files.js';
import { rasterFormats, limits } from './submission-inputs.js';

const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
// Library text larger than any request can hold is delivered as a file.
const textProbeBytes = limits.certainTextBytes;
const utf8 = () => new TextDecoder('utf-8', { fatal: true });
async function collect(stream, limit = Infinity) {
  const chunks = []; let length = 0;
  try { for await (const chunk of stream) { chunks.push(chunk); length += chunk.length; if (length >= limit) break; } }
  finally { stream.destroy(); }
  return Buffer.concat(chunks);
}
// A supported raster image, UTF-8 text without NUL bytes, or any other file,
// named by its recognized format when it has one. A large file whose start
// reads as text is a file of format text.
function classify(bytes, size) {
  const format = imageFormat(bytes);
  if (rasterFormats.includes(format)) return { kind: 'image', format };
  const readable = !bytes.includes(0) && (() => { try { utf8().decode(bytes, { stream: size > textProbeBytes }); return true; } catch { return false; } })();
  if (readable && size <= textProbeBytes) return { kind: 'text', format: 'utf-8' };
  return { kind: 'file', format: format ?? fileFormat(bytes) ?? (readable ? 'text' : null) };
}
// Workspace copies are named by version, never by the filename label.
const copyPath = (file) => {
  const extension = file.kind === 'image' ? file.format : splitExtension(file.filename)[1].toLowerCase();
  return `references/library/${file.versionId}${/^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : ''}`;
};

// Written documents are UTF-8 text; larger files are edited elsewhere.
export const maxDocumentBytes = 4 * 1024 * 1024;
function documentText(value) {
  if (typeof value !== 'string') fail(400, 'Send the document text.');
  if (Buffer.byteLength(value, 'utf8') > maxDocumentBytes) fail(413, `Documents can be up to ${maxDocumentBytes / 1024 / 1024} MB. Upload larger files instead.`);
  return value;
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Written text keeps previewing as text when restored or copied.
const isWritten = (version) => version.provenance.method === 'document' || version.provenance.written === true;
// How each kind of publication names itself in retry refusals, and what it creates.
const publications = {
  upload: { noun: 'upload', retry: () => 'Upload it', again: (filename) => `Upload ${filename}`, kind: 'asset' },
  document: { noun: 'save', retry: () => 'Save', again: () => 'Save', kind: 'document' },
  copy: { noun: 'copy', retry: () => 'Copy it', again: () => 'Copy it' },
};
const savedOutcome = (provenance) => provenance.baseVersionId ? 'saved' : provenance.collision === 'replace' ? 'replaced' : 'created';

export function createLibrary({ retained, metadata, drafts, project, record }) {
  const numbered = (versions) => versions.map((version, index) => ({ id: version.id, size: version.size, hash: version.hash,
    available: version.available, error: version.error, committedAt: version.committedAt, number: index + 1, written: isWritten(version),
    ...(version.provenance.restoredFromVersionId ? { restoredFrom: version.provenance.restoredFromVersionId } : {}) }));
  function assetFrom(ctx, row) {
    const history = metadata.history(ctx, row.id); const versions = numbered(history);
    // A project copy names the source version it began from.
    const origin = history[0]?.provenance;
    return { id: row.id, projectId: row.project_id, filename: row.filename, folderId: row.folder_id, kind: row.kind, createdAt: row.created_at, removedAt: row.removed_at,
      current: versions.find((version) => version.id === row.current_version_id) ?? null, versionCount: versions.length,
      ...(origin?.method === 'copy' ? { copiedFrom: { projectId: origin.sourceProjectId, assetId: origin.sourceAssetId, versionId: origin.copiedFromVersionId } } : {}) };
  }
  const folderFrom = (row) => ({ id: row.id, name: row.name, parentId: row.parent_id, createdAt: row.created_at });
  // A live folder of this project.
  function liveFolder(ctx, projectId, folderId) {
    const row = typeof folderId === 'string' && metadata.folder(ctx, folderId);
    if (!row || row.project_id !== projectId || row.removed_at) fail(404, 'This Library folder does not exist.');
    return row;
  }
  // Where something is placed: a live folder, or null for the Library root.
  const destination = (ctx, projectId, folderId) => folderId === null ? null : liveFolder(ctx, projectId, folderId);
  // A committed Library source of this project; removed ones only for reading.
  function libraryAsset(ctx, projectId, assetId, { allowRemoved = false } = {}) {
    const row = typeof assetId === 'string' && metadata.object(ctx, assetId);
    if (!row || row.project_id !== projectId || !libraryKinds.includes(row.kind) || (row.removed_at && !allowRemoved) || !row.current_version_id) fail(404, 'This Library file does not exist.');
    return row;
  }
  // Names are unique among a folder's live files and subfolders, never merged.
  function requireFreeName(ctx, projectId, folderId, name, selfId) {
    if (metadata.names(ctx, projectId, folderId).some((entry) => entry.filename === name && entry.id !== selfId)) fail(409, `This folder already contains ${name}. Choose another name.`);
  }
  // A folder and its ancestors, from the root down, including removed folders.
  function chain(ctx, folderId) {
    const folders = [];
    for (let folder = folderId && metadata.folder(ctx, folderId); folder; folder = folder.parent_id && metadata.folder(ctx, folder.parent_id)) folders.unshift(folder);
    return folders;
  }
  // Folder labels, e.g. "Thumbnails/References/".
  const labels = (folders) => folders.map((folder) => `${folder.name}/`).join('');
  const folderPath = (ctx, folderId) => labels(chain(ctx, folderId));
  const has = (input, key) => Object.hasOwn(input ?? {}, key);
  const numberedVersion = (ctx, version) => numbered(metadata.history(ctx, version.objectId)).find((entry) => entry.id === version.id);
  function owned(ctx, projectId, versionId) {
    const version = metadata.version(ctx, versionId);
    const source = version && metadata.object(ctx, version.objectId);
    if (!source || source.project_id !== projectId || !libraryKinds.includes(source.kind) || version.state !== 'committed') fail(404, 'This Library file version does not exist.');
    return { version, source };
  }

  // A committed operation reported again, without new bytes.
  const savedResult = (ctx, outcome, prior) => ({ outcome, asset: assetFrom(ctx, metadata.object(ctx, prior.objectId)), version: numberedVersion(ctx, prior) });
  // A Save that committed but crashed before finishing its draft is finished here.
  function settle(ctx, projectId) {
    for (const draft of drafts.list(ctx, projectId)) {
      const saved = draft.saveOperationId && metadata.operation(ctx, draft.saveOperationId);
      if (saved?.state === 'committed') drafts.afterSave(ctx, projectId, draft.id, saved.provenance.revision, saved);
    }
  }
  // Where a publication lands in a folder (null: the root): a new asset, or by
  // explicit choice a new version of the asset holding its name there. A retry
  // repeats its operation's original choice exactly: a saved one is reported
  // again without new bytes, and an unfinished one follows its file wherever
  // it has moved since.
  // A copy is always a new file, so its conflicts offer no file to replace.
  function placement(ctx, projectId, { filename, folderId = null, collision = null, assetId, operationId, method, kind = publications[method].kind, prior = metadata.operation(ctx, operationId) }) {
    if (![null, 'create', 'replace'].includes(collision)) fail(400, 'Choose Create new or Replace for a name collision.');
    const outcome = collision === 'replace' ? 'replaced' : 'created';
    const publication = publications[method];
    if (prior) {
      const source = metadata.object(ctx, prior.objectId);
      if (source.project_id !== projectId || prior.provenance.method !== method || prior.provenance.requestedFilename !== filename || (prior.provenance.folderId ?? null) !== folderId
        || prior.provenance.collision !== collision || (collision === 'replace' && source.id !== assetId)) fail(409, `This ${publication.noun} was started for a different file. ${publication.retry()} again.`);
      const descriptor = { ...(collision === 'replace' ? { objectId: source.id } : {}), kind: source.kind, filename: prior.filename };
      if (prior.state !== 'committed' && source.removed_at) fail(409, `${source.filename} was removed. ${publication.again(filename)} again as a new file.`);
      // An interrupted first publication's name, perhaps a Create new suffix, may have been taken since.
      if (prior.state !== 'committed' && !descriptor.objectId && metadata.names(ctx, projectId, source.folder_id).some((entry) => entry.filename === prior.filename && entry.id !== source.id)) {
        fail(409, `Another file is named ${prior.filename} now. ${publication.again(filename)} again to choose.`);
      }
      return { prior, outcome, descriptor };
    }
    destination(ctx, projectId, folderId);
    const taken = metadata.names(ctx, projectId, folderId);
    const holder = taken.find((entry) => entry.filename === filename);
    const conflict = nameConflict(filename, taken);
    if (conflict && method === 'copy') delete conflict.assetId;
    if (collision === 'replace') {
      if (!holder?.committed || holder.id !== assetId) fail(409, holder ? `Another file is named ${filename} now. Choose again.` : `No file is named ${filename} any more. Save it as a new file.`, { conflict });
      return { outcome, descriptor: { objectId: holder.id, kind: metadata.object(ctx, holder.id).kind, filename } };
    }
    if (holder && collision !== 'create') fail(409, `A file named ${filename} already exists.`, { conflict });
    return { outcome, descriptor: { kind, filename: conflict?.suggested ?? filename, folderId } };
  }

  return {
    list(ctx, projectId) {
      project(ctx, projectId, { allowArchived: true });
      settle(ctx, projectId);
      return { folders: metadata.folders(ctx, projectId).map(folderFrom), assets: metadata.sources(ctx, projectId).map((row) => assetFrom(ctx, row)),
        drafts: drafts.list(ctx, projectId).map(({ text, ...draft }) => ({ ...draft, length: text.length })) };
    },
    createFolder(ctx, projectId, input) {
      return metadata.transaction(() => {
        project(ctx, projectId);
        const name = libraryFilename(input?.name, 'folder'); const parentId = input.parentId ?? null;
        destination(ctx, projectId, parentId);
        requireFreeName(ctx, projectId, parentId, name);
        const folder = folderFrom(metadata.createFolder(ctx, { projectId, parentId, name }));
        record(ctx, 'folder_created', folder.id, projectId, { name, parentId }, 'folder');
        return folder;
      });
    },
    // A dropped folder's path: each live same-named folder is reused, so a
    // retry finds the same folders. A file holding a name gets the first
    // suffixed folder name no file holds ("refs (1)").
    ensureFolders(ctx, projectId, input) {
      return metadata.transaction(() => {
        project(ctx, projectId);
        if (!Array.isArray(input?.names) || !input.names.length) fail(400, 'Name the folders to create.');
        const names = input.names.map((name) => libraryFilename(name, 'folder'));
        let folder = destination(ctx, projectId, input.parentId ?? null);
        for (const wanted of names) {
          const parentId = folder?.id ?? null; const taken = metadata.names(ctx, projectId, parentId);
          const files = taken.filter((entry) => entry.kind === 'asset').map((entry) => entry.filename);
          const name = availableFilename(wanted, files, { extension: false });
          const found = taken.find((entry) => entry.kind === 'folder' && entry.filename === name);
          if (found) { folder = metadata.folder(ctx, found.id); continue; }
          folder = metadata.createFolder(ctx, { projectId, parentId, name });
          record(ctx, 'folder_created', folder.id, projectId, { name, parentId }, 'folder');
        }
        return folderFrom(folder);
      });
    },
    // Rename and move keep the asset's identity and every version.
    updateAsset(ctx, projectId, assetId, input) {
      return metadata.transaction(() => {
        project(ctx, projectId);
        const row = libraryAsset(ctx, projectId, assetId);
        const filename = has(input, 'filename') ? libraryFilename(input.filename) : row.filename;
        const folderId = has(input, 'folderId') ? input.folderId ?? null : row.folder_id;
        destination(ctx, projectId, folderId);
        requireFreeName(ctx, projectId, folderId, filename, row.id);
        metadata.relocateAsset(ctx, row.id, { filename, folderId });
        record(ctx, folderId === row.folder_id ? 'asset_renamed' : 'asset_moved', row.id, projectId, { filename, folderId, from: { filename: row.filename, folderId: row.folder_id } });
        return assetFrom(ctx, metadata.object(ctx, row.id));
      });
    },
    // A folder moves with its contents, but never into itself or below.
    updateFolder(ctx, projectId, folderId, input) {
      return metadata.transaction(() => {
        project(ctx, projectId);
        const row = liveFolder(ctx, projectId, folderId);
        const name = has(input, 'name') ? libraryFilename(input.name, 'folder') : row.name;
        const parentId = has(input, 'parentId') ? input.parentId ?? null : row.parent_id;
        destination(ctx, projectId, parentId);
        if (chain(ctx, parentId).some((ancestor) => ancestor.id === row.id)) fail(409, 'A folder cannot move into itself.');
        requireFreeName(ctx, projectId, parentId, name, row.id);
        metadata.relocateFolder(ctx, row.id, { name, parentId });
        record(ctx, parentId === row.parent_id ? 'folder_renamed' : 'folder_moved', row.id, projectId, { name, parentId, from: { name: row.name, parentId: row.parent_id } }, 'folder');
        return folderFrom(metadata.folder(ctx, row.id));
      });
    },
    // Removal hides a source from future choices; every version stays readable.
    removeAsset(ctx, projectId, assetId) {
      metadata.transaction(() => {
        project(ctx, projectId);
        const row = libraryAsset(ctx, projectId, assetId);
        metadata.remove(ctx, row.id);
        record(ctx, 'asset_removed', row.id, projectId, { filename: row.filename, folderId: row.folder_id });
      });
      return { ok: true };
    },
    removeFolder(ctx, projectId, folderId) {
      metadata.transaction(() => {
        project(ctx, projectId);
        const row = liveFolder(ctx, projectId, folderId);
        const assets = metadata.removeFolder(ctx, row.id);
        record(ctx, 'folder_removed', row.id, projectId, { name: row.name, parentId: row.parent_id, assets }, 'folder');
      });
      return { ok: true };
    },
    removed(ctx, projectId) {
      project(ctx, projectId, { allowArchived: true });
      return { assets: metadata.removed(ctx, projectId).map((row) => ({ ...assetFrom(ctx, row), path: folderPath(ctx, row.folder_id) + row.filename })) };
    },
    // Collisions are folder-local. Without an explicit Create new or Replace
    // choice, a taken name is refused unread.
    async upload(ctx, projectId, input, source, { signal } = {}) {
      project(ctx, projectId);
      const filename = libraryFilename(input?.filename);
      const folderId = input.folderId ?? null;
      const { prior, descriptor, outcome } = placement(ctx, projectId, { ...input, filename, folderId, method: 'upload' });
      if (prior?.state === 'committed') return savedResult(ctx, outcome, prior);
      const version = await retained.publish(ctx, { operationId: input.operationId, projectId, ...descriptor,
        provenance: { method: 'upload', requestedFilename: filename, collision: input.collision ?? null, ...(folderId ? { folderId } : {}) } }, source, { signal });
      const asset = assetFrom(ctx, metadata.object(ctx, version.objectId));
      record(ctx, outcome === 'replaced' ? 'asset_replaced' : 'asset_uploaded', asset.id, projectId, { versionId: version.id, filename: asset.filename });
      return { outcome, asset, version: numberedVersion(ctx, version) };
    },
    // Write/paste: a new document starts empty or pasted; editing a saved text
    // file starts from its current version. Each asset has at most one draft.
    async createDraft(ctx, projectId, input = {}) {
      project(ctx, projectId);
      settle(ctx, projectId);
      if (!input.assetId) {
        const draft = drafts.create(ctx, { projectId, filename: libraryFilename(input.filename), text: documentText(input.text ?? '') });
        record(ctx, 'draft_created', draft.id, projectId, { filename: draft.filename }, 'library_draft');
        return draft;
      }
      const row = libraryAsset(ctx, projectId, input.assetId);
      const existing = () => drafts.forAsset(ctx, row.id);
      if (existing()) return existing();
      const current = metadata.version(ctx, row.current_version_id);
      if (current.size > maxDocumentBytes) fail(413, 'This file is too large to edit here. Download it to edit it elsewhere.');
      const stream = await retained.read(ctx, current.id);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await collect(stream)); }
      catch (error) { if (error.status) throw error; fail(422, 'This file is not UTF-8 text, so it cannot be edited here.'); }
      // Another request may have started this draft while the bytes were read.
      if (existing()) return existing();
      const draft = drafts.create(ctx, { projectId, assetId: row.id, baseVersionId: current.id, filename: row.filename, text });
      record(ctx, 'draft_created', draft.id, projectId, { assetId: row.id, filename: draft.filename }, 'library_draft');
      return draft;
    },
    draft(ctx, projectId, draftId) {
      project(ctx, projectId, { allowArchived: true });
      settle(ctx, projectId);
      return drafts.get(ctx, projectId, draftId);
    },
    // A draft edit is app data only: it never touches retained/current content.
    writeDraft(ctx, projectId, draftId, input = {}) {
      project(ctx, projectId);
      const draft = drafts.get(ctx, projectId, draftId);
      const filename = input.filename === undefined ? undefined : libraryFilename(input.filename);
      if (draft.assetId && filename !== undefined && filename !== draft.filename) fail(400, 'A saved file keeps its name while you edit it.');
      return drafts.write(ctx, projectId, draftId, { text: documentText(input.text), filename, revision: input.revision });
    },
    discardDraft(ctx, projectId, draftId) {
      project(ctx, projectId);
      drafts.remove(ctx, projectId, draftId);
      record(ctx, 'draft_discarded', draftId, projectId, {}, 'library_draft');
    },
    // Explicit Save publishes the draft's stored text at the revision the user
    // saw. A first save creates a document asset (or, by choice, a new version
    // of the file holding its name); later saves add versions of that asset.
    async saveDraft(ctx, projectId, draftId, input = {}, { signal } = {}) {
      project(ctx, projectId);
      const prior = metadata.operation(ctx, input.operationId);
      if (prior?.state === 'committed') {
        if (prior.provenance.method !== 'document' || prior.provenance.draftId !== draftId || metadata.object(ctx, prior.objectId).project_id !== projectId) fail(409, 'This save was started for a different draft. Save again.');
        const remaining = drafts.find(ctx, projectId, draftId) && drafts.afterSave(ctx, projectId, draftId, prior.provenance.revision, prior);
        return { outcome: savedOutcome(prior.provenance), asset: assetFrom(ctx, metadata.object(ctx, prior.objectId)), version: numberedVersion(ctx, prior), draft: remaining ?? null };
      }
      settle(ctx, projectId);
      const draft = drafts.get(ctx, projectId, draftId);
      if (draft.revision !== input.revision) fail(409, 'This draft changed in another tab. Review it, then save again.', { conflict: { draftRevision: draft.revision } });
      // One Save at a time per draft, so two tabs never publish it twice.
      const saving = draft.saveOperationId !== input.operationId && metadata.operation(ctx, draft.saveOperationId);
      if (saving && ['staging', 'published'].includes(saving.state)) fail(409, 'This draft is already being saved in another tab.');
      const bytes = Buffer.from(draft.text, 'utf8');
      let descriptor; let provenance;
      if (draft.assetId) {
        const row = libraryAsset(ctx, projectId, draft.assetId);
        const saved = metadata.version(ctx, row.current_version_id); const current = numberedVersion(ctx, saved);
        const base = input.baseVersionId ?? draft.baseVersionId;
        if (base !== current.id) fail(409, `v${current.number} of ${row.filename} was saved after this draft began.`, { conflict: { currentVersion: current } });
        if (sha256(bytes) === current.hash && bytes.length === current.size) {
          drafts.afterSave(ctx, projectId, draftId, draft.revision, saved);
          return { outcome: 'unchanged', asset: assetFrom(ctx, row), version: current, draft: null };
        }
        descriptor = { objectId: row.id, kind: row.kind, filename: row.filename };
        provenance = { method: 'document', draftId, revision: draft.revision, baseVersionId: base };
      } else {
        // New documents are saved at the Library root, then moved like any file.
        ({ descriptor } = placement(ctx, projectId, { ...input, filename: draft.filename, folderId: null, method: 'document', prior }));
        provenance = { method: 'document', draftId, revision: draft.revision, requestedFilename: draft.filename, collision: input.collision ?? null };
      }
      drafts.saving(ctx, projectId, draftId, input.operationId);
      let version;
      try { version = await retained.publish(ctx, { operationId: input.operationId, projectId, ...descriptor, provenance }, bytes, { signal }); }
      catch (error) {
        // Another save of this asset committed first: report the version that won.
        const current = draft.assetId && metadata.object(ctx, draft.assetId)?.current_version_id;
        if (current && current !== provenance.baseVersionId) {
          const winner = numberedVersion(ctx, metadata.version(ctx, current));
          fail(409, `v${winner.number} of ${descriptor.filename} was saved while this draft was saving.`, { conflict: { currentVersion: winner } });
        }
        throw error;
      }
      const remaining = drafts.afterSave(ctx, projectId, draftId, draft.revision, version);
      const asset = assetFrom(ctx, metadata.object(ctx, version.objectId));
      record(ctx, 'document_saved', asset.id, projectId, { versionId: version.id, filename: asset.filename });
      return { outcome: savedOutcome(provenance), asset, version: numberedVersion(ctx, version), draft: remaining };
    },
    asset(ctx, projectId, assetId) {
      project(ctx, projectId, { allowArchived: true });
      const row = libraryAsset(ctx, projectId, assetId, { allowRemoved: true });
      const versions = numbered(metadata.history(ctx, row.id)).map((version) => ({ ...version, current: version.id === row.current_version_id }));
      return { ...assetFrom(ctx, row), versions: versions.reverse() };
    },
    // A restore publishes an older version's verified bytes as a new current
    // version; every version in between, and every reference to one, stays.
    async restoreVersion(ctx, projectId, assetId, input = {}, { signal } = {}) {
      project(ctx, projectId);
      const prior = metadata.operation(ctx, input.operationId);
      if (prior?.state === 'committed') {
        if (prior.provenance.method !== 'restore' || prior.objectId !== assetId || prior.provenance.restoredFromVersionId !== input.versionId
          || metadata.object(ctx, prior.objectId).project_id !== projectId) fail(409, 'This restore was started for a different version. Restore again.');
        return savedResult(ctx, 'restored', prior);
      }
      const row = libraryAsset(ctx, projectId, assetId);
      const { version: older } = owned(ctx, projectId, input.versionId);
      if (older.objectId !== row.id) fail(404, 'This version does not belong to this Library file.');
      const current = numberedVersion(ctx, metadata.version(ctx, row.current_version_id));
      if (input.baseVersionId !== current.id) fail(409, `v${current.number} of ${row.filename} was saved after you looked. Review it, then restore again.`, { conflict: { currentVersion: current } });
      if (older.id === current.id) fail(409, `v${current.number} is already current.`);
      if (older.hash === current.hash && older.size === current.size) return { outcome: 'unchanged', asset: assetFrom(ctx, row), version: current };
      const provenance = { method: 'restore', restoredFromVersionId: older.id, baseVersionId: current.id, ...(isWritten(older) ? { written: true } : {}) };
      const stream = await retained.read(ctx, older.id);
      let version;
      try { version = await retained.publish(ctx, { operationId: input.operationId, projectId, objectId: row.id, kind: row.kind, filename: row.filename, provenance }, stream, { signal }); }
      finally { stream.destroy(); }
      const asset = assetFrom(ctx, metadata.object(ctx, row.id));
      record(ctx, 'asset_restored', asset.id, projectId, { versionId: version.id, restoredFromVersionId: older.id, filename: asset.filename });
      return { outcome: 'restored', asset, version: numberedVersion(ctx, version) };
    },
    // A project copy is a new asset in another project with independent bytes
    // of the source's current version only; nothing links their lifetimes.
    // A copy never replaces a destination file: a taken name needs Create new
    // or another name. A retry copies the version its operation began with.
    async copyAsset(ctx, projectId, assetId, input = {}, { signal } = {}) {
      project(ctx, projectId);
      const targetId = input.targetProjectId;
      if (typeof targetId !== 'string') fail(400, 'Choose the project to copy into.');
      project(ctx, targetId);
      if (targetId === projectId) fail(400, 'Choose another project to copy into.');
      if (input.collision === 'replace') fail(400, 'A copy is always a new file. Choose Create new or another name.');
      const filename = libraryFilename(input.filename); const folderId = input.folderId ?? null;
      const prior = metadata.operation(ctx, input.operationId);
      if (prior && (prior.provenance.sourceProjectId !== projectId || prior.provenance.sourceAssetId !== assetId)) fail(409, 'This copy was started for a different file. Copy it again.');
      // A saved copy is reported again even if its source was removed since.
      const row = libraryAsset(ctx, projectId, assetId, { allowRemoved: prior?.state === 'committed' });
      const placed = placement(ctx, targetId, { filename, folderId, collision: input.collision ?? null, operationId: input.operationId, method: 'copy', kind: row.kind, prior });
      if (prior?.state === 'committed') return savedResult(ctx, 'copied', prior);
      const { version: source } = owned(ctx, projectId, prior?.provenance.copiedFromVersionId ?? row.current_version_id);
      const provenance = { method: 'copy', requestedFilename: filename, collision: input.collision ?? null, ...(folderId ? { folderId } : {}),
        sourceProjectId: projectId, sourceAssetId: row.id, ...(isWritten(source) ? { written: true } : {}) };
      const version = await retained.copy(ctx, source.id, { operationId: input.operationId, projectId: targetId, ...placed.descriptor, provenance }, { signal });
      const asset = assetFrom(ctx, metadata.object(ctx, version.objectId));
      record(ctx, 'asset_copied', asset.id, targetId, { versionId: version.id, filename: asset.filename, from: { projectId, assetId: row.id, versionId: source.id } });
      return { outcome: 'copied', asset, version: numberedVersion(ctx, version) };
    },
    // Rechecks the recorded hash and size; failure marks only this version unavailable.
    async verify(ctx, projectId, versionId) {
      project(ctx, projectId, { allowArchived: true });
      const { version } = owned(ctx, projectId, versionId);
      (await retained.read(ctx, version.id)).destroy();
      return numberedVersion(ctx, version);
    },
    // Exact-byte repair keeps the version identity; other bytes need a new version.
    async repair(ctx, projectId, versionId, source, { signal } = {}) {
      project(ctx, projectId);
      const { version } = owned(ctx, projectId, versionId);
      await retained.repair(ctx, version.id, source, { signal });
      record(ctx, 'asset_repaired', version.objectId, projectId, { versionId: version.id });
      return numberedVersion(ctx, version);
    },
    // The current committed versions named by ordered typed selections: an
    // asset, or a folder expanded recursively over its live files in
    // relative-path order. One entry per asset identity, in first-selected
    // position, keeps every selection that named it (a folder's with its
    // captured path and the file's relative path). An unresolvable source is
    // reported by identity, never resolved empty or substituted by name; an
    // existing empty folder adds nothing. Resolved selections are returned in
    // order with their captured paths.
    resolve(ctx, projectId, selections) {
      const files = new Map(); const problems = []; const resolved = [];
      // Each folder's chain is read once per resolution, however many files share it.
      const chains = new Map();
      const chainOf = (folderId) => { if (!chains.has(folderId)) chains.set(folderId, chain(ctx, folderId)); return chains.get(folderId); };
      const pathOf = (folderId) => labels(chainOf(folderId));
      let live;
      // Why a source names nothing here: another project's source, or one of
      // the other kind, is reported as such and never matched by name.
      const unowned = (id, noun) => {
        const object = metadata.object(ctx, id); const folder = metadata.folder(ctx, id);
        const [kind, holder] = object && libraryKinds.includes(object.kind) ? ['file', object] : folder ? ['folder', folder] : [];
        if (!holder) return `It is not a ${noun} in this project’s Library.`;
        if (holder.project_id !== projectId) return `It is a ${kind} in another project’s Library. Choose one from this project; nothing is matched by name.`;
        return `It is a ${kind}, not a ${noun}. Select it as a ${kind}.`;
      };
      const include = (row, source) => {
        if (!files.has(row.id)) {
          const version = numberedVersion(ctx, metadata.version(ctx, row.current_version_id));
          files.set(row.id, { projectId, assetId: row.id, versionId: version.id, number: version.number, filename: row.filename, libraryPath: pathOf(row.folder_id) + row.filename,
            hash: version.hash, size: version.size, sources: [] });
        }
        files.get(row.id).sources.push(source);
      };
      for (const selection of selections) {
        const key = sourceKey(selection);
        if (selection.kind === 'folder') {
          const row = metadata.folder(ctx, selection.id);
          const owned = row && row.project_id === projectId;
          const reason = !owned ? unowned(selection.id, 'folder') : row.removed_at ? 'It was removed from the Library.' : null;
          if (reason) { problems.push({ key, label: owned ? pathOf(row.id) : key, phase: 'resolve', reason }); continue; }
          resolved.push({ kind: 'folder', id: row.id, path: pathOf(row.id) });
          live ??= metadata.sources(ctx, projectId);
          live.flatMap((asset) => {
            const folders = chainOf(asset.folder_id); const at = folders.findIndex((folder) => folder.id === row.id);
            return at < 0 ? [] : [{ asset, relativePath: labels(folders.slice(at + 1)) + asset.filename }];
          }).sort((a, b) => comparePaths(a.relativePath, b.relativePath))
            .forEach(({ asset, relativePath }) => include(asset, { kind: 'folder', id: row.id, folderPath: pathOf(row.id), relativePath }));
          continue;
        }
        const row = selection.kind === 'asset' ? metadata.object(ctx, selection.id) : null;
        const owned = row && row.project_id === projectId && libraryKinds.includes(row.kind);
        const reason = !owned ? unowned(selection.id, 'file') : row.removed_at ? 'It was removed from the Library.'
          : !row.current_version_id ? 'Its first upload has not finished.' : null;
        if (reason) { problems.push({ key, label: owned ? row.filename : key, phase: 'resolve', reason }); continue; }
        include(row, { kind: selection.kind, id: selection.id });
        resolved.push({ kind: 'asset', id: row.id, path: pathOf(row.folder_id) + row.filename });
      }
      return { files: [...files.values()], selections: resolved, problems };
    },
    // How a version can be delivered. Sends verify every byte; previews read
    // small files whole but only sample large ones, trusting their last check.
    async inspect(ctx, projectId, versionId, { verify = true } = {}) {
      const { version } = owned(ctx, projectId, versionId);
      if (verify || version.size <= textProbeBytes) return classify(await collect(await retained.read(ctx, version.id), version.size > textProbeBytes ? formatSampleBytes : Infinity), version.size);
      if (!version.available) fail(409, `Retained version ${version.id} is unavailable. ${version.error}`);
      return classify(await retained.peek(ctx, version.id, formatSampleBytes), version.size);
    },
    copyPath,
    // A frozen text version, read verified, for inline delivery.
    async text(ctx, projectId, versionId) {
      const { version } = owned(ctx, projectId, versionId);
      return utf8().decode(await collect(await retained.read(ctx, version.id)));
    },
    // An independent verified workspace copy of a frozen version.
    materialize(ctx, projectId, versionId, workspace, relative) {
      const { version } = owned(ctx, projectId, versionId);
      return retained.materialize(ctx, version.id, workspace, relative);
    },
    async read(ctx, projectId, versionId) {
      project(ctx, projectId, { allowArchived: true });
      const { version, source } = owned(ctx, projectId, versionId);
      return { version, filename: source.filename, written: isWritten(version), stream: await retained.read(ctx, version.id) };
    },
  };
}
