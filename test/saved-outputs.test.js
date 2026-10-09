import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fixture, waitFor } from './support/chat-fixture.js';
import { parseLaneResult } from '../public/playbook-format.js';
import { setPlaybook } from './support/playbooks.js';
import { createClaudeAdapter } from '../claude-adapter.js';
import { createBackup, restoreBackup } from '../backup.js';
import { createApp } from '../server.js';
import { ControlledCodex } from './support/controlled-codex.js';

const reply = 'Here is the script.\n\n# Black holes\n\nThey are not holes.';
const completed = async (f, card, text = reply) => {
  const submission = await f.queue(card.id, await f.compose(card.id));
  const send = await waitFor(() => f.codex.sends.find((entry) => entry.clientUserMessageId && !entry.done));
  send.done = true;
  f.codex.finish(send, 'completed', text);
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.submissions.find((s) => s.id === submission.id).status === 'completed' && value; });
  return { submission, send, chat, item: chat.items.find((entry) => entry.kind === 'agentMessage' && entry.text === text) };
};
const save = (f, cardId, body) => f.call('POST', `/api/cards/${cardId}/chat/saved-outputs`, { operation: randomUUID(), ...body });
const content = async (f, cardId, outputId) => {
  const response = await f.raw(`/api/cards/${cardId}/chat/saved-outputs/${outputId}/content`);
  return { status: response.status, disposition: response.headers.get('content-disposition'), text: await response.text() };
};

