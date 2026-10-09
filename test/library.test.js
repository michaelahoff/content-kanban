import test from 'node:test';
import assert from 'node:assert/strict';
import { availableFilename, libraryFilename, previewType } from '../public/library-format.js';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { openStore } from '../store.js';
import { fixture as chatFixture, waitFor } from './support/chat-fixture.js';
import http from 'node:http';
import { createApp } from '../server.js';
import { createBackup, restoreBackup } from '../backup.js';
import { ControlledCodex } from './support/controlled-codex.js';

test('Create new picks the first free numeric suffix before the extension', () => {
  assert.equal(availableFilename('logo.png', []), 'logo.png');
  assert.equal(availableFilename('logo.png', ['logo.png']), 'logo (1).png');
  assert.equal(availableFilename('logo.png', ['logo.png', 'logo (1).png', 'logo (3).png']), 'logo (2).png');
  assert.equal(availableFilename('archive.tar.gz', ['archive.tar.gz']), 'archive.tar (1).gz');
  assert.equal(availableFilename('README', ['README']), 'README (1)');
  assert.equal(availableFilename('.env', ['.env']), '.env (1)');
});

test('library filenames are labels, never paths', () => {
  assert.equal(libraryFilename('  Episode 12 — script.md '), 'Episode 12 — script.md');
  assert.equal(libraryFilename('café.txt'), 'café.txt');
  for (const bad of ['', '   ', '.', '..', 'a/b.png', '../x', 'a\\b', 'nul\0.bin', 'tab\there', 'x'.repeat(256), 42, null]) {
    assert.throws(() => libraryFilename(bad), (error) => error.status === 400, String(bad));
  }
});

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-library-'));
  let store = await openStore({ dataDir });
  const ctx = { ...store.owner, actor: `user:${store.owner.userId}` };
  const projectId = store.workspace(ctx).projects[0].id;
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, ctx, projectId,
    get store() { return store; },
    get library() { return store.library; },
    upload(filename, bytes, options = {}) { return store.library.upload(ctx, options.projectId ?? projectId, { filename, operationId: options.operationId ?? randomUUID(), ...options }, bytes); },
    async restart() { store.close(); store = await openStore({ dataDir }); },
  };
}
const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('an uploaded file gets a stable asset identity whose exact bytes read back after restart', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from('# Episode 12\r\nHook: \0 opaque');
  const { outcome, asset, version } = await f.upload('youtube-script.md', bytes);
  assert.equal(outcome, 'created');
  assert.equal(asset.filename, 'youtube-script.md');
  assert.equal(version.size, bytes.length); assert.equal(version.hash, sha(bytes));
  await f.restart();
  const [listed] = f.library.list(f.ctx, f.projectId).assets;
  assert.equal(listed.id, asset.id); assert.equal(listed.filename, 'youtube-script.md');
  assert.deepEqual(listed.current, { id: version.id, size: bytes.length, hash: sha(bytes), available: true, error: '', committedAt: version.committedAt, number: 1 });
  assert.deepEqual(await collect((await f.library.read(f.ctx, f.projectId, version.id)).stream), bytes);
});

test('a same-name upload needs an explicit choice: Create new suffixes, Replace versions, equal bytes never merge', async (t) => {
  const f = await fixture(t);
  const logo = Buffer.from([137, 80, 78, 71, 1]);
  const first = await f.upload('logo.png', logo);
  await assert.rejects(f.upload('logo.png', logo), (error) => error.status === 409
    && assert.deepEqual(error.conflict, { assetId: first.asset.id, filename: 'logo.png', suggested: 'logo (1).png' }) === undefined);
  assert.equal(f.library.list(f.ctx, f.projectId).assets.length, 1, 'a refused upload stores nothing');

  const copy = await f.upload('logo.png', logo, { collision: 'create' });
  assert.equal(copy.outcome, 'created'); assert.equal(copy.asset.filename, 'logo (1).png');
  assert.notEqual(copy.asset.id, first.asset.id, 'equal bytes stay separate identities');
  const sameBytes = await f.upload('brand.png', logo);
  assert.notEqual(sameBytes.asset.id, first.asset.id);

  const replaced = await f.upload('logo.png', Buffer.from('new logo'), { collision: 'replace', assetId: first.asset.id });
  assert.equal(replaced.outcome, 'replaced'); assert.equal(replaced.asset.id, first.asset.id);
  assert.equal(replaced.version.number, 2); assert.equal(replaced.asset.versionCount, 2);
  const details = f.library.asset(f.ctx, f.projectId, first.asset.id);
  assert.deepEqual(details.versions.map((version) => [version.number, version.id, version.current]), [[2, replaced.version.id, true], [1, first.version.id, false]]);
  assert.deepEqual(await collect((await f.library.read(f.ctx, f.projectId, first.version.id)).stream), logo, 'the earlier version is retained');
  assert.deepEqual(f.library.list(f.ctx, f.projectId).assets.map((asset) => asset.filename), ['brand.png', 'logo (1).png', 'logo.png']);

  // Replace names the asset holding that name, never another one.
  await assert.rejects(f.upload('logo.png', logo, { collision: 'replace', assetId: copy.asset.id }), (error) => error.status === 409 && error.conflict.assetId === first.asset.id);
  await assert.rejects(f.upload('fresh.png', logo, { collision: 'replace', assetId: first.asset.id }), (error) => error.status === 409);
  await assert.rejects(f.upload('logo.png', logo, { collision: 'merge' }), (error) => error.status === 400);
});

