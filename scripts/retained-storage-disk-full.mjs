// Linux acceptance on an isolated 16 MiB tmpfs, never the shared host disk.
// Run with: npm run test:retained-disk-full (requires unprivileged user namespaces).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.js';

const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-disk-full-'));
let store; let mounted = false;
try {
  execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=16m,nosuid,nodev', 'tmpfs', dataDir]); mounted = true;
  store = await openStore({ dataDir });
  const ctx = { ...store.owner, actor: 'system:disk-full-acceptance' };
  const descriptor = { operationId: 'initial', projectId: store.workspace(ctx).projects[0].id, kind: 'asset', filename: 'opaque.bin' };
  const initial = await store.retained.publish(ctx, descriptor, Buffer.from('abc'));
  async function* tooLarge() { const chunk = Buffer.alloc(64 * 1024, 127); for (let index = 0; index < 512; index++) yield chunk; }
  const replacement = { ...descriptor, operationId: 'replacement', objectId: initial.objectId };
  await assert.rejects(store.retained.publish(ctx, replacement, tooLarge()), (error) => error.code === 'ENOSPC');
  assert.equal(store.retained.current(ctx, initial.objectId).id, initial.id);
  assert.deepEqual(await readdir(path.join(dataDir, 'retained', 'staging')), []);
  assert.equal(store.retained.inventory(ctx).find((v) => v.operationId === 'replacement').state, 'failed');
  const retry = await store.retained.publish(ctx, replacement, Buffer.from('new'));
  assert.equal(store.retained.current(ctx, initial.objectId).id, retry.id);
  store.close(); store = await openStore({ dataDir });
  const chunks = []; for await (const chunk of await store.retained.read(ctx, initial.id)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from('abc'));
  console.log(JSON.stringify({ filesystem: 'isolated 16 MiB tmpfs', failure: 'ENOSPC', priorVersionPreserved: true, stagingReclaimed: true, retry: 'committed' }));
} finally {
  store?.close();
  if (mounted) execFileSync('umount', [dataDir]);
  await rm(dataDir, { recursive: true, force: true });
}
