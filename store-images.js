// Image versions and card chat image outputs, exposed only through openStore().
// An output is retained with its provenance whether or not its bytes were
// saved; import, gallery adoption and image roles are separate steps.
import { randomUUID } from 'node:crypto';
import { archivedMessage } from './store-chat.js';

export const imagesMigration = `
  CREATE TABLE image_versions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    hash TEXT NOT NULL, size INTEGER NOT NULL, format TEXT NOT NULL, origin TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE chat_outputs (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES card_chats(card_id),
    attempt_id TEXT NOT NULL REFERENCES chat_attempts(id), native_id TEXT NOT NULL, kind TEXT NOT NULL,
    generation_status TEXT NOT NULL, import_status TEXT NOT NULL, image_id TEXT REFERENCES image_versions(id),
    name TEXT NOT NULL, provenance TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, imported_at TEXT,
    UNIQUE (attempt_id, native_id));
`;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// What every image output records about its request and producer. The image
// model is not reported by Codex, so it stays null rather than inferred.
export const outputProvenance = (submission, creationMethod, { toolPrompt = null, native }) => ({
  provider: 'codex', creationMethod, conversationModel: submission.model, imageModel: null, submissionId: submission.id,
  configurationId: submission.configuration.id, harness: submission.configuration.harness, toolPrompt, references: submission.context.images, native });
const versionFrom = (row) => row && ({ id: row.id, hash: row.hash, size: row.size, format: row.format, origin: row.origin, createdAt: row.created_at });