test('a failed upload stores nothing selectable, keeps current content and retries the same operation without duplicates', async (t) => {
  const f = await fixture(t);
  const broken = () => Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('upload disconnected'); })());
  const first = await f.upload('notes.txt', Buffer.from('v1'));

  await assert.rejects(f.upload('notes.txt', broken(), { collision: 'replace', assetId: first.asset.id, operationId: 'replace-1' }), /disconnected/);
  assert.equal(f.library.asset(f.ctx, f.projectId, first.asset.id).current.id, first.version.id, 'failed replacement keeps v1 current');
  assert.equal(f.library.asset(f.ctx, f.projectId, first.asset.id).versions.length, 1);
  await assert.rejects(f.upload('notes.txt', broken(), { collision: 'create', operationId: 'copy-1' }), /disconnected/);
  await assert.rejects(f.upload('other.bin', broken(), { operationId: 'other-1' }), /disconnected/);
  assert.deepEqual(f.library.list(f.ctx, f.projectId).assets.map((asset) => asset.filename), ['notes.txt']);

  // Another upload takes the suffix the failed Create new chose; its retry keeps its own choice.
  await f.upload('notes (1).txt', Buffer.from('unrelated'));
  await f.restart();
  const replaced = await f.upload('notes.txt', Buffer.from('v2'), { collision: 'replace', assetId: first.asset.id, operationId: 'replace-1' });
  assert.equal(replaced.outcome, 'replaced'); assert.equal(replaced.version.number, 2);
  await assert.rejects(f.upload('notes.txt', Buffer.from('copy'), { collision: 'create', operationId: 'copy-1' }), (error) => error.status === 409 && /upload/i.test(error.message));
  const other = await f.upload('other.bin', Buffer.from('other'), { operationId: 'other-1' });

  // Retrying a saved operation reports it again without reading new bytes.
  const again = await f.upload('notes.txt', broken(), { collision: 'replace', assetId: first.asset.id, operationId: 'replace-1' });
  assert.deepEqual([again.outcome, again.version.id], ['replaced', replaced.version.id]);
  assert.equal((await f.upload('other.bin', broken(), { operationId: 'other-1' })).version.id, other.version.id);
  await assert.rejects(f.upload('renamed.bin', Buffer.from('other'), { operationId: 'other-1' }), (error) => error.status === 409);
  assert.deepEqual(f.library.list(f.ctx, f.projectId).assets.map((asset) => [asset.filename, asset.versionCount]), [['notes (1).txt', 1], ['notes.txt', 2], ['other.bin', 1]]);
});