test('Save as document retains a reply’s exact text beside its producing work, with its provenance', async (t) => {
  const f = await fixture(t); const card = await f.card({ title: 'Script' });
  const { submission, send, chat, item } = await completed(f, card);

  const saved = await save(f, card.id, { sequence: item.sequence, filename: 'script.md' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const output = saved.body;
  assert.equal(output.status, 'saved');
  assert.equal(output.filename, 'script.md');
  assert.equal(output.attemptId, chat.attempts[0].id);
  assert.equal(output.submissionId, submission.id);
  assert.equal(output.conversationId, submission.conversationId);
  assert.equal(output.provider, 'codex');
  assert.equal(output.model, 'test-model');
  assert.equal(output.creationMethod, 'transcript-save');
  assert.equal(output.native.turnId, send.turnId);
  assert.equal(output.native.itemId, item.nativeId);
  assert.deepEqual(output.derivation, { declared: false }, 'A user save declares no derivation: it stays unknown');
  assert.equal(output.size, Buffer.byteLength(reply));

  const listed = (await f.chat(card.id)).savedOutputs;
  assert.deepEqual(listed.map((entry) => [entry.id, entry.status]), [[output.id, 'saved']]);
  const download = await content(f, card.id, output.id);
  assert.equal(download.status, 200);
  assert.equal(download.text, reply);
  assert.match(download.disposition, /attachment; filename="script.md"/);
});

test('a passage saves exactly, a repeated save operation is not duplicated, and text not in the reply is refused', async (t) => {
  const f = await fixture(t); const card = await f.card();
  const { item } = await completed(f, card);
  const operation = randomUUID();
  const first = await save(f, card.id, { operation, sequence: item.sequence, filename: 'title.md', text: '# Black holes' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await save(f, card.id, { operation, sequence: item.sequence, filename: 'title.md', text: '# Black holes' });
  assert.equal(again.body.id, first.body.id);
  assert.equal((await f.chat(card.id)).savedOutputs.length, 1);
  assert.equal((await content(f, card.id, first.body.id)).text, '# Black holes');

  const invented = await save(f, card.id, { sequence: item.sequence, filename: 'fake.md', text: 'Not in the reply' });
  assert.equal(invented.status, 400);
  assert.equal((await save(f, card.id, { sequence: item.sequence, filename: '../escape.md' })).status, 400);
  assert.equal((await save(f, card.id, { sequence: 999999, filename: 'missing.md' })).status, 404);
  assert.equal((await f.chat(card.id)).savedOutputs.length, 1);
});

test('a saved document survives Stop, fresh context, workspace changes, archive and card deletion, and stays downloadable', async (t) => {
  const f = await fixture(t); const card = await f.card();
  const { item } = await completed(f, card);
  const output = (await save(f, card.id, { sequence: item.sequence, filename: 'script.md' })).body;

  // A stopped reply's retained text can still be saved by a new explicit action.
  await f.queue(card.id, await f.compose(card.id, 'Another'));
  const running = await waitFor(() => f.codex.sends[1]);
  f.codex.emit(running.threadId, { type: 'delta', turnId: running.turnId, itemId: 'partial', delta: 'Half a draft' });
  await waitFor(async () => (await f.chat(card.id)).items.some((entry) => entry.text === 'Half a draft'));
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  const stopped = await waitFor(async () => { const chat = await f.chat(card.id); return chat.submissions[1].status === 'interrupted' && chat; });
  const partial = stopped.items.find((entry) => entry.text === 'Stopped partial reply');
  const recovered = await save(f, card.id, { sequence: partial.sequence, filename: 'partial.md' });
  assert.equal(recovered.status, 201, JSON.stringify(recovered.body));

  await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  await rm(path.join(f.dataDir, 'workspaces', card.id), { recursive: true, force: true });
  const project = (await f.ok('GET', '/api/workspace')).projects[0];
  await f.ok('POST', `/api/projects/${project.id}/archive`, {});
  const archived = await f.chat(card.id);
  assert.deepEqual(archived.savedOutputs.map((entry) => entry.status), ['saved', 'saved']);
  assert.equal((await content(f, card.id, output.id)).text, reply, 'Archived content stays downloadable');
  const refused = await save(f, card.id, { sequence: item.sequence, filename: 'late.md' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /archived/i);

  await f.ok('POST', `/api/projects/${project.id}/unarchive`, {});
  await f.ok('DELETE', `/api/cards/${card.id}`);
  const deleted = await f.chat(card.id);
  assert.deepEqual(deleted.savedOutputs.map((entry) => entry.id), [output.id, recovered.body.id]);
  assert.equal((await content(f, card.id, output.id)).text, reply);
  assert.equal((await content(f, card.id, recovered.body.id)).text, 'Stopped partial reply');
});

const block = (value) => `Done.\n\n\`\`\`frameboard-result\n${JSON.stringify(value, null, 2)}\n\`\`\``;

test('a lane result may declare inline documents with their source IDs; anything else in outputs is reported, not saved', () => {
  const parsed = parseLaneResult(block({ fields: { intro: 'Hi' }, outputs: [
    { filename: 'script.md', text: '# Script', sources: ['v1', 'v2'] },
    { filename: 'bare.md', text: 'No sources' },
    { filename: 'render.png', path: 'out/render.png' },
    { filename: 'empty.md', text: '' },
    { text: 'No name' },
    { filename: 'bad-sources.md', text: 'x', sources: 'v1' },
  ] }), 'youtube-video');
  assert.deepEqual(parsed.fields, { intro: 'Hi' });
  assert.deepEqual(parsed.outputs, [
    { filename: 'script.md', text: '# Script', sources: ['v1', 'v2'] },
    { filename: 'bare.md', text: 'No sources', sources: null },
  ]);
  assert.equal(parsed.errors.length, 4);
  assert.match(parsed.errors[0], /render\.png.*exact text/);
  assert.match(parsed.errors[1], /empty\.md/);
  assert.match(parsed.errors[2], /filename/);
  assert.match(parsed.errors[3], /bad-sources\.md.*sources/);
  assert.deepEqual(parseLaneResult(block({ notes: 'n' }), 'youtube-video').outputs, []);
  assert.match(parseLaneResult(block({ outputs: { filename: 'x' } }), 'youtube-video').errors[0], /“outputs” must be a list/);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
const runs = async (f, cardId) => (await f.ok('GET', `/api/cards/${cardId}/lane-runs`)).runs;
async function laneCard(f, settings = { run: 'manual', model: 'test-model', may_edit: ['intro'] }) {
  const workspace = await f.ok('GET', '/api/workspace');
  const project = workspace.projects[0]; const stage = workspace.flows[0].stages[0];
  await setPlaybook(f.ok, project.flowId, stage, settings, 'Write an intro and a script.');
  const card = await f.card({ title: 'Lane card' });
  const image = await (await f.raw('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  const { revision } = (await f.ok('GET', `/api/cards/${card.id}`)).card;
  await f.ok('PATCH', `/api/cards/${card.id}`, { revision, images: [{ id: image.id, name: 'Portrait' }], imageRoles: { original: image.id } });
  return { project, stage, card, image };
}

test('a lane run saves its declared inline documents with verified sources, separately from its field and notes effects', async (t) => {
  const f = await fixture(t);
  const { card, image } = await laneCard(f);
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  f.codex.finish(send, 'completed', block({ fields: { intro: 'New intro' }, notes: 'Wrote the script.', outputs: [
    { filename: 'script.md', text: '# The script', sources: [image.id] },
    { filename: 'outline.md', text: '- one\n- two' },
    { filename: 'invented.md', text: 'x', sources: ['not-supplied'] },
  ] }));
  const [run] = await waitFor(async () => { const value = await runs(f, card.id); return value[0].status === 'completed' && value; });
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.savedOutputs.length === 2 && value.savedOutputs.every((o) => o.status === 'saved') && value; });

  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, 'New intro');
  assert.match((await f.ok('GET', `/api/cards/${card.id}/notes`)).text, /Wrote the script/);
  const [script, outline] = chat.savedOutputs;
  assert.equal(script.filename, 'script.md');
  assert.equal(script.creationMethod, 'lane-result');
  assert.equal(script.provider, 'codex');
  assert.equal(script.laneRunId, run.id);
  assert.equal(script.attemptId, chat.attempts[0].id);
  assert.deepEqual(script.derivation, { declared: true, sources: [{ kind: 'image', versionId: image.id, label: 'Portrait' }] });
  assert.deepEqual(script.supplied.map((input) => [input.kind, input.versionId]), [['image', image.id]], 'Supplied context is recorded separately');
  assert.deepEqual(outline.derivation, { declared: false }, 'Undeclared derivation stays unknown');
  assert.equal((await content(f, card.id, script.id)).text, '# The script');
  assert.equal((await content(f, card.id, outline.id)).text, '- one\n- two');

  assert.deepEqual(run.result.outputs.map(({ filename, status }) => [filename, status]), [['script.md', 'saved'], ['outline.md', 'saved'], ['invented.md', 'failed']]);
  assert.match(run.result.outputs[2].error, /not-supplied/);
  assert.match(run.reason, /Saved script\.md and outline\.md\./);
  assert.match(run.reason, /invented\.md was not saved/);
  assert.ok(chat.items.some((item) => item.kind === 'agentMessage' && item.text.includes('invented.md')), 'The reply text is retained');
});

test('Stop while a lane document is being saved keeps it unsaved and reported, while the reply and earlier card effects remain', async (t) => {
  let pause = null; let paused;
  const reached = new Promise((resolve) => { paused = resolve; });
  const f = await fixture(t, { retainedCheckpoint: async (boundary, version) => { if (boundary === 'staged' && version.filename === 'script.md' && pause) { paused(); await pause; } } });
  const { card } = await laneCard(f);
  let release; pause = new Promise((resolve) => { release = resolve; });
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  f.codex.autoInterrupt = false;
  f.codex.finish(send, 'completed', block({ fields: { intro: 'Applied intro' }, outputs: [{ filename: 'script.md', text: 'Late script' }] }));
  await reached;
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  release();
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.savedOutputs[0]?.status === 'failed' && value; });
  assert.match(chat.savedOutputs[0].error, /stopped/);
  assert.equal((await content(f, card.id, chat.savedOutputs[0].id)).status, 409);
  const [run] = await waitFor(async () => { const value = await runs(f, card.id); return value[0].status === 'completed' && value; });
  assert.match(run.reason, /script\.md was not saved: Not saved: this response was stopped/);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, 'Applied intro', 'A separately valid card effect stands');
  const item = chat.items.find((entry) => entry.kind === 'agentMessage');
  assert.match(item.text, /Late script/, 'The reply text is retained');
  // A new explicit user action can save that retained text.
  const saved = await save(f, card.id, { sequence: item.sequence, filename: 'script.md', text: 'Late script' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
});

test('an archived or recovered lane reply registers nothing, and its text can still be saved explicitly', async (t) => {
  const f = await fixture(t);
  const { project, card } = await laneCard(f);
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const old = await waitFor(() => f.codex.sends[0]);
  f.codex.autoInterrupt = false;
  await f.ok('POST', `/api/projects/${project.id}/archive`, {});
  await f.ok('POST', `/api/projects/${project.id}/unarchive`, {});
  f.codex.finish(old, 'completed', block({ outputs: [{ filename: 'late.md', text: 'Late' }] }));
  await waitFor(async () => (await f.chat(card.id)).attempts[0].status === 'interrupted');
  assert.deepEqual((await f.chat(card.id)).savedOutputs, []);

  // A reply recovered after a restart never replays its result block.
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const second = await waitFor(() => f.codex.sends[1]);
  await f.close();
  const turn = f.codex.threads.get(second.threadId).turns.find((entry) => entry.id === second.turnId);
  turn.items.push({ type: 'agentMessage', id: 'recovered', text: block({ outputs: [{ filename: 'recovered.md', text: 'Recovered' }] }) });
  turn.status = 'completed';
  await f.restart();
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.submissions[1].status === 'completed' && value; });
  assert.deepEqual(chat.savedOutputs, []);
  const item = chat.items.find((entry) => entry.nativeId === 'recovered');
  const saved = await save(f, card.id, { sequence: item.sequence, filename: 'recovered.md', text: 'Recovered' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal((await content(f, card.id, saved.body.id)).text, 'Recovered');
});

test('tool-disabled Claude saves an inline document through its lane result, recorded as produced by Claude', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'frameboard-claude-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, FAKE_CLAUDE_LANE_RESULT: JSON.stringify({ notes: 'Brief written.', outputs: [{ filename: 'brief.md', text: '# Thumbnail brief', sources: [] }] }) };
  const claude = { ...createClaudeAdapter({ command: process.execPath, args: [fileURLToPath(new URL('./support/fake-claude.js', import.meta.url))], env }), protectRetainedData: undefined };
  const f = await fixture(t, { claudeAdapter: claude });
  const settings = await f.ok('GET', '/api/providers/claude');
  await f.ok('PUT', '/api/providers/claude', { revision: settings.revision, selection: { ...settings.selection, enabled: true } });
  const { card, image } = await laneCard(f, { run: 'manual', provider: 'claude', model: 'sonnet' });
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.savedOutputs[0]?.status === 'saved' && value; });
  const [brief] = chat.savedOutputs;
  assert.equal(brief.provider, 'claude');
  assert.equal(brief.model, 'sonnet');
  assert.equal(brief.creationMethod, 'lane-result');
  assert.deepEqual(brief.derivation, { declared: true, sources: [] }, 'An empty list declares no sources');
  assert.deepEqual(brief.supplied.map((input) => input.versionId), [image.id]);
  assert.equal((await content(f, card.id, brief.id)).text, '# Thumbnail brief');
  const [run] = await waitFor(async () => { const value = await runs(f, card.id); return value[0].status === 'completed' && value; });
  assert.match(run.reason, /Added hand-off notes\. Saved brief\.md\./);
});

test('every saved output’s payload, provenance and outcome is in a verified backup and restores intact', async (t) => {
  const f = await fixture(t);
  const { card } = await laneCard(f);
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  f.codex.finish(send, 'completed', block({ outputs: [{ filename: 'lane.md', text: 'From the lane' }, { filename: 'bad.md', text: 'x', sources: ['unknown'] }] }));
  const { savedOutputs: [lane] } = await waitFor(async () => { const value = await f.chat(card.id); return value.savedOutputs[0]?.status === 'saved' && value; });
  const item = (await f.chat(card.id)).items.find((entry) => entry.kind === 'agentMessage');
  const user = (await save(f, card.id, { sequence: item.sequence, filename: 'reply.md' })).body;
  const before = (await f.chat(card.id)).savedOutputs;
  const project = (await f.ok('GET', '/api/workspace')).projects[0];
  await f.ok('POST', `/api/projects/${project.id}/archive`, {});
  await f.close();

  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-outputs-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { backupDir } = await createBackup({ dataDir: f.dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'native') });
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.inventory.savedOutputs.map(({ outputId, status }) => [outputId, status]), [[lane.id, 'saved'], [user.id, 'saved']]);
  assert.ok(manifest.inventory.savedOutputs.every((entry) => manifest.files.some((file) => file.path === entry.path && file.sha256 === entry.sha256)));

  const dataDir = path.join(root, 'restored');
  await restoreBackup({ backupDir, dataDir, codexHome: path.join(root, 'native') });
  const app = await createApp({ dataDir, codexAdapter: new ControlledCodex(path.join(root, 'native')) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const restored = (await (await fetch(`${base}/api/cards/${card.id}/chat`)).json()).savedOutputs;
  assert.deepEqual(restored, before, 'Identities, provenance and outcomes are unchanged');
  for (const [output, text] of [[lane, 'From the lane'], [user, item.text]]) {
    assert.equal(await (await fetch(`${base}/api/cards/${card.id}/chat/saved-outputs/${output.id}/content`)).text(), text);
  }
});
