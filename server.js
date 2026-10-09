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
import { createLaneRunner } from './lane-runner.js';
import { createEventStream } from './event-stream.js';
import { imageFormat, storeImage, verifiedImage, maxImageBytes } from './image-files.js';
import { lockDataDirectory } from './data-lock.js';
import { createBackup } from './backup.js';
import { createMaintenance, maintenanceMessage } from './maintenance.js';
import { homedir } from 'node:os';
import { assetPreview } from './public/library-format.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const imageTypes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const staticTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function assert(value, message) {
  if (!value) throw Object.assign(new Error(message), { status: 400 });
}

// Library uploads carry metadata in the query string and bytes in the body.
// Frameboard computes hashes, sizes and storage locations itself.
const uploadParameters = new Set(['filename', 'operation', 'collision', 'asset', 'folder']);
function uploadInput(url) {
  for (const key of url.searchParams.keys()) assert(uploadParameters.has(key), 'Uploads take only a filename, folder, operation and collision choice. Frameboard computes hashes and storage locations itself.');
  const operation = url.searchParams.get('operation');
  assert(/^[\w-]{1,100}$/.test(operation || ''), 'Each upload needs an operation ID.');
  return { filename: url.searchParams.get('filename'), operationId: operation, collision: url.searchParams.get('collision') || undefined,
    assetId: url.searchParams.get('asset') || undefined, folderId: url.searchParams.get('folder') || null };
}
// Restores and copies name versions, projects and labels, never bytes or
// paths: only the listed fields and an operation ID are accepted.
function libraryChoices(input, fields, action) {
  assert(input && typeof input === 'object' && Object.keys(input).every((key) => key === 'operation' || fields.includes(key)), `${action} takes only ${fields.join(', ')} and an operation ID.`);
  assert(/^[\w-]{1,100}$/.test(input.operation || ''), `Each ${action.toLowerCase()} needs an operation ID.`);
  const { operation, ...choices } = input;
  return { ...choices, operationId: operation };
}
// Stops a publication when the uploading client disconnects.
function uploadSignal(req) {
  const controller = new AbortController();
  req.once('close', () => { if (!req.complete) controller.abort(new Error('The upload was interrupted before all bytes arrived.')); });
  return controller.signal;
}
const rfc5987 = (value) => encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const disposition = (kind, filename) => `${kind}; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${rfc5987(filename)}`;

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