test('damaged originals become unavailable without substitution, and only exact bytes repair the same version', async (t) => {
  const f = await fixture(t);
  const original = Buffer.from('original script bytes');
  const first = await f.upload('script.md', original);
  const second = await f.upload('script.md', Buffer.from('current script'), { collision: 'replace', assetId: first.asset.id });
  const payload = path.join(f.dataDir, 'retained', 'versions', first.version.id);
  await chmod(payload, 0o600); await writeFile(payload, 'tampered bytes!!');

  await assert.rejects(f.library.read(f.ctx, f.projectId, first.version.id), (error) => error.status === 409 && /unavailable/.test(error.message));
  const damaged = f.library.asset(f.ctx, f.projectId, first.asset.id);
  assert.equal(damaged.versions.find((version) => version.id === first.version.id).available, false);
  assert.match(damaged.versions.find((version) => version.id === first.version.id).error, /hash\/size/);
  assert.equal(damaged.current.id, second.version.id, 'other versions stay usable');
  assert.deepEqual(await collect((await f.library.read(f.ctx, f.projectId, second.version.id)).stream), Buffer.from('current script'));

  await assert.rejects(f.library.repair(f.ctx, f.projectId, first.version.id, Buffer.from('current script')), (error) => error.status === 409 && /exactly/.test(error.message));
  assert.equal((await f.library.verify(f.ctx, f.projectId, first.version.id).catch((error) => error)).status, 409);
  const repaired = await f.library.repair(f.ctx, f.projectId, first.version.id, Readable.from([original]));
  assert.deepEqual([repaired.id, repaired.available, repaired.number], [first.version.id, true, 1]);
  assert.equal((await f.library.verify(f.ctx, f.projectId, first.version.id)).available, true);
  assert.deepEqual(await collect((await f.library.read(f.ctx, f.projectId, first.version.id)).stream), original);
  assert.equal(f.library.asset(f.ctx, f.projectId, first.asset.id).current.id, second.version.id, 'repair never changes the current version');
});

test('versions belong to their project, and an archived project stays readable but refuses uploads and repairs, even mid-upload', async (t) => {
  const f = await fixture(t);
  const { project: other } = f.store.createProject(f.ctx, { name: 'Other' });
  const kept = await f.upload('brief.md', Buffer.from('# Brief'));
  for (const attempt of [
    () => f.library.read(f.ctx, other.id, kept.version.id),
    () => f.library.repair(f.ctx, other.id, kept.version.id, Buffer.from('# Brief')),
    async () => f.library.asset(f.ctx, other.id, kept.asset.id),
    () => f.upload('brief.md', Buffer.from('x'), { projectId: other.id, collision: 'replace', assetId: kept.asset.id }),
  ]) await assert.rejects(attempt(), (error) => [404, 409].includes(error.status));
  assert.deepEqual(f.library.list(f.ctx, other.id).assets, []);

  let release;
  const slow = Readable.from((async function* () { yield Buffer.from('first half '); await new Promise((resolve) => { release = resolve; }); yield Buffer.from('second half'); })());
  const pending = f.upload('late.bin', slow);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  f.store.archiveProject(f.ctx, f.projectId);
  release();
  await assert.rejects(pending, (error) => error.status === 409 && /archived/i.test(error.message));

  assert.deepEqual(f.library.list(f.ctx, f.projectId).assets.map((asset) => asset.filename), ['brief.md']);
  assert.deepEqual(await collect((await f.library.read(f.ctx, f.projectId, kept.version.id)).stream), Buffer.from('# Brief'));
  await assert.rejects(f.upload('new.md', Buffer.from('x')), (error) => error.status === 409 && /archived/i.test(error.message));
  await assert.rejects(f.library.repair(f.ctx, f.projectId, kept.version.id, Buffer.from('# Brief')), (error) => error.status === 409 && /archived/i.test(error.message));
  f.store.unarchiveProject(f.ctx, f.projectId);
  assert.deepEqual(f.library.list(f.ctx, f.projectId).assets.map((asset) => asset.filename), ['brief.md'], 'the interrupted upload never became selectable');
});

