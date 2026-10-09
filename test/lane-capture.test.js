import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeAdapter } from '../claude-adapter.js';
import { randomUUID } from 'node:crypto';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

// Pending lane runs are requests: whatever is saved when the run is ready to
// queue is what its one submission captures.
async function laneFixture(t, options) {
  const f = await fixture(t, options);
  const workspace = await f.ok('GET', '/api/workspace');
  const projectId = workspace.projects[0].id; const flowId = workspace.projects[0].flowId; const stages = workspace.flows[0].stages;
  async function upload(filename, bytes) {
    const response = await f.raw(`/api/projects/${projectId}/library/uploads?${new URLSearchParams({ filename, operation: randomUUID() })}`, { method: 'POST', body: bytes });
    const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body));
    return body.asset;
  }
  async function image(name, bytes = png) {
    const id = `${randomUUID()}${path.extname(name)}`;
    await writeFile(path.join(f.dataDir, 'images', id), bytes);
    return { id, name };
  }
  const runs = async (cardId) => (await f.ok('GET', `/api/cards/${cardId}/lane-runs`)).runs;
  const save = async (relative, text) => {
    const listed = await f.ok('GET', `/api/flows/${flowId}/playbooks`);
    const existing = [listed.map, ...listed.lanes, ...listed.skills].find((document) => document?.path === relative);
    return (await f.ok('PUT', `/api/flows/${flowId}/playbooks`, { path: relative, text, baseHash: existing?.hash ?? null })).document;
  };
  const notes = async (cardId, text) => f.ok('PUT', `/api/cards/${cardId}/notes`, { text, baseHash: (await f.ok('GET', `/api/cards/${cardId}/notes`)).hash });
  // Holds the next provider discovery, the asynchronous part of preparing a
  // run, until released. Later discoveries pass straight through.
  function holdDiscovery() {
    const discover = f.codex.discover.bind(f.codex);
    let release; let entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    f.codex.discover = async (...args) => { f.codex.discover = discover; entered(); await gate; return discover(...args); };
    t.after(release);
    return { reached, release };
  }
  const sentText = (send) => send.input.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
  return { ...f, projectId, flowId, stages, upload, image, runs, save, notes, holdDiscovery, sentText };
}

test('a playbook, map, skill or notes saved while a run is being prepared is captured, never a stale snapshot', async (t) => {
  const f = await laneFixture(t);
  await f.save('skills/voice.md', 'OLD SKILL');
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model', skills: ['voice'] }, 'OLD INSTRUCTIONS');
  const card = await f.card();
  const held = f.holdDiscovery();
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  await held.reached;
  const playbook = await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model', skills: ['voice'] }, 'NEW INSTRUCTIONS');
  const map = await f.save('MAP.md', '# NEW MAP');
  await f.save('skills/voice.md', 'NEW SKILL');
  const notes = await f.notes(card.id, 'NEW NOTES');
  held.release();

  const send = await waitFor(() => f.codex.sends[0]);
  const sent = f.sentText(send);
  for (const text of ['NEW INSTRUCTIONS', '# NEW MAP', 'NEW SKILL', 'NEW NOTES']) assert.ok(sent.includes(text), `${text} is sent`);
  for (const text of ['OLD INSTRUCTIONS', 'OLD SKILL']) assert.ok(!sent.includes(text), `${text} is not sent`);
  const { submissions } = await f.chat(card.id);
  assert.equal(submissions.length, 1, 'one run queues one submission');
  assert.deepEqual([submissions[0].lane.playbook.hash, submissions[0].lane.map.hash, submissions[0].lane.notesHash], [playbook.hash, map.hash, notes.hash]);
  assert.equal((await f.runs(card.id))[0].status, 'queued');
});

// A manual prompt keeps the card chat busy, so an on-enter run that needs
// fresh context waits for it.
async function waitingRun(f, settings = {}, body = 'Start over.') {
  await setPlaybook(f.ok, f.flowId, f.stages[1], { conversation: 'fresh', model: 'test-model', ...settings }, body);
  const card = await f.card();
  await f.queue(card.id, await f.compose(card.id));
  const manual = await waitFor(() => f.codex.sends[0]);
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[1].id });
  const run = await waitFor(async () => (await f.runs(card.id)).find((entry) => entry.reason.includes('Waiting for the card chat')));
  assert.equal(run.status, 'pending');
  return { card, manual, run };
}

for (const run of ['manual', 'off']) test(`run: ${run} cancels an automatic run waiting for fresh context at once, and editing back does not revive it`, async (t) => {
  const f = await laneFixture(t);
  const { card, manual } = await waitingRun(f);
  await setPlaybook(f.ok, f.flowId, f.stages[1], { conversation: 'fresh', model: 'test-model', run }, 'Start over.');
  const cancelled = await waitFor(async () => (await f.runs(card.id)).find((entry) => entry.status === 'cancelled'));
  assert.match(cancelled.reason, /turned off or its trigger changed/);
  assert.equal(f.codex.sends.length, 1, 'cancelled while the manual prompt is still running');
  await setPlaybook(f.ok, f.flowId, f.stages[1], { conversation: 'fresh', model: 'test-model' }, 'Start over.');
  f.codex.finish(manual);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual((await f.runs(card.id)).map((entry) => entry.status), ['cancelled']);
  assert.equal((await f.chat(card.id)).submissions.length, 1, 'only the manual prompt was ever queued');
});

