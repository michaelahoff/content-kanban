// One on-demand installed app-server. Native authentication/state remain owned
// by Codex; the caller owns durable bindings, submissions and request decisions.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';

export class CodexError extends Error {
  constructor(kind, message, details = {}) { super(message); this.kind = kind; Object.assign(this, details); }
}
const unavailable = (message) => new CodexError('configuration-unavailable', message);

export function createCodexAdapter({
  command = 'codex', args = ['app-server'], env = process.env, cwd = process.cwd(),
  requestTimeoutMs = 60000, clientVersion = '0',
} = {}) {
  let session = null;
  const listeners = new Map();
  const bindings = new Map();
  const sequences = new Map();
  function emit(threadId, event) {
    if (!threadId) return;
    const seq = (sequences.get(threadId) ?? 0) + 1;
    sequences.set(threadId, seq);
    for (const handlers of listeners.get(threadId) ?? []) {
      try { handlers.onEvent?.({ ...event, threadId, seq }); } catch { /* A view cannot break transport. */ }
    }
  }
  function invalidate(current, threadId, turnId) {
    for (const [id, pending] of current.incoming) {
      if (pending.threadId === threadId && (!turnId || pending.turnId === turnId)) {
        current.incoming.delete(id);
        emit(threadId, { type: 'request-invalidated', turnId: pending.turnId, requestId: id });
      }
    }
  }
  function startSession() {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const current = { child, pending: new Map(), incoming: new Map(), threads: new Set(), nextId: 1, exited: false };
    const ended = (error) => {
      if (current.exited) return;
      current.exited = true;
      if (session === current) session = null;
      for (const { reject, timer } of current.pending.values()) { clearTimeout(timer); reject(error); }
      current.pending.clear();
      for (const threadId of current.threads) {
        invalidate(current, threadId);
        const binding = bindings.get(threadId);
        emit(threadId, { type: 'process-exited', turnId: binding?.turnId ?? null, error });
        if (binding) binding.turnId = null;
      }
    };
    current.end = ended;
    const write = (message) => {
      if (current.exited) throw new CodexError('process-exited', 'The Codex app-server stopped.');
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) { ended(new CodexError('process-exited', error.message)); child.kill(); }
      });
    };
    child.on('error', (error) => ended(new CodexError('unavailable', `Codex could not be started: ${error.message}`)));
    child.on('exit', (code, signal) => ended(new CodexError('process-exited', `The Codex app-server stopped (${signal ?? `exit ${code}`}).`)));
    child.stdin.on('error', () => {});
    createInterface({ input: child.stderr }).on('line', () => {});
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (current.exited) return;
      let message;
      try { message = JSON.parse(line); } catch {
        ended(new CodexError('protocol', 'Codex sent malformed JSON.')); child.kill(); return;
      }
      if (message.id !== undefined && message.method === undefined) {
        const pending = current.pending.get(message.id);
        if (!pending) return;
        current.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new CodexError(/no rollout found|thread not found|thread not loaded/.test(message.error.message) ? 'native-unavailable' : 'rpc', message.error.message, { code: message.error.code }));
        else pending.resolve(message.result);
      } else if (message.id !== undefined) {
        const { threadId, turnId } = message.params ?? {};
        const token = { threadId, turnId };
        current.incoming.set(message.id, token);
        const respond = (result) => {
          if (current.exited || current.incoming.get(message.id) !== token) throw new CodexError('request-expired', 'This native request is no longer pending.');
          current.incoming.delete(message.id);
          write({ jsonrpc: '2.0', id: message.id, result });
        };
        const handlers = [...(listeners.get(threadId) ?? [])];
        emit(threadId, { type: 'request', turnId, requestId: message.id, method: message.method, params: message.params });
        const handler = handlers.find((h) => (!h.acceptsRequest || h.acceptsRequest(message.params)) && (message.method === 'item/tool/call' ? h.onToolCall : h.onRequest));
        const deny = () => {
          if (!current.incoming.has(message.id)) return;
          if (message.method === 'item/tool/call') respond({ success: false, contentItems: [{ type: 'inputText', text: 'Frameboard has no handler for this tool.' }] });
          else if (/requestApproval$/.test(message.method) && !/permissions/.test(message.method)) respond({ decision: 'decline' });
          else { current.incoming.delete(message.id); write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Frameboard cannot handle this request.' } }); }
        };
        if (!handler) deny();
        else Promise.resolve().then(() => (message.method === 'item/tool/call' ? handler.onToolCall : handler.onRequest)({ requestId: message.id, method: message.method, ...message.params, respond }))
          .then((result) => { if (result !== undefined && current.incoming.has(message.id)) respond(result); }, deny);
      } else {
        const p = message.params ?? {};
        const threadId = p.threadId ?? p.thread?.id;
        const turnId = p.turnId ?? p.turn?.id;
        if (message.method === 'turn/started') {
          const binding = bindings.get(threadId); if (binding) binding.turnId = turnId;
          emit(threadId, { type: 'turn-started', turnId, turn: p.turn });
        } else if (message.method === 'turn/completed') {
          const binding = bindings.get(threadId); if (binding?.turnId === turnId) binding.turnId = null;
          invalidate(current, threadId, turnId);
          emit(threadId, { type: 'turn-completed', turnId, status: p.turn.status, error: p.turn.error, turn: p.turn });
        } else if (message.method === 'item/agentMessage/delta') emit(threadId, { type: 'delta', turnId, itemId: p.itemId, delta: p.delta });
        else if (message.method === 'item/started' || message.method === 'item/completed') {
          emit(threadId, { type: message.method === 'item/started' ? 'item-started' : 'item-completed', turnId, item: p.item });
          if (message.method === 'item/completed' && p.item.type === 'imageGeneration') emit(threadId, { type: 'artifact', turnId, itemId: p.item.id, provider: 'codex', nativeKind: 'imageGeneration', status: p.item.status, result: p.item.result, savedPath: p.item.savedPath ?? null, revisedPrompt: p.item.revisedPrompt ?? null });
        } else {
          emit(threadId, { type: message.method === 'model/rerouted' ? 'target-unavailable' : 'notification', turnId, method: message.method, params: p });
          if (message.method === 'model/rerouted') {
            const binding = bindings.get(threadId); if (binding) binding.blocked = 'Codex rerouted the selected model.';
            current.request('turn/interrupt', { threadId, turnId }).catch(() => {});
          }
        }
      }
    });
    current.request = (method, params) => new Promise((resolve, reject) => {
      if (current.exited) { reject(new CodexError('process-exited', 'The Codex app-server stopped.')); return; }
      const id = current.nextId++;
      const timer = setTimeout(() => {
        current.pending.delete(id);
        reject(new CodexError('timeout', `Codex did not answer ${method} in time. Delivery may be uncertain.`, { method }));
      }, requestTimeoutMs);
      current.pending.set(id, { resolve, reject, timer });
      write({ jsonrpc: '2.0', id, method, params });
    });
    current.ready = current.request('initialize', {
      clientInfo: { name: 'frameboard', title: 'Frameboard', version: clientVersion }, capabilities: { experimentalApi: true },
    }).then((result) => { write({ jsonrpc: '2.0', method: 'initialized' }); return result; });
    current.ready.catch(() => { child.kill(); });
    return current;
  }
  async function connection() {
    session ??= startSession(); const current = session; await current.ready; return current;
  }
  const request = async (method, params) => (await connection()).request(method, params);
  async function pages(method, params) {
    const data = []; let cursor; const seen = new Set();
    do {
      const page = await request(method, { ...params, ...(cursor ? { cursor } : {}) });
      data.push(...page.data); cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new CodexError('protocol', 'Codex repeated a discovery cursor.');
      seen.add(cursor);
    } while (cursor);
    return data;
  }
  async function requireModel(model) {
    if (!model || !(await pages('model/list', { includeHidden: false })).some((entry) => !entry.hidden && entry.id === model)) throw new CodexError('model-unavailable', `The selected Codex model ${model ?? '(none)'} is unavailable. Select an available model explicitly.`);
  }
  const api = {
    get running() { return Boolean(session && !session.exited); },
    subscribe(threadId, handlers) {
      if (!listeners.has(threadId)) listeners.set(threadId, new Set());
      listeners.get(threadId).add(handlers);
      return () => { listeners.get(threadId)?.delete(handlers); if (!listeners.get(threadId)?.size) listeners.delete(threadId); };
    },
    async discover({ cwd: work = cwd } = {}) {
      const current = await connection(); const harness = await current.ready;
      const [models, skills, config, hooks, plugins, mcpServers, requirements] = await Promise.all([
        pages('model/list', { includeHidden: false }), current.request('skills/list', { cwds: [work], forceReload: true }),
        current.request('config/read', { cwd: work, includeLayers: false }), current.request('hooks/list', { cwds: [work] }),
        current.request('plugin/installed', {}), pages('mcpServerStatus/list', {}), current.request('configRequirements/read', null),
      ]);
      return {
        cwd: work, harness: { userAgent: harness.userAgent, codexHome: harness.codexHome },
        models: models.filter((m) => !m.hidden).map((m) => ({ id: m.id, displayName: m.displayName, isDefault: m.isDefault })),
        skills: skills.data.flatMap((entry) => entry.skills).map((s) => ({ id: s.path, name: s.name, description: s.description, scope: s.scope })),
        hooks: hooks.data.flatMap((entry) => entry.hooks), plugins: plugins.marketplaces.flatMap((entry) => entry.plugins),
        mcpServers, configuredMcpServers: Object.keys(config.config.mcp_servers ?? {}), requirements: requirements.requirements,
        errors: [...skills.data.flatMap((entry) => entry.errors), ...hooks.data.flatMap((entry) => [...entry.errors, ...entry.warnings]), ...plugins.marketplaceLoadErrors],
      };
    },
    async openThread({ threadId = null, cwd: work, model, threadConfig, modelProvider }) {
      if (!work || !threadConfig) throw unavailable('An explicit card workspace and frozen configuration are required.');
      if (threadId !== null && (typeof threadId !== 'string' || !threadId)) throw new CodexError('binding-mismatch', 'Resume requires a nonempty exact thread identity.');
      const allowed = new Set(['developerInstructions', 'config', 'dynamicTools', 'sandbox', 'approvalPolicy', 'approvalsReviewer']);
      if (Object.keys(threadConfig).some((key) => !allowed.has(key))) throw unavailable('Unsupported thread configuration fields. Native history and path replacement are forbidden.');
      const old = threadId && bindings.get(threadId);
      if (old && (!isDeepStrictEqual(old.threadConfig, threadConfig) || old.cwd !== work || old.modelProvider !== modelProvider)) throw new CodexError('fresh-context-required', 'This configuration change requires an explicitly confirmed empty fresh context.');
      if (old?.turnId) throw new CodexError('busy', 'This conversation already has an active turn.');
      await requireModel(model);
      const current = await connection();
      // dynamicTools are persisted at start. The resume schema has no registration field.
      const { dynamicTools, ...resumeConfig } = threadConfig;
      const resumeParams = { ...resumeConfig, threadId, cwd: work, model, ...(modelProvider ? { modelProvider } : {}), excludeTurns: true };
      let result = await current.request(threadId ? 'thread/resume' : 'thread/start', threadId
        ? resumeParams : { ...threadConfig, cwd: work, model, ...(modelProvider ? { modelProvider } : {}), allowProviderModelFallback: false });
      // Turn permissions persist natively, and warm resume ignores sandbox
      // overrides. Explicitly restore the ordinary baseline before dispatch;
      // an authorized Full turn opts in again through turn/start.
      if (threadId && threadConfig.sandbox === 'workspace-write' && threadConfig.approvalPolicy === 'on-request'
        && (result.sandbox.type !== 'workspaceWrite' || result.sandbox.networkAccess || result.approvalPolicy !== 'on-request')) {
        await current.request('thread/settings/update', { threadId, approvalPolicy: 'on-request', approvalsReviewer: 'user',
          sandboxPolicy: { type: 'workspaceWrite', writableRoots: [work], networkAccess: false } });
        result = await current.request('thread/resume', resumeParams);
      }
      const id = result.thread.id;
      if ((threadId && id !== threadId) || result.cwd !== work || result.thread.cwd !== work || (modelProvider && result.modelProvider !== modelProvider)) throw new CodexError('binding-mismatch', 'Codex returned a different native binding. Nothing will be submitted.');
      if (!threadId && result.model !== model) throw new CodexError('model-unavailable', 'Codex did not retain the selected model.');
      bindings.set(id, { cwd: work, model, modelProvider, threadConfig: structuredClone(threadConfig), turnId: null });
      current.threads.add(id);
      return { threadId: id, resumed: Boolean(threadId), native: result };
    },
    async startTurn({ threadId, input, clientUserMessageId, model, fullAccess = false }) {
      const binding = bindings.get(threadId); const current = await connection();
      if (!binding || !current.threads.has(threadId)) throw new CodexError('not-open', 'Resume the exact native binding before submitting.');
      if (binding.blocked) throw unavailable(binding.blocked);
      if (binding.turnId) throw new CodexError('busy', 'This conversation already has an active turn.');
      const chosen = model ?? binding.model;
      binding.turnId = 'dispatching';
      try {
        await requireModel(chosen);
        const result = await current.request('turn/start', { threadId, input, model: chosen, clientUserMessageId,
          approvalPolicy: fullAccess ? 'never' : 'on-request', sandboxPolicy: fullAccess ? { type: 'dangerFullAccess' }
            : { type: 'workspaceWrite', writableRoots: [binding.cwd], networkAccess: false } });
        binding.model = chosen;
        // Completion may precede the RPC response; do not resurrect a finished turn.
        if (binding.turnId === 'dispatching') binding.turnId = result.turn.id;
        return { turnId: result.turn.id, turn: result.turn };
      } catch (error) {
        if (error.kind !== 'timeout') binding.turnId = null;
        throw error;
      }
    },
    async interrupt({ threadId, turnId }) {
      const current = session;
      if (!current || current.exited) throw new CodexError('process-exited', 'No active Codex process.');
      const result = await current.request('turn/interrupt', { threadId, turnId });
      invalidate(current, threadId, turnId); return result;
    },
    readThread: ({ threadId }) => request('thread/read', { threadId, includeTurns: false }),
    listTurns: ({ threadId, cursor = null, limit = 25 }) => request('thread/turns/list', { threadId, cursor, limit, itemsView: 'full', sortDirection: 'desc' }),
    listItems: ({ threadId, turnId = null, cursor = null, limit = 100 }) => request('thread/items/list', { threadId, turnId, cursor, limit, sortDirection: 'asc' }),
    listLoadedThreads: ({ cursor = null, limit = 100 } = {}) => request('thread/loaded/list', { cursor, limit }),
    async archiveThread({ threadId }) {
      if (bindings.get(threadId)?.turnId) throw new CodexError('busy', 'Stop the active turn before archiving.');
      const result = await request('thread/archive', { threadId });
      session?.threads.delete(threadId); return result;
    },
    unarchiveThread: ({ threadId }) => request('thread/unarchive', { threadId }),
    async unsubscribeThread({ threadId }) {
      if (bindings.get(threadId)?.turnId) throw new CodexError('busy', 'Stop the active turn before unsubscribing.');
      const result = await request('thread/unsubscribe', { threadId });
      // Unsubscribe can leave a thread loaded natively. It proves no config transition.
      session?.threads.delete(threadId); return result;
    },
    async close({ signal = 'SIGTERM' } = {}) {
      const current = session; session = null;
      if (!current || current.exited) return;
      const exited = new Promise((resolve) => current.child.once('exit', resolve));
      current.end(new CodexError('process-exited', 'The Codex app-server was closed.'));
      current.child.kill(signal);
      const timer = setTimeout(() => current.child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
  return api;
}
