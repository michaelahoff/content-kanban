// Linux acceptance: the backup folder is an isolated 16 MiB tmpfs, never the
// shared host disk. Run with: npm run test:backup-disk-full.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.js';
import { createBackup } from '../backup.js';

const root = await mkdtemp(path.join(tmpdir(), 'frameboard-backup-disk-full-'));
const dataDir = path.join(root, 'data'); const output = path.join(root, 'backups');
let store; let mounted = false;
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
  console.log(JSON.stringify({ filesystem: 'isolated 16 MiB tmpfs backup folder', failure: 'ENOSPC', retainedBytes: big.size, previousBackupPreserved: true, stagingReclaimed: true, retry: 'published' }));
} finally {
  store?.close();
  if (mounted) execFileSync('umount', [output]);
  await rm(root, { recursive: true, force: true });
}
