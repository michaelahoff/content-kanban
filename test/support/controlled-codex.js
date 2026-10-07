// A controllable external native-harness boundary. It does no inference and
// preserves exact identities so HTTP/worker tests can inject races deliberately.
import { randomUUID } from 'node:crypto';
export class ControlledCodex {
  constructor(home) {
    this.home = home; this.threads = new Map(); this.listeners = new Map(); this.sends = []; this.interrupts = [];
    this.instructions = []; this.skills = []; this.running = false; this.autoInterrupt = true;
    this.models = ['test-model', 'other-model']; this.startGate = null;
    this.afterSubscribe = null;
  }
  async discover({ cwd } = {}) {
    this.running = true;
    return { cwd, harness: { userAgent: 'codex/0.160.1', codexHome: this.home },
      skills: this.skills, hooks: [], plugins: [], mcpServers: [], configuredMcpServers: [], errors: [],
      models: this.models.map((id, index) => ({ id, displayName: id, isDefault: index === 0 })) };
  }
  async openThread({ threadId, cwd, model, threadConfig }) {
    if (threadId && !this.threads.has(threadId)) throw Object.assign(new Error('No rollout found.'), { kind: 'native-unavailable' });
    if (!this.models.includes(model)) throw Object.assign(new Error('Model unavailable.'), { kind: 'model-unavailable' });
    const id = threadId ?? randomUUID();
    if (!this.threads.has(id)) this.threads.set(id, { id, cwd, turns: [], config: threadConfig });
    return { threadId: id, native: { instructionSources: this.instructions, sandbox: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' } };
  }
  subscribe(threadId, handlers) {
    if (!this.listeners.has(threadId)) this.listeners.set(threadId, new Set());
    this.listeners.get(threadId).add(handlers);
    this.afterSubscribe?.(threadId);
    return () => this.listeners.get(threadId).delete(handlers);
  }
  emit(threadId, event) {
    for (const handler of this.listeners.get(threadId) ?? []) handler.onEvent?.({ threadId, ...event });
  }
  async startTurn(input) {
    await this.startGate;
    const thread = this.threads.get(input.threadId);
    const turn = { id: randomUUID(), status: 'inProgress', items: [{ type: 'userMessage', id: randomUUID(), clientId: input.clientUserMessageId, content: input.input }] };
    thread.turns.push(turn); this.sends.push({ ...input, turnId: turn.id });
    this.emit(thread.id, { type: 'turn-started', turnId: turn.id });
    return { turnId: turn.id, turn };
  }
  finish(send, status = 'completed', text = 'A completed reply') {
    const turn = this.threads.get(send.threadId).turns.find((turn) => turn.id === send.turnId);
    const item = { type: 'agentMessage', id: randomUUID(), text };
    turn.items.push(item); turn.status = status;
    this.emit(send.threadId, { type: 'item-completed', turnId: send.turnId, item });
    this.emit(send.threadId, { type: 'turn-completed', turnId: send.turnId, status, turn });
  }
  // Completes one native imageGeneration item, as app-server reports it.
  // notify: false records it only in native history, as when the app crashed.
  image(send, { id = randomUUID(), result = '', savedPath = null, status = 'completed', revisedPrompt = null, failure = null } = {}, { notify = true } = {}) {
    const item = { type: 'imageGeneration', id, status, result, savedPath, revisedPrompt, failure };
    this.threads.get(send.threadId).turns.find((turn) => turn.id === send.turnId).items.push(item);
    if (notify) this.emit(send.threadId, { type: 'item-completed', turnId: send.turnId, item });
    return item;
  }
  async interrupt(input) {
    this.interrupts.push(input);
    if (this.autoInterrupt) {
      const send = this.sends.find((send) => send.turnId === input.turnId);
      if (send) this.finish(send, 'interrupted', 'Stopped partial reply');
    }
    return {};
  }
  request(send, method = 'item/commandExecution/requestApproval', params = {}) {
    const requestId = randomUUID(); const results = [];
    const request = { requestId, threadId: send.threadId, turnId: send.turnId, method,
      command: 'outside sandbox', cwd: this.threads.get(send.threadId).cwd, ...params, respond: (result) => results.push(result) };
    for (const handler of this.listeners.get(send.threadId) ?? []) if (!handler.acceptsRequest || handler.acceptsRequest(request)) handler.onRequest?.(request);
    return { requestId, results };
  }
  async tool(send, tool, args = {}, callId = randomUUID()) {
    const results = [];
    for (const handler of this.listeners.get(send.threadId) ?? []) if (handler.onToolCall && (!handler.acceptsRequest || handler.acceptsRequest({ turnId: send.turnId }))) {
      const result = await handler.onToolCall({ threadId: send.threadId, turnId: send.turnId, callId, tool, arguments: args });
      if (result !== undefined) results.push(result);
    }
    return results.at(-1);
  }
  async listTurns({ threadId, cursor }) {
    if (!this.threads.has(threadId)) throw Object.assign(new Error('No rollout found.'), { kind: 'native-unavailable' });
    const turns = this.threads.get(threadId).turns;
    return { data: cursor ? [] : turns, nextCursor: null };
  }
  async close() { this.running = false; }
}
