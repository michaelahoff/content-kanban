import test from 'node:test';
import assert from 'node:assert/strict';
import { assetPreview, availableFilename, deliveryDescription, libraryFilename, previewType, libraryPaths, searchLibrary, folderHolders } from '../public/library-format.js';
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

test('delivery descriptions name the route and the recognized format without claiming comprehension', () => {
  assert.equal(deliveryDescription({ method: 'text' }), 'full text inline');
  assert.equal(deliveryDescription({ method: 'image', format: 'png' }), 'native image');
  assert.equal(deliveryDescription({ method: 'copy', format: 'pdf' }), 'PDF · workspace copy for Codex tools');
  assert.equal(deliveryDescription({ method: 'copy', format: 'matroska' }), 'Matroska video · workspace copy for Codex tools');
  assert.equal(deliveryDescription({ method: 'copy', format: 'text' }), 'large text · workspace copy for Codex tools');
  assert.equal(deliveryDescription({ method: 'copy', format: null }), 'workspace copy for Codex tools');
});

test('library filenames are labels, never paths', () => {
  assert.equal(libraryFilename('  Episode 12 — script.md '), 'Episode 12 — script.md');
  assert.equal(libraryFilename('café.txt'), 'café.txt');
  for (const bad of ['', '   ', '.', '..', 'a/b.png', '../x', 'a\\b', 'nul\0.bin', 'tab\there', 'x'.repeat(256), 42, null]) {
    assert.throws(() => libraryFilename(bad), (error) => error.status === 400, String(bad));
  }
});

