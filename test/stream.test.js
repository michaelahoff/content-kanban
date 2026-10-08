import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, waitFor } from './support/chat-fixture.js';

test('the stream replays durable activity after Last-Event-ID without duplicates and then delivers live changes', async (t) => {
  const f = await fixture(t); const card = await f.card();
  const { cursor } = await f.ok('GET', '/api/chat-activity');
  const submission = await f.queue(card.id, await f.compose(card.id));
  const first = await f.stream({ since: cursor });
  const queued = await first.until((frame) => frame.event === 'activity' && frame.data.type === 'submission_queued');
  assert.equal(queued.data.data.submissionId, submission.id);
  await first.close();
  const replayed = await f.stream({ since: 0, lastEventId: queued.id });
  const running = await replayed.until((frame) => frame.data.type === 'submission_running');
  assert.ok(replayed.frames.every((frame) => frame.event !== 'activity' || frame.id > queued.id));
  const ids = replayed.frames.filter((frame) => frame.event === 'activity').map((frame) => frame.id);
  assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b));
  f.codex.finish(f.codex.sends[0]);
  const completed = await replayed.until((frame) => frame.data.type === 'submission_completed');
  assert.ok(completed.id > running.id);
});

test('a client too far behind, or holding a cursor from another database, is told to resync from snapshots', async (t) => {
  const f = await fixture(t, { streamReplayLimit: 3 }); const card = await f.card();
  await f.compose(card.id, 'One'); await f.compose(card.id, 'Two'); await f.compose(card.id, 'Three'); await f.compose(card.id, 'Four');
  const { cursor } = await f.ok('GET', '/api/chat-activity');
  const behind = await f.stream({ since: 0 });
  const resync = await behind.until((frame) => frame.event === 'resync');
  assert.equal(resync.data.cursor, cursor);
  assert.equal(resync.id, cursor);
  assert.equal(behind.frames.filter((frame) => frame.event === 'activity').length, 0);
  const foreign = await f.stream({ since: cursor + 1000 });
  assert.equal((await foreign.until((frame) => frame.event === 'resync')).data.cursor, cursor);
});

test('streamed deltas carry their item offset, and a snapshot includes all text streamed so far', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  const live = await f.stream();
  f.codex.emit(send.threadId, { type: 'delta', turnId: send.turnId, itemId: 'reply', delta: 'Hel' });
  f.codex.emit(send.threadId, { type: 'delta', turnId: send.turnId, itemId: 'reply', delta: 'lo' });
  await live.until((frame) => frame.event === 'delta' && frame.data.offset === 3);
  const deltas = live.frames.filter((frame) => frame.event === 'delta').map((frame) => frame.data);
  const { attempts } = await f.chat(card.id);
  assert.deepEqual(deltas, [{ cardId: card.id, attemptId: attempts[0].id, itemId: 'reply', offset: 0, text: 'Hel' }, { cardId: card.id, attemptId: attempts[0].id, itemId: 'reply', offset: 3, text: 'lo' }]);
  // Without waiting for the periodic writer, the snapshot already holds both deltas.
  assert.equal((await f.chat(card.id)).items.find((item) => item.nativeId === 'reply').text, 'Hello');
  f.codex.emit(send.threadId, { type: 'delta', turnId: send.turnId, itemId: 'reply', delta: '!' });
  assert.equal((await live.until((frame) => frame.event === 'delta' && frame.data.text === '!')).data.offset, 5);
});