async function httpFixture(t, options) {
  const f = await chatFixture(t, options);
  const projectId = (await f.ok('GET', '/api/workspace')).projects[0].id;
  const library = `/api/projects/${projectId}/library`;
  const upload = async (filename, bytes, query = {}) => {
    const params = new URLSearchParams({ filename, operation: query.operation ?? randomUUID(), ...query });
    const response = await f.raw(`${library}/uploads?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, duplex: 'half' });
    return { status: response.status, body: await response.json() };
  };
  return { ...f, projectId, library, upload };
}

test('uploads stream over HTTP with only a filename, operation and collision choice; downloads return the exact bytes', async (t) => {
  const f = await httpFixture(t);
  const bytes = Buffer.from([0, 255, 1, 254, 10, 13]);
  const created = await f.upload('weird name (final) — v2.bin', bytes);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { asset, version } = created.body;
  assert.deepEqual((await f.ok('GET', f.library)).assets.map((entry) => [entry.id, entry.filename, entry.current.hash]), [[asset.id, 'weird name (final) — v2.bin', sha(bytes)]]);

  const download = await f.raw(`${f.library}/versions/${version.id}/content`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal(download.headers.get('content-length'), String(bytes.length));
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="weird name \(final\) _ v2.bin"; filename\*=UTF-8''weird%20name%20%28final%29%20%E2%80%94%20v2.bin$/);
  assert.match(download.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await f.ok('GET', `${f.library}/assets/${asset.id}`)).versions[0].id, version.id);

  const conflict = await f.upload('weird name (final) — v2.bin', Buffer.from('again'));
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body.conflict, { assetId: asset.id, filename: 'weird name (final) — v2.bin', suggested: 'weird name (final) — v2 (1).bin' });
  const copy = await f.upload('weird name (final) — v2.bin', Buffer.from('again'), { collision: 'create' });
  assert.equal(copy.body.asset.filename, 'weird name (final) — v2 (1).bin');
  const replaced = await f.upload('weird name (final) — v2.bin', Buffer.from('v2'), { collision: 'replace', asset: asset.id });
  assert.deepEqual([replaced.status, replaced.body.outcome, replaced.body.version.number], [201, 'replaced', 2]);

  for (const query of [{ hash: sha(bytes) }, { sha256: sha(bytes) }, { path: 'retained/versions/x' }, { versionId: version.id }]) {
    const refused = await f.upload('claimed.bin', bytes, query);
    assert.equal(refused.status, 400, JSON.stringify(query));
    assert.match(refused.body.error, /computes/);
  }
  assert.equal((await f.upload('../escape.bin', bytes)).status, 400);
  assert.equal((await f.upload('ok.bin', bytes, { operation: '' })).status, 400);
  assert.equal((await f.raw(`${f.library}/versions/${randomUUID()}/content`)).status, 404);
  assert.equal((await f.ok('GET', f.library)).assets.length, 2);
});

test('only images and plain text preview inline; other files always download', () => {
  assert.deepEqual(previewType('Logo.PNG'), { kind: 'image', type: 'image/png' });
  assert.deepEqual(previewType('script.md'), { kind: 'text', type: 'text/plain; charset=utf-8' });
  for (const name of ['page.html', 'vector.svg', 'clip.mp4', 'README', '.png', 'archive.zip']) assert.equal(previewType(name), null, name);
});

test('a disconnected upload saves nothing and retries; archived and maintenance states refuse Library changes', async (t) => {
  const f = await httpFixture(t);
  const port = new URL((await f.raw('/api/workspace')).url).port;
  const operation = randomUUID();
  await new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: `${f.library}/uploads?${new URLSearchParams({ filename: 'clip.mp4', operation })}`,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': 1000 } });
    request.on('error', resolve);
    request.write(Buffer.alloc(100, 7), () => setTimeout(() => { request.destroy(); resolve(); }, 50));
  });
  assert.deepEqual((await f.ok('GET', f.library)).assets, []);
  // The interrupted operation is released once the server sees the disconnect.
  const retried = await waitFor(async () => {
    const attempt = await f.upload('clip.mp4', Buffer.alloc(1000, 7), { operation });
    if (attempt.status !== 409) return attempt;
    assert.match(attempt.body.error, /in progress/);
  });
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.equal(retried.body.version.size, 1000);

  const text = await f.upload('script.md', Buffer.from('# Script'));
  const inline = await f.raw(`${f.library}/versions/${text.body.version.id}/content?inline=1`);
  assert.equal(inline.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(inline.headers.get('content-disposition'), /^inline;/);
  const notInline = await f.raw(`${f.library}/versions/${retried.body.version.id}/content?inline=1`);
  assert.equal(notInline.headers.get('content-type'), 'application/octet-stream');
  await notInline.arrayBuffer();

  const output = await mkdtemp(path.join(tmpdir(), 'frameboard-library-export-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await f.ok('POST', '/api/projects/' + f.projectId + '/archive', {});
  const archived = await f.upload('late.bin', Buffer.from('late'));
  assert.equal(archived.status, 409); assert.match(archived.body.error, /archived/i);
  assert.equal((await f.call('POST', `${f.library}/versions/${text.body.version.id}/repair`)).status, 409);
  assert.equal((await f.raw(`${f.library}/versions/${text.body.version.id}/content`)).status, 200, 'archived files stay downloadable');
  await f.ok('POST', '/api/projects/' + f.projectId + '/unarchive', {});

  await f.ok('POST', '/api/maintenance/export', { output });
  const paused = await f.upload('paused.bin', Buffer.from('paused'));
  assert.equal(paused.status, 503);
  await waitFor(async () => !(await f.ok('GET', '/api/maintenance')).active);
  assert.deepEqual((await f.ok('GET', f.library)).assets.map((asset) => asset.filename), ['clip.mp4', 'script.md']);
});

test('complete export and restore carry every Library identity, label, version and exact byte', async (t) => {
  const f = await httpFixture(t);
  const files = [['empty', Buffer.alloc(0)], ['名前 with spaces.tar.gz', Buffer.from([31, 139, 8, 0, 255])], ['logo.png', Buffer.from([137, 80, 78, 71])]];
  for (const [name, bytes] of files) assert.equal((await f.upload(name, bytes)).status, 201);
  const logo = (await f.ok('GET', f.library)).assets.find((asset) => asset.filename === 'logo.png');
  await f.upload('logo.png', Buffer.from('replacement'), { collision: 'replace', asset: logo.id });
  await f.upload('logo.png', Buffer.from([137, 80, 78, 71]), { collision: 'create' });
  const before = (await f.ok('GET', f.library)).assets;
  const details = await Promise.all(before.map((asset) => f.ok('GET', `${f.library}/assets/${asset.id}`)));

  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-library-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await f.close();
  const { backupDir } = await createBackup({ dataDir: f.dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'native') });
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.inventory.retained.filter((entry) => entry.current).map((entry) => [entry.objectId, entry.label]).sort(),
    before.map((asset) => [asset.id, asset.filename]).sort());
  const dataDir = path.join(root, 'restored');
  await restoreBackup({ backupDir, dataDir, codexHome: path.join(root, 'native') });
  const restored = await createApp({ dataDir, codexAdapter: new ControlledCodex(path.join(root, 'native')) });
  await new Promise((resolve) => restored.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => restored.close(resolve)));
  const base = `http://127.0.0.1:${restored.address().port}`;
  assert.deepEqual(await (await fetch(`${base}${f.library}`)).json(), { assets: before });
  for (const asset of details) {
    assert.deepEqual(await (await fetch(`${base}${f.library}/assets/${asset.id}`)).json(), asset);
    for (const version of asset.versions) {
      const bytes = Buffer.from(await (await fetch(`${base}${f.library}/versions/${version.id}/content`)).arrayBuffer());
      assert.deepEqual([bytes.length, sha(bytes)], [version.size, version.hash]);
    }
  }
});

test('backups exported before Library labels were inventoried still restore', async (t) => {
  const f = await httpFixture(t);
  await f.upload('script.md', Buffer.from('# Script'));
  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-library-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await f.close();
  const { backupDir } = await createBackup({ dataDir: f.dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'native') });
  const manifestFile = path.join(backupDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.inventory.retained = manifest.inventory.retained.map(({ label, ...entry }) => entry);
  await writeFile(manifestFile, JSON.stringify(manifest));
  await restoreBackup({ backupDir, dataDir: path.join(root, 'restored'), codexHome: path.join(root, 'native') });
  manifest.inventory.retained[0].filename = 'renamed.md';
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(restoreBackup({ backupDir, dataDir: path.join(root, 'tampered'), codexHome: path.join(root, 'native') }), /inventory does not match/);
});

test('over HTTP, a damaged version reports unavailable, downloads nothing and repairs only with its exact bytes', async (t) => {
  const f = await httpFixture(t);
  const bytes = Buffer.from('exact original');
  const { body: { asset, version } } = await f.upload('take.wav', bytes);
  const payload = path.join(f.dataDir, 'retained', 'versions', version.id);
  await chmod(payload, 0o600); await writeFile(payload, 'exact 0riginal');
  const refused = await f.raw(`${f.library}/versions/${version.id}/content`);
  assert.equal(refused.status, 409); assert.match((await refused.json()).error, /unavailable/);
  assert.equal((await f.call('POST', `${f.library}/versions/${version.id}/verify`)).status, 409);
  assert.equal((await f.ok('GET', f.library)).assets[0].current.available, false);
  const repair = (body) => f.raw(`${f.library}/versions/${version.id}/repair`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
  const wrong = await repair(Buffer.from('another file'));
  assert.equal(wrong.status, 409); assert.match((await wrong.json()).error, /exactly/);
  const fixed = await repair(bytes);
  assert.equal(fixed.status, 200);
  assert.deepEqual(await fixed.json(), { ...version, available: true });
  assert.equal((await f.ok('POST', `${f.library}/versions/${version.id}/verify`)).available, true);
  assert.deepEqual(Buffer.from(await (await f.raw(`${f.library}/versions/${version.id}/content`)).arrayBuffer()), bytes);
  assert.equal((await f.ok('GET', `${f.library}/assets/${asset.id}`)).versions.length, 1);
});