test('Library paths, search and folder-local name holders, as the browser computes them', () => {
  const listing = {
    folders: [{ id: 'thumbs', name: 'Thumbnails', parentId: null }, { id: 'refs', name: 'References', parentId: 'thumbs' }, { id: 'scripts', name: 'Scripts', parentId: null }],
    assets: [{ id: 'a', filename: 'logo.png', folderId: null }, { id: 'b', filename: 'logo.png', folderId: 'refs' }, { id: 'c', filename: 'Episode.md', folderId: 'scripts' }],
  };
  const paths = libraryPaths(listing);
  assert.deepEqual([paths.folders.get('refs'), paths.assets.get('b'), paths.assets.get('a')], ['Thumbnails/References/', 'Thumbnails/References/logo.png', 'logo.png']);
  // Search matches whole paths, case-insensitively, folders first.
  assert.deepEqual(searchLibrary(listing, 'thumbnails/ref').map((entry) => [entry.kind, entry.id]), [['folder', 'refs'], ['asset', 'b']]);
  assert.deepEqual(searchLibrary(listing, 'LOGO').map((entry) => entry.id), ['a', 'b']);
  assert.deepEqual(searchLibrary(listing, 'episode').map((entry) => entry.path), ['Scripts/Episode.md']);
  assert.deepEqual(folderHolders(listing, 'thumbs'), [{ kind: 'folder', id: 'refs', filename: 'References' }]);
  assert.deepEqual(folderHolders(listing, null).map((entry) => entry.filename), ['Thumbnails', 'Scripts', 'logo.png']);
});

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-library-'));
  // Tests set faults.checkpoint to fail a publication at a chosen stage.
  const faults = { checkpoint: async () => {} };
  const open = () => openStore({ dataDir, retainedCheckpoint: (stage, version) => faults.checkpoint(stage, version) });
  let store = await open(); let closed = false;
  const ctx = { ...store.owner, actor: `user:${store.owner.userId}` };
  const projectId = store.workspace(ctx).projects[0].id;
  t.after(async () => { if (!closed) store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, ctx, projectId, faults,
    get store() { return store; },
    get library() { return store.library; },
    upload(filename, bytes, options = {}) { return store.library.upload(ctx, options.projectId ?? projectId, { filename, operationId: options.operationId ?? randomUUID(), ...options }, bytes); },
    async restart() { store.close(); store = await open(); },
    close() { store.close(); closed = true; },
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
  assert.deepEqual(listed.current, { id: version.id, size: bytes.length, hash: sha(bytes), available: true, error: '', committedAt: version.committedAt, number: 1, written: false });
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
  const listing = await f.ok('GET', f.library); const before = listing.assets;
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
  assert.deepEqual(await (await fetch(`${base}${f.library}`)).json(), listing);
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

test('retrying a saved upload reports that operation’s own version and records nothing new', async (t) => {
  const f = await fixture(t);
  const first = await f.upload('cut.mp4', Buffer.from('v1'));
  const second = await f.upload('cut.mp4', Buffer.from('v2'), { collision: 'replace', assetId: first.asset.id, operationId: 'op-a' });
  await f.upload('cut.mp4', Buffer.from('v3'), { collision: 'replace', assetId: first.asset.id, operationId: 'op-b' });
  const activity = () => f.store.activity(f.ctx, { since: 0, limit: 10000 }).filter((entry) => entry.entity === 'asset').length;
  const before = activity();
  const again = await f.upload('cut.mp4', Buffer.from('ignored'), { collision: 'replace', assetId: first.asset.id, operationId: 'op-a' });
  assert.deepEqual([again.outcome, again.version.id, again.version.number], ['replaced', second.version.id, 2]);
  assert.equal(activity(), before);
});

test('a refused upload still answers with its reason after a large body, and malformed IDs are not found', async (t) => {
  const f = await httpFixture(t);
  await f.upload('big.bin', Buffer.from('first'));
  const refused = await f.upload('big.bin', Buffer.alloc(32 * 1024 * 1024, 1));
  assert.equal(refused.status, 409); assert.equal(refused.body.conflict.suggested, 'big (1).bin');
  assert.equal((await f.raw(`/api/projects/%E0/library/versions/x/content`)).status, 404);
  assert.equal((await f.raw(`${f.library}/versions/%E0%A4%A/content`)).status, 404);
});

test('an archive landing during a repair leaves the version unavailable', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from('exact bytes');
  const { version } = await f.upload('voice.wav', bytes);
  const payload = path.join(f.dataDir, 'retained', 'versions', version.id);
  await chmod(payload, 0o600); await writeFile(payload, 'other bytes');
  await assert.rejects(f.library.verify(f.ctx, f.projectId, version.id));
  let release;
  const slow = Readable.from((async function* () { yield bytes.subarray(0, 5); await new Promise((resolve) => { release = resolve; }); yield bytes.subarray(5); })());
  const pending = f.library.repair(f.ctx, f.projectId, version.id, slow);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  f.store.archiveProject(f.ctx, f.projectId);
  release();
  await assert.rejects(pending, (error) => error.status === 409 && /archived/i.test(error.message));
  f.store.unarchiveProject(f.ctx, f.projectId);
  assert.equal(f.library.asset(f.ctx, f.projectId, version.objectId ?? f.library.list(f.ctx, f.projectId).assets[0].id).current.available, false);
});

const draftsOf = (f) => f.library.list(f.ctx, f.projectId).drafts;
const text = async (f, versionId) => (await collect((await f.library.read(f.ctx, f.projectId, versionId)).stream)).toString('utf8');

test('a written document is a draft until Save, which creates a stable document asset and version', async (t) => {
  const f = await fixture(t);
  const draft = await f.library.createDraft(f.ctx, f.projectId, { filename: 'Hook guide.md' });
  assert.deepEqual([draft.filename, draft.text, draft.revision, draft.assetId, draft.baseVersionId], ['Hook guide.md', '', 1, null, null]);
  const written = f.library.writeDraft(f.ctx, f.projectId, draft.id, { text: '# Hooks\nOpen on the payoff. ✨', revision: 1 });
  assert.equal(written.revision, 2);
  assert.deepEqual(f.library.list(f.ctx, f.projectId).assets, [], 'a draft is not a Library asset');
  assert.deepEqual(f.store.retained.inventory(f.ctx), [], 'nor a retained version');

  const saved = await f.library.saveDraft(f.ctx, f.projectId, draft.id, { revision: 2, operationId: 'save-1' });
  assert.equal(saved.outcome, 'created');
  assert.deepEqual([saved.asset.filename, saved.asset.kind, saved.version.number, saved.draft], ['Hook guide.md', 'document', 1, null]);
  assert.equal(await text(f, saved.version.id), '# Hooks\nOpen on the payoff. ✨');
  assert.deepEqual(draftsOf(f), [], 'a saved draft is finished');
  await f.restart();
  assert.deepEqual(f.library.list(f.ctx, f.projectId).assets.map((asset) => [asset.id, asset.current.id]), [[saved.asset.id, saved.version.id]]);
});

test('editing a saved document drafts against its current version; later saves add versions of the same asset', async (t) => {
  const f = await fixture(t);
  const created = await f.library.createDraft(f.ctx, f.projectId, { filename: 'guide.md', text: 'v1 text' });
  const first = await f.library.saveDraft(f.ctx, f.projectId, created.id, { revision: 1, operationId: 'save-1' });

  const edit = await f.library.createDraft(f.ctx, f.projectId, { assetId: first.asset.id });
  assert.deepEqual([edit.assetId, edit.baseVersionId, edit.filename, edit.text], [first.asset.id, first.version.id, 'guide.md', 'v1 text']);
  assert.equal((await f.library.createDraft(f.ctx, f.projectId, { assetId: first.asset.id })).id, edit.id, 'one draft per asset');
  const written = f.library.writeDraft(f.ctx, f.projectId, edit.id, { text: 'v2 draft', revision: 1 });
  assert.throws(() => f.library.writeDraft(f.ctx, f.projectId, edit.id, { text: 'stale tab', revision: 1 }), (error) => error.status === 409 && error.conflict.draftRevision === 2);
  assert.equal(f.library.draft(f.ctx, f.projectId, edit.id).text, 'v2 draft');
  assert.throws(() => f.library.writeDraft(f.ctx, f.projectId, edit.id, { text: 'x', filename: 'renamed.md', revision: 2 }), (error) => error.status === 400);
  assert.equal(f.library.asset(f.ctx, f.projectId, first.asset.id).current.id, first.version.id, 'draft edits never change current content');
  assert.equal(await text(f, first.version.id), 'v1 text');
  assert.deepEqual(f.library.list(f.ctx, f.projectId).drafts.map((draft) => [draft.id, draft.assetId, draft.length]), [[edit.id, first.asset.id, 8]]);

  await assert.rejects(f.library.saveDraft(f.ctx, f.projectId, edit.id, { revision: 1, operationId: 'save-2' }), (error) => error.status === 409);
  const second = await f.library.saveDraft(f.ctx, f.projectId, edit.id, { revision: written.revision, operationId: 'save-2' });
  assert.deepEqual([second.outcome, second.asset.id, second.version.number, second.draft], ['saved', first.asset.id, 2, null]);
  assert.deepEqual([await text(f, first.version.id), await text(f, second.version.id)], ['v1 text', 'v2 draft']);

  // A draft begun before another save must not silently overwrite it.
  const stale = await f.library.createDraft(f.ctx, f.projectId, { assetId: first.asset.id });
  const other = await f.upload('guide.md', Buffer.from('uploaded v3'), { collision: 'replace', assetId: first.asset.id });
  f.library.writeDraft(f.ctx, f.projectId, stale.id, { text: 'my edit', revision: 1 });
  await assert.rejects(f.library.saveDraft(f.ctx, f.projectId, stale.id, { revision: 2, operationId: 'save-3' }),
    (error) => error.status === 409 && error.conflict.currentVersion.id === other.version.id && /v3/.test(error.message));
  assert.equal(f.library.draft(f.ctx, f.projectId, stale.id).text, 'my edit', 'the draft is kept');
  const forced = await f.library.saveDraft(f.ctx, f.projectId, stale.id, { revision: 2, operationId: 'save-4', baseVersionId: other.version.id });
  assert.deepEqual([forced.version.number, await text(f, forced.version.id)], [4, 'my edit']);

  // Saving unchanged text publishes nothing.
  const same = await f.library.createDraft(f.ctx, f.projectId, { assetId: first.asset.id });
  const unchanged = await f.library.saveDraft(f.ctx, f.projectId, same.id, { revision: 1, operationId: 'save-5' });
  assert.deepEqual([unchanged.outcome, unchanged.version.id, unchanged.draft], ['unchanged', forced.version.id, null]);
  assert.equal(f.library.asset(f.ctx, f.projectId, first.asset.id).versionCount, 4);
  assert.deepEqual(draftsOf(f), []);
});

test('a failed save keeps the prior version current and the draft intact; retrying never duplicates a saved version', async (t) => {
  const f = await fixture(t);
  const draft = await f.library.createDraft(f.ctx, f.projectId, { filename: 'guide.md', text: 'v1' });
  const first = await f.library.saveDraft(f.ctx, f.projectId, draft.id, { revision: 1, operationId: 'save-1' });
  const edit = await f.library.createDraft(f.ctx, f.projectId, { assetId: first.asset.id });
  f.library.writeDraft(f.ctx, f.projectId, edit.id, { text: 'v2', revision: 1 });

  for (const stage of ['writing', 'bytes-published', 'published']) {
    f.faults.checkpoint = async (at) => { if (at === stage) throw new Error(`disk failed while ${stage}`); };
    await assert.rejects(f.library.saveDraft(f.ctx, f.projectId, edit.id, { revision: 2, operationId: 'save-2' }), /disk failed/);
    assert.equal(f.library.asset(f.ctx, f.projectId, first.asset.id).current.id, first.version.id, `${stage}: v1 stays current`);
    assert.equal(f.library.draft(f.ctx, f.projectId, edit.id).text, 'v2', `${stage}: the draft is kept`);
  }
  f.faults.checkpoint = async () => {};
  await f.restart();
  assert.equal(f.library.asset(f.ctx, f.projectId, first.asset.id).versionCount, 1);
  const saved = await f.library.saveDraft(f.ctx, f.projectId, edit.id, { revision: 2, operationId: 'save-2' });
  assert.equal(saved.version.number, 2);
  const again = await f.library.saveDraft(f.ctx, f.projectId, edit.id, { revision: 2, operationId: 'save-2' });
  assert.deepEqual([again.outcome, again.version.id], ['saved', saved.version.id], 'a repeated saved operation reports its own version');
  assert.equal(f.library.asset(f.ctx, f.projectId, first.asset.id).versionCount, 2);
  await assert.rejects(f.library.saveDraft(f.ctx, f.projectId, randomUUID(), { revision: 2, operationId: 'save-2' }), (error) => error.status === 409);
});

test('a first save follows the Library name rules: Create new, Replace or refuse; archive refuses draft changes', async (t) => {
  const f = await fixture(t);
  const held = await f.upload('brief.md', Buffer.from('uploaded'));
  const draft = await f.library.createDraft(f.ctx, f.projectId, { filename: 'brief.md', text: 'written' });
  await assert.rejects(f.library.saveDraft(f.ctx, f.projectId, draft.id, { revision: 1, operationId: 'save-1' }),
    (error) => error.status === 409 && error.conflict.suggested === 'brief (1).md');
  assert.equal(f.library.draft(f.ctx, f.projectId, draft.id).text, 'written');
  const copy = await f.library.saveDraft(f.ctx, f.projectId, draft.id, { revision: 1, operationId: 'save-2', collision: 'create' });
  assert.deepEqual([copy.outcome, copy.asset.filename, copy.asset.kind], ['created', 'brief (1).md', 'document']);

  const replacing = await f.library.createDraft(f.ctx, f.projectId, { filename: 'brief.md', text: 'written over' });
  const replaced = await f.library.saveDraft(f.ctx, f.projectId, replacing.id, { revision: 1, operationId: 'save-3', collision: 'replace', assetId: held.asset.id });
  assert.deepEqual([replaced.outcome, replaced.asset.id, replaced.version.number], ['replaced', held.asset.id, 2]);
  assert.equal(await text(f, replaced.version.id), 'written over');
  // An uploaded file replaced by written text can be uploaded over again.
  assert.equal((await f.upload('brief.md', Buffer.from('v3'), { collision: 'replace', assetId: held.asset.id })).version.number, 3);

  await f.upload('opaque.txt', Buffer.from([0xff, 0xfe, 0x00]));
  const opaque = f.library.list(f.ctx, f.projectId).assets.find((asset) => asset.filename === 'opaque.txt');
  await assert.rejects(f.library.createDraft(f.ctx, f.projectId, { assetId: opaque.id }), (error) => error.status === 422);
  await assert.rejects(f.library.createDraft(f.ctx, f.projectId, { filename: '../x.md' }), (error) => error.status === 400);

  const pending = await f.library.createDraft(f.ctx, f.projectId, { filename: 'later.md', text: 'kept' });
  f.store.archiveProject(f.ctx, f.projectId);
  assert.equal(f.library.draft(f.ctx, f.projectId, pending.id).text, 'kept', 'archived drafts stay readable');
  assert.throws(() => f.library.writeDraft(f.ctx, f.projectId, pending.id, { text: 'x', revision: 1 }), (error) => error.status === 409 && /archived/i.test(error.message));
  assert.throws(() => f.library.discardDraft(f.ctx, f.projectId, pending.id), (error) => error.status === 409);
  await assert.rejects(f.library.saveDraft(f.ctx, f.projectId, pending.id, { revision: 1, operationId: 'save-4' }), (error) => error.status === 409 && /archived/i.test(error.message));
  await assert.rejects(f.library.createDraft(f.ctx, f.projectId, { filename: 'new.md' }), (error) => error.status === 409);
  f.store.unarchiveProject(f.ctx, f.projectId);
  f.library.discardDraft(f.ctx, f.projectId, pending.id);
  assert.deepEqual(draftsOf(f), []);
  const { project: other } = f.store.createProject(f.ctx, { name: 'Other' });
  await assert.rejects(f.library.createDraft(f.ctx, other.id, { assetId: held.asset.id }), (error) => error.status === 404);
});

test('over HTTP, drafts autosave as app data, Save publishes them, and a saved document previews as text', async (t) => {
  const f = await httpFixture(t);
  const drafts = `${f.library}/drafts`;
  const draft = await f.ok('POST', drafts, { filename: 'Hook guide', text: '' });
  assert.equal(draft.revision, 1);
  const written = await f.ok('PUT', `${drafts}/${draft.id}`, { text: '<b>Open</b> on the payoff', revision: 1 });
  assert.deepEqual([written.revision, written.text], [2, undefined], 'autosave answers without echoing the text');
  assert.equal((await f.call('PUT', `${drafts}/${draft.id}`, { text: 'stale', revision: 1 })).status, 409);
  assert.deepEqual((await f.ok('GET', f.library)).assets, []);
  assert.deepEqual((await f.ok('GET', f.library)).drafts.map((entry) => [entry.id, entry.filename, entry.revision, entry.length]), [[draft.id, 'Hook guide', 2, 25]]);
  assert.equal((await f.ok('GET', `${drafts}/${draft.id}`)).text, '<b>Open</b> on the payoff');

  assert.equal((await f.call('POST', `${drafts}/${draft.id}/save`, { revision: 2, operation: '' })).status, 400);
  const saved = await f.ok('POST', `${drafts}/${draft.id}/save`, { revision: 2, operation: randomUUID() });
  assert.deepEqual([saved.outcome, saved.asset.kind, saved.version.number, saved.draft], ['created', 'document', 1, null]);
  assert.equal((await f.call('GET', `${drafts}/${draft.id}`)).status, 404);
  const preview = await f.raw(`${f.library}/versions/${saved.version.id}/content?inline=1`);
  assert.equal(preview.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(preview.headers.get('content-security-policy'), /sandbox/);
  assert.equal(await preview.text(), '<b>Open</b> on the payoff');

  const edit = await f.ok('POST', drafts, { assetId: saved.asset.id });
  assert.equal(edit.baseVersionId, saved.version.id);
  assert.deepEqual(await f.ok('DELETE', `${drafts}/${edit.id}`), { ok: true });
  assert.deepEqual((await f.ok('GET', f.library)).drafts, []);

  const output = await mkdtemp(path.join(tmpdir(), 'frameboard-library-export-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const kept = await f.ok('POST', drafts, { filename: 'during.md', text: 'x' });
  await f.ok('POST', '/api/maintenance/export', { output });
  assert.equal((await f.call('PUT', `${drafts}/${kept.id}`, { text: 'y', revision: 1 })).status, 503);
  assert.equal((await f.call('POST', `${drafts}/${kept.id}/save`, { revision: 1, operation: randomUUID() })).status, 503);
  await waitFor(async () => !(await f.ok('GET', '/api/maintenance')).active);
  assert.equal((await f.ok('GET', `${drafts}/${kept.id}`)).text, 'x');
});

test('export and restore keep saved documents as versions and drafts as app data, including after a failed save', async (t) => {
  const f = await fixture(t);
  const created = await f.library.createDraft(f.ctx, f.projectId, { filename: 'guide.md', text: 'saved v1' });
  const saved = await f.library.saveDraft(f.ctx, f.projectId, created.id, { revision: 1, operationId: 'save-1' });
  const edit = await f.library.createDraft(f.ctx, f.projectId, { assetId: saved.asset.id });
  f.library.writeDraft(f.ctx, f.projectId, edit.id, { text: 'unsaved v2 ✍️', revision: 1 });
  f.faults.checkpoint = async (stage) => { if (stage === 'published') throw new Error('disk full'); };
  await assert.rejects(f.library.saveDraft(f.ctx, f.projectId, edit.id, { revision: 2, operationId: 'save-2' }), /disk full/);
  const fresh = await f.library.createDraft(f.ctx, f.projectId, { filename: 'Pasted notes.md', text: 'pasted, never saved' });
  const before = f.library.list(f.ctx, f.projectId);

  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-library-drafts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  f.close();
  const { backupDir } = await createBackup({ dataDir: f.dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'native') });
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.inventory.tables.library_drafts, 2);
  assert.deepEqual(manifest.inventory.retained.map((entry) => [entry.objectId, entry.versionId]), [[saved.asset.id, saved.version.id]], 'drafts and failed saves are not retained versions');

  const dataDir = path.join(root, 'restored');
  await restoreBackup({ backupDir, dataDir, codexHome: path.join(root, 'native') });
  const restored = await openStore({ dataDir });
  t.after(() => restored.close());
  assert.deepEqual(restored.library.list(f.ctx, f.projectId), before);
  assert.equal(restored.library.draft(f.ctx, f.projectId, edit.id).text, 'unsaved v2 ✍️');
  assert.equal(restored.library.draft(f.ctx, f.projectId, fresh.id).text, 'pasted, never saved');
  assert.equal(restored.library.asset(f.ctx, f.projectId, saved.asset.id).current.id, saved.version.id);
  const resaved = await restored.library.saveDraft(f.ctx, f.projectId, edit.id, { revision: 2, operationId: 'save-3' });
  assert.equal((await collect((await restored.library.read(f.ctx, f.projectId, resaved.version.id)).stream)).toString(), 'unsaved v2 ✍️');
});

test('a crash after a save commits never leaves its draft behind, and a retry reports the save', async (t) => {
  const f = await fixture(t);
  const crashAfterCommit = () => { f.faults.checkpoint = (stage) => stage === 'committed' ? new Promise(() => {}) : Promise.resolve(); };
  const fresh = await f.library.createDraft(f.ctx, f.projectId, { filename: 'guide.md', text: 'v1' });
  crashAfterCommit();
  void f.library.saveDraft(f.ctx, f.projectId, fresh.id, { revision: 1, operationId: 'save-1' });
  await waitFor(() => f.library.list(f.ctx, f.projectId).assets.length === 1);
  f.faults.checkpoint = async () => {};
  await f.restart();
  assert.deepEqual(draftsOf(f), [], 'the committed first save finished its draft');
  const [asset] = f.library.list(f.ctx, f.projectId).assets;
  const retried = await f.library.saveDraft(f.ctx, f.projectId, fresh.id, { revision: 1, operationId: 'save-1' });
  assert.deepEqual([retried.outcome, retried.asset.id, retried.draft], ['created', asset.id, null]);

  const edit = await f.library.createDraft(f.ctx, f.projectId, { assetId: asset.id });
  f.library.writeDraft(f.ctx, f.projectId, edit.id, { text: 'v2', revision: 1 });
  crashAfterCommit();
  void f.library.saveDraft(f.ctx, f.projectId, edit.id, { revision: 2, operationId: 'save-2' });
  await waitFor(() => f.library.asset(f.ctx, f.projectId, asset.id).versionCount === 2);
  f.faults.checkpoint = async () => {};
  await f.restart();
  const next = await f.library.createDraft(f.ctx, f.projectId, { assetId: asset.id });
  assert.notEqual(next.id, edit.id, 'the saved edit is not offered as a stale draft');
  assert.deepEqual([next.baseVersionId, next.text], [f.library.asset(f.ctx, f.projectId, asset.id).current.id, 'v2']);
});

test('saves racing on one draft never publish twice, and a lost race reports the newer version', async (t) => {
  const f = await fixture(t);
  const draft = await f.library.createDraft(f.ctx, f.projectId, { filename: 'guide.md', text: 'v1' });
  let release;
  f.faults.checkpoint = (stage) => stage === 'staged' ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  const first = f.library.saveDraft(f.ctx, f.projectId, draft.id, { revision: 1, operationId: 'tab-a' });
  await waitFor(() => release);
  await assert.rejects(f.library.saveDraft(f.ctx, f.projectId, draft.id, { revision: 1, operationId: 'tab-b' }), (error) => error.status === 409 && /already being saved/.test(error.message));
  release();
  const saved = await first;
  assert.deepEqual(f.library.list(f.ctx, f.projectId).assets.map((asset) => asset.filename), ['guide.md']);

  // Two drafts of one asset cannot exist, but a save can lose to an upload committing first.
  const edit = await f.library.createDraft(f.ctx, f.projectId, { assetId: saved.asset.id });
  f.library.writeDraft(f.ctx, f.projectId, edit.id, { text: 'mine', revision: 1 });
  release = null;
  const losing = f.library.saveDraft(f.ctx, f.projectId, edit.id, { revision: 2, operationId: 'tab-c' });
  await waitFor(() => release);
  f.faults.checkpoint = async () => {};
  const upload = await f.upload('guide.md', Buffer.from('uploaded'), { collision: 'replace', assetId: saved.asset.id });
  release();
  await assert.rejects(losing, (error) => error.status === 409 && error.conflict?.currentVersion.id === upload.version.id);
  assert.equal(f.library.draft(f.ctx, f.projectId, edit.id).text, 'mine');
});

test('previews and editing follow the current version’s content, not the file’s origin', async (t) => {
  const f = await fixture(t);
  const uploaded = await f.upload('README', Buffer.from('plain upload'));
  assert.equal(uploaded.version.written, false);
  const draft = await f.library.createDraft(f.ctx, f.projectId, { filename: 'README', text: 'written over' });
  const written = await f.library.saveDraft(f.ctx, f.projectId, draft.id, { revision: 1, operationId: 'save-1', collision: 'replace', assetId: uploaded.asset.id });
  assert.deepEqual([written.asset.kind, written.version.written, written.asset.current.written], ['asset', true, true]);
  assert.equal(assetPreview('README', written.asset.current)?.kind, 'text');
  const binary = await f.upload('README', Buffer.from([0xff, 0]), { collision: 'replace', assetId: uploaded.asset.id });
  assert.equal(assetPreview('README', binary.asset.current), null);
  assert.equal(assetPreview('ref.png', { written: true }).kind, 'text', 'a written document named like an image is text');
  assert.equal(assetPreview('ref.png', { written: false }).kind, 'image');
});

test('nested folders scope names: the same filename coexists in different folders, and a collision is folder-local', async (t) => {
  const f = await fixture(t);
  const thumbnails = f.library.createFolder(f.ctx, f.projectId, { name: 'Thumbnails' });
  const references = f.library.createFolder(f.ctx, f.projectId, { name: 'References', parentId: thumbnails.id });
  assert.deepEqual([references.name, references.parentId], ['References', thumbnails.id]);
  assert.throws(() => f.library.createFolder(f.ctx, f.projectId, { name: 'Thumbnails' }), (error) => error.status === 409);
  assert.throws(() => f.library.createFolder(f.ctx, f.projectId, { name: 'a/b' }), (error) => error.status === 400);

  const root = await f.upload('logo.png', Buffer.from('root logo'));
  const nested = await f.upload('logo.png', Buffer.from('root logo'), { folderId: references.id });
  assert.equal(nested.outcome, 'created'); assert.equal(nested.asset.filename, 'logo.png');
  assert.notEqual(nested.asset.id, root.asset.id);
  assert.equal(nested.asset.folderId, references.id);
  await assert.rejects(f.upload('logo.png', Buffer.from('x'), { folderId: references.id }), (error) => error.status === 409
    && assert.deepEqual(error.conflict, { assetId: nested.asset.id, filename: 'logo.png', suggested: 'logo (1).png' }) === undefined);
  // A folder holds its name in its parent too.
  await assert.rejects(f.upload('References', Buffer.from('x'), { folderId: thumbnails.id }), (error) => error.status === 409 && !error.conflict.assetId);

  await f.restart();
  const { folders, assets } = f.library.list(f.ctx, f.projectId);
  assert.deepEqual(folders.map((folder) => [folder.id, folder.name, folder.parentId]), [[references.id, 'References', thumbnails.id], [thumbnails.id, 'Thumbnails', null]]);
  assert.deepEqual(assets.map((asset) => [asset.id, asset.folderId]), [[root.asset.id, null], [nested.asset.id, references.id]]);
  await assert.rejects(f.upload('x.png', Buffer.from('x'), { folderId: randomUUID() }), (error) => error.status === 404);
});

test('rename and move keep identities and every version, refuse a taken name in the destination and never merge', async (t) => {
  const f = await fixture(t);
  const brand = f.library.createFolder(f.ctx, f.projectId, { name: 'Brand' });
  const old = f.library.createFolder(f.ctx, f.projectId, { name: 'Old', parentId: brand.id });
  const logo = await f.upload('logo.png', Buffer.from('v1'));
  await f.upload('logo.png', Buffer.from('v2'), { collision: 'replace', assetId: logo.asset.id });
  const twin = await f.upload('logo.png', Buffer.from('v1'), { folderId: brand.id });

  // Same bytes and name in the destination: refused, not merged.
  assert.throws(() => f.library.updateAsset(f.ctx, f.projectId, logo.asset.id, { folderId: brand.id }), (error) => error.status === 409 && /logo\.png/.test(error.message));
  assert.throws(() => f.library.updateAsset(f.ctx, f.projectId, logo.asset.id, { filename: 'Brand' }), (error) => error.status === 409);
  const moved = f.library.updateAsset(f.ctx, f.projectId, logo.asset.id, { filename: 'mark.png', folderId: old.id });
  assert.deepEqual([moved.id, moved.filename, moved.folderId, moved.versionCount], [logo.asset.id, 'mark.png', old.id, 2]);
  const renamed = f.library.updateAsset(f.ctx, f.projectId, twin.asset.id, { filename: 'mark.png' });
  assert.deepEqual([renamed.id, renamed.folderId], [twin.asset.id, brand.id], 'the same name coexists one folder up');
  assert.equal(f.library.updateAsset(f.ctx, f.projectId, logo.asset.id, { filename: 'mark.png' }).id, logo.asset.id, 'keeping its own name is not a conflict');
  assert.deepEqual(f.library.asset(f.ctx, f.projectId, logo.asset.id).versions.map((version) => version.number), [2, 1]);

  // Folders move with their contents; a folder cannot move into itself or below.
  assert.throws(() => f.library.updateFolder(f.ctx, f.projectId, brand.id, { parentId: old.id }), (error) => error.status === 409);
  assert.throws(() => f.library.updateFolder(f.ctx, f.projectId, brand.id, { parentId: brand.id }), (error) => error.status === 409);
  f.library.createFolder(f.ctx, f.projectId, { name: 'Old' });
  assert.throws(() => f.library.updateFolder(f.ctx, f.projectId, old.id, { parentId: null }), (error) => error.status === 409);
  const archive = f.library.updateFolder(f.ctx, f.projectId, old.id, { name: 'Archive', parentId: null });
  assert.deepEqual([archive.id, archive.name, archive.parentId], [old.id, 'Archive', null]);
  assert.equal(f.library.asset(f.ctx, f.projectId, logo.asset.id).folderId, old.id, 'contents keep their folder identity');
  assert.throws(() => f.library.updateAsset(f.ctx, f.projectId, logo.asset.id, { filename: '../x' }), (error) => error.status === 400);
  assert.throws(() => f.library.updateAsset(f.ctx, f.projectId, logo.asset.id, { folderId: randomUUID() }), (error) => error.status === 404);

  const { project: other } = f.store.createProject(f.ctx, { name: 'Other' });
  const foreign = f.library.createFolder(f.ctx, other.id, { name: 'Elsewhere' });
  assert.throws(() => f.library.updateAsset(f.ctx, f.projectId, logo.asset.id, { folderId: foreign.id }), (error) => error.status === 404);
  assert.throws(() => f.library.updateAsset(f.ctx, other.id, logo.asset.id, { filename: 'stolen.png' }), (error) => error.status === 404);
  assert.throws(() => f.library.updateFolder(f.ctx, other.id, brand.id, { name: 'Stolen' }), (error) => error.status === 404);
});

test('removal hides sources but keeps every version readable; folder removal is recursive and a former name never revives an identity', async (t) => {
  const f = await fixture(t);
  const thumbnails = f.library.createFolder(f.ctx, f.projectId, { name: 'Thumbnails' });
  const references = f.library.createFolder(f.ctx, f.projectId, { name: 'References', parentId: thumbnails.id });
  const script = await f.upload('script.md', Buffer.from('v1'));
  const v2 = await f.upload('script.md', Buffer.from('v2'), { collision: 'replace', assetId: script.asset.id });
  const cover = await f.upload('cover.png', Buffer.from('cover'), { folderId: thumbnails.id });
  const deep = await f.upload('deep.png', Buffer.from('deep'), { folderId: references.id });
  const kept = await f.upload('kept.png', Buffer.from('kept'));

  const broken = Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('upload disconnected'); })());
  await assert.rejects(f.upload('script.md', broken, { collision: 'replace', assetId: script.asset.id, operationId: 'replace-before-removal' }), /disconnected/);
  f.library.removeAsset(f.ctx, f.projectId, script.asset.id);
  assert.deepEqual(f.library.list(f.ctx, f.projectId).assets.map((asset) => asset.filename), ['cover.png', 'deep.png', 'kept.png']);
  await assert.rejects(f.upload('script.md', Buffer.from('v3'), { collision: 'replace', assetId: script.asset.id, operationId: 'replace-before-removal' }),
    (error) => error.status === 409 && /removed/.test(error.message));
  const removed = f.library.asset(f.ctx, f.projectId, script.asset.id);
  assert.ok(removed.removedAt);
  assert.deepEqual(removed.versions.map((version) => version.id), [v2.version.id, script.version.id]);
  assert.deepEqual(await collect((await f.library.read(f.ctx, f.projectId, script.version.id)).stream), Buffer.from('v1'));
  assert.throws(() => f.library.updateAsset(f.ctx, f.projectId, script.asset.id, { filename: 'back.md' }), (error) => error.status === 404);
  await assert.rejects(f.upload('script.md', Buffer.from('v3'), { collision: 'replace', assetId: script.asset.id }), (error) => error.status === 409);
  const reused = await f.upload('script.md', Buffer.from('new source'));
  assert.equal(reused.outcome, 'created'); assert.notEqual(reused.asset.id, script.asset.id, 'the former name holds a new identity');

  // An upload in progress inside a folder being removed saves nothing.
  let release;
  const slow = Readable.from((async function* () { yield Buffer.from('half'); await new Promise((resolve) => { release = resolve; }); yield Buffer.from('rest'); })());
  const pending = f.upload('late.png', slow, { folderId: references.id });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  f.library.removeFolder(f.ctx, f.projectId, thumbnails.id);
  release();
  await assert.rejects(pending, (error) => error.status === 409);

  await f.restart();
  const listing = f.library.list(f.ctx, f.projectId);
  assert.deepEqual(listing.folders, []);
  assert.deepEqual(listing.assets.map((asset) => asset.filename), ['kept.png', 'script.md']);
  assert.deepEqual(f.library.removed(f.ctx, f.projectId).assets.map((asset) => [asset.id, asset.path]).sort(),
    [[cover.asset.id, 'Thumbnails/cover.png'], [deep.asset.id, 'Thumbnails/References/deep.png'], [script.asset.id, 'script.md']].sort());
  assert.deepEqual(await collect((await f.library.read(f.ctx, f.projectId, deep.version.id)).stream), Buffer.from('deep'));
  await assert.rejects(f.upload('x.png', Buffer.from('x'), { folderId: references.id }), (error) => error.status === 404);
  assert.throws(() => f.library.createFolder(f.ctx, f.projectId, { name: 'x', parentId: thumbnails.id }), (error) => error.status === 404);
  assert.throws(() => f.library.removeFolder(f.ctx, f.projectId, thumbnails.id), (error) => error.status === 404);
  // A removed folder's name is free again, for a new folder identity.
  assert.notEqual(f.library.createFolder(f.ctx, f.projectId, { name: 'Thumbnails' }).id, thumbnails.id);
  assert.ok(f.library.list(f.ctx, f.projectId).assets.find((asset) => asset.id === kept.asset.id));
});

