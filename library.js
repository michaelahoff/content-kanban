// The project Library: uploaded files with stable asset identities and
// immutable versions. Bytes live in retained storage; names are labels.
import { availableFilename, libraryFilename } from './public/library-format.js';

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
    if (!source || source.project_id !== projectId || !['asset', 'document'].includes(source.kind) || version.state !== 'committed') fail(404, 'This Library file version does not exist.');
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
      const conflict = holder ? { assetId: holder.id, filename, suggested: availableFilename(filename, taken.map((entry) => entry.filename)) } : null;
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
      const version = await retained.publish(ctx, { operationId: input.operationId, projectId, kind: 'asset', ...descriptor,
        provenance: { method: 'upload', requestedFilename: filename, collision } }, source, { signal });
      const asset = assetFrom(ctx, metadata.object(ctx, version.objectId));
      const outcome = descriptor.objectId ? 'replaced' : 'created';
      record(ctx, outcome === 'replaced' ? 'asset_replaced' : 'asset_uploaded', asset.id, projectId, { versionId: version.id, filename: asset.filename });
      return { outcome, asset, version: asset.current };
    },
    asset(ctx, projectId, assetId) {
      project(ctx, projectId, { allowArchived: true });
      const row = metadata.object(ctx, assetId);
      if (!row || row.project_id !== projectId || !['asset', 'document'].includes(row.kind) || row.removed_at || !row.current_version_id) fail(404, 'This Library file does not exist.');
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
    async read(ctx, projectId, versionId) {
      project(ctx, projectId, { allowArchived: true });
      const { version, source } = owned(ctx, projectId, versionId);
      return { version, filename: source.filename, stream: await retained.read(ctx, version.id) };
    },
  };
}