test('a run waiting for fresh context queues with what is saved when the chat frees up, not when it was requested', async (t) => {
  const f = await laneFixture(t);
  await f.save('skills/voice.md', 'OLD SKILL');
  const { card, manual } = await waitingRun(f, { skills: ['voice'] }, 'OLD INSTRUCTIONS');
  const script = await f.upload('script.md', Buffer.from('CURRENT SCRIPT'));
  await setPlaybook(f.ok, f.flowId, f.stages[1], { conversation: 'fresh', model: 'other-model', skills: ['voice'], assets: [`asset:${script.id}`] }, 'CURRENT INSTRUCTIONS');
  await f.save('MAP.md', '# CURRENT MAP');
  await f.save('skills/voice.md', 'CURRENT SKILL');
  await f.notes(card.id, 'CURRENT NOTES');
  const photo = await f.image('current-photo.png');
  const { card: saved } = await f.ok('GET', `/api/cards/${card.id}`);
  await f.ok('PATCH', `/api/cards/${card.id}`, { revision: saved.revision, title: 'CURRENT TITLE', images: [photo] });
  f.codex.finish(manual);

  const send = await waitFor(() => f.codex.sends[1]);
  assert.equal(send.model, 'other-model', 'the target saved now');
  const sent = f.sentText(send);
  for (const text of ['CURRENT INSTRUCTIONS', '# CURRENT MAP', 'CURRENT SKILL', 'CURRENT NOTES', 'CURRENT TITLE', 'CURRENT SCRIPT', 'current-photo.png']) assert.ok(sent.includes(text), `${text} is sent`);
  for (const text of ['OLD INSTRUCTIONS', 'OLD SKILL']) assert.ok(!sent.includes(text), `${text} is not sent`);
  const chat = await f.chat(card.id);
  const lane = chat.submissions.at(-1);
  assert.equal(lane.conversationId, chat.conversations.at(-1).id, 'in the fresh conversation');
  assert.deepEqual(lane.context.images.map((entry) => entry.id), [photo.id]);
  assert.deepEqual(lane.context.library.map((file) => file.assetId), [script.id]);
  assert.equal((await f.runs(card.id))[0].status, 'queued');
});

test('inputs that change during every preparation end the run with the conflict named and nothing queued; Run playbook then starts new work', async (t) => {
  const f = await laneFixture(t);
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model' }, 'Summarize.');
  const card = await f.card();
  const discover = f.codex.discover.bind(f.codex);
  let preparations = 0;
  // Something outside Frameboard rewrites the notes during each discovery.
  f.codex.discover = async (...args) => {
    preparations += 1;
    await writeFile(path.join(f.dataDir, 'workspaces', card.id, 'notes.md'), `Edited ${preparations}`);
    return discover(...args);
  };
  const requested = await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const failed = await waitFor(async () => (await f.runs(card.id)).find((run) => run.status === 'failed'));
  assert.equal(failed.id, requested.id);
  assert.match(failed.reason, /The hand-off notes changed while preparing the lane run\. This run's inputs changed during 5 preparations in a row/);
  assert.equal(preparations, 5);
  assert.deepEqual((await f.chat(card.id)).submissions, [], 'no stale or mixed snapshot, and nothing to Retry');
  assert.deepEqual(f.codex.sends, []);

  f.codex.discover = discover;
  const again = await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  assert.notEqual(again.id, failed.id);
  const send = await waitFor(() => f.codex.sends[0]);
  assert.ok(f.sentText(send).includes('Edited 5'));
  assert.deepEqual((await f.runs(card.id)).map((run) => run.status), ['queued', 'failed']);
});

test('turning a playbook off while its run is prepared cancels the run before any submission exists', async (t) => {
  const f = await laneFixture(t);
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model' }, 'Summarize.');
  const card = await f.card();
  const held = f.holdDiscovery();
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  await held.reached;
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'off', model: 'test-model' }, 'Summarize.');
  held.release();
  const cancelled = await waitFor(async () => (await f.runs(card.id)).find((run) => run.status === 'cancelled'));
  assert.match(cancelled.reason, /turned off/);
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model' }, 'Summarize.');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual((await f.runs(card.id)).map((run) => run.status), ['cancelled'], 'turning it back on does not revive it');
  assert.deepEqual((await f.chat(card.id)).submissions, []);
  assert.deepEqual(f.codex.sends, []);
});