test('remembered sources resolve to current versions: folders expand recursively in path order, overlaps keep first position, removed sources stay unresolved', async (t) => {
  const f = await fixture(t);
  const thumbnails = f.library.createFolder(f.ctx, f.projectId, { name: 'Thumbnails' });
  const references = f.library.createFolder(f.ctx, f.projectId, { name: 'refs', parentId: thumbnails.id });
  const empty = f.library.createFolder(f.ctx, f.projectId, { name: 'Next episode' });
  const script = await f.upload('script.md', Buffer.from('# A'));
  const b = await f.upload('b.png', Buffer.from('b'), { folderId: thumbnails.id });
  const deep = await f.upload('a.png', Buffer.from('a'), { folderId: references.id });
  const dot = await f.upload('refs.txt', Buffer.from('r'), { folderId: thumbnails.id });
  const logo = await f.upload('logo.png', Buffer.from('logo'), { folderId: thumbnails.id });

  const selection = [{ kind: 'asset', id: logo.asset.id }, { kind: 'folder', id: thumbnails.id }, { kind: 'asset', id: script.asset.id }, { kind: 'folder', id: empty.id }];
  const resolved = f.library.resolve(f.ctx, f.projectId, selection);
  assert.deepEqual(resolved.problems, [], 'an existing empty folder is a valid selection');
  // logo.png keeps its first position; the folder adds the rest in relative-path
  // order, compared segment by segment, so refs/a.png sorts before refs.txt.
  assert.deepEqual(resolved.files.map((file) => [file.assetId, file.libraryPath]), [
    [logo.asset.id, 'Thumbnails/logo.png'], [b.asset.id, 'Thumbnails/b.png'], [deep.asset.id, 'Thumbnails/refs/a.png'],
    [dot.asset.id, 'Thumbnails/refs.txt'], [script.asset.id, 'script.md']]);
  assert.deepEqual(resolved.files[0].sources, [{ kind: 'asset', id: logo.asset.id }, { kind: 'folder', id: thumbnails.id, relativePath: 'logo.png' }]);
  assert.deepEqual(resolved.files[2].sources, [{ kind: 'folder', id: thumbnails.id, relativePath: 'refs/a.png' }]);
  assert.deepEqual([resolved.files[4].versionId, resolved.files[4].hash, resolved.files[4].size, resolved.files[4].filename], [script.version.id, sha(Buffer.from('# A')), 3, 'script.md']);

  // Replace and move follow the identity; removal leaves the ID unresolved, even after its name is reused.
  const v2 = await f.upload('script.md', Buffer.from('# B'), { collision: 'replace', assetId: script.asset.id });
  f.library.updateAsset(f.ctx, f.projectId, script.asset.id, { folderId: empty.id });
  assert.deepEqual(f.library.resolve(f.ctx, f.projectId, [selection[3]]).files.map((file) => [file.assetId, file.versionId, file.libraryPath]), [[script.asset.id, v2.version.id, 'Next episode/script.md']]);
  f.library.updateAsset(f.ctx, f.projectId, script.asset.id, { folderId: null });
  f.library.removeAsset(f.ctx, f.projectId, script.asset.id);
  f.library.removeFolder(f.ctx, f.projectId, thumbnails.id);
  await f.upload('script.md', Buffer.from('impostor'));
  f.library.createFolder(f.ctx, f.projectId, { name: 'Thumbnails' });
  const { project: other } = f.store.createProject(f.ctx, { name: 'Other' });
  const foreign = f.library.createFolder(f.ctx, other.id, { name: 'Elsewhere' });
  const after = f.library.resolve(f.ctx, f.projectId, [...selection, { kind: 'folder', id: foreign.id }, { kind: 'folder', id: logo.asset.id }, { kind: 'path', id: 'script.md' }]);
  assert.deepEqual(after.problems.map((problem) => [problem.key, problem.label, problem.phase, problem.reason]), [
    [`asset:${logo.asset.id}`, 'logo.png', 'resolve', 'It was removed from the Library.'],
    [`folder:${thumbnails.id}`, 'Thumbnails/', 'resolve', 'It was removed from the Library.'],
    [`asset:${script.asset.id}`, 'script.md', 'resolve', 'It was removed from the Library.'],
    [`folder:${foreign.id}`, `folder:${foreign.id}`, 'resolve', 'It is not a folder in this project’s Library.'],
    [`folder:${logo.asset.id}`, `folder:${logo.asset.id}`, 'resolve', 'It is not a folder in this project’s Library.'],
    ['path:script.md', 'path:script.md', 'resolve', 'It is not a file in this project’s Library.']]);
  assert.deepEqual(after.files, [], 'an existing empty folder adds no files, and nothing substitutes for removed sources');
});

