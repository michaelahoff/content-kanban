import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, waitFor } from './support/chat-fixture.js';
import { openStore } from '../store.js';

const never = new Promise(() => {});
const attemptsOf = async (f, cardId) => (await f.chat(cardId)).attempts;

test('a crash before any native binding requeues the submission automatically as a linked attempt, exactly once', async (t) => {
  const f = await fixture(t); const card = await f.card();
  f.codex.openGate = never;
  const submission = await f.queue(card.id, await f.compose(card.id));
  await waitFor(async () => (await attemptsOf(f, card.id))[0]?.status === 'dispatching');
  f.codex.openGate = null;
  await f.restart();
  await waitFor(() => f.codex.sends.length === 1);
  const chat = await f.chat(card.id);
  assert.equal(chat.submissions.length, 1);
  assert.equal(chat.attempts[0].status, 'not-delivered');
  assert.equal(chat.attempts[1].previousAttemptId, chat.attempts[0].id);
  assert.equal(chat.attempts[1].submissionId, submission.id);
  assert.equal(f.codex.sends[0].clientUserMessageId, chat.attempts[1].id);
  await f.restart();
  assert.equal(f.codex.sends.length, 1);
});

test('a crash after binding but before turn/start proves non-delivery from complete native history and resumes the same thread', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); await waitFor(() => f.codex.sends[0]);
  f.codex.finish(f.codex.sends[0]);
  f.codex.startGate = never;
  await f.queue(card.id, await f.compose(card.id, 'Follow-up not yet sent'));
  await waitFor(async () => (await attemptsOf(f, card.id))[1]?.status === 'dispatching');
  f.codex.startGate = null;
  await f.restart();
  await waitFor(() => f.codex.sends.length === 2);
  const chat = await f.chat(card.id);
  assert.equal(chat.attempts[1].status, 'not-delivered');
  assert.equal(chat.attempts[2].previousAttemptId, chat.attempts[1].id);
  assert.equal(f.codex.sends[1].threadId, f.codex.sends[0].threadId);
});

test('a crash after Codex recorded the turn but before acknowledgement imports its completed output once and never resends', async (t) => {
  const f = await fixture(t); const card = await f.card();
  f.codex.ackGate = never;
  await f.queue(card.id, await f.compose(card.id));
  await waitFor(() => f.codex.sends[0]);
  assert.equal((await attemptsOf(f, card.id))[0].turnId, null);
  const send = f.codex.sends[0]; const turn = f.codex.threads.get(send.threadId).turns[0];
  turn.items.push({ type: 'agentMessage', id: 'answer', text: 'Answered while Frameboard was down' }); turn.status = 'completed';
  f.codex.ackGate = null;
  await f.restart();
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'completed');
  // Duplicate and out-of-order native events after recovery change nothing.
  f.codex.emit(send.threadId, { type: 'item-started', turnId: send.turnId, item: { type: 'agentMessage', id: 'answer', text: '' } });
  f.codex.emit(send.threadId, { type: 'turn-completed', turnId: send.turnId, status: 'completed' });
  await f.restart();
  const chat = await f.chat(card.id);
  assert.equal(chat.attempts[0].turnId, send.turnId, 'Recovery retains the exact native turn identity.');
  assert.deepEqual(chat.items.map((item) => item.text), ['Answered while Frameboard was down']);
  assert.equal(chat.attempts.length, 1);
  assert.equal(f.codex.sends.length, 1);
});

test('lost acknowledgement recovery establishes history so a later missing thread cannot be replaced automatically', async (t) => {
  const f = await fixture(t); const card = await f.card();
  f.codex.ackGate = never;
  await f.queue(card.id, await f.compose(card.id)); const first = await waitFor(() => f.codex.sends[0]);
  const turn = f.codex.threads.get(first.threadId).turns[0];
  turn.status = 'completed'; turn.items.push({ type: 'agentMessage', id: 'recovered', text: 'Retained first answer' });
  f.codex.ackGate = null; await f.restart();
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'completed');
  f.codex.startGate = never;
  await f.queue(card.id, await f.compose(card.id, 'Undelivered follow-up'));
  await waitFor(async () => (await f.chat(card.id)).attempts[1]?.status === 'dispatching');
  f.codex.threads.delete(first.threadId); f.codex.startGate = null;
  await f.restart();
  await waitFor(async () => (await f.chat(card.id)).conversations[0].state === 'native-unavailable');
  const chat = await f.chat(card.id);
  assert.equal(chat.conversations[0].binding.threadId, first.threadId);
  assert.equal(chat.submissions[1].status, 'interrupted');
  assert.equal(f.codex.sends.length, 1);
  assert.ok(chat.items.some((item) => item.text === 'Retained first answer'));
  assert.equal((await f.ok('GET', '/api/chat-activity')).entries[0].state, 'needs-attention');
});

