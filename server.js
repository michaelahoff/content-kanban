import http from 'node:http';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, imageIdPattern } from './store.js';
import { createClaudeAdapter } from './claude-adapter.js';
import { createProviderService } from './provider-service.js';
import { createCodexAdapter } from './codex-adapter.js';
import { configurationDiscovery, compileConfiguration, mandatoryBehavior } from './codex-configuration.js';
import { createChatService } from './chat-service.js';
import { createChatWorker } from './chat-worker.js';
import { createEventStream } from './event-stream.js';
import { imageFormat, storeImage, verifiedImage, maxImageBytes } from './image-files.js';
import { lockDataDirectory } from './data-lock.js';

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
    if (imageFormat(bytes) === 'jpg') return { title: String(title || '').slice(0, 500), thumbnail: bytes };
  }
  throw Object.assign(new Error('YouTube did not return a thumbnail for this video.'), { status: 502 });
}

async function json(req, limit) {
  try { return JSON.parse((await body(req, limit)).toString()); }
  catch (error) { if (error.status) throw error; throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

export async function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), fetch: fetchImpl = globalThis.fetch, onCardEvent, codexAdapter, claudeAdapter, providerBackoffMs, streamReplayLimit } = {}) {
  const lock = await lockDataDirectory(dataDir);
  dataDir = lock.dataDir;
  let store; let worker; let stream;
  try {
    const imagesDir = path.join(dataDir, 'images');
    await mkdir(imagesDir, { recursive: true });
    try { store = await openStore({ dataDir, onCardEvent, onCommit: () => { worker?.wake(); stream?.notify(); } }); }
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
    const claude = claudeAdapter ?? createClaudeAdapter();
    const adapters = { codex, claude };
    const providers = createProviderService({ store, adapters });
    const chat = createChatService({ store, adapter: codex, adapters, providers, dataDir });
    stream = createEventStream({ store, replayLimit: streamReplayLimit });
    worker = createChatWorker({ store, adapter: codex, adapters, service: chat, ctx: currentUser(), providerBackoffMs,
      onDelta: (delta) => stream.delta(currentUser().workspaceId, delta) });
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
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/outputs\/[^/]+\/adopt$/, (ctx, req, id, url) => store.images.adopt(ctx, id, url.pathname.split('/').at(-2))],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/outputs\/[^/]+\/retry-save$/, (ctx, req, id, url) => worker.retrySave(id, url.pathname.split('/').at(-2))],
      ['GET', /^\/api\/chat-activity$/, (ctx) => ({ cursor: store.workspace(ctx).eventCursor, entries: store.chats.indicators(ctx) })],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/revoke-grants$/, (ctx, req, id) => store.chats.clearGrants(ctx, id)],
      ['GET', /^\/api\/cards\/([^/]+)\/chat$/, (ctx, req, id) => (worker.flushCard(id), { ...store.chats.snapshot(ctx, id), proposals: store.protection.proposals(ctx, id), outputs: store.images.outputs(ctx, id).map((output) => ({ ...output, available: Boolean(output.imageId) && existsSync(path.join(imagesDir, output.imageId)) })) })],
      ['PUT', /^\/api\/cards\/([^/]+)\/chat\/composer$/, async (ctx, req, id) => store.chats.saveComposer(ctx, id, await read(req))],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/preview$/, (ctx, req, id) => chat.preview(ctx, id)],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/discover$/, (ctx, req, id) => codexAction(() => chat.discover(ctx, id))],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/submissions$/, (ctx, req, id) => codexAction(async () => chat.queue(ctx, id, await read(req))), 201],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/fresh$/, async (ctx, req, id) => store.chats.fresh(ctx, id, await read(req))],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/viewed$/, (ctx, req, id) => (store.chats.viewed(ctx, id), { ok: true })],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/reconcile$/, (ctx, req, id) => codexAction(() => worker.reconcileCard(id))],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/continue$/, async (ctx, req, id) => store.chats.continueOutside(ctx, id, (await read(req))?.submissionId)],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/resolve$/, async (ctx, req, id) => store.chats.resolve(ctx, id, (await read(req))?.attemptId)],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/stop$/, (ctx, req, id) => ({ attempt: worker.stop(id) })],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/cancel$/, async (ctx, req, id) => (store.chats.cancelSubmission(ctx, id, (await read(req)).submissionId), { ok: true })],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/retry$/, async (ctx, req, id) => store.chats.retry(ctx, id, (await read(req)).submissionId)],
      ['POST', /^\/api\/cards\/([^/]+)\/chat\/answer$/, async (ctx, req, id) => { const input = await read(req); return worker.answer(id, input.requestId, input.response); }],
      ['GET', /^\/api\/settings$/, (ctx) => providers.snapshot(ctx)],
      ['GET', /^\/api\/models$/, (ctx) => providers.catalog(ctx)],
      ['POST', /^\/api\/models\/refresh$/, (ctx) => providers.catalog(ctx, { refresh: true })],
      ['GET', /^\/api\/providers\/(codex|claude)$/, (ctx, req, provider) => ({ ...store.providerConfiguration(ctx, provider), running: adapters[provider].running,
        ...store.providerCatalog(ctx, provider), mandatoryBehavior: provider === 'codex' ? mandatoryBehavior : ['Claude uses your installed Claude Code authentication and native conversation history. Card chats support text and image references; native tools are disabled.'], discoveryRequired: false })],
      ['PUT', /^\/api\/providers\/(codex|claude)$/, async (ctx, req, provider) => store.saveProviderConfiguration(ctx, await read(req), provider)],
      ['POST', /^\/api\/providers\/(codex|claude)\/discover$/, (ctx, req, provider) => codexAction(() => providers.refresh(ctx, provider))],
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
        if (url.pathname === '/api/stream' && req.method === 'GET') {
          const cursor = req.headers['last-event-id'] ?? url.searchParams.get('since');
          assert(cursor === null || /^\d{1,15}$/.test(cursor), 'Invalid stream cursor.');
          return stream.open(currentUser(req), req, res, cursor === null ? undefined : Number(cursor));
        }
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
          const bytes = await body(req, maxImageBytes);
          assert(imageFormat(bytes) === imageTypes[type], 'This file does not contain a supported image.');
          const version = store.images.record(currentUser(req), await storeImage(imagesDir, bytes), 'upload');
          return send(res, 201, { id: version.id, hash: version.hash });
        }
        if (url.pathname === '/api/youtube' && req.method === 'POST') {
          const videoId = youtubeVideoId((await json(req, 16 * 1024))?.url);
          assert(videoId, 'Enter a YouTube video URL, such as https://www.youtube.com/watch?v=…');
          const { title, thumbnail } = await fetchYoutube(videoId, fetchImpl);
          const { id } = store.images.record(currentUser(req), await storeImage(imagesDir, thumbnail), 'youtube');
          return send(res, 201, { title, image: { id, name: `${title || videoId} thumbnail.jpg`.slice(0, 500) } });
        }
        if (url.pathname.startsWith('/api/')) return send(res, routes.some(([, pattern]) => pattern.test(url.pathname)) ? 405 : 404, { error: 'Not found.' });
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
        let bytes;
        let type;
        if (url.pathname.startsWith('/images/')) {
          const id = url.pathname.slice(8);
          if (!imageIdPattern.test(id)) return send(res, 404, { error: 'Image not found.' });
          // Recorded versions are served only when their bytes match the hash.
          // Images from before the hashed store have no recorded hash.
          bytes = await verifiedImage(imagesDir, id, store.images.version(id)?.hash);
          type = Object.entries(imageTypes).find(([, extension]) => extension === id.split('.').pop())[0];
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          const file = publicFiles.get(url.pathname);
          if (!file) return send(res, 404, { error: 'Not found.' });
          bytes = await readFile(path.join(root, 'public', file));
          type = `${staticTypes[path.extname(file)]}; charset=utf-8`;
          res.setHeader('Cache-Control', 'no-cache');
        }
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch (error) {
        if (!res.headersSent) send(res, error.code === 'ENOENT' ? 404 : error.status || 500, { error: error.status ? error.message : error.code === 'ENOENT' ? 'Not found.' : 'Could not save or load data. Check available disk space and try again.' });
        else res.end();
        if (!error.status && error.code !== 'ENOENT') console.error(error);
      }
    });
    // Open event streams would otherwise keep close() waiting forever.
    const close = server.close.bind(server);
    let closing;
    server.close = (callback) => {
      if (!closing) {
        worker.close(); stream.close();
        const stopped = Promise.all([codex.close(), claude.close()]).catch((error) => console.error(error));
        closing = new Promise((resolve) => close(resolve)).then(async (error) => {
          await stopped;
          await chat.drain();
          // An HTTP request already in progress may have rediscovered Codex
          // during shutdown. Finish its filesystem work and stop that process.
          await providers.drain();
          await Promise.all([codex.close(), claude.close()]);
          return error;
        }).finally(() => { try { store.close(); } finally { lock.release(); } });
      }
      closing.then((error) => callback?.(error), (error) => callback?.(error));
      return server;
    };
    return server;
  } catch (error) {
    worker?.close(); stream?.close(); store?.close(); lock.release();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = await createApp();
  app.listen(port, '127.0.0.1', () => console.log(`\n  Frameboard is ready → http://localhost:${port}\n  Your data lives in ${process.env.DATA_DIR || path.join(root, 'data')}\n`));
}