test('a dropped folder path reuses live folders, steps around a file holding its name, and repeats exactly on retry', async (t) => {
  const f = await fixture(t);
  const existing = f.library.createFolder(f.ctx, f.projectId, { name: 'Thumbnails' });
  await f.upload('refs', Buffer.from('a file named like the folder'), { folderId: existing.id });
  const leaf = f.library.ensureFolders(f.ctx, f.projectId, { parentId: null, names: ['Thumbnails', 'refs', 'Deep'] });
  const suffixed = f.library.list(f.ctx, f.projectId).folders.find((folder) => folder.id === leaf.parentId);
  assert.deepEqual([suffixed.name, suffixed.parentId], ['refs (1)', existing.id]);
  assert.equal(leaf.name, 'Deep');
  assert.equal(f.library.ensureFolders(f.ctx, f.projectId, { parentId: null, names: ['Thumbnails', 'refs', 'Deep'] }).id, leaf.id, 'a retry finds the same folders');
  assert.equal(f.library.list(f.ctx, f.projectId).folders.length, 3);
  // Folder names have no extension: "v1.2" steps aside as "v1.2 (1)".
  await f.upload('v1.2', Buffer.from('a file'));
  assert.equal(f.library.ensureFolders(f.ctx, f.projectId, { parentId: null, names: ['v1.2'] }).name, 'v1.2 (1)');
  assert.throws(() => f.library.ensureFolders(f.ctx, f.projectId, { parentId: null, names: [] }), (error) => error.status === 400);
  assert.throws(() => f.library.ensureFolders(f.ctx, f.projectId, { parentId: null, names: ['ok', '..'] }), (error) => error.status === 400);
  assert.equal(f.library.list(f.ctx, f.projectId).folders.length, 4, 'an invalid path creates nothing');
  f.store.archiveProject(f.ctx, f.projectId);
  assert.throws(() => f.library.ensureFolders(f.ctx, f.projectId, { parentId: null, names: ['New'] }), (error) => error.status === 409 && /archived/i.test(error.message));
  for (const attempt of [() => f.library.createFolder(f.ctx, f.projectId, { name: 'New' }), () => f.library.updateFolder(f.ctx, f.projectId, existing.id, { name: 'Renamed' }),
    () => f.library.removeFolder(f.ctx, f.projectId, existing.id)]) assert.throws(attempt, (error) => error.status === 409 && /archived/i.test(error.message));
  assert.equal(f.library.list(f.ctx, f.projectId).folders.length, 4, 'archived Libraries stay readable');
});

