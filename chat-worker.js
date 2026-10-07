// One active attempt per card; every ready card progresses independently.
// The durable queue owns correctness. Wake-ups only reduce scheduling latency.
import { configurationDiscovery, queuedConfigurationDecision, openConfiguredThread } from './codex-configuration.js';
import { submissionText } from './public/chat-context.js';

export function createChatWorker({ store, adapter, service, ctx }) {
  const live = new Map();
  const retained = new Set();
  const requests = new Map();
  let closed = false; let scheduled = false;
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
  function end(work, status, reason = '') {
    if (closed) return;
    flush(work);
    if (store.chats.attempt(work.attempt.id)?.status === 'uncertain') store.chats.reconcile(ctx, work.attempt.id, status, reason);
    else store.chats.finish(ctx, work.attempt.id, status, reason);
    release(work);
  }
  async function interrupt(work) {
    if (closed || !work.threadId || !work.turnId || work.interruptSent === work.turnId) return;
    work.interruptSent = work.turnId;
    try { await adapter.interrupt({ threadId: work.threadId, turnId: work.turnId }); }
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
      item.text += event.delta; item.dirty = true; work.items.set(item.id, item);
      // Late deltas remain reviewable even when the periodic writer has stopped.
      if (live.get(work.submission.cardId) !== work) flush(work);
    } else if (event.type === 'item-started' || event.type === 'item-completed') {
      const native = event.item; const old = work.items.get(native.id);
      if (old?.completed && event.type === 'item-started') return;
      const item = { id: native.id, kind: native.type, text: native.text ?? old?.text ?? '', data: native,
        completed: event.type === 'item-completed' || Boolean(old?.completed), dirty: true };
      if (native.type === 'userMessage') return; // The immutable submission is its source of truth.
      work.items.set(item.id, item); flush(work);
    } else if (event.type === 'turn-completed') {
      end(work, event.status === 'completed' ? 'completed' : event.status === 'interrupted' ? 'interrupted' : 'failed', event.error?.message ?? '');
    } else if (event.type === 'process-exited' || event.type === 'target-unavailable') {
      end(work, 'uncertain', event.error?.message ?? 'The selected target changed. Reconcile this conversation before continuing.');
    } else if (event.type === 'request-invalidated') {
      for (const [id, pending] of requests) if (pending.work === work && String(pending.nativeId) === String(event.requestId)) requests.delete(id);
    } else if (event.type === 'notification' && event.method === 'thread/compacted') {
      store.chats.item(ctx, work.attempt.id, { id: `compacted-${event.seq}`, kind: 'notice', text: 'Context compacted', completed: true });
    }
  }
  function pendingRequest(work, request) {
    if (closed || request.turnId !== work.turnId) return;
    const { respond, requestId, method, ...params } = request;
    const id = store.chats.request(ctx, work.attempt.id, { requestId, method, params });
    if (id) requests.set(id, { work, respond, method, nativeId: requestId });
  }
  async function execute(work) {
    try {
      const { submission, attempt } = work;
      const cwd = service.workspace(submission.cardId);
      const discovery = await configurationDiscovery(adapter, { cwd });
      if (closed) return;
      if (store.chats.attempt(attempt.id)?.status === 'interrupt-requested') { end(work, 'interrupted'); return; }
      const decision = queuedConfigurationDecision(submission.configuration, store.providerConfiguration(ctx).selection, discovery);
      if (decision.status !== 'ready') { store.chats.hold(ctx, attempt.id, decision.reason); release(work); return; }
      const opened = await openConfiguredThread(adapter, { frozen: submission.configuration, discovery,
        currentSelection: store.providerConfiguration(ctx).selection, threadId: work.conversation.binding?.threadId,
        binding: work.conversation.binding, cwd, model: submission.model });
      if (closed) return;
      work.threadId = opened.threadId;
      if (!store.chats.bind(ctx, attempt.id, opened.binding)) { end(work, 'interrupted'); return; }
      work.unsubscribe = adapter.subscribe(opened.threadId, { onEvent: (event) => receive(work, event), onRequest: (request) => pendingRequest(work, request) });
      const images = await service.references(submission);
      if (closed) return;
      if (store.chats.attempt(attempt.id)?.status === 'interrupt-requested') { end(work, 'interrupted'); return; }
      const recheck = queuedConfigurationDecision(submission.configuration, store.providerConfiguration(ctx).selection, discovery);
      if (recheck.status !== 'ready') { store.chats.hold(ctx, attempt.id, recheck.reason); release(work); return; }
      if (store.chats.attempt(attempt.id)?.status !== 'dispatching') { release(work); return; }
      work.dispatching = true;
      const started = await adapter.startTurn({ threadId: opened.threadId, model: submission.model,
        clientUserMessageId: attempt.id, input: [{ type: 'text', text: submissionText(submission) }, ...images] });
      if (closed) return;
      work.turnId = started.turnId;
      store.chats.running(ctx, attempt.id, started.turnId);
      if (store.chats.attempt(attempt.id)?.status === 'interrupt-requested') void interrupt(work);
    } catch (error) {
      if (closed) return;
      const uncertain = ['timeout', 'process-exited', 'protocol', 'binding-mismatch', 'busy'].includes(error.kind);
      if (uncertain) end(work, 'uncertain', error.message);
      else if (['configuration-unavailable', 'fresh-context-required', 'native-unavailable'].includes(error.kind) || error.status === 409) {
        store.chats.hold(ctx, work.attempt.id, error.message, error.kind === 'native-unavailable'); release(work);
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
    });
  }
  async function reconcile() {
    store.chats.invalidateAfterRestart(ctx);
    for (const { attempt, conversation } of store.chats.unfinished(ctx)) {
      if (closed) return;
      try {
        if (!conversation.binding?.threadId) throw new Error('Native identity was not recorded; delivery cannot be established.');
        let cursor = null; let match; const seen = new Set();
        do {
          const page = await adapter.listTurns({ threadId: conversation.binding.threadId, cursor });
          if (closed) return;
          match = page.data.find((turn) => turn.items?.some((item) => item.type === 'userMessage' && item.clientId === attempt.id));
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error('Native history repeated a cursor.');
          seen.add(cursor);
        } while (!match && cursor);
        if (!match) throw new Error('No matching native turn. Non-delivery is not proven at this milestone; this submission remains held.');
        for (const item of match.items ?? []) if (item.type !== 'userMessage') store.chats.item(ctx, attempt.id,
          { id: item.id, kind: item.type, text: item.text ?? '', data: item, completed: match.status === 'completed' });
        const status = match.status === 'completed' ? 'completed' : match.status === 'interrupted' ? 'interrupted' : match.status === 'failed' ? 'failed' : 'uncertain';
        store.chats.reconcile(ctx, attempt.id, status, status === 'uncertain' ? 'Native delivery was accepted but has no terminal result. Reconciliation is required.' : 'Recovered after restart.');
      } catch (error) {
        if (!closed) store.chats.reconcile(ctx, attempt.id, error.kind === 'native-unavailable' ? 'interrupted' : 'uncertain', error.message, error.kind === 'native-unavailable');
      }
    }
  }
  void reconcile().catch((error) => { if (!closed) console.error(error); }).finally(wake);
  // Unfinished rows fence their own cards while read-only recovery proceeds.
  // An unavailable old conversation must not delay independent ready cards.
  wake();
  return {
    wake,
    stop(cardId) { const result = store.chats.stop(ctx, cardId); wake(); return result; },
    answer(cardId, requestId, response) {
      const pending = requests.get(requestId);
      if (!pending || pending.work.submission.cardId !== cardId) throw Object.assign(new Error('This request is no longer live.'), { status: 409 });
      // Do not accept native session/rule amendments. Scoped grants are a later
      // permission milestone; this boundary offers one-operation decisions only.
      if (!/item\/(commandExecution|fileChange)\/requestApproval$/.test(pending.method)
        || !response || !['accept', 'decline', 'cancel'].includes(response.decision) || Object.keys(response).length !== 1) {
        throw Object.assign(new Error('This request needs the later permission/input controls. Stop remains available.'), { status: 400 });
      }
      store.chats.answerRequest(ctx, cardId, requestId, response);
      requests.delete(requestId);
      pending.respond(response);
      return { ok: true };
    },
    close() {
      for (const work of retained) { flush(work); clearInterval(work.timer); work.unsubscribe?.(); }
      closed = true; requests.clear(); live.clear(); retained.clear();
    },
  };
}
