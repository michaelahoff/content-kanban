import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.js';
import { createBackup } from '../backup.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-export-'));
  const dataDir = path.join(root, 'data'); await mkdir(dataDir);
  const output = path.join(root, 'backups');
  let store = await openStore({ dataDir });
  const ctx = { ...store.owner, actor: `user:${store.owner.userId}` };
  t.after(async () => { store?.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, dataDir, output, ctx,
    get store() { return store; },
    projectId: store.workspace(ctx).projects[0].id,
    publish(operationId, bytes, extra = {}) {
      return store.retained.publish(ctx, { operationId, projectId: this.projectId, kind: 'asset', filename: 'opaque.bin', ...extra }, Buffer.from(bytes));
    },
    stop() { store.close(); store = null; },
    export(options = {}) { return createBackup({ dataDir, output, codexHome: path.join(root, 'native'), ...options }); },
  };
}

test('export bundles every committed retained version, including superseded and removed ones, with a versioned inventory', async (t) => {
  const f = await fixture(t);
  const first = await f.publish('first', 'first bytes');
  const second = await f.publish('second', 'second bytes', { objectId: first.objectId });
  const removed = await f.publish('removed', 'removed bytes', { kind: 'document', filename: 'voice.md' });
  f.store.retained.remove(f.ctx, removed.objectId);
  f.stop();

  const { backupDir } = await f.export();
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'frameboard-backup');
  assert.equal(manifest.version, 2);
  for (const [version, bytes] of [[first, 'first bytes'], [second, 'second bytes'], [removed, 'removed bytes']]) {
    const relative = `retained/versions/${version.id}`;
    assert.deepEqual(await readFile(path.join(backupDir, relative)), Buffer.from(bytes));
    assert.deepEqual(manifest.files.find((entry) => entry.path === relative), { path: relative, size: bytes.length, sha256: sha(bytes), mode: 0o444 });
  }
  const retained = Object.fromEntries(manifest.inventory.retained.map((entry) => [entry.versionId, entry]));
  assert.deepEqual(retained[first.id], { versionId: first.id, objectId: first.objectId, projectId: f.projectId, kind: 'asset', label: 'opaque.bin', filename: 'opaque.bin',
    path: `retained/versions/${first.id}`, size: 11, sha256: sha('first bytes'), current: false, removed: false, baseVersionId: null });
  assert.equal(retained[second.id].current, true);
  assert.equal(retained[second.id].baseVersionId, first.id);
  assert.equal(retained[removed.id].removed, true);
  assert.deepEqual(await readdir(f.output), [path.basename(backupDir)]);
});

test('missing or corrupt retained payloads publish no bundle and leave the last good backup untouched', async (t) => {
  const f = await fixture(t);
  const version = await f.publish('kept', 'kept bytes');
  f.stop();
  const good = await f.export();
  const payload = path.join(f.dataDir, 'retained', 'versions', version.id);
  await chmod(payload, 0o600); await writeFile(payload, 'kept bytez');
  await assert.rejects(f.export(), new RegExp(`Damaged retained version: ${version.id}`));
  await rm(payload);
  await assert.rejects(f.export(), new RegExp(`Missing retained version: ${version.id}`));
  assert.deepEqual(await readdir(f.output), [path.basename(good.backupDir)]);
  assert.deepEqual(await readFile(path.join(good.backupDir, 'retained', 'versions', version.id)), Buffer.from('kept bytes'));
});

test('an interrupted export publishes nothing; the next export reclaims its staging but never a live export\'s', async (t) => {
  const f = await fixture(t);
  await f.publish('kept', 'kept bytes');
  f.stop();
  const good = await f.export();
  const crashed = await execute(process.execPath, ['--disable-warning=ExperimentalWarning', 'test/support/export-crash.js', f.dataDir, f.output, path.join(f.root, 'native'), 'copying'])
    .then(() => null, (error) => error.code);
  assert.equal(crashed, 86);
  const abandoned = (await readdir(f.output)).filter((name) => name.startsWith('.incomplete-'));
  assert.ok(abandoned.length);

  // A second workspace exporting to the same folder is paused mid-copy.
  const other = await fixture(t); other.stop();
  let resume; const paused = new Promise((resolve) => { resume = resolve; });
  let reached; const atCheckpoint = new Promise((resolve) => { reached = resolve; });
  const live = createBackup({ dataDir: other.dataDir, output: f.output, codexHome: path.join(other.root, 'native'),
    checkpoint: async (boundary) => { if (boundary === 'copying') { reached(); await paused; } } });
  await atCheckpoint;
  const liveStaging = (await readdir(f.output)).filter((name) => name.startsWith('.incomplete-') && !abandoned.includes(name));
  assert.ok(liveStaging.length);

  const next = await f.export();
  const names = await readdir(f.output);
  for (const name of abandoned) assert.ok(!names.includes(name), `${name} was not reclaimed`);
  for (const name of liveStaging) assert.ok(names.includes(name), `${name} belongs to a live export`);
  resume();
  const otherBackup = await live;
  assert.deepEqual((await readdir(f.output)).sort(), [good.backupDir, next.backupDir, otherBackup.backupDir].map((dir) => path.basename(dir)).sort());
});

