// Private metadata for retained-storage.js, plus the read-only listings the
// Library (library.js) shows. Released image tables are untouched.
import { randomUUID } from 'node:crypto';
import { archivedMessage } from './store-chat.js';

export const libraryKinds = ['asset', 'document'];
const librarySource = `kind IN (${libraryKinds.map((kind) => `'${kind}'`).join(', ')})`;
export const retainedMigration = `
  CREATE TABLE retained_objects (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL CHECK(kind IN ('asset', 'document', 'output')),
    filename TEXT NOT NULL, current_version_id TEXT, removed_at TEXT, created_at TEXT NOT NULL);
  CREATE TABLE retained_versions (
    id TEXT PRIMARY KEY, object_id TEXT NOT NULL REFERENCES retained_objects(id),
    operation_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    base_version_id TEXT, filename TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('staging', 'published', 'committed', 'failed')),
    hash TEXT, size INTEGER, provenance TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, committed_at TEXT,
    UNIQUE(workspace_id, operation_id));
  CREATE INDEX retained_versions_by_object ON retained_versions(object_id);
`;
// Library folders (#53) nest within one project. A name is unique among a
// folder's live files and subfolders; removal hides, and never deletes.
export const foldersMigration = `
  CREATE TABLE library_folders (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT NOT NULL REFERENCES projects(id),
    parent_id TEXT REFERENCES library_folders(id), name TEXT NOT NULL, removed_at TEXT, created_at TEXT NOT NULL);
  CREATE INDEX library_folders_by_parent ON library_folders(project_id, parent_id);
  ALTER TABLE retained_objects ADD COLUMN folder_id TEXT REFERENCES library_folders(id);
`;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const from = (row) => row && ({ id: row.id, objectId: row.object_id, operationId: row.operation_id,
  filename: row.filename, state: row.state, hash: row.hash, size: row.size, provenance: JSON.parse(row.provenance),
  available: Boolean(row.available), error: row.error, createdAt: row.created_at, committedAt: row.committed_at });

