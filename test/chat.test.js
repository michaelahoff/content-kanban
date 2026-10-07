import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { fixture, waitFor } from './support/chat-fixture.js';

test('opening is idle; Send freezes saved context, clears composer atomically and deduplicates one browser ID', async (t) => {
  const f = await fixture(t); const card = await f.card({ title: 'Frozen title', fields: { intro: 'Saved intro', prompt: 'Legacy prompt must stay out' } });
  const opened = await f.chat(card.id);
  assert.equal(f.codex.running, false);
  assert.equal(opened.conversations[0].binding, null);
  const composer = await f.compose(card.id);
  const id = randomUUID();
  const submission = await f.queue(card.id, composer, id);
  assert.equal(submission.prompt, 'Explain this card');
  assert.equal(submission.context.fields.find((field) => field.key === 'intro').value, 'Saved intro');
  assert.equal(submission.context.fields.find((field) => field.key === 'intro').version, 1);
  assert.ok(!submission.context.fields.some((field) => field.key === 'prompt'));
  assert.equal((await f.chat(card.id)).composer.prompt, '');
  await f.ok('PATCH', `/api/cards/${card.id}`, { revision: card.revision, fields: { intro: 'New intro' } });
  const newerComposer = await f.compose(card.id, 'New draft');
  assert.equal((await f.queue(card.id, composer, id)).id, submission.id);
  assert.equal((await f.chat(card.id)).composer.prompt, newerComposer.prompt);
  const repeat = await f.queue(card.id, await f.compose(card.id));
  assert.notEqual(repeat.id, id);
  assert.equal(repeat.context.fields.find((field) => field.key === 'intro').value, 'New intro');
  assert.equal(repeat.context.fields.find((field) => field.key === 'intro').version, 2);
  assert.equal(submission.context.fields.find((field) => field.key === 'intro').value, 'Saved intro');
});