test('over HTTP, folders nest, uploads land in a folder, and rename, move and removal keep identities and versions', async (t) => {
  const f = await httpFixture(t);
  const folder = (body) => f.call('POST', `${f.library}/folders`, body);
  const created = await folder({ name: 'Thumbnails' });
  assert.equal(created.status, 201);
  const thumbnails = created.body;
  assert.equal((await folder({ name: 'Thumbnails' })).status, 409);
  const old = await f.ok('POST', `${f.library}/folders/paths`, { parentId: thumbnails.id, names: ['refs', 'old'] });
  const refs = (await f.ok('GET', f.library)).folders.find((entry) => entry.id === old.parentId);
  assert.deepEqual([refs.name, refs.parentId, old.name], ['refs', thumbnails.id, 'old']);
  const uploaded = await f.upload('logo.png', Buffer.from('logo'), { folder: thumbnails.id });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.asset.folderId, thumbnails.id);
  const root = await f.upload('logo.png', Buffer.from('logo'));
  assert.equal(root.status, 201, 'the same name coexists at the root');
  assert.equal((await f.upload('logo.png', Buffer.from('logo'), { folder: thumbnails.id })).status, 409);

  assert.equal((await f.call('PATCH', `${f.library}/assets/${root.body.asset.id}`, { folderId: thumbnails.id })).status, 409);
  const moved = await f.ok('PATCH', `${f.library}/assets/${root.body.asset.id}`, { filename: 'mark.png', folderId: refs.id });
  assert.deepEqual([moved.id, moved.filename, moved.folderId], [root.body.asset.id, 'mark.png', refs.id]);
  assert.equal((await f.call('PATCH', `${f.library}/folders/${thumbnails.id}`, { parentId: refs.id })).status, 409);
  assert.equal((await f.ok('PATCH', `${f.library}/folders/${refs.id}`, { name: 'References' })).name, 'References');

  await f.ok('DELETE', `${f.library}/assets/${uploaded.body.asset.id}`);
  await f.ok('DELETE', `${f.library}/folders/${thumbnails.id}`);
  assert.deepEqual(await f.ok('GET', f.library), { folders: [], assets: [], drafts: [] });
  const removed = (await f.ok('GET', `${f.library}/removed`)).assets;
  assert.deepEqual(removed.map((asset) => asset.path).sort(), ['Thumbnails/References/mark.png', 'Thumbnails/logo.png']);
  assert.ok((await f.ok('GET', `${f.library}/assets/${uploaded.body.asset.id}`)).removedAt);
  assert.equal((await f.raw(`${f.library}/versions/${uploaded.body.version.id}/content`)).status, 200, 'removed versions stay downloadable');
  assert.equal((await f.call('DELETE', `${f.library}/folders/${thumbnails.id}`)).status, 404);
  assert.equal((await f.upload('late.png', Buffer.from('x'), { folder: thumbnails.id })).status, 404);

  // Archive and maintenance refuse every organizing change.
  const kept = await f.ok('POST', `${f.library}/folders`, { name: 'Kept' });
  await f.ok('POST', `/api/projects/${f.projectId}/archive`, {});
  for (const [method, url, body] of [['POST', `${f.library}/folders`, { name: 'New' }], ['PATCH', `${f.library}/folders/${kept.id}`, { name: 'X' }], ['DELETE', `${f.library}/folders/${kept.id}`],
    ['POST', `${f.library}/folders/paths`, { names: ['New'] }]]) {
    const response = await f.call(method, url, body);
    assert.equal(response.status, 409, `${method} ${url}`);
  }
  await f.ok('POST', `/api/projects/${f.projectId}/unarchive`, {});
  const output = await mkdtemp(path.join(tmpdir(), 'frameboard-library-export-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await f.ok('POST', '/api/maintenance/export', { output });
  assert.equal((await f.call('PATCH', `${f.library}/folders/${kept.id}`, { name: 'Paused' })).status, 503);
  await waitFor(async () => !(await f.ok('GET', '/api/maintenance')).active);
  assert.deepEqual((await f.ok('GET', f.library)).folders.map((entry) => entry.name), ['Kept']);
});

test('export and restore carry nested folders, locations and removals, and the manifest inventories them', async (t) => {
  const f = await httpFixture(t);
  const thumbnails = await f.ok('POST', `${f.library}/folders`, { name: 'Thumbnails' });
  const refs = await f.ok('POST', `${f.library}/folders`, { name: 'refs', parentId: thumbnails.id });
  const gone = await f.ok('POST', `${f.library}/folders`, { name: 'Gone' });
  await f.ok('POST', `${f.library}/folders`, { name: 'Empty' });
  const deep = (await f.upload('a.png', Buffer.from('a'), { folder: refs.id })).body;
  const removed = (await f.upload('old.md', Buffer.from('old'), { folder: gone.id })).body;
  await f.upload('script.md', Buffer.from('script'));
  await f.ok('DELETE', `${f.library}/folders/${gone.id}`);
  const listing = await f.ok('GET', f.library); const removedListing = await f.ok('GET', `${f.library}/removed`);

  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-library-folders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await f.close();
  const { backupDir } = await createBackup({ dataDir: f.dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'native') });
  const manifestFile = path.join(backupDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.deepEqual(manifest.inventory.folders.map((folder) => [folder.name, folder.parentId === thumbnails.id ? 'Thumbnails' : folder.parentId, folder.removed]).sort(),
    [['Empty', null, false], ['Gone', null, true], ['Thumbnails', null, false], ['refs', 'Thumbnails', false]]);
  const inventoried = new Map(manifest.inventory.retained.map((entry) => [entry.objectId, entry]));
  assert.deepEqual([inventoried.get(deep.asset.id).folderId, inventoried.get(removed.asset.id).folderId, inventoried.get(removed.asset.id).removed], [refs.id, gone.id, true]);

  const dataDir = path.join(root, 'restored');
  await restoreBackup({ backupDir, dataDir, codexHome: path.join(root, 'native') });
  const restored = await createApp({ dataDir, codexAdapter: new ControlledCodex(path.join(root, 'native')) });
  await new Promise((resolve) => restored.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => restored.close(resolve)));
  const base = `http://127.0.0.1:${restored.address().port}`;
  assert.deepEqual(await (await fetch(`${base}${f.library}`)).json(), listing);
  assert.deepEqual(await (await fetch(`${base}${f.library}/removed`)).json(), removedListing);

  manifest.inventory.folders.find((folder) => folder.id === refs.id).name = 'renamed';
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(restoreBackup({ backupDir, dataDir: path.join(root, 'tampered'), codexHome: path.join(root, 'native') }), /inventory does not match/);
});

