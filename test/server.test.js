import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server.js';

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-test-'));
  const app = await createApp({ dataDir });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  return { base, app, dataDir, get: async () => (await fetch(`${base}/api/board`)).json(), put: (state) => fetch(`${base}/api/board`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) }) };
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');

test('creates a usable board and persists card text and lane changes to disk', async (t) => {
  const f = await fixture(t);
  const state = await f.get();
  assert.equal(state.board.projects[0].lanes.length, 4);
  const lanes = state.board.projects[0].lanes;
  lanes[0].name = 'New ideas';
  lanes[1].cards.push({ id: 'card-1', title: 'A film idea', titleOptions: 'First title\nAnother angle', intro: 'A hook\nwith two lines', script: 'Full script', images: [], coverImageId: null, updatedAt: '2026-09-20T12:34:56.789Z' });
  Object.assign(lanes[1].cards[0], { originalVideoTitle: 'An inspiring video', originalVideoUrl: 'https://example.com/inspiration?v=1&list=2', publishedVideoUrl: 'https://example.com/published' });
  assert.equal((await f.put(state)).status, 200);
  const disk = JSON.parse(await readFile(path.join(f.dataDir, 'board.json'), 'utf8'));
  assert.equal(disk.revision, 1);
  assert.equal(disk.board.projects[0].lanes[1].cards[0].intro, 'A hook\nwith two lines');
  assert.equal(disk.board.projects[0].lanes[1].cards[0].titleOptions, 'First title\nAnother angle');
  assert.equal(disk.board.projects[0].lanes[1].cards[0].updatedAt, '2026-09-20T12:34:56.789Z');
  assert.equal(disk.board.projects[0].lanes[1].cards[0].originalVideoTitle, 'An inspiring video');
  assert.equal(disk.board.projects[0].lanes[1].cards[0].originalVideoUrl, 'https://example.com/inspiration?v=1&list=2');
  assert.equal(disk.board.projects[0].lanes[1].cards[0].publishedVideoUrl, 'https://example.com/published');
  const reopened = await createApp({ dataDir: f.dataDir });
  await new Promise((resolve) => reopened.listen(0, '127.0.0.1', resolve));
  const loaded = await (await fetch(`http://127.0.0.1:${reopened.address().port}/api/board`)).json();
  assert.deepEqual(loaded, disk);
  await new Promise((resolve) => reopened.close(resolve));
});

test('uploads original image bytes and persists the selected display image', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/api/images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const image = await fetch(`${f.base}/images/${id}`);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const state = await f.get();
  state.board.projects[0].lanes[0].cards.push({ id: 'card', title: 'Image card', intro: '', script: '', images: [{ id, name: 'image.png' }], coverImageId: id });
  assert.equal((await f.put(state)).status, 200);
  assert.equal((await f.get()).board.projects[0].lanes[0].cards[0].coverImageId, id);
});

test('rejects stale and concurrent saves instead of overwriting another tab', async (t) => {
  const f = await fixture(t);
  const state = await f.get();
  const responses = await Promise.all([f.put(state), f.put(state)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await f.get()).revision, 1);
});

test('invalid card data cannot replace the saved board', async (t) => {
  const f = await fixture(t);
  const state = await f.get();
  state.board.projects[0].lanes[0].cards.push({ id: 'broken', title: '', intro: '', script: '', images: [], coverImageId: 'missing' });
  assert.equal((await f.put(state)).status, 400);
  assert.equal((await f.get()).revision, 0);
  assert.equal((await f.put(null)).status, 400);
});

test('rejects duplicate IDs and empty lane names', async (t) => {
  const f = await fixture(t);
  const state = await f.get();
  state.board.projects[0].lanes[0].id = state.board.projects[0].id;
  assert.equal((await f.put(state)).status, 400);
  const next = await f.get();
  next.board.projects[0].lanes[0].name = '  ';
  assert.equal((await f.put(next)).status, 400);
});

test('saves all additional lane colors and rejects invalid edit timestamps', async (t) => {
  const f = await fixture(t);
  for (const color of ['teal', 'cyan', 'orange', 'red', 'purple', 'lime']) {
    const state = await f.get();
    state.board.projects[0].lanes[0].color = color;
    assert.equal((await f.put(state)).status, 200);
    assert.equal((await f.get()).board.projects[0].lanes[0].color, color);
  }
  const state = await f.get();
  const card = { id: 'legacy-card', title: '', intro: '', script: '', images: [], coverImageId: null };
  state.board.projects[0].lanes[0].cards.push(card);
  assert.equal((await f.put(state)).status, 200);
  const saved = await f.get();
  assert.equal(saved.board.projects[0].lanes[0].cards[0].updatedAt, undefined);
  for (const value of [null, 123, 'invalid', '2026-09-20', '2026-02-30T12:34:56.789Z']) {
    saved.board.projects[0].lanes[0].cards[0].updatedAt = value;
    assert.equal((await f.put(saved)).status, 400);
  }
});