test('a crash during streaming retains the partial reply as interrupted, needs attention and is not resent', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  f.codex.emit(send.threadId, { type: 'delta', turnId: send.turnId, itemId: 'streamed', delta: 'Half a reply' });
  await waitFor(async () => (await f.chat(card.id)).items.some((item) => item.text === 'Half a reply'));
  await f.restart();
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'interrupted');
  const chat = await f.chat(card.id);
  assert.equal(chat.items.find((item) => item.nativeId === 'streamed').completed, false);
  assert.equal(chat.items.find((item) => item.nativeId === 'streamed').text, 'Half a reply');
  assert.equal(f.codex.sends.length, 1);
  const [entry] = (await f.ok('GET', '/api/chat-activity')).entries;
  assert.equal(entry.state, 'needs-attention');
});

const codexError = (kind, message, extra = {}) => Object.assign(new Error(message), { kind, ...extra });

test('an unanswered turn/start is held visibly; reconciliation without proof keeps it held and only an explicit resolution permits a deliberate retry', async (t) => {
  const f = await fixture(t); const card = await f.card();
  f.codex.startError = { error: codexError('timeout', 'Codex did not answer turn/start in time.'), recorded: false };
  const submission = await f.queue(card.id, await f.compose(card.id));
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'uncertain');
  const queued = await f.queue(card.id, await f.compose(card.id, 'Waits behind the ambiguity'));
  assert.equal((await f.ok('GET', '/api/chat-activity')).entries[0].state, 'needs-attention');
  await f.ok('POST', `/api/cards/${card.id}/chat/reconcile`, {});
  let chat = await f.chat(card.id);
  assert.equal(chat.submissions[0].status, 'uncertain');
  assert.equal(chat.submissions.find((s) => s.id === queued.id).status, 'queued');
  assert.equal(f.codex.sends.length, 0);
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: submission.id })).status, 409);
  await f.ok('POST', `/api/cards/${card.id}/chat/resolve`, { attemptId: chat.attempts[0].id });
  await waitFor(() => f.codex.sends.length === 1);
  chat = await f.chat(card.id);
  assert.equal(chat.submissions[0].status, 'interrupted');
  assert.equal(f.codex.sends[0].clientUserMessageId, chat.attempts.find((a) => a.submissionId === queued.id).id);
  f.codex.finish(f.codex.sends[0]);
  await f.ok('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: submission.id });
  await waitFor(() => f.codex.sends.length === 2);
  chat = await f.chat(card.id);
  const retried = chat.attempts.filter((a) => a.submissionId === submission.id);
  assert.equal(retried[1].previousAttemptId, retried[0].id);
});

test('a Codex exit during turn/start reconciles at once: a recorded turn is kept without resending, an unrecorded one is requeued', async (t) => {
  const f = await fixture(t); const [kept, requeued] = await Promise.all([f.card(), f.card()]);
  f.codex.startError = { error: codexError('process-exited', 'The Codex app-server stopped.'), recorded: true };
  await f.queue(kept.id, await f.compose(kept.id));
  await waitFor(async () => (await f.chat(kept.id)).submissions[0].status === 'interrupted');
  assert.equal(f.codex.sends.length, 1);
  assert.equal((await f.chat(kept.id)).attempts.length, 1);
  f.codex.startError = { error: codexError('process-exited', 'The Codex app-server stopped.'), recorded: false };
  await f.queue(requeued.id, await f.compose(requeued.id));
  await waitFor(() => f.codex.sends.length === 2);
  const chat = await f.chat(requeued.id);
  assert.deepEqual(chat.attempts.map((a) => a.status), ['not-delivered', 'running']);
});

const overloaded = () => ({ error: codexError('rpc', 'Server overloaded; retry later.', { code: -32001 }), recorded: false });

