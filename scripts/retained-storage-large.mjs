// Manual bounded-memory acceptance: npm run test:retained-large.
// Requires about 7 GiB of free space; nothing is written into app data.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openStore } from '../store.js';

const size = 2 * 1024 ** 3 + 65537;
const chunk = Buffer.alloc(64 * 1024);
for (let index = 0; index < chunk.length; index++) chunk[index] = index % 251;
async function* original() {
  let remaining = size;
  while (remaining) { const bytes = chunk.subarray(0, Math.min(remaining, chunk.length)); remaining -= bytes.length; yield bytes; }
}
const expected = createHash('sha256'); for await (const bytes of original()) expected.update(bytes);
const hash = expected.digest('hex');
const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-large-'));
let store;
try {
  store = await openStore({ dataDir });
  const ctx = { ...store.owner, actor: 'system:large-file-acceptance' };
  const projectId = store.workspace(ctx).projects[0].id;
  const descriptor = { operationId: 'large', projectId, kind: 'asset', filename: 'opaque.unrecognized' };
  const version = await store.retained.publish(ctx, descriptor, original());
  assert.equal(version.hash, hash); assert.equal(version.size, size);
  const workspace = path.join(dataDir, 'workspaces', 'large'); await mkdir(workspace, { recursive: true });
  await store.retained.materialize(ctx, version.id, workspace, 'references/original');
  const copied = await store.retained.copy(ctx, version.id, { ...descriptor, operationId: 'copy' });
  assert.equal(copied.hash, hash); assert.equal(copied.size, size); assert.notEqual(copied.id, version.id);
  // Remove the reproducible reference before repair to keep disk use bounded.
  await rm(path.join(workspace, 'references', 'original'));
  await rm(path.join(dataDir, 'retained', 'versions', version.id));
  const repaired = await store.retained.repair(ctx, version.id, original());
  assert.equal(repaired.id, version.id); assert.equal(repaired.hash, hash);
  store.close(); store = await openStore({ dataDir });
  const readHash = createHash('sha256'); let readSize = 0;
  for await (const bytes of await store.retained.read(ctx, version.id)) { readHash.update(bytes); readSize += bytes.length; }
  assert.equal(readHash.digest('hex'), hash); assert.equal(readSize, size);
  assert.ok(process.resourceUsage().maxRSS < 256 * 1024, 'Peak RSS must remain under 256 MiB for a multi-GiB file.');
  console.log(JSON.stringify({ size, sha256: hash, maxRssMiB: process.resourceUsage().maxRSS / 1024,
    verified: ['import', 'materialize', 'independent-copy', 'repair', 'restart', 'read'] }));
} finally { store?.close(); await rm(dataDir, { recursive: true, force: true }); }
