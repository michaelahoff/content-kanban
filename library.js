// The project Library: uploaded files with stable asset identities and
// immutable versions. Bytes live in retained storage; names are labels.
import { libraryFilename, nameConflict } from './public/library-format.js';
import { libraryKinds } from './store-retained.js';

const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };

export function createLibrary({ retained, metadata, project, record }) {
  const numbered = (versions) => versions.map((version, index) => ({ id: version.id, size: version.size, hash: version.hash,
    available: version.available, error: version.error, committedAt: version.committedAt, number: index + 1 }));
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

  return {
    list(ctx, projectId) {
      project(ctx, projectId, { allowArchived: true });
      return { assets: metadata.sources(ctx, projectId).map((row) => assetFrom(ctx, row)) };
    },
    // Collisions are folder-local (the Library root, for now). Without an
    // explicit Create new or Replace choice, a taken name is refused unread.
    async upload(ctx, projectId, input, source, { signal } = {}) {
      project(ctx, projectId);
      const filename = libraryFilename(input?.filename);
      const collision = input.collision ?? null;
      if (![null, 'create', 'replace'].includes(collision)) fail(400, 'Choose Create new or Replace for a name collision.');
      const taken = metadata.names(ctx, projectId);
      const holder = taken.find((entry) => entry.filename === filename);
      const conflict = nameConflict(filename, taken);
      // A retry repeats its operation's original choice exactly; a saved
      // operation is reported again without reading new bytes.
      const prior = metadata.operation(ctx, input.operationId);
      let descriptor;
      if (prior) {
        const source = metadata.object(ctx, prior.objectId);
        if (source.project_id !== projectId || prior.provenance.method !== 'upload' || prior.provenance.requestedFilename !== filename
          || prior.provenance.collision !== collision || (collision === 'replace' && source.id !== input.assetId)) fail(409, 'This upload was started for a different file. Upload it again.');
        if (prior.state !== 'committed' && taken.some((entry) => entry.filename === prior.filename && entry.id !== source.id)) fail(409, `Another file is named ${prior.filename} now. Upload ${filename} again to choose.`);
        descriptor = { ...(collision === 'replace' ? { objectId: source.id } : {}), filename: prior.filename };
      } else if (collision === 'replace') {
        if (!holder?.committed || holder.id !== input.assetId) fail(409, holder ? `Another file is named ${filename} now. Choose again.` : `No file is named ${filename} any more. Upload it as a new file.`, { conflict });
        descriptor = { objectId: holder.id, filename };
      } else {
        if (holder && collision !== 'create') fail(409, `A file named ${filename} already exists.`, { conflict });
        descriptor = { filename: conflict?.suggested ?? filename };
      }
      const outcome = descriptor.objectId ? 'replaced' : 'created';
      if (prior?.state === 'committed') return { outcome, asset: assetFrom(ctx, metadata.object(ctx, prior.objectId)), version: numberedVersion(ctx, prior) };
      const version = await retained.publish(ctx, { operationId: input.operationId, projectId, kind: 'asset', ...descriptor,
        provenance: { method: 'upload', requestedFilename: filename, collision } }, source, { signal });
      const asset = assetFrom(ctx, metadata.object(ctx, version.objectId));
      record(ctx, outcome === 'replaced' ? 'asset_replaced' : 'asset_uploaded', asset.id, projectId, { versionId: version.id, filename: asset.filename });
      return { outcome, asset, version: numberedVersion(ctx, version) };
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
        const key = `${selection.kind}:${selection.id}`;
        const row = selection.kind === 'asset' ? metadata.object(ctx, selection.id) : null;
        const owned = row && row.project_id === projectId && libraryKinds.includes(row.kind);
        const reason = !owned ? 'It is not a file in this project’s Library.' : row.removed_at ? 'It was removed from the Library.'
          : !row.current_version_id ? 'Its first upload has not finished.' : null;
        if (reason) { problems.push({ key, label: owned ? row.filename : key, phase: 'resolve', reason }); continue; }
        if (!files.has(row.id)) {
          const version = numberedVersion(ctx, metadata.version(ctx, row.current_version_id));
          files.set(row.id, { assetId: row.id, versionId: version.id, number: version.number, filename: row.filename, hash: version.hash, size: version.size, sources: [] });
        }
        files.get(row.id).sources.push({ kind: selection.kind, id: selection.id });
      }
      return { files: [...files.values()], problems };
    },
    async read(ctx, projectId, versionId) {
      project(ctx, projectId, { allowArchived: true });
      const { version, source } = owned(ctx, projectId, versionId);
      return { version, filename: source.filename, stream: await retained.read(ctx, version.id) };
    },
  };
}
