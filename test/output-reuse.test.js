import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createClaudeAdapter } from '../claude-adapter.js';
import { createBackup, restoreBackup } from '../backup.js';
import { createApp } from '../server.js';
import { ControlledCodex } from './support/controlled-codex.js';
import { setPlaybook } from './support/playbooks.js';
import { parseDocument, playbookSettings } from '../public/playbook-format.js';
import { fixture, waitFor } from './support/chat-fixture.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
const script = '# Black holes\n\nThey are not holes.';

// A completed reply in the card chat, saved with Save as document.
async function savedDocument(f, card, text = script, filename = 'script.md') {
  const before = f.codex.sends.length;
  const submission = await f.queue(card.id, await f.compose(card.id, 'Write the script'));
  const send = await waitFor(() => f.codex.sends[before]);
  f.codex.finish(send, 'completed', text);
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.submissions.find((s) => s.id === submission.id).status === 'completed' && value; });
  const item = chat.items.find((entry) => entry.kind === 'agentMessage' && entry.attemptId === chat.attempts.at(-1).id);
  const saved = await f.ok('POST', `/api/cards/${card.id}/chat/saved-outputs`, { operation: randomUUID(), sequence: item.sequence, filename });
  return { output: saved, submission };
}
const reuse = async (f, cardId, prompt, outputs, extra = {}) => {
  const { composer } = await f.chat(cardId);
  return f.compose(cardId, prompt, 'test-model', { ...extra, selections: { ...composer.selections, ...extra.selections, savedOutputs: outputs } });
};
const sentText = (send) => send.input.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');

test('a saved document from a previous conversation of the same card is sent as its exact version, without adoption or promotion', async (t) => {
  const f = await fixture(t); const card = await f.card({ title: 'Launch video' });
  const { output, submission: origin } = await savedDocument(f, card);
  const fresh = await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  assert.deepEqual(fresh.savedOutputs.map((entry) => entry.id), [output.id], 'fresh context still shows earlier saved outputs to reuse');

  const composer = await reuse(f, card.id, 'Tighten the saved script', [output.id]);
  assert.deepEqual(composer.selections.savedOutputs, [output.id]);
  const submission = await f.queue(card.id, composer);
  assert.deepEqual(submission.context.savedOutputs.map(({ outputId, versionId, filename, hash, size, method, conversationId, submissionId }) => ({ outputId, versionId, filename, hash, size, method, conversationId, submissionId })),
    [{ outputId: output.id, versionId: output.versionId, filename: 'script.md', hash: sha256(script), size: Buffer.byteLength(script), method: 'text', conversationId: origin.conversationId, submissionId: origin.id }]);
  assert.notEqual(submission.conversationId, origin.conversationId, 'the output came from a previous conversation');

  const send = await waitFor(() => f.codex.sends[1]);
  const text = sentText(send);
  assert.ok(text.includes(script), 'the whole saved text is sent');
  assert.ok(text.includes(output.id) && text.includes(output.versionId));
  assert.ok(text.indexOf('Tighten the saved script') < text.indexOf(script), 'the prompt comes before reference material');
  assert.match(text, /reference material/i);

  const { card: saved } = await f.ok('GET', `/api/cards/${card.id}`);
  assert.deepEqual(saved.images, [], 'reuse adopts nothing');
  const library = await f.ok('GET', `/api/projects/${saved.projectId}/library`);
  assert.deepEqual(library.assets ?? [], [], 'reuse promotes nothing to the Library');
  const delivery = await waitFor(async () => (await f.chat(card.id)).attempts.at(-1).delivery);
  assert.deepEqual(delivery.map(({ outputId, versionId, method }) => ({ outputId, versionId, method })), [{ outputId: output.id, versionId: output.versionId, method: 'text' }]);

  // A revision saved from that reply records the reused output as supplied context, not as a derivation.
  f.codex.finish(send, 'completed', 'Tighter script');
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.submissions.at(-1).status === 'completed' && value; });
  const item = chat.items.find((entry) => entry.kind === 'agentMessage' && entry.text === 'Tighter script');
  const revision = await f.ok('POST', `/api/cards/${card.id}/chat/saved-outputs`, { operation: randomUUID(), sequence: item.sequence, filename: 'tighter.md' });
  assert.deepEqual(revision.supplied, [{ kind: 'output', outputId: output.id, versionId: output.versionId, label: 'script.md', hash: sha256(script), size: Buffer.byteLength(script) }]);
  assert.deepEqual(revision.derivation, { declared: false });
});