test('a retried upload follows its own saved outcome and its file’s current location, not the folder it started in', async (t) => {
  const f = await fixture(t);
  const drafts = f.library.createFolder(f.ctx, f.projectId, { name: 'Drafts' });
  const saved = await f.upload('cut.mp4', Buffer.from('cut'), { folderId: drafts.id, operationId: 'saved-1' });
  const moving = await f.upload('take.wav', Buffer.from('v1'), { folderId: drafts.id });
  const broken = Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('upload disconnected'); })());
  await assert.rejects(f.upload('take.wav', broken, { folderId: drafts.id, collision: 'replace', assetId: moving.asset.id, operationId: 'replace-1' }), /disconnected/);
  f.library.updateAsset(f.ctx, f.projectId, moving.asset.id, { folderId: null });
  f.library.updateAsset(f.ctx, f.projectId, saved.asset.id, { folderId: null });
  f.library.removeFolder(f.ctx, f.projectId, drafts.id);

  // The response was lost: the saved upload is reported again although its folder is gone.
  const again = await f.upload('cut.mp4', Buffer.from('ignored'), { folderId: drafts.id, operationId: 'saved-1' });
  assert.deepEqual([again.outcome, again.version.id], ['created', saved.version.id]);
  // The interrupted replacement finishes on the moved file.
  const replaced = await f.upload('take.wav', Buffer.from('v2'), { folderId: drafts.id, collision: 'replace', assetId: moving.asset.id, operationId: 'replace-1' });
  assert.deepEqual([replaced.asset.id, replaced.asset.folderId, replaced.version.number], [moving.asset.id, null, 2]);

  // A first upload whose folder is removed mid-stream says so.
  const later = f.library.createFolder(f.ctx, f.projectId, { name: 'Later' });
  let release;
  const slow = Readable.from((async function* () { yield Buffer.from('half'); await new Promise((resolve) => { release = resolve; }); yield Buffer.from('rest'); })());
  const pending = f.upload('late.png', slow, { folderId: later.id });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  f.library.removeFolder(f.ctx, f.projectId, later.id);
  release();
  await assert.rejects(pending, (error) => error.status === 409 && /removed/.test(error.message));
});

test('a new document saves at the Library root, where a subfolder also holds its name, and then moves like any file', async (t) => {
  const f = await fixture(t);
  f.library.createFolder(f.ctx, f.projectId, { name: 'guide.md' });
  const scripts = f.library.createFolder(f.ctx, f.projectId, { name: 'Scripts' });
  const draft = await f.library.createDraft(f.ctx, f.projectId, { filename: 'guide.md', text: '# Guide' });
  await assert.rejects(f.library.saveDraft(f.ctx, f.projectId, draft.id, { revision: draft.revision, operationId: 'doc-1' }),
    (error) => error.status === 409 && error.conflict.suggested === 'guide (1).md' && !error.conflict.assetId);
  const saved = await f.library.saveDraft(f.ctx, f.projectId, draft.id, { revision: draft.revision, operationId: 'doc-2', collision: 'create', folderId: scripts.id });
  assert.deepEqual([saved.asset.filename, saved.asset.folderId], ['guide (1).md', null], 'a requested folder is ignored: documents save at the root');
  const moved = f.library.updateAsset(f.ctx, f.projectId, saved.asset.id, { folderId: scripts.id });
  assert.equal(moved.folderId, scripts.id);
  const edit = await f.library.createDraft(f.ctx, f.projectId, { assetId: saved.asset.id });
  const v2 = await f.library.saveDraft(f.ctx, f.projectId, edit.id, { revision: (await f.library.writeDraft(f.ctx, f.projectId, edit.id, { text: '# Guide v2', revision: edit.revision })).revision, operationId: 'doc-3' });
  assert.deepEqual([v2.asset.id, v2.asset.folderId, v2.version.number], [saved.asset.id, scripts.id, 2], 'a later save keeps the moved file in place');
});

test('restoring an older version publishes its bytes as a new current version and keeps every intervening version', async (t) => {
  const f = await fixture(t);
  const v1 = await f.upload('script.md', Buffer.from('# Take one'));
  const v2 = await f.upload('script.md', Buffer.from('# Take two'), { collision: 'replace', assetId: v1.asset.id });
  const v3 = await f.upload('script.md', Buffer.from('# Take three'), { collision: 'replace', assetId: v1.asset.id });

  const restored = await f.library.restoreVersion(f.ctx, f.projectId, v1.asset.id, { versionId: v1.version.id, baseVersionId: v3.version.id, operationId: 'restore-1' });
  assert.equal(restored.outcome, 'restored');
  assert.deepEqual([restored.asset.id, restored.version.number, restored.version.restoredFrom], [v1.asset.id, 4, v1.version.id]);
  assert.notEqual(restored.version.id, v1.version.id, 'a new version, not a revived one');
  const asset = f.library.asset(f.ctx, f.projectId, v1.asset.id);
  assert.equal(asset.current.id, restored.version.id);
  assert.deepEqual(asset.versions.map((version) => version.id), [restored.version.id, v3.version.id, v2.version.id, v1.version.id]);
  assert.deepEqual(await collect((await f.library.read(f.ctx, f.projectId, restored.version.id)).stream), Buffer.from('# Take one'));
  // Historical references keep their own bytes.
  assert.deepEqual(await collect((await f.library.read(f.ctx, f.projectId, v3.version.id)).stream), Buffer.from('# Take three'));
  assert.deepEqual(f.library.resolve(f.ctx, f.projectId, [{ kind: 'asset', id: v1.asset.id }]).files.map((file) => file.versionId), [restored.version.id]);

  // A retry reports the same restoration without another version.
  const again = await f.library.restoreVersion(f.ctx, f.projectId, v1.asset.id, { versionId: v1.version.id, baseVersionId: v3.version.id, operationId: 'restore-1' });
  assert.deepEqual([again.outcome, again.version.id], ['restored', restored.version.id]);
  assert.equal(f.library.asset(f.ctx, f.projectId, v1.asset.id).versionCount, 4);
});

test('restoration is explicit about the version it replaces and refuses foreign, removed or archived sources', async (t) => {
  const f = await fixture(t);
  const { project: other } = f.store.createProject(f.ctx, { name: 'Other' });
  const v1 = await f.upload('script.md', Buffer.from('# Take one'));
  const v2 = await f.upload('script.md', Buffer.from('# Take two'), { collision: 'replace', assetId: v1.asset.id });
  const elsewhere = await f.upload('notes.md', Buffer.from('# Notes'));
  const restore = (input, projectId = f.projectId, assetId = v1.asset.id) => f.library.restoreVersion(f.ctx, projectId, assetId, { operationId: randomUUID(), ...input });

  // A version saved after the user looked is never silently replaced.
  await assert.rejects(restore({ versionId: v1.version.id, baseVersionId: v1.version.id }),
    (error) => error.status === 409 && error.conflict.currentVersion.id === v2.version.id && /v2/.test(error.message));
  await assert.rejects(restore({ versionId: v2.version.id, baseVersionId: v2.version.id }), (error) => error.status === 409 && /already current/.test(error.message));
  await assert.rejects(restore({ versionId: elsewhere.version.id, baseVersionId: v2.version.id }), (error) => error.status === 404);
  await assert.rejects(restore({ versionId: v1.version.id, baseVersionId: v2.version.id }, other.id), (error) => error.status === 404);
  // Restoring content the current version already has publishes nothing.
  const v3 = await f.upload('script.md', Buffer.from('# Take one'), { collision: 'replace', assetId: v1.asset.id });
  const unchanged = await restore({ versionId: v1.version.id, baseVersionId: v3.version.id });
  assert.deepEqual([unchanged.outcome, unchanged.version.id], ['unchanged', v3.version.id]);
  assert.equal(f.library.asset(f.ctx, f.projectId, v1.asset.id).versionCount, 3);

  // A retry names the asset and version it began with.
  const done = await restore({ versionId: v2.version.id, baseVersionId: v3.version.id, operationId: 'restore-1' });
  await assert.rejects(restore({ versionId: elsewhere.version.id, baseVersionId: elsewhere.version.id, operationId: 'restore-1' }, f.projectId, elsewhere.asset.id), (error) => error.status === 409);

  f.store.archiveProject(f.ctx, f.projectId);
  await assert.rejects(restore({ versionId: v1.version.id, baseVersionId: done.version.id }), (error) => error.status === 409 && /archived/i.test(error.message));
  f.store.unarchiveProject(f.ctx, f.projectId);
  f.library.removeAsset(f.ctx, f.projectId, v1.asset.id);
  await assert.rejects(restore({ versionId: v1.version.id, baseVersionId: done.version.id }), (error) => error.status === 404);
  assert.equal(f.library.asset(f.ctx, f.projectId, v1.asset.id).versionCount, 4);
});

