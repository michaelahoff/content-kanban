import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod, stat, symlink, link, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.js';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-retained-'));
  let store = await openStore({ dataDir, ...options });
  const ctx = { ...store.owner, actor: `user:${store.owner.userId}` };
  const projectId = store.workspace(ctx).projects[0].id;
  const workspace = path.join(dataDir, 'workspaces', 'card'); await mkdir(workspace, { recursive: true });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, ctx, projectId, workspace,
    get retained() { return store.retained; },
    descriptor(operationId, extra = {}) { return { operationId, projectId, kind: 'asset', filename: '../opaque.unknown', ...extra }; },
    async restart() { store.close(); store = await openStore({ dataDir }); },
  };
}
const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };
const payload = (f, id) => path.join(f.dataDir, 'retained', 'versions', id);
const damage = async (filename, bytes) => { await chmod(filename, 0o600); await writeFile(filename, bytes); };

test('opaque bytes and authored documents publish durable independent versions without type restrictions or label paths', async (t) => {
  const f = await fixture(t);
  const version = await f.retained.publish(f.ctx, f.descriptor('first'), Readable.from([Buffer.from('abc')]));
  assert.equal(version.state, 'committed'); assert.equal(version.available, true); assert.equal(version.size, 3);
  assert.equal(version.hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const document = await f.retained.publish(f.ctx, f.descriptor('doc', { kind: 'document', filename: 'voice.md' }), Buffer.from('# Voice\r\n\0'));
  const output = await f.retained.publish(f.ctx, f.descriptor('output', { kind: 'output', provenance: { attemptId: 'attempt', method: 'rendered' } }), Buffer.from([0, 255, 127]));
  await f.restart();
  assert.equal(f.retained.current(f.ctx, version.objectId).id, version.id);
  assert.deepEqual(await collect(await f.retained.read(f.ctx, version.id)), Buffer.from('abc'));
  assert.deepEqual(await collect(await f.retained.read(f.ctx, document.id)), Buffer.from('# Voice\r\n\0'));
  assert.deepEqual(await collect(await f.retained.read(f.ctx, output.id)), Buffer.from([0, 255, 127]));
  assert.deepEqual(f.retained.version(f.ctx, output.id).provenance, { attemptId: 'attempt', method: 'rendered' });
  assert.deepEqual((await readdir(path.join(f.dataDir, 'retained', 'versions'))).sort(), [version.id, document.id, output.id].sort());
});

test('disconnect and abort preserve the current version; batches retry only failed siblings', async (t) => {
  const f = await fixture(t);
  const initial = await f.retained.publish(f.ctx, f.descriptor('initial'), Buffer.from('abc'));
  const broken = () => Readable.from((async function* () { yield Buffer.from('part'); throw new Error('upload disconnected'); })());
  const descriptor = f.descriptor('replace', { objectId: initial.objectId });
  await assert.rejects(f.retained.publish(f.ctx, descriptor, broken()), /disconnected/);
  assert.equal(f.retained.current(f.ctx, initial.objectId).id, initial.id);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.retained.publish(f.ctx, f.descriptor('aborted', { objectId: initial.objectId }), Buffer.from('no'), { signal: controller.signal }), /aborted/);
  assert.equal(f.retained.current(f.ctx, initial.objectId).id, initial.id);
  const batch = await f.retained.publishBatch(f.ctx, [
    { descriptor: f.descriptor('good'), source: Buffer.from('kept') },
    { descriptor, source: broken() },
  ]);
  assert.equal(batch[0].version.state, 'committed'); assert.match(batch[1].error, /disconnected/);
  const retry = await f.retained.publishBatch(f.ctx, [
    { descriptor: f.descriptor('good'), source: broken() },
    { descriptor, source: Buffer.from('replacement') },
  ]);
  assert.equal(retry[0].version.id, batch[0].version.id);
  assert.equal(f.retained.current(f.ctx, initial.objectId).id, retry[1].version.id);
  assert.deepEqual(await collect(await f.retained.read(f.ctx, initial.id)), Buffer.from('abc'));
  assert.equal(f.retained.inventory(f.ctx).filter((v) => v.operationId === 'good').length, 1);
});

