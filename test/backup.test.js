import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.js';
import { ControlledCodex } from './support/controlled-codex.js';
import { randomUUID } from 'node:crypto';
import { waitFor } from './support/chat-fixture.js';

const execute = promisify(execFile);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
const cli = (...args) => execute(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/backup.mjs', ...args]);

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-backup-'));
  const dataDir = path.join(root, 'data');
  let app; let codex;
  const stop = async () => { if (app?.listening) await new Promise((resolve) => app.close(resolve)); };
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  async function start(directory = dataDir) {
    codex = new ControlledCodex(directory);
    app = await createApp({ dataDir: directory, codexAdapter: codex });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  }
  await start();
  async function api(method, url, body) {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${url}`, { method,
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  }
  const workspace = await api('GET', '/api/workspace'); const project = workspace.projects[0];
  const card = await api('POST', `/api/projects/${project.id}/cards`, { title: 'Retained card', stageId: workspace.flows[0].stages[0].id });
  const uploaded = await fetch(`http://127.0.0.1:${app.address().port}/api/images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  const image = await uploaded.json(); assert.ok(uploaded.ok);
  await api('PATCH', `/api/cards/${card.id}`, { revision: card.revision, images: [{ id: image.id, name: 'Original' }], imageRoles: { original: image.id } });
  const workspaceDir = path.join(dataDir, 'workspaces', card.id); await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(workspaceDir, 'draft.txt'), 'Workspace draft');
  await api('PUT', `/api/flows/${project.flowId}/playbooks`, { path: 'skills/voice.md', text: 'Retained skill', baseHash: null });
  const before = { workspace: await api('GET', '/api/workspace'), card: await api('GET', `/api/cards/${card.id}`), states: await api('GET', `/api/cards/${card.id}/states`) };
  const backup = async (extra = []) => JSON.parse((await cli('create', '--data-dir', dataDir, '--output', path.join(root, 'backups'), ...extra)).stdout);
  async function completeChat() {
    const { composer } = await api('GET', `/api/cards/${card.id}/chat`);
    const saved = await api('PUT', `/api/cards/${card.id}/chat/composer`, { ...composer, prompt: 'Retained prompt', model: 'test-model' });
    await api('POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: saved.revision });
    const send = await waitFor(() => codex.sends[0]); codex.finish(send);
    return await api('GET', `/api/cards/${card.id}/chat`);
  }
  return { root, dataDir, api, card, image, before, start, stop, backup, completeChat };
}

test('backup CLI restores app history, image roles and workspace bytes losslessly', async (t) => {
  const f = await fixture(t); await f.stop();
  const result = await f.backup();
  assert.match(path.basename(result.backupDir), /^frameboard-\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.nativeResume, 'not verified');
  const restored = path.join(f.root, 'restored');
  await cli('restore', '--backup', result.backupDir, '--data-dir', restored, '--codex-home', path.join(f.root, 'native'));
  assert.deepEqual(await readFile(path.join(restored, 'images', f.image.id)), png);
  assert.equal(await readFile(path.join(restored, 'workspaces', f.card.id, 'draft.txt'), 'utf8'), 'Workspace draft');
  assert.equal(await readFile(path.join(restored, 'flows', f.before.workspace.projects[0].flowId, 'skills', 'voice.md'), 'utf8'), 'Retained skill');
  await f.start(restored);
  // The restore itself is the only new activity.
  assert.deepEqual(await f.api('GET', '/api/workspace'), { ...f.before.workspace, eventCursor: f.before.workspace.eventCursor + 1 });
  assert.deepEqual(await f.api('GET', `/api/cards/${f.card.id}`), f.before.card);
  assert.deepEqual(await f.api('GET', `/api/cards/${f.card.id}/states`), f.before.states);
});

test('backup selects only bound native rollouts and images, excludes global secrets, and restore never overwrites native files', async (t) => {
  const f = await fixture(t); const chat = await f.completeChat(); await f.stop();
  const thread = chat.conversations[0].binding.threadId;
  const home = path.join(f.root, 'codex-source'); const other = randomUUID();
  const rollout = `sessions/2026/10/07/rollout-2026-10-07T12-00-00-${thread}.jsonl`;
  await mkdir(path.dirname(path.join(home, rollout)), { recursive: true });
  const transcript = JSON.stringify({ type: 'session_meta', payload: { id: thread } }) + '\n';
  await writeFile(path.join(home, rollout), transcript);
  await writeFile(path.join(home, path.dirname(rollout), `rollout-2026-10-07T12-00-00-${other}.jsonl`), 'Unrelated private conversation');
  for (const filename of ['auth.json', 'config.toml', 'rules/default.rules', 'skills/private/SKILL.md', '.credentials.json', 'state_5.sqlite']) {
    await mkdir(path.dirname(path.join(home, filename)), { recursive: true }); await writeFile(path.join(home, filename), 'GLOBAL_SECRET_SENTINEL');
  }
  const generated = `generated_images/${thread}/image.png`;
  await mkdir(path.dirname(path.join(home, generated)), { recursive: true }); await writeFile(path.join(home, generated), png);
  const { backupDir } = await f.backup(['--codex-home', home]);
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.filter((entry) => entry.path.startsWith('native/')).map((entry) => entry.path).sort(), [`native/codex/${generated}`, `native/codex/${rollout}`].sort());
  assert.doesNotMatch(JSON.stringify(manifest), /GLOBAL_SECRET_SENTINEL|auth\.json|state_5\.sqlite|config\.toml|SKILL\.md/);
  assert.equal(manifest.nativeResume, 'not verified');
  const nativeHome = path.join(f.root, 'codex-target');
  await mkdir(path.dirname(path.join(nativeHome, rollout)), { recursive: true }); await writeFile(path.join(nativeHome, rollout), 'Existing native history');
  const restored = path.join(f.root, 'native-restored');
  const report = JSON.parse((await cli('restore', '--backup', backupDir, '--data-dir', restored, '--codex-home', nativeHome)).stdout);
  assert.equal(await readFile(path.join(nativeHome, rollout), 'utf8'), 'Existing native history');
  assert.deepEqual(await readFile(path.join(nativeHome, generated)), png);
  assert.deepEqual(report.nativeSkipped, [rollout]);
  await f.start(restored);
  // History is identical; the bound conversation is not promised to resume.
  assert.deepEqual(await f.api('GET', `/api/cards/${f.card.id}/chat`), { ...chat,
    conversations: chat.conversations.map((conversation) => ({ ...conversation, state: 'native-unavailable' })) });
});

