// Durable card-chat state, exposed only through openStore(). Native work never
// happens here. All mutations use the board store's transaction and activity log.
import { randomUUID } from 'node:crypto';
import { defaultSelections, contextFields, selectedContext } from './public/chat-context.js';
import { sourceKey } from './public/library-format.js';

export const chatMigration = `
  CREATE TABLE card_field_versions (card_id TEXT NOT NULL REFERENCES cards(id), field TEXT NOT NULL, version INTEGER NOT NULL,
    PRIMARY KEY (card_id, field));
  INSERT INTO card_field_versions SELECT id, 'title', revision FROM cards;
  INSERT INTO card_field_versions SELECT c.id, f.key, c.revision FROM cards c, json_each(c.fields) f;
  CREATE TRIGGER chat_card_fields_created AFTER INSERT ON cards BEGIN
    INSERT INTO card_field_versions VALUES (NEW.id, 'title', 1);
    INSERT INTO card_field_versions SELECT NEW.id, key, 1 FROM json_each(NEW.fields);
  END;
  CREATE TRIGGER chat_card_fields_changed AFTER UPDATE OF title, fields ON cards BEGIN
    UPDATE card_field_versions SET version = version + 1 WHERE card_id = NEW.id AND field = 'title' AND NEW.title != OLD.title;
    UPDATE card_field_versions SET version = version + 1 WHERE card_id = NEW.id AND field IN
      (SELECT key FROM json_each(NEW.fields) WHERE value IS NOT json_extract(OLD.fields, '$.' || key));
  END;
  CREATE TABLE card_chats (card_id TEXT PRIMARY KEY REFERENCES cards(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    composer TEXT NOT NULL, composer_revision INTEGER NOT NULL DEFAULT 0, last_viewed_at TEXT);
  CREATE TABLE chat_conversations (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES card_chats(card_id),
    position INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT, state TEXT NOT NULL, binding TEXT, grants TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
  CREATE UNIQUE INDEX chat_current_conversation ON chat_conversations(card_id) WHERE state != 'previous';
  CREATE TABLE chat_submissions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    card_id TEXT NOT NULL REFERENCES card_chats(card_id), conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
    frozen TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, completed_at TEXT);
  CREATE INDEX chat_queue ON chat_submissions(card_id, sequence);
  CREATE TABLE chat_attempts (id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES chat_submissions(id),
    card_id TEXT NOT NULL REFERENCES card_chats(card_id), previous_attempt_id TEXT REFERENCES chat_attempts(id),
    status TEXT NOT NULL, turn_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, error TEXT NOT NULL DEFAULT '');
  CREATE UNIQUE INDEX chat_one_active_attempt ON chat_attempts(card_id)
    WHERE status IN ('dispatching', 'accepted', 'running', 'interrupt-requested');
  CREATE TABLE chat_items (sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL REFERENCES chat_attempts(id),
    native_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL, completed INTEGER NOT NULL,
    UNIQUE (attempt_id, native_id));
  CREATE TABLE chat_requests (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES chat_attempts(id), native_id TEXT NOT NULL,
    method TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL);
`;

// Recovery (#24): why an attempt stopped, why a submission is held or waiting
// for its provider, and native turns continued outside Frameboard.
export const recoveryMigration = `
  ALTER TABLE chat_attempts ADD COLUMN cause TEXT;
  ALTER TABLE chat_submissions ADD COLUMN hold TEXT;
  ALTER TABLE chat_submissions ADD COLUMN retry_at TEXT;
  ALTER TABLE chat_submissions ADD COLUMN waits INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_conversations ADD COLUMN outside_turns TEXT NOT NULL DEFAULT '[]';
`;

