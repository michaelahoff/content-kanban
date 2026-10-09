import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';

// Retry resends one frozen lane submission as a new attempt. Run playbook is
// new whole work from what is saved now. Neither reapplies lane-entry values.
async function laneFixture(t, options) {
  const f = await fixture(t, options);
  const workspace = await f.ok('GET', '/api/workspace');
  const projectId = workspace.projects[0].id; const flowId = workspace.projects[0].flowId; const stages = workspace.flows[0].stages;
  const runs = async (cardId) => (await f.ok('GET', `/api/cards/${cardId}/lane-runs`)).runs;
  const retry = (cardId, submissionId) => f.call('POST', `/api/cards/${cardId}/chat/retry`, { submissionId });
  const sentText = (send) => send.input.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
  const codexError = (kind, message) => Object.assign(new Error(message), { kind });
  async function upload(filename, text, query = {}) {
    const response = await f.raw(`/api/projects/${projectId}/library/uploads?${new URLSearchParams({ filename, operation: randomUUID(), ...query })}`, { method: 'POST', body: Buffer.from(text) });
    const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body));
    return { ...body.asset, version: body.version };
  }
  const repair = (version, text) => f.raw(`/api/projects/${projectId}/library/versions/${version.id}/repair`, { method: 'POST', body: Buffer.from(text) });
  const save = async (relative, text) => {
    const listed = await f.ok('GET', `/api/flows/${flowId}/playbooks`);
    const existing = [listed.map, ...listed.lanes, ...listed.skills].find((document) => document?.path === relative);
    return (await f.ok('PUT', `/api/flows/${flowId}/playbooks`, { path: relative, text, baseHash: existing?.hash ?? null })).document;
  };
  const notes = async (cardId, text) => f.ok('PUT', `/api/cards/${cardId}/notes`, { text, baseHash: (await f.ok('GET', `/api/cards/${cardId}/notes`)).hash });
  const edit = async (cardId, fields) => {
    const { card } = await f.ok('GET', `/api/cards/${cardId}`);
    return (await f.ok('PATCH', `/api/cards/${cardId}`, { revision: card.revision, fields: { ...card.fields, ...fields } })).card;
  };
  return { ...f, flowId, stages, runs, retry, sentText, codexError, upload, repair, save, notes, edit };
}

test('Retry of a failed lane run waits for an uncertain later delivery to be reconciled instead of jumping ahead of it', async (t) => {
  const f = await laneFixture(t);
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model' }, 'Write an intro.');
  const card = await f.card();
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  f.codex.finish(await waitFor(() => f.codex.sends[0]), 'failed');
  const failed = await waitFor(async () => (await f.runs(card.id)).find((run) => run.status === 'failed'));

  f.codex.startError = { error: f.codexError('timeout', 'Codex did not answer turn/start in time.'), recorded: true };
  await f.queue(card.id, await f.compose(card.id, 'A later prompt'));
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.submissions.at(-1).status === 'uncertain' && value; });

  assert.equal((await f.runs(card.id)).find((run) => run.id === failed.id).retryable, false);
  assert.equal(chat.submissions.find((submission) => submission.id === failed.submissionId).retryable, false, 'history offers no Retry it would refuse');
  const refused = await f.retry(card.id, failed.submissionId);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /uncertain/i);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.codex.sends.length, 2, 'nothing is sent into the conversation before the uncertain delivery is reconciled');

  await f.ok('POST', `/api/cards/${card.id}/chat/resolve`, { attemptId: chat.attempts.at(-1).id });
  assert.equal((await f.runs(card.id)).find((run) => run.id === failed.id).retryable, true);
  assert.equal((await f.chat(card.id)).submissions.find((submission) => submission.id === failed.submissionId).retryable, true);
  assert.equal((await f.retry(card.id, failed.submissionId)).status, 200);
  const resent = await waitFor(() => f.codex.sends[2]);
  assert.equal(f.sentText(resent), f.sentText(f.codex.sends[0]));
});

test('a run that failed before queueing, or whose reply was recovered after a restart, offers no Retry; Run playbook is the way on', async (t) => {
  const f = await laneFixture(t);
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'missing-model' }, 'Write an intro.');
  const card = await f.card();
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const prequeue = await waitFor(async () => (await f.runs(card.id)).find((run) => run.status === 'failed'));
  assert.deepEqual([prequeue.submissionId, prequeue.retryable], [null, false]);

  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model' }, 'Write an intro.');
  f.codex.ackGate = new Promise(() => {});
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  const turn = f.codex.threads.get(send.threadId).turns[0];
  turn.status = 'completed';
  turn.items.push({ type: 'agentMessage', id: 'recovered', text: 'Recovered reply' });
  f.codex.ackGate = null;
  await f.restart();
  const recovered = await waitFor(async () => (await f.runs(card.id)).find((run) => run.submissionId && run.status === 'failed'));
  assert.equal(recovered.submissionStatus, 'completed');
  assert.equal(recovered.retryable, false);
  assert.equal((await f.chat(card.id)).submissions[0].retryable, false);
  assert.equal((await f.retry(card.id, recovered.submissionId)).status, 409, 'a finished reply is not a failed submission to Retry');
});

