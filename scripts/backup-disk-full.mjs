// Linux acceptance: the backup and restore folders are isolated 16 MiB tmpfs
// mounts, never the shared host disk. Run with: npm run test:backup-disk-full.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.js';
import { createBackup, restoreBackup } from '../backup.js';

const root = await mkdtemp(path.join(tmpdir(), 'frameboard-backup-disk-full-'));
const dataDir = path.join(root, 'data'); const output = path.join(root, 'backups'); const restores = path.join(root, 'restores');
let store; let mounted = false; let restoreMounted = false;
try {
  await mkdir(dataDir); await mkdir(output);
  execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=16m,nosuid,nodev', 'tmpfs', output]); mounted = true;
  store = await openStore({ dataDir });
  const ctx = { ...store.owner, actor: 'system:disk-full-acceptance' };
  const descriptor = { projectId: store.workspace(ctx).projects[0].id, kind: 'asset', filename: 'opaque.bin' };
  // 8 MiB already in the last good backup plus 14 MiB more cannot fit in 16 MiB.
  async function* bytes(count, value) { const chunk = Buffer.alloc(64 * 1024, value); for (let index = 0; index < count; index++) yield chunk; }
  await store.retained.publish(ctx, { ...descriptor, operationId: 'first' }, bytes(128, 1));
  store.close(); store = null;
  const good = await createBackup({ dataDir, output, codexHome: path.join(root, 'native') });
  store = await openStore({ dataDir });
  const big = await store.retained.publish(ctx, { ...descriptor, operationId: 'second' }, bytes(96, 2));
  store.close(); store = null;
  await assert.rejects(createBackup({ dataDir, output, codexHome: path.join(root, 'native') }), (error) => error.code === 'ENOSPC' && /Not enough disk space for the backup/.test(error.message));
  assert.deepEqual(await readdir(output), [path.basename(good.backupDir)]);
  // After space is freed, the next export succeeds without manual cleanup.
  await rm(good.backupDir, { recursive: true });
  const next = await createBackup({ dataDir, output, codexHome: path.join(root, 'native') });
  assert.deepEqual(await readdir(output), [path.basename(next.backupDir)]);
  // Restore: 8 MiB of existing data beside a 14 MiB restore cannot fit either.
  await mkdir(restores);
  execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=16m,nosuid,nodev', 'tmpfs', restores]); restoreMounted = true;
  const existing = path.join(restores, 'existing.bin'); await writeFile(existing, Buffer.alloc(8 * 1024 * 1024, 3));
  const restored = path.join(restores, 'restored'); const codexHome = path.join(root, 'native');
  await assert.rejects(restoreBackup({ backupDir: next.backupDir, dataDir: restored, codexHome }), (error) => error.code === 'ENOSPC' && /Not enough disk space to restore the backup. Nothing was activated/.test(error.message));
  assert.deepEqual(await readdir(restores), ['existing.bin']);
  assert.equal((await readFile(existing)).length, 8 * 1024 * 1024);
  await rm(existing);
  await restoreBackup({ backupDir: next.backupDir, dataDir: restored, codexHome });
  assert.equal(createHash('sha256').update(await readFile(path.join(restored, 'retained', 'versions', big.id))).digest('hex'), big.hash);
  console.log(JSON.stringify({ filesystem: 'isolated 16 MiB tmpfs backup and restore folders', failure: 'ENOSPC', retainedBytes: big.size, previousBackupPreserved: true, stagingReclaimed: true, retry: 'published',
    restore: { failure: 'ENOSPC', activated: false, existingDataPreserved: true, retry: 'restored with matching hash' } }));
} finally {
  store?.close();
  if (mounted) execFileSync('umount', [output]);
  if (restoreMounted) execFileSync('umount', [restores]);
  await rm(root, { recursive: true, force: true });
}