test('Run playbook while a run is prepared reuses it; after it queues, Run playbook is distinct new work', async (t) => {
  const f = await laneFixture(t);
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model' }, 'Summarize.');
  const card = await f.card();
  const held = f.holdDiscovery();
  const first = await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  await held.reached;
  assert.equal((await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {})).id, first.id, 'a repeated request is the same pending run');
  held.release();
  await waitFor(() => f.codex.sends[0]);
  await waitFor(async () => (await f.runs(card.id))[0].status === 'queued');
  const second = await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  assert.notEqual(second.id, first.id);
  await waitFor(async () => (await f.runs(card.id)).every((run) => run.status === 'queued'));
  const { submissions } = await f.chat(card.id);
  assert.deepEqual(submissions.map((submission) => submission.lane.runId).sort(), [first.id, second.id].sort(), 'one submission per run, two runs');
});

test('a Claude lane run with an unsupported gallery photo fails the whole union by identity, even with usable Library text, and has no Retry', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'frameboard-claude-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const claude = { ...createClaudeAdapter({ command: process.execPath, args: [fileURLToPath(new URL('./support/fake-claude.js', import.meta.url))], env: { ...process.env, CLAUDE_CONFIG_DIR: home } }), protectRetainedData: undefined };
  const f = await laneFixture(t, { claudeAdapter: claude });
  const settings = await f.ok('GET', '/api/providers/claude');
  await f.ok('PUT', '/api/providers/claude', { revision: settings.revision, selection: { ...settings.selection, enabled: true } });
  const script = await f.upload('script.md', Buffer.from('Usable script'));
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', provider: 'claude', model: 'sonnet', assets: [`asset:${script.id}`] }, 'Write a thumbnail brief.');
  const avif = await f.image('portrait.avif', Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from('ftypavif'), Buffer.alloc(20)]));
  const card = await f.card({ images: [avif] });

  const preview = await f.ok('GET', `/api/cards/${card.id}/lane-runs/preview`);
  assert.deepEqual(preview.problems.map((problem) => problem.key), [`image:${avif.id}`]);
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const failed = await waitFor(async () => (await f.runs(card.id)).find((run) => run.status === 'failed'));
  assert.ok(failed.reason.startsWith('Not sent.') && failed.reason.includes(`(image:${avif.id})`) && failed.reason.includes('Claude accepts PNG, JPEG, GIF and WebP'), failed.reason);
  assert.equal(failed.submissionId, null);
  assert.deepEqual((await f.chat(card.id)).submissions, [], 'no subset is sent and nothing exists to Retry');
});

test('a card chat model chosen while a run is prepared becomes its target when the playbook names none', async (t) => {
  const f = await laneFixture(t);
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual' }, 'Summarize.');
  const card = await f.card();
  await f.compose(card.id, '', 'test-model');
  const held = f.holdDiscovery();
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  await held.reached;
  await f.compose(card.id, '', 'other-model');
  held.release();
  assert.equal((await waitFor(() => f.codex.sends[0])).model, 'other-model');
  assert.deepEqual((await f.chat(card.id)).submissions.map((submission) => submission.model), ['other-model']);
});

test('a playbook turned off during the last preparation it gets cancels the run rather than failing it', async (t) => {
  const f = await laneFixture(t);
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model' }, 'Summarize.');
  const card = await f.card();
  const discover = f.codex.discover.bind(f.codex);
  let preparations = 0;
  f.codex.discover = async (...args) => {
    preparations += 1;
    if (preparations < 5) await writeFile(path.join(f.dataDir, 'workspaces', card.id, 'notes.md'), `Edited ${preparations}`);
    else await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'off', model: 'test-model' }, 'Summarize.');
    return discover(...args);
  };
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const [run] = await waitFor(async () => { const all = await f.runs(card.id); return all[0].status !== 'pending' && all; });
  assert.equal(run.status, 'cancelled', run.reason);
  assert.match(run.reason, /turned off/);
  assert.equal(preparations, 5);
  assert.deepEqual((await f.chat(card.id)).submissions, []);
});

test('a manual Send queued while a fresh-context run is prepared never shares that run\'s fresh conversation', async (t) => {
  const f = await laneFixture(t);
  await setPlaybook(f.ok, f.flowId, f.stages[1], { conversation: 'fresh', model: 'test-model' }, 'Start over.');
  const card = await f.card();
  await f.queue(card.id, await f.compose(card.id));
  f.codex.finish(await waitFor(() => f.codex.sends[0]));
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'completed');
  const held = f.holdDiscovery();
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[1].id });
  await held.reached;
  await f.queue(card.id, await f.compose(card.id, 'A manual question'));
  held.release();
  const manual = await waitFor(() => f.codex.sends[1]);
  assert.match(f.sentText(manual), /A manual question/);
  assert.equal((await f.runs(card.id))[0].status, 'pending', 'the run waits for the chat again');
  f.codex.finish(manual);
  await waitFor(() => f.codex.sends[2]);
  const chat = await f.chat(card.id);
  const lane = chat.submissions.find((submission) => submission.lane);
  assert.equal(chat.conversations.length, 3);
  assert.equal(lane.conversationId, chat.conversations.at(-1).id);
  assert.deepEqual(chat.submissions.filter((submission) => submission.conversationId === lane.conversationId).map((submission) => submission.id), [lane.id], 'alone in its fresh conversation');
});