test('cancellation and disk exhaustion fail visibly, reclaim staging and keep the previous backup', async (t) => {
  const f = await fixture(t);
  await f.publish('kept', 'kept bytes');
  f.stop();
  const good = await f.export();
  const controller = new AbortController();
  await assert.rejects(f.export({ signal: controller.signal, checkpoint: async (boundary) => { if (boundary === 'copying') controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(await readdir(f.output), [path.basename(good.backupDir)]);
  const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  await assert.rejects(f.export({ checkpoint: async (boundary) => { if (boundary === 'copying') throw full; } }), /Not enough disk space for the backup/);
  assert.deepEqual(await readdir(f.output), [path.basename(good.backupDir)]);
});

test('an external writer changing playbooks or workspaces during export fails visibly instead of certifying a mixed bundle', async (t) => {
  const f = await fixture(t);
  const flow = f.store.workspace(f.ctx).flows[0].id;
  const map = path.join(f.dataDir, 'flows', flow, 'MAP.md');
  await mkdir(path.dirname(map), { recursive: true }); await writeFile(map, '# Map');
  const notes = path.join(f.dataDir, 'workspaces', 'card', 'notes.md');
  await mkdir(path.dirname(notes), { recursive: true }); await writeFile(notes, 'Notes');
  f.stop();
  const good = await f.export();
  let once = false;
  await assert.rejects(f.export({ checkpoint: async (boundary) => { if (boundary === 'verifying' && !once) { once = true; await writeFile(map, '# Edited map'); } } }),
    /App data changed during export: flows\/.*MAP\.md.*close programs editing playbooks/);
  await assert.rejects(f.export({ checkpoint: async (boundary, relative) => { if (relative?.endsWith('notes.md')) await writeFile(path.join(path.dirname(notes), 'scratch.txt'), 'New'); } }),
    /App data changed during export: workspaces\/card\/scratch\.txt/);
  assert.deepEqual(await readdir(f.output), [path.basename(good.backupDir)]);
});

test('the manifest inventories active and archived projects, image versions and every database table, and states its coverage honestly', async (t) => {
  const f = await fixture(t);
  const archived = f.store.createProject(f.ctx, { name: 'Archived project' }).project;
  f.store.archiveProject(f.ctx, archived.id);
  f.stop();
  const { backupDir } = await f.export();
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  const projects = Object.fromEntries(manifest.inventory.projects.map((project) => [project.id, project]));
  assert.equal(projects[archived.id].name, 'Archived project');
  assert.ok(projects[archived.id].archivedAt);
  assert.equal(projects[f.projectId].archivedAt, null);
  assert.equal(manifest.inventory.tables.projects, 2);
  assert.equal(manifest.inventory.tables.retained_versions, 0);
  assert.ok(manifest.inventory.tables.activity_log > 0);
  assert.ok(manifest.coverage.excluded.some((entry) => /credentials/i.test(entry)));
  assert.ok(manifest.coverage.excluded.some((entry) => /external service/i.test(entry)));
});

test('reclaim removes only staging Frameboard can prove it owns, never similarly named folders', async (t) => {
  const f = await fixture(t); f.stop();
  await mkdir(path.join(f.output, '.incomplete-mine', 'notes'), { recursive: true });
  await writeFile(path.join(f.output, '.incomplete-mine', 'notes', 'keep.txt'), 'User folder');
  await mkdir(path.join(f.output, '.incomplete-Ab12Cd'));
  await f.export();
  assert.equal(await readFile(path.join(f.output, '.incomplete-mine', 'notes', 'keep.txt'), 'utf8'), 'User folder');
  assert.ok((await readdir(f.output)).includes('.incomplete-Ab12Cd'));
});

test('a project map recorded by the database is required coverage', async (t) => {
  const f = await fixture(t);
  const flow = f.store.workspace(f.ctx).flows[0].id;
  f.stop();
  await rm(path.join(f.dataDir, 'flows', flow, 'MAP.md'));
  await assert.rejects(f.export(), new RegExp(`Missing project map .*flows/${flow}/MAP\\.md`));
  assert.deepEqual(await readdir(f.output), []);
});