test('another card’s output or an unknown one blocks Send by identity; ordinary messages keep reuse choices and fresh context clears them', async (t) => {
  const f = await fixture(t); const card = await f.card(); const other = await f.card({ title: 'Other card' });
  const { output: foreign } = await savedDocument(f, other, 'Other card script', 'other.md');
  const { output } = await savedDocument(f, card);
  const unknown = randomUUID();
  const composer = await reuse(f, card.id, 'Use them', [output.id, foreign.id, unknown]);
  const preview = await f.ok('POST', `/api/cards/${card.id}/chat/preview`, {});
  assert.deepEqual(preview.problems.map(({ key, label, phase }) => ({ key, label, phase })),
    [{ key: `output:${foreign.id}`, label: 'other.md', phase: 'resolve' }, { key: `output:${unknown}`, label: `output:${unknown}`, phase: 'resolve' }]);
  assert.match(preview.problems[0].reason, /project Library/);
  const refused = await f.call('POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: composer.revision });
  assert.equal(refused.status, 409);
  assert.ok(refused.body.error.includes(`output:${foreign.id}`));
  assert.equal((await f.chat(card.id)).submissions.length, 1, 'a refused Send queues nothing');

  const kept = await f.queue(card.id, await reuse(f, card.id, 'Use the script', [output.id]));
  assert.deepEqual(kept.context.savedOutputs.map((entry) => entry.outputId), [output.id]);
  f.codex.finish(await waitFor(() => f.codex.sends[2]));
  await waitFor(async () => (await f.chat(card.id)).submissions.at(-1).status === 'completed');
  assert.deepEqual((await f.chat(card.id)).composer.selections.savedOutputs, [output.id], 'an ordinary message keeps the choice');
  const { composer: fresh } = await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  assert.deepEqual(fresh.selections.savedOutputs, [], 'fresh context clears it');
  const switched = await reuse(f, card.id, 'Use the script', [output.id]);
  const claude = await f.ok('PUT', `/api/cards/${card.id}/chat/composer`, { ...switched, provider: 'claude', model: null });
  assert.deepEqual(claude.selections.savedOutputs, [], 'a primary-provider change clears earlier choices');
});

test('a gallery image that is also a reused chat image output is sent once with every label; Library files follow, then reused saved outputs', async (t) => {
  const f = await fixture(t); const card = await f.card();
  // One reply produces an image output and the text the user saves.
  await f.queue(card.id, await f.compose(card.id, 'Draw and write'));
  const send = await waitFor(() => f.codex.sends[0]);
  f.codex.image(send, { result: png.toString('base64') });
  f.codex.finish(send, 'completed', script);
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.submissions[0].status === 'completed' && value.outputs[0]?.importStatus === 'imported' && value; });
  const image = chat.outputs[0];
  const item = chat.items.find((entry) => entry.kind === 'agentMessage');
  const document = await f.ok('POST', `/api/cards/${card.id}/chat/saved-outputs`, { operation: randomUUID(), sequence: item.sequence, filename: 'script.md' });
  const { card: adopted } = await f.ok('POST', `/api/cards/${card.id}/chat/outputs/${image.id}/adopt`, {});
  await f.ok('PATCH', `/api/cards/${card.id}`, { changes: { imageRoles: { original: image.imageId } }, baseVersions: adopted.fieldVersions });
  // The same bytes uploaded to the Library are a separate asset.
  const params = new URLSearchParams({ filename: 'copy.png', operation: randomUUID() });
  const upload = await (await f.raw(`/api/projects/${adopted.projectId}/library/uploads?${params}`, { method: 'POST', body: png })).json();

  const composer = await reuse(f, card.id, 'Use everything', [document.id, document.id], { selections: { roles: ['original'], images: [image.imageId], library: [{ kind: 'asset', id: upload.asset.id }] } });
  assert.deepEqual(composer.selections.savedOutputs, [document.id], 'a repeated output is one choice');
  const submission = await f.queue(card.id, composer);
  assert.deepEqual(submission.context.images.map(({ id, labels, outputId }) => ({ id, labels, outputId })),
    [{ id: image.imageId, labels: ['Original', 'Attachment', 'Chat version'], outputId: image.id }], 'one image version, with its role and both sources');
  assert.deepEqual(submission.context.library.map((file) => [file.assetId, file.method]), [[upload.asset.id, 'image']], 'equal bytes in the Library stay a separate input');
  assert.deepEqual(submission.context.savedOutputs.map((output) => [output.outputId, output.method]), [[document.id, 'text']]);

  const next = await waitFor(() => f.codex.sends[1]);
  const workspace = path.join(f.dataDir, 'workspaces', card.id);
  assert.deepEqual(next.input.filter((entry) => entry.type === 'localImage').map((entry) => path.relative(workspace, entry.path).split('/').slice(0, 2).join('/')).map((dir) => dir.startsWith('references/library') ? 'library' : 'card'), ['card', 'library']);
  const text = sentText(next);
  assert.equal(text.match(/Original, Attachment, Chat version: /g)?.length, 1);
  assert.ok(text.indexOf(image.imageId) < text.indexOf(upload.version.id) && text.indexOf(upload.version.id) < text.indexOf(script), 'card images, then Library files, then reused outputs');
  const delivery = await waitFor(async () => (await f.chat(card.id)).attempts.at(-1).delivery);
  assert.deepEqual(delivery.map((entry) => entry.imageId ?? entry.outputId ?? entry.versionId), [image.imageId, upload.version.id, document.id]);
});