test('backup and restore refuse a running app and a second app cannot share its data', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.backup(), /Stop Frameboard/);
  await assert.rejects(createApp({ dataDir: f.dataDir, codexAdapter: new ControlledCodex(f.dataDir) }), /Stop Frameboard/);
  await f.stop(); const { backupDir } = await f.backup(); await f.start();
  await assert.rejects(cli('restore', '--backup', backupDir, '--data-dir', f.dataDir), /Stop Frameboard/);
});

test('backup refuses missing recorded images instead of silently omitting retained versions', async (t) => {
  const f = await fixture(t); await f.stop();
  await rm(path.join(f.dataDir, 'images', f.image.id));
  await assert.rejects(f.backup(), /Missing image/);
  assert.deepEqual(await readdir(path.join(f.root, 'backups')), []);
});

test('damaged images abort backup and damaged backup bytes abort restore before changing destination data', async (t) => {
  const f = await fixture(t); await f.stop(); const { backupDir } = await f.backup();
  await rm(path.join(f.dataDir, 'images', f.image.id));
  await writeFile(path.join(f.dataDir, 'images', f.image.id), Buffer.concat([png, Buffer.from('Damage')]));
  await assert.rejects(f.backup(), /Damaged image/);
  assert.equal((await readdir(path.join(f.root, 'backups'))).length, 1);
  await writeFile(path.join(backupDir, 'workspaces', f.card.id, 'draft.txt'), 'Damaged backup');
  const empty = path.join(f.root, 'empty-target'); await mkdir(empty);
  await assert.rejects(cli('restore', '--backup', backupDir, '--data-dir', empty), /hash mismatch/);
  assert.deepEqual(await readdir(empty), []);
  const target = path.join(f.root, 'target'); await mkdir(target); await writeFile(path.join(target, 'keep.txt'), 'Existing data');
  await assert.rejects(cli('restore', '--backup', backupDir, '--data-dir', target), /Existing app data/);
  assert.deepEqual(await readdir(target), ['keep.txt']);
  assert.equal(await readFile(path.join(target, 'keep.txt'), 'utf8'), 'Existing data');
});

