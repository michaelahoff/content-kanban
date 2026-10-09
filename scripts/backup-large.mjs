// Manual bounded-memory acceptance: npm run test:backup-large.
// Requires about 7 GiB of free temporary space; nothing touches real app data.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openStore } from '../store.js';
import { createBackup, restoreBackup } from '../backup.js';

const size = 2 * 1024 ** 3 + 65537;
const chunk = Buffer.alloc(64 * 1024);
for (let index = 0; index < chunk.length; index++) chunk[index] = (index * 7) % 253;
async function* original() {
  let remaining = size;
  while (remaining) { const bytes = chunk.subarray(0, Math.min(remaining, chunk.length)); remaining -= bytes.length; yield bytes; }
}
const fileHash = async (filename) => { const hash = createHash('sha256'); for await (const bytes of createReadStream(filename, { highWaterMark: 64 * 1024 })) hash.update(bytes); return hash.digest('hex'); };
const root = await mkdtemp(path.join(tmpdir(), 'frameboard-backup-large-'));
const dataDir = path.join(root, 'data');
let store;
try {
  await mkdir(dataDir);
  store = await openStore({ dataDir });
  const ctx = { ...store.owner, actor: 'system:large-backup-acceptance' };
  const version = await store.retained.publish(ctx, { operationId: 'large', projectId: store.workspace(ctx).projects[0].id, kind: 'asset', filename: 'video.unrecognized' }, original());
  store.close(); store = null;
  const { backupDir } = await createBackup({ dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'native') });
  assert.equal(await fileHash(path.join(backupDir, 'retained', 'versions', version.id)), version.hash);
  await rm(dataDir, { recursive: true });
  const restored = path.join(root, 'restored');
  await restoreBackup({ backupDir, dataDir: restored, codexHome: path.join(root, 'native') });
  await rm(backupDir, { recursive: true });
  assert.equal(await fileHash(path.join(restored, 'retained', 'versions', version.id)), version.hash);
  assert.ok(process.resourceUsage().maxRSS < 256 * 1024, 'Peak RSS must remain under 256 MiB for a multi-GiB file.');
  console.log(JSON.stringify({ size, sha256: version.hash, maxRssMiB: process.resourceUsage().maxRSS / 1024, verified: ['export', 'staged-copy verification', 'restore'] }));
} finally { store?.close(); await rm(root, { recursive: true, force: true }); }