test('tampered originals affect only their version; exact-byte repair preserves history and rejects wrong bytes', async (t) => {
  const f = await fixture(t);
  const old = await f.retained.publish(f.ctx, f.descriptor('old'), Buffer.from('abc'));
  const current = await f.retained.publish(f.ctx, f.descriptor('new', { objectId: old.objectId }), Buffer.from('new'));
  await damage(payload(f, old.id), Buffer.from('bad'));
  await assert.rejects(f.retained.read(f.ctx, old.id), /unavailable/);
  assert.equal(f.retained.version(f.ctx, old.id).available, false);
  assert.deepEqual(await collect(await f.retained.read(f.ctx, current.id)), Buffer.from('new'));
  await assert.rejects(f.retained.repair(f.ctx, old.id, Buffer.from('wrong')), /match.*hash and size/);
  const repaired = await f.retained.repair(f.ctx, old.id, Buffer.from('abc'));
  assert.equal(repaired.id, old.id); assert.equal(repaired.objectId, old.objectId); assert.equal(repaired.hash, old.hash);
  assert.equal(f.retained.current(f.ctx, old.objectId).id, current.id);
  await f.retained.remove(f.ctx, old.objectId);
  await rm(payload(f, current.id));
  await assert.rejects(f.retained.read(f.ctx, current.id), /unavailable/);
  await f.restart();
  assert.equal(f.retained.current(f.ctx, old.objectId), null);
  assert.equal(f.retained.inventory(f.ctx).filter((v) => v.state === 'committed').length, 2);
  assert.deepEqual(await collect(await f.retained.read(f.ctx, old.id)), Buffer.from('abc'));
  assert.equal((await f.retained.repair(f.ctx, current.id, Buffer.from('new'))).id, current.id);
});

test('reference materialization always rebuilds an independent copy of the frozen version and refuses authority/link escapes', async (t) => {
  const f = await fixture(t);
  const original = await f.retained.publish(f.ctx, f.descriptor('original'), Buffer.from('abc'));
  const newer = await f.retained.publish(f.ctx, f.descriptor('newer', { objectId: original.objectId }), Buffer.from('new'));
  const reference = await f.retained.materialize(f.ctx, original.id, f.workspace, 'references/file');
  assert.notEqual((await stat(reference.path)).ino, (await stat(payload(f, original.id))).ino);
  assert.equal((await stat(reference.path)).nlink, 1);
  await damage(reference.path, Buffer.from('mutable workspace'));
  await f.retained.materialize(f.ctx, original.id, f.workspace, 'references/file');
  assert.deepEqual(await readFile(reference.path), Buffer.from('abc'));
  assert.deepEqual(await collect(await f.retained.read(f.ctx, newer.id)), Buffer.from('new'));
  for (const root of [f.dataDir, path.join(f.dataDir, 'retained', 'versions')])
    await assert.rejects(f.retained.materialize(f.ctx, original.id, root, 'frameboard.db'), /authoritative/);
  await assert.rejects(f.retained.materialize(f.ctx, original.id, f.workspace, '../escape'), /relative/);
  await symlink(path.join(f.dataDir, 'retained', 'versions'), path.join(f.workspace, 'escape'));
  await assert.rejects(f.retained.materialize(f.ctx, original.id, f.workspace, 'escape/overwrite'), /links/);
  const copied = await f.retained.copy(f.ctx, original.id, f.descriptor('copy'));
  assert.notEqual(copied.objectId, original.objectId); assert.notEqual(copied.id, original.id);
  assert.notEqual((await stat(payload(f, copied.id))).ino, (await stat(payload(f, original.id))).ino);
  await f.retained.remove(f.ctx, original.objectId); await rm(payload(f, original.id)); await f.restart();
  assert.deepEqual(await collect(await f.retained.read(f.ctx, copied.id)), Buffer.from('abc'));
});