test('Stop during a pending send survives pre-accept rejection or process exit without resending', async (t) => {
  for (const failure of [overloaded(), { error: codexError('process-exited', 'Codex exited before acceptance.'), recorded: false }]) {
    const f = await fixture(t); const card = await f.card();
    let rejectSend;
    f.codex.startGate = new Promise((resolve) => { rejectSend = resolve; });
    f.codex.startError = failure;
    await f.queue(card.id, await f.compose(card.id));
    await waitFor(async () => (await f.chat(card.id)).conversations[0].binding);
    await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
    rejectSend();
    await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'interrupted');
    assert.equal(f.codex.sends.length, 0);
    assert.deepEqual((await f.ok('GET', '/api/chat-activity')).entries, []);
    await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  }
});

test('Stop remains interrupted when a lost interruption response is reconciled to completed native output', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  f.codex.interrupt = async () => { throw codexError('timeout', 'Interruption response was lost.'); };
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  await waitFor(async () => (await f.chat(card.id)).attempts[0].status === 'uncertain');
  const turn = f.codex.threads.get(send.threadId).turns[0];
  turn.status = 'completed'; turn.items.push({ type: 'agentMessage', id: 'late-answer', text: 'Output completed around Stop' });
  await f.ok('POST', `/api/cards/${card.id}/chat/reconcile`, {});
  const chat = await f.chat(card.id);
  assert.equal(chat.submissions[0].status, 'interrupted');
  assert.equal(chat.attempts[0].cause, 'user');
  assert.ok(chat.items.some((item) => item.text === 'Output completed around Stop'));
  assert.deepEqual((await f.ok('GET', '/api/chat-activity')).entries, []);
});

test('Stop during the outside-continuation history check settles the unsent attempt', async (t) => {
  for (const outside of [false, true]) {
    const f = await fixture(t); const card = await f.card();
    await f.queue(card.id, await f.compose(card.id)); const first = await waitFor(() => f.codex.sends[0]);
    f.codex.finish(first);
    await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'completed');
    if (outside) f.codex.threads.get(first.threadId).turns.push({ id: 'outside-during-stop', status: 'completed', items: [] });
    let releaseHistory; let checking = false;
    const gate = new Promise((resolve) => { releaseHistory = resolve; });
    const listTurns = f.codex.listTurns.bind(f.codex);
    f.codex.listTurns = async (input) => { checking = true; await gate; return listTurns(input); };
    await f.queue(card.id, await f.compose(card.id, 'Stop before follow-up dispatch'));
    await waitFor(() => checking);
    await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
    releaseHistory();
    await waitFor(async () => (await f.chat(card.id)).submissions[1].status === 'interrupted');
    assert.equal(f.codex.sends.length, 1);
    await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  }
});

test('a proven pre-accept overload waits for the provider with backoff and is then delivered once', async (t) => {
  const f = await fixture(t, { providerBackoffMs: 400 }); const card = await f.card();
  f.codex.startGate = new Promise((resolve) => { f.codex.releaseStart = resolve; });
  f.codex.startError = overloaded();
  await f.queue(card.id, await f.compose(card.id));
  f.codex.releaseStart();
  const waiting = await waitFor(async () => (await f.ok('GET', '/api/chat-activity')).entries.find((entry) => entry.waitingForProvider));
  assert.equal(waiting.state, 'working');
  assert.match(waiting.reason, /Waiting for provider/);
  await waitFor(() => f.codex.sends.length === 1);
  const chat = await f.chat(card.id);
  assert.deepEqual(chat.attempts.map((a) => a.status), ['not-delivered', 'running']);
  assert.equal(chat.attempts[1].previousAttemptId, chat.attempts[0].id);
});

