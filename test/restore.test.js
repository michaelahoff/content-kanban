import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod, stat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { openStore, inspectBackupDatabase } from '../store.js';
import { createBackup, restoreBackup } from '../backup.js';
import { ControlledCodex } from './support/controlled-codex.js';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';

const execute = promisify(execFile);
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

// Exports the stopped source workspace, restores it into a new directory and
// starts the restored app against a different native harness, as on another
// machine. Nothing from the old runtime survives except retained data.
async function restoreInto(t, source, { codex = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await source.close();
  const { backupDir } = await createBackup({ dataDir: source.dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'old-native') });
  const dataDir = path.join(root, 'restored');
  const report = await restoreBackup({ backupDir, dataDir, codexHome: path.join(root, 'native') });
  codex ??= new ControlledCodex(path.join(root, 'native'));
  let app;
  const start = async () => {
    app = await createApp({ dataDir, codexAdapter: codex, providerBackoffMs: 10 });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  };
  const close = () => new Promise((resolve) => (app.listening ? app.close(resolve) : resolve()));
  t.after(close);
  await start();
  const call = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (...args) => { const result = await call(...args); assert.ok(result.status < 300, JSON.stringify(result)); return result.body; };
  const chat = (id) => ok('GET', `/api/cards/${id}/chat`);
  const compose = async (id, prompt) => { const { composer } = await chat(id); return ok('PUT', `/api/cards/${id}/chat/composer`, { ...composer, prompt, model: 'test-model' }); };
  const queue = (id, composer) => ok('POST', `/api/cards/${id}/chat/submissions`, { id: randomUUID(), composerRevision: composer.revision });
  return { root, dataDir, backupDir, report, codex, call, ok, chat, compose, queue, restart: async () => { await close(); await start(); } };
}