test('Retry resends the frozen reused output after the choice changes and a restart; damaged saved bytes block a new Send by identity', async (t) => {
  const f = await fixture(t); const card = await f.card();
  const { output } = await savedDocument(f, card);
  const submission = await f.queue(card.id, await reuse(f, card.id, 'Use the script', [output.id]));
  f.codex.finish(await waitFor(() => f.codex.sends[1]), 'failed', 'Provider failed');
  await waitFor(async () => (await f.chat(card.id)).submissions.at(-1).status === 'failed');
  await reuse(f, card.id, 'Something else', []);
  await f.restart();
  await f.ok('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: submission.id });
  const retried = await waitFor(() => f.codex.sends[2]);
  assert.ok(sentText(retried).includes(script), 'Retry sends the frozen reused output, not the current choice');
  f.codex.finish(retried);
  await waitFor(async () => (await f.chat(card.id)).submissions.find((s) => s.id === submission.id).status === 'completed');
  const { attempts } = await f.chat(card.id);
  assert.deepEqual(attempts.filter((attempt) => attempt.submissionId === submission.id).map((attempt) => attempt.delivery.map(({ outputId, status }) => [outputId, status])),
    [[[output.id, 'sent']], [[output.id, 'sent']]]);

  await rm(path.join(f.dataDir, 'retained', 'versions', output.versionId));
  const composer = await reuse(f, card.id, 'Use it again', [output.id]);
  const blocked = await f.call('POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: composer.revision });
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body.problems.map(({ key, label, phase }) => ({ key, label, phase })), [{ key: `output:${output.id}`, label: 'script.md', phase: 'integrity' }]);
  assert.match(blocked.body.problems[0].reason, /Remove it from this prompt, or save its reply again/);
});

async function withClaude(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'frameboard-claude-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const claude = { ...createClaudeAdapter({ command: process.execPath, args: [fileURLToPath(new URL('./support/fake-claude.js', import.meta.url))], env: { ...process.env, CLAUDE_CONFIG_DIR: home } }), protectRetainedData: undefined };
  const f = await fixture(t, { claudeAdapter: claude });
  const settings = await f.ok('GET', '/api/providers/claude');
  await f.ok('PUT', '/api/providers/claude', { revision: settings.revision, selection: { ...settings.selection, enabled: true } });
  const sent = async (card) => {
    const binding = (await f.chat(card.id)).conversations.at(-1).binding;
    const work = path.join(f.dataDir, 'workspaces', card.id);
    const history = await readFile(path.join(home, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), `${binding.threadId}.jsonl`), 'utf8');
    return history.trim().split('\n').map((line) => JSON.parse(line)).find((entry) => entry.type === 'user').message.content;
  };
  return { ...f, sent };
}