test('provider retry deadlines exclude waiting work blocked by an earlier held submission', async (t) => {
  const f = await fixture(t, { providerBackoffMs: 1000 }); const card = await f.card();
  const first = await f.queue(card.id, await f.compose(card.id)); const sent = await waitFor(() => f.codex.sends[0]);
  f.codex.finish(sent, 'failed');
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'failed');
  f.codex.startError = overloaded();
  await f.queue(card.id, await f.compose(card.id, 'Later waiting work'));
  const waiting = await waitFor(async () => (await f.chat(card.id)).submissions.find((row) => row.status === 'waiting'));
  f.codex.threads.get(sent.threadId).turns.push({ id: 'outside-before-retry', status: 'completed', items: [] });
  await f.ok('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: first.id });
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'held');
  const store = await openStore({ dataDir: f.dataDir });
  try {
    const ctx = { ...store.owner, actor: `user:${store.owner.userId}` };
    assert.equal(store.chats.nextRetry(ctx), null, 'Blocked work needs no provider timer.');
    await f.ok('POST', `/api/cards/${card.id}/chat/cancel`, { submissionId: first.id });
    assert.equal(store.chats.nextRetry(ctx), waiting.retryAt, 'Unblocking work restores its original retry deadline.');
  } finally { store.close(); }
});

test('repeated pre-accept rejections stop waiting and require an explicit retry', async (t) => {
  const f = await fixture(t); const card = await f.card();
  let rejections = 0;
  const startTurn = f.codex.startTurn.bind(f.codex);
  f.codex.startTurn = async (input) => { rejections++; f.codex.startError = overloaded(); return startTurn(input); };
  await f.queue(card.id, await f.compose(card.id));
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'failed');
  assert.equal(f.codex.sends.length, 0);
  const settled = rejections;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(rejections, settled);
  assert.equal((await f.ok('GET', '/api/chat-activity')).entries[0].state, 'needs-attention');
});

test('exhausted usage after acceptance fails with its reset information and is never retried automatically', async (t) => {
  const f = await fixture(t); const [limited, other] = await Promise.all([f.card(), f.card()]);
  await f.queue(limited.id, await f.compose(limited.id)); const send = await waitFor(() => f.codex.sends[0]);
  f.codex.emit(send.threadId, { type: 'turn-completed', turnId: send.turnId, status: 'failed',
    error: { message: 'You have hit your usage limit. Try again at 4:00 PM.', codexErrorInfo: 'usageLimitExceeded' } });
  await waitFor(async () => (await f.chat(limited.id)).submissions[0].status === 'failed');
  const [entry] = (await f.ok('GET', '/api/chat-activity')).entries;
  assert.equal(entry.state, 'needs-attention');
  assert.match(entry.reason, /Usage limit reached.*Try again at 4:00 PM/);
  await f.queue(other.id, await f.compose(other.id)); await waitFor(() => f.codex.sends.length === 2);
  assert.equal(f.codex.sends.filter((s) => s.threadId === send.threadId).length, 1);
});

test('an unavailable model at dispatch fails without substitution', async (t) => {
  const f = await fixture(t); const card = await f.card();
  f.codex.openGate = new Promise((resolve) => { f.codex.releaseOpen = resolve; });
  await f.queue(card.id, await f.compose(card.id, 'Use the chosen model', 'other-model'));
  f.codex.models = ['test-model']; f.codex.releaseOpen();
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'failed');
  assert.equal(f.codex.sends.length, 0);
});

test('a conversation continued outside Frameboard holds the next prompt for an explicit choice and never imports those turns', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const first = await waitFor(() => f.codex.sends[0]);
  f.codex.finish(first);
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'completed');
  f.codex.threads.get(first.threadId).turns.push({ id: 'cli-turn', status: 'completed',
    items: [{ type: 'userMessage', id: 'cli-user', content: [] }, { type: 'agentMessage', id: 'cli-answer', text: 'Answered in the CLI' }] });
  const follow = await f.queue(card.id, await f.compose(card.id, 'Follow-up after outside use'));
  await waitFor(async () => (await f.chat(card.id)).submissions[1].status === 'held');
  let chat = await f.chat(card.id);
  assert.match(chat.submissions[1].reason, /continued outside Frameboard \(1 turn\)/);
  assert.ok(!chat.items.some((item) => item.text === 'Answered in the CLI'));
  assert.equal(f.codex.sends.length, 1);
  assert.equal((await f.ok('GET', '/api/chat-activity')).entries[0].state, 'needs-attention');
  await f.ok('POST', `/api/cards/${card.id}/chat/continue`, { submissionId: follow.id });
  await waitFor(() => f.codex.sends.length === 2);
  assert.equal(f.codex.sends[1].threadId, first.threadId);
  f.codex.finish(f.codex.sends[1]);
  await f.queue(card.id, await f.compose(card.id, 'Acknowledged turns do not hold again'));
  await waitFor(() => f.codex.sends.length === 3);
  chat = await f.chat(card.id);
  assert.ok(chat.items.some((item) => item.kind === 'notice' && /outside Frameboard/.test(item.text)));
});

