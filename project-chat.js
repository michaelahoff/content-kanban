// Drives a project chat: each turn the user sends becomes one native turn of
// the flow builder (flow-builder-tools.js) in the project's own conversation,
// with the builder's tools reaching the agent the way card tools do (Codex
// dynamic tools, the Claude SDK-hosted MCP server). One turn runs at a time
// per project. Nothing resumes after a restart: an unfinished turn ends and
// the next message continues the same native conversation.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { configurationDiscovery, compileConfiguration, queuedConfigurationDecision, openConfiguredThread } from './provider-configuration.js';
import { createFlowBuilder, projectSummary } from './flow-builder.js';
import { failureReason } from './chat-worker.js';
import { providerNames } from './public/playbook-format.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const check = (value, message) => { if (!value) fail(400, message); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const providerName = (provider) => providerNames[provider] ?? provider;
// Why a turn could not be sent, in words that say what to do next.
function explain(error) {
  const message = failureReason(error) || error.message || 'The provider could not take this message.';
  if (error.kind === 'fresh-context-required') return `${message} Start fresh context (the + button) and send the message again.`;
  if (error.kind === 'native-unavailable') return `${message} Start fresh context to continue; this history stays here.`;
  if (error.kind === 'model-unavailable') return `${message} Refresh models in Settings and choose a current one.`;
  return message;
}