test('tool-disabled Claude receives a Codex-saved output’s actual text in fresh context; an unsupported gallery image still stops the whole union', async (t) => {
  const f = await withClaude(t); const card = await f.card();
  const { output } = await savedDocument(f, card);
  await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  await f.queue(card.id, await reuse(f, card.id, 'Shorten it', [output.id], { provider: 'claude', model: 'sonnet' }));
  await waitFor(async () => (await f.chat(card.id)).submissions.at(-1).status === 'completed');
  const content = await f.sent(card);
  assert.deepEqual(content.map((block) => block.type), ['text']);
  assert.ok(content[0].text.includes(script) && content[0].text.includes(output.id));

  const avif = { id: '00000009-0000-4000-8000-000000000000.avif', name: 'portrait.avif' };
  await writeFile(path.join(f.dataDir, 'images', avif.id), Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from('ftypavif'), Buffer.alloc(20)]));
  const { card: current } = await f.ok('GET', `/api/cards/${card.id}`);
  await f.ok('PATCH', `/api/cards/${card.id}`, { changes: { images: [avif], imageRoles: { original: avif.id } }, baseVersions: current.fieldVersions });
  const composer = await reuse(f, card.id, 'Again', [output.id], { provider: 'claude', model: 'sonnet' });
  const refused = await f.call('POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: composer.revision });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body.problems.map(({ key }) => key), [`image:${avif.id}`], 'usable reused text never lets a subset through');
});