export function createImageStore({ all, get, run, transaction, retainedCard, recordChange, now, adopt, revoked }) {
  const version = (id) => versionFrom(get('SELECT * FROM image_versions WHERE id = ?', id));
  function outputFrom(row, gallery = null) {
    const image = row.image_id ? version(row.image_id) : null;
    return { ...JSON.parse(row.provenance), id: row.id, cardId: row.card_id, attemptId: row.attempt_id, nativeId: row.native_id, kind: row.kind,
      generationStatus: row.generation_status, importStatus: row.import_status, imageId: row.image_id, hash: image?.hash ?? null,
      name: row.name, error: row.error, createdAt: row.created_at, importedAt: row.imported_at,
      ...(gallery ? { inGallery: gallery.some((entry) => entry.id === row.image_id) } : {}) };
  }
  const output = (id) => { const row = get('SELECT * FROM chat_outputs WHERE id = ?', id); return row && outputFrom(row); };
  function activity(ctx, cardId, type, data) {
    recordChange(ctx, 'chat', cardId, type, { projectId: retainedCard(ctx, cardId).project_id, data });
  }
  function insertVersion(ctx, value, origin) {
    run('INSERT INTO image_versions (id, workspace_id, hash, size, format, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      value.id, ctx.workspaceId, value.hash, value.size, value.format, origin, now());
  }
  return {
    version,
    output,
    record(ctx, value, origin) { transaction(() => insertVersion(ctx, value, origin)); return version(value.id); },
    outputs(ctx, cardId) {
      const card = retainedCard(ctx, cardId);
      return all('SELECT * FROM chat_outputs WHERE card_id = ? ORDER BY created_at, rowid', cardId).map((row) => outputFrom(row, JSON.parse(card.images)));
    },
    // Idempotent by (attempt, native item or tool call): repeated native events
    // and reconciliation return the existing output. A revoked attempt (Stop,
    // archive) registers nothing new; its native item stays in the transcript.
    capture(ctx, attemptId, { nativeId, kind, generationStatus, name, provenance }) {
      return transaction(() => {
        const existing = get('SELECT * FROM chat_outputs WHERE attempt_id = ? AND native_id = ?', attemptId, nativeId);
        if (existing) return outputFrom(existing);
        const a = get('SELECT card_id FROM chat_attempts WHERE id = ?', attemptId);
        if (revoked(attemptId)) return null;
        const id = randomUUID();
        run(`INSERT INTO chat_outputs (id, card_id, attempt_id, native_id, kind, generation_status, import_status, name, provenance, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, a.card_id, attemptId, nativeId, kind, generationStatus,
        generationStatus === 'completed' ? 'pending' : 'not-applicable', name, JSON.stringify(provenance), now());
        activity({ ...ctx, actor: `automation:${attemptId}` }, a.card_id, 'image_output_received', { outputId: id, attemptId, generationStatus });
        return output(id);
      });
    },
    // A registered render is copied and hashed at registration, in the card
    // tool's transaction, so it is saved whenever the tool call succeeds.
    registered(ctx, attemptId, callId, artifact) {
      return transaction(() => {
        const existing = get('SELECT id FROM chat_outputs WHERE attempt_id = ? AND native_id = ?', attemptId, `tool:${callId}`);
        if (existing) return output(existing.id);
        const a = get('SELECT * FROM chat_attempts WHERE id = ?', attemptId);
        const submission = { id: a.submission_id, ...JSON.parse(get('SELECT frozen FROM chat_submissions WHERE id = ?', a.submission_id).frozen) };
        const captured = this.capture(ctx, attemptId, { nativeId: `tool:${callId}`, kind: 'registeredImage', generationStatus: 'completed', name: artifact.name,
          provenance: outputProvenance(submission, 'code-rendered', { native: { turnId: a.turn_id, callId, sourcePath: artifact.sourcePath } }) });
        return this.imported({ ...ctx, actor: `automation:${attemptId}` }, captured.id, artifact, 'registered-render');
      });
    },
    imported(ctx, id, value, origin) {
      return transaction(() => {
        const current = output(id);
        if (current.importStatus === 'imported') return current;
        // Bytes are published only while the producing attempt is unrevoked.
        if (revoked(current.attemptId)) return this.importFailed(ctx, id, 'Not saved: this response was stopped or its project archived before the image was saved.');
        insertVersion(ctx, value, origin);
        run("UPDATE chat_outputs SET import_status = 'imported', image_id = ?, error = '', imported_at = ? WHERE id = ?", value.id, now(), id);
        activity(ctx, current.cardId, 'image_output_imported', { outputId: id, imageId: value.id, hash: value.hash });
        return output(id);
      });
    },
    importFailed(ctx, id, reason) {
      return transaction(() => {
        const current = output(id);
        if (current.importStatus === 'imported') return current;
        run("UPDATE chat_outputs SET import_status = 'failed', error = ? WHERE id = ?", reason, id);
        activity(ctx, current.cardId, 'image_output_import_failed', { outputId: id, reason });
        return output(id);
      });
    },
    // A save-only retry reuses the same output; it never asks for generation.
    beginRetry(ctx, cardId, id) {
      if (retainedCard(ctx, cardId).project_archived_at) fail(409, archivedMessage);
      const existing = output(id);
      if (existing?.cardId === cardId && existing.importStatus !== 'imported' && revoked(existing.attemptId)) fail(409, 'This image cannot be saved: its response was stopped or its project archived. Send a new request instead.');
      return transaction(() => {
        const current = output(id);
        if (!current || current.cardId !== cardId) fail(404, 'This image output does not exist.');
        if (current.importStatus === 'imported') return current;
        if (current.importStatus !== 'failed') fail(409, current.generationStatus === 'completed' ? 'This image is still being saved.' : 'Generation did not complete. Send a deliberate new request instead.');
        run("UPDATE chat_outputs SET import_status = 'pending' WHERE id = ?", id);
        activity(ctx, cardId, 'image_output_save_retried', { outputId: id });
        return output(id);
      });
    },
    // Restart interrupts an in-flight save; it remains explicitly retryable.
    interruptedImports(ctx) {
      transaction(() => run(`UPDATE chat_outputs SET import_status = 'failed', error = 'Saving was interrupted by a restart. Retry saving.'
        WHERE import_status = 'pending' AND card_id IN (SELECT card_id FROM card_chats WHERE workspace_id = ?)`, ctx.workspaceId));
    },
    adopt(ctx, cardId, id) {
      return transaction(() => {
        const current = output(id);
        if (!current || current.cardId !== cardId) fail(404, 'This image output does not exist.');
        if (current.importStatus !== 'imported') fail(409, 'Only a saved image version can be added to the gallery.');
        return adopt(ctx, cardId, { id: current.imageId, name: current.name }, { outputId: id });
      });
    },
  };
}
