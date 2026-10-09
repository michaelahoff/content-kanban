import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';
import { createClaudeAdapter } from '../claude-adapter.js';
import { createBackup, restoreBackup } from '../backup.js';
import { createApp } from '../server.js';
import { ControlledCodex } from './support/controlled-codex.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
const opaque = Buffer.from([0, 255, 1, 254, 2, 253, 0, 0, 7]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const block = (value) => `Done.\n\n\`\`\`frameboard-result\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const runs = async (f, cardId) => (await f.ok('GET', `/api/cards/${cardId}/lane-runs`)).runs;
const bytesOf = async (f, cardId, outputId) => {
  const response = await f.raw(`/api/cards/${cardId}/chat/saved-outputs/${outputId}/content`);
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
};
const workspaceFile = async (f, cardId, relative, bytes) => {
  const filename = path.join(f.dataDir, 'workspaces', cardId, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, bytes);
  return filename;
};
async function laneCard(f) {
  const workspace = await f.ok('GET', '/api/workspace');
  const project = workspace.projects[0]; const stage = workspace.flows[0].stages[0];
  await setPlaybook(f.ok, project.flowId, stage, { run: 'manual', model: 'test-model', may_edit: ['intro'] }, 'Render a thumbnail.');
  const card = await f.card({ title: 'Lane card' });
  const image = await (await f.raw('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  const { revision } = (await f.ok('GET', `/api/cards/${card.id}`)).card;
  await f.ok('PATCH', `/api/cards/${card.id}`, { revision, images: [{ id: image.id, name: 'Portrait' }], imageRoles: { original: image.id } });
  return { project, stage, card, image };
}
// Runs a lane whose agent leaves files in its workspace before finishing.
async function laneRun(f, card, result, files = {}) {
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends.find((entry) => !entry.done));
  send.done = true;
  for (const [relative, bytes] of Object.entries(files)) await workspaceFile(f, card.id, relative, bytes);
  f.codex.finish(send, 'completed', block(result));
  return waitFor(async () => { const value = await runs(f, card.id); return value[0].status === 'completed' && value[0]; });
}

test('a Codex lane run saves the finished workspace files it declares, with exact bytes and their creation method', async (t) => {
  const f = await fixture(t);
  const { card, image } = await laneCard(f);
  const run = await laneRun(f, card, { fields: { intro: 'New intro' }, outputs: [
    { path: 'out/thumbnail.png', filename: 'thumbnail.png', sources: [image.id] },
    { path: 'out/project.bin' },
  ] }, { 'out/thumbnail.png': png, 'out/project.bin': opaque, 'out/scratch.txt': 'not declared' });

  const chat = await f.chat(card.id);
  assert.deepEqual(chat.savedOutputs.map((output) => [output.filename, output.status]), [['thumbnail.png', 'saved'], ['project.bin', 'saved']],
    'Only declared files are saved; a filename defaults to the path’s last part');
  const [thumbnail, project] = chat.savedOutputs;
  assert.equal(thumbnail.creationMethod, 'lane-result');
  assert.equal(thumbnail.kind, 'image', 'An image saved from the workspace is not native generation');
  assert.deepEqual(thumbnail.file, { path: 'out/thumbnail.png', format: 'png', namedBy: 'agent' });
  assert.equal(project.kind, 'file');
  assert.equal(thumbnail.provider, 'codex');
  assert.equal(thumbnail.hash, sha(png));
  assert.deepEqual(thumbnail.derivation, { declared: true, sources: [{ kind: 'image', versionId: image.id, label: 'Portrait' }] });
  assert.deepEqual(project.derivation, { declared: false });
  assert.deepEqual((await bytesOf(f, card.id, thumbnail.id)).bytes, png);
  assert.deepEqual((await bytesOf(f, card.id, project.id)).bytes, opaque);

  // Later workspace edits do not change the snapshot.
  await workspaceFile(f, card.id, 'out/project.bin', 'overwritten');
  assert.deepEqual((await bytesOf(f, card.id, project.id)).bytes, opaque);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, 'New intro');
  assert.match(run.reason, /Saved thumbnail\.png and project\.bin\./);
  assert.deepEqual(chat.outputs, [], 'A saved file is not an image output or gallery image');
});

test('unusable paths are reported as not saved and register nothing, while the reply, card effects and valid saves stand', async (t) => {
  const f = await fixture(t);
  const { card } = await laneCard(f);
  const root = path.join(f.dataDir, 'workspaces', card.id);
  const database = path.join(f.dataDir, 'frameboard.db');
  await workspaceFile(f, card.id, 'outside/inside.txt', 'escape');
  await symlink(database, path.join(root, 'linked.db'));
  await symlink(path.join(root, 'outside'), path.join(root, 'via'));
  await link(database, path.join(root, 'hard.db'));
  const run = await laneRun(f, card, { fields: { intro: 'Applied intro' }, outputs: [
    { path: '/etc/hostname', filename: 'absolute.txt' },
    { path: '../frameboard.db', filename: 'traversal.db' },
    { path: 'linked.db' },
    { path: 'via/inside.txt' },
    { path: 'hard.db' },
    { path: 'references/input.png' },
    { path: 'missing.png' },
    { path: 'folder' },
    { path: 'kept.txt' },
  ] }, { 'kept.txt': 'kept', 'folder/inner.txt': 'x', 'references/input.png': png });

  const chat = await f.chat(card.id);
  assert.deepEqual(chat.savedOutputs.map((output) => [output.filename, output.status]), [['kept.txt', 'saved']], 'Refused paths register nothing');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, 'Applied intro', 'Valid card effects stand');
  assert.ok(chat.items.some((item) => item.kind === 'agentMessage' && item.text.includes('missing.png')), 'The reply text is retained');
  const outcomes = Object.fromEntries(run.result.outputs.map((output) => [output.filename, output]));
  assert.deepEqual(Object.values(outcomes).map((output) => output.status), ['failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'saved']);
  assert.match(outcomes['absolute.txt'].error, /inside the card workspace/);
  assert.match(outcomes['traversal.db'].error, /inside the card workspace/);
  assert.match(outcomes['linked.db'].error, /is a link/);
  assert.match(outcomes['inside.txt'].error, /through a link/);
  assert.match(outcomes['hard.db'].error, /hard links/);
  assert.match(outcomes['input.png'].error, /reference copy/);
  assert.match(outcomes['missing.png'].error, /does not exist/);
  assert.match(outcomes.folder.error, /not a regular file/);
  assert.match(run.reason, /Applied Intro\. Saved kept\.txt\. absolute\.txt was not saved\./);
  assert.match(run.reason, /missing\.png was not saved\. missing\.png does not exist in the card workspace\./);
});

test('tool-disabled Claude cannot save a binary or general file by naming a path; its inline document still saves', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'frameboard-claude-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, FAKE_CLAUDE_LANE_RESULT: JSON.stringify({ outputs: [
    { path: 'render.png', filename: 'render.png' }, { filename: 'brief.md', text: '# Brief' }] }) };
  const claude = { ...createClaudeAdapter({ command: process.execPath, args: [fileURLToPath(new URL('./support/fake-claude.js', import.meta.url))], env }), protectRetainedData: undefined };
  const f = await fixture(t, { claudeAdapter: claude });
  const settings = await f.ok('GET', '/api/providers/claude');
  await f.ok('PUT', '/api/providers/claude', { revision: settings.revision, selection: { ...settings.selection, enabled: true } });
  const workspace = await f.ok('GET', '/api/workspace');
  await setPlaybook(f.ok, workspace.projects[0].flowId, workspace.flows[0].stages[0], { run: 'manual', provider: 'claude', model: 'sonnet' }, 'Brief.');
  const card = await f.card({ title: 'Claude card' });
  // Even a file that really is in the workspace was not written by Claude.
  await workspaceFile(f, card.id, 'render.png', png);
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const [run] = await waitFor(async () => { const value = await runs(f, card.id); return value[0].status === 'completed' && value; });
  const chat = await f.chat(card.id);
  assert.deepEqual(chat.savedOutputs.map((output) => [output.filename, output.status, output.provider]), [['brief.md', 'saved', 'claude']]);
  assert.match(run.result.outputs[0].error, /Claude ran with its tools turned off/);
  assert.match(run.reason, /render\.png was not saved/);

  // Nor can the user save a workspace file as Claude's output.
  const refused = await f.call('POST', `/api/cards/${card.id}/chat/saved-outputs`, { operation: 'claude-file', attempt: chat.attempts[0].id, path: 'render.png' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Claude/);
  assert.equal((await f.chat(card.id)).savedOutputs.length, 1);
});

const saveFile = (f, cardId, body) => f.call('POST', `/api/cards/${cardId}/chat/saved-outputs`, body);
async function completedChat(f, card) {
  await f.queue(card.id, await f.compose(card.id));
  const send = await waitFor(() => f.codex.sends.find((entry) => !entry.done));
  return { send, finish: async () => {
    send.done = true;
    f.codex.finish(send, 'completed', 'Rendered out/frame.png');
    return waitFor(async () => { const value = await f.chat(card.id); return value.attempts.at(-1).status === 'completed' && value; });
  } };
}

test('Save output keeps a finished workspace file the user names, once, and only after its response finishes', async (t) => {
  const f = await fixture(t); const card = await f.card();
  const { finish } = await completedChat(f, card);
  await workspaceFile(f, card.id, 'out/frame.png', png);
  const running = (await f.chat(card.id)).attempts[0];
  const early = await saveFile(f, card.id, { operation: 'early', attempt: running.id, path: 'out/frame.png' });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /finish/);
  const chat = await finish();
  const attempt = chat.attempts[0];

  const saved = await saveFile(f, card.id, { operation: 'frame', attempt: attempt.id, path: 'out/frame.png', filename: 'frame-final.png' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.status, 'saved');
  assert.equal(saved.body.creationMethod, 'workspace-save');
  assert.equal(saved.body.kind, 'image');
  assert.equal(saved.body.file.namedBy, 'user', 'Frameboard records that the user credited this response');
  assert.equal(saved.body.attemptId, attempt.id);
  assert.deepEqual(saved.body.derivation, { declared: false });
  assert.equal(saved.body.hash, sha(png));
  const again = await saveFile(f, card.id, { operation: 'frame', attempt: attempt.id, path: 'out/frame.png', filename: 'frame-final.png' });
  assert.equal(again.body.id, saved.body.id, 'Repeating a successful save does not duplicate it');
  assert.equal((await f.chat(card.id)).savedOutputs.length, 1);
  const inline = await f.raw(`/api/cards/${card.id}/chat/saved-outputs/${saved.body.id}/content?inline=1`);
  assert.equal(inline.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await inline.arrayBuffer()), png);

  assert.equal((await saveFile(f, card.id, { operation: 'missing', attempt: attempt.id, path: 'nope.bin' })).status, 404);
  assert.equal((await saveFile(f, card.id, { operation: 'escape', attempt: attempt.id, path: '../../frameboard.db' })).status, 400);
  assert.equal((await saveFile(f, card.id, { operation: 'unknown', attempt: 'no-such-attempt', path: 'out/frame.png' })).status, 404);
  assert.equal((await f.chat(card.id)).savedOutputs.length, 1);
});

test('a failed file save retries only its originally verified bytes, never a later occupant of the path, and does not duplicate', async (t) => {
  let failAt = null;
  const f = await fixture(t, { retainedCheckpoint: async (boundary) => { if (boundary === failAt) { failAt = null; throw new Error('disk trouble'); } } });
  const card = await f.card();
  const { finish } = await completedChat(f, card);
  const { attempts: [attempt] } = await finish();
  await workspaceFile(f, card.id, 'cut.mov', opaque);

  failAt = 'staged';
  const failed = await saveFile(f, card.id, { operation: 'cut', attempt: attempt.id, path: 'cut.mov' });
  assert.equal(failed.status, 409);
  assert.match(failed.body.error, /Saving failed: disk trouble/);
  const [output] = (await f.chat(card.id)).savedOutputs;
  assert.equal(output.status, 'failed');
  assert.equal((await bytesOf(f, card.id, output.id)).status, 409, 'A failed save never claims retained bytes');
  const retry = () => f.call('POST', `/api/cards/${card.id}/chat/saved-outputs/${output.id}/retry-save`, {});

  // The path now holds different bytes: retrying refuses them.
  await workspaceFile(f, card.id, 'cut.mov', Buffer.from('a different cut'));
  const substituted = await retry();
  assert.equal(substituted.status, 409);
  assert.match(substituted.body.error, /changed since it was first saved/);
  await workspaceFile(f, card.id, 'cut.mov', Buffer.from([9, 9, 9, 9, 9, 9, 9, 9, 9]));
  assert.match((await retry()).body.error, /changed since it was first saved/, 'Same size, different bytes are refused too');
  assert.equal((await f.chat(card.id)).savedOutputs[0].status, 'failed');

  // The exact original bytes are available again: the same output is saved.
  await workspaceFile(f, card.id, 'cut.mov', opaque);
  const retried = await retry();
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.id, output.id);
  assert.equal(retried.body.status, 'saved');
  assert.deepEqual((await bytesOf(f, card.id, output.id)).bytes, opaque);
  assert.equal((await retry()).body.id, output.id, 'Retrying a saved output returns it');
  assert.deepEqual((await f.chat(card.id)).savedOutputs.map((entry) => [entry.id, entry.status]), [[output.id, 'saved']]);

  // A save that failed before its bytes were verified has nothing exact to retry.
  await workspaceFile(f, card.id, 'early.bin', opaque);
  failAt = 'staging';
  const unverified = await saveFile(f, card.id, { operation: 'early', attempt: attempt.id, path: 'early.bin' });
  assert.equal(unverified.status, 409);
  const early = (await f.chat(card.id)).savedOutputs.find((entry) => entry.filename === 'early.bin');
  assert.equal(early.status, 'failed');
  const refused = await f.call('POST', `/api/cards/${card.id}/chat/saved-outputs/${early.id}/retry-save`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /never verified/);
});

test('a lane file save stopped mid-save stays failed and its registration cannot be retried; the user can still save the file', async (t) => {
  let pause = null; let paused;
  const reached = new Promise((resolve) => { paused = resolve; });
  const f = await fixture(t, { retainedCheckpoint: async (boundary, version) => { if (boundary === 'staged' && version.filename === 'render.png' && pause) { paused(); await pause; } } });
  const { card } = await laneCard(f);
  let release; pause = new Promise((resolve) => { release = resolve; });
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  f.codex.autoInterrupt = false;
  await workspaceFile(f, card.id, 'render.png', png);
  f.codex.finish(send, 'completed', block({ fields: { intro: 'Applied intro' }, outputs: [{ path: 'render.png' }] }));
  await reached;
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  release();
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.savedOutputs[0]?.status === 'failed' && value; });
  const [output] = chat.savedOutputs;
  assert.match(output.error, /stopped/);
  const [run] = await waitFor(async () => { const value = await runs(f, card.id); return value[0].status === 'completed' && value; });
  assert.match(run.reason, /render\.png was not saved\. This response was stopped/);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, 'Applied intro');

  const retry = await f.call('POST', `/api/cards/${card.id}/chat/saved-outputs/${output.id}/retry-save`, {});
  assert.equal(retry.status, 409, 'Stop cannot be undone by retrying the agent’s registration');
  assert.equal((await f.chat(card.id)).savedOutputs[0].status, 'failed');
  const saved = await saveFile(f, card.id, { operation: 'mine', attempt: output.attemptId, path: 'render.png' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.creationMethod, 'workspace-save');
});

test('a lane file save that failed cannot be retried once its run ends; the user saves the file instead', async (t) => {
  let failOnce = true;
  const f = await fixture(t, { retainedCheckpoint: async (boundary, version) => { if (boundary === 'staged' && version.filename === 'cut.mov' && failOnce) { failOnce = false; throw new Error('disk trouble'); } } });
  const { card } = await laneCard(f);
  const run = await laneRun(f, card, { fields: { intro: 'Applied intro' }, outputs: [{ path: 'cut.mov' }] }, { 'cut.mov': opaque });
  assert.match(run.reason, /cut\.mov was not saved\. Saving failed: disk trouble/);
  const [output] = (await f.chat(card.id)).savedOutputs;
  assert.equal(output.status, 'failed');
  const retry = await f.call('POST', `/api/cards/${card.id}/chat/saved-outputs/${output.id}/retry-save`, {});
  assert.equal(retry.status, 409, 'The ended run cannot publish through its old registration');
  assert.match(retry.body.error, /no longer has authority.*Save output/);
  assert.equal((await f.chat(card.id)).savedOutputs[0].status, 'failed');
  const saved = await saveFile(f, card.id, { operation: 'mine', attempt: output.attemptId, path: 'cut.mov' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual((await bytesOf(f, card.id, saved.body.id)).bytes, opaque);
});

test('a saved file survives workspace deletion, archive and card deletion, is refused while archived, and restores from a verified backup', async (t) => {
  const f = await fixture(t); const card = await f.card();
  const { finish } = await completedChat(f, card);
  const { attempts: [attempt] } = await finish();
  // Larger than any document or image limit: streamed, never a single buffer limit.
  const large = Buffer.alloc(24 * 1024 * 1024 + 3, 7); large[5] = 1; large[large.length - 1] = 2;
  await workspaceFile(f, card.id, 'render/master.bin', large);
  const saved = (await saveFile(f, card.id, { operation: 'master', attempt: attempt.id, path: 'render/master.bin' })).body;
  assert.equal(saved.status, 'saved');
  assert.equal(saved.size, large.length);
  assert.equal(saved.hash, sha(large));

  await rm(path.join(f.dataDir, 'workspaces', card.id), { recursive: true, force: true });
  const project = (await f.ok('GET', '/api/workspace')).projects[0];
  await workspaceFile(f, card.id, 'later.bin', opaque);
  await f.ok('POST', `/api/projects/${project.id}/archive`, {});
  const refused = await saveFile(f, card.id, { operation: 'archived', attempt: attempt.id, path: 'later.bin' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /archived/i);
  assert.equal(sha((await bytesOf(f, card.id, saved.id)).bytes), sha(large), 'Archived outputs stay downloadable');
  await f.ok('POST', `/api/projects/${project.id}/unarchive`, {});
  await f.ok('DELETE', `/api/cards/${card.id}`);
  const before = (await f.chat(card.id)).savedOutputs;
  assert.deepEqual(before.map((output) => [output.id, output.status]), [[saved.id, 'saved']], 'A save refused while archived registered nothing');
  await f.close();

  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-files-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { backupDir } = await createBackup({ dataDir: f.dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'native') });
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  const entry = manifest.inventory.savedOutputs.find((output) => output.outputId === saved.id);
  assert.equal(entry.sha256, sha(large));
  assert.deepEqual(entry.source, { kind: 'file', path: 'render/master.bin', creationMethod: 'workspace-save' }, 'The inventory names each file output’s source');
  assert.ok(manifest.files.some((file) => file.path === entry.path && file.sha256 === entry.sha256));
  const dataDir = path.join(root, 'restored');
  await restoreBackup({ backupDir, dataDir, codexHome: path.join(root, 'native') });
  const app = await createApp({ dataDir, codexAdapter: new ControlledCodex(path.join(root, 'native')) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.deepEqual((await (await fetch(`${base}/api/cards/${card.id}/chat`)).json()).savedOutputs, before, 'Identities, provenance and outcomes are unchanged');
  const restored = Buffer.from(await (await fetch(`${base}/api/cards/${card.id}/chat/saved-outputs/${saved.id}/content`)).arrayBuffer());
  assert.equal(sha(restored), sha(large));
});
