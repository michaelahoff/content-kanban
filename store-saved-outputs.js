// Saved outputs: explicit retained snapshots of what a card chat produced,
// exposed only through openStore(). Each binds its card chat, conversation,
// submission and delivery attempt, its actual provider and creation method,
// and keeps the supplied context apart from any declared derivation. Its bytes
// are a retained version of kind 'output', so they outlive the workspace, the
// card, its sources and fresh context, and are in every backup.
import { createHash, randomUUID } from 'node:crypto';
import { libraryFilename } from './public/library-format.js';
import { maxDocumentBytes } from './library.js';

export const savedOutputsMigration = `
  CREATE TABLE saved_outputs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    card_id TEXT NOT NULL REFERENCES card_chats(card_id), attempt_id TEXT NOT NULL REFERENCES chat_attempts(id),
    operation_id TEXT NOT NULL, filename TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('saving', 'saved', 'failed')),
    version_id TEXT REFERENCES retained_versions(id), provenance TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, saved_at TEXT, UNIQUE (workspace_id, operation_id));
  CREATE INDEX saved_outputs_by_card ON saved_outputs(card_id, created_at);
`;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const live = ['dispatching', 'accepted', 'running'];
const revokedSaveMessage = 'This response was stopped, its project archived or the workspace restored before it was saved.';

// Exactly what the submission supplied, with its labels and versions. Supplying
// an input never claims the output was derived from it.
export const suppliedInputs = (frozen) => [
  ...(frozen.context?.images ?? []).map((image) => ({ kind: 'image', versionId: image.id, label: image.name, roles: image.labels, hash: image.hash ?? null })),
  ...(frozen.context?.library ?? []).map((file) => ({ kind: 'asset', assetId: file.assetId, versionId: file.versionId, label: file.libraryPath ?? file.filename, hash: file.hash, size: file.size })),
];

// A lane result's declared sources, verified against what its submission
// supplied: an image or Library version ID, or a Library asset ID naming the
// supplied version. Anything else refuses the save rather than recording a
// derivation nobody can check. No sources declared leaves it unknown.
function declaredDerivation(frozen, sources) {
  if (sources === null) return { declared: false };
  const supplied = suppliedInputs(frozen);
  return { declared: true, sources: sources.map((id) => {
    const input = supplied.find((entry) => entry.versionId === id || entry.assetId === id);
    if (!input) fail(400, `Its source ${id} was not supplied to this run. Declare only the version IDs listed in the prompt.`);
    return input.kind === 'image' ? { kind: 'image', versionId: input.versionId, label: input.label } : { kind: 'asset', assetId: input.assetId, versionId: input.versionId, label: input.label };
  }) };
}