test('configuration removal holds frozen queued work and fresh context cancels rather than retargeting it', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.ok('PUT', '/api/providers/codex', { revision: 0, selection: { instructions: 'Original guidance', selected: [] } });
  const firstSubmission = await f.queue(card.id, await f.compose(card.id));
  await waitFor(() => f.codex.sends[0]);
  const queued = await f.queue(card.id, await f.compose(card.id, 'Old queued prompt'));
  await f.ok('PUT', '/api/providers/codex', { revision: 1, selection: { instructions: '', selected: [] } });
  assert.equal((await f.chat(card.id)).submissions[0].configuration.instructions, 'Original guidance');
  assert.equal((await f.chat(card.id)).attempts[0].status, 'running');
  f.codex.finish(f.codex.sends[0]);
  await waitFor(async () => (await f.chat(card.id)).submissions.find((s) => s.id === queued.id).status === 'held');
  assert.equal(f.codex.sends.length, 1);
  const blocked = await f.queue(card.id, await f.compose(card.id, 'Changed configuration'));
  assert.equal(blocked.configuration.instructions, '');
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/fresh`, {})).status, 409);
  const fresh = await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  assert.equal(fresh.submissions.find((s) => s.id === queued.id).status, 'cancelled');
  assert.equal(fresh.submissions.find((s) => s.id === blocked.id).conversationId, firstSubmission.conversationId);
  await f.queue(card.id, await f.compose(card.id, 'Fresh prompt'));
  await waitFor(() => f.codex.sends.length === 2);
  assert.notEqual(f.codex.sends[0].threadId, f.codex.sends[1].threadId);
});

test('exact image versions deduplicate role references; composer selections survive reload and damaged bytes hold delivery', async (t) => {
  const f = await fixture(t); const imageId = `${randomUUID()}.png`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(f.dataDir, 'images', imageId), png);
  const card = await f.card({ images: [{ id: imageId, name: 'Exact reference' }], imageRoles: { original: imageId, inspiration: imageId, cover: imageId } });
  const composer = await f.compose(card.id, 'Use references');
  const preview = await f.ok('POST', `/api/cards/${card.id}/chat/preview`, {});
  assert.equal(preview.context.images.length, 1);
  assert.deepEqual(preview.context.images[0].labels, ['Original', 'Inspiration']);
  assert.match(preview.context.images[0].hash, /^[a-f0-9]{64}$/);
  await f.restart();
  assert.deepEqual((await f.chat(card.id)).composer, composer);
  const sent = await f.queue(card.id, composer);
  await waitFor(() => f.codex.sends[0]);
  assert.equal(f.codex.sends[0].input.filter((input) => input.type === 'localImage').length, 1);
  assert.deepEqual(await readFile(f.codex.sends[0].input[1].path), png);
  const held = await f.queue(card.id, await f.compose(card.id, 'Frozen second image'));
  await writeFile(path.join(f.dataDir, 'images', imageId), Buffer.from('damaged'));
  f.codex.finish(f.codex.sends[0]);
  await waitFor(async () => (await f.chat(card.id)).submissions.find((row) => row.id === held.id).status === 'held');
  assert.equal(f.codex.sends.length, 1);
  assert.equal(sent.context.images[0].hash, preview.context.images[0].hash);
});

test('completed native bindings resume exactly after restart; accepted turns cut off by restart are never replayed', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id));
  await waitFor(() => f.codex.sends[0]);
  f.codex.finish(f.codex.sends[0]);
  await f.restart();
  await f.queue(card.id, await f.compose(card.id, 'Follow-up', 'other-model'));
  await waitFor(() => f.codex.sends.length === 2);
  assert.equal(f.codex.sends[1].threadId, f.codex.sends[0].threadId);
  assert.equal(f.codex.sends[1].model, 'other-model');
  await f.restart();
  await waitFor(async () => (await f.chat(card.id)).attempts[1].status === 'interrupted');
  assert.equal(f.codex.sends.length, 2);
  assert.equal((await f.chat(card.id)).attempts[1].cause, 'restart');
  assert.equal((await f.chat(card.id)).conversations[0].model, 'other-model');
});

test('three independent ready cards run together while each card serializes its frozen follow-ups', async (t) => {
  const f = await fixture(t); const cards = await Promise.all([f.card(), f.card(), f.card()]);
  for (const card of cards) await f.queue(card.id, await f.compose(card.id));
  await waitFor(() => f.codex.sends.length === 3);
  assert.equal(new Set(f.codex.sends.map((send) => send.threadId)).size, 3);
  const follow = await f.queue(cards[0].id, await f.compose(cards[0].id, 'Second prompt'));
  assert.equal(f.codex.sends.length, 3);
  const first = f.codex.sends[0];
  assert.match(first.input[0].text, /Submitted card context/);
  f.codex.finish(first);
  await waitFor(() => f.codex.sends.length === 4);
  assert.equal(f.codex.sends[3].threadId, first.threadId);
  assert.equal((await f.chat(cards[0].id)).submissions.find((row) => row.id === follow.id).status, 'running');
  assert.equal((await f.chat(cards[1].id)).attempts[0].status, 'running');
});

test('Stop retains partial output, invalidates requests and fences late events while preserving queued manual work', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id));
  await waitFor(() => f.codex.sends[0]); const first = f.codex.sends[0];
  f.codex.emit(first.threadId, { type: 'delta', turnId: first.turnId, itemId: 'partial', delta: 'Keep this partial text' });
  await waitFor(async () => (await f.chat(card.id)).items.some((item) => item.text === 'Keep this partial text'));
  f.codex.request(first);
  const requested = await waitFor(async () => { const chat = await f.chat(card.id); return chat.requests[0] && chat; });
  await f.queue(card.id, await f.compose(card.id, 'Queued follow-up'));
  f.codex.autoInterrupt = false;
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  assert.equal((await f.chat(card.id)).requests[0].status, 'invalidated');
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/answer`, { requestId: requested.requests[0].id, response: { decision: 'accept' } })).status, 409);
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true })).status, 409);
  f.codex.finish(first, 'interrupted');
  await waitFor(() => f.codex.sends.length === 2);
  f.codex.emit(first.threadId, { type: 'item-completed', turnId: first.turnId, item: { id: 'late', type: 'agentMessage', text: 'Late retained output' } });
  f.codex.emit(first.threadId, { type: 'turn-completed', turnId: first.turnId, status: 'completed' });
  const after = await f.chat(card.id);
  assert.equal(after.attempts[0].status, 'interrupted');
  assert.equal(after.attempts[1].status, 'running');
  assert.ok(after.items.some((item) => item.text === 'Late retained output'));
  assert.ok(after.items.some((item) => item.text === 'Keep this partial text'));
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  f.codex.finish(f.codex.sends[1], 'interrupted');
  const fresh = await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, {});
  assert.equal(fresh.conversations[0].state, 'previous');
  assert.equal(fresh.conversations[1].binding, null);
  assert.deepEqual(fresh.conversations[1].grants, []);
  assert.equal(f.codex.sends.length, 2);
  assert.equal((await f.ok('GET', '/api/chat-activity')).entries.some((entry) => entry.state === 'done'), false);
});

