import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';

const projectOf = async (f) => (await f.ok('GET', '/api/workspace')).projects[0];

test('archive cancels queued work, stops running work after commit and keeps history readable while blocking mutations', async (t) => {
  const f = await fixture(t); const card = await f.card({ title: 'Kept' });
  const running = await f.queue(card.id, await f.compose(card.id));
  const send = await waitFor(() => f.codex.sends[0]);
  f.codex.emit(send.threadId, { type: 'delta', turnId: send.turnId, itemId: 'partial', delta: 'Partial reply' });
  await waitFor(async () => (await f.chat(card.id)).items.some((item) => item.text === 'Partial reply'));
  f.codex.request(send);
  const { requests: [request] } = await waitFor(async () => { const chat = await f.chat(card.id); return chat.requests[0] && chat; });
  const queued = await f.queue(card.id, await f.compose(card.id, 'Queued follow-up'));
  f.codex.autoInterrupt = false;
  const project = await projectOf(f);

  await f.ok('POST', `/api/projects/${project.id}/archive`, {});
  const archived = await f.chat(card.id);
  assert.equal(archived.submissions.find((s) => s.id === queued.id).status, 'cancelled');
  assert.equal(archived.submissions.find((s) => s.id === running.id).status, 'interrupt-requested');
  assert.equal(archived.requests[0].status, 'invalidated');
  await waitFor(() => f.codex.interrupts.length === 1);
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/answer`, { requestId: request.id, response: { decision: 'accept' } })).status, 409);

  const workspace = await f.ok('GET', '/api/workspace');
  assert.ok(workspace.projects.find((p) => p.id === project.id).archivedAt);
  assert.equal((await f.ok('GET', `/api/projects/${project.id}/cards`)).cards[0].title, 'Kept');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.title, 'Kept');
  assert.ok(archived.items.some((item) => item.text === 'Partial reply'));
  for (const [method, url, body] of [
    ['PATCH', `/api/cards/${card.id}`, { revision: card.revision, title: 'Changed' }],
    ['POST', `/api/projects/${project.id}/cards`, { stageId: card.stageId }],
    ['POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: archived.composer.revision }],
    ['POST', `/api/cards/${card.id}/lane-runs`, {}],
    ['PUT', `/api/cards/${card.id}/notes`, { text: 'Late note', baseHash: (await f.ok('GET', `/api/cards/${card.id}/notes`)).hash }],
    ['PATCH', `/api/projects/${project.id}`, { name: 'Renamed' }],
  ]) {
    const response = await f.call(method, url, body);
    assert.equal(response.status, 409, `${method} ${url}: ${JSON.stringify(response.body)}`);
    assert.match(response.body.error, /archived/i);
  }

  f.codex.finish(send, 'interrupted');
  await waitFor(async () => (await f.chat(card.id)).submissions.find((s) => s.id === running.id).status === 'interrupted');
  await f.ok('POST', `/api/projects/${project.id}/unarchive`, {});
  assert.equal((await f.ok('GET', '/api/workspace')).projects.find((p) => p.id === project.id).archivedAt, null);
  const retry = await f.call('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: running.id });
  assert.equal(retry.status, 409);
  assert.match(retry.body.error, /archived/i);
  const after = await f.chat(card.id);
  assert.equal(after.submissions.find((s) => s.id === queued.id).status, 'cancelled');
  assert.equal(f.codex.sends.length, 1);

  // Unarchived projects accept new, explicit work.
  await f.queue(card.id, await f.compose(card.id, 'New work'));
  await waitFor(() => f.codex.sends.length === 2);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
const result = (value) => `Done.\n\n\`\`\`frameboard-result\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const runs = async (f, cardId) => (await f.ok('GET', `/api/cards/${cardId}/lane-runs`)).runs;

test('an archived lane run’s late tools, images and result cannot affect the card or a newer attempt after unarchive', async (t) => {
  const f = await fixture(t);
  const workspace = await f.ok('GET', '/api/workspace');
  const project = workspace.projects[0]; const stage = workspace.flows[0].stages[0];
  await setPlaybook(f.ok, project.flowId, stage, { run: 'manual', model: 'test-model', may_edit: ['intro'] }, 'Write an intro.');
  const card = await f.card();
  const composer = await f.compose(card.id, 'Newer work');
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const old = await waitFor(() => f.codex.sends[0]);
  f.codex.autoInterrupt = false;
  await f.ok('POST', `/api/projects/${project.id}/archive`, {});
  const [archivedRun] = await runs(f, card.id);
  await f.ok('POST', `/api/projects/${project.id}/unarchive`, {});

  await f.queue(card.id, composer);
  // The old attempt is still interrupt-requested, so the newer one waits behind it.
  assert.equal(f.codex.sends.length, 1);
  const late = await f.codex.tool(old, 'edit_fields', { fields: { intro: 'Late tool edit' }, baseVersions: { intro: 1 } });
  assert.equal(late.success, false);
  assert.match(late.contentItems[0].text, /no longer has card-tool authority/);
  f.codex.image(old, { result: png.toString('base64') });
  f.codex.finish(old, 'completed', result({ fields: { intro: 'Late result' }, notes: 'Late notes.', move: stage.name }));
  const newer = await waitFor(() => f.codex.sends[1]);
  f.codex.emit(old.threadId, { type: 'turn-completed', turnId: old.turnId, status: 'completed' });

  const chat = await f.chat(card.id);
  assert.equal(chat.attempts[0].status, 'interrupted');
  assert.equal(chat.attempts[1].status, 'running');
  assert.equal(chat.outputs.length, 0);
  assert.equal(chat.proposals.length, 0);
  assert.ok(chat.items.some((item) => item.kind === 'imageGeneration'), 'The late native image stays in the transcript');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, '');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}/notes`)).text, '');
  assert.equal((await runs(f, card.id)).find((run) => run.id === archivedRun.id).status, 'failed');
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: archivedRun.submissionId })).status, 409);

  await f.restart();
  f.codex.finish(newer, 'completed');
  assert.equal((await f.chat(card.id)).outputs.length, 0);
  assert.equal(f.codex.sends.length, 2);
});

