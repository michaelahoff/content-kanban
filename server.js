import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const imageTypes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const imageIdPattern = /^[a-f0-9-]{36}\.(png|jpg|webp|gif|avif)$/;
const colors = ['lavender', 'blue', 'amber', 'green', 'pink', 'gray', 'teal', 'cyan', 'orange', 'red', 'purple', 'lime'];

export function newBoard() {
  return { projects: [{ id: randomUUID(), name: 'My project', lanes: [
    ['Ideas', 'lavender'], ['In progress', 'blue'], ['Review', 'amber'], ['Done', 'green'],
  ].map(([name, color]) => ({ id: randomUUID(), name, color, cards: [] })) }] };
}

function assert(value, message) {
  if (!value) throw Object.assign(new Error(message), { status: 400 });
}

// Cards saved before the rename kept the original video under "muse" keys.
export function migrateBoard(board) {
  for (const card of (board?.projects || []).flatMap((project) => project?.lanes || []).flatMap((lane) => lane?.cards || [])) {
    if (!card || typeof card !== 'object') continue;
    for (const [from, to] of [['museVideoUrl', 'originalVideoUrl'], ['museVideoTitle', 'originalVideoTitle']]) {
      if (!(from in card)) continue;
      if (!card[to]) card[to] = card[from];
      delete card[from];
    }
  }
  return board;
}

export function validateBoard(board) {
  const ids = new Set();
  const string = (value, max) => typeof value === 'string' && value.length <= max;
  const entity = (item) => {
    assert(item && string(item.id, 100) && item.id.length && !ids.has(item.id), 'Invalid or duplicate ID.');
    ids.add(item.id);
  };
  assert(board && Array.isArray(board.projects) && board.projects.length <= 200, 'Invalid project list.');
  for (const project of board.projects) {
    entity(project);
    assert(string(project.name, 150) && project.name.trim(), 'Projects need a name (up to 150 characters).');
    assert(Array.isArray(project.lanes) && project.lanes.length <= 100, 'Invalid lane list.');
    for (const lane of project.lanes) {
      entity(lane);
      assert(string(lane.name, 100) && lane.name.trim() && colors.includes(lane.color), 'Invalid lane.');
      assert(Array.isArray(lane.cards) && lane.cards.length <= 10000, 'Invalid card list.');
      for (const card of lane.cards) {
        entity(card);
        assert(string(card.title, 500) && string(card.intro, 200000) && string(card.script, 1000000), 'Invalid card text.');
        assert(card.titleOptions === undefined || string(card.titleOptions, 200000), 'Invalid title options.');
        assert(card.prompt === undefined || string(card.prompt, 200000), 'Invalid card prompt.');
        assert(card.originalVideoTitle === undefined || string(card.originalVideoTitle, 500), 'Invalid original video title.');
        for (const field of ['originalVideoUrl', 'publishedVideoUrl']) {
          assert(card[field] === undefined || string(card[field], 4096), 'Video URLs must be text of up to 4096 characters.');
        }
        assert(card.updatedAt === undefined || (string(card.updatedAt, 24) && Number.isFinite(Date.parse(card.updatedAt)) && new Date(card.updatedAt).toISOString() === card.updatedAt), 'Invalid last-edited timestamp.');
        assert(Array.isArray(card.images) && card.images.length <= 200, 'Invalid card images.');
        const images = new Set();
        for (const image of card.images) {
          assert(image && imageIdPattern.test(image.id) && string(image.name, 500) && !images.has(image.id), 'Invalid image.');
          images.add(image.id);
        }
        assert(card.coverImageId === null || images.has(card.coverImageId), 'The display image must belong to the card.');
        for (const field of ['originalImageId', 'inspirationImageId']) {
          assert(card[field] === undefined || card[field] === null || images.has(card[field]), 'Flagged images must belong to the card.');
        }
      }
    }
  }
}

async function body(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('This file or board is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isImage(bytes, type) {
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/gif') return /^GIF8[79]a/.test(bytes.toString('ascii', 0, 6));
  if (type === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (type === 'image/avif') return bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32));
  return false;
}

export function youtubeVideoId(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { return null; }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  const id = host === 'youtu.be' ? url.pathname.split('/')[1]
    : host === 'youtube.com' || host === 'youtube-nocookie.com'
      ? url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/)?.[1]
      : null;
  return /^[\w-]{11}$/.test(id || '') ? id : null;
}

