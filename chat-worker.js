// One active attempt per card; every ready card progresses independently.
// The durable queue owns correctness. Wake-ups only reduce scheduling latency.
import { configurationDiscovery, queuedConfigurationDecision, openConfiguredThread } from './provider-configuration.js';
import { submissionText } from './public/chat-context.js';
import { automaticDecision, nativeDecision } from './native-requests.js';
import { outputProvenance } from './store-images.js';
import { applyLaneResult } from './lane-runner.js';

// Explains a failed accepted turn. Exhausted usage and provider rejections after
// acceptance need an explicit retry; nothing is resent or substituted.
export function failureReason(error) {
  const info = error?.codexErrorInfo; const kind = typeof info === 'string' ? info : info && Object.keys(info)[0];
  const message = error?.message ?? '';
  if (kind === 'usageLimitExceeded') return `Usage limit reached. Retry explicitly after it resets. ${message}`.trim();
  if (kind) return `Codex reported ${kind} after accepting this prompt. Retry explicitly. ${message}`.trim();
  return message;
}

// A JSON-RPC rejection Codex documents as transient backpressure: the request
// was refused before acceptance.
const overloaded = (error) => error.code === -32001;

export function createChatWorker({ store, adapter, adapters = { codex: adapter }, service, ctx, providerBackoffMs = 2000, providerWaitLimit = 6, onDelta = () => {} }) {
  const live = new Map();
  let retryTimer = null;
  const retained = new Set();
  const requests = new Map();
  const importing = new Set();
  let closed = false; let scheduled = false; let nativeHome = null;
  // Native transcript rows keep image provenance, not the base64 payload.
  const transcriptData = (native) => {
    if (native.type !== 'imageGeneration') return native;
    const { result, ...rest } = native;
    return { ...rest, resultReturned: Boolean(result) };
  };
  async function saveOutput(output, native) {
    if (closed || importing.has(output.id)) return;
    importing.add(output.id);
    const automation = { ...ctx, actor: `automation:${output.attemptId}` };
    try {
      nativeHome ??= (await adapter.discover({})).harness.codexHome;
      const version = await service.importNative(native, nativeHome);
      if (!closed) store.images.imported(automation, output.id, version, 'native-image-generation');
    } catch (error) {
      if (!closed) store.images.importFailed(automation, output.id, error.status ? error.message : `Saving failed: ${error.message}`);
    } finally { importing.delete(output.id); }
  }
  function capture(attempt, submission, native, location) {
    const output = store.images.capture(ctx, attempt.id, { nativeId: native.id, kind: 'imageGeneration',
      generationStatus: native.status === 'completed' ? 'completed' : native.status ?? 'unknown', name: `Generated image ${native.id}`.slice(0, 500),
      provenance: outputProvenance(submission, 'native-image-generation', { toolPrompt: native.revisedPrompt ?? null,
        native: { ...location, itemId: native.id, status: native.status, savedPath: native.savedPath ?? null,
          transparentBackground: native.transparentBackground ?? null, failure: native.failure ?? null } }) });
    if (output.importStatus === 'pending') void saveOutput(output, native);
  }
  function flush(work) {
    if (closed) return;
    for (const item of work.items.values()) if (item.dirty) {
      store.chats.item(ctx, work.attempt.id, item);
      item.dirty = false;
    }
  }
  function release(work) {
    flush(work);
    clearInterval(work.timer);
    if (live.get(work.submission.cardId) === work) live.delete(work.submission.cardId);
    for (const [id, pending] of requests) if (pending.work === work) requests.delete(id);
    wake();
  }
  // An observed Codex exit is proof for reconciliation: no surviving process
  // can still deliver the turn, so history is checked at once.
  function end(work, status, reason = '', { exited = false } = {}) {
    if (closed) return;
    flush(work);
    if (store.chats.attempt(work.attempt.id)?.status === 'uncertain') store.chats.reconcile(ctx, work.attempt.id, status, reason);
    else store.chats.finish(ctx, work.attempt.id, status, reason, exited ? 'process-exited' : null);
    release(work);
    if (exited && status === 'uncertain') void recheck(work.attempt.id, true);
  }
  async function recheck(attemptId, proof) {
    const entry = store.chats.unfinished(ctx).find((candidate) => candidate.attempt.id === attemptId);
    if (!entry) return;
    try { await settleFromHistory(entry, proof); }
    catch (error) { if (!closed) store.chats.reconcile(ctx, attemptId, 'uncertain', `Reconciliation failed: ${error.message}`); }
  }
  async function interrupt(work) {
    if (closed || !work.threadId || !work.turnId || work.interruptSent === work.turnId) return;
    work.interruptSent = work.turnId;
    try { await adapters[work.submission.provider].interrupt({ threadId: work.threadId, turnId: work.turnId }); }
    catch (error) {
      if (!closed) end(work, 'uncertain', `Interruption has not been acknowledged: ${error.message}`);
    }
  }
  function receive(work, event) {
    if (closed) return;
    // A listener stays with its native turn for late history, including after a
    // follow-up starts. Never attribute an old turn's events to the next attempt.
    if (event.turnId && work.turnId && event.turnId !== work.turnId) return;
    if (event.turnId && !work.turnId) {
      if (!work.dispatching || work.previousTurnIds.has(event.turnId)) return;
      if (live.get(work.submission.cardId) !== work || !['dispatching', 'interrupt-requested'].includes(store.chats.attempt(work.attempt.id)?.status)) return;
      work.turnId = event.turnId;
    }
    if (event.type === 'turn-started') {
      store.chats.running(ctx, work.attempt.id, event.turnId);
      if (store.chats.attempt(work.attempt.id)?.status === 'interrupt-requested') void interrupt(work);
    } else if (event.type === 'delta') {
      const item = work.items.get(event.itemId) ?? { id: event.itemId, kind: 'agentMessage', text: '', data: {}, completed: false };
      if (item.completed) return;
      const offset = item.text.length;
      item.text += event.delta; item.dirty = true; work.items.set(item.id, item);
      onDelta({ cardId: work.submission.cardId, attemptId: work.attempt.id, itemId: item.id, offset, text: event.delta });
      // Late deltas remain reviewable even when the periodic writer has stopped.
      if (live.get(work.submission.cardId) !== work) flush(work);
    } else if (event.type === 'item-started' || event.type === 'item-completed') {
      const native = event.item; const old = work.items.get(native.id);
      if (old?.completed && event.type === 'item-started') return;
      const item = { id: native.id, kind: native.type, text: native.text ?? old?.text ?? '', data: transcriptData(native),
        completed: event.type === 'item-completed' || Boolean(old?.completed), dirty: true };
      if (native.type === 'userMessage') return; // The immutable submission is its source of truth.
      work.items.set(item.id, item); flush(work);
      if (native.type === 'imageGeneration' && event.type === 'item-completed') capture(work.attempt, work.submission, native, { threadId: work.threadId, turnId: event.turnId ?? work.turnId });
    } else if (event.type === 'turn-completed') {
      if (event.status === 'completed' && work.submission.lane) laneResult(work);
      end(work, event.status === 'completed' ? 'completed' : event.status === 'interrupted' ? 'interrupted' : 'failed', failureReason(event.error));
    } else if (event.type === 'process-exited' || event.type === 'target-unavailable') {
      end(work, 'uncertain', event.error?.message ?? 'The selected target changed. Reconcile this conversation before continuing.', { exited: event.type === 'process-exited' });
    } else if (event.type === 'request-invalidated') {
      store.chats.invalidateRequest(ctx, work.attempt.id, event.requestId);
      for (const [id, pending] of requests) if (pending.work === work && String(pending.nativeId) === String(event.requestId)) requests.delete(id);
    } else if (event.type === 'notification' && event.method === 'thread/compacted') {
      store.chats.item(ctx, work.attempt.id, { id: `compacted-${event.seq}`, kind: 'notice', text: 'Context compacted', completed: true });
    }
  }
  // A completed lane run applies its reply's result block while the attempt
  // still holds card-tool authority, then notes what happened in the chat.
  function laneResult(work) {
    flush(work);
    let text;
    try {
      const reply = [...work.items.values()].filter((item) => item.kind === 'agentMessage').map((item) => item.text).join('\n\n');
      text = applyLaneResult({ store, ctx, attempt: work.attempt, submission: work.submission, text: reply });
    } catch (error) {
      text = `The lane result could not be applied: ${error.message}`;
      const run = store.laneRuns.bySubmission(work.submission.id);
      if (run?.status === 'queued') store.laneRuns.update(ctx, run.id, { status: 'failed', reason: text });
    }
    if (text) store.chats.item(ctx, work.attempt.id, { id: 'lane-result', kind: 'notice', text: `Lane result · ${text}`, completed: true });
  }
  function pendingRequest(work, request) {
    if (closed || request.turnId !== work.turnId) return;
    const { respond, requestId, method, ...params } = request;
    if (method === 'item/fileChange/requestApproval') params.changes = work.items.get(params.itemId)?.data?.changes;
    const id = store.chats.request(ctx, work.attempt.id, { requestId, method, params });
    if (id) {
      const pending = { work, respond, method, params, nativeId: requestId };
      requests.set(id, pending);
      const response = automaticDecision(pending, store.chats.requestGrants(ctx, work.submission.cardId));
      if (response) { store.chats.answerRequest(ctx, work.submission.cardId, id, response); requests.delete(id); respond(response); }
    } else if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    else if (method === 'item/tool/requestUserInput') return { answers: {} };
    else return { decision: 'decline' };
  }
  async function toolCall(work, request) {
    try {
      if (closed || request.turnId !== work.turnId || live.get(work.submission.cardId) !== work) throw new Error('This attempt no longer has card-tool authority.');
      let artifact;
      if (request.tool === 'register_image') {
        if (!['dispatching', 'accepted', 'running'].includes(store.chats.attempt(work.attempt.id)?.status)) throw new Error('This attempt no longer has card-tool authority.');
        const saved = store.protection.receipt(ctx, work.attempt.id, request.callId, request.tool, request.arguments);
        if (saved) return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(saved) }] };
        artifact = await service.renderedImage(work.submission.cardId, request.arguments);
        if (closed) throw new Error('The worker has closed.');
      }
      const result = store.protection.tool(ctx, work.attempt.id, request.callId, request.tool, request.arguments, artifact);
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    } catch (error) { return { success: false, contentItems: [{ type: 'inputText', text: error.message }] }; }
  }
  async function execute(work) {
    try {
      const { submission, attempt } = work;
      const adapter = adapters[submission.provider];
      if (store.providerConfiguration(ctx, submission.provider).selection.enabled === false) { store.chats.hold(ctx, attempt.id, 'This provider is disabled in Settings. Enable it and resubmit to continue.'); release(work); return; }
      const cwd = service.workspace(submission.cardId);
      const discovery = await configurationDiscovery(adapter, { cwd }, submission.provider);
      if (closed) return;
      nativeHome = discovery.harness.codexHome;
      if (store.chats.attempt(attempt.id)?.status === 'interrupt-requested') { end(work, 'interrupted'); return; }
      const decision = queuedConfigurationDecision(submission.configuration, store.providerConfiguration(ctx, submission.provider).selection, discovery);
      if (decision.status !== 'ready') { store.chats.hold(ctx, attempt.id, decision.reason); release(work); return; }
      const opened = await openConfiguredThread(adapter, { frozen: submission.configuration, discovery,
        currentSelection: store.providerConfiguration(ctx, submission.provider).selection, threadId: work.conversation.binding?.threadId,
        binding: work.conversation.binding, bindingConfiguration: store.chats.bindingConfiguration(work.conversation.id), cwd, model: submission.model });
      if (closed) return;
      work.threadId = opened.threadId;
      if (!store.chats.bind(ctx, attempt.id, opened.binding)) { end(work, 'interrupted'); return; }
      work.unsubscribe = adapter.subscribe(opened.threadId, { acceptsRequest: (request) => request.turnId === work.turnId,
        onEvent: (event) => receive(work, event), onRequest: (request) => pendingRequest(work, request), onToolCall: (request) => toolCall(work, request) });
      const images = await service.references(submission);
      if (closed) return;
      if (store.chats.attempt(attempt.id)?.status === 'interrupt-requested') { end(work, 'interrupted'); return; }
      const recheck = queuedConfigurationDecision(submission.configuration, store.providerConfiguration(ctx, submission.provider).selection, discovery);
      if (recheck.status !== 'ready') { store.chats.hold(ctx, attempt.id, recheck.reason); release(work); return; }
      if (work.conversation.binding?.threadId) {
        const outside = await outsideTurns(work.conversation.id, opened.threadId, adapter);
        if (closed) return;
        if (store.chats.attempt(attempt.id)?.status === 'interrupt-requested') { end(work, 'interrupted'); return; }
        if (outside.length) { store.chats.holdOutside(ctx, attempt.id, outside); release(work); return; }
      }
      if (store.chats.attempt(attempt.id)?.status !== 'dispatching') { release(work); return; }
      work.dispatching = true; work.sent = true;
      const started = await adapter.startTurn({ threadId: opened.threadId, model: submission.model,
        fullAccess: store.chats.requestGrants(ctx, submission.cardId).some((grant) => grant.kind === 'full'),
        clientUserMessageId: attempt.id, input: [{ type: 'text', text: submissionText(submission) }, ...images] });
      if (closed) return;
      work.turnId = started.turnId;
      store.chats.running(ctx, attempt.id, started.turnId);
      if (store.chats.attempt(attempt.id)?.status === 'interrupt-requested') void interrupt(work);
    } catch (error) {
      if (closed) return;
      // Nothing reached Codex, or Codex refused it before acceptance: wait for
      // the provider and retry. Possible delivery is never retried this way.
      if (overloaded(error) || (!work.sent && ['timeout', 'process-exited', 'busy'].includes(error.kind))) {
        store.chats.wait(ctx, work.attempt.id, error.message, { baseMs: providerBackoffMs, limit: providerWaitLimit }); release(work); return;
      }
      const uncertain = ['timeout', 'process-exited', 'protocol', 'binding-mismatch', 'busy'].includes(error.kind);
      if (uncertain) end(work, 'uncertain', error.message, { exited: error.kind === 'process-exited' });
      else if (['configuration-unavailable', 'fresh-context-required', 'native-unavailable'].includes(error.kind) || error.status === 409) {
        store.chats.hold(ctx, work.attempt.id, error.message, { nativeUnavailable: error.kind === 'native-unavailable' }); release(work);
      } else end(work, 'failed', error.message);
    }
  }
  function wake() {
    if (closed || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (closed) return;
      for (const work of live.values()) if (store.chats.attempt(work.attempt.id)?.status === 'interrupt-requested') void interrupt(work);
      for (const submission of store.chats.ready(ctx)) {
        if (live.has(submission.cardId)) continue;
        const claimed = store.chats.claim(ctx, submission.id);
        if (!claimed) continue;
        const previousTurnIds = new Set([...store.chats.turnIds(ctx, submission.cardId),
          ...[...retained].filter((work) => work.submission.cardId === submission.cardId && work.turnId).map((work) => work.turnId)]);
        const work = { ...claimed, items: new Map(), threadId: null, turnId: null, dispatching: false, previousTurnIds };
        live.set(submission.cardId, work); retained.add(work);
        work.timer = setInterval(() => flush(work), 500);
        work.timer.unref();
        void execute(work);
      }
      // Waiting submissions become ready at their retry time.
      clearTimeout(retryTimer);
      const next = store.chats.nextRetry(ctx);
      if (next) { retryTimer = setTimeout(wake, Math.max(0, Date.parse(next) - Date.now()) + 5); retryTimer.unref(); }
    });
  }
  // Pages native history read-only (newest first) until `found` matches.
  async function findTurn(threadId, found, nativeAdapter = adapter) {
    let cursor = null; const seen = new Set();
    do {
      const page = await nativeAdapter.listTurns({ threadId, cursor });
      if (closed) return null;
      const match = page.data.find(found);
      if (match) return match;
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Native history repeated a cursor.');
      seen.add(cursor);
    } while (cursor);
    return null;
  }
  // Newest native turns back to the latest one Frameboard knows. Any other turn
  // was continued outside Frameboard (for example a CLI resume).
  async function outsideTurns(conversationId, threadId, nativeAdapter) {
    const { attemptIds, turnIds } = store.chats.nativeIdentity(conversationId);
    const outside = [];
    await findTurn(threadId, (turn) => {
      if (turnIds.has(turn.id) || turn.items?.some((item) => item.type === 'userMessage' && attemptIds.has(item.clientId))) return true;
      outside.push(turn.id); return false;
    }, nativeAdapter);
    return outside;
  }
  // Read-only delivery reconciliation by attempt client ID. `proof` holds only
  // when the app-server that could have received turn/start has exited (app
  // startup or an observed process exit). Then complete native history without
  // the attempt proves non-delivery. Anything possibly delivered is never resent.
  async function settleFromHistory({ attempt, submission, conversation }, proof) {
    const threadId = conversation.binding?.threadId;
    const nativeAdapter = adapters[submission.provider];
    if (threadId) nativeAdapter.bindHistory?.({ threadId, cwd: conversation.binding.cwd });
    const notSent = (unbind = false) => {
      // A Stop or deletion requested before delivery is honored, not requeued.
      if (attempt.status === 'interrupt-requested' || ['user', 'cancelled'].includes(attempt.cause)) return store.chats.reconcile(ctx, attempt.id, 'interrupted', 'Stopped before it was sent to Codex.');
      return store.chats.notDelivered(ctx, attempt.id, 'Not sent before Codex stopped; sent again automatically.', { unbind });
    };
    // The binding is committed before turn/start, so no binding means no send.
    if (!threadId) return notSent();
    let match;
    try { match = await findTurn(threadId, (turn) => turn.items?.some((item) => item.type === 'userMessage' && item.clientId === attempt.id), nativeAdapter); }
    catch (error) {
      if (closed) return false;
      if (error.kind !== 'native-unavailable') return store.chats.reconcile(ctx, attempt.id, 'uncertain', `Native history could not be read, so delivery is uncertain: ${error.message}`);
      // A thread is persisted with its first turn. A missing thread whose
      // conversation never had a turn therefore never received this one.
      if (proof && !attempt.turnId && !store.chats.conversationTurns(conversation.id).length) return notSent(true);
      return store.chats.reconcile(ctx, attempt.id, 'interrupted', 'Native history for this conversation is missing. Its retained history stays readable here and nothing was resent. Start fresh context to continue.', { nativeUnavailable: true, cause: 'missing-history' });
    }
    if (closed) return false;
    if (!match) {
      if (attempt.turnId) {
        store.chats.item(ctx, attempt.id, { id: 'missing-from-native-history', kind: 'notice', text: 'Missing from native history. Retained output is shown; nothing was resent.', completed: true });
        return store.chats.reconcile(ctx, attempt.id, 'interrupted', 'Codex accepted this prompt, but it is missing from native history. Nothing was resent.', { cause: 'missing-history' });
      }
      if (proof) return notSent();
      return store.chats.reconcile(ctx, attempt.id, 'uncertain', 'No matching native turn yet, and Codex may still deliver it. Check again, or mark it interrupted to retry deliberately.');
    }
    for (const item of match.items ?? []) if (item.type !== 'userMessage') {
      store.chats.item(ctx, attempt.id, { id: item.id, kind: item.type, text: item.text ?? '', data: transcriptData(item), completed: match.status === 'completed' });
      if (item.type === 'imageGeneration') capture(attempt, submission, item, { threadId, turnId: match.id });
    }
    const identity = { turnId: match.id };
    if (match.status === 'completed') return store.chats.reconcile(ctx, attempt.id, 'completed', 'Recovered after restart.', identity);
    if (match.status === 'failed') return store.chats.reconcile(ctx, attempt.id, 'failed', failureReason(match.error), identity);
    if (match.status === 'interrupted' || proof) return store.chats.reconcile(ctx, attempt.id, 'interrupted', 'Interrupted when Codex stopped. Partial output is retained; nothing was resent.', { ...identity, cause: 'restart' });
    return store.chats.reconcile(ctx, attempt.id, 'uncertain', 'Codex accepted this prompt and has not reported a result. It is held until reconciled.', identity);
  }
  async function reconcile() {
    store.chats.invalidateAfterRestart(ctx);
    store.images.interruptedImports(ctx);
    for (const entry of store.chats.unfinished(ctx)) {
      if (closed) return;
      try { await settleFromHistory(entry, true); }
      catch (error) { if (!closed) store.chats.reconcile(ctx, entry.attempt.id, 'uncertain', `Reconciliation failed: ${error.message}`); }
    }
  }
  void reconcile().catch((error) => { if (!closed) console.error(error); }).finally(wake);
  // Unfinished rows fence their own cards while read-only recovery proceeds.
  // An unavailable old conversation must not delay independent ready cards.
  wake();
  // Retry saving reads the same item from native history (read-only), or its
  // reported saved file. It never resumes the conversation or starts a turn.
  async function nativeItem({ threadId, turnId, itemId }) {
    const turn = await findTurn(threadId, (entry) => entry.id === turnId);
    return turn?.items?.find((item) => item.id === itemId && item.type === 'imageGeneration') ?? null;
  }
  return {
    wake,
    async retrySave(cardId, outputId) {
      const output = store.images.beginRetry(ctx, cardId, outputId);
      if (output.importStatus === 'imported') return output;
      let native = null;
      try { native = await nativeItem(output.native); } catch { /* Native history is unavailable; use the reported file. */ }
      await saveOutput(output, native ?? { result: '', savedPath: output.native.savedPath });
      return store.images.output(outputId);
    },
    // Explicit read-only reconciliation of this card's uncertain deliveries.
    async reconcileCard(cardId) {
      store.getCard(ctx, cardId);
      for (const entry of store.chats.unfinished(ctx)) {
        if (entry.attempt.cardId === cardId && entry.attempt.status === 'uncertain') await recheck(entry.attempt.id, entry.attempt.cause === 'process-exited');
      }
      return { ok: true };
    },
    // A snapshot then includes everything streamed so far, so the next delta's
    // offset continues exactly where the snapshot ends.
    flushCard(cardId) { for (const work of retained) if (work.submission.cardId === cardId) flush(work); },
    stop(cardId) { const result = store.chats.stop(ctx, cardId); wake(); return result; },
    answer(cardId, requestId, response) {
      const pending = requests.get(requestId);
      if (!pending || pending.work.submission.cardId !== cardId) throw Object.assign(new Error('This request is no longer live.'), { status: 409 });
      const decision = nativeDecision(pending, response);
      store.chats.answerRequest(ctx, cardId, requestId, decision.native, decision.grant);
      requests.delete(requestId);
      pending.respond(decision.native);
      return { ok: true };
    },
    close() {
      for (const work of retained) { flush(work); clearInterval(work.timer); work.unsubscribe?.(); }
      closed = true; clearTimeout(retryTimer); requests.clear(); live.clear(); retained.clear();
    },
  };
}