test('a failed restoration keeps the current version, and its retry publishes the same older bytes once', async (t) => {
  const f = await fixture(t);
  const v1 = await f.upload('script.md', Buffer.from('# Take one'));
  const v2 = await f.upload('script.md', Buffer.from('# Take two'), { collision: 'replace', assetId: v1.asset.id });
  const input = { versionId: v1.version.id, baseVersionId: v2.version.id, operationId: 'restore-1' };

  // Interrupted after the bytes were published but before the commit.
  f.faults.checkpoint = async (stage) => { if (stage === 'bytes-published') throw new Error('crashed before commit'); };
  await assert.rejects(f.library.restoreVersion(f.ctx, f.projectId, v1.asset.id, input), /crashed/);
  f.faults.checkpoint = async () => {};
  assert.deepEqual([f.library.asset(f.ctx, f.projectId, v1.asset.id).current.id, f.library.asset(f.ctx, f.projectId, v1.asset.id).versionCount], [v2.version.id, 2]);

  // Damaged older bytes are never restored; exact repair makes the retry possible.
  const payload = path.join(f.dataDir, 'retained', 'versions', v1.version.id);
  await chmod(payload, 0o600); await writeFile(payload, 'tampered!!');
  await f.restart();
  await assert.rejects(f.library.restoreVersion(f.ctx, f.projectId, v1.asset.id, input), (error) => error.status === 409 && /unavailable/.test(error.message));
  assert.equal(f.library.asset(f.ctx, f.projectId, v1.asset.id).current.id, v2.version.id);
  await f.library.repair(f.ctx, f.projectId, v1.version.id, Buffer.from('# Take one'));
  const restored = await f.library.restoreVersion(f.ctx, f.projectId, v1.asset.id, input);
  assert.deepEqual([restored.version.number, restored.version.hash], [3, sha(Buffer.from('# Take one'))]);
  assert.equal(f.library.asset(f.ctx, f.projectId, v1.asset.id).versionCount, 3);
});

test('a restored written version previews and edits as written text', async (t) => {
  const f = await fixture(t);
  const draft = await f.library.createDraft(f.ctx, f.projectId, { filename: 'cover.png', text: 'written first' });
  const saved = await f.library.saveDraft(f.ctx, f.projectId, draft.id, { revision: draft.revision, operationId: 'doc-1' });
  const uploaded = await f.upload('cover.png', Buffer.from([137, 80, 78, 71]), { collision: 'replace', assetId: saved.asset.id });
  assert.equal(uploaded.version.written, false);
  const restored = await f.library.restoreVersion(f.ctx, f.projectId, saved.asset.id, { versionId: saved.version.id, baseVersionId: uploaded.version.id, operationId: 'restore-1' });
  assert.deepEqual([restored.version.written, restored.asset.current.written], [true, true]);
  assert.equal((await f.library.read(f.ctx, f.projectId, restored.version.id)).written, true);
});

test('a project copy is an independent asset with only the current content, which survives source removal, damage and archive', async (t) => {
  const f = await fixture(t);
  const { project: other } = f.store.createProject(f.ctx, { name: 'Other' });
  const refs = f.library.createFolder(f.ctx, other.id, { name: 'refs' });
  const v1 = await f.upload('logo.png', Buffer.from('logo one'));
  const v2 = await f.upload('logo.png', Buffer.from('logo two'), { collision: 'replace', assetId: v1.asset.id });

  const copied = await f.library.copyAsset(f.ctx, f.projectId, v1.asset.id, { targetProjectId: other.id, folderId: refs.id, filename: 'logo.png', operationId: 'copy-1' });
  assert.equal(copied.outcome, 'copied');
  assert.notEqual(copied.asset.id, v1.asset.id);
  assert.deepEqual([copied.asset.projectId, copied.asset.folderId, copied.asset.filename, copied.asset.versionCount], [other.id, refs.id, 'logo.png', 1]);
  assert.notEqual(copied.version.id, v2.version.id);
  assert.deepEqual([copied.version.number, copied.version.hash, copied.version.size], [1, v2.version.hash, v2.version.size], 'only the current content');
  assert.deepEqual(copied.asset.copiedFrom, { projectId: f.projectId, assetId: v1.asset.id, versionId: v2.version.id });
  assert.deepEqual(f.library.list(f.ctx, other.id).assets.map((asset) => asset.id), [copied.asset.id]);
  assert.equal(f.library.asset(f.ctx, f.projectId, v1.asset.id).versionCount, 2, 'the source is untouched');
  // Each project reads only its own asset's versions.
  await assert.rejects(f.library.read(f.ctx, f.projectId, copied.version.id), (error) => error.status === 404);
  await assert.rejects(f.library.read(f.ctx, other.id, v2.version.id), (error) => error.status === 404);

  // A retry reports the same copy.
  const again = await f.library.copyAsset(f.ctx, f.projectId, v1.asset.id, { targetProjectId: other.id, folderId: refs.id, filename: 'logo.png', operationId: 'copy-1' });
  assert.deepEqual([again.asset.id, again.version.id], [copied.asset.id, copied.version.id]);

  // Equal bytes never alias: the source's damage, removal and archive leave the copy whole.
  const payload = path.join(f.dataDir, 'retained', 'versions', v2.version.id);
  await chmod(payload, 0o600); await writeFile(payload, 'tampered');
  f.library.removeAsset(f.ctx, f.projectId, v1.asset.id);
  f.store.archiveProject(f.ctx, f.projectId);
  await f.restart();
  assert.deepEqual(await collect((await f.library.read(f.ctx, other.id, copied.version.id)).stream), Buffer.from('logo two'));
  const resolved = f.library.resolve(f.ctx, other.id, [{ kind: 'asset', id: copied.asset.id }]);
  assert.deepEqual([resolved.problems, resolved.files.map((file) => [file.versionId, file.libraryPath])], [[], [[copied.version.id, 'refs/logo.png']]]);
});

test('a project copy chooses its destination folder and name explicitly and requires both projects to be active', async (t) => {
  const f = await fixture(t);
  const { project: other } = f.store.createProject(f.ctx, { name: 'Other' });
  const { project: third } = f.store.createProject(f.ctx, { name: 'Third' });
  const source = await f.upload('logo.png', Buffer.from('logo'));
  const held = await f.upload('logo.png', Buffer.from('logo'), { projectId: other.id });
  const copy = (input, projectId = f.projectId, assetId = source.asset.id) => f.library.copyAsset(f.ctx, projectId, assetId, { targetProjectId: other.id, filename: 'logo.png', operationId: randomUUID(), ...input });

  // A taken name offers Create new; a copy never becomes a version of the destination's file.
  await assert.rejects(copy({}), (error) => error.status === 409 && error.conflict.suggested === 'logo (1).png' && !error.conflict.assetId);
  await assert.rejects(copy({ collision: 'replace', assetId: held.asset.id }), (error) => error.status === 400);
  const suffixed = await copy({ collision: 'create' });
  assert.deepEqual([suffixed.asset.filename, suffixed.asset.folderId], ['logo (1).png', null]);
  const renamed = await copy({ filename: 'brand mark.png' });
  assert.equal(renamed.asset.filename, 'brand mark.png');
  assert.deepEqual(f.library.list(f.ctx, other.id).assets.map((asset) => [asset.filename, asset.versionCount]), [['brand mark.png', 1], ['logo (1).png', 1], ['logo.png', 1]]);
  assert.equal(f.library.asset(f.ctx, other.id, held.asset.id).current.id, held.version.id, 'equal bytes never merge with the held file');

  // Ownership: the folder must be the destination's, the source the named project's.
  const foreignFolder = f.library.createFolder(f.ctx, third.id, { name: 'refs' });
  await assert.rejects(copy({ folderId: foreignFolder.id }), (error) => error.status === 404);
  await assert.rejects(copy({ targetProjectId: randomUUID() }), (error) => error.status === 404);
  await assert.rejects(copy({}, third.id), (error) => error.status === 404);
  await assert.rejects(copy({ filename: '../escape.png' }), (error) => error.status === 400);

  f.store.archiveProject(f.ctx, other.id);
  await assert.rejects(copy({ filename: 'late.png' }), (error) => error.status === 409 && /archived/i.test(error.message));
  f.store.unarchiveProject(f.ctx, other.id);
  f.store.archiveProject(f.ctx, f.projectId);
  await assert.rejects(copy({ filename: 'late.png' }), (error) => error.status === 409 && /archived/i.test(error.message));
  f.store.unarchiveProject(f.ctx, f.projectId);
  f.library.removeAsset(f.ctx, f.projectId, source.asset.id);
  await assert.rejects(copy({ filename: 'late.png' }), (error) => error.status === 404);
  assert.equal(f.library.list(f.ctx, other.id).assets.length, 3);
});