// Looks up a YouTube video's title and downloads its largest available thumbnail.
async function fetchYoutube(videoId, fetchImpl) {
  const get = (url) => fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  const unreachable = () => Object.assign(new Error('Could not reach YouTube. Check your internet connection and try again.'), { status: 502 });
  let info;
  try { info = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`); }
  catch { throw unreachable(); }
  if (info.status === 401 || info.status === 403 || info.status === 404) throw Object.assign(new Error('YouTube could not find this video, or it is private.'), { status: 404 });
  if (!info.ok) throw unreachable();
  const { title } = await info.json();
  for (const size of ['maxresdefault', 'hqdefault']) {
    let response;
    try { response = await get(`https://i.ytimg.com/vi/${videoId}/${size}.jpg`); } catch { throw unreachable(); }
    if (!response.ok) continue;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (isImage(bytes, 'image/jpeg')) return { title: String(title || '').slice(0, 500), thumbnail: bytes };
  }
  throw Object.assign(new Error('YouTube did not return a thumbnail for this video.'), { status: 502 });
}

export async function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), fetch: fetchImpl = globalThis.fetch } = {}) {
  const imagesDir = path.join(dataDir, 'images');
  const boardFile = path.join(dataDir, 'board.json');
  await mkdir(imagesDir, { recursive: true });
  let state;
  try {
    state = JSON.parse(await readFile(boardFile, 'utf8'));
    validateBoard(migrateBoard(state.board));
    if (!Number.isInteger(state.revision)) throw new Error('Invalid saved board revision.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not load ${boardFile}. Your data has not been changed. ${error.message}`);
    state = { revision: 0, board: newBoard() };
    await writeFile(boardFile, JSON.stringify(state, null, 2));
  }
  let writeQueue = Promise.resolve();
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return json(res, 403, { error: 'Use localhost to access this board.' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === '/api/board' && req.method === 'GET') return json(res, 200, state);
      if (url.pathname === '/api/board' && req.method === 'PUT') {
        let update;
        try { update = JSON.parse((await body(req, 12 * 1024 * 1024)).toString()); }
        catch (error) { if (error.status) throw error; return json(res, 400, { error: 'Invalid JSON.' }); }
        assert(update && typeof update === 'object', 'Invalid update.');
        validateBoard(migrateBoard(update.board));
        const save = writeQueue.then(async () => {
          if (update.revision !== state.revision) return json(res, 409, { error: 'This board changed in another tab. Copy any unsaved text, then reload to get the latest version.' });
          const next = { revision: state.revision + 1, board: update.board };
          await writeFile(`${boardFile}.tmp`, JSON.stringify(next, null, 2));
          await rename(`${boardFile}.tmp`, boardFile);
          state = next;
          json(res, 200, { revision: state.revision });
        });
        writeQueue = save.catch(() => {});
        await save;
        return;
      }
      if (url.pathname === '/api/images' && req.method === 'POST') {
        const type = req.headers['content-type'];
        assert(Object.hasOwn(imageTypes, type || ''), 'Use a PNG, JPEG, WebP, GIF, or AVIF image.');
        const bytes = await body(req, 20 * 1024 * 1024);
        assert(isImage(bytes, type), 'This file does not contain a supported image.');
        const id = `${randomUUID()}.${imageTypes[type]}`;
        await writeFile(path.join(imagesDir, id), bytes);
        return json(res, 201, { id });
      }
      if (url.pathname === '/api/youtube' && req.method === 'POST') {
        let videoUrl;
        try { videoUrl = JSON.parse((await body(req, 16 * 1024)).toString()).url; }
        catch (error) { if (error.status) throw error; return json(res, 400, { error: 'Invalid JSON.' }); }
        const videoId = youtubeVideoId(videoUrl);
        assert(videoId, 'Enter a YouTube video URL, such as https://www.youtube.com/watch?v=…');
        const { title, thumbnail } = await fetchYoutube(videoId, fetchImpl);
        const id = `${randomUUID()}.jpg`;
        await writeFile(path.join(imagesDir, id), thumbnail);
        return json(res, 201, { title, image: { id, name: `${title || videoId} thumbnail.jpg`.slice(0, 500) } });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
      let filename;
      let type;
      if (url.pathname.startsWith('/images/')) {
        const id = url.pathname.slice(8);
        if (!imageIdPattern.test(id)) return json(res, 404, { error: 'Image not found.' });
        filename = path.join(imagesDir, id);
        type = Object.entries(imageTypes).find(([, extension]) => extension === id.split('.').pop())[0];
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/trifecta.js': ['trifecta.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
        const file = files[url.pathname];
        if (!file) return json(res, 404, { error: 'Not found.' });
        filename = path.join(root, 'public', file[0]);
        type = `${file[1]}; charset=utf-8`;
        res.setHeader('Cache-Control', 'no-cache');
      }
      const bytes = await readFile(filename);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (!res.headersSent) json(res, error.code === 'ENOENT' ? 404 : error.status || 500, { error: error.status ? error.message : error.code === 'ENOENT' ? 'Not found.' : 'Could not save or load data. Check available disk space and try again.' });
      else res.end();
      if (!error.status && error.code !== 'ENOENT') console.error(error);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = await createApp();
  app.listen(port, '127.0.0.1', () => console.log(`\n  Frameboard is ready → http://localhost:${port}\n  Your data lives in ${process.env.DATA_DIR || path.join(root, 'data')}\n`));
}