test('rejects unsupported, disguised, and oversized image uploads', async (t) => {
  const f = await fixture(t);
  for (const [type, body] of [['image/svg+xml', '<svg/>'], ['image/png', 'not a PNG']]) {
    assert.equal((await fetch(`${f.base}/api/images`, { method: 'POST', headers: { 'Content-Type': type }, body })).status, 400);
  }
  assert.equal((await fetch(`${f.base}/api/images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(20 * 1024 * 1024 + 1) })).status, 413);
});

test('blocks cross-origin writes, untrusted hosts, and non-public files', async (t) => {
  const f = await fixture(t);
  const state = await f.get();
  assert.equal((await fetch(`${f.base}/api/board`, { method: 'PUT', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify(state) })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(`${f.base}/api/board`, { headers: { Host: 'example.com' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  for (const url of ['/data/board.json', '/server.js', '/images/%2e%2e%2fboard.json']) assert.equal((await fetch(`${f.base}${url}`)).status, 404);
  const page = await fetch(f.base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('keeps a corrupt data file intact and reports a startup error', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-corrupt-'));
  try {
    await writeFile(path.join(dataDir, 'board.json'), 'not json');
    await assert.rejects(createApp({ dataDir }), /Your data has not been changed/);
    assert.equal(await readFile(path.join(dataDir, 'board.json'), 'utf8'), 'not json');
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('recognizes YouTube video links and rejects other URLs', async () => {
  const { youtubeVideoId } = await import('../server.js');
  for (const url of ['https://www.youtube.com/watch?v=62NJbICVWkQ&t=4s', 'https://youtu.be/62NJbICVWkQ?si=x', 'https://m.youtube.com/shorts/62NJbICVWkQ', 'https://www.youtube.com/live/62NJbICVWkQ']) {
    assert.equal(youtubeVideoId(url), '62NJbICVWkQ', url);
  }
  for (const url of ['https://example.com/watch?v=62NJbICVWkQ', 'https://www.youtube.com/@channel', 'not a url']) assert.equal(youtubeVideoId(url), null, url);
});

test('fetches a YouTube title and stores its thumbnail as a local image', async (t) => {
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16]);
  const requested = [];
  const fakeFetch = async (url) => {
    requested.push(url);
    if (url.startsWith('https://www.youtube.com/oembed')) return new Response(JSON.stringify({ title: 'A great video' }));
    if (url.includes('maxresdefault')) return new Response('', { status: 404 });
    return new Response(jpeg);
  };
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-test-'));
  const app = await createApp({ dataDir, fetch: fakeFetch });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (url) => fetch(`${base}/api/youtube`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  const response = await post('https://youtu.be/62NJbICVWkQ');
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.title, 'A great video');
  assert.match(result.image.id, /^[a-f0-9-]{36}\.jpg$/);
  assert.equal(result.image.name, 'A great video thumbnail.jpg');
  assert.ok(requested.some((url) => url.endsWith('/vi/62NJbICVWkQ/hqdefault.jpg')));
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/images/${result.image.id}`)).arrayBuffer()), jpeg);
  assert.equal((await post('https://example.com/video')).status, 400);
});

test('moves cards saved with muse video fields to the original video fields', async (t) => {
  const f = await fixture(t);
  const state = await f.get();
  state.board.projects[0].lanes[0].cards.push(
    { id: 'old', title: 'Old card', intro: '', script: '', images: [], coverImageId: null, museVideoTitle: 'Old title', museVideoUrl: 'https://youtu.be/62NJbICVWkQ' },
    { id: 'both', title: 'Both', intro: '', script: '', images: [], coverImageId: null, museVideoUrl: 'https://old.example', originalVideoUrl: 'https://kept.example' },
  );
  await writeFile(path.join(f.dataDir, 'board.json'), JSON.stringify(state));
  const reopened = await createApp({ dataDir: f.dataDir });
  await new Promise((resolve) => reopened.listen(0, '127.0.0.1', resolve));
  const [old, both] = (await (await fetch(`http://127.0.0.1:${reopened.address().port}/api/board`)).json()).board.projects[0].lanes[0].cards;
  await new Promise((resolve) => reopened.close(resolve));
  assert.deepEqual([old.originalVideoTitle, old.originalVideoUrl, 'museVideoUrl' in old, 'museVideoTitle' in old], ['Old title', 'https://youtu.be/62NJbICVWkQ', false, false]);
  assert.equal(both.originalVideoUrl, 'https://kept.example');
});