export async function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), fetch: fetchImpl = globalThis.fetch, onCardEvent, codexAdapter, claudeAdapter, providerBackoffMs, streamReplayLimit, backupCheckpoint } = {}) {
  const lock = await lockDataDirectory(dataDir);
  dataDir = lock.dataDir;
  let store; let worker; let stream; let lanes; let maintenance;
  try {
    const imagesDir = path.join(dataDir, 'images');
    await mkdir(imagesDir, { recursive: true });
    try { store = await openStore({ dataDir, onCardEvent, onCommit: () => { worker?.wake(); lanes?.wake(); stream?.notify(); } }); }
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
    await Promise.all(Object.values(adapters).map((adapter) => adapter.protectRetainedData?.(dataDir)));
    const providers = createProviderService({ store, adapters });
    const chat = createChatService({ store, adapter: codex, adapters, providers, dataDir });
    stream = createEventStream({ store, replayLimit: streamReplayLimit });
    const paused = () => Boolean(maintenance?.active);
    worker = createChatWorker({ store, adapter: codex, adapters, service: chat, ctx: currentUser(), providerBackoffMs, paused,
      onDelta: (delta) => stream.delta(currentUser().workspaceId, delta) });
    lanes = createLaneRunner({ store, service: chat, providers, ctx: currentUser(), paused });
    // Native files are collected from the home the harness reports in use.
    const codexHome = async () => {
      try { return (await codex.discover({})).harness.codexHome; }
      catch { return process.env.CODEX_HOME || path.join(homedir(), '.codex'); }
    };
    maintenance = createMaintenance({ store, ctx: currentUser(), worker, lanes, dataDir, codexHome,
      settle: async () => { await chat.drain(); await providers.drain(); },
      exportWorkspace: (options) => createBackup({ ...options, checkpoint: backupCheckpoint }) });
    // Running work may finish during maintenance: Stop and request answers stay
    // available. Every other mutating route, including new ones, is refused.
    const finishesRunningWork = (pathname) => /^\/api\/cards\/[^/]+\/chat\/(stop|answer)$/.test(pathname);
    lanes.wake();
    const flowFor = (ctx, flowId) => {
      const flow = store.workspace(ctx).flows.find((entry) => entry.id === flowId);
      if (!flow) throw Object.assign(new Error('This project no longer exists. Reload the page.'), { status: 404 });
      return flow;
    };
    const bodyOf = (input) => { assert(input && typeof input === 'object', 'Invalid playbook document.'); return input; };
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
        ...store.providerCatalog(ctx, provider), mandatoryBehavior: provider === 'codex' ? mandatoryBehavior : ['Claude uses your installed Claude Code authentication and native conversation history. Card chats support full text and PNG, JPEG, GIF and WebP image references. Native tools are disabled, so other Library files, including PDFs, audio and video, cannot be sent to Claude.'], discoveryRequired: false })],
      ['PUT', /^\/api\/providers\/(codex|claude)$/, async (ctx, req, provider) => store.saveProviderConfiguration(ctx, await read(req), provider)],
      ['POST', /^\/api\/providers\/(codex|claude)\/discover$/, (ctx, req, provider) => codexAction(() => providers.refresh(ctx, provider))],
      ['GET', /^\/api\/workspace$/, (ctx) => store.workspace(ctx)],
      ['POST', /^\/api\/projects$/, async (ctx, req) => store.createProject(ctx, await read(req)), 201],
      ['PATCH', /^\/api\/projects\/([^/]+)$/, async (ctx, req, id) => store.updateProject(ctx, id, await read(req))],
      ['DELETE', /^\/api\/projects\/([^/]+)$/, (ctx, req, id) => (store.deleteProject(ctx, id), { ok: true })],
      ['POST', /^\/api\/projects\/([^/]+)\/archive$/, (ctx, req, id) => store.archiveProject(ctx, id)],
      ['POST', /^\/api\/projects\/([^/]+)\/unarchive$/, (ctx, req, id) => store.unarchiveProject(ctx, id)],
      ['POST', /^\/api\/projects\/([^/]+)\/prompt$/, async (ctx, req, id) => ({ cards: store.setProjectPrompt(ctx, id, (await read(req))?.prompt) })],
      ['GET', /^\/api\/projects\/([^/]+)\/library$/, (ctx, req, id) => store.library.list(ctx, id)],
      ['POST', /^\/api\/projects\/([^/]+)\/library\/uploads$/, (ctx, req, id, url) => store.library.upload(ctx, id, uploadInput(url), req, { signal: uploadSignal(req) }), 201],
      ['GET', /^\/api\/projects\/([^/]+)\/library\/assets\/[^/]+$/, (ctx, req, id, url) => store.library.asset(ctx, id, url.pathname.split('/').at(-1))],
      ['PATCH', /^\/api\/projects\/([^/]+)\/library\/assets\/[^/]+$/, async (ctx, req, id, url) => store.library.updateAsset(ctx, id, url.pathname.split('/').at(-1), await read(req))],
      ['DELETE', /^\/api\/projects\/([^/]+)\/library\/assets\/[^/]+$/, (ctx, req, id, url) => store.library.removeAsset(ctx, id, url.pathname.split('/').at(-1))],
      ['POST', /^\/api\/projects\/([^/]+)\/library\/assets\/[^/]+\/restore$/, async (ctx, req, id, url) =>
        store.library.restoreVersion(ctx, id, url.pathname.split('/').at(-2), libraryChoices(await read(req), ['versionId', 'baseVersionId'], 'Restore'))],
      ['POST', /^\/api\/projects\/([^/]+)\/library\/assets\/[^/]+\/copy$/, async (ctx, req, id, url) =>
        store.library.copyAsset(ctx, id, url.pathname.split('/').at(-2), libraryChoices(await read(req), ['targetProjectId', 'folderId', 'filename', 'collision'], 'Copy')), 201],
      ['GET', /^\/api\/projects\/([^/]+)\/library\/removed$/, (ctx, req, id) => store.library.removed(ctx, id)],
      ['POST', /^\/api\/projects\/([^/]+)\/library\/folders$/, async (ctx, req, id) => store.library.createFolder(ctx, id, await read(req)), 201],
      ['POST', /^\/api\/projects\/([^/]+)\/library\/folders\/paths$/, async (ctx, req, id) => store.library.ensureFolders(ctx, id, await read(req))],
      ['PATCH', /^\/api\/projects\/([^/]+)\/library\/folders\/[^/]+$/, async (ctx, req, id, url) => store.library.updateFolder(ctx, id, url.pathname.split('/').at(-1), await read(req))],
      ['DELETE', /^\/api\/projects\/([^/]+)\/library\/folders\/[^/]+$/, (ctx, req, id, url) => store.library.removeFolder(ctx, id, url.pathname.split('/').at(-1))],
      ['POST', /^\/api\/projects\/([^/]+)\/library\/versions\/[^/]+\/verify$/, (ctx, req, id, url) => store.library.verify(ctx, id, url.pathname.split('/').at(-2))],
      ['POST', /^\/api\/projects\/([^/]+)\/library\/versions\/[^/]+\/repair$/, (ctx, req, id, url) => store.library.repair(ctx, id, url.pathname.split('/').at(-2), req, { signal: uploadSignal(req) })],
      ['POST', /^\/api\/projects\/([^/]+)\/library\/drafts$/, async (ctx, req, id) => store.library.createDraft(ctx, id, bodyOf(await read(req))), 201],
      ['GET', /^\/api\/projects\/([^/]+)\/library\/drafts\/[^/]+$/, (ctx, req, id, url) => store.library.draft(ctx, id, url.pathname.split('/').at(-1))],
      // Autosave answers with the new revision; the browser already has the text.
      ['PUT', /^\/api\/projects\/([^/]+)\/library\/drafts\/[^/]+$/, async (ctx, req, id, url) => {
        const { text, ...draft } = store.library.writeDraft(ctx, id, url.pathname.split('/').at(-1), bodyOf(await read(req)));
        return draft;
      }],
      ['DELETE', /^\/api\/projects\/([^/]+)\/library\/drafts\/[^/]+$/, (ctx, req, id, url) => (store.library.discardDraft(ctx, id, url.pathname.split('/').at(-1)), { ok: true })],
      ['POST', /^\/api\/projects\/([^/]+)\/library\/drafts\/[^/]+\/save$/, async (ctx, req, id, url) => {
        const input = bodyOf(await read(req));
        assert(/^[\w-]{1,100}$/.test(input.operation || ''), 'Each save needs an operation ID.');
        return store.library.saveDraft(ctx, id, url.pathname.split('/').at(-2), { revision: input.revision, operationId: input.operation,
          collision: input.collision || undefined, assetId: input.asset || undefined, baseVersionId: input.baseVersionId || undefined });
      }],
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
      ['GET', /^\/api\/flows\/([^/]+)\/playbooks$/, (ctx, req, id) => ({ ...store.playbooks.list(flowFor(ctx, id).id), stages: flowFor(ctx, id).stages })],
      ['PUT', /^\/api\/flows\/([^/]+)\/playbooks$/, async (ctx, req, id) => {
        const flow = flowFor(ctx, id); const input = bodyOf(await read(req));
        store.editableFlow(ctx, flow.id);
        const document = store.playbooks.write(flow.id, input.path, input.text, input.baseHash ?? null, { laneIds: flow.stages.map((stage) => stage.id) });
        store.recordPlaybookChange(ctx, flow.id, input.path, 'playbook_saved');
        return { document, stages: flowFor(ctx, id).stages };
      }],
      ['DELETE', /^\/api\/flows\/([^/]+)\/playbooks$/, async (ctx, req, id) => {
        const flow = flowFor(ctx, id); const input = bodyOf(await read(req));
        store.editableFlow(ctx, flow.id);
        store.playbooks.remove(flow.id, input.path, input.baseHash);
        store.recordPlaybookChange(ctx, flow.id, input.path, 'playbook_deleted');
        return { stages: flowFor(ctx, id).stages };
      }],
      ['GET', /^\/api\/cards\/([^/]+)\/lane-runs$/, (ctx, req, id) => ({ runs: store.laneRuns.forCard(ctx, id) })],
      ['POST', /^\/api\/cards\/([^/]+)\/lane-runs$/, (ctx, req, id) => store.laneRuns.request(ctx, id), 201],
      ['GET', /^\/api\/cards\/([^/]+)\/lane-runs\/preview$/, (ctx, req, id) => lanes.preview(id)],
      ['GET', /^\/api\/cards\/([^/]+)\/notes$/, (ctx, req, id) => (store.getCard(ctx, id), store.playbooks.notes(id))],
      ['PUT', /^\/api\/cards\/([^/]+)\/notes$/, async (ctx, req, id) => {
        store.editableCard(ctx, id); const input = bodyOf(await read(req));
        const notes = store.playbooks.writeNotes(id, input.text, input.baseHash);
        store.recordNotesChange(ctx, id);
        return notes;
      }],
      ['GET', /^\/api\/maintenance$/, () => maintenance.status()],
      ['POST', /^\/api\/maintenance\/export$/, async (ctx, req) => maintenance.start(await read(req)), 202],
      ['POST', /^\/api\/maintenance\/cancel$/, () => maintenance.cancel()],
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
        if (url.pathname.startsWith('/api/') && !/^\/api\/maintenance(\/(export|cancel))?$/.test(url.pathname) && !['GET', 'HEAD'].includes(req.method)) {
          if (maintenance.active && !finishesRunningWork(url.pathname)) return send(res, 503, { error: maintenanceMessage });
          // Maintenance drains writes in progress before it exports.
          res.once('close', maintenance.track());
        }
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
        const content = url.pathname.match(/^\/api\/projects\/([^/]+)\/library\/versions\/([^/]+)\/content$/);
        if (content && req.method === 'GET') {
          // Verified before the first byte; a change while streaming aborts the response.
          let ids;
          try { ids = content.slice(1).map(decodeURIComponent); } catch { return send(res, 404, { error: 'Not found.' }); }
          const { version, filename, written, stream: bytes } = await store.library.read(currentUser(req), ...ids);
          const inline = url.searchParams.get('inline') === '1' && assetPreview(filename, { written });
          res.writeHead(200, { 'Content-Type': inline ? inline.type : 'application/octet-stream', 'Content-Length': version.size,
            'Content-Disposition': disposition(inline ? 'inline' : 'attachment', filename),
            'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=31536000, immutable' });
          bytes.once('error', () => res.destroy());
          res.once('close', () => bytes.destroy());
          return bytes.pipe(res);
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
        if (!res.headersSent) send(res, error.code === 'ENOENT' ? 404 : error.status || 500, { error: error.status ? error.message : error.code === 'ENOENT' ? 'Not found.' : 'Could not save or load data. Check available disk space and try again.', ...(error.conflict ? { conflict: error.conflict } : {}), ...(error.problems ? { problems: error.problems } : {}) });
        else res.end();
        if (!error.status && error.code !== 'ENOENT') console.error(error);
      }
    });
    // Open event streams would otherwise keep close() waiting forever.
    const close = server.close.bind(server);
    let closing;
    server.close = (callback) => {
      if (!closing) {
        const exporting = maintenance.close();
        worker.close(); lanes.close(); stream.close();
        const stopped = Promise.all([codex.close(), claude.close()]).catch((error) => console.error(error));
        closing = new Promise((resolve) => close(resolve)).then(async (error) => {
          await stopped;
          await exporting;
          await chat.drain();
          // An HTTP request already in progress may have rediscovered Codex
          // during shutdown. Finish its filesystem work and stop that process.
          await providers.drain();
          await Promise.all([codex.close(), claude.close()]);
          await Promise.all([codex.disposeProtection?.(), claude.disposeProtection?.()]);
          return error;
        }).finally(() => { try { store.close(); } finally { lock.release(); } });
      }
      closing.then((error) => callback?.(error), (error) => callback?.(error));
      return server;
    };
    return server;
  } catch (error) {
    worker?.close(); lanes?.close(); stream?.close(); store?.close(); lock.release();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = await createApp();
  app.listen(port, '127.0.0.1', () => console.log(`\n  Frameboard is ready → http://localhost:${port}\n  Your data lives in ${process.env.DATA_DIR || path.join(root, 'data')}\n`));
}
