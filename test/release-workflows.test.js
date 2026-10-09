// Release evidence for the integrated project-asset workflows (#67): each test
// follows one user's work across the Library, manual prompts, lane playbooks,
// saved outputs, reuse, promotion, archive and a complete export and restore,
// through the public HTTP API and the controlled Codex peer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { restoreBackup } from '../backup.js';
import { createClaudeAdapter } from '../claude-adapter.js';
import { ControlledCodex } from './support/controlled-codex.js';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';

const script = 'EPISODE 12 SCRIPT\nCold open: the desk drawer that would not close.';
const guide = '# Hook guide\n\nOpen on the question, not the answer.';
const outline = '# Outline\n\n1. Drawer\n2. Question\n3. Answer';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
const result = (value) => `Done.\n\n\`\`\`frameboard-result\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const sentText = (send) => send.input.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');

async function workflowFixture(t, options) {
  const f = await fixture(t, options);
  const workspace = await f.ok('GET', '/api/workspace');
  const project = workspace.projects[0];
  const stage = workspace.flows.find((flow) => flow.id === project.flowId).stages[0];
  const library = `/api/projects/${project.id}/library`;
  async function upload(filename, bytes, query = {}, projectId = project.id) {
    const response = await f.raw(`/api/projects/${projectId}/library/uploads?${new URLSearchParams({ filename, operation: randomUUID(), ...query })}`, { method: 'POST', body: bytes });
    const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body));
    return body.asset;
  }
  async function write(filename, text) {
    const draft = await f.ok('POST', `${library}/drafts`, { filename, text });
    return (await f.ok('POST', `${library}/drafts/${draft.id}/save`, { revision: draft.revision, operation: randomUUID() })).asset;
  }
  const folder = (name) => f.ok('POST', `${library}/folders`, { name });
  const select = async (cardId, prompt, selections) => {
    const { composer } = await f.chat(cardId);
    return f.compose(cardId, prompt, 'test-model', { selections: { ...composer.selections, ...selections } });
  };
  const nextSend = (count) => waitFor(() => f.codex.sends[count]);
  const settled = (cardId, submissionId) => waitFor(async () => {
    const chat = await f.chat(cardId); return chat.submissions.find((entry) => entry.id === submissionId)?.status === 'completed' && chat;
  });
  return { ...f, project, stage, library, upload, write, folder, select, nextSend, settled };
}

test('a script and a written guide travel from the Library through a manual Send and a lane run to a saved output reused on its card and, once promoted, on another card', async (t) => {
  const f = await workflowFixture(t);
  const scripts = await f.folder('Scripts');
  const scriptAsset = await f.upload('episode-12.txt', Buffer.from(script), { folder: scripts.id });
  const guideAsset = await f.write('Hook guide.md', guide);
  const card = await f.card({ title: 'Episode 12' });

  // Manual prompt: a folder and a written document, in selection order.
  const manualSelection = [{ kind: 'folder', id: scripts.id }, { kind: 'asset', id: guideAsset.id }];
  const manual = await f.queue(card.id, await f.select(card.id, 'Draft a hook', { library: manualSelection }));
  assert.deepEqual(manual.context.library.map((file) => [file.assetId, file.libraryPath, file.method]),
    [[scriptAsset.id, 'Scripts/episode-12.txt', 'text'], [guideAsset.id, 'Hook guide.md', 'text']]);
  const manualSend = await f.nextSend(0);
  assert.ok(sentText(manualSend).includes(script) && sentText(manualSend).includes(guide), 'both files are sent in full');
  f.codex.finish(manualSend, 'completed', 'A hook.');
  await f.settled(card.id, manual.id);

  // Lane run: the playbook's own selection, independent of the manual one.
  await setPlaybook(f.ok, f.project.flowId, f.stage, { run: 'manual', model: 'test-model', may_edit: ['intro'], assets: [`asset:${guideAsset.id}`] },
    'Write an intro and save an outline.');
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const laneSend = await f.nextSend(1);
  const lane = (await f.chat(card.id)).submissions.at(-1);
  assert.deepEqual(lane.context.library.map((file) => file.assetId), [guideAsset.id]);
  assert.ok(sentText(laneSend).includes(guide) && !sentText(laneSend).includes(script), 'the lane run sends only its playbook selection');
  const guideVersion = lane.context.library[0].versionId;
  f.codex.finish(laneSend, 'completed', result({ fields: { intro: 'Ever fought a drawer?' }, outputs: [{ filename: 'outline.md', text: outline, sources: [guideVersion] }] }));
  const saved = await waitFor(async () => (await f.chat(card.id)).savedOutputs.find((entry) => entry.status === 'saved'));
  assert.deepEqual([saved.filename, saved.creationMethod, saved.provider], ['outline.md', 'lane-result', 'codex']);
  assert.deepEqual(saved.derivation.sources.map((source) => source.versionId), [guideVersion]);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, 'Ever fought a drawer?');
  assert.deepEqual((await f.chat(card.id)).composer.selections.library, manualSelection, 'a lane run leaves the manual selection alone');

  // Same-card reuse: the exact saved version, after the Library files.
  const reuse = await f.queue(card.id, await f.select(card.id, 'Tighten the outline', { savedOutputs: [saved.id] }));
  assert.deepEqual(reuse.context.savedOutputs.map((entry) => [entry.outputId, entry.versionId, entry.method]), [[saved.id, saved.versionId, 'text']]);
  const reuseSend = await f.nextSend(2);
  const reuseText = sentText(reuseSend);
  assert.ok(reuseText.indexOf(guide) < reuseText.indexOf(outline), 'reused outputs follow Library files');
  f.codex.finish(reuseSend, 'completed', 'Tighter.');
  await f.settled(card.id, reuse.id);

  // Promotion makes it a Library file another card can select by its own identity.
  const promoted = await f.ok('POST', `/api/cards/${card.id}/chat/saved-outputs/${saved.id}/promote`, { operation: randomUUID(), folderId: null, filename: 'Outline.md' });
  assert.notEqual(promoted.version.id, saved.versionId);
  const other = await f.card({ title: 'Episode 13' });
  const borrowed = await f.queue(other.id, await f.select(other.id, 'Reuse that outline', { library: [{ kind: 'asset', id: promoted.asset.id }] }));
  assert.deepEqual(borrowed.context.library.map((file) => [file.assetId, file.versionId, file.hash]), [[promoted.asset.id, promoted.version.id, saved.hash]]);
  assert.deepEqual(borrowed.context.savedOutputs, []);
  assert.ok(sentText(await f.nextSend(3)).includes(outline));

  // Fresh context clears the manual choices; the playbook keeps its own.
  const fresh = await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  assert.deepEqual([fresh.composer.selections.library, fresh.composer.selections.savedOutputs], [[], []]);
  assert.deepEqual((await f.ok('GET', `/api/cards/${card.id}/lane-runs/preview`)).library.map((file) => file.assetId), [guideAsset.id]);
});

// Starts an app over an existing data directory, as `DATA_DIR=… npm start` would.
async function serve(dataDir, codex) {
  const app = await createApp({ dataDir, codexAdapter: codex });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise((resolve) => (app.listening ? app.close(resolve) : resolve()));
  const raw = (url, init) => fetch(`http://127.0.0.1:${app.address().port}${url}`, init);
  const call = async (method, url, body) => {
    const response = await raw(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (...args) => { const value = await call(...args); assert.ok(value.status < 300, JSON.stringify(value)); return value.body; };
  return { raw, call, ok, close };
}

// Everything a user can inspect about the retained work, read over HTTP: each
// project's Library (live, removed, every version and its bytes), cards,
// frozen submissions, saved outputs with their provenance and bytes, and the
// lane playbooks with what their selections resolve to.
async function inventory({ ok, raw }, projectIds) {
  const bytes = async (url) => { const response = await raw(url); assert.equal(response.status, 200, url); return Buffer.from(await response.arrayBuffer()).toString('base64'); };
  const workspace = await ok('GET', '/api/workspace');
  const settings = Object.fromEntries(await Promise.all(['codex', 'claude'].map(async (provider) => [provider, (await ok('GET', `/api/providers/${provider}`)).selection])));
  const projects = [];
  for (const id of projectIds) {
    const project = workspace.projects.find((entry) => entry.id === id);
    const library = await ok('GET', `/api/projects/${id}/library`);
    const removed = (await ok('GET', `/api/projects/${id}/library/removed`)).assets;
    const assets = [];
    for (const { id: assetId } of [...library.assets, ...removed]) {
      const asset = await ok('GET', `/api/projects/${id}/library/assets/${assetId}`);
      const versions = [];
      for (const version of asset.versions) versions.push({ ...version, bytes: await bytes(`/api/projects/${id}/library/versions/${version.id}/content`) });
      assets.push({ ...asset, versions });
    }
    const cards = [];
    for (const card of (await ok('GET', `/api/projects/${id}/cards`)).cards) {
      const chat = await ok('GET', `/api/cards/${card.id}/chat`);
      const savedOutputs = [];
      for (const output of chat.savedOutputs) savedOutputs.push({ ...output, bytes: await bytes(`/api/cards/${card.id}/chat/saved-outputs/${output.id}/content`) });
      const gallery = [];
      for (const image of card.images) gallery.push({ ...image, bytes: await bytes(`/images/${image.id}`) });
      cards.push({ id: card.id, title: card.title, fields: card.fields, gallery, selections: chat.composer.selections, savedOutputs,
        notes: (await ok('GET', `/api/cards/${card.id}/notes`)).text, laneRuns: (await ok('GET', `/api/cards/${card.id}/lane-runs`)).runs.map(({ id: runId, status, submissionId, result: applied }) => ({ runId, status, submissionId, applied })),
        submissions: chat.submissions.map(({ id: submissionId, prompt, context, laneRunId }) => ({ id: submissionId, prompt, context, laneRunId })),
        laneRunPreview: project.archivedAt ? 'archived' : (await ok('GET', `/api/cards/${card.id}/lane-runs/preview`)).library.map((file) => [file.assetId, file.versionId]) });
    }
    const flow = await ok('GET', `/api/flows/${project.flowId}/playbooks`);
    const playbooks = [flow.map, ...flow.lanes, ...flow.skills].map(({ path: file, text }) => ({ file, text }));
    projects.push({ id, name: project.name, archived: Boolean(project.archivedAt), folders: library.folders, assets, cards, playbooks });
  }
  return { settings, projects };
}

test('active and archived projects with their whole asset history export under maintenance and restore into an empty destination intact, running nothing again', async (t) => {
  const f = await workflowFixture(t);
  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-release-'));
  let restored;
  t.after(async () => { await restored?.close(); await rm(root, { recursive: true, force: true }); });

  // Active project: a replaced script, a removed file, a written guide, a playbook selection.
  const scripts = await f.folder('Scripts');
  const scriptAsset = await f.upload('episode-12.txt', Buffer.from(script), { folder: scripts.id });
  await f.upload('episode-12.txt', Buffer.from(`${script}\nTake two.`), { folder: scripts.id, collision: 'replace', asset: scriptAsset.id });
  const dropped = await f.upload('old notes.txt', Buffer.from('Superseded notes'));
  await f.ok('DELETE', `${f.library}/assets/${dropped.id}`);
  const guideAsset = await f.write('Hook guide.md', guide);
  await f.ok('PUT', `/api/flows/${f.project.flowId}/playbooks`, { path: 'skills/voice.md', text: '# Voice\n\nSpeak plainly.', baseHash: null });
  await setPlaybook(f.ok, f.project.flowId, f.stage, { run: 'manual', model: 'test-model', may_edit: ['intro'], skills: ['voice'], assets: [`folder:${scripts.id}`, `asset:${guideAsset.id}`] }, 'Outline the episode.');

  // A completed Send whose reply is saved as a document and promoted.
  const portrait = await (await f.raw('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  const card = await f.card({ title: 'Episode 12', images: [{ id: portrait.id, name: 'Portrait' }] });
  const sent = await f.queue(card.id, await f.select(card.id, 'Outline it', { library: [{ kind: 'folder', id: scripts.id }] }));
  f.codex.finish(await f.nextSend(0), 'completed', outline);
  const reply = (await f.settled(card.id, sent.id)).items.find((item) => item.kind === 'agentMessage' && item.text === outline);
  const saved = await f.ok('POST', `/api/cards/${card.id}/chat/saved-outputs`, { operation: randomUUID(), sequence: reply.sequence, filename: 'outline.md' });
  await f.ok('POST', `/api/cards/${card.id}/chat/saved-outputs/${saved.id}/promote`, { operation: randomUUID(), folderId: null, filename: 'Outline.md' });
  // A completed lane run with a field, hand-off notes and a saved document.
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  f.codex.finish(await f.nextSend(1), 'completed', result({ fields: { intro: 'Ever fought a drawer?' }, notes: 'Outlined from the script.', outputs: [{ filename: 'lane-outline.md', text: outline }] }));
  await waitFor(async () => (await f.chat(card.id)).savedOutputs.filter((entry) => entry.status === 'saved').length === 2);

  // Archived project: its own Library file, used by a Send whose reply was saved.
  const { project: season } = await f.ok('POST', '/api/projects', { name: 'Season 1' });
  const seasonStage = (await f.ok('GET', '/api/workspace')).flows.find((flow) => flow.id === season.flowId).stages[0];
  const reel = await f.upload('reel.bin', Buffer.from([0, 255, 1, 254, 0]), {}, season.id);
  const seasonCard = await f.ok('POST', `/api/projects/${season.id}/cards`, { stageId: seasonStage.id, title: 'Pilot' });
  const pilot = await f.queue(seasonCard.id, await f.select(seasonCard.id, 'Review the reel', { library: [{ kind: 'asset', id: reel.id }] }));
  f.codex.finish(await f.nextSend(2), 'completed', 'The reel is fine.');
  const pilotReply = (await f.settled(seasonCard.id, pilot.id)).items.find((item) => item.kind === 'agentMessage' && item.text === 'The reel is fine.');
  await f.ok('POST', `/api/cards/${seasonCard.id}/chat/saved-outputs`, { operation: randomUUID(), sequence: pilotReply.sequence, filename: 'review.md' });
  await f.ok('POST', `/api/projects/${season.id}/archive`, {});

  // Unfinished work at export time: one running, one queued behind it.
  const running = await f.queue(card.id, await f.select(card.id, 'Running when the export starts', {}));
  const runningSend = await f.nextSend(3);
  const queued = await f.queue(card.id, await f.select(card.id, 'Queued behind it', {}));
  const output = path.join(root, 'backups');
  await f.ok('POST', '/api/maintenance/export', { output });
  f.codex.finish(runningSend, 'completed', 'Finished during maintenance.');
  const exported = await waitFor(async () => { const value = await f.ok('GET', '/api/maintenance'); return !value.active && value.last; });
  assert.equal(exported.status, 'completed', JSON.stringify(exported));
  const before = await inventory(f, [f.project.id, season.id]);
  assert.deepEqual(before.projects.map((project) => [project.assets.length, project.cards.flatMap((entry) => entry.savedOutputs).length, project.cards.flatMap((entry) => entry.submissions).length,
    project.cards.flatMap((entry) => entry.laneRuns).length, project.cards.flatMap((entry) => entry.gallery).length, project.playbooks.length]),
  [[4, 2, 4, 1, 1, 3], [1, 1, 1, 0, 0, 1]], 'the comparison covers every Library file, saved output, submission, lane run, gallery image and flow document');
  assert.match(before.projects[0].cards[0].notes, /Outlined from the script/);
  await f.close();

  const dataDir = path.join(root, 'restored');
  await restoreBackup({ backupDir: exported.backupDir, dataDir, codexHome: path.join(root, 'native') });
  const codex = new ControlledCodex(path.join(root, 'native'));
  restored = await serve(dataDir, codex);
  const after = await inventory(restored, [f.project.id, season.id]);
  assert.deepEqual(after, before, 'every identity, version, byte, provenance link, frozen submission and playbook selection is restored');
  assert.equal(after.projects[1].archived, true);
  assert.equal(after.projects[0].assets.find((asset) => asset.id === scriptAsset.id).versions.length, 2, 'the superseded version is kept');
  assert.ok(after.projects[0].assets.find((asset) => asset.id === dropped.id).removedAt, 'the removed file is kept, still removed');

  // Nothing runs again: the queued follow-up is held, not resumed.
  const chat = await restored.ok('GET', `/api/cards/${card.id}/chat`);
  assert.equal(chat.submissions.find((entry) => entry.id === running.id).status, 'completed');
  assert.equal(chat.submissions.find((entry) => entry.id === queued.id).status, 'held');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(codex.sends.length, 0);
  const archivedChat = await restored.ok('GET', `/api/cards/${seasonCard.id}/chat`);
  const refused = await restored.call('POST', `/api/cards/${seasonCard.id}/chat/submissions`, { id: randomUUID(), composerRevision: archivedChat.composer.revision });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /archived/i, 'the archived project accepts no new work');

  // New explicit work in fresh context sends the restored current versions.
  const { composer } = await restored.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  const next = await restored.ok('PUT', `/api/cards/${card.id}/chat/composer`, { ...composer, prompt: 'Outline it again', model: 'test-model',
    selections: { ...composer.selections, library: [{ kind: 'folder', id: scripts.id }, { kind: 'asset', id: guideAsset.id }] } });
  await restored.ok('POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: next.revision });
  const send = await waitFor(() => codex.sends[0]);
  assert.ok(sentText(send).includes('Take two.') && sentText(send).includes(guide));
  assert.equal(codex.sends.length, 1, 'only the new work was sent');
});

test('with retained-data protection on, as shipped, a Claude Send and a Claude lane run with Library files are held before any Claude turn starts', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'frameboard-claude-held-'));
  // The production adapter, protection left on: only the harness is the fixture.
  const claude = createClaudeAdapter({ command: process.execPath, args: [fileURLToPath(new URL('./support/fake-claude.js', import.meta.url))], env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
  const f = await workflowFixture(t, { claudeAdapter: claude });
  t.after(() => rm(home, { recursive: true, force: true }));
  const settings = await f.ok('GET', '/api/providers/claude');
  await f.ok('PUT', '/api/providers/claude', { revision: settings.revision, selection: { ...settings.selection, enabled: true } });
  const guideAsset = await f.write('Hook guide.md', guide);
  const library = [{ kind: 'asset', id: guideAsset.id }];

  const card = await f.card({ title: 'Claude card' });
  const { composer } = await f.chat(card.id);
  const saved = await f.ok('PUT', `/api/cards/${card.id}/chat/composer`, { ...composer, prompt: 'Use the guide', provider: 'claude', model: 'sonnet', selections: { ...composer.selections, library } });
  const manual = await f.queue(card.id, saved);
  await setPlaybook(f.ok, f.project.flowId, f.stage, { run: 'manual', provider: 'claude', model: 'sonnet', assets: [`asset:${guideAsset.id}`] }, 'Outline it.');
  const laneCard = await f.card({ title: 'Claude lane card' });
  await f.ok('POST', `/api/cards/${laneCard.id}/lane-runs`, {});

  for (const cardId of [card.id, laneCard.id]) {
    const chat = await waitFor(async () => { const value = await f.chat(cardId); return value.submissions[0]?.status === 'held' && value; });
    const [submission] = chat.submissions;
    assert.match(submission.reason, /Retained-data protection .*Claude.* unproven/, submission.reason);
    assert.equal(submission.provider, 'claude');
    assert.ok(chat.attempts.every((attempt) => attempt.turnId === null && !attempt.delivery?.some((entry) => entry.status === 'sent')), 'no Claude turn started');
  }
  assert.equal((await f.chat(card.id)).submissions[0].id, manual.id);
  // The fixture records every user turn it receives; none arrived.
  assert.deepEqual(await readdir(path.join(home, 'projects')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; }), []);
});
