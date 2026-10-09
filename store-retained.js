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
    // A name is held by a live source, including one whose first upload is still in progress.
    names: (ctx, projectId) => all(`SELECT o.id, o.filename, o.current_version_id FROM retained_objects o WHERE o.workspace_id = ? AND o.project_id = ? AND o.${librarySource}
      AND o.removed_at IS NULL AND (o.current_version_id IS NOT NULL OR EXISTS (SELECT 1 FROM retained_versions v WHERE v.object_id = o.id AND v.state IN ('staging', 'published')))`, ctx.workspaceId, projectId)
      .map((row) => ({ id: row.id, filename: row.filename, committed: row.current_version_id !== null })),
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
        if (!source) run('INSERT INTO retained_objects (id, workspace_id, project_id, kind, filename, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          objectId, ctx.workspaceId, input.projectId, input.kind, input.filename, at);
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
    commit(ctx, id) {
      return transaction(() => {
        const row = get('SELECT * FROM retained_versions WHERE id = ? AND workspace_id = ?', id, ctx.workspaceId);
        const source = object(ctx, row.object_id);
        if (source.removed_at || source.current_version_id !== row.base_version_id) fail(409, 'The current retained version changed during publication.');
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