const active = ['dispatching', 'accepted', 'running', 'interrupt-requested'];
// SQL lists: submissions not yet settled, and attempts that may still act.
const unfinishedSubmissions = "('queued', 'waiting', 'held', 'dispatching', 'running', 'interrupt-requested', 'uncertain')";
const unsettledAttempts = "('dispatching', 'accepted', 'running', 'interrupt-requested', 'uncertain')";
export const archivedMessage = 'This project is archived. Unarchive it to make changes.';
const restoredRetryMessage = 'This work was restored from a backup, so it cannot be retried. Send a new prompt or Run playbook instead.';
const restoredHoldReason = 'Restored from a backup and held. It is not sent again, but the old workspace may already have delivered it: review its retained output before sending new work, then cancel it.';
const restoredRunReason = 'Restored from a backup and held. It does not run or apply a result; Run playbook to start new work.';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const check = (value, message) => { if (!value) fail(400, message); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const validId = (value) => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const conversationFrom = (row) => ({ id: row.id, cardId: row.card_id, provider: row.provider, model: row.model,
  state: row.state, binding: row.binding ? JSON.parse(row.binding) : null, grants: JSON.parse(row.grants), outsideTurns: JSON.parse(row.outside_turns), createdAt: row.created_at });
const submissionFrom = (row) => ({ ...JSON.parse(row.frozen), id: row.id, cardId: row.card_id,
  conversationId: row.conversation_id, status: row.status, reason: row.reason, hold: row.hold, retryAt: row.retry_at, revoked: row.revoked, createdAt: row.created_at, completedAt: row.completed_at });
const attemptFrom = (row) => row && ({ id: row.id, submissionId: row.submission_id, cardId: row.card_id,
  previousAttemptId: row.previous_attempt_id, status: row.status, turnId: row.turn_id, startedAt: row.started_at, completedAt: row.completed_at, error: row.error, cause: row.cause, revoked: row.revoked, delivery: row.delivery ? JSON.parse(row.delivery) : null });

export function createChatStore({ all, get, run, transaction, retainedCard, requireCard, recordChange, now }) {
  function activity(ctx, cardId, type, data = {}) {
    const card = retainedCard(ctx, cardId);
    recordChange(ctx, 'chat', cardId, type, { projectId: card.project_id, data });
  }
  // Counts archives of the card's project. Preparation that spans an archive,
  // even one already undone, must not queue its work.
  const archiveGeneration = (cardId) => get('SELECT p.archive_generation FROM cards c JOIN projects p ON p.id = c.project_id WHERE c.id = ?', cardId).archive_generation;
  function current(cardId) { return conversationFrom(get("SELECT * FROM chat_conversations WHERE card_id = ? AND state != 'previous'", cardId)); }
  function newConversation(cardId, model, provider = 'codex') {
    const id = randomUUID();
    const position = get('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM chat_conversations WHERE card_id = ?', cardId).position;
    run("INSERT INTO chat_conversations (id, card_id, position, provider, model, state, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)", id, cardId, position, provider, model, now());
    return current(cardId);
  }
  function ensure(ctx, cardId) {
    const card = retainedCard(ctx, cardId);
    if (!get('SELECT card_id FROM card_chats WHERE card_id = ?', cardId)) transaction(() => {
      const settings = Object.fromEntries(all('SELECT provider, selection FROM provider_configurations WHERE workspace_id = ?', ctx.workspaceId)
        .map((row) => [row.provider, JSON.parse(row.selection)]));
      const provider = settings.codex?.enabled === false && settings.claude?.enabled === true ? 'claude' : 'codex';
      run('INSERT INTO card_chats (card_id, workspace_id, composer) VALUES (?, ?, ?)', cardId, ctx.workspaceId,
        JSON.stringify({ prompt: '', provider, model: null, selections: defaultSelections(card.template), authority: { fields: [] } }));
      newConversation(cardId, null, provider);
    });
    return get('SELECT * FROM card_chats WHERE card_id = ?', cardId);
  }
  function requireSubmission(ctx, cardId, id) {
    retainedCard(ctx, cardId);
    return get('SELECT * FROM chat_submissions WHERE id = ? AND card_id = ?', id, cardId) || fail(404, 'This submission does not exist.');
  }
  function attempt(id) { return attemptFrom(get('SELECT * FROM chat_attempts WHERE id = ?', id)); }
  function validateComposer(card, value) {
    check(object(value) && text(value.prompt, 200000), 'Prompts can be up to 200,000 characters.');
    check(value.model === null || (text(value.model, 200) && value.model.trim()), 'Choose a model.');
    check(value.provider === undefined || ['codex', 'claude'].includes(value.provider), 'Unknown chat provider.');
    const selections = value.selections;
    const fields = contextFields(card.template).map((field) => field.key);
    check(object(selections) && Array.isArray(selections.fields) && selections.fields.every((key) => fields.includes(key))
      && selections.fields.length <= fields.length, 'Invalid context fields.');
    check(Array.isArray(selections.roles) && selections.roles.length <= 3 && selections.roles.every((role) => ['original', 'inspiration', 'cover'].includes(role)), 'Invalid image roles.');
    check(Array.isArray(selections.images) && selections.images.length <= 200 && selections.images.every((id) => text(id, 100)), 'Invalid image references.');
    check(object(value.authority) && Array.isArray(value.authority.fields) && value.authority.fields.length <= fields.length
      && value.authority.fields.every((key) => fields.includes(key)), 'Invalid text authority.');
    // Library choices are ordered typed source IDs. A removed or foreign
    // source may stay selected; Send refuses it by name until corrected.
    const library = selections.library ?? [];
    check(Array.isArray(library) && library.length <= 200 && library.every((entry) => object(entry) && ['asset', 'folder'].includes(entry.kind) && validId(entry.id)), 'Invalid Library selections.');
    // Reused saved outputs are exact output IDs, resolved and refused like
    // Library sources: only this card chat's saved outputs can be sent.
    const outputs = selections.savedOutputs ?? [];
    check(Array.isArray(outputs) && outputs.length <= 200 && outputs.every(validId), 'Invalid saved output selections.');
    return { prompt: value.prompt, provider: value.provider ?? 'codex', model: value.model, selections: { fields: [...new Set(selections.fields)], roles: [...new Set(selections.roles)], images: [...new Set(selections.images)],
      library: [...new Map(library.map((entry) => [sourceKey(entry), { kind: entry.kind, id: entry.id }])).values()], savedOutputs: [...new Set(outputs)] },
      authority: { fields: [...new Set(value.authority.fields)] } };
  }
  function activeAttempt(cardId) {
    return attemptFrom(get("SELECT * FROM chat_attempts WHERE card_id = ? AND status IN ('dispatching', 'accepted', 'running', 'interrupt-requested')", cardId));
  }
  // What Retry depends on that is the same for every submission of a card.
  function retryState(cardId) {
    const conversation = current(cardId);
    return { conversation, active: Boolean(activeAttempt(cardId)),
      uncertain: Boolean(get("SELECT 1 FROM chat_submissions WHERE conversation_id = ? AND status = 'uncertain' LIMIT 1", conversation.id)) };
  }
  // Why a submission cannot be retried now, or null. A retried submission
  // keeps its place in the queue, so it would be sent ahead of later work:
  // an uncertain delivery anywhere in the conversation is reconciled first.
  function retryRefusal(row, state = retryState(row.card_id)) {
    if (row.revoked === 'archived') return 'This work was cancelled when its project was archived, so it cannot be retried. Send a new prompt or Run playbook instead.';
    if (row.revoked === 'restored') return restoredRetryMessage;
    if (!['failed', 'interrupted'].includes(row.status) || row.conversation_id !== state.conversation.id
      || state.conversation.state !== 'active' || state.active) return 'Retry requires a terminal attempt in the current, available conversation. Reconcile uncertainty before retrying.';
    if (state.uncertain) return 'Delivery of another prompt in this conversation is uncertain. Check delivery or mark it interrupted before retrying.';
    return null;
  }
  function invalidateRequests(attemptId) { run("UPDATE chat_requests SET status = 'invalidated' WHERE attempt_id = ? AND status = 'pending'", attemptId); }
  function status(ctx, id, value, reason = '', type = `submission_${value}`) {
    run('UPDATE chat_submissions SET status = ?, reason = ?, completed_at = ? WHERE id = ?', value, reason,
      ['completed', 'failed', 'interrupted', 'cancelled'].includes(value) ? now() : null, id);
    const row = get('SELECT card_id FROM chat_submissions WHERE id = ?', id);
    activity(ctx, row.card_id, type, { submissionId: id, reason });
    // A lane run ends with its submission. A completed reply's result block is
    // applied (and the run completed) before this; reaching here completed means
    // it was recovered without being applied.
    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(value)) {
      const laneReason = value === 'completed' ? 'The reply was recovered after Frameboard stopped, so its result was not applied. Run the playbook again.' : reason || `The lane run's reply was ${value}.`;
      run("UPDATE lane_runs SET status = ?, reason = ?, updated_at = ? WHERE submission_id = ? AND status IN ('queued', 'held')", value === 'cancelled' ? 'cancelled' : 'failed', laneReason, now(), id);
    }
  }
  function settleAttempt(ctx, a, result, reason, cause = null) {
    const stopped = a.status === 'interrupt-requested' || ['user', 'cancelled'].includes(a.cause);
    const value = stopped && result !== 'uncertain' ? 'interrupted' : result;
    // Stop and cancellation intent survive transport uncertainty and recovery.
    if (['user', 'cancelled', 'resolved'].includes(a.cause)) cause = a.cause;
    run('UPDATE chat_attempts SET status = ?, completed_at = ?, error = ?, cause = COALESCE(?, cause) WHERE id = ?', value, now(), reason, cause, a.id);
    invalidateRequests(a.id);
    status(ctx, a.submissionId, value, reason);
    return value;
  }
  // Stop and archive also revoke the attempt: it can never again change the
  // card, add notes or save outputs, whatever native events arrive later.
  function requestInterruption(ctx, a, reason, cause, revoked = null) {
    run("UPDATE chat_attempts SET status = 'interrupt-requested', cause = ?, revoked = COALESCE(revoked, ?) WHERE id = ?", cause, revoked, a.id);
    invalidateRequests(a.id);
    status(ctx, a.submissionId, 'interrupt-requested', reason);
    return { ...a, status: 'interrupt-requested' };
  }
  // Both dispatch and provider timers consider only unblocked queue heads.
  function queueHeads(ctx) {
    return all(`SELECT s.* FROM chat_submissions s JOIN card_chats h ON h.card_id = s.card_id
      JOIN cards c ON c.id = s.card_id JOIN projects p ON p.id = c.project_id JOIN chat_conversations v ON v.id = s.conversation_id
      WHERE h.workspace_id = ? AND c.deleted_at IS NULL AND p.archived_at IS NULL AND s.revoked IS NULL AND v.state = 'active' AND s.status IN ('queued', 'waiting')
      AND NOT EXISTS (SELECT 1 FROM chat_submissions earlier WHERE earlier.card_id = s.card_id AND earlier.sequence < s.sequence
        AND earlier.status IN ${unfinishedSubmissions})
      AND NOT EXISTS (SELECT 1 FROM chat_attempts a WHERE a.card_id = s.card_id AND a.status IN ('dispatching', 'accepted', 'running', 'interrupt-requested'))
      ORDER BY s.sequence`, ctx.workspaceId);
  }
  const api = {
    snapshot(ctx, cardId) {
      const row = ensure(ctx, cardId);
      const card = retainedCard(ctx, cardId);
      const state = retryState(cardId);
      return { cardId, deleted: Boolean(card.deleted_at), composer: { provider: 'codex', ...JSON.parse(row.composer), revision: row.composer_revision },
        conversations: all('SELECT * FROM chat_conversations WHERE card_id = ? ORDER BY position', cardId).map(conversationFrom),
        submissions: all('SELECT * FROM chat_submissions WHERE card_id = ? ORDER BY sequence', cardId).map((row) => ({ ...submissionFrom(row), retryable: !retryRefusal(row, state) })),
        attempts: all('SELECT * FROM chat_attempts WHERE card_id = ? ORDER BY rowid', cardId).map(attemptFrom),
        items: all('SELECT i.* FROM chat_items i JOIN chat_attempts a ON a.id = i.attempt_id WHERE a.card_id = ? ORDER BY i.sequence', cardId)
          .map((item) => ({ sequence: item.sequence, attemptId: item.attempt_id, nativeId: item.native_id, kind: item.kind, text: item.text, data: JSON.parse(item.data), completed: Boolean(item.completed) })),
        requests: all('SELECT r.* FROM chat_requests r JOIN chat_attempts a ON a.id = r.attempt_id WHERE a.card_id = ? ORDER BY r.rowid', cardId)
          .map((row) => ({ id: row.id, attemptId: row.attempt_id, method: row.method, params: JSON.parse(row.params), status: row.status })),
      };
    },
    saveComposer(ctx, cardId, input) {
      const card = requireCard(ctx, cardId);
      const row = ensure(ctx, cardId);
      check(object(input) && Number.isInteger(input.revision), 'Composer updates need their revision.');
      if (row.composer_revision !== input.revision) fail(409, 'The composer changed in another tab. Your unsent draft has been kept here; reload the saved composer or copy your draft.');
      const composer = validateComposer(card, input);
      // A primary-provider change clears the earlier Library and saved output
      // choices; any made together with the change are kept.
      const previous = JSON.parse(row.composer);
      if (composer.provider !== (previous.provider ?? 'codex')) {
        const earlier = new Set((previous.selections.library ?? []).map(sourceKey));
        composer.selections.library = composer.selections.library.filter((entry) => !earlier.has(sourceKey(entry)));
        const reused = new Set(previous.selections.savedOutputs ?? []);
        composer.selections.savedOutputs = composer.selections.savedOutputs.filter((id) => !reused.has(id));
      }
      if ((composer.model !== previous.model || composer.provider !== (previous.provider ?? 'codex')) && activeAttempt(cardId)) fail(409, 'Wait for the active response to finish or Stop it before changing model.');
      return transaction(() => {
        run('UPDATE card_chats SET composer = ?, composer_revision = composer_revision + 1 WHERE card_id = ?', JSON.stringify(composer), cardId);
        activity(ctx, cardId, 'composer_saved');
        return { ...composer, revision: input.revision + 1 };
      });
    },
    context(ctx, cardId) {
      const card = requireCard(ctx, cardId);
      const row = ensure(ctx, cardId);
      const versions = Object.fromEntries(all('SELECT field, version FROM card_field_versions WHERE card_id = ?', cardId).map((row) => [row.field, row.version]));
      return { cardId, cardRevision: card.revision, composerRevision: row.composer_revision, conversationId: current(cardId).id, archiveGeneration: archiveGeneration(cardId),
        projectId: card.projectId, librarySelections: JSON.parse(row.composer).selections.library ?? [], savedOutputSelections: JSON.parse(row.composer).selections.savedOutputs ?? [], prompt: JSON.parse(row.composer).prompt, provider: JSON.parse(row.composer).provider ?? 'codex', model: JSON.parse(row.composer).model,
        authority: JSON.parse(row.composer).authority, context: selectedContext(card, JSON.parse(row.composer).selections, versions,
          all("SELECT image_id AS id, name, id AS outputId FROM chat_outputs WHERE card_id = ? AND import_status = 'imported'", cardId)) };
    },
    // Saved card values for a lane run's selections, plus every field version
    // so a result can edit fields the playbook did not send.
    laneContext(ctx, cardId, selections) {
      const card = requireCard(ctx, cardId);
      ensure(ctx, cardId);
      const versions = Object.fromEntries(all('SELECT field, version FROM card_field_versions WHERE card_id = ?', cardId).map((row) => [row.field, row.version]));
      return { cardRevision: card.revision, conversationId: current(cardId).id, projectId: card.projectId, versions, card,
        // A lane can need portraits, backgrounds or other gallery photos that
        // have no role. Text selections must never hide those inputs.
        context: selectedContext(card, { fields: selections.fields, roles: ['original', 'inspiration', 'cover'], images: card.images.map((image) => image.id) }, versions, []) };
    },
    findSubmission(ctx, cardId, id) {
      retainedCard(ctx, cardId);
      const row = get('SELECT * FROM chat_submissions WHERE id = ? AND card_id = ?', id, cardId);
      return row ? submissionFrom(row) : null;
    },
    queue(ctx, cardId, input, captured, configuration) {
      check(object(input) && validId(input.id), 'A browser submission ID is required.');
      const existing = this.findSubmission(ctx, cardId, input.id);
      if (existing) return existing;
      const card = requireCard(ctx, cardId);
      const row = ensure(ctx, cardId);
      check(Number.isInteger(input.composerRevision), 'Send needs the saved composer revision.');
      if (captured.archiveGeneration !== archiveGeneration(cardId)) fail(409, 'The project was archived while preparing Send, so it was not sent. Review and send again.');
      if (row.composer_revision !== input.composerRevision || captured.composerRevision !== row.composer_revision || captured.cardRevision !== card.revision
        || captured.conversationId !== current(cardId).id) fail(409, 'The card, composer or conversation changed while preparing Send. Review and send again.');
      check(captured.prompt.trim() && captured.model, 'Write a prompt and explicitly choose a model before sending.');
      return transaction(() => {
        const conversation = current(cardId);
        if (conversation.provider !== captured.provider) {
          if (conversation.binding || get('SELECT id FROM chat_submissions WHERE conversation_id = ? LIMIT 1', conversation.id)) fail(409, 'Start fresh context before switching providers. Previous conversation history will be kept.');
          run('UPDATE chat_conversations SET provider = ? WHERE id = ?', captured.provider, conversation.id);
        }
        const frozen = { prompt: captured.prompt, context: captured.context, provider: captured.provider, model: captured.model, configuration, authority: captured.authority };
        run('INSERT INTO chat_submissions (id, card_id, conversation_id, frozen, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          input.id, cardId, conversation.id, JSON.stringify(frozen), 'queued', now());
        const composer = JSON.parse(row.composer);
        run('UPDATE card_chats SET composer = ?, composer_revision = composer_revision + 1 WHERE card_id = ?', JSON.stringify({ ...composer, prompt: '' }), cardId);
        activity(ctx, cardId, 'submission_queued', { submissionId: input.id, conversationId: conversation.id, model: frozen.model });
        return this.findSubmission(ctx, cardId, input.id);
      });
    },
    // A lane run's submission. The playbook supplies prompt, selections and
    // authority, so the composer and its draft are left alone.
    queueLane(ctx, cardId, input, captured, configuration) {
      check(object(input) && validId(input.id), 'A lane run submission ID is required.');
      const existing = this.findSubmission(ctx, cardId, input.id);
      if (existing) return existing;
      const card = requireCard(ctx, cardId);
      ensure(ctx, cardId);
      if (captured.cardRevision !== card.revision || captured.conversationId !== current(cardId).id) fail(409, 'The card or its conversation changed while preparing the lane run.');
      check(captured.prompt.trim() && captured.model, 'A lane run needs instructions and a model.');
      return transaction(() => {
        const conversation = current(cardId);
        if (conversation.provider !== captured.provider) {
          if (conversation.binding || get('SELECT id FROM chat_submissions WHERE conversation_id = ? LIMIT 1', conversation.id)) fail(409, 'Start fresh context before switching providers.');
          run('UPDATE chat_conversations SET provider = ? WHERE id = ?', captured.provider, conversation.id);
        }
        // The run and its submission link in one commit; a run cancelled while
        // this was being prepared gets no submission.
        const laneRun = get('SELECT status FROM lane_runs WHERE id = ?', captured.lane.runId);
        if (laneRun?.status !== 'pending') throw Object.assign(new Error('This lane run was cancelled while it was being prepared.'), { status: 409, code: 'lane-run-closed' });
        const frozen = { prompt: captured.prompt, context: captured.context, provider: captured.provider, model: captured.model, configuration, authority: captured.authority, lane: captured.lane };
        run('INSERT INTO chat_submissions (id, card_id, conversation_id, frozen, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          input.id, cardId, conversation.id, JSON.stringify(frozen), 'queued', now());
        run("UPDATE lane_runs SET status = 'queued', reason = '', submission_id = ?, updated_at = ? WHERE id = ?", input.id, now(), captured.lane.runId);
        activity(ctx, cardId, 'submission_queued', { submissionId: input.id, conversationId: conversation.id, model: frozen.model, laneRunId: captured.lane.runId });
        return this.findSubmission(ctx, cardId, input.id);
      });
    },
    // Whether a lane run can start fresh context now: nothing may be running,
    // queued or awaiting reconciliation in the current conversation.
    laneConversation(ctx, cardId) {
      ensure(ctx, cardId);
      const conversation = current(cardId);
      const used = Boolean(conversation.binding || get('SELECT id FROM chat_submissions WHERE conversation_id = ? LIMIT 1', conversation.id));
      const busy = Boolean(activeAttempt(cardId) || get(`SELECT id FROM chat_submissions WHERE conversation_id = ? AND status IN ${unfinishedSubmissions} LIMIT 1`, conversation.id));
      return { id: conversation.id, provider: conversation.provider, state: conversation.state, used, busy, composer: JSON.parse(get('SELECT composer FROM card_chats WHERE card_id = ?', cardId).composer) };
    },
    cancelQueued(ctx, submissionId, reason) {
      const row = get('SELECT status FROM chat_submissions WHERE id = ?', submissionId);
      if (!row || !['queued', 'waiting', 'held'].includes(row.status)) return false;
      transaction(() => status(ctx, submissionId, 'cancelled', reason));
      return true;
    },
    ready(ctx) {
      const at = now();
      return queueHeads(ctx).filter((row) => row.status === 'queued' || row.retry_at <= at).map(submissionFrom);
    },
    nextRetry(ctx) {
      return queueHeads(ctx).filter((row) => row.status === 'waiting').reduce((at, row) => !at || row.retry_at < at ? row.retry_at : at, null);
    },
    // A proven pre-accept transient rejection: nothing was accepted, so the
    // same submission waits for its provider and retries with backoff. After
    // `limit` consecutive waits it fails and needs an explicit retry.
    wait(ctx, id, reason, { baseMs, limit }) {
      return transaction(() => {
        const a = attempt(id);
        if (a?.status === 'interrupt-requested') {
          settleAttempt(ctx, a, 'interrupted', 'Stopped before Codex accepted this prompt.');
          return true;
        }
        if (!a || a.status !== 'dispatching') return false;
        const { waits } = get('SELECT waits FROM chat_submissions WHERE id = ?', a.submissionId);
        if (waits >= limit) {
          settleAttempt(ctx, a, 'failed', `Codex kept rejecting this prompt before accepting it. Retry explicitly. ${reason}`);
          return true;
        }
        run("UPDATE chat_attempts SET status = 'not-delivered', completed_at = ?, error = ? WHERE id = ?", now(), reason, id);
        invalidateRequests(id);
        const retryAt = new Date(Date.parse(now()) + Math.min(baseMs * 2 ** waits, 300000)).toISOString();
        run('UPDATE chat_submissions SET retry_at = ?, waits = waits + 1 WHERE id = ?', retryAt, a.submissionId);
        status(ctx, a.submissionId, 'waiting', `Waiting for provider: ${reason} Retrying automatically.`);
        return true;
      });
    },
    claim(ctx, submissionId) {
      return transaction(() => {
        const submission = this.ready(ctx).find((row) => row.id === submissionId);
        if (!submission) return null;
        const id = randomUUID();
        const previous = get('SELECT id FROM chat_attempts WHERE submission_id = ? ORDER BY rowid DESC LIMIT 1', submission.id);
        run('INSERT INTO chat_attempts (id, submission_id, card_id, previous_attempt_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
          id, submission.id, submission.cardId, previous?.id ?? null, 'dispatching', now());
        status(ctx, submission.id, 'dispatching');
        return { attempt: attempt(id), submission, conversation: current(submission.cardId) };
      });
    },
    attempt,
    activeAttempt,
    // The actual outcome of each Library input for one attempt: prepared,
    // sent, not sent, uncertain or failed with its reason.
    delivered(ctx, id, delivery) {
      transaction(() => {
        const a = attempt(id); if (!a) return;
        run('UPDATE chat_attempts SET delivery = ? WHERE id = ?', JSON.stringify(delivery), id);
        activity(ctx, a.cardId, 'delivery_recorded', { attemptId: id });
      });
    },
    // Why an attempt may no longer produce effects, or null. Status alone does
    // not say this: a late native event can still arrive for a revoked attempt.
    revocation(id) {
      const row = get('SELECT a.revoked, p.archived_at FROM chat_attempts a JOIN cards c ON c.id = a.card_id JOIN projects p ON p.id = c.project_id WHERE a.id = ?', id);
      return row?.revoked ?? (row?.archived_at ? 'archived' : null);
    },
    bindingConfiguration(conversationId) {
      const conversation = get('SELECT binding FROM chat_conversations WHERE id = ?', conversationId);
      const binding = conversation?.binding && JSON.parse(conversation.binding);
      if (!binding) return null;
      const row = get(`SELECT json_extract(frozen, '$.configuration') AS configuration FROM chat_submissions
        WHERE conversation_id = ? AND json_extract(frozen, '$.configuration.id') = ? ORDER BY sequence DESC LIMIT 1`, conversationId, binding.configurationId);
      return row ? JSON.parse(row.configuration) : null;
    },
    turnIds(ctx, cardId) {
      retainedCard(ctx, cardId);
      return all('SELECT turn_id FROM chat_attempts WHERE card_id = ? AND turn_id IS NOT NULL', cardId).map((row) => row.turn_id);
    },
    bind(ctx, attemptId, binding) {
      return transaction(() => {
        const a = attempt(attemptId);
        if (a?.status !== 'dispatching' || retainedCard(ctx, a.cardId).deleted_at) return false;
        const submission = get('SELECT conversation_id FROM chat_submissions WHERE id = ?', a.submissionId);
        const existing = get('SELECT binding FROM chat_conversations WHERE id = ?', submission.conversation_id).binding;
        if (existing && existing !== JSON.stringify(binding)) fail(409, 'The exact native conversation binding changed.');
        run('UPDATE chat_conversations SET binding = ? WHERE id = ?', JSON.stringify(binding), submission.conversation_id);
        activity(ctx, a.cardId, 'conversation_bound', { conversationId: submission.conversation_id });
        return true;
      });
    },
    running(ctx, id, turnId) {
      return transaction(() => {
        const a = attempt(id);
        if (!a || !active.includes(a.status)) return false;
        if (a.turnId && a.turnId !== turnId) return false;
        if (a.turnId === turnId && a.status === 'running') return true;
        const submission = get('SELECT * FROM chat_submissions WHERE id = ?', a.submissionId);
        const conversation = get('SELECT * FROM chat_conversations WHERE id = ?', submission.conversation_id);
        const model = JSON.parse(submission.frozen).model;
        if (conversation.model && conversation.model !== model) this.item(ctx, id,
          { id: 'model-change', kind: 'notice', text: `Model changed from ${conversation.model} to ${model}.`, completed: true });
        run('UPDATE chat_conversations SET model = ? WHERE id = ?', model, conversation.id);
        run('UPDATE chat_attempts SET turn_id = ?, status = ? WHERE id = ?', turnId,
          a.status === 'interrupt-requested' ? a.status : 'running', id);
        run('UPDATE chat_submissions SET waits = 0, retry_at = NULL WHERE id = ?', a.submissionId);
        if (a.status !== 'interrupt-requested') status(ctx, a.submissionId, 'running');
        return true;
      });
    },
    finish(ctx, id, result, reason = '', cause = null) {
      return transaction(() => {
        const a = attempt(id);
        if (!a || !active.includes(a.status)) return false;
        settleAttempt(ctx, a, result, reason, cause);
        return true;
      });
    },
    hold(ctx, id, reason, { nativeUnavailable = false, kind = 'configuration' } = {}) {
      return transaction(() => {
        const a = attempt(id);
        if (!a || !active.includes(a.status)) return false;
        // Stop or archive while preparing ends the attempt; there is nothing to hold.
        if (a.status === 'interrupt-requested') {
          settleAttempt(ctx, a, 'interrupted', 'Stopped before it was sent.');
          return true;
        }
        run("UPDATE chat_attempts SET status = 'held', completed_at = ?, error = ? WHERE id = ?", now(), reason, id);
        invalidateRequests(id);
        run('UPDATE chat_submissions SET hold = ? WHERE id = ?', nativeUnavailable ? 'native-unavailable' : kind, a.submissionId);
        status(ctx, a.submissionId, 'held', reason);
        if (nativeUnavailable) run("UPDATE chat_conversations SET state = 'native-unavailable' WHERE id = (SELECT conversation_id FROM chat_submissions WHERE id = ?)", a.submissionId);
        return true;
      });
    },
    item(ctx, id, item) {
      return transaction(() => {
        const a = attempt(id);
        if (!a) return;
        retainedCard(ctx, a.cardId);
        // Upsert by (attempt, native item): repeated or out-of-order events never
        // duplicate an item or replace a completed item with partial content.
        const { changes } = run(`INSERT INTO chat_items (attempt_id, native_id, kind, text, data, completed) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (attempt_id, native_id) DO UPDATE SET kind = excluded.kind, text = excluded.text, data = excluded.data,
          completed = MAX(chat_items.completed, excluded.completed)
          WHERE (excluded.completed OR NOT chat_items.completed)
            AND (chat_items.text IS NOT excluded.text OR chat_items.data IS NOT excluded.data OR chat_items.completed IS NOT excluded.completed)`,
        id, item.id, item.kind, item.text ?? '', JSON.stringify(item.data ?? {}), Number(Boolean(item.completed)));
        if (changes) activity(ctx, a.cardId, 'transcript_updated', { attemptId: id, itemId: item.id });
      });
    },
    request(ctx, id, request) {
      return transaction(() => {
        const a = attempt(id);
        if (!a || !['dispatching', 'accepted', 'running'].includes(a.status)) return null;
        const requestId = `${id}:${request.requestId}`;
        // A repeated native request is the same request. Once answered or
        // invalidated it is never pending again; the caller declines it.
        const existing = get('SELECT status FROM chat_requests WHERE id = ?', requestId);
        if (existing) return existing.status === 'pending' ? requestId : null;
        run('INSERT INTO chat_requests (id, attempt_id, native_id, method, params, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          requestId, id, String(request.requestId), request.method, JSON.stringify(request.params), 'pending', now());
        activity(ctx, a.cardId, 'request_pending', { requestId });
        return requestId;
      });
    },
    invalidateRequest(ctx, attemptId, nativeId) {
      transaction(() => {
        const a = attempt(attemptId); if (!a) return;
        retainedCard(ctx, a.cardId);
        const updated = run("UPDATE chat_requests SET status = 'invalidated' WHERE attempt_id = ? AND native_id = ? AND status = 'pending'", attemptId, String(nativeId));
        if (updated.changes) activity({ ...ctx, actor: 'system:native-request' }, a.cardId, 'request_invalidated', { requestId: `${attemptId}:${nativeId}` });
      });
    },
    answerRequest(ctx, cardId, requestId, response, grant = null) {
      return transaction(() => {
        retainedCard(ctx, cardId);
        const row = get('SELECT r.* FROM chat_requests r JOIN chat_attempts a ON a.id = r.attempt_id WHERE r.id = ? AND a.card_id = ?', requestId, cardId);
        if (!row || row.status !== 'pending' || !['dispatching', 'accepted', 'running'].includes(attempt(row.attempt_id)?.status)) fail(409, 'This request was invalidated or has already been answered.');
        run("UPDATE chat_requests SET status = 'answered', response = ? WHERE id = ?", JSON.stringify(response), requestId);
        if (grant) {
          const conversation = get('SELECT v.* FROM chat_conversations v JOIN chat_submissions s ON s.conversation_id = v.id JOIN chat_attempts a ON a.submission_id = s.id WHERE a.id = ?', row.attempt_id);
          if (conversation.state !== 'active') fail(409, 'This conversation no longer accepts grants.');
          const grants = JSON.parse(conversation.grants);
          if (!grants.some((g) => JSON.stringify(g) === JSON.stringify(grant))) grants.push(grant);
          run('UPDATE chat_conversations SET grants = ? WHERE id = ?', JSON.stringify(grants), conversation.id);
        }
        activity(ctx, cardId, 'request_answered', { requestId });
      });
    },
    requestGrants(ctx, cardId) { retainedCard(ctx, cardId); return current(cardId).grants; },
    clearGrants(ctx, cardId) {
      requireCard(ctx, cardId);
      if (activeAttempt(cardId) && current(cardId).grants.some((g) => g.kind === 'full')) fail(409, 'Stop the active response and wait for acknowledged interruption before revoking Full native access.');
      transaction(() => { run("UPDATE chat_conversations SET grants = '[]' WHERE id = ?", current(cardId).id); activity(ctx, cardId, 'grants_revoked'); });
      return { ok: true };
    },
    stop(ctx, cardId) {
      retainedCard(ctx, cardId);
      return transaction(() => {
        const a = activeAttempt(cardId);
        if (!a) return null;
        return requestInterruption(ctx, a, 'Stopped by the user.', 'user', 'stopped');
      });
    },
    cancelSubmission(ctx, cardId, id) {
      const row = requireSubmission(ctx, cardId, id);
      if (!['queued', 'waiting', 'held'].includes(row.status)) fail(409, 'Only queued, waiting or held submissions can be cancelled here. Stop active work first.');
      transaction(() => status(ctx, id, 'cancelled', 'Cancelled by the user.'));
    },
    // How each of a card's lane runs can be recovered: whether Retry would be
    // accepted now, and whether the native agent may have received it
    // without Frameboard knowing (delivery uncertain, or an uncertain
    // delivery marked interrupted), so running it again may repeat its work.
    // `conversationUncertain` is why Retry waits even for other submissions.
    recovery(cardId) {
      // A run that failed before queueing may have no card chat to read.
      if (!get('SELECT 1 FROM card_chats WHERE card_id = ?', cardId)) return { conversationUncertain: false, of: () => ({ retryable: false, possiblyDelivered: false }) };
      const state = retryState(cardId);
      return { conversationUncertain: state.uncertain, of(id) {
        const row = id && get('SELECT * FROM chat_submissions WHERE id = ?', id);
        if (!row) return { retryable: false, possiblyDelivered: false };
        return { retryable: !retryRefusal(row, state), possiblyDelivered: row.status === 'uncertain'
          || Boolean(get("SELECT 1 FROM chat_attempts WHERE submission_id = ? AND cause = 'resolved' LIMIT 1", id)) };
      } };
    },
    retry(ctx, cardId, id) {
      requireCard(ctx, cardId);
      const row = requireSubmission(ctx, cardId, id);
      const refusal = retryRefusal(row);
      if (refusal) fail(409, refusal);
      transaction(() => {
        status(ctx, id, 'queued', 'Explicitly retried by the user with the original frozen inputs.');
        run("UPDATE lane_runs SET status = 'queued', reason = '', result = NULL, updated_at = ? WHERE submission_id = ?", now(), id);
      });
      return submissionFrom(get('SELECT * FROM chat_submissions WHERE id = ?', id));
    },
    cancelCard(ctx, cardId, reason) {
      return transaction(() => {
        for (const row of all("SELECT id FROM chat_submissions WHERE card_id = ? AND status IN ('queued', 'waiting', 'held')", cardId)) status(ctx, row.id, 'cancelled', reason);
        const a = activeAttempt(cardId);
        if (a) requestInterruption(ctx, a, reason, 'cancelled');
      });
    },
    // Archive revokes more strongly than Stop: queued work is cancelled, active
    // work is interrupted, and no unfinished attempt or submission can act, be
    // requeued or be retried again. Pending requests and grants are revoked too.
    revokeCard(ctx, cardId, reason) {
      return transaction(() => {
        run(`UPDATE chat_submissions SET revoked = 'archived' WHERE card_id = ?
          AND status IN ${unfinishedSubmissions}`, cardId);
        run(`UPDATE chat_attempts SET revoked = COALESCE(revoked, 'archived') WHERE card_id = ? AND status IN ${unsettledAttempts}`, cardId);
        for (const row of all("SELECT id FROM chat_submissions WHERE card_id = ? AND status IN ('queued', 'waiting', 'held')", cardId)) status(ctx, row.id, 'cancelled', reason);
        const a = activeAttempt(cardId);
        if (a && a.status !== 'interrupt-requested') requestInterruption(ctx, a, reason, 'cancelled');
        if (get("SELECT 1 FROM chat_conversations WHERE card_id = ? AND grants != '[]'", cardId)) {
          run("UPDATE chat_conversations SET grants = '[]' WHERE card_id = ?", cardId);
          activity(ctx, cardId, 'grants_revoked');
        }
      });
    },
    fresh(ctx, cardId, input) {
      check(object(input), 'Fresh context needs explicit transition options.');
      requireCard(ctx, cardId);
      const row = ensure(ctx, cardId);
      return transaction(() => {
        if (activeAttempt(cardId)) fail(409, 'Wait for the response to finish, or Stop and wait for acknowledged interruption before starting fresh context.');
        const old = current(cardId);
        if (all("SELECT id FROM chat_submissions WHERE conversation_id = ? AND status = 'uncertain'", old.id).length) fail(409, 'Delivery is uncertain. Reconcile the old conversation before starting fresh context.');
        const queued = all("SELECT id FROM chat_submissions WHERE conversation_id = ? AND status IN ('queued', 'waiting', 'held')", old.id);
        if (queued.length && input.cancelQueued !== true) fail(409, 'Explicitly cancel the old queued submissions before starting fresh context.');
        for (const submission of queued) status(ctx, submission.id, 'cancelled', 'Cancelled for empty fresh context.');
        run("UPDATE chat_conversations SET state = 'previous' WHERE id = ?", old.id);
        // Manual Library and saved output choices belong to the conversation
        // they were made in. Outputs saved in it stay selectable from the new one.
        const composer = JSON.parse(row.composer);
        if (composer.selections.library?.length || composer.selections.savedOutputs?.length) run('UPDATE card_chats SET composer = ?, composer_revision = composer_revision + 1 WHERE card_id = ?',
          JSON.stringify({ ...composer, selections: { ...composer.selections, library: [], savedOutputs: [] } }), cardId);
        const next = newConversation(cardId, composer.model, composer.provider ?? 'codex');
        activity(ctx, cardId, 'fresh_context', { previousConversationId: old.id, conversationId: next.id });
        return this.snapshot(ctx, cardId);
      });
    },
    // Attempts that hold their card's dispatch slot: native work may still act.
    activeAttempts(ctx) {
      return all(`SELECT a.id, a.card_id, a.status FROM chat_attempts a JOIN card_chats h ON h.card_id = a.card_id
        WHERE h.workspace_id = ? AND a.status IN (${active.map(() => '?').join(', ')}) ORDER BY a.started_at`, ctx.workspaceId, ...active)
        .map((row) => ({ cardId: row.card_id, attemptId: row.id, status: row.status }));
    },
    unfinished(ctx) {
      return all(`SELECT a.* FROM chat_attempts a JOIN card_chats h ON h.card_id = a.card_id
        WHERE h.workspace_id = ? AND a.status IN ${unsettledAttempts}`, ctx.workspaceId)
        .map((row) => ({ attempt: attemptFrom(row), submission: submissionFrom(get('SELECT * FROM chat_submissions WHERE id = ?', row.submission_id)),
          conversation: conversationFrom(get('SELECT v.* FROM chat_conversations v JOIN chat_submissions s ON s.conversation_id = v.id WHERE s.id = ?', row.submission_id)) }));
    },
    invalidateAfterRestart(ctx) {
      transaction(() => {
        run("UPDATE chat_requests SET status = 'invalidated' WHERE status = 'pending' AND attempt_id IN (SELECT a.id FROM chat_attempts a JOIN card_chats h ON h.card_id = a.card_id WHERE h.workspace_id = ?)", ctx.workspaceId);
      });
    },
    // The recovery hold of a restored workspace, applied once before any worker
    // wakes. The old runtime's unsettled attempts lose all effect authority,
    // approvals and grants lapse, bound conversations are not resumed, and no
    // earlier submission can be retried. Unfinished work in active projects is
    // held for review; archived or deleted work stays cancelled. Retained
    // transcripts and outputs stay as they were, for inspection only.
    holdRestored(ctx) {
      const closed = `(SELECT c.id FROM cards c JOIN projects p ON p.id = c.project_id WHERE c.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL OR p.archived_at IS NOT NULL)`;
      return transaction(() => {
        const at = now(); let held = 0;
        const unfinished = all(`SELECT id, card_id, revoked FROM chat_submissions WHERE status IN ${unfinishedSubmissions}`);
        // Settled attempts keep their outcome, and an explicit save of an
        // output they already returned stays possible.
        run(`UPDATE chat_attempts SET status = 'interrupted', completed_at = ?, error = ?, revoked = COALESCE(revoked, 'restored'),
          cause = CASE WHEN revoked IS NULL THEN 'restored' ELSE COALESCE(cause, 'cancelled') END WHERE status IN ${unsettledAttempts}`,
        at, 'Restored from a backup. This attempt ended with the old workspace; nothing was resent.');
        run("UPDATE chat_requests SET status = 'invalidated' WHERE status = 'pending'");
        run("UPDATE chat_conversations SET grants = '[]' WHERE grants != '[]'");
        // A binding names the old workspace and native index, so exact native
        // resumption is not promised: new work continues in fresh context.
        run("UPDATE chat_conversations SET state = 'native-unavailable' WHERE state = 'active' AND binding IS NOT NULL");
        for (const row of unfinished) {
          if (row.revoked || get(`SELECT 1 FROM cards WHERE id = ? AND id IN ${closed}`, row.card_id)) {
            status(ctx, row.id, 'cancelled', 'Cancelled before the backup was restored.');
            continue;
          }
          run("UPDATE chat_submissions SET hold = 'restored', retry_at = NULL WHERE id = ?", row.id);
          status(ctx, row.id, 'held', restoredHoldReason);
          held++;
        }
        run("UPDATE chat_submissions SET revoked = 'restored' WHERE revoked IS NULL AND status != 'completed'");
        // Lane runs never apply a result here. A cancelled card's runs close.
        run(`UPDATE lane_runs SET status = 'cancelled', reason = 'Cancelled before the backup was restored.', updated_at = ? WHERE status IN ('pending', 'queued') AND card_id IN ${closed}`, at);
        run("UPDATE lane_runs SET status = 'held', reason = ?, updated_at = ? WHERE status IN ('pending', 'queued')", restoredRunReason, at);
        return { held };
      });
    },
    // Settles an unfinished or uncertain attempt from read-only native evidence.
    reconcile(ctx, id, result, reason, { nativeUnavailable = false, cause = null, turnId = null } = {}) {
      return transaction(() => {
        const a = attempt(id);
        if (!a || (!active.includes(a.status) && a.status !== 'uncertain')) return false;
        if (turnId) {
          if (a.turnId && a.turnId !== turnId) fail(409, 'The recovered native turn identity changed.');
          run('UPDATE chat_attempts SET turn_id = ? WHERE id = ?', turnId, id);
        }
        settleAttempt(ctx, a, result, reason, cause);
        if (nativeUnavailable) run("UPDATE chat_conversations SET state = 'native-unavailable' WHERE id = (SELECT conversation_id FROM chat_submissions WHERE id = ?) AND state != 'previous'", a.submissionId);
        return true;
      });
    },
    // Proven non-delivery only: the submission returns to the head of its card's
    // queue and its next attempt links to this one. A missing first-send thread
    // never persisted, so its binding is cleared for a new native conversation.
    notDelivered(ctx, id, reason, { unbind = false } = {}) {
      return transaction(() => {
        const a = attempt(id);
        if (!a || (!active.includes(a.status) && a.status !== 'uncertain')) return false;
        if (a.status === 'interrupt-requested' || ['user', 'cancelled'].includes(a.cause) || a.revoked) {
          settleAttempt(ctx, a, 'interrupted', 'Stopped before Codex accepted this prompt.');
          return true;
        }
        run("UPDATE chat_attempts SET status = 'not-delivered', completed_at = ?, error = ? WHERE id = ?", now(), reason, id);
        invalidateRequests(id);
        const { conversation_id: conversationId } = get('SELECT conversation_id FROM chat_submissions WHERE id = ?', a.submissionId);
        if (unbind && !this.conversationTurns(conversationId).length) run('UPDATE chat_conversations SET binding = NULL WHERE id = ?', conversationId);
        status(ctx, a.submissionId, 'queued', reason, 'submission_requeued');
        return true;
      });
    },
    // The user's explicit decision for an ambiguous delivery. It permits a
    // deliberate linked retry; nothing is resent automatically.
    resolve(ctx, cardId, attemptId) {
      retainedCard(ctx, cardId);
      return transaction(() => {
        const a = attempt(attemptId);
        if (!a || a.cardId !== cardId || a.status !== 'uncertain') fail(409, 'Only an uncertain delivery can be resolved.');
        settleAttempt(ctx, a, 'interrupted', 'Marked interrupted by the user. Codex may have received it; retry only deliberately.', 'resolved');
        return { ok: true };
      });
    },
    // Native turns Frameboard did not send. They are recorded, never imported,
    // and hold this prompt until the user continues or starts fresh context.
    holdOutside(ctx, id, turnIds) {
      return transaction(() => {
        const a = attempt(id);
        if (!a || !active.includes(a.status)) return false;
        const conversation = get('SELECT v.* FROM chat_conversations v JOIN chat_submissions s ON s.conversation_id = v.id WHERE s.id = ?', a.submissionId);
        run('UPDATE chat_conversations SET outside_turns = ? WHERE id = ?', JSON.stringify([...new Set([...JSON.parse(conversation.outside_turns), ...turnIds])]), conversation.id);
        const count = `${turnIds.length} turn${turnIds.length === 1 ? '' : 's'}`;
        this.item(ctx, id, { id: `outside-${turnIds[0]}`, kind: 'notice', text: `This conversation was continued outside Frameboard (${count}). Those turns are not shown or imported.`, completed: true });
        return this.hold(ctx, id, `This conversation was continued outside Frameboard (${count}). Those turns are not imported. Continue here, or start fresh context.`, { kind: 'outside' });
      });
    },
    continueOutside(ctx, cardId, submissionId) {
      requireCard(ctx, cardId);
      const row = requireSubmission(ctx, cardId, submissionId);
      if (row.status !== 'held' || row.hold !== 'outside' || row.conversation_id !== current(cardId).id) fail(409, 'Only a prompt held for outside native turns can continue here.');
      transaction(() => {
        run('UPDATE chat_submissions SET hold = NULL WHERE id = ?', submissionId);
        status(ctx, submissionId, 'queued', 'Continuing in this conversation after outside native turns.', 'submission_continued');
      });
      return { ok: true };
    },
    // Native identities Frameboard owns in one conversation.
    nativeIdentity(conversationId) {
      const rows = all('SELECT a.id, a.turn_id FROM chat_attempts a JOIN chat_submissions s ON s.id = a.submission_id WHERE s.conversation_id = ?', conversationId);
      const outside = JSON.parse(get('SELECT outside_turns FROM chat_conversations WHERE id = ?', conversationId).outside_turns);
      return { attemptIds: new Set(rows.map((row) => row.id)), turnIds: new Set([...rows.map((row) => row.turn_id).filter(Boolean), ...outside]) };
    },
    conversationTurns(conversationId) {
      return all('SELECT a.turn_id FROM chat_attempts a JOIN chat_submissions s ON s.id = a.submission_id WHERE s.conversation_id = ? AND a.turn_id IS NOT NULL', conversationId).map((row) => row.turn_id);
    },
    // A durable last-viewed marker. Clearing Done is recorded once so that
    // every other tab's stream learns of it; repeated views add nothing.
    viewed(ctx, cardId) {
      const row = ensure(ctx, cardId);
      transaction(() => {
        const unviewed = get("SELECT 1 FROM chat_submissions WHERE card_id = ? AND status = 'completed' AND (? IS NULL OR completed_at > ?) LIMIT 1", cardId, row.last_viewed_at, row.last_viewed_at);
        run('UPDATE card_chats SET last_viewed_at = ? WHERE card_id = ?', now(), cardId);
        if (unviewed) activity(ctx, cardId, 'chat_viewed');
      });
    },
    // Derived from durable rows only, so a restart rebuilds them. Priority:
    // Input needed > Needs attention > Working > Done. Deliberate Stop,
    // cancellation and resolution are the user's choices, not attention.
    indicators(ctx) {
      const entries = [];
      // Archived projects are out of active use; their chats need no attention.
      for (const row of all(`SELECT h.*, c.title, c.project_id, c.deleted_at FROM card_chats h JOIN cards c ON c.id = h.card_id
        JOIN projects p ON p.id = c.project_id WHERE h.workspace_id = ? AND p.archived_at IS NULL`, ctx.workspaceId)) {
        const a = activeAttempt(row.card_id);
        const pending = get("SELECT r.id FROM chat_requests r JOIN chat_attempts a ON a.id = r.attempt_id WHERE a.card_id = ? AND r.status = 'pending' LIMIT 1", row.card_id);
        const conversation = current(row.card_id);
        const submissions = all('SELECT * FROM chat_submissions WHERE card_id = ? AND conversation_id = ? ORDER BY sequence DESC', row.card_id, conversation.id);
        const lastCause = (s) => get('SELECT cause FROM chat_attempts WHERE submission_id = ? ORDER BY rowid DESC LIMIT 1', s.id)?.cause;
        const settled = submissions.find((s) => ['completed', 'failed', 'interrupted', 'cancelled'].includes(s.status));
        const attention = submissions.find((s) => ['held', 'uncertain'].includes(s.status))
          ?? (settled && (settled.status === 'failed' || (settled.status === 'interrupted' && !['user', 'cancelled', 'resolved'].includes(lastCause(settled)))) ? settled : null);
        const waiting = submissions.find((s) => s.status === 'waiting');
        const complete = get('SELECT 1 FROM chat_submissions WHERE card_id = ? AND status = ? AND (? IS NULL OR completed_at > ?) LIMIT 1', row.card_id, 'completed', row.last_viewed_at, row.last_viewed_at);
        const state = pending ? 'input-needed' : attention || conversation.state === 'native-unavailable' ? 'needs-attention'
          : a || waiting || submissions.some((s) => s.status === 'queued') ? 'working' : complete ? 'done' : 'idle';
        if (state !== 'idle') entries.push({ cardId: row.card_id, projectId: row.project_id, title: row.title, deleted: Boolean(row.deleted_at), state,
          startedAt: state === 'working' ? a?.startedAt ?? null : null, waitingForProvider: state === 'working' && !a && Boolean(waiting),
          requestId: pending?.id ?? null,
          reason: state === 'needs-attention' ? attention?.reason || 'Native context is unavailable. Its history is retained; start fresh context to continue.' : state === 'working' && !a && waiting ? waiting.reason : '' });
      }
      const priority = ['input-needed', 'needs-attention', 'working', 'done'];
      return entries.sort((a, b) => priority.indexOf(a.state) - priority.indexOf(b.state));
    },
  };
  return api;
}