export function createRetainedMetadata({ all, get, run, transaction, now }) {
  const version = (ctx, id) => from(get('SELECT * FROM retained_versions WHERE id = ? AND workspace_id = ?', id, ctx.workspaceId));
  const object = (ctx, id) => get('SELECT * FROM retained_objects WHERE id = ? AND workspace_id = ?', id, ctx.workspaceId)
    || fail(404, 'The retained source does not exist.');
  // Archive may land while bytes stream; an archived project gains no new bytes.
  const active = (ctx, id) => {
    const row = get('SELECT p.archived_at FROM retained_versions v JOIN retained_objects o ON o.id = v.object_id JOIN projects p ON p.id = o.project_id WHERE v.id = ? AND v.workspace_id = ?', id, ctx.workspaceId);
    if (row?.archived_at) fail(409, archivedMessage);
  };
  return {
    transaction,
    version,
    operation: (ctx, operationId) => from(get('SELECT * FROM retained_versions WHERE workspace_id = ? AND operation_id = ?', ctx.workspaceId, operationId)),
    inventory: (ctx) => all('SELECT * FROM retained_versions WHERE workspace_id = ? ORDER BY rowid', ctx.workspaceId).map(from),
    unfinished: () => all("SELECT * FROM retained_versions WHERE state != 'committed'").map(from),
    committed: () => all("SELECT * FROM retained_versions WHERE state = 'committed'").map(from),
    // Library listings: live uploaded/authored sources and their committed versions.
    object: (ctx, id) => get('SELECT * FROM retained_objects WHERE id = ? AND workspace_id = ?', id, ctx.workspaceId),
    sources: (ctx, projectId) => all(`SELECT * FROM retained_objects WHERE workspace_id = ? AND project_id = ? AND ${librarySource}
      AND removed_at IS NULL AND current_version_id IS NOT NULL ORDER BY filename, created_at`, ctx.workspaceId, projectId),
    history: (ctx, objectId) => all("SELECT * FROM retained_versions WHERE workspace_id = ? AND object_id = ? AND state = 'committed' ORDER BY committed_at, rowid", ctx.workspaceId, objectId).map(from),
    // A name in one folder (null: the root) is held by a live subfolder or
    // source, including a source whose first upload is still in progress.
    names: (ctx, projectId, folderId) => [
      ...all(`SELECT o.id, o.filename, o.current_version_id FROM retained_objects o WHERE o.workspace_id = ? AND o.project_id = ? AND o.${librarySource}
        AND o.folder_id IS ? AND o.removed_at IS NULL AND (o.current_version_id IS NOT NULL OR EXISTS (SELECT 1 FROM retained_versions v WHERE v.object_id = o.id AND v.state IN ('staging', 'published')))`, ctx.workspaceId, projectId, folderId)
        .map((row) => ({ kind: 'asset', id: row.id, filename: row.filename, committed: row.current_version_id !== null })),
      ...all('SELECT id, name FROM library_folders WHERE workspace_id = ? AND project_id = ? AND parent_id IS ? AND removed_at IS NULL', ctx.workspaceId, projectId, folderId)
        .map((row) => ({ kind: 'folder', id: row.id, filename: row.name, committed: false })),
    ],
    folder: (ctx, id) => get('SELECT * FROM library_folders WHERE id = ? AND workspace_id = ?', id, ctx.workspaceId),
    folders: (ctx, projectId) => all('SELECT * FROM library_folders WHERE workspace_id = ? AND project_id = ? AND removed_at IS NULL ORDER BY name, created_at', ctx.workspaceId, projectId),
    // Labels and locations are metadata: identities and versions never change.
    relocateAsset(ctx, id, { filename, folderId }) { run('UPDATE retained_objects SET filename = ?, folder_id = ? WHERE id = ? AND workspace_id = ?', filename, folderId, id, ctx.workspaceId); },
    relocateFolder(ctx, id, { name, parentId }) { run('UPDATE library_folders SET name = ?, parent_id = ? WHERE id = ? AND workspace_id = ?', name, parentId, id, ctx.workspaceId); },
    removed: (ctx, projectId) => all(`SELECT * FROM retained_objects WHERE workspace_id = ? AND project_id = ? AND ${librarySource}
      AND removed_at IS NOT NULL AND current_version_id IS NOT NULL ORDER BY removed_at DESC, filename`, ctx.workspaceId, projectId),
    // Removal hides a folder's whole subtree, including first uploads still in
    // progress, which then never commit. Earlier removals keep their time.
    removeFolder(ctx, id) {
      const at = now();
      const tree = `WITH RECURSIVE tree(id) AS (SELECT id FROM library_folders WHERE id = ? AND workspace_id = ?
        UNION ALL SELECT f.id FROM library_folders f JOIN tree ON f.parent_id = tree.id WHERE f.workspace_id = ?)`;
      const scope = [id, ctx.workspaceId, ctx.workspaceId];
      run(`${tree} UPDATE library_folders SET removed_at = ? WHERE id IN tree AND removed_at IS NULL`, ...scope, at);
      return run(`${tree} UPDATE retained_objects SET removed_at = ? WHERE folder_id IN tree AND workspace_id = ? AND ${librarySource} AND removed_at IS NULL`, ...scope, at, ctx.workspaceId).changes;
    },
    createFolder(ctx, { projectId, parentId, name }) {
      const id = randomUUID();
      run('INSERT INTO library_folders (id, workspace_id, project_id, parent_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, ctx.workspaceId, projectId, parentId, name, now());
      return get('SELECT * FROM library_folders WHERE id = ? AND workspace_id = ?', id, ctx.workspaceId);
    },
    active,
    current(ctx, id) { const row = object(ctx, id); return row.removed_at ? null : version(ctx, row.current_version_id); },
    remove(ctx, id) { object(ctx, id); transaction(() => run('UPDATE retained_objects SET removed_at = ? WHERE id = ?', now(), id)); },
    begin(ctx, input) {
      return transaction(() => {
        if (typeof input.operationId !== 'string' || !input.operationId.length || typeof input.filename !== 'string' || !input.filename.length
          || !['asset', 'document', 'output'].includes(input.kind)) fail(400, 'Retained publication needs an operation ID, filename and source kind.');
        const prior = get('SELECT * FROM retained_versions WHERE workspace_id = ? AND operation_id = ?', ctx.workspaceId, input.operationId);
        if (prior) {
          const source = object(ctx, prior.object_id);
          if (input.objectId && input.objectId !== source.id || source.project_id !== input.projectId || source.kind !== input.kind
            || prior.filename !== input.filename || prior.provenance !== JSON.stringify(input.provenance ?? {})) fail(409, 'This publication operation already names different metadata.');
          return from(prior);
        }
        if (!get('SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', input.projectId, ctx.workspaceId)) fail(404, 'The owning project does not exist.');
        const source = input.objectId ? object(ctx, input.objectId) : null;
        if (source && (source.project_id !== input.projectId || source.kind !== input.kind || source.removed_at)) fail(409, 'The retained source cannot be replaced.');
        const objectId = source?.id ?? randomUUID(); const id = randomUUID(); const at = now();
        if (!source) run('INSERT INTO retained_objects (id, workspace_id, project_id, kind, filename, folder_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          objectId, ctx.workspaceId, input.projectId, input.kind, input.filename, input.folderId ?? null, at);
        run(`INSERT INTO retained_versions (id, object_id, operation_id, workspace_id, base_version_id, filename, state, provenance, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'staging', ?, ?)`, id, objectId, input.operationId, ctx.workspaceId, source?.current_version_id ?? null, input.filename, JSON.stringify(input.provenance ?? {}), at);
        return version(ctx, id);
      });
    },
    restart(ctx, id) { transaction(() => run("UPDATE retained_versions SET state = 'staging', error = '' WHERE id = ? AND workspace_id = ? AND state != 'committed'", id, ctx.workspaceId)); },
    pin(ctx, id, digest) {
      const prior = version(ctx, id);
      if (prior.hash && (prior.hash !== digest.hash || prior.size !== digest.size)) fail(409, 'Retry bytes differ from the original publication. Publish a new version instead.');
      transaction(() => run('UPDATE retained_versions SET hash = ?, size = ? WHERE id = ? AND workspace_id = ?', digest.hash, digest.size, id, ctx.workspaceId));
    },
    published(ctx, id) { transaction(() => run("UPDATE retained_versions SET state = 'published' WHERE id = ? AND workspace_id = ?", id, ctx.workspaceId)); },
    commit(ctx, id, authorize) {
      return transaction(() => {
        authorize?.();
        const row = get('SELECT * FROM retained_versions WHERE id = ? AND workspace_id = ?', id, ctx.workspaceId);
        const source = object(ctx, row.object_id);
        if (source.removed_at) fail(409, `${source.filename} or its folder was removed during the upload. Nothing was saved.`);
        if (source.current_version_id !== row.base_version_id) fail(409, 'The current retained version changed during publication.');
        active(ctx, id);
        if (row.state !== 'published' || !row.hash || row.size === null) fail(409, 'Publication is incomplete.');
        run("UPDATE retained_versions SET state = 'committed', available = 1, error = '', committed_at = ? WHERE id = ?", now(), id);
        run('UPDATE retained_objects SET current_version_id = ? WHERE id = ?', id, row.object_id);
        return version(ctx, id);
      });
    },
    failed(id, message) { transaction(() => run("UPDATE retained_versions SET state = 'failed', error = ? WHERE id = ? AND state != 'committed'", message, id)); },
    availability(id, available, error = '') { transaction(() => run('UPDATE retained_versions SET available = ?, error = ? WHERE id = ? AND state = ?', available ? 1 : 0, error, id, 'committed')); },
  };
}
