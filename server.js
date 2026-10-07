import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, imageIdPattern } from './store.js';
import { createCodexAdapter } from './codex-adapter.js';
import { configurationDiscovery, compileConfiguration, mandatoryBehavior } from './codex-configuration.js';
import { createChatService } from './chat-service.js';
import { createChatWorker } from './chat-worker.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const imageTypes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const staticTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function assert(value, message) {
  if (!value) throw Object.assign(new Error(message), { status: 400 });
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

async function json(req, limit) {
  try { return JSON.parse((await body(req, limit)).toString()); }
  catch (error) { if (error.status) throw error; throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

export async function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), fetch: fetchImpl = globalThis.fetch, onCardEvent, codexAdapter } = {}) {
  const imagesDir = path.join(dataDir, 'images');
  await mkdir(imagesDir, { recursive: true });
  let store; let worker;
  try { store = await openStore({ dataDir, onCardEvent, onCommit: () => worker?.wake() }); }
  catch (error) { throw new Error(`Could not load the board in ${dataDir}. Your data has not been changed. ${error.message}`); }
  // Only top-level files in public/ are served, so paths cannot escape it.
  const publicFiles = new Map((await readdir(path.join(root, 'public'))).filter((name) => staticTypes[path.extname(name)]).map((name) => [`/${name}`, name]));
  publicFiles.set('/', 'index.html');
  // There is one owner today. Sign-in will replace this with the requesting user.
  const currentUser = () => ({ workspaceId: store.owner.workspaceId, userId: store.owner.userId, actor: `user:${store.owner.userId}` });
  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const read = (req) => json(req, 12 * 1024 * 1024);
  const codex = codexAdapter ?? createCodexAdapter();
  const chat = createChatService({ store, adapter: codex, dataDir });
  worker = createChatWorker({ store, adapter: codex, service: chat, ctx: currentUser() });
  const codexAction = async (fn) => {
    try { return await fn(); } catch (error) {
      if (error.kind) Object.assign(error, { status: 503 });
      throw error;
    }
  };
  const routes = [
    ['PUT', /^\/api\/cards\/([^/]+)\/draft-lease$/, async (ctx, req, id) => store.protection.lease(ctx, id, await read(req))],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/text-preview$/, async (ctx, req, id) => store.protection.previewAcceptance(ctx, id, await read(req))],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/accept-text$/, async (ctx, req, id) => store.protection.acceptText(ctx, id, await read(req))],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/proposals\/[^/]+\/accept$/, async (ctx, req, id, url) => store.protection.accept(ctx, id, url.pathname.split('/').at(-2), await read(req))],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/proposals\/[^/]+\/preview$/, (ctx, req, id, url) => store.protection.previewProposal(ctx, id, url.pathname.split('/').at(-2))],
    ['GET', /^\/api\/chat-activity$/, (ctx) => ({ entries: store.chats.indicators(ctx) })],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/revoke-grants$/, (ctx, req, id) => store.chats.clearGrants(ctx, id)],
    ['GET', /^\/api\/cards\/([^/]+)\/chat$/, (ctx, req, id) => ({ ...store.chats.snapshot(ctx, id), proposals: store.protection.proposals(ctx, id) })],
    ['PUT', /^\/api\/cards\/([^/]+)\/chat\/composer$/, async (ctx, req, id) => store.chats.saveComposer(ctx, id, await read(req))],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/preview$/, (ctx, req, id) => chat.preview(ctx, id)],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/discover$/, (ctx, req, id) => codexAction(() => chat.discover(ctx, id))],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/submissions$/, (ctx, req, id) => codexAction(async () => chat.queue(ctx, id, await read(req))), 201],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/fresh$/, async (ctx, req, id) => store.chats.fresh(ctx, id, await read(req))],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/viewed$/, (ctx, req, id) => (store.chats.viewed(ctx, id), { ok: true })],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/stop$/, (ctx, req, id) => ({ attempt: worker.stop(id) })],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/cancel$/, async (ctx, req, id) => (store.chats.cancelSubmission(ctx, id, (await read(req)).submissionId), { ok: true })],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/retry$/, async (ctx, req, id) => store.chats.retry(ctx, id, (await read(req)).submissionId)],
    ['POST', /^\/api\/cards\/([^/]+)\/chat\/answer$/, async (ctx, req, id) => { const input = await read(req); return worker.answer(id, input.requestId, input.response); }],
    ['GET', /^\/api\/providers\/codex$/, (ctx) => ({ ...store.providerConfiguration(ctx), running: codex.running, mandatoryBehavior, discoveryRequired: true })],
    ['PUT', /^\/api\/providers\/codex$/, async (ctx, req) => store.saveProviderConfiguration(ctx, await read(req))],
    ['POST', /^\/api\/providers\/codex\/discover$/, (ctx) => codexAction(async () => {
      const discovery = await configurationDiscovery(codex);
      return { discovery, effective: compileConfiguration(store.providerConfiguration(ctx).selection, discovery) };
    })],
    ['GET', /^\/api\/workspace$/, (ctx) => store.workspace(ctx)],
    ['POST', /^\/api\/projects$/, async (ctx, req) => store.createProject(ctx, await read(req)), 201],
    ['PATCH', /^\/api\/projects\/([^/]+)$/, async (ctx, req, id) => store.updateProject(ctx, id, await read(req))],
    ['DELETE', /^\/api\/projects\/([^/]+)$/, (ctx, req, id) => (store.deleteProject(ctx, id), { ok: true })],
    ['POST', /^\/api\/projects\/([^/]+)\/prompt$/, async (ctx, req, id) => ({ cards: store.setProjectPrompt(ctx, id, (await read(req))?.prompt) })],
    ['GET', /^\/api\/projects\/([^/]+)\/cards$/, (ctx, req, id) => ({ cards: store.listCards(ctx, id) })],
    ['POST', /^\/api\/projects\/([^/]+)\/cards$/, async (ctx, req, id) => store.createCard(ctx, id, await read(req)), 201],
    ['POST', /^\/api\/flows\/([^/]+)\/stages$/, async (ctx, req, id) => store.createStage(ctx, id, await read(req)), 201],
    ['PATCH', /^\/api\/stages\/([^/]+)$/, async (ctx, req, id) => store.updateStage(ctx, id, await read(req))],
    ['DELETE', /^\/api\/stages\/([^/]+)$/, (ctx, req, id) => (store.deleteStage(ctx, id), { ok: true })],
    ['GET', /^\/api\/cards\/([^/]+)$/, (ctx, req, id) => store.getCard(ctx, id)],
    ['GET', /^\/api\/cards\/([^/]+)\/states$/, (ctx, req, id) => ({ states: store.savedCardStates(ctx, id) })],
    ['POST', /^\/api\/cards\/([^/]+)\/editing-session\/end$/, async (ctx, req, id) => (store.endEditingSession(ctx, id, await read(req)), { ok: true })],
    ['PATCH', /^\/api\/cards\/([^/]+)$/, async (ctx, req, id) => store.updateCard(ctx, id, await read(req))],
    ['DELETE', /^\/api\/cards\/([^/]+)$/, (ctx, req, id) => (store.deleteCard(ctx, id), { ok: true })],
    ['POST', /^\/api\/cards\/([^/]+)\/undo-move$/, async (ctx, req, id) => store.undoMove(ctx, id, await read(req))],
    ['POST', /^\/api\/cards\/([^/]+)\/transitions$/, async (ctx, req, id) => store.transitionCard(ctx, id, await read(req))],
    ['GET', /^\/api\/events$/, (ctx, req, id, url) => ({ events: store.events(ctx, { since: Math.max(0, Number.parseInt(url.searchParams.get('since'), 10) || 0) }) })],
  ];
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return send(res, 403, { error: 'Use localhost to access this board.' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'Cross-origin requests are not allowed.' });
      const url = new URL(req.url, `http://${host}`);
      for (const [method, pattern, handler, status = 200] of routes) {
        const match = url.pathname.match(pattern);
        if (!match || req.method !== method) continue;
        let id;
        try { id = match[1] && decodeURIComponent(match[1]); } catch { return send(res, 404, { error: 'Not found.' }); }
        return send(res, status, await handler(currentUser(req), req, id, url));
      }
      if (url.pathname === '/api/images' && req.method === 'POST') {
        const type = req.headers['content-type'];
        assert(Object.hasOwn(imageTypes, type || ''), 'Use a PNG, JPEG, WebP, GIF, or AVIF image.');
        const bytes = await body(req, 20 * 1024 * 1024);
        assert(isImage(bytes, type), 'This file does not contain a supported image.');
        const id = `${randomUUID()}.${imageTypes[type]}`;
        await writeFile(path.join(imagesDir, id), bytes);
        return send(res, 201, { id });
      }
      if (url.pathname === '/api/youtube' && req.method === 'POST') {
        const videoId = youtubeVideoId((await json(req, 16 * 1024))?.url);
        assert(videoId, 'Enter a YouTube video URL, such as https://www.youtube.com/watch?v=…');
        const { title, thumbnail } = await fetchYoutube(videoId, fetchImpl);
        const id = `${randomUUID()}.jpg`;
        await writeFile(path.join(imagesDir, id), thumbnail);
        return send(res, 201, { title, image: { id, name: `${title || videoId} thumbnail.jpg`.slice(0, 500) } });
      }
      if (url.pathname.startsWith('/api/')) return send(res, routes.some(([, pattern]) => pattern.test(url.pathname)) ? 405 : 404, { error: 'Not found.' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
      let filename;
      let type;
      if (url.pathname.startsWith('/images/')) {
        const id = url.pathname.slice(8);
        if (!imageIdPattern.test(id)) return send(res, 404, { error: 'Image not found.' });
        filename = path.join(imagesDir, id);
        type = Object.entries(imageTypes).find(([, extension]) => extension === id.split('.').pop())[0];
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        const file = publicFiles.get(url.pathname);
        if (!file) return send(res, 404, { error: 'Not found.' });
        filename = path.join(root, 'public', file);
        type = `${staticTypes[path.extname(file)]}; charset=utf-8`;
        res.setHeader('Cache-Control', 'no-cache');
      }
      const bytes = await readFile(filename);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (!res.headersSent) send(res, error.code === 'ENOENT' ? 404 : error.status || 500, { error: error.status ? error.message : error.code === 'ENOENT' ? 'Not found.' : 'Could not save or load data. Check available disk space and try again.' });
      else res.end();
      if (!error.status && error.code !== 'ENOENT') console.error(error);
    }
  });
  server.on('close', () => { worker.close(); store.close(); codex.close().catch((error) => console.error(error)); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = await createApp();
  app.listen(port, '127.0.0.1', () => console.log(`\n  Frameboard is ready → http://localhost:${port}\n  Your data lives in ${process.env.DATA_DIR || path.join(root, 'data')}\n`));
}
