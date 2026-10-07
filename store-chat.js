// Durable card-chat state, exposed only through openStore(). Native work never
// happens here. All mutations use the board store's transaction and activity log.
import { randomUUID } from 'node:crypto';
import { defaultSelections, contextFields, selectedContext } from './public/chat-context.js';

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

const active = ['dispatching', 'accepted', 'running', 'interrupt-requested'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const check = (value, message) => { if (!value) fail(400, message); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const validId = (value) => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const conversationFrom = (row) => ({ id: row.id, cardId: row.card_id, provider: row.provider, model: row.model,
  state: row.state, binding: row.binding ? JSON.parse(row.binding) : null, grants: JSON.parse(row.grants), createdAt: row.created_at });
const submissionFrom = (row) => ({ ...JSON.parse(row.frozen), id: row.id, cardId: row.card_id,
  conversationId: row.conversation_id, status: row.status, reason: row.reason, createdAt: row.created_at, completedAt: row.completed_at });
const attemptFrom = (row) => row && ({ id: row.id, submissionId: row.submission_id, cardId: row.card_id,
  previousAttemptId: row.previous_attempt_id, status: row.status, turnId: row.turn_id, startedAt: row.started_at, completedAt: row.completed_at, error: row.error });

export function createChatStore({ all, get, run, transaction, retainedCard, requireCard, recordChange, now }) {
  function activity(ctx, cardId, type, data = {}) {
    const card = retainedCard(ctx, cardId);
    recordChange(ctx, 'chat', cardId, type, { projectId: card.project_id, data });
  }
  function current(cardId) { return conversationFrom(get("SELECT * FROM chat_conversations WHERE card_id = ? AND state != 'previous'", cardId)); }
  function newConversation(cardId, model) {
    const id = randomUUID();
    const position = get('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM chat_conversations WHERE card_id = ?', cardId).position;
    run("INSERT INTO chat_conversations (id, card_id, position, provider, model, state, created_at) VALUES (?, ?, ?, 'codex', ?, 'active', ?)", id, cardId, position, model, now());
    return current(cardId);
  }
  function ensure(ctx, cardId) {
    const card = retainedCard(ctx, cardId);
    if (!get('SELECT card_id FROM card_chats WHERE card_id = ?', cardId)) transaction(() => {
      run('INSERT INTO card_chats (card_id, workspace_id, composer) VALUES (?, ?, ?)', cardId, ctx.workspaceId,
        JSON.stringify({ prompt: '', model: null, selections: defaultSelections(card.template), authority: { fields: [] } }));
      newConversation(cardId, null);
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
    check(value.model === null || (text(value.model, 200) && value.model.trim()), 'Choose a Codex model.');
    const selections = value.selections;
    const fields = contextFields(card.template).map((field) => field.key);
    check(object(selections) && Array.isArray(selections.fields) && selections.fields.every((key) => fields.includes(key))
      && selections.fields.length <= fields.length, 'Invalid context fields.');
    check(Array.isArray(selections.roles) && selections.roles.length <= 3 && selections.roles.every((role) => ['original', 'inspiration', 'cover'].includes(role)), 'Invalid image roles.');
    check(Array.isArray(selections.images) && selections.images.length <= 200 && selections.images.every((id) => text(id, 100)), 'Invalid image references.');
    check(object(value.authority) && Array.isArray(value.authority.fields) && value.authority.fields.length <= fields.length
      && value.authority.fields.every((key) => fields.includes(key)), 'Invalid text authority.');
    return { prompt: value.prompt, model: value.model, selections: { fields: [...new Set(selections.fields)], roles: [...new Set(selections.roles)], images: [...new Set(selections.images)] },
      authority: { fields: [...new Set(value.authority.fields)] } };
  }
  function activeAttempt(cardId) {
    return attemptFrom(get("SELECT * FROM chat_attempts WHERE card_id = ? AND status IN ('dispatching', 'accepted', 'running', 'interrupt-requested')", cardId));
  }
  function invalidateRequests(attemptId) { run("UPDATE chat_requests SET status = 'invalidated' WHERE attempt_id = ? AND status = 'pending'", attemptId); }
  function status(ctx, id, value, reason = '') {
    run('UPDATE chat_submissions SET status = ?, reason = ?, completed_at = ? WHERE id = ?', value, reason,
      ['completed', 'failed', 'interrupted', 'cancelled'].includes(value) ? now() : null, id);
    const row = get('SELECT card_id FROM chat_submissions WHERE id = ?', id);
    activity(ctx, row.card_id, `submission_${value}`, { submissionId: id, reason });
  }
  function settleAttempt(ctx, a, result, reason) {
    const value = a.status === 'interrupt-requested' && result !== 'uncertain' ? 'interrupted' : result;
    run('UPDATE chat_attempts SET status = ?, completed_at = ?, error = ? WHERE id = ?', value, now(), reason, a.id);
    invalidateRequests(a.id);
    status(ctx, a.submissionId, value, reason);
    return value;
  }
  function requestInterruption(ctx, a, reason) {
    run("UPDATE chat_attempts SET status = 'interrupt-requested' WHERE id = ?", a.id);
    invalidateRequests(a.id);
    status(ctx, a.submissionId, 'interrupt-requested', reason);
    return { ...a, status: 'interrupt-requested' };
  }
  const api = {
    snapshot(ctx, cardId) {
      const row = ensure(ctx, cardId);
      const card = retainedCard(ctx, cardId);
      return { cardId, deleted: Boolean(card.deleted_at), composer: { ...JSON.parse(row.composer), revision: row.composer_revision },
        conversations: all('SELECT * FROM chat_conversations WHERE card_id = ? ORDER BY position', cardId).map(conversationFrom),
        submissions: all('SELECT * FROM chat_submissions WHERE card_id = ? ORDER BY sequence', cardId).map(submissionFrom),
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
      if (composer.model !== JSON.parse(row.composer).model && activeAttempt(cardId)) fail(409, 'Wait for the active response to finish or Stop it before changing model.');
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
      return { cardRevision: card.revision, composerRevision: row.composer_revision, conversationId: current(cardId).id,
        prompt: JSON.parse(row.composer).prompt, model: JSON.parse(row.composer).model,
        authority: JSON.parse(row.composer).authority, context: selectedContext(card, JSON.parse(row.composer).selections, versions,
          all("SELECT image_id AS id, name, id AS outputId FROM chat_outputs WHERE card_id = ? AND import_status = 'imported'", cardId)) };
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
      if (row.composer_revision !== input.composerRevision || captured.composerRevision !== row.composer_revision || captured.cardRevision !== card.revision
        || captured.conversationId !== current(cardId).id) fail(409, 'The card, composer or conversation changed while preparing Send. Review and send again.');
      check(captured.prompt.trim() && captured.model, 'Write a prompt and explicitly choose a model before sending.');
      return transaction(() => {
        const conversation = current(cardId);
        const frozen = { prompt: captured.prompt, context: captured.context, provider: 'codex', model: captured.model, configuration, authority: captured.authority };
        run('INSERT INTO chat_submissions (id, card_id, conversation_id, frozen, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          input.id, cardId, conversation.id, JSON.stringify(frozen), 'queued', now());
        const composer = JSON.parse(row.composer);
        run('UPDATE card_chats SET composer = ?, composer_revision = composer_revision + 1 WHERE card_id = ?', JSON.stringify({ ...composer, prompt: '' }), cardId);
        activity(ctx, cardId, 'submission_queued', { submissionId: input.id, conversationId: conversation.id, model: frozen.model });
        return this.findSubmission(ctx, cardId, input.id);
      });
    },
    ready(ctx) {
      return all(`SELECT s.* FROM chat_submissions s JOIN card_chats h ON h.card_id = s.card_id
        JOIN cards c ON c.id = s.card_id JOIN chat_conversations v ON v.id = s.conversation_id
        WHERE h.workspace_id = ? AND c.deleted_at IS NULL AND s.status = 'queued' AND v.state = 'active'
        AND NOT EXISTS (SELECT 1 FROM chat_submissions earlier WHERE earlier.card_id = s.card_id AND earlier.sequence < s.sequence
          AND earlier.status IN ('queued', 'held', 'dispatching', 'running', 'interrupt-requested', 'uncertain'))
        AND NOT EXISTS (SELECT 1 FROM chat_attempts a WHERE a.card_id = s.card_id AND a.status IN ('dispatching', 'accepted', 'running', 'interrupt-requested'))
        ORDER BY s.sequence`, ctx.workspaceId).map(submissionFrom);
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
        if (a.status !== 'interrupt-requested') status(ctx, a.submissionId, 'running');
        return true;
      });
    },
    finish(ctx, id, result, reason = '') {
      return transaction(() => {
        const a = attempt(id);
        if (!a || !active.includes(a.status)) return false;
        const value = settleAttempt(ctx, a, result, reason);
        if (value === 'uncertain') {
          run("UPDATE chat_conversations SET state = 'native-unavailable' WHERE id = (SELECT conversation_id FROM chat_submissions WHERE id = ?)", a.submissionId);
        }
        return true;
      });
    },
    hold(ctx, id, reason, nativeUnavailable = false) {
      return transaction(() => {
        const a = attempt(id);
        if (!a || !active.includes(a.status)) return false;
        run("UPDATE chat_attempts SET status = 'held', completed_at = ?, error = ? WHERE id = ?", now(), reason, id);
        invalidateRequests(id);
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
        run(`INSERT INTO chat_items (attempt_id, native_id, kind, text, data, completed) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (attempt_id, native_id) DO UPDATE SET kind = excluded.kind, text = excluded.text, data = excluded.data,
          completed = MAX(chat_items.completed, excluded.completed)`, id, item.id, item.kind, item.text ?? '', JSON.stringify(item.data ?? {}), Number(Boolean(item.completed)));
        activity(ctx, a.cardId, 'transcript_updated', { attemptId: id, itemId: item.id });
      });
    },
    request(ctx, id, request) {
      return transaction(() => {
        const a = attempt(id);
        if (!a || !['dispatching', 'accepted', 'running'].includes(a.status)) return null;
        const requestId = `${id}:${request.requestId}`;
        run('INSERT OR IGNORE INTO chat_requests (id, attempt_id, native_id, method, params, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
        return requestInterruption(ctx, a, 'Stopped by the user.');
      });
    },
    cancelSubmission(ctx, cardId, id) {
      const row = requireSubmission(ctx, cardId, id);
      if (!['queued', 'held'].includes(row.status)) fail(409, 'Only queued or held submissions can be cancelled here. Stop active work first.');
      transaction(() => status(ctx, id, 'cancelled', 'Cancelled by the user.'));
    },
    retry(ctx, cardId, id) {
      requireCard(ctx, cardId);
      const row = requireSubmission(ctx, cardId, id);
      if (!['failed', 'interrupted'].includes(row.status) || row.conversation_id !== current(cardId).id
        || current(cardId).state !== 'active' || activeAttempt(cardId)) fail(409, 'Retry requires a terminal attempt in the current, available conversation. Reconcile uncertainty before retrying.');
      transaction(() => status(ctx, id, 'queued', 'Explicitly retried by the user with the original frozen inputs.'));
      return submissionFrom(get('SELECT * FROM chat_submissions WHERE id = ?', id));
    },
    cancelCard(ctx, cardId, reason) {
      return transaction(() => {
        for (const row of all("SELECT id FROM chat_submissions WHERE card_id = ? AND status IN ('queued', 'held')", cardId)) status(ctx, row.id, 'cancelled', reason);
        const a = activeAttempt(cardId);
        if (a) requestInterruption(ctx, a, reason);
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
        const queued = all("SELECT id FROM chat_submissions WHERE conversation_id = ? AND status IN ('queued', 'held')", old.id);
        if (queued.length && input.cancelQueued !== true) fail(409, 'Explicitly cancel the old queued submissions before starting fresh context.');
        for (const submission of queued) status(ctx, submission.id, 'cancelled', 'Cancelled for empty fresh context.');
        run("UPDATE chat_conversations SET state = 'previous' WHERE id = ?", old.id);
        const next = newConversation(cardId, JSON.parse(row.composer).model);
        activity(ctx, cardId, 'fresh_context', { previousConversationId: old.id, conversationId: next.id });
        return this.snapshot(ctx, cardId);
      });
    },
    unfinished(ctx) {
      return all(`SELECT a.* FROM chat_attempts a JOIN card_chats h ON h.card_id = a.card_id
        WHERE h.workspace_id = ? AND a.status IN ('dispatching', 'accepted', 'running', 'interrupt-requested', 'uncertain')`, ctx.workspaceId)
        .map((row) => ({ attempt: attemptFrom(row), submission: submissionFrom(get('SELECT * FROM chat_submissions WHERE id = ?', row.submission_id)),
          conversation: conversationFrom(get('SELECT v.* FROM chat_conversations v JOIN chat_submissions s ON s.conversation_id = v.id WHERE s.id = ?', row.submission_id)) }));
    },
    invalidateAfterRestart(ctx) {
      transaction(() => {
        run("UPDATE chat_requests SET status = 'invalidated' WHERE status = 'pending' AND attempt_id IN (SELECT a.id FROM chat_attempts a JOIN card_chats h ON h.card_id = a.card_id WHERE h.workspace_id = ?)", ctx.workspaceId);
      });
    },
    reconcile(ctx, id, result, reason, nativeUnavailable = false) {
      return transaction(() => {
        const a = attempt(id);
        if (!a || (!active.includes(a.status) && a.status !== 'uncertain')) return;
        const value = settleAttempt(ctx, a, result, reason);
        run("UPDATE chat_conversations SET state = ? WHERE id = (SELECT conversation_id FROM chat_submissions WHERE id = ?) AND state != 'previous'", value === 'uncertain' || nativeUnavailable ? 'native-unavailable' : 'active', a.submissionId);
      });
    },
    viewed(ctx, cardId) {
      ensure(ctx, cardId);
      transaction(() => run('UPDATE card_chats SET last_viewed_at = ? WHERE card_id = ?', now(), cardId));
    },
    indicators(ctx) {
      const entries = [];
      for (const row of all('SELECT h.*, c.title, c.project_id, c.deleted_at FROM card_chats h JOIN cards c ON c.id = h.card_id WHERE h.workspace_id = ?', ctx.workspaceId)) {
        const a = activeAttempt(row.card_id);
        const pending = get("SELECT r.id FROM chat_requests r JOIN chat_attempts a ON a.id = r.attempt_id WHERE a.card_id = ? AND r.status = 'pending' LIMIT 1", row.card_id);
        const submissions = all('SELECT * FROM chat_submissions WHERE card_id = ? ORDER BY sequence DESC', row.card_id);
        const conversation = current(row.card_id);
        const attention = submissions.find((s) => s.conversation_id === conversation.id && ['held', 'failed', 'uncertain'].includes(s.status));
        const complete = submissions.find((s) => s.status === 'completed' && (!row.last_viewed_at || s.completed_at > row.last_viewed_at));
        const state = pending ? 'input-needed' : attention || conversation.state === 'native-unavailable' ? 'needs-attention'
          : a || submissions.some((s) => s.status === 'queued') ? 'working' : complete ? 'done' : 'idle';
        if (state !== 'idle') entries.push({ cardId: row.card_id, projectId: row.project_id, title: row.title, deleted: Boolean(row.deleted_at), state,
          startedAt: a?.startedAt ?? null, reason: attention?.reason ?? '' });
      }
      const priority = ['input-needed', 'needs-attention', 'working', 'done'];
      return entries.sort((a, b) => priority.indexOf(a.state) - priority.indexOf(b.state));
    },
  };
  return api;
}
