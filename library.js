// The project Library: uploaded files with stable asset identities and
// immutable versions. Bytes live in retained storage; names are labels.
import { createHash } from 'node:crypto';
import { libraryFilename, nameConflict, splitExtension, sourceKey } from './public/library-format.js';
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
// A supported raster image, UTF-8 text without NUL bytes, or any other file.
// A large file whose start reads as text is a file of format text.
function classify(bytes, size) {
  const format = imageFormat(bytes);
  if (rasterFormats.includes(format)) return { kind: 'image', format };
  const readable = !bytes.includes(0) && (() => { try { utf8().decode(bytes, { stream: size > textProbeBytes }); return true; } catch { return false; } })();
  if (readable && size <= textProbeBytes) return { kind: 'text', format: 'utf-8' };
  return { kind: 'file', format: format ?? (readable ? 'text' : null) };
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
const savedOutcome = (provenance) => provenance.baseVersionId ? 'saved' : provenance.collision === 'replace' ? 'replaced' : 'created';

export function createLibrary({ retained, metadata, drafts, project, record }) {
  const numbered = (versions) => versions.map((version, index) => ({ id: version.id, size: version.size, hash: version.hash,
    available: version.available, error: version.error, committedAt: version.committedAt, number: index + 1, written: version.provenance.method === 'document' }));
  function assetFrom(ctx, row) {
    const versions = numbered(metadata.history(ctx, row.id));
    return { id: row.id, projectId: row.project_id, filename: row.filename, kind: row.kind, createdAt: row.created_at,
      current: versions.find((version) => version.id === row.current_version_id) ?? null, versionCount: versions.length };
  }
  const numberedVersion = (ctx, version) => numbered(metadata.history(ctx, version.objectId)).find((entry) => entry.id === version.id);
  function owned(ctx, projectId, versionId) {
    const version = metadata.version(ctx, versionId);
    const source = version && metadata.object(ctx, version.objectId);
    if (!source || source.project_id !== projectId || !libraryKinds.includes(source.kind) || version.state !== 'committed') fail(404, 'This Library file version does not exist.');
    return { version, source };
  }

  const live = (ctx, projectId, assetId) => {
    const row = metadata.object(ctx, assetId);
    if (!row || row.project_id !== projectId || !libraryKinds.includes(row.kind) || row.removed_at || !row.current_version_id) fail(404, 'This Library file does not exist.');
    return row;
  };
  // A Save that committed but crashed before finishing its draft is finished here.
  function settle(ctx, projectId) {
    for (const draft of drafts.list(ctx, projectId)) {
      const saved = draft.saveOperationId && metadata.operation(ctx, draft.saveOperationId);
      if (saved?.state === 'committed') drafts.afterSave(ctx, projectId, draft.id, saved.provenance.revision, saved);
    }
  }
  // Where a publication lands: a new asset, or by explicit choice a new version
  // of the asset holding its name. A retry repeats its operation's original
  // choice exactly; a saved operation is reported again without new bytes.
  function placement(ctx, projectId, { filename, collision = null, assetId, operationId, method, prior = metadata.operation(ctx, operationId) }) {
    if (![null, 'create', 'replace'].includes(collision)) fail(400, 'Choose Create new or Replace for a name collision.');
    const taken = metadata.names(ctx, projectId);
    const holder = taken.find((entry) => entry.filename === filename);
    const conflict = nameConflict(filename, taken);
    const outcome = collision === 'replace' ? 'replaced' : 'created';
    if (prior) {
      const source = metadata.object(ctx, prior.objectId);
      if (source.project_id !== projectId || prior.provenance.method !== method || prior.provenance.requestedFilename !== filename
        || prior.provenance.collision !== collision || (collision === 'replace' && source.id !== assetId)) fail(409, `This ${method === 'upload' ? 'upload' : 'save'} was started for a different file. ${method === 'upload' ? 'Upload it' : 'Save'} again.`);
      if (prior.state !== 'committed' && taken.some((entry) => entry.filename === prior.filename && entry.id !== source.id)) fail(409, `Another file is named ${prior.filename} now. ${method === 'upload' ? `Upload ${filename}` : 'Save'} again to choose.`);
      return { prior, outcome, descriptor: { ...(collision === 'replace' ? { objectId: source.id } : {}), kind: source.kind, filename: prior.filename } };
    }
    if (collision === 'replace') {
      if (!holder?.committed || holder.id !== assetId) fail(409, holder ? `Another file is named ${filename} now. Choose again.` : `No file is named ${filename} any more. Save it as a new file.`, { conflict });
      return { outcome, descriptor: { objectId: holder.id, kind: metadata.object(ctx, holder.id).kind, filename } };
    }
    if (holder && collision !== 'create') fail(409, `A file named ${filename} already exists.`, { conflict });
    return { outcome, descriptor: { kind: method === 'upload' ? 'asset' : 'document', filename: conflict?.suggested ?? filename } };
  }

  return {
    list(ctx, projectId) {
      project(ctx, projectId, { allowArchived: true });
      settle(ctx, projectId);
      return { assets: metadata.sources(ctx, projectId).map((row) => assetFrom(ctx, row)),
        drafts: drafts.list(ctx, projectId).map(({ text, ...draft }) => ({ ...draft, length: text.length })) };
    },
    // Collisions are folder-local (the Library root, for now). Without an
    // explicit Create new or Replace choice, a taken name is refused unread.
    async upload(ctx, projectId, input, source, { signal } = {}) {
      project(ctx, projectId);
      const filename = libraryFilename(input?.filename);
      const { prior, descriptor, outcome } = placement(ctx, projectId, { ...input, filename, method: 'upload' });
      if (prior?.state === 'committed') return { outcome, asset: assetFrom(ctx, metadata.object(ctx, prior.objectId)), version: numberedVersion(ctx, prior) };
      const version = await retained.publish(ctx, { operationId: input.operationId, projectId, ...descriptor,
        provenance: { method: 'upload', requestedFilename: filename, collision: input.collision ?? null } }, source, { signal });
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
      const row = live(ctx, projectId, input.assetId);
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
        const row = live(ctx, projectId, draft.assetId);
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
        ({ descriptor } = placement(ctx, projectId, { ...input, filename: draft.filename, method: 'document', prior }));
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
      const row = metadata.object(ctx, assetId);
      if (!row || row.project_id !== projectId || !libraryKinds.includes(row.kind) || row.removed_at || !row.current_version_id) fail(404, 'This Library file does not exist.');
      const versions = numbered(metadata.history(ctx, row.id)).map((version) => ({ ...version, current: version.id === row.current_version_id }));
      return { ...assetFrom(ctx, row), versions: versions.reverse() };
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
    // The current committed versions named by ordered typed selections, one per
    // asset identity in first-selected position with every selection that named
    // it. An unresolvable source is reported by identity, never resolved empty.
    resolve(ctx, projectId, selections) {
      const files = new Map(); const problems = [];
      for (const selection of selections) {
        const key = sourceKey(selection);
        const row = selection.kind === 'asset' ? metadata.object(ctx, selection.id) : null;
        const owned = row && row.project_id === projectId && libraryKinds.includes(row.kind);
        const reason = !owned ? 'It is not a file in this project’s Library.' : row.removed_at ? 'It was removed from the Library.'
          : !row.current_version_id ? 'Its first upload has not finished.' : null;
        if (reason) { problems.push({ key, label: owned ? row.filename : key, phase: 'resolve', reason }); continue; }
        if (!files.has(row.id)) {
          const version = numberedVersion(ctx, metadata.version(ctx, row.current_version_id));
          files.set(row.id, { projectId, assetId: row.id, versionId: version.id, number: version.number, filename: row.filename, hash: version.hash, size: version.size, sources: [] });
        }
        files.get(row.id).sources.push({ kind: selection.kind, id: selection.id });
      }
      return { files: [...files.values()], problems };
    },
    // How a version can be delivered. Sends verify every byte; previews read
    // small files whole but only sample large ones, trusting their last check.
    async inspect(ctx, projectId, versionId, { verify = true } = {}) {
      const { version } = owned(ctx, projectId, versionId);
      if (verify || version.size <= textProbeBytes) return classify(await collect(await retained.read(ctx, version.id), version.size > textProbeBytes ? 64 : Infinity), version.size);
      if (!version.available) fail(409, `Retained version ${version.id} is unavailable. ${version.error}`);
      return classify(await retained.peek(ctx, version.id, 64), version.size);
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
      return { version, filename: source.filename, written: version.provenance.method === 'document', stream: await retained.read(ctx, version.id) };
    },
  };
}