const result = (value) => `Done.\n\n\`\`\`frameboard-result\n${JSON.stringify(value)}\n\`\`\``;

test('after a queued failure Retry resends the whole frozen submission, and Run playbook reruns the whole prompt from current inputs; neither reapplies entry values', async (t) => {
  const f = await laneFixture(t);
  const scriptA = await f.upload('script-a.md', 'SCRIPT A');
  await f.save('MAP.md', '# OLD MAP');
  await f.save('skills/voice.md', 'OLD SKILL');
  const settings = { may_edit: ['intro'], skills: ['voice'], set: { prompt: 'Entry prompt' } };
  await setPlaybook(f.ok, f.flowId, f.stages[1], { ...settings, model: 'test-model', assets: [`asset:${scriptA.id}`] }, 'OLD INSTRUCTIONS');
  const card = await f.card();
  await f.notes(card.id, 'OLD NOTES');
  const moved = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[1].id });
  assert.equal(moved.card.fields.prompt, 'Entry prompt', 'entering the lane applies its set: values once');
  const first = await waitFor(() => f.codex.sends[0]);
  f.codex.finish(first, 'failed');
  const failed = await waitFor(async () => (await f.runs(card.id)).find((run) => run.status === 'failed'));

  // Everything a new run would read changes after the failure.
  await f.edit(card.id, { prompt: 'My own prompt' });
  const scriptB = await f.upload('script-b.md', 'SCRIPT B');
  await setPlaybook(f.ok, f.flowId, f.stages[1], { ...settings, model: 'other-model', assets: [`asset:${scriptB.id}`] }, 'NEW INSTRUCTIONS');
  await f.save('MAP.md', '# NEW MAP');
  await f.save('skills/voice.md', 'NEW SKILL');
  await f.notes(card.id, 'NEW NOTES');

  await f.ok('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: failed.submissionId });
  const retried = await waitFor(() => f.codex.sends[1]);
  assert.equal(retried.model, 'test-model', 'the frozen target');
  assert.equal(f.sentText(retried), f.sentText(first), 'the frozen prompt, operational documents, notes and Library file');
  for (const text of ['OLD INSTRUCTIONS', '# OLD MAP', 'OLD SKILL', 'OLD NOTES', 'SCRIPT A']) assert.ok(f.sentText(retried).includes(text), `${text} is resent`);
  let chat = await f.chat(card.id);
  assert.equal(chat.submissions.length, 1, 'Retry is a new attempt of the same submission');
  assert.deepEqual(chat.attempts.map((attempt) => attempt.submissionId), [failed.submissionId, failed.submissionId]);
  assert.equal(chat.attempts[1].previousAttemptId, chat.attempts[0].id);
  assert.equal((await f.runs(card.id)).length, 1, 'the same lane run');
  f.codex.finish(retried, 'completed', result({ fields: { intro: 'Retried intro' }, notes: 'Retried run notes.' }));
  await waitFor(async () => (await f.runs(card.id))[0].status === 'completed');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.prompt, 'My own prompt', 'Retry never reapplies set:');

  const requested = await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  assert.notEqual(requested.id, failed.id, 'Run playbook is a new run');
  const rerun = await waitFor(() => f.codex.sends[2]);
  assert.equal(rerun.model, 'other-model', 'the target saved now');
  const sent = f.sentText(rerun);
  for (const text of ['NEW INSTRUCTIONS', '# NEW MAP', 'NEW SKILL', 'NEW NOTES', 'Retried run notes.', 'SCRIPT B', 'Retried intro']) assert.ok(sent.includes(text), `${text} is sent`);
  for (const text of ['OLD INSTRUCTIONS', '# OLD MAP', 'OLD SKILL', 'SCRIPT A']) assert.ok(!sent.includes(text), `${text} is not sent`);
  f.codex.finish(rerun, 'failed');
  await waitFor(async () => (await f.runs(card.id))[0].status === 'failed');

  // The whole history and every earlier effect survive the new run's failure.
  const saved = (await f.ok('GET', `/api/cards/${card.id}`)).card;
  assert.deepEqual([saved.fields.prompt, saved.fields.intro], ['My own prompt', 'Retried intro']);
  assert.match((await f.ok('GET', `/api/cards/${card.id}/notes`)).text, /NEW NOTES[\s\S]*Retried run notes\./);
  chat = await f.chat(card.id);
  assert.deepEqual(chat.submissions.map((submission) => submission.status), ['completed', 'failed']);
  assert.deepEqual((await f.runs(card.id)).map((run) => [run.trigger, run.status]), [['manual', 'failed'], ['enter', 'completed']]);
});