test('missing native history after restart keeps app history readable, needs attention and permits only empty fresh context', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const first = await waitFor(() => f.codex.sends[0]);
  f.codex.finish(first);
  await f.queue(card.id, await f.compose(card.id, 'Running when history vanished')); const second = await waitFor(() => f.codex.sends[1]);
  f.codex.emit(second.threadId, { type: 'delta', turnId: second.turnId, itemId: 'partial', delta: 'Partial before loss' });
  await waitFor(async () => (await f.chat(card.id)).items.some((item) => item.text === 'Partial before loss'));
  f.codex.threads.delete(first.threadId);
  await f.restart();
  await waitFor(async () => (await f.chat(card.id)).conversations[0].state === 'native-unavailable');
  const chat = await f.chat(card.id);
  assert.equal(chat.submissions[1].status, 'interrupted');
  assert.ok(chat.items.some((item) => item.text === 'A completed reply'));
  assert.ok(chat.items.some((item) => item.text === 'Partial before loss'));
  assert.equal((await f.ok('GET', '/api/chat-activity')).entries[0].state, 'needs-attention');
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: chat.submissions[1].id })).status, 409);
  const fresh = await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  assert.equal(fresh.conversations[1].binding, null);
  await f.queue(card.id, await f.compose(card.id, 'Start again without replay'));
  await waitFor(() => f.codex.sends.length === 3);
  assert.notEqual(f.codex.sends[2].threadId, first.threadId);
  assert.doesNotMatch(f.codex.sends[2].input[0].text, /Running when history vanished/);
});

test('repeated and out-of-order native events cannot duplicate items or requests, or reopen an answered request', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  const item = { type: 'agentMessage', id: 'final', text: 'Complete answer' };
  f.codex.emit(send.threadId, { type: 'item-completed', turnId: send.turnId, item });
  f.codex.emit(send.threadId, { type: 'item-completed', turnId: send.turnId, item });
  f.codex.emit(send.threadId, { type: 'item-started', turnId: send.turnId, item: { ...item, text: '' } });
  f.codex.emit(send.threadId, { type: 'delta', turnId: send.turnId, itemId: 'final', delta: ' duplicated tail' });
  f.codex.request(send, undefined, {}, 'native-7');
  const requested = await waitFor(async () => { const chat = await f.chat(card.id); return chat.requests[0] && chat; });
  f.codex.request(send, undefined, {}, 'native-7');
  await f.ok('POST', `/api/cards/${card.id}/chat/answer`, { requestId: requested.requests[0].id, response: { decision: 'decline', scope: 'once' } });
  const repeated = f.codex.request(send, undefined, {}, 'native-7');
  await waitFor(() => repeated.results.length === 1);
  assert.deepEqual(repeated.results[0], { decision: 'decline' });
  const chat = await f.chat(card.id);
  assert.deepEqual(chat.items.map((entry) => entry.text), ['Complete answer']);
  assert.equal(chat.requests.length, 1);
  assert.equal(chat.requests[0].status, 'answered');
  const pendingEvents = (await f.ok('GET', '/api/events?since=0')).events.filter((event) => event.type === 'request_pending');
  assert.equal(pendingEvents.length, 1);
});

