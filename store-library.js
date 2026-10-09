// Library document drafts: app data saved as the user writes, never a retained
// asset version. Only an explicit Save (library.js) publishes their text.
import { randomUUID } from 'node:crypto';

export const libraryDraftsMigration = `
  -- A draft belongs to one project. A new document has no asset yet; an edit
  -- of a saved one names it (one draft per asset) and the version it began from.
  CREATE TABLE library_drafts (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    project_id TEXT NOT NULL REFERENCES projects(id), asset_id TEXT UNIQUE REFERENCES retained_objects(id),
    base_version_id TEXT REFERENCES retained_versions(id), filename TEXT NOT NULL, text TEXT NOT NULL,
    revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX library_drafts_by_project ON library_drafts(workspace_id, project_id);
`;
const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const from = (row) => row && ({ id: row.id, projectId: row.project_id, assetId: row.asset_id, baseVersionId: row.base_version_id,
  filename: row.filename, text: row.text, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at });

export function createDraftStore({ all, get, run, transaction, now }) {
  const find = (ctx, projectId, id) => from(get('SELECT * FROM library_drafts WHERE id = ? AND workspace_id = ? AND project_id = ?', id, ctx.workspaceId, projectId));
  const requireDraft = (ctx, projectId, id) => find(ctx, projectId, id) || fail(404, 'This draft no longer exists. It may have been saved or discarded in another tab.');
  return {
    list: (ctx, projectId) => all('SELECT * FROM library_drafts WHERE workspace_id = ? AND project_id = ? ORDER BY created_at, rowid', ctx.workspaceId, projectId).map(from),
    get: requireDraft,
    find,
    forAsset: (ctx, assetId) => from(get('SELECT * FROM library_drafts WHERE workspace_id = ? AND asset_id = ?', ctx.workspaceId, assetId)),
    create(ctx, { projectId, assetId = null, baseVersionId = null, filename, text }) {
      const id = randomUUID(); const at = now();
      transaction(() => run(`INSERT INTO library_drafts (id, workspace_id, project_id, asset_id, base_version_id, filename, text, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, id, ctx.workspaceId, projectId, assetId, baseVersionId, filename, text, at, at));
      return requireDraft(ctx, projectId, id);
    },
    // Revisions stop two tabs from silently overwriting each other's draft.
    write(ctx, projectId, id, { text, filename, revision }) {
      return transaction(() => {
        const draft = requireDraft(ctx, projectId, id);
        if (draft.revision !== revision) fail(409, 'This draft changed in another tab.', { conflict: { draftRevision: draft.revision } });
        run('UPDATE library_drafts SET text = ?, filename = ?, revision = revision + 1, updated_at = ? WHERE id = ?', text, filename ?? draft.filename, now(), id);
        return requireDraft(ctx, projectId, id);
      });
    },
    remove(ctx, projectId, id) { transaction(() => { requireDraft(ctx, projectId, id); run('DELETE FROM library_drafts WHERE id = ?', id); }); },
    // A saved draft is finished. Text written after the saved revision stays a
    // draft of the asset, now based on the version just saved.
    saved(ctx, projectId, id, revision, version) {
      return transaction(() => {
        const draft = find(ctx, projectId, id);
        if (!draft) return null;
        if (draft.revision === revision) { run('DELETE FROM library_drafts WHERE id = ?', id); return null; }
        // Another draft already edits the replaced file; this one stays a new document.
        if (get('SELECT id FROM library_drafts WHERE asset_id = ? AND id != ?', version.objectId, id)) return draft;
        run('UPDATE library_drafts SET asset_id = ?, base_version_id = ?, filename = ? WHERE id = ?', version.objectId, version.id, version.filename, id);
        return find(ctx, projectId, id);
      });
    },
  };
}