export function createProjectChat({ store, adapters, providers, ctx, dataDir, paused = () => false, onDelta = () => {} }) {
  const live = new Map();
  let closed = false;
  const builder = createFlowBuilder({ store });
  const workspace = (projectId) => path.resolve(dataDir, 'workspaces', `project-chat-${projectId}`);
  store.projectChats.interruptAll(ctx, 'Frameboard restarted before this reply finished. Send your message again; the conversation continues from here.');

  const turnText = (turn) => (turn.context ? `${turn.context}\n\n## Message\n\n${turn.prompt}` : turn.prompt);
  function flush(work) {
    if (closed) return;
    for (const item of work.items.values()) if (item.dirty) { store.projectChats.item(ctx, work.turn.id, item); item.dirty = false; }
  }
  function release(work) {
    flush(work);
    clearInterval(work.timer);
    work.unsubscribe?.();
    if (live.get(work.projectId) === work) live.delete(work.projectId);
    wake();
  }
  function end(work, status, reason = '') {
    if (closed) return;
    flush(work);
    store.projectChats.finish(ctx, work.turn.id, status, reason);
    release(work);
  }
  // A Stop that arrived before the message was sent ends the turn here.
  function stopped(work) {
    if (store.projectChats.turn(work.turn.id)?.status !== 'interrupt-requested') return false;
    end(work, 'interrupted', 'Stopped before the message was sent.');
    return true;
  }
  async function interrupt(work) {
    if (closed || !work.threadId || !work.turnId || work.interruptSent === work.turnId) return;
    work.interruptSent = work.turnId;
    try { await adapters[work.turn.provider].interrupt({ threadId: work.threadId, turnId: work.turnId }); }
    catch (error) { if (!closed) end(work, 'interrupted', `Stopped; the provider did not acknowledge the interruption: ${error.message}`); }
  }
  function receive(work, event) {
    if (closed) return;
    if (event.turnId && work.turnId && event.turnId !== work.turnId) return;
    if (event.turnId && !work.turnId) {
      // A late event of an earlier turn in this conversation must not be
      // taken for the turn being dispatched.
      if (!work.dispatching || work.previousTurnIds.has(event.turnId)) return;
      work.turnId = event.turnId;
    }
    if (event.type === 'turn-started') {
      store.projectChats.nativeTurn(ctx, work.turn.id, event.turnId);
      if (store.projectChats.turn(work.turn.id)?.status === 'interrupt-requested') void interrupt(work);
    } else if (event.type === 'delta') {
      const item = work.items.get(event.itemId) ?? { id: event.itemId, kind: 'agentMessage', text: '', data: {}, completed: false };
      if (item.completed) return;
      const offset = item.text.length;
      item.text += event.delta; item.dirty = true; work.items.set(item.id, item);
      onDelta({ projectId: work.projectId, turnId: work.turn.id, itemId: item.id, offset, text: event.delta });
    } else if (event.type === 'item-started' || event.type === 'item-completed') {
      const native = event.item;
      if (native.type === 'userMessage') return;
      const old = work.items.get(native.id);
      if (old?.completed && event.type === 'item-started') return;
      work.items.set(native.id, { id: native.id, kind: native.type, text: native.text ?? old?.text ?? '', data: native, completed: event.type === 'item-completed' || Boolean(old?.completed), dirty: true });
      flush(work);
    } else if (event.type === 'turn-completed') {
      end(work, event.status === 'completed' ? 'completed' : event.status === 'interrupted' ? 'interrupted' : 'failed', failureReason(event.error));
    } else if (event.type === 'process-exited' || event.type === 'target-unavailable') {
      end(work, 'failed', event.error?.message ?? 'The provider stopped before finishing. Send the message again.');
    } else if (event.type === 'notification' && event.method === 'thread/compacted') {
      work.items.set(`compacted-${event.seq}`, { id: `compacted-${event.seq}`, kind: 'notice', text: 'Context compacted', data: {}, completed: true, dirty: true });
    }
  }
  // The builder needs no commands or file changes: a native approval request
  // is declined and noted, so the agent carries on with its tools.
  function decline(work, request) {
    if (closed || request.turnId !== work.turnId) return undefined;
    const id = `declined-${request.requestId}`;
    work.items.set(id, { id, kind: 'notice', text: `Declined a ${request.method.split('/').at(-1)} request from the agent: the project chat only builds flows with its Frameboard tools.`, data: {}, completed: true, dirty: true });
    flush(work);
    if (request.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (request.method === 'item/tool/requestUserInput') return { answers: {} };
    return { decision: 'decline' };
  }
  async function toolCall(work, request) {
    try {
      if (closed || request.turnId !== work.turnId || live.get(work.projectId) !== work) throw new Error('This turn no longer has Frameboard tool authority.');
      if (store.projectChats.turn(work.turn.id)?.status !== 'running') throw new Error('This turn is no longer running.');
      const callId = String(request.callId ?? '').slice(0, 200) || `${work.turn.id}:${work.items.size}`;
      const input = object(request.arguments) ? request.arguments : {};
      const saved = store.projectChats.receipt(work.turn.id, callId, request.tool, input);
      const result = saved ?? await builder.call({ ...ctx, actor: `automation:project-chat:${work.turn.id}` }, work.projectId, request.tool, input);
      if (!saved) store.projectChats.recordCall(ctx, work.turn.id, callId, request.tool, input, result);
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    } catch (error) {
      if (!error.status && !closed) console.error(error);
      return { success: false, contentItems: [{ type: 'inputText', text: error.status ? error.message : `Frameboard could not do that: ${error.message}` }] };
    }
  }
  async function run(turn) {
    const work = { turn, projectId: turn.projectId, items: new Map(), threadId: null, turnId: null, unsubscribe: null, dispatching: false, previousTurnIds: new Set() };
    live.set(turn.projectId, work);
    work.timer = setInterval(() => flush(work), 500);
    work.timer.unref();
    try {
      const adapter = adapters[turn.provider];
      if (!adapter) fail(400, 'Unknown chat provider.');
      if (store.providerConfiguration(ctx, turn.provider).selection.enabled === false) fail(409, `${providerName(turn.provider)} is disabled in Settings. Enable it and send the message again.`);
      const cwd = workspace(turn.projectId);
      await mkdir(cwd, { recursive: true });
      const discovery = await configurationDiscovery(adapter, { cwd }, turn.provider);
      if (closed || stopped(work)) return;
      const models = discovery.models;
      const model = turn.model ? (models.some((entry) => entry.id === turn.model) ? turn.model : null) : models.find((entry) => entry.isDefault)?.id ?? models[0]?.id ?? null;
      if (!model) fail(409, turn.model ? `The model ${turn.model} is not available for ${providerName(turn.provider)}. Choose another model.` : `No ${providerName(turn.provider)} model is available. Refresh models in Settings.`);
      if (model !== turn.model) store.projectChats.setModel(ctx, turn.id, model);
      const selection = store.providerConfiguration(ctx, turn.provider).selection;
      let conversation = store.projectChats.conversation(turn.conversationId);
      // The conversation's first turn freezes its configuration; later turns
      // reuse it, so the native session keeps the same guidance and tools.
      // When that configuration no longer applies (the user's provider
      // guidance or Frameboard's flow builder changed), the message starts a
      // new conversation rather than failing: the builder's guidance is
      // Frameboard's, not something the user chose to keep.
      const current = compileConfiguration(selection, discovery, builder.tools, turn.provider, 'builder');
      let frozen = conversation.configuration;
      const stale = Boolean(frozen) && (queuedConfigurationDecision(frozen, selection, discovery).status !== 'ready'
        || JSON.stringify(frozen.nativeOptions.dynamicTools) !== JSON.stringify(current.nativeOptions.dynamicTools));
      // A configuration that cannot run now fails the turn and keeps the
      // conversation; only a usable new one replaces it.
      if ((!frozen || stale) && !current.supported) fail(409, current.reasons.join(' '));
      if (stale) {
        conversation = store.projectChats.rotate(ctx, turn.id);
        work.items.set('new-conversation', { id: 'new-conversation', kind: 'notice', text: 'Settings or the flow builder changed since this conversation began, so this message starts a new conversation. The earlier one is kept above.', data: {}, completed: true, dirty: true });
        flush(work);
        frozen = current;
      }
      frozen ??= current;
      const opened = await openConfiguredThread(adapter, { frozen, discovery, currentSelection: selection, threadId: conversation.binding?.threadId ?? null,
        binding: conversation.binding, bindingConfiguration: conversation.configuration, cwd, model });
      if (closed) return;
      work.threadId = opened.threadId;
      work.previousTurnIds = new Set(store.projectChats.nativeTurnIds(conversation.id));
      store.projectChats.bind(ctx, conversation.id, opened.binding, frozen);
      work.unsubscribe = adapter.subscribe(opened.threadId, { acceptsRequest: (request) => request.turnId === work.turnId,
        onEvent: (event) => receive(work, event), onRequest: (request) => decline(work, request), onToolCall: (request) => toolCall(work, request) });
      if (stopped(work)) return;
      await adapter.assertProtection?.();
      if (closed || stopped(work)) return;
      if (!store.projectChats.start(ctx, turn.id)) { release(work); return; }
      work.dispatching = true;
      const started = await adapter.startTurn({ threadId: opened.threadId, model, clientUserMessageId: turn.id, input: [{ type: 'text', text: turnText(turn) }] });
      if (closed) return;
      work.turnId ??= started.turnId;
      store.projectChats.nativeTurn(ctx, turn.id, started.turnId);
      if (store.projectChats.turn(turn.id)?.status === 'interrupt-requested') void interrupt(work);
    } catch (error) {
      if (closed) return;
      if (!error.status && !error.kind) console.error(error);
      end(work, 'failed', explain(error));
    }
  }
  function wake() {
    if (closed || paused()) return;
    setImmediate(() => {
      if (closed || paused()) return;
      for (const turn of store.projectChats.queued(ctx)) if (!live.has(turn.projectId)) void run(turn);
    });
  }
  wake();
  return {
    wake,
    tools: builder.tools,
    // A message from the user. It is queued at once and answered in the
    // background; problems show up as the turn's outcome in the transcript.
    send(userCtx, projectId, input) {
      check(object(input), 'Write a message.');
      const existing = typeof input.id === 'string' ? store.projectChats.turn(input.id) : null;
      if (existing && existing.projectId === projectId) return existing;
      const settings = store.projectChats.snapshot(userCtx, projectId);
      if (settings.archived) fail(409, store.projectChats.archivedMessage);
      const provider = input.provider ?? settings.provider;
      check(['codex', 'claude'].includes(provider), 'Unknown chat provider.');
      providers?.assertEnabled(userCtx, provider);
      const model = input.model === undefined ? (provider === settings.provider ? settings.model : null) : input.model;
      const turn = store.projectChats.queue(userCtx, projectId, { id: input.id, prompt: input.prompt, context: projectSummary(store, userCtx, projectId), provider, model });
      wake();
      return turn;
    },
    stop(userCtx, projectId) {
      const turn = store.projectChats.active(projectId) || fail(409, 'Nothing is running in this project chat.');
      const work = live.get(projectId);
      if (turn.status === 'interrupt-requested') {
        // The provider has not confirmed the first Stop: a second one ends the turn here.
        const reason = 'Stopped; the provider did not confirm the interruption.';
        if (work) end(work, 'interrupted', reason); else store.projectChats.finish(userCtx, turn.id, 'interrupted', reason);
        return { turn: store.projectChats.turn(turn.id) };
      }
      store.projectChats.requestStop(userCtx, turn.id);
      if (work?.turnId) void interrupt(work);
      else if (!work) store.projectChats.finish(userCtx, turn.id, 'interrupted', 'Stopped before it started.');
      return { turn: store.projectChats.turn(turn.id) };
    },
    fresh: (userCtx, projectId) => store.projectChats.fresh(userCtx, projectId),
    // A snapshot then includes everything streamed so far.
    flush(projectId) { const work = live.get(projectId); if (work) flush(work); },
    idle: () => !live.size,
    close() {
      for (const work of live.values()) { flush(work); clearInterval(work.timer); work.unsubscribe?.(); }
      closed = true; live.clear();
    },
  };
}