export function createSavedOutputStore({ all, get, run, transaction, retainedCard, requireCard, recordChange, now, retained, library, revoked }) {
  function outputFrom(row, promotions = library().promotions({ workspaceId: row.workspace_id }, row.card_id)) {
    const version = row.version_id ? retained().version({ workspaceId: row.workspace_id }, row.version_id) : null;
    return { ...JSON.parse(row.provenance), id: row.id, cardId: row.card_id, attemptId: row.attempt_id, operationId: row.operation_id,
      filename: row.filename, status: row.status, versionId: row.version_id, hash: version?.hash ?? null, size: version?.size ?? null,
      available: version ? version.available : null, error: row.error, createdAt: row.created_at, savedAt: row.saved_at,
      promotions: promotions.get(row.id) ?? [] };
  }
  const byId = (ctx, id) => get('SELECT * FROM saved_outputs WHERE id = ? AND workspace_id = ?', id, ctx.workspaceId);
  function activity(ctx, cardId, type, data) {
    recordChange(ctx, 'chat', cardId, type, { projectId: retainedCard(ctx, cardId).project_id, data });
  }
  function provenance(attemptId, { creationMethod, itemId = null, sources }) {
    const a = get('SELECT * FROM chat_attempts WHERE id = ?', attemptId);
    const s = get('SELECT * FROM chat_submissions WHERE id = ?', a.submission_id); const frozen = JSON.parse(s.frozen);
    return { provider: frozen.provider ?? 'codex', model: frozen.model, creationMethod, conversationId: s.conversation_id, submissionId: s.id,
      laneRunId: frozen.lane?.runId ?? null, native: { turnId: a.turn_id, itemId }, supplied: suppliedInputs(frozen), derivation: declaredDerivation(frozen, sources) };
  }
  // A live attempt may register outputs only while it still holds authority:
  // not after Stop, archive or a workspace restore, nor once it has ended.
  function authorize(attemptId) {
    if (revoked(attemptId)) fail(409, revokedSaveMessage);
    if (!live.includes(get('SELECT status FROM chat_attempts WHERE id = ?', attemptId)?.status)) fail(409, 'This response no longer has authority to save outputs.');
  }

  const api = {
    list(ctx, cardId) {
      retainedCard(ctx, cardId);
      const promotions = library().promotions(ctx, cardId);
      return all('SELECT * FROM saved_outputs WHERE card_id = ? AND workspace_id = ? ORDER BY created_at, rowid', cardId, ctx.workspaceId).map((row) => outputFrom(row, promotions));
    },
    // Registers and saves one document. `operationId` is stable for the
    // request: repeating it returns the saved output, and repeating a failed
    // one retries with exactly the same text. `sources` are the declared
    // derivation (null: unknown). `requireLive` registration (an agent's
    // own result) needs the attempt's current authority before registering,
    // before byte publication and at commit. Failures after registration are
    // recorded on the output and returned, never thrown.
    async saveDocument(ctx, cardId, { operationId, attemptId, filename, text, creationMethod, itemId = null, sources = null, requireLive = false }) {
      const name = libraryFilename(filename, 'document');
      if (typeof text !== 'string' || !text.length) fail(400, 'There is no text to save.');
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.length > maxDocumentBytes) fail(413, `A saved document can be up to ${maxDocumentBytes / 1024 / 1024} MB.`);
      const row = transaction(() => {
        const prior = get('SELECT * FROM saved_outputs WHERE workspace_id = ? AND operation_id = ?', ctx.workspaceId, operationId);
        if (prior) {
          if (prior.card_id !== cardId || prior.attempt_id !== attemptId || prior.filename !== name) fail(409, 'This save operation already names a different output.');
          if (prior.status === 'saving') fail(409, `${name} is still being saved.`);
          if (prior.status === 'failed') {
            if (requireLive) authorize(attemptId);
            run("UPDATE saved_outputs SET status = 'saving', error = '' WHERE id = ?", prior.id);
          }
          return byId(ctx, prior.id);
        }
        const card = requireCard(ctx, cardId);
        if (get('SELECT card_id FROM chat_attempts WHERE id = ?', attemptId)?.card_id !== cardId) fail(404, 'This response does not exist in this card chat.');
        if (requireLive) authorize(attemptId);
        const id = randomUUID();
        run(`INSERT INTO saved_outputs (id, workspace_id, card_id, attempt_id, operation_id, filename, status, provenance, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'saving', ?, ?)`, id, ctx.workspaceId, cardId, attemptId, operationId, name,
        JSON.stringify(provenance(attemptId, { creationMethod, itemId, sources })), now());
        activity(ctx, cardId, 'output_registered', { outputId: id, attemptId, filename: name });
        return { ...byId(ctx, id), projectId: card.projectId };
      });
      if (row.status === 'saved') {
        const output = outputFrom(row);
        if (output.hash !== createHash('sha256').update(bytes).digest('hex')) fail(409, 'This save operation already saved different text.');
        return output;
      }
      const projectId = row.projectId ?? retainedCard(ctx, cardId).project_id;
      try {
        const version = await retained().publish(ctx, { operationId: `saved-output:${row.id}`, kind: 'output', projectId, filename: name, provenance: { savedOutputId: row.id } },
          bytes, { authorize: requireLive ? () => authorize(attemptId) : undefined });
        transaction(() => {
          run("UPDATE saved_outputs SET status = 'saved', version_id = ?, error = '', saved_at = ? WHERE id = ?", version.id, now(), row.id);
          activity(ctx, cardId, 'output_saved', { outputId: row.id, versionId: version.id, hash: version.hash });
        });
      } catch (error) {
        const reason = error.status ? error.message : `Saving failed: ${error.message}`;
        transaction(() => {
          run("UPDATE saved_outputs SET status = 'failed', error = ? WHERE id = ? AND status = 'saving'", reason, row.id);
          activity(ctx, cardId, 'output_save_failed', { outputId: row.id, reason });
        });
      }
      return outputFrom(byId(ctx, row.id));
    },
    // Save as document: the user's explicit save of a retained reply, or of a
    // passage of it. A stopped, archived-then-unarchived or recovered reply can
    // be saved this way; only its own late registrations are refused.
    async saveReply(ctx, cardId, { operation, sequence, filename, text }) {
      if (typeof operation !== 'string' || !/^[\w-]{1,100}$/.test(operation)) fail(400, 'Each save needs an operation ID.');
      requireCard(ctx, cardId);
      const item = Number.isInteger(sequence) && get(`SELECT i.*, a.status AS attempt_status FROM chat_items i JOIN chat_attempts a ON a.id = i.attempt_id
        WHERE i.sequence = ? AND a.card_id = ? AND i.kind = 'agentMessage'`, sequence, cardId);
      if (!item) fail(404, 'This reply does not exist in this card chat.');
      if (!item.completed && live.concat('interrupt-requested').includes(item.attempt_status)) fail(409, 'Wait for this reply to finish before saving it.');
      if (text !== undefined && (typeof text !== 'string' || !text.trim() || !item.text.includes(text))) fail(400, 'Save text that appears in this reply.');
      const output = await api.saveDocument(ctx, cardId, { operationId: `reply:${cardId}:${operation}`, attemptId: item.attempt_id, filename,
        text: text ?? item.text, creationMethod: 'transcript-save', itemId: item.native_id });
      if (output.status === 'failed') throw Object.assign(new Error(output.error), { status: 409, output });
      return output;
    },
    async content(ctx, cardId, id) {
      retainedCard(ctx, cardId);
      const row = byId(ctx, id);
      if (!row || row.card_id !== cardId) fail(404, 'This saved output does not exist.');
      if (row.status !== 'saved') fail(409, 'This output was not saved.');
      return { output: outputFrom(row), stream: await retained().read(ctx, row.version_id) };
    },
    // Save to project library: only this explicit user action publishes a
    // saved output in the Library; saving it never does. The output stays as
    // it is, whatever happens to the asset.
    promote(ctx, cardId, id, input) {
      const card = retainedCard(ctx, cardId);
      const row = byId(ctx, id);
      if (!row || row.card_id !== cardId) fail(404, 'This saved output does not exist.');
      if (row.status !== 'saved') fail(409, 'This output was not saved, so there is nothing to save to the Library.');
      return library().promoteOutput(ctx, card.project_id, { ...input, cardId, outputId: row.id, versionId: row.version_id });
    },
    // Restart interrupts an in-flight save. Its text remains in the reply.
    interrupted(ctx) {
      transaction(() => run(`UPDATE saved_outputs SET status = 'failed', error = 'Saving was interrupted by a restart. Save it from the reply instead.'
        WHERE status = 'saving' AND workspace_id = ?`, ctx.workspaceId));
    },
  };
  return api;
}