test('restart after archive settles uncertain and preparing work without requeueing, and unarchive dispatches nothing', async (t) => {
  const f = await fixture(t); const project = await projectOf(f);
  const uncertainCard = await f.card(); const preparingCard = await f.card();
  f.codex.startError = { error: Object.assign(new Error('Codex did not answer turn/start in time.'), { kind: 'timeout' }), recorded: false };
  const uncertain = await f.queue(uncertainCard.id, await f.compose(uncertainCard.id));
  await waitFor(async () => (await f.chat(uncertainCard.id)).submissions[0].status === 'uncertain');
  f.codex.openGate = new Promise(() => {});
  const preparing = await f.queue(preparingCard.id, await f.compose(preparingCard.id));
  await waitFor(async () => (await f.chat(preparingCard.id)).attempts[0]?.status === 'dispatching');

  await f.ok('POST', `/api/projects/${project.id}/archive`, {});
  f.codex.openGate = null;
  await f.restart();
  await f.ok('POST', `/api/projects/${project.id}/unarchive`, {});
  await f.ok('POST', `/api/cards/${uncertainCard.id}/chat/reconcile`, {});
  for (const [card, submission] of [[uncertainCard, uncertain], [preparingCard, preparing]]) {
    const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.submissions[0].status === 'interrupted' && value; });
    assert.equal(chat.attempts.length, 1, 'No new attempt was created');
    assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: submission.id })).status, 409);
  }
  assert.equal(f.codex.sends.length, 0);
});

test('archive during lane run preparation cancels it before any submission, and unarchive does not revive it', async (t) => {
  const f = await fixture(t);
  const workspace = await f.ok('GET', '/api/workspace');
  const project = workspace.projects[0]; const stages = workspace.flows[0].stages;
  await setPlaybook(f.ok, project.flowId, stages[1], { model: 'test-model' }, 'Write an intro.');
  const card = await f.card();
  const discover = f.codex.discover.bind(f.codex);
  let entered = false; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.codex.discover = async (...args) => { entered = true; await gate; return discover(...args); };
  t.after(release);
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  await waitFor(() => entered);
  await f.ok('POST', `/api/projects/${project.id}/archive`, {});
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const [run] = await runs(f, card.id);
  assert.equal(run.status, 'cancelled');
  assert.match(run.reason, /archived/);
  await f.ok('POST', `/api/projects/${project.id}/unarchive`, {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await runs(f, card.id))[0].status, 'cancelled');
  assert.deepEqual((await f.chat(card.id)).submissions, []);
  assert.deepEqual(f.codex.sends, []);
});

test('a manual Send still being prepared when the project is archived is refused, even after unarchive', async (t) => {
  const f = await fixture(t); const project = await projectOf(f); const card = await f.card();
  const composer = await f.compose(card.id);
  const discover = f.codex.discover.bind(f.codex);
  let entered = false; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.codex.discover = async (...args) => { entered = true; await gate; return discover(...args); };
  t.after(release);
  const sending = f.call('POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: composer.revision });
  await waitFor(() => entered);
  await f.ok('POST', `/api/projects/${project.id}/archive`, {});
  await f.ok('POST', `/api/projects/${project.id}/unarchive`, {});
  release();
  const response = await sending;
  assert.equal(response.status, 409);
  assert.match(response.body.error, /archived/);
  assert.deepEqual((await f.chat(card.id)).submissions, []);
  assert.deepEqual(f.codex.sends, []);
});

test('archive while dispatch is rechecking configuration settles the attempt so the card is usable after unarchive', async (t) => {
  const f = await fixture(t); const project = await projectOf(f); const card = await f.card();
  const composer = await f.compose(card.id);
  const discover = f.codex.discover.bind(f.codex);
  let armed = false; let entered = false; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(release);
  // After binding, the worker discovers the configuration once more before sending.
  f.codex.afterSubscribe = () => { armed = true; };
  f.codex.discover = async (...args) => { if (armed) { entered = true; await gate; } return discover(...args); };
  const submission = await f.queue(card.id, composer);
  await waitFor(() => entered);
  await f.ok('POST', `/api/projects/${project.id}/archive`, {});
  release();
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.submissions[0].status === 'interrupted' && value; });
  assert.equal(chat.attempts[0].status, 'interrupted');
  await f.ok('POST', `/api/projects/${project.id}/unarchive`, {});
  await f.queue(card.id, await f.compose(card.id, 'New work'));
  await waitFor(() => f.codex.sends.length === 1);
  assert.notEqual(f.codex.sends[0].clientUserMessageId, chat.attempts[0].id);
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: submission.id })).status, 409);
});