test('a deliberate retry links a new attempt to the same immutable submission and deletion atomically cancels pending work', async (t) => {
  const f = await fixture(t); const card = await f.card();
  const submission = await f.queue(card.id, await f.compose(card.id));
  await waitFor(() => f.codex.sends[0]); f.codex.finish(f.codex.sends[0], 'failed');
  await f.ok('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: submission.id });
  await waitFor(() => f.codex.sends.length === 2);
  const retried = await f.chat(card.id);
  assert.equal(retried.submissions.length, 1);
  assert.equal(retried.attempts[1].previousAttemptId, retried.attempts[0].id);
  assert.equal(retried.attempts[1].submissionId, submission.id);
  const queued = await f.queue(card.id, await f.compose(card.id, 'Do not deliver after delete'));
  f.codex.request(f.codex.sends[1]);
  await f.ok('DELETE', `/api/cards/${card.id}`);
  const deleted = await f.chat(card.id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.submissions.find((s) => s.id === queued.id).status, 'cancelled');
  assert.equal(deleted.requests[0].status, 'invalidated');
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: deleted.composer.revision })).status, 404);
  await waitFor(() => f.codex.interrupts.length === 1);
  assert.equal(f.codex.sends.length, 2);
});

test('failed queue and cancellation commits leave composer, card, submissions and active work intact', async (t) => {
  const f = await fixture(t); const card = await f.card();
  const composer = await f.compose(card.id);
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db')); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON activity_log WHEN NEW.type = 'submission_queued' BEGIN SELECT RAISE(ABORT, 'injected disk write failure'); END");
  const id = randomUUID();
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/submissions`, { id, composerRevision: composer.revision })).status, 500);
  const unchanged = await f.chat(card.id);
  assert.deepEqual(unchanged.composer, composer);
  assert.equal(unchanged.submissions.length, 0);
  assert.equal(f.codex.sends.length, 0);
  db.exec('DROP TRIGGER fail_queue');
  await f.queue(card.id, composer, id); await waitFor(() => f.codex.sends[0]);
  const queued = await f.queue(card.id, await f.compose(card.id, 'Stay queued'));
  db.exec("CREATE TRIGGER fail_cancel BEFORE INSERT ON activity_log WHEN NEW.type = 'submission_cancelled' BEGIN SELECT RAISE(ABORT, 'injected cancellation failure'); END");
  assert.equal((await f.call('DELETE', `/api/cards/${card.id}`)).status, 500);
  const retained = await f.chat(card.id);
  assert.equal(retained.deleted, false);
  assert.equal(retained.submissions.find((s) => s.id === queued.id).status, 'queued');
  assert.equal(retained.attempts[0].status, 'running');
  assert.equal(f.codex.interrupts.length, 0);
  db.exec('DROP TRIGGER fail_cancel');
});

test('a follow-up reuses the exact read-only image reference without overwriting it', async (t) => {
  const f = await fixture(t); const imageId = `${randomUUID()}.png`;
  await writeFile(path.join(f.dataDir, 'images', imageId), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64'));
  const card = await f.card({ images: [{ id: imageId, name: 'Reusable original' }], imageRoles: { original: imageId } });
  await f.queue(card.id, await f.compose(card.id)); await waitFor(() => f.codex.sends[0]);
  f.codex.finish(f.codex.sends[0]);
  await f.queue(card.id, await f.compose(card.id, 'Use that exact source again'));
  await waitFor(() => f.codex.sends.length === 2);
  assert.equal(f.codex.sends[1].input[1].path, f.codex.sends[0].input[1].path);
});

test('late previous-turn events before a follow-up receives its native identity cannot complete or populate that follow-up', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); await waitFor(() => f.codex.sends[0]);
  const first = f.codex.sends[0]; f.codex.finish(first);
  f.codex.afterSubscribe = (threadId) => {
    f.codex.emit(threadId, { type: 'item-completed', turnId: first.turnId, item: { id: 'early-late', type: 'agentMessage', text: 'OLD TURN OUTPUT' } });
    f.codex.emit(threadId, { type: 'turn-completed', turnId: first.turnId, status: 'completed' });
  };
  const follow = await f.queue(card.id, await f.compose(card.id, 'Second active prompt'));
  await waitFor(() => f.codex.sends.length === 2);
  const chat = await f.chat(card.id); const second = chat.attempts.find((attempt) => attempt.submissionId === follow.id);
  assert.equal(second.status, 'running');
  assert.equal(second.turnId, f.codex.sends[1].turnId);
  assert.ok(!chat.items.some((item) => item.attemptId === second.id && item.text === 'OLD TURN OUTPUT'));
  assert.ok(chat.items.some((item) => item.attemptId === chat.attempts[0].id && item.text === 'OLD TURN OUTPUT'));
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/fresh`, {})).status, 409);
  await f.queue(card.id, await f.compose(card.id, 'Third queued prompt'));
  assert.equal(f.codex.sends.length, 2);
});