test('a failed project copy leaves nothing in the destination, and its retry copies the version it began with', async (t) => {
  const f = await fixture(t);
  const { project: other } = f.store.createProject(f.ctx, { name: 'Other' });
  const v1 = await f.upload('script.md', Buffer.from('# Take one'));
  const input = { targetProjectId: other.id, filename: 'script.md', operationId: 'copy-1' };

  f.faults.checkpoint = async (stage) => { if (stage === 'bytes-published') throw new Error('crashed before commit'); };
  await assert.rejects(f.library.copyAsset(f.ctx, f.projectId, v1.asset.id, input), /crashed/);
  f.faults.checkpoint = async () => {};
  await f.restart();
  assert.deepEqual(f.library.list(f.ctx, other.id).assets, []);
  // The name stays free while nothing was saved.
  assert.equal((await f.upload('notes.md', Buffer.from('x'), { projectId: other.id })).asset.filename, 'notes.md');

  // The source changes before the retry: the retry still copies v1, verified.
  await f.upload('script.md', Buffer.from('# Take two'), { collision: 'replace', assetId: v1.asset.id });
  const payload = path.join(f.dataDir, 'retained', 'versions', v1.version.id);
  await chmod(payload, 0o600); await writeFile(payload, 'tampered!!');
  await assert.rejects(f.library.copyAsset(f.ctx, f.projectId, v1.asset.id, input), (error) => error.status === 409 && /unavailable/.test(error.message));
  assert.equal(f.library.list(f.ctx, other.id).assets.length, 1);
  await f.library.repair(f.ctx, f.projectId, v1.version.id, Buffer.from('# Take one'));
  const copied = await f.library.copyAsset(f.ctx, f.projectId, v1.asset.id, input);
  assert.deepEqual([copied.version.hash, copied.asset.copiedFrom.versionId], [sha(Buffer.from('# Take one')), v1.version.id]);
  assert.deepEqual(f.library.list(f.ctx, other.id).assets.map((asset) => asset.filename), ['notes.md', 'script.md']);
  await assert.rejects(f.library.copyAsset(f.ctx, f.projectId, v1.asset.id, { ...input, filename: 'other.md' }), (error) => error.status === 409);
});

test('a copied written document stays written text in its new project', async (t) => {
  const f = await fixture(t);
  const { project: other } = f.store.createProject(f.ctx, { name: 'Other' });
  const draft = await f.library.createDraft(f.ctx, f.projectId, { filename: 'cover.png', text: 'written' });
  const saved = await f.library.saveDraft(f.ctx, f.projectId, draft.id, { revision: draft.revision, operationId: 'doc-1' });
  const copied = await f.library.copyAsset(f.ctx, f.projectId, saved.asset.id, { targetProjectId: other.id, filename: 'cover.png', operationId: 'copy-1' });
  assert.deepEqual([copied.asset.kind, copied.version.written], ['document', true]);
  const edit = await f.library.createDraft(f.ctx, other.id, { assetId: copied.asset.id });
  assert.equal(edit.text, 'written');
});

test('over HTTP, restoring a version and copying into another project name their choices; archive and maintenance refuse both', async (t) => {
  const f = await httpFixture(t);
  const other = (await f.ok('POST', '/api/projects', { name: 'Other' })).project;
  const otherLibrary = `/api/projects/${other.id}/library`;
  const v1 = (await f.upload('script.md', Buffer.from('# Take one'))).body;
  const v2 = (await f.upload('script.md', Buffer.from('# Take two'), { collision: 'replace', asset: v1.asset.id })).body;
  const restoreUrl = `${f.library}/assets/${v1.asset.id}/restore`; const copyUrl = `${f.library}/assets/${v1.asset.id}/copy`;

  assert.equal((await f.call('POST', restoreUrl, { versionId: v1.version.id, baseVersionId: v2.version.id })).status, 400, 'an operation ID is required');
  const stale = await f.call('POST', restoreUrl, { versionId: v1.version.id, baseVersionId: v1.version.id, operation: randomUUID() });
  assert.deepEqual([stale.status, stale.body.conflict.currentVersion.id], [409, v2.version.id]);
  const restored = await f.ok('POST', restoreUrl, { versionId: v1.version.id, baseVersionId: v2.version.id, operation: 'restore-1' });
  assert.deepEqual([restored.outcome, restored.version.number, restored.version.restoredFrom], ['restored', 3, v1.version.id]);
  const detail = await f.ok('GET', `${f.library}/assets/${v1.asset.id}`);
  assert.deepEqual(detail.versions.map((version) => [version.number, version.current]), [[3, true], [2, false], [1, false]]);
  assert.deepEqual(Buffer.from(await (await f.raw(`${f.library}/versions/${restored.version.id}/content`)).arrayBuffer()), Buffer.from('# Take one'));

  const folder = await f.ok('POST', `${otherLibrary}/folders`, { name: 'Scripts' });
  const copied = await f.ok('POST', copyUrl, { targetProjectId: other.id, folderId: folder.id, filename: 'script.md', operation: 'copy-1' });
  assert.deepEqual([copied.asset.projectId, copied.asset.folderId, copied.asset.versionCount, copied.version.hash], [other.id, folder.id, 1, restored.version.hash]);
  const taken = await f.call('POST', copyUrl, { targetProjectId: other.id, folderId: folder.id, filename: 'script.md', operation: randomUUID() });
  assert.deepEqual([taken.status, taken.body.conflict.suggested, taken.body.conflict.assetId], [409, 'script (1).md', undefined]);
  for (const claim of [{ versionId: v1.version.id }, { hash: v1.version.hash }, { path: 'retained/versions/x' }]) {
    const refused = await f.call('POST', copyUrl, { targetProjectId: other.id, filename: 'claimed.md', operation: randomUUID(), ...claim });
    assert.equal(refused.status, 400, JSON.stringify(claim));
  }
  assert.deepEqual(Buffer.from(await (await f.raw(`${otherLibrary}/versions/${copied.version.id}/content`)).arrayBuffer()), Buffer.from('# Take one'));
  assert.equal((await f.raw(`${f.library}/versions/${copied.version.id}/content`)).status, 404, 'the copy belongs to its destination');

  await f.ok('POST', `/api/projects/${other.id}/archive`, {});
  assert.equal((await f.call('POST', copyUrl, { targetProjectId: other.id, filename: 'late.md', operation: randomUUID() })).status, 409);
  await f.ok('POST', `/api/projects/${other.id}/unarchive`, {});
  await f.ok('POST', `/api/projects/${f.projectId}/archive`, {});
  assert.equal((await f.call('POST', restoreUrl, { versionId: v2.version.id, baseVersionId: restored.version.id, operation: randomUUID() })).status, 409);
  assert.equal((await f.call('POST', copyUrl, { targetProjectId: other.id, filename: 'late.md', operation: randomUUID() })).status, 409);
  await f.ok('POST', `/api/projects/${f.projectId}/unarchive`, {});

  const output = await mkdtemp(path.join(tmpdir(), 'frameboard-library-export-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await f.ok('POST', '/api/maintenance/export', { output });
  assert.equal((await f.call('POST', restoreUrl, { versionId: v2.version.id, baseVersionId: restored.version.id, operation: randomUUID() })).status, 503);
  assert.equal((await f.call('POST', copyUrl, { targetProjectId: other.id, filename: 'paused.md', operation: randomUUID() })).status, 503);
  await waitFor(async () => !(await f.ok('GET', '/api/maintenance')).active);
  assert.deepEqual([(await f.ok('GET', f.library)).assets[0].versionCount, (await f.ok('GET', otherLibrary)).assets.length], [3, 1]);
});

test('export and restore keep a restored history and an independent project copy, with their own identities and bytes', async (t) => {
  const f = await httpFixture(t);
  const other = (await f.ok('POST', '/api/projects', { name: 'Other' })).project;
  const otherLibrary = `/api/projects/${other.id}/library`;
  const v1 = (await f.upload('logo.png', Buffer.from('logo one'))).body;
  const v2 = (await f.upload('logo.png', Buffer.from('logo two'), { collision: 'replace', asset: v1.asset.id })).body;
  await f.ok('POST', `${f.library}/assets/${v1.asset.id}/restore`, { versionId: v1.version.id, baseVersionId: v2.version.id, operation: 'restore-1' });
  const copied = await f.ok('POST', `${f.library}/assets/${v1.asset.id}/copy`, { targetProjectId: other.id, filename: 'logo.png', operation: 'copy-1' });
  // The source's later life never reaches the copy.
  await f.ok('DELETE', `${f.library}/assets/${v1.asset.id}`);
  await f.ok('POST', `/api/projects/${f.projectId}/archive`, {});
  const source = await f.ok('GET', `${f.library}/assets/${v1.asset.id}`);
  const copy = await f.ok('GET', `${otherLibrary}/assets/${copied.asset.id}`);
  assert.deepEqual(source.versions.map((version) => [version.number, version.restoredFrom ?? null]), [[3, v1.version.id], [2, null], [1, null]]);
  assert.deepEqual([copy.versions.length, copy.copiedFrom.versionId, copy.versions[0].hash], [1, source.versions[0].id, source.versions[0].hash]);

  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-library-copies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await f.close();
  const { backupDir } = await createBackup({ dataDir: f.dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'native') });
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  const copyEntry = manifest.inventory.retained.find((entry) => entry.versionId === copy.versions[0].id);
  assert.deepEqual([copyEntry.objectId, copyEntry.projectId, copyEntry.path === `retained/versions/${source.versions[0].id}`], [copied.asset.id, other.id, false], 'the copy has its own retained payload');
  const dataDir = path.join(root, 'restored');
  await restoreBackup({ backupDir, dataDir, codexHome: path.join(root, 'native') });
  const restored = await createApp({ dataDir, codexAdapter: new ControlledCodex(path.join(root, 'native')) });
  await new Promise((resolve) => restored.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => restored.close(resolve)));
  const base = `http://127.0.0.1:${restored.address().port}`;
  assert.deepEqual(await (await fetch(`${base}${f.library}/assets/${v1.asset.id}`)).json(), source);
  assert.deepEqual(await (await fetch(`${base}${otherLibrary}/assets/${copied.asset.id}`)).json(), copy);
  for (const [library, version, bytes] of [[f.library, source.versions[0], 'logo one'], [f.library, source.versions[1], 'logo two'], [otherLibrary, copy.versions[0], 'logo one']]) {
    assert.deepEqual(Buffer.from(await (await fetch(`${base}${library}/versions/${version.id}/content`)).arrayBuffer()), Buffer.from(bytes));
  }
});