test('a restored workspace holds unfinished work and pending lane runs, revokes old authority and dispatches nothing until new explicit work', async (t) => {
  const f = await fixture(t);
  const workspace = await f.ok('GET', '/api/workspace');
  const project = workspace.projects[0]; const stages = workspace.flows[0].stages;
  await setPlaybook(f.ok, project.flowId, stages[1], { run: 'on-enter', model: 'test-model', conversation: 'fresh', may_edit: ['intro'] }, 'Write an intro.');

  // Running work with a pending approval and a conversation grant, plus a queued follow-up.
  const running = await f.card({ title: 'Running' });
  const active = await f.queue(running.id, await f.compose(running.id));
  const send = await waitFor(() => f.codex.sends[0]);
  f.codex.emit(send.threadId, { type: 'delta', turnId: send.turnId, itemId: 'partial', delta: 'Partial reply' });
  f.codex.request(send, 'item/commandExecution/requestApproval', { command: 'granted command' });
  const granted = await waitFor(async () => (await f.chat(running.id)).requests.find((request) => request.status === 'pending'));
  await f.ok('POST', `/api/cards/${running.id}/chat/answer`, { requestId: granted.id, response: { decision: 'accept', scope: 'conversation' } });
  f.codex.request(send);
  await waitFor(async () => (await f.chat(running.id)).requests.some((request) => request.status === 'pending'));
  const followUp = await f.queue(running.id, await f.compose(running.id, 'Queued follow-up'));

  // A pending lane run: it waits for the busy card chat before fresh context.
  const laneCard = await f.card({ title: 'Lane' });
  const laneChat = await f.queue(laneCard.id, await f.compose(laneCard.id, 'Busy chat'));
  await waitFor(() => f.codex.sends[1]);
  await f.ok('POST', `/api/cards/${laneCard.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  const [pendingRun] = await waitFor(async () => { const { runs } = await f.ok('GET', `/api/cards/${laneCard.id}/lane-runs`); return runs[0]?.reason.startsWith('Waiting') && runs; });

  // A terminal failure that was a Retry candidate in the old workspace.
  const failedCard = await f.card({ title: 'Failed' });
  const failed = await f.queue(failedCard.id, await f.compose(failedCard.id));
  f.codex.finish(await waitFor(() => f.codex.sends[2]), 'failed');
  await waitFor(async () => (await f.chat(failedCard.id)).submissions[0].status === 'failed');

  // Archived work still being interrupted when the backup was taken.
  const other = await f.ok('POST', '/api/projects', { name: 'Archived' });
  const archivedCard = await f.ok('POST', `/api/projects/${other.project.id}/cards`, { stageId: other.flow.stages[0].id });
  const archivedWork = await f.queue(archivedCard.id, await f.compose(archivedCard.id));
  await waitFor(() => f.codex.sends[3]);
  f.codex.autoInterrupt = false;
  await f.ok('POST', `/api/projects/${other.project.id}/archive`, {});
  assert.equal((await f.chat(archivedCard.id)).submissions[0].status, 'interrupt-requested');

  const r = await restoreInto(t, f);
  await settle();
  assert.deepEqual(r.codex.sends, [], 'Nothing was resumed, resent or started');

  const restored = await r.chat(running.id);
  for (const id of [active.id, followUp.id]) {
    const submission = restored.submissions.find((entry) => entry.id === id);
    assert.equal(submission.status, 'held');
    assert.equal(submission.hold, 'restored');
    assert.match(submission.reason, /restored from a backup/i);
  }
  assert.equal(restored.attempts[0].status, 'interrupted');
  assert.equal(restored.attempts[0].cause, 'restored');
  assert.equal(restored.attempts[0].revoked, 'restored');
  assert.ok(restored.items.some((item) => item.text === 'Partial reply'), 'Retained output stays inspectable');
  assert.ok(restored.requests.every((request) => request.status !== 'pending'), 'Historical approvals were invalidated');
  assert.deepEqual(restored.conversations[0].grants, [], 'Historical grants confer no authority');

  const [heldRun] = (await r.ok('GET', `/api/cards/${laneCard.id}/lane-runs`)).runs;
  assert.equal(heldRun.id, pendingRun.id);
  assert.equal(heldRun.status, 'held');
  assert.match(heldRun.reason, /restored from a backup/i);
  assert.equal((await r.chat(laneCard.id)).submissions.find((entry) => entry.id === laneChat.id).status, 'held');

  const archived = await r.chat(archivedCard.id);
  assert.equal(archived.submissions[0].id, archivedWork.id);
  assert.equal(archived.submissions[0].status, 'cancelled');
  assert.equal(archived.submissions[0].revoked, 'archived');
  assert.equal(archived.attempts[0].revoked, 'archived');
  assert.ok((await r.ok('GET', '/api/workspace')).projects.find((project) => project.id === other.project.id).archivedAt);
  assert.match((await r.call('POST', `/api/cards/${archivedCard.id}/chat/retry`, { submissionId: archivedWork.id })).body.error, /archived/);

  const retry = await r.call('POST', `/api/cards/${failedCard.id}/chat/retry`, { submissionId: failed.id });
  assert.equal(retry.status, 409);
  assert.match(retry.body.error, /restored from a backup/i);
  const indicators = (await r.ok('GET', '/api/chat-activity')).entries;
  for (const id of [running.id, laneCard.id]) {
    const entry = indicators.find((value) => value.cardId === id);
    assert.equal(entry.state, 'needs-attention');
    assert.match(entry.reason, /restored from a backup/i);
  }

  // A restart neither resumes the held work nor holds new work.
  await r.restart();
  await settle();
  assert.deepEqual(r.codex.sends, []);
  assert.equal((await r.chat(running.id)).submissions.find((entry) => entry.id === followUp.id).status, 'held');

  // New explicit work reconnects the provider and runs. Held work is cancelled explicitly first.
  // Exact native resumption is not promised: the old binding is unavailable and
  // new work continues in fresh context.
  assert.equal((await r.chat(failedCard.id)).conversations[0].state, 'native-unavailable');
  await r.ok('POST', `/api/cards/${failedCard.id}/chat/fresh`, {});
  const fresh = await r.queue(failedCard.id, await r.compose(failedCard.id, 'New work after restore'));
  const newSend = await waitFor(() => r.codex.sends[0]);
  assert.equal(r.codex.sends.length, 1);
  r.codex.finish(newSend);
  await waitFor(async () => (await r.chat(failedCard.id)).submissions.find((entry) => entry.id === fresh.id).status === 'completed');
  for (const id of [followUp.id, active.id]) await r.ok('POST', `/api/cards/${running.id}/chat/cancel`, { submissionId: id });
  await r.ok('POST', `/api/cards/${laneCard.id}/chat/cancel`, { submissionId: laneChat.id });
  // Run playbook is new explicit work: it replaces the held run.
  const newRun = await r.ok('POST', `/api/cards/${laneCard.id}/lane-runs`, {});
  const laneSend = await waitFor(() => r.codex.sends[1]);
  const runs = (await r.ok('GET', `/api/cards/${laneCard.id}/lane-runs`)).runs;
  assert.equal(runs.find((run) => run.id === pendingRun.id).status, 'cancelled');
  assert.equal(runs.find((run) => run.id === newRun.id).status, 'queued');
  r.codex.finish(laneSend, 'completed', 'No result block');
  await waitFor(async () => (await r.ok('GET', `/api/cards/${laneCard.id}/lane-runs`)).runs.find((run) => run.id === newRun.id).status === 'completed');
  await r.restart();
  await settle();
  assert.equal(r.codex.sends.length, 2, 'Settled new work is not held or resent after another restart');
  assert.equal((await r.chat(failedCard.id)).submissions.find((entry) => entry.id === fresh.id).status, 'completed');
});

async function storeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-restore-store-'));
  const dataDir = path.join(root, 'data'); await mkdir(dataDir);
  let store = await openStore({ dataDir });
  const ctx = { ...store.owner, actor: `user:${store.owner.userId}` };
  t.after(async () => { store?.close(); await rm(root, { recursive: true, force: true }); });
  return { root, dataDir, ctx, get store() { return store; }, stop() { store.close(); store = null; },
    export: () => createBackup({ dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'native') }) };
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const streamed = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };

test('restore round-trips the complete identity, hash and relationship inventory of every store into an empty destination', async (t) => {
  const f = await storeFixture(t);
  const projectId = f.store.workspace(f.ctx).projects[0].id;
  const first = await f.store.retained.publish(f.ctx, { operationId: 'first', projectId, kind: 'asset', filename: 'script.bin' }, Buffer.from('first bytes'));
  const second = await f.store.retained.publish(f.ctx, { operationId: 'second', projectId, objectId: first.objectId, kind: 'asset', filename: 'script.bin' }, Buffer.from('second bytes'));
  const removed = await f.store.retained.publish(f.ctx, { operationId: 'removed', projectId, kind: 'document', filename: 'voice.md' }, Buffer.from('# Voice'));
  f.store.retained.remove(f.ctx, removed.objectId);
  const { project: archived } = f.store.createProject(f.ctx, { name: 'Archived project' });
  const archivedVersion = await f.store.retained.publish(f.ctx, { operationId: 'archived', projectId: archived.id, kind: 'asset', filename: 'old.bin' }, Buffer.from([0, 255, 1, 254]));
  const card = f.store.createCard(f.ctx, archived.id, { stageId: f.store.workspace(f.ctx).flows.find((flow) => flow.id === archived.flowId).stages[0].id, title: 'Archived card' });
  f.store.playbooks.appendNotes(card.id, 'Hand-off', 'Retained notes.');
  await mkdir(path.join(f.dataDir, 'workspaces', card.id, 'drafts'), { recursive: true });
  await writeFile(path.join(f.dataDir, 'workspaces', card.id, 'drafts', 'render.txt'), 'Workspace draft');
  f.store.archiveProject(f.ctx, archived.id);
  f.stop();

  const { backupDir } = await f.export();
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  const dataDir = path.join(f.root, 'restored');
  await restoreBackup({ backupDir, dataDir, codexHome: path.join(f.root, 'native') });

  // Every bundled file is restored with its exact bytes; the database differs
  // only by the recovery marker, which is not app content.
  for (const entry of manifest.files.filter((value) => value.path !== 'frameboard.db')) {
    assert.equal(sha(await readFile(path.join(dataDir, entry.path))), entry.sha256, entry.path);
  }
  const inventory = inspectBackupDatabase(path.join(dataDir, 'frameboard.db'));
  assert.deepEqual({ ...inventory.tables, meta: manifest.inventory.tables.meta }, manifest.inventory.tables);
  assert.equal(inventory.tables.meta, manifest.inventory.tables.meta + 1);
  assert.deepEqual(inventory.projects, manifest.inventory.projects);
  assert.deepEqual(inventory.retained, manifest.inventory.retained);
  assert.deepEqual(inventory.images.map((image) => ({ ...image, path: `images/${image.id}` })), manifest.inventory.images);
  assert.deepEqual(inventory.outputs.map(({ outputId, cardId, attemptId, importStatus }) => ({ outputId, cardId, attemptId, importStatus })),
    manifest.inventory.outputs.map(({ outputId, cardId, attemptId, importStatus }) => ({ outputId, cardId, attemptId, importStatus })));

  // A restored workspace exported before it was ever opened restores again.
  const again = await createBackup({ dataDir, output: path.join(f.root, 'backups'), codexHome: path.join(f.root, 'native') });
  await restoreBackup({ backupDir: again.backupDir, dataDir: path.join(f.root, 'restored-again'), codexHome: path.join(f.root, 'native') });
  const twice = await openStore({ dataDir: path.join(f.root, 'restored-again') });
  assert.equal(twice.activity({ ...twice.owner }, { since: 0, limit: 10000 }).filter((entry) => entry.type === 'restored').length, 1);
  twice.close();

  const store = await openStore({ dataDir }); t.after(() => store.close());
  const ctx = { ...store.owner, actor: `user:${store.owner.userId}` };
  for (const [version, bytes] of [[first, 'first bytes'], [second, 'second bytes'], [removed, '# Voice'], [archivedVersion, Buffer.from([0, 255, 1, 254])]]) {
    assert.deepEqual(await streamed(await store.retained.read(ctx, version.id)), Buffer.from(bytes));
  }
  const projects = store.workspace(ctx).projects;
  assert.ok(projects.find((project) => project.id === archived.id).archivedAt, 'Archive state is preserved');
  assert.equal(store.playbooks.notes(card.id).text.includes('Retained notes.'), true);
  assert.equal(store.activity(ctx, { since: 0, limit: 10000 }).filter((entry) => entry.type === 'restored').length, 1);
});

// Rewrites a bundled file and its manifest entry, as a damaged or foreign
// bundle whose bytes still match their recorded hash would look.
async function rewriteBundled(backupDir, relative, change) {
  const filename = path.join(backupDir, relative);
  await chmod(filename, 0o600); await change(filename);
  const manifestPath = path.join(backupDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bytes = await readFile(filename);
  Object.assign(manifest.files.find((entry) => entry.path === relative), { size: bytes.length, sha256: sha(bytes) });
  await writeFile(manifestPath, JSON.stringify(manifest));
}

test('restore refuses a backup from a newer schema before anything is activated', async (t) => {
  const f = await storeFixture(t); f.stop();
  const { backupDir } = await f.export();
  await rewriteBundled(backupDir, 'frameboard.db', (filename) => {
    const db = new DatabaseSync(filename);
    db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run(); db.close();
  });
  const dataDir = path.join(f.root, 'restored');
  await assert.rejects(restoreBackup({ backupDir, dataDir, codexHome: path.join(f.root, 'native') }), /newer version of Frameboard/);
  await assert.rejects(stat(dataDir), { code: 'ENOENT' });
  assert.deepEqual((await readdir(f.root)).sort(), ['backups', 'data']);
});

test('an interrupted, disk-full or raced restore activates nothing, and the next restore reclaims its staging', async (t) => {
  const f = await storeFixture(t);
  await f.store.retained.publish(f.ctx, { operationId: 'kept', projectId: f.store.workspace(f.ctx).projects[0].id, kind: 'asset', filename: 'kept.bin' }, Buffer.from('kept bytes'));
  f.stop();
  const { backupDir } = await f.export();
  const parent = path.join(f.root, 'restores'); const dataDir = path.join(parent, 'restored'); const codexHome = path.join(f.root, 'native');
  for (const phase of ['copying', 'activating']) {
    const crashed = await execute(process.execPath, ['--disable-warning=ExperimentalWarning', 'test/support/restore-crash.js', backupDir, dataDir, codexHome, phase]).then(() => null, (error) => error.code);
    assert.equal(crashed, 86);
    await assert.rejects(stat(dataDir), { code: 'ENOENT' });
    assert.ok((await readdir(parent)).some((name) => name.startsWith('.incomplete-')), 'The crash left owned staging behind');
  }

  const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  await assert.rejects(restoreBackup({ backupDir, dataDir, codexHome, checkpoint: async (boundary) => { if (boundary === 'verifying') throw full; } }),
    (error) => error.code === 'ENOSPC' && /Not enough disk space to restore the backup. Nothing was activated/.test(error.message));
  await assert.rejects(stat(dataDir), { code: 'ENOENT' });

  // Data written into the empty destination during the restore is never merged or replaced.
  await mkdir(dataDir);
  await assert.rejects(restoreBackup({ backupDir, dataDir, codexHome, checkpoint: async (boundary) => { if (boundary === 'activating') await writeFile(path.join(dataDir, 'other.txt'), 'Another writer'); } }), /new or empty app data directory/);
  assert.deepEqual(await readdir(dataDir), ['other.txt']);
  await rm(dataDir, { recursive: true });

  const report = await restoreBackup({ backupDir, dataDir, codexHome });
  assert.match(report.recovery, /held/);
  assert.deepEqual((await readdir(parent)).filter((name) => !name.endsWith('.frameboard-lock.sqlite')), ['restored'], 'Abandoned staging was reclaimed');
});

test('a damaged database, linked bundle directory or unsupported manifest is refused before activation', async (t) => {
  const f = await storeFixture(t);
  const card = f.store.createCard(f.ctx, f.store.workspace(f.ctx).projects[0].id, { stageId: f.store.workspace(f.ctx).flows[0].stages[0].id });
  await mkdir(path.join(f.dataDir, 'workspaces', card.id), { recursive: true });
  await writeFile(path.join(f.dataDir, 'workspaces', card.id, 'draft.txt'), 'Workspace draft');
  f.stop();
  const restore = async (backupDir) => restoreBackup({ backupDir, dataDir: path.join(f.root, 'restored'), codexHome: path.join(f.root, 'native') });
  const fresh = async () => (await f.export()).backupDir;

  const damaged = await fresh();
  await rewriteBundled(damaged, 'frameboard.db', async (filename) => {
    const bytes = await readFile(filename); bytes.fill(0x41, 4096, 8192); await writeFile(filename, bytes);
  });
  await assert.rejects(restore(damaged), /damaged/i);

  const linked = await fresh();
  const outside = path.join(f.root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'draft.txt'), 'Workspace draft');
  await rm(path.join(linked, 'workspaces', card.id), { recursive: true });
  await symlink(outside, path.join(linked, 'workspaces', card.id));
  await assert.rejects(restore(linked), /Linked directory refused/);

  const inventory = await fresh();
  const inventoryPath = path.join(inventory, 'manifest.json'); const recorded = JSON.parse(await readFile(inventoryPath, 'utf8'));
  recorded.inventory.projects[0].archivedAt = '2026-01-01T00:00:00.000Z';
  await writeFile(inventoryPath, JSON.stringify(recorded));
  await assert.rejects(restore(inventory), /inventory does not match/);

  // A destination reached through a link may not land inside the backup.
  const inside = await fresh();
  await symlink(inside, path.join(f.root, 'via-link'));
  await assert.rejects(restoreBackup({ backupDir: inside, dataDir: path.join(f.root, 'via-link', 'restored'), codexHome: path.join(f.root, 'native') }), /outside the backup folder/);
  await rm(path.join(f.root, 'via-link'));

  const unsupported = await fresh();
  const manifestPath = path.join(unsupported, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await readFile(manifestPath, 'utf8')), version: 3 }));
  await assert.rejects(restore(unsupported), /Unsupported backup manifest/);

  await assert.rejects(stat(path.join(f.root, 'restored')), { code: 'ENOENT' });
  assert.deepEqual((await readdir(f.root)).sort(), ['backups', 'data', 'outside']);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
const result = (value) => `Done.\n\n\`\`\`frameboard-result\n${JSON.stringify(value, null, 2)}\n\`\`\``;

test('late callbacks from the old runtime cannot act in a restored workspace, and new work rebuilds verified reference copies', async (t) => {
  const f = await fixture(t);
  const workspace = await f.ok('GET', '/api/workspace');
  const project = workspace.projects[0]; const stage = workspace.flows[0].stages[0];
  await setPlaybook(f.ok, project.flowId, stage, { run: 'manual', model: 'test-model', may_edit: ['intro'] }, 'Write an intro.');
  const card = await f.card({ title: 'Referenced' });
  const image = await (await f.raw('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  const { revision } = await f.ok('GET', `/api/cards/${card.id}`).then((value) => value.card);
  await f.ok('PATCH', `/api/cards/${card.id}`, { revision, images: [{ id: image.id, name: 'Original' }], imageRoles: { original: image.id } });
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const old = await waitFor(() => f.codex.sends[0]);
  const [run] = (await f.ok('GET', `/api/cards/${card.id}/lane-runs`)).runs;

  // Restored beside the same native harness, where the old turn still runs.
  const r = await restoreInto(t, f, { codex: f.codex });
  const late = await f.codex.tool(old, 'edit_fields', { fields: { intro: 'Late tool edit' }, baseVersions: { intro: 1 } });
  assert.notEqual(late?.success, true);
  f.codex.image(old, { result: png.toString('base64') });
  f.codex.finish(old, 'completed', result({ fields: { intro: 'Late result' }, notes: 'Late notes.' }));
  await r.restart();
  await settle();
  const chat = await r.chat(card.id);
  assert.equal(chat.outputs.length, 0);
  assert.equal(chat.proposals.length, 0);
  assert.equal(chat.submissions[0].status, 'held');
  assert.equal(chat.attempts.length, 1);
  assert.equal((await r.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, '');
  assert.equal((await r.ok('GET', `/api/cards/${card.id}/notes`)).text, '');
  assert.equal((await r.ok('GET', `/api/cards/${card.id}/lane-runs`)).runs.find((entry) => entry.id === run.id).status, 'held');
  assert.equal(f.codex.sends.length, 1);

  // New explicit work verifies and repairs the restored reference copy.
  const reference = path.join(r.dataDir, 'workspaces', card.id, 'references', `${sha(png)}.png`);
  await chmod(reference, 0o644); await writeFile(reference, 'Tampered reference');
  await r.ok('POST', `/api/cards/${card.id}/chat/cancel`, { submissionId: chat.submissions[0].id });
  await r.ok('POST', `/api/cards/${card.id}/chat/fresh`, {});
  await r.queue(card.id, await r.compose(card.id, 'Use the original'));
  const send = await waitFor(() => f.codex.sends[1]);
  assert.ok(send.input.some((entry) => entry.type === 'localImage' && entry.path === reference));
  assert.deepEqual(await readFile(reference), png);
});
