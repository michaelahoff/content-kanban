// Durable project-chat state: one chat per project, its conversations (one
// native session each), the turns the user sent and the transcript items a
// turn produced. Native work never happens here; project-chat.js drives it.
// Exposed only through openStore() as store.projectChats.
import { randomUUID } from 'node:crypto';
import { archivedMessage } from './store-chat.js';

// IF NOT EXISTS: a database laid out as an older version for an upgrade test
// may already hold these tables.
export const projectChatsMigration = `
  CREATE TABLE IF NOT EXISTS project_chats (project_id TEXT PRIMARY KEY REFERENCES projects(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    provider TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS project_chat_conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project_chats(project_id),
    position INTEGER NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL, binding TEXT, configuration TEXT, created_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS project_chat_current ON project_chat_conversations(project_id) WHERE state = 'active';
  CREATE TABLE IF NOT EXISTS project_chat_turns (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES project_chats(project_id), conversation_id TEXT NOT NULL REFERENCES project_chat_conversations(id),
    prompt TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL, model TEXT, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
    native_turn_id TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
  CREATE INDEX IF NOT EXISTS project_chat_turns_by_project ON project_chat_turns(project_id, sequence);
  CREATE TABLE IF NOT EXISTS project_chat_items (sequence INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL REFERENCES project_chat_turns(id),
    native_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL, completed INTEGER NOT NULL, UNIQUE (turn_id, native_id));
  CREATE TABLE IF NOT EXISTS project_chat_tool_calls (turn_id TEXT NOT NULL REFERENCES project_chat_turns(id), call_id TEXT NOT NULL, tool TEXT NOT NULL,
    arguments TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (turn_id, call_id));
`;