test('hash-preserving hardlinks and symbolic originals are unavailable; foreign identities and changed operation metadata are rejected', async (t) => {
  const f = await fixture(t);
  const original = await f.retained.publish(f.ctx, f.descriptor('original'), Buffer.from('abc'));
  await link(payload(f, original.id), path.join(f.workspace, 'linked'));
  await assert.rejects(f.retained.read(f.ctx, original.id), /independent/);
  await rm(path.join(f.workspace, 'linked')); await rm(payload(f, original.id));
  await writeFile(path.join(f.workspace, 'outside'), 'abc'); await symlink(path.join(f.workspace, 'outside'), payload(f, original.id));
  await assert.rejects(f.retained.read(f.ctx, original.id), /unavailable/);
  await f.retained.repair(f.ctx, original.id, Buffer.from('abc'));
  assert.deepEqual(await readFile(path.join(f.workspace, 'outside')), Buffer.from('abc'));
  await assert.rejects(f.retained.publish(f.ctx, f.descriptor('original', { filename: 'changed' }), Buffer.from('abc')), /different metadata/);
  const foreign = { ...f.ctx, workspaceId: 'foreign' };
  await assert.rejects(f.retained.read(foreign, original.id), /does not exist/);
  assert.equal(f.retained.version(foreign, original.id), undefined);
  assert.deepEqual(f.retained.inventory(foreign), []);
});

test('replacement publication retains its own filename and retry identity even when the source label differs', async (t) => {
  const f = await fixture(t);
  const original = await f.retained.publish(f.ctx, f.descriptor('original', { filename: 'first.bin' }), Buffer.from('abc'));
  const descriptor = f.descriptor('replacement', { objectId: original.objectId, filename: 'second.bin' });
  const replaced = await f.retained.publish(f.ctx, descriptor, Buffer.from('new'));
  const retry = await f.retained.publish(f.ctx, descriptor, Buffer.from('ignored'));
  assert.equal(retry.id, replaced.id);
  assert.equal(f.retained.version(f.ctx, original.id).filename, 'first.bin');
  assert.equal(f.retained.version(f.ctx, replaced.id).filename, 'second.bin');
});

test('abrupt process death at every publication boundary keeps only complete committed bytes selectable', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  for (const phase of ['staging', 'writing', 'staged', 'bytes-published', 'published', 'committed']) {
    await t.test(phase, async (t) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-crash-'));
      t.after(() => rm(dataDir, { recursive: true, force: true }));
      await assert.rejects(run(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('./support/retained-crash.js', import.meta.url).pathname, dataDir, phase]), (error) => error.code === 86);
      const store = await openStore({ dataDir }); t.after(() => store.close());
      const ctx = { ...store.owner, actor: 'system:recovery-test' }; const retained = store.retained;
      const inventory = retained.inventory(ctx); const seed = inventory.find((v) => v.operationId === 'seed');
      const replacement = inventory.find((v) => v.operationId === 'replacement');
      const committed = phase === 'committed';
      assert.equal(retained.current(ctx, seed.objectId).id, committed ? replacement.id : seed.id);
      assert.equal(replacement.state, committed ? 'committed' : 'failed');
      assert.deepEqual(await collect(await retained.read(ctx, seed.id)), Buffer.from('abc'));
      assert.deepEqual(await readdir(path.join(dataDir, 'retained', 'staging')), []);
      assert.deepEqual((await readdir(path.join(dataDir, 'retained', 'versions'))).sort(), (committed ? [seed.id, replacement.id] : [seed.id]).sort());
      const descriptor = { operationId: 'replacement', projectId: store.workspace(ctx).projects[0].id, kind: 'asset', filename: 'opaque.bin', objectId: seed.objectId };
      if (replacement.hash && !committed) await assert.rejects(retained.publish(ctx, descriptor, Buffer.from('wrong')), /Retry bytes differ/);
      const retry = await retained.publish(ctx, descriptor, Buffer.from('new'));
      assert.equal(retry.id, replacement.id);
      assert.deepEqual(await collect(await retained.read(ctx, replacement.id)), Buffer.from('new'));
    });
  }
});