test('indicators are rebuilt from durable rows in priority order, and viewing from any tab clears Done once for every tab', async (t) => {
  const f = await fixture(t); const [done, working, input, attention] = await Promise.all([f.card(), f.card(), f.card(), f.card()]);
  for (const card of [done, working, input, attention]) await f.queue(card.id, await f.compose(card.id));
  await waitFor(() => f.codex.sends.length === 4);
  const byCard = async (card) => { const threadId = (await f.chat(card.id)).conversations[0].binding.threadId; return f.codex.sends.find((send) => send.threadId === threadId); };
  f.codex.finish(await byCard(done));
  f.codex.request(await byCard(input));
  f.codex.finish(await byCard(attention), 'failed', 'Failed reply');
  await waitFor(async () => (await f.ok('GET', '/api/chat-activity')).entries.length === 4);
  await f.restart();
  const { entries, cursor } = await f.ok('GET', '/api/chat-activity');
  assert.ok(Number.isInteger(cursor));
  // The restart invalidated the pending request and interrupted active turns.
  const state = (card) => entries.find((entry) => entry.cardId === card.id)?.state;
  assert.equal(state(done), 'done');
  assert.equal(state(attention), 'needs-attention');
  assert.deepEqual(entries.map((entry) => entry.state), [...entries.map((entry) => entry.state)].sort((a, b) =>
    ['input-needed', 'needs-attention', 'working', 'done'].indexOf(a) - ['input-needed', 'needs-attention', 'working', 'done'].indexOf(b)));
  await f.ok('POST', `/api/cards/${done.id}/chat/viewed`, {});
  await f.ok('POST', `/api/cards/${done.id}/chat/viewed`, {});
  assert.equal((await f.ok('GET', '/api/chat-activity')).entries.some((entry) => entry.cardId === done.id), false);
  const viewed = (await f.ok('GET', `/api/events?since=${cursor}`)).events.filter((event) => event.type === 'chat_viewed');
  assert.equal(viewed.length, 1);
});

test('Working reports its attempt start for the timer, and Input needed names the originating request', async (t) => {
  const f = await fixture(t); const [working, input] = await Promise.all([f.card(), f.card()]);
  await f.queue(working.id, await f.compose(working.id)); await waitFor(() => f.codex.sends.length === 1);
  await f.queue(input.id, await f.compose(input.id)); const send = await waitFor(() => f.codex.sends[1]);
  f.codex.request(send);
  const entries = await waitFor(async () => { const value = (await f.ok('GET', '/api/chat-activity')).entries; return value.length === 2 && value[0].state === 'input-needed' && value; });
  assert.equal(entries[0].cardId, input.id);
  assert.equal(entries[0].requestId, (await f.chat(input.id)).requests[0].id);
  assert.equal(entries[0].startedAt, null);
  assert.equal(entries[1].state, 'working');
  assert.equal(entries[1].startedAt, (await f.chat(working.id)).attempts[0].startedAt);
});

test('three ready cards with text, approval and image work progress independently with one attempt each', async (t) => {
  const f = await fixture(t); const [text, approval, image] = await Promise.all([f.card(), f.card(), f.card()]);
  for (const card of [text, approval, image]) await f.queue(card.id, await f.compose(card.id));
  await waitFor(() => f.codex.sends.length === 3);
  const sendFor = async (card) => { const threadId = (await f.chat(card.id)).conversations[0].binding.threadId; return f.codex.sends.find((send) => send.threadId === threadId); };
  f.codex.request(await sendFor(approval));
  const pending = await waitFor(async () => (await f.chat(approval.id)).requests[0]);
  f.codex.finish(await sendFor(text));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
  f.codex.image(await sendFor(image), { result: png.toString('base64') });
  await waitFor(async () => (await f.chat(image.id)).outputs[0]?.importStatus === 'imported');
  const states = Object.fromEntries((await waitFor(async () => { const { entries } = await f.ok('GET', '/api/chat-activity'); return entries.length === 3 && entries; })).map((entry) => [entry.cardId, entry.state]));
  assert.deepEqual(states, { [text.id]: 'done', [approval.id]: 'input-needed', [image.id]: 'working' });
  await f.ok('POST', `/api/cards/${approval.id}/chat/answer`, { requestId: pending.id, response: { decision: 'accept', scope: 'once' } });
  f.codex.finish(await sendFor(approval)); f.codex.finish(await sendFor(image));
  for (const card of [text, approval, image]) {
    await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'completed');
    assert.equal((await f.chat(card.id)).attempts.length, 1);
  }
  assert.equal(f.codex.sends.length, 3);
});

test('a Stop requested before delivery is honored after a crash rather than requeued, and is not Done or attention', async (t) => {
  const f = await fixture(t); const card = await f.card();
  f.codex.openGate = never;
  await f.queue(card.id, await f.compose(card.id));
  await waitFor(async () => (await attemptsOf(f, card.id))[0]?.status === 'dispatching');
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  f.codex.openGate = null;
  await f.restart();
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'interrupted');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.codex.sends.length, 0);
  assert.equal((await attemptsOf(f, card.id)).length, 1);
  assert.deepEqual((await f.ok('GET', '/api/chat-activity')).entries, []);
});