test('Retry after the card left its lane and returned keeps the frozen run but cannot regain automatic field authority', async (t) => {
  const f = await laneFixture(t);
  await setPlaybook(f.ok, f.flowId, f.stages[1], { model: 'test-model', may_edit: ['intro'] }, 'Write an intro.');
  const card = await f.card();
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[1].id });
  f.codex.finish(await waitFor(() => f.codex.sends[0]), 'failed');
  const failed = await waitFor(async () => (await f.runs(card.id)).find((run) => run.status === 'failed'));
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[2].id });
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[1].id });
  // Returning is a new entry: its own run starts, and the old one stays failed.
  const entered = await waitFor(() => f.codex.sends[1]);
  f.codex.finish(entered, 'failed');
  await waitFor(async () => (await f.runs(card.id)).filter((run) => run.status === 'failed').length === 2);

  assert.equal((await f.ok('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: failed.submissionId })).id, failed.submissionId);
  const retried = await waitFor(() => f.codex.sends[2]);
  assert.equal(f.sentText(retried), f.sentText(f.codex.sends[0]));
  f.codex.finish(retried, 'completed', result({ fields: { intro: 'Old run intro' }, notes: 'Old run notes.' }));
  const completed = await waitFor(async () => (await f.runs(card.id)).find((run) => run.id === failed.id && run.status === 'completed'));
  assert.deepEqual([completed.result.applied, completed.result.proposed], [[], ['intro']]);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, '');
  assert.match((await f.ok('GET', `/api/cards/${card.id}/notes`)).text, /Old run notes\./, 'notes stay permitted, as for a run that finishes after departure');
});

test('a lane run whose delivery is uncertain says it may have reached the agent, and Run playbook is new work that waits for reconciliation', async (t) => {
  const f = await laneFixture(t);
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model' }, 'Write an intro.');
  const card = await f.card();
  f.codex.startError = { error: f.codexError('timeout', 'Codex did not answer turn/start in time.'), recorded: true };
  const first = await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const uncertain = await waitFor(async () => (await f.runs(card.id)).find((run) => run.submissionStatus === 'uncertain'));
  assert.deepEqual([uncertain.possiblyDelivered, uncertain.retryable], [true, false]);

  const second = await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  assert.notEqual(second.id, first.id);
  await waitFor(async () => (await f.runs(card.id)).find((run) => run.id === second.id).status === 'queued');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.codex.sends.length, 1, 'the new run is not sent while the earlier delivery is uncertain');

  const chat = await f.chat(card.id);
  await f.ok('POST', `/api/cards/${card.id}/chat/resolve`, { attemptId: chat.attempts[0].id });
  const resolved = (await f.runs(card.id)).find((run) => run.id === first.id);
  assert.deepEqual([resolved.status, resolved.possiblyDelivered], ['failed', true], 'marking it interrupted does not prove it was not delivered');
  const rerun = await waitFor(() => f.codex.sends[1]);
  assert.equal(f.sentText(rerun), f.sentText(f.codex.sends[0]), 'the whole playbook prompt, not a continuation');
  f.codex.finish(rerun, 'failed');
  const plain = await waitFor(async () => (await f.runs(card.id)).find((run) => run.id === second.id && run.status === 'failed'));
  assert.equal(plain.possiblyDelivered, false);
});

test('Retry of a lane run whose frozen Library version lost its bytes fails by name until exact-byte repair, never substituting the current version', async (t) => {
  const f = await laneFixture(t);
  const script = await f.upload('script.md', 'SCRIPT A');
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model', assets: [`asset:${script.id}`] }, 'Use the script.');
  const card = await f.card();
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  f.codex.finish(await waitFor(() => f.codex.sends[0]), 'failed');
  const failed = await waitFor(async () => (await f.runs(card.id)).find((run) => run.status === 'failed'));
  await f.upload('script.md', 'SCRIPT B', { collision: 'replace', asset: script.id });
  await rm(path.join(f.dataDir, 'retained', 'versions', script.version.id));

  await f.ok('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: failed.submissionId });
  const unavailable = await waitFor(async () => (await f.chat(card.id)).attempts.length === 2 && (await f.chat(card.id)).submissions[0].status === 'failed' && (await f.chat(card.id)).submissions[0]);
  assert.match(unavailable.reason, /script\.md[\s\S]*exact original bytes/);
  assert.equal(f.codex.sends.length, 1, 'nothing is sent, and the current version is not substituted');
  assert.equal((await f.repair(script.version, 'SCRIPT B')).status, 409, 'other bytes cannot repair the frozen version');
  assert.equal((await f.repair(script.version, 'SCRIPT A')).status, 200);

  await f.ok('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: failed.submissionId });
  const resent = await waitFor(() => f.codex.sends[1]);
  assert.equal(f.sentText(resent), f.sentText(f.codex.sends[0]));
  assert.ok(f.sentText(resent).includes('SCRIPT A') && !f.sentText(resent).includes('SCRIPT B'));
});