test('export and restore keep reuse choices and frozen reused outputs with their provenance, and refuse a frozen reference to a missing output version', async (t) => {
  const f = await fixture(t); const card = await f.card();
  const { output } = await savedDocument(f, card);
  const submission = await f.queue(card.id, await reuse(f, card.id, 'Use the script', [output.id]));
  f.codex.finish(await waitFor(() => f.codex.sends[1]));
  await waitFor(async () => (await f.chat(card.id)).submissions.at(-1).status === 'completed');
  await f.close();
  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-reuse-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { backupDir } = await createBackup({ dataDir: f.dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'old-native') });
  const dataDir = path.join(root, 'restored');
  await restoreBackup({ backupDir, dataDir, codexHome: path.join(root, 'native') });
  const app = await createApp({ dataDir, codexAdapter: new ControlledCodex(path.join(root, 'native')) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const restored = await (await fetch(`http://127.0.0.1:${app.address().port}/api/cards/${card.id}/chat`)).json();
  assert.deepEqual(restored.composer.selections.savedOutputs, [output.id]);
  assert.deepEqual(restored.submissions.find((entry) => entry.id === submission.id).context.savedOutputs, submission.context.savedOutputs);

  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  try {
    const row = db.prepare('SELECT id, frozen FROM chat_submissions WHERE id = ?').get(submission.id);
    const frozen = JSON.parse(row.frozen); frozen.context.savedOutputs[0].versionId = randomUUID();
    db.prepare('UPDATE chat_submissions SET frozen = ? WHERE id = ?').run(JSON.stringify(frozen), row.id);
  } finally { db.close(); }
  await assert.rejects(createBackup({ dataDir: f.dataDir, output: path.join(root, 'broken'), codexHome: path.join(root, 'old-native') }), /saved output version/);
});

test('lane playbooks select only Library assets and folders: a saved output ID is never reused by a lane run', async (t) => {
  const f = await fixture(t); const card = await f.card();
  const { output } = await savedDocument(f, card);
  assert.deepEqual(playbookSettings(parseDocument(`---\nlane: drafting\nassets: [output:${output.id}]\n---\nWrite.`), 'youtube-video').assets, [], 'output:<id> is not a playbook source');
  const workspace = await f.ok('GET', '/api/workspace'); const project = workspace.projects[0];
  const stage = workspace.flows.find((flow) => flow.id === project.flowId).stages[0];
  await setPlaybook(f.ok, project.flowId, stage, { run: 'manual', model: 'test-model', assets: [`asset:${output.id}`] }, 'Use the saved script.');
  const preview = await f.ok('GET', `/api/cards/${card.id}/lane-runs/preview`);
  assert.deepEqual(preview.problems.map(({ key, phase }) => ({ key, phase })), [{ key: `asset:${output.id}`, phase: 'resolve' }], 'promote an output to the Library before a playbook can select it');
});

test('another card reuses an output only through its promoted Library asset, which stays a separate input from the output on its own card', async (t) => {
  const f = await fixture(t); const card = await f.card(); const other = await f.card({ title: 'Other card' });
  const { output } = await savedDocument(f, card);
  const promoted = await f.ok('POST', `/api/cards/${card.id}/chat/saved-outputs/${output.id}/promote`, { folderId: null, filename: 'script.md', operation: randomUUID() });
  assert.deepEqual((await f.chat(card.id)).composer.selections.savedOutputs, [], 'promotion selects nothing');

  const asset = { kind: 'asset', id: promoted.asset.id };
  const { composer: otherComposer } = await f.chat(other.id);
  const elsewhere = await f.queue(other.id, await f.compose(other.id, 'Use the promoted script', 'test-model', { selections: { ...otherComposer.selections, library: [asset] } }));
  assert.deepEqual(elsewhere.context.library.map((file) => [file.assetId, file.versionId, file.hash]), [[promoted.asset.id, promoted.version.id, sha256(script)]]);
  assert.deepEqual(elsewhere.context.savedOutputs, []);
  f.codex.finish(await waitFor(() => f.codex.sends[1]));

  const both = await f.queue(card.id, await reuse(f, card.id, 'Use both', [output.id], { selections: { library: [asset] } }));
  assert.deepEqual([both.context.library.map((file) => file.versionId), both.context.savedOutputs.map((entry) => entry.versionId)], [[promoted.version.id], [output.versionId]],
    'equal bytes never merge a promoted asset with its output');
  assert.equal(sentText(await waitFor(() => f.codex.sends[2])).split(script).length - 1, 2, 'each is sent');
});

test('a saved image file is reused as a native image after Library files, separate from a gallery image with the same bytes', async (t) => {
  const f = await fixture(t);
  const upload = await (await f.raw('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  const card = await f.card({ images: [{ id: upload.id, name: 'Portrait' }], imageRoles: { original: upload.id } });
  await f.queue(card.id, await f.compose(card.id, 'Render a thumbnail'));
  const send = await waitFor(() => f.codex.sends[0]);
  const workspace = path.join(f.dataDir, 'workspaces', card.id);
  await writeFile(path.join(workspace, 'render.png'), png);
  f.codex.finish(send, 'completed', 'Rendered render.png');
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.submissions[0].status === 'completed' && value; });
  const output = await f.ok('POST', `/api/cards/${card.id}/chat/saved-outputs`, { operation: randomUUID(), attempt: chat.attempts[0].id, path: 'render.png' });
  assert.equal(output.status, 'saved', JSON.stringify(output));

  const submission = await f.queue(card.id, await reuse(f, card.id, 'Refine the thumbnail', [output.id]));
  assert.deepEqual(submission.context.images.map((image) => [image.id, image.labels]), [[upload.id, ['Original']]]);
  assert.deepEqual(submission.context.savedOutputs.map((entry) => [entry.outputId, entry.method, entry.path]), [[output.id, 'image', `references/outputs/${output.versionId}.png`]]);
  const next = await waitFor(() => f.codex.sends[1]);
  const images = next.input.filter((entry) => entry.type === 'localImage');
  assert.deepEqual(images.map((entry) => path.relative(workspace, entry.path)).map((relative) => relative.startsWith('references/outputs/') ? 'output' : 'card'), ['card', 'output'], 'one input per retained identity, equal bytes and all');
  assert.deepEqual(await readFile(images[1].path), png);
});
