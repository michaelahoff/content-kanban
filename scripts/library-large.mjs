// Manual bounded-memory acceptance: npm run test:library-large.
// Streams a multi-GiB Matroska video through the Library's HTTP upload and
// download, a Codex Send that delivers it (with an authored document and a
// small file of unusual opaque bytes) as independent workspace copies, a
// complete export and restore, and a Send after restore that rebuilds the
// deleted copies. Requires about 11 GiB free.
// The Codex boundary is the test peer: no native harness or account is used.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createApp } from '../server.js';
import { createBackup, restoreBackup } from '../backup.js';
import { ControlledCodex } from '../test/support/controlled-codex.js';

const size = 2 * 1024 ** 3 + 65537;
const chunk = Buffer.alloc(64 * 1024);
for (let index = 0; index < chunk.length; index++) chunk[index] = (index * 7) % 253;
// The Matroska (EBML) signature makes it a video by its bytes, not its name.
const matroska = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
async function* original() {
  yield matroska;
  let remaining = size - matroska.length;
  while (remaining) { const bytes = chunk.subarray(0, Math.min(remaining, chunk.length)); remaining -= bytes.length; yield bytes; }
}
const expected = createHash('sha256'); for await (const bytes of original()) expected.update(bytes);
const hash = expected.digest('hex');
const filename = 'raw capture — take 3.mkv';
// Every byte value twice: NULs and invalid UTF-8, no recognized format.
const opaque = Buffer.from([...Array(512).keys()].map((index) => index % 256));
const opaqueHash = createHash('sha256').update(opaque).digest('hex');
const root = await mkdtemp(path.join(tmpdir(), 'frameboard-library-large-'));
const codex = new ControlledCodex(path.join(root, 'native'));
const listen = async (dataDir) => { const app = await createApp({ dataDir, codexAdapter: codex }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve)); return app; };
const api = async (app, method, url, body) => {
  const response = await fetch(`http://127.0.0.1:${app.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
};
const fileDigest = async (filename) => {
  const digest = createHash('sha256'); let read = 0;
  for await (const bytes of createReadStream(filename)) { digest.update(bytes); read += bytes.length; }
  return { sha256: digest.digest('hex'), size: read };
};
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
  const drafts = `/api/projects/${project.id}/library/drafts`;
  const draft = await api(app, 'POST', drafts, { filename: 'shot list.md', text: '# Shot list\nOpen on the desk.' });
  const documentAsset = (await api(app, 'POST', `${drafts}/${draft.id}/save`, { revision: draft.revision, operation: randomUUID() })).asset;
  const opaqueUpload = await (await fetch(`http://127.0.0.1:${app.address().port}/api/projects/${project.id}/library/uploads?${new URLSearchParams({ filename: 'palette.lut', operation: randomUUID() })}`,
    { method: 'POST', body: opaque })).json();
  assert.deepEqual([opaqueUpload.version.hash, opaqueUpload.version.size], [opaqueHash, opaque.length]);
  const selected = [{ kind: 'asset', id: uploaded.body.asset.id }, { kind: 'asset', id: documentAsset.id }, { kind: 'asset', id: opaqueUpload.asset.id }];
  // Send verifies every byte, then delivery streams an independent copy.
  const workspace = await api(app, 'GET', '/api/workspace');
  const stageId = workspace.flows.find((flow) => flow.id === project.flowId).stages[0].id;
  const card = await api(app, 'POST', `/api/projects/${project.id}/cards`, { stageId, title: 'Large file card' });
  const { composer } = await api(app, 'GET', `/api/cards/${card.id}/chat`);
  const saved = await api(app, 'PUT', `/api/cards/${card.id}/chat/composer`, { ...composer, prompt: 'Review the capture', model: 'test-model',
    selections: { ...composer.selections, library: selected } });
  const submission = await api(app, 'POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: saved.revision });
  assert.deepEqual(submission.context.library.map((file) => file.method === 'copy' ? [file.method, file.format, file.hash, file.size] : [file.method]),
    [['copy', 'matroska', hash, size], ['text'], ['copy', null, opaqueHash, opaque.length]]);
  while (!codex.sends.length) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await fileDigest(path.join(root, 'data', 'workspaces', card.id, submission.context.library[0].path)), { sha256: hash, size });
  assert.deepEqual(await fileDigest(path.join(root, 'data', 'workspaces', card.id, submission.context.library[2].path)), { sha256: opaqueHash, size: opaque.length });
  assert.ok(codex.sends[0].input[0].text.includes('Open on the desk.'), 'the authored document is sent in full');
  codex.finish(codex.sends[0]);
  const [copy, , opaqueCopy] = submission.context.library.map((file) => file.path);
  await close(app); app = null;
  const { backupDir } = await createBackup({ dataDir: path.join(root, 'data'), output: path.join(root, 'backups'), codexHome: path.join(root, 'native') });
  await rm(path.join(root, 'data'), { recursive: true, force: true });
  await restoreBackup({ backupDir, dataDir: path.join(root, 'restored'), codexHome: path.join(root, 'native') });
  await rm(backupDir, { recursive: true, force: true });
  app = await listen(path.join(root, 'restored'));
  assert.deepEqual(await download(app, url), { sha256: hash, size });
  // Restored work never resumes. New work in fresh context rebuilds the copy.
  await rm(path.join(root, 'restored', 'workspaces', card.id, copy));
  await rm(path.join(root, 'restored', 'workspaces', card.id, opaqueCopy));
  const fresh = (await api(app, 'POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true })).composer;
  const again = await api(app, 'PUT', `/api/cards/${card.id}/chat/composer`, { ...fresh, prompt: 'Review it again', model: 'test-model', selections: { ...fresh.selections, library: selected } });
  await api(app, 'POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: again.revision });
  while (codex.sends.length < 2) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await fileDigest(path.join(root, 'restored', 'workspaces', card.id, copy)), { sha256: hash, size });
  assert.deepEqual(await fileDigest(path.join(root, 'restored', 'workspaces', card.id, opaqueCopy)), { sha256: opaqueHash, size: opaque.length });
  codex.finish(codex.sends[1]);
  assert.ok(process.resourceUsage().maxRSS < 256 * 1024, 'Peak RSS must remain under 256 MiB for a multi-GiB file.');
  console.log(JSON.stringify({ size, sha256: hash, format: 'matroska', opaque: { size: opaque.length, sha256: opaqueHash }, maxRssMiB: process.resourceUsage().maxRSS / 1024,
    verified: ['http-upload', 'http-download', 'send-materialization', 'export', 'restore', 'restored-download', 'restored-rebuild'] }));
} finally { if (app) await close(app); await rm(root, { recursive: true, force: true }); }