test('restore preserves executable workspace files and refuses to overwrite existing app data', async (t) => {
  const f = await fixture(t); await f.stop();
  const relative = `workspaces/${f.card.id}/render.sh`;
  await writeFile(path.join(f.dataDir, relative), '#!/bin/sh\nexit 0\n'); await chmod(path.join(f.dataDir, relative), 0o700);
  const { backupDir } = await f.backup(); const target = path.join(f.root, 'mode-restored');
  await cli('restore', '--backup', backupDir, '--data-dir', target);
  assert.equal((await stat(path.join(target, relative))).mode & 0o777, 0o700);
  await assert.rejects(cli('restore', '--backup', backupDir, '--data-dir', f.dataDir), /Existing app data/);
});

test('linked workspace files and escaping or secret-bearing manifest entries are refused', async (t) => {
  const f = await fixture(t); await f.stop(); const { backupDir } = await f.backup();
  await symlink(path.join(f.dataDir, 'frameboard.db'), path.join(f.dataDir, 'workspaces', f.card.id, 'linked.db'));
  await assert.rejects(f.backup(), /Links and special files/);
  const manifestPath = path.join(backupDir, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entry = manifest.files.find((value) => value.path.endsWith('draft.txt'));
  const target = path.join(f.root, 'rejected-restore');
  for (const invalidPath of ['../escape.txt', 'native/codex/auth.json', 'native/codex/config.toml']) {
    const modified = structuredClone(manifest); modified.files.find((value) => value.path === entry.path).path = invalidPath;
    if (invalidPath.startsWith('native/')) { await mkdir(path.join(backupDir, 'native', 'codex'), { recursive: true }); await writeFile(path.join(backupDir, invalidPath), 'Workspace draft'); }
    await writeFile(manifestPath, JSON.stringify(modified));
    await assert.rejects(cli('restore', '--backup', backupDir, '--data-dir', target), /Invalid backup file entry|Only bound native/);
    await assert.rejects(stat(target), { code: 'ENOENT' });
  }
});

test('a hard app crash releases the backup lock without deleting a lock file', { timeout: 10000 }, async (t) => {
  const f = await fixture(t); await f.stop();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { env: { ...process.env, DATA_DIR: f.dataDir, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', (code) => reject(new Error(`App exited before startup: ${code}`))); });
  await assert.rejects(f.backup(), /Stop Frameboard/);
  const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  assert.equal((await f.backup()).nativeResume, 'not verified');
});

test('restore rejects a manifest that omits an image still recorded in the database', async (t) => {
  const f = await fixture(t); await f.stop(); const { backupDir } = await f.backup();
  const filename = path.join(backupDir, 'manifest.json'); const manifest = JSON.parse(await readFile(filename, 'utf8'));
  manifest.files = manifest.files.filter((entry) => entry.path !== `images/${f.image.id}`);
  await writeFile(filename, JSON.stringify(manifest));
  const target = path.join(f.root, 'missing-image-restore');
  await assert.rejects(cli('restore', '--backup', backupDir, '--data-dir', target), /Missing image/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
});