test('disk-full failures at the filesystem boundary keep prior content and successful siblings; errors after commit retain success', async (t) => {
  let phase;
  const f = await fixture(t, { retainedCheckpoint: async (boundary) => {
    if (boundary === phase) throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
  } });
  const seed = await f.retained.publish(f.ctx, f.descriptor('seed'), Buffer.from('abc'));
  for (phase of ['writing', 'staged', 'bytes-published', 'published']) {
    await assert.rejects(f.retained.publish(f.ctx, f.descriptor(phase, { objectId: seed.objectId }), Buffer.from('new')), { code: 'ENOSPC' });
    assert.equal(f.retained.current(f.ctx, seed.objectId).id, seed.id);
    assert.deepEqual(await readdir(path.join(f.dataDir, 'retained', 'staging')), []);
  }
  phase = 'committed';
  const saved = await f.retained.publish(f.ctx, f.descriptor('saved'), Buffer.from('kept'));
  assert.equal(saved.state, 'committed');
  assert.deepEqual(await collect(await f.retained.read(f.ctx, saved.id)), Buffer.from('kept'));
});

test('replacing a storage directory with a link cannot redirect publication or recovery outside the retained store', async (t) => {
  const f = await fixture(t);
  const staging = path.join(f.dataDir, 'retained', 'staging');
  await rm(staging, { recursive: true }); await symlink(f.workspace, staging);
  await assert.rejects(f.retained.publish(f.ctx, f.descriptor('redirected'), Buffer.from('abc')), /links|Linked/);
  assert.deepEqual(await readdir(f.workspace), []);
});

test('legacy backup refuses to omit committed retained payloads and preserves the last complete backup', async (t) => {
  const { createBackup } = await import('../backup.js');
  const f = await fixture(t);
  const output = await mkdtemp(path.join(tmpdir(), 'frameboard-retained-backup-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const options = { dataDir: f.dataDir, output, codexHome: path.join(f.dataDir, 'absent-native') };
  const good = await createBackup(options);
  await f.retained.publish(f.ctx, f.descriptor('retained'), Buffer.from('abc'));
  await assert.rejects(createBackup(options), /retained.*export.*not.*available/i);
  assert.deepEqual(await readdir(output), [path.basename(good.backupDir)]);
});

test('retrying a successful independent copy does not read an unavailable source or duplicate the copy', async (t) => {
  const f = await fixture(t);
  const original = await f.retained.publish(f.ctx, f.descriptor('original'), Buffer.from('abc'));
  const descriptor = f.descriptor('copy');
  const copied = await f.retained.copy(f.ctx, original.id, descriptor);
  await rm(payload(f, original.id));
  const retry = await f.retained.copy(f.ctx, original.id, descriptor);
  assert.equal(retry.id, copied.id);
  assert.deepEqual(await collect(await f.retained.read(f.ctx, retry.id)), Buffer.from('abc'));
  assert.equal(f.retained.inventory(f.ctx).filter((v) => v.operationId === 'copy').length, 1);
});

test('a replacement prepared before another commit cannot overwrite the newer current version', async (t) => {
  const f = await fixture(t);
  const initial = await f.retained.publish(f.ctx, f.descriptor('initial'), Buffer.from('abc'));
  let release; let prepared;
  const ready = new Promise((resolve) => { prepared = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const source = (async function* () { yield Buffer.from('slow'); prepared(); await gate; yield Buffer.from(' old edit'); })();
  const pending = f.retained.publish(f.ctx, f.descriptor('slow', { objectId: initial.objectId }), source);
  try {
    await ready;
    assert.equal(f.retained.current(f.ctx, initial.objectId).id, initial.id);
    const staged = f.retained.inventory(f.ctx).find((v) => v.operationId === 'slow');
    await assert.rejects(f.retained.read(f.ctx, staged.id), /not committed/);
    const newer = await f.retained.publish(f.ctx, f.descriptor('newer', { objectId: initial.objectId }), Buffer.from('latest'));
    release();
    await assert.rejects(pending, /changed during publication/);
    assert.equal(f.retained.current(f.ctx, initial.objectId).id, newer.id);
    assert.deepEqual(await collect(await f.retained.read(f.ctx, newer.id)), Buffer.from('latest'));
    assert.deepEqual(await collect(await f.retained.read(f.ctx, initial.id)), Buffer.from('abc'));
  } finally { release(); await pending.catch(() => {}); }
});