export const unfinishedTurnStatuses = ['queued', 'running', 'interrupt-requested'];
const finalStatuses = ['completed', 'failed', 'interrupted'];
const providers = ['codex', 'claude'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const check = (value, message) => { if (!value) fail(400, message); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const conversationFrom = (row) => row && ({ id: row.id, projectId: row.project_id, provider: row.provider, state: row.state, binding: row.binding ? JSON.parse(row.binding) : null,
  configuration: row.configuration ? JSON.parse(row.configuration) : null, createdAt: row.created_at });
const turnFrom = (row) => row && ({ id: row.id, projectId: row.project_id, conversationId: row.conversation_id, prompt: row.prompt, context: row.context, provider: row.provider, model: row.model,
  status: row.status, reason: row.reason, nativeTurnId: row.native_turn_id, createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at });

export function createProjectChatStore({ all, get, run, transaction, recordChange, now, requireProject }) {
  const activity = (ctx, projectId, type, data = {}) => recordChange(ctx, 'project-chat', projectId, type, { projectId, data });
  const current = (projectId) => conversationFrom(get("SELECT * FROM project_chat_conversations WHERE project_id = ? AND state = 'active'", projectId));
  const turn = (id) => turnFrom(get('SELECT * FROM project_chat_turns WHERE id = ?', id));
  const active = (projectId) => turnFrom(get(`SELECT * FROM project_chat_turns WHERE project_id = ? AND status IN (${unfinishedTurnStatuses.map(() => '?').join(', ')}) ORDER BY sequence LIMIT 1`, projectId, ...unfinishedTurnStatuses));
  function newConversation(projectId, provider) {
    const id = randomUUID();
    const position = get('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM project_chat_conversations WHERE project_id = ?', projectId).position;
    run("INSERT INTO project_chat_conversations (id, project_id, position, provider, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)", id, projectId, position, provider, now());
    return current(projectId);
  }
  // The chat row, created on first use with the provider card chats default to.
  function ensure(ctx, projectId) {
    const project = requireProject(ctx, projectId, { allowArchived: true });
    if (!get('SELECT project_id FROM project_chats WHERE project_id = ?', projectId)) transaction(() => {
      const settings = Object.fromEntries(all('SELECT provider, selection FROM provider_configurations WHERE workspace_id = ?', ctx.workspaceId).map((row) => [row.provider, JSON.parse(row.selection)]));
      const provider = settings.codex?.enabled === false && settings.claude?.enabled === true ? 'claude' : 'codex';
      run('INSERT INTO project_chats (project_id, workspace_id, provider, created_at) VALUES (?, ?, ?, ?)', projectId, ctx.workspaceId, provider, now());
      newConversation(projectId, provider);
    });
    return { ...get('SELECT * FROM project_chats WHERE project_id = ?', projectId), archived: Boolean(project.archived_at) };
  }
  const api = {
    current, turn, active, unfinishedTurnStatuses,
    conversation: (id) => conversationFrom(get('SELECT * FROM project_chat_conversations WHERE id = ?', id)),
    snapshot(ctx, projectId) {
      const row = ensure(ctx, projectId);
      return { projectId, archived: row.archived, provider: row.provider, model: row.model,
        conversations: all('SELECT * FROM project_chat_conversations WHERE project_id = ? ORDER BY position', projectId).map((entry) => {
          const { binding, configuration, ...conversation } = conversationFrom(entry);
          return { ...conversation, bound: Boolean(binding) };
        }),
        turns: all('SELECT * FROM project_chat_turns WHERE project_id = ? ORDER BY sequence', projectId).map((entry) => { const { context, ...rest } = turnFrom(entry); return rest; }),
        items: all('SELECT i.* FROM project_chat_items i JOIN project_chat_turns t ON t.id = i.turn_id WHERE t.project_id = ? ORDER BY i.sequence', projectId)
          .map((item) => ({ sequence: item.sequence, turnId: item.turn_id, nativeId: item.native_id, kind: item.kind, text: item.text, data: JSON.parse(item.data), completed: Boolean(item.completed) })),
        busy: Boolean(active(projectId)) };
    },
    saveSettings(ctx, projectId, input) {
      check(object(input), 'Choose a provider and model.');
      check(input.provider === undefined || providers.includes(input.provider), 'Unknown chat provider.');
      check(input.model === undefined || input.model === null || (typeof input.model === 'string' && input.model.trim() && input.model.length <= 200), 'Choose a model.');
      const row = ensure(ctx, projectId);
      requireProject(ctx, projectId);
      return transaction(() => {
        const provider = input.provider ?? row.provider;
        const model = input.model === undefined ? (provider === row.provider ? row.model : null) : input.model;
        run('UPDATE project_chats SET provider = ?, model = ? WHERE project_id = ?', provider, model, projectId);
        if (provider !== row.provider || model !== row.model) activity(ctx, projectId, 'settings_saved');
        return { provider, model };
      });
    },
    // A turn the user sent. One at a time per project; a provider other than
    // the current conversation's needs fresh context once it has been used.
    queue(ctx, projectId, { id, prompt, context = '', provider, model = null }) {
      check(validId(id), 'A browser turn ID is required.');
      check(typeof prompt === 'string' && prompt.trim() && prompt.length <= 200000, 'Write a message of up to 200,000 characters.');
      check(providers.includes(provider), 'Unknown chat provider.');
      check(model === null || (typeof model === 'string' && model.trim() && model.length <= 200), 'Choose a model.');
      const existing = turn(id);
      if (existing) { check(existing.projectId === projectId, 'This turn ID belongs to another project.'); return existing; }
      ensure(ctx, projectId);
      requireProject(ctx, projectId);
      return transaction(() => {
        if (active(projectId)) fail(409, 'Wait for the current reply to finish, or Stop it, before sending another message.');
        const conversation = current(projectId);
        if (conversation.provider !== provider) {
          if (conversation.binding || get('SELECT id FROM project_chat_turns WHERE conversation_id = ? LIMIT 1', conversation.id)) fail(409, 'Start fresh context before switching providers. The earlier conversation is kept.');
          run('UPDATE project_chat_conversations SET provider = ? WHERE id = ?', provider, conversation.id);
        }
        run('INSERT INTO project_chat_turns (id, project_id, conversation_id, prompt, context, provider, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, projectId, conversation.id, prompt, context, provider, model, 'queued', now());
        run('UPDATE project_chats SET provider = ?, model = ? WHERE project_id = ?', provider, model, projectId);
        activity(ctx, projectId, 'turn_queued', { turnId: id });
        return turn(id);
      });
    },
    queued: (ctx) => all("SELECT t.* FROM project_chat_turns t JOIN project_chats c ON c.project_id = t.project_id JOIN projects p ON p.id = t.project_id WHERE c.workspace_id = ? AND t.status = 'queued' AND p.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY t.sequence", ctx.workspaceId).map(turnFrom),
    setModel(ctx, id, model) { transaction(() => { run('UPDATE project_chat_turns SET model = ? WHERE id = ?', model, id); run('UPDATE project_chats SET model = ? WHERE project_id = (SELECT project_id FROM project_chat_turns WHERE id = ?)', model, id); }); },
    start(ctx, id) {
      return transaction(() => {
        const row = turn(id);
        if (row?.status !== 'queued') return false;
        run("UPDATE project_chat_turns SET status = 'running', started_at = ? WHERE id = ?", now(), id);
        activity(ctx, row.projectId, 'turn_running', { turnId: id });
        return true;
      });
    },
    nativeTurnIds: (conversationId) => all('SELECT native_turn_id FROM project_chat_turns WHERE conversation_id = ? AND native_turn_id IS NOT NULL', conversationId).map((row) => row.native_turn_id),
    nativeTurn(ctx, id, nativeTurnId) { transaction(() => run('UPDATE project_chat_turns SET native_turn_id = COALESCE(native_turn_id, ?) WHERE id = ?', nativeTurnId, id)); },
    bind(ctx, conversationId, binding, configuration) {
      transaction(() => {
        const existing = get('SELECT binding FROM project_chat_conversations WHERE id = ?', conversationId)?.binding;
        if (existing && existing !== JSON.stringify(binding)) fail(409, 'The native conversation binding changed.');
        run('UPDATE project_chat_conversations SET binding = ?, configuration = COALESCE(configuration, ?) WHERE id = ?', JSON.stringify(binding), JSON.stringify(configuration), conversationId);
      });
    },
    requestStop(ctx, id) {
      return transaction(() => {
        const row = turn(id);
        if (!row || !['queued', 'running'].includes(row.status)) return row;
        run("UPDATE project_chat_turns SET status = 'interrupt-requested' WHERE id = ?", id);
        activity(ctx, row.projectId, 'turn_stopping', { turnId: id });
        return turn(id);
      });
    },
    finish(ctx, id, status, reason = '') {
      check(finalStatuses.includes(status), 'Unknown turn outcome.');
      return transaction(() => {
        const row = turn(id);
        if (!row || !unfinishedTurnStatuses.includes(row.status)) return false;
        // A Stop that arrives as the reply completes still counts as stopped.
        const outcome = row.status === 'interrupt-requested' && status !== 'failed' ? 'interrupted' : status;
        run('UPDATE project_chat_turns SET status = ?, reason = ?, completed_at = ? WHERE id = ?', outcome, reason, now(), id);
        activity(ctx, row.projectId, `turn_${outcome}`, { turnId: id, reason });
        return true;
      });
    },
    // Upsert by (turn, native item): repeated or out-of-order events never
    // duplicate an item or replace a completed item with partial content.
    item(ctx, turnId, item) {
      transaction(() => {
        const row = turn(turnId);
        if (!row) return;
        const { changes } = run(`INSERT INTO project_chat_items (turn_id, native_id, kind, text, data, completed) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (turn_id, native_id) DO UPDATE SET kind = excluded.kind, text = excluded.text, data = excluded.data,
          completed = MAX(project_chat_items.completed, excluded.completed)
          WHERE (excluded.completed OR NOT project_chat_items.completed)
            AND (project_chat_items.text IS NOT excluded.text OR project_chat_items.data IS NOT excluded.data OR project_chat_items.completed IS NOT excluded.completed)`,
        turnId, item.id, item.kind, item.text ?? '', JSON.stringify(item.data ?? {}), Number(Boolean(item.completed)));
        if (changes) activity(ctx, row.projectId, 'transcript_updated', { turnId, itemId: item.id });
      });
    },
    // A repeated tool call with the same identity gets its first result.
    receipt(turnId, callId, tool, input) {
      const row = get('SELECT * FROM project_chat_tool_calls WHERE turn_id = ? AND call_id = ?', turnId, callId);
      if (!row) return null;
      if (row.tool !== tool || row.arguments !== JSON.stringify(input)) fail(409, 'This tool call identity already has a different payload.');
      return JSON.parse(row.result);
    },
    recordCall(ctx, turnId, callId, tool, input, result) {
      transaction(() => {
        const row = turn(turnId);
        run('INSERT OR IGNORE INTO project_chat_tool_calls VALUES (?, ?, ?, ?, ?, ?)', turnId, callId, tool, JSON.stringify(input), JSON.stringify(result), now());
        activity({ ...ctx, actor: `automation:project-chat:${turnId}` }, row.projectId, 'tool_called', { turnId, tool, callId });
      });
    },
    fresh(ctx, projectId) {
      const row = ensure(ctx, projectId);
      requireProject(ctx, projectId);
      return transaction(() => {
        if (active(projectId)) fail(409, 'Wait for the reply to finish, or Stop it, before starting fresh context.');
        const old = current(projectId);
        run("UPDATE project_chat_conversations SET state = 'previous' WHERE id = ?", old.id);
        const next = newConversation(projectId, row.provider);
        activity(ctx, projectId, 'fresh_context', { previousConversationId: old.id, conversationId: next.id });
        return api.snapshot(ctx, projectId);
      });
    },
    // The configuration a conversation froze no longer applies (Settings or
    // the flow builder changed): the turn moves to a new conversation and the
    // old one is kept as history.
    rotate(ctx, turnId) {
      return transaction(() => {
        const row = turn(turnId);
        const old = current(row.projectId);
        run("UPDATE project_chat_conversations SET state = 'previous' WHERE id = ?", old.id);
        const next = newConversation(row.projectId, row.provider);
        run('UPDATE project_chat_turns SET conversation_id = ? WHERE id = ?', next.id, turnId);
        activity(ctx, row.projectId, 'fresh_context', { previousConversationId: old.id, conversationId: next.id, turnId, reason: 'configuration-changed' });
        return next;
      });
    },
    // After a restart nothing resumes: an unfinished turn ends, its
    // conversation stays bound, and the next message continues it.
    interruptAll(ctx, reason) {
      transaction(() => {
        for (const row of all(`SELECT t.* FROM project_chat_turns t JOIN project_chats c ON c.project_id = t.project_id WHERE c.workspace_id = ? AND t.status IN (${unfinishedTurnStatuses.map(() => '?').join(', ')})`, ctx.workspaceId, ...unfinishedTurnStatuses)) {
          run("UPDATE project_chat_turns SET status = 'interrupted', reason = ?, completed_at = ? WHERE id = ?", reason, now(), row.id);
          activity({ ...ctx, actor: 'system:restart' }, row.project_id, 'turn_interrupted', { turnId: row.id, reason });
        }
      });
    },
    archivedMessage,
  };
  return api;
}
