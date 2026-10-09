// Manual bounded-memory acceptance: npm run test:library-large.
// Streams a multi-GiB opaque file through the Library's HTTP upload and
// download, then a complete export and restore. Requires about 7 GiB free.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createApp } from '../server.js';
import { createBackup, restoreBackup } from '../backup.js';

const size = 2 * 1024 ** 3 + 65537;
const chunk = Buffer.alloc(64 * 1024);
for (let index = 0; index < chunk.length; index++) chunk[index] = (index * 7) % 253;
async function* original() {
  let remaining = size;
  while (remaining) { const bytes = chunk.subarray(0, Math.min(remaining, chunk.length)); remaining -= bytes.length; yield bytes; }
}
const expected = createHash('sha256'); for await (const bytes of original()) expected.update(bytes);
const hash = expected.digest('hex');
const filename = 'raw capture — take 3.mkv';
const root = await mkdtemp(path.join(tmpdir(), 'frameboard-library-large-'));
const listen = async (dataDir) => { const app = await createApp({ dataDir }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve)); return app; };
const close = (app) => new Promise((resolve) => app.close(resolve));
async function download(app, url) {
  const response = await fetch(`http://127.0.0.1:${app.address().port}${url}`);
  assert.equal(response.status, 200);
  const digest = createHash('sha256'); let received = 0;
  for await (const bytes of Readable.fromWeb(response.body)) { digest.update(bytes); received += bytes.length; }
  return { sha256: digest.digest('hex'), size: received };
}
let app;
try {
  app = await listen(path.join(root, 'data'));
  const { projects: [project] } = await (await fetch(`http://127.0.0.1:${app.address().port}/api/workspace`)).json();
  const query = new URLSearchParams({ filename, operation: randomUUID() });
  const uploaded = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: app.address().port, method: 'POST', path: `/api/projects/${project.id}/library/uploads?${query}`,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': size } }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (part) => { text += part; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    pipeline(Readable.from(original()), request).catch(reject);
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.deepEqual([uploaded.body.version.hash, uploaded.body.version.size], [hash, size]);
  const url = `/api/projects/${project.id}/library/versions/${uploaded.body.version.id}/content`;
  assert.deepEqual(await download(app, url), { sha256: hash, size });
  await close(app); app = null;
  const { backupDir } = await createBackup({ dataDir: path.join(root, 'data'), output: path.join(root, 'backups'), codexHome: path.join(root, 'native') });
  await rm(path.join(root, 'data'), { recursive: true, force: true });
  await restoreBackup({ backupDir, dataDir: path.join(root, 'restored'), codexHome: path.join(root, 'native') });
  await rm(backupDir, { recursive: true, force: true });
  app = await listen(path.join(root, 'restored'));
  assert.deepEqual(await download(app, url), { sha256: hash, size });
  assert.ok(process.resourceUsage().maxRSS < 256 * 1024, 'Peak RSS must remain under 256 MiB for a multi-GiB file.');
  console.log(JSON.stringify({ size, sha256: hash, maxRssMiB: process.resourceUsage().maxRSS / 1024,
    verified: ['http-upload', 'http-download', 'export', 'restore', 'restored-download'] }));
} finally { if (app) await close(app); await rm(root, { recursive: true, force: true }); }
