// Native Claude Code stream-json transport. Initialization lists models without
// sending a prompt. Card chats keep native sessions with the user's full Claude
// Code setup and tools, inside the retained-data boundary, and send text,
// image and PDF document inputs. Frameboard card tools reach Claude as the
// SDK-hosted `frameboard` MCP server, carried over the same stdio stream, so
// the boundary needs no socket for them.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { imageFormat } from './image-files.js';
import { fileFormat } from './public/library-format.js';
import { createNativeBoundary } from './native-boundary.js';
import { claudePdfRoute, claudePdfEvidence } from './claude-pdf-gate.js';

const error = (kind, message) => Object.assign(new Error(message), { kind });
// Claude Code reports thinking and text as separate blocks, and its final
// assistant messages number blocks differently from the stream. Text items
// are therefore identified by their order among a message's text blocks.
function textOrdinal(counters, messageId, key) {
  const entry = counters.get(messageId) ?? { next: 0, keys: new Map() };
  counters.set(messageId, entry);
  if (!entry.keys.has(key)) entry.keys.set(key, entry.next++);
  return `${messageId}:${entry.keys.get(key)}`;
}
const uuid = (value) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
// The account kind, never its identity: only these fields are kept.
const accountKind = (account) => typeof account?.apiProvider === 'string' ? { apiProvider: account.apiProvider, subscriptionType: typeof account.subscriptionType === 'string' ? account.subscriptionType : null } : null;
export function createClaudeAdapter({ command = 'claude', args = [], env = process.env, cwd = process.cwd(), timeoutMs = 15000, pdfEvidence = claudePdfEvidence } = {}) {
  const sessions = new Map(); const processes = new Set(); const listeners = new Map();
  const nativeHome = env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  let retainedDataDir = null; let boundaryTask = null;
  const boundary = () => {
    if (!retainedDataDir) return null;
    // A failed setup is retried, so a corrected installation applies on refresh.
    // Without CLAUDE_CONFIG_DIR, Claude Code keeps its global config (MCP
    // servers, onboarding) in ~/.claude.json beside its home.
    const nativeFiles = env.CLAUDE_CONFIG_DIR ? [] : [path.join(homedir(), '.claude.json')];
    boundaryTask ??= createNativeBoundary({ dataDir: retainedDataDir, nativeHome, nativeFiles }).catch((error) => { boundaryTask = null; throw error; });
    return boundaryTask;
  };
  const historyPath = (work, id) => path.join(nativeHome, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  // Card tool calls are routed like Codex dynamic tools: to the subscriber
  // that owns the session's current turn, keyed by Claude's tool-use ID.
  async function cardToolCall(session, name, input, callId) {
    const handler = [...listeners.get(session.id) ?? []].find((entry) => entry.onToolCall && (!entry.acceptsRequest || entry.acceptsRequest({ turnId: session.turnId })));
    if (!session.turnId || !handler) return { content: [{ type: 'text', text: 'Frameboard card tools are available only during a card chat turn.' }], isError: true };
    // Shown like a Codex card-tool call in the transcript's activity.
    const item = { id: `tool:${callId}`, type: 'dynamicToolCall', tool: name };
    emit(session, { type: 'item-started', item });
    const result = await handler.onToolCall({ turnId: session.turnId, callId, tool: name, arguments: input ?? {} });
    emit(session, { type: 'item-completed', item: { ...item, status: result.success ? 'completed' : 'failed' } });
    return { content: (result.contentItems ?? []).map((item) => ({ type: 'text', text: item.text ?? '' })), isError: !result.success };
  }
  async function cardToolServer(session, rpc) {
    if (rpc.method === 'initialize') return { protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'frameboard', version: '1.0.0' } };
    if (rpc.method === 'tools/list') return { tools: session.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    if (rpc.method === 'tools/call') {
      if (!session.tools.some((tool) => tool.name === rpc.params?.name)) return { content: [{ type: 'text', text: `Unknown Frameboard tool ${rpc.params?.name}.` }], isError: true };
      return cardToolCall(session, rpc.params.name, rpc.params.arguments, rpc.params._meta?.['claudecode/toolUseId'] ?? `${session.turnId}:${rpc.id}`);
    }
    // Notifications and ping get an empty result; other requests are unknown.
    if (rpc.id === undefined || rpc.method === 'ping' || rpc.method?.startsWith('notifications/')) return {};
    throw Object.assign(new Error(`Method not found: ${rpc.method}`), { rpcCode: -32601 });
  }
  const emit = (session, event) => { for (const handler of listeners.get(session.id) ?? []) handler.onEvent?.({ threadId: session.id, turnId: session.turnId, ...event }); };
  async function launch({ id, work = cwd, model, instructions = '', permissionMode = null, tools = [], resume = false } = {}) {
    const guard = await boundary(); await guard?.check();
    const child = (guard ? guard.launch.bind(guard) : spawn)(command, [...args, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      // The boundary is the protection, as for Codex Full access: Claude runs
      // its tools without prompts that nobody in a card chat could answer.
      ...(permissionMode ? ['--permission-mode', permissionMode] : []), ...(id ? [resume ? '--resume' : '--session-id', id] : []),
      ...(model ? ['--model', model] : []), ...(instructions ? ['--append-system-prompt', instructions] : [])],
    { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
    // A new session has no native history file until its first turn.
    const session = { id, work, child, tools, turnId: null, ended: false, turnless: !resume, buffer: '', items: new Map(), controls: new Map(), streamed: new Map(), completed: new Map() };
    processes.add(session);
    let resolveInit; let rejectInit;
    const ready = new Promise((resolve, reject) => { resolveInit = resolve; rejectInit = reject; });
    const timer = setTimeout(() => { rejectInit(error('timeout', 'Claude initialization timed out.')); child.kill(); }, timeoutMs);
    const write = (message) => { if (session.ended || child.stdin.destroyed) throw error('process-exited', 'Claude Code is unavailable.'); child.stdin.write(JSON.stringify(message) + '\n'); };
    session.write = write;
    session.control = (request) => new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { session.controls.delete(requestId); reject(error('timeout', 'Claude did not acknowledge the configuration request.')); }, timeoutMs);
      session.controls.set(requestId, { resolve, reject, timer });
      try { write({ type: 'control_request', request_id: requestId, request }); }
      catch (cause) { clearTimeout(timer); session.controls.delete(requestId); reject(cause); }
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // Never forward credentials or native configuration logs.
    child.once('error', (cause) => rejectInit(error('process-exited', cause.code === 'ENOENT' ? 'Claude Code is not installed. Install Claude Code and sign in, then refresh models.' : `Could not start Claude Code: ${cause.message}`)));
    child.once('close', () => {
      clearTimeout(timer); processes.delete(session); session.ended = true;
      for (const pending of session.controls.values()) { clearTimeout(pending.timer); pending.reject(error('process-exited', 'Claude Code stopped before acknowledging configuration.')); }
      session.controls.clear();
      rejectInit(error('process-exited', 'Claude Code stopped before initialization. Check your installation and sign-in.'));
      if (session.turnId) emit(session, { type: 'process-exited', error: error('process-exited', 'Claude Code stopped before reporting a result. Check delivery before retrying.') });
    });
    function receive(message) {
      if (message.type === 'control_response' && message.response?.request_id === 'initialize') {
        clearTimeout(timer);
        if (message.response.subtype === 'error') rejectInit(error('configuration-unavailable', message.response.error));
        else resolveInit(message.response.response);
      } else if (message.type === 'control_response') {
        const pending = session.controls.get(message.response?.request_id);
        if (pending) {
          clearTimeout(pending.timer); session.controls.delete(message.response.request_id);
          if (message.response.subtype === 'error') pending.reject(error('configuration-unavailable', message.response.error));
          else pending.resolve(message.response.response);
        }
      } else if (message.type === 'control_request' && message.request?.subtype === 'mcp_message') {
        const rpc = message.request.message ?? {};
        const reply = (body) => {
          try { write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { mcp_response: { jsonrpc: '2.0', id: rpc.id ?? 0, ...body } } } }); }
          catch { /* Claude Code exited; it no longer waits for this reply. */ }
        };
        (message.request.server_name === 'frameboard' ? cardToolServer(session, rpc) : Promise.reject(Object.assign(new Error(`Unknown MCP server ${message.request.server_name}.`), { rpcCode: -32601 })))
          .then((result) => reply({ result }), (cause) => reply(cause.rpcCode ? { error: { code: cause.rpcCode, message: cause.message } } : { result: { content: [{ type: 'text', text: cause.message }], isError: true } }));
      } else if (message.type === 'control_request') {
        // Permissions are bypassed, so a tool request is allowed as asked.
        write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: message.request?.subtype === 'can_use_tool' ? { behavior: 'allow', updatedInput: message.request.input ?? {} } : {} } });
      } else if (session.turnId && message.type === 'stream_event') {
        const event = message.event;
        if (event.type === 'message_start') session.messageId = event.message.id;
        if (event.type === 'content_block_start' && event.content_block?.type === 'text') textOrdinal(session.streamed, session.messageId, event.index);
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const itemId = textOrdinal(session.streamed, session.messageId, event.index);
          session.items.set(itemId, (session.items.get(itemId) ?? '') + event.delta.text);
          emit(session, { type: 'delta', itemId, delta: event.delta.text });
        }
      } else if (session.turnId && message.type === 'assistant') {
        // Claude Code reports a document the API rejected as a synthetic error
        // message, removes it and lets the model answer without it. In a turn
        // that sent PDFs that reply would use a subset of the submission, so the
        // turn is stopped and fails.
        const removal = session.sentPdf && message.is_api_error_message && (message.message?.content ?? []).find((block) => block.type === 'text' && /\bdocument\b/i.test(block.text));
        if (removal && !session.pdfRemoved) {
          session.pdfRemoved = `Claude could not process a PDF in this prompt (it may be damaged, encrypted or over the page limit) and removed it, so the turn was stopped rather than continue without it. Claude Code reported: ${removal.text}`;
          emit(session, { type: 'input-rejected', reason: session.pdfRemoved });
          session.control({ subtype: 'interrupt' }).catch(() => {});
        }
        for (const [index, block] of (message.message?.content ?? []).entries()) if (block.type === 'text') {
          const itemId = textOrdinal(session.completed, message.message.id, `${message.uuid ?? ''}:${index}`);
          emit(session, { type: 'item-completed', item: { id: itemId, type: 'agentMessage', text: block.text } });
        }
      } else if (session.turnId && message.type === 'result') {
        const status = session.pdfRemoved ? 'failed' : session.interrupted ? 'interrupted' : message.is_error ? 'failed' : 'completed';
        if (message.session_id && message.session_id !== session.id) {
          emit(session, { type: 'target-unavailable', error: error('binding-mismatch', 'Claude returned a different session. Nothing will be resent automatically.') });
        } else {
          emit(session, { type: 'turn-completed', status, error: session.pdfRemoved ? { message: session.pdfRemoved } : message.is_error ? { message: (message.errors ?? [message.result ?? 'Claude could not complete this prompt.']).join(' ') } : undefined });
        }
        session.turnId = null; session.interrupted = false; session.pdfRemoved = null;
      }
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      session.buffer += chunk.toString();
      let index;
      while ((index = session.buffer.indexOf('\n')) >= 0) {
        const line = session.buffer.slice(0, index); session.buffer = session.buffer.slice(index + 1);
        if (!line.trim()) continue;
        try { receive(JSON.parse(line)); } catch { rejectInit(error('protocol', 'Claude returned an invalid stream message.')); child.kill(); }
      }
    });
    write({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize', ...(tools.length ? { sdkMcpServers: ['frameboard'] } : {}) } });
    try { session.info = await ready; return session; } catch (cause) { child.kill(); throw cause; }
  }
  async function stop(session) {
    if (session.ended) return;
    const done = new Promise((resolve) => session.child.once('close', resolve));
    session.child.stdin.end(); session.child.kill('SIGTERM');
    const timer = setTimeout(() => session.child.kill('SIGKILL'), 2000);
    try { await done; } finally { clearTimeout(timer); }
  }
  return {
    async protectRetainedData(dataDir) { await Promise.all([...processes].map(stop)); retainedDataDir = dataDir; },
    async assertProtection() { await (await boundary())?.check(); },
    async disposeProtection() { if (boundaryTask) await (await boundaryTask.catch(() => null))?.close(); boundaryTask = null; },
    get running() { return processes.size > 0; },
    async discover({ cwd: work = cwd } = {}) {
      const session = await launch({ work });
      try {
        const models = session.info.models;
        if (!Array.isArray(models) || !models.length) throw error('configuration-unavailable', 'Claude Code returned no available models. Update Claude Code and refresh.');
        const account = accountKind(session.info.account);
        return { cwd: work, harness: { userAgent: 'Claude Code', claudeHome: nativeHome, account },
          models: models.map((model) => ({ id: model.value, displayName: model.displayName ?? model.value, resolvedModel: model.resolvedModel, pdf: claudePdfRoute(model.resolvedModel ?? model.value, pdfEvidence) })), items: [], errors: [],
          ...(retainedDataDir ? { protection: (await boundary()).snapshot } : {}) };
      } finally { await stop(session); }
    },
    subscribe(threadId, handler) {
      if (!listeners.has(threadId)) listeners.set(threadId, new Set());
      listeners.get(threadId).add(handler);
      return () => { listeners.get(threadId)?.delete(handler); };
    },
    async openThread({ threadId, cwd: work, model, threadConfig }) {
      if (threadId && !uuid(threadId)) throw error('binding-mismatch', 'Claude resume requires an exact session ID.');
      const id = threadId ?? randomUUID();
      let session = sessions.get(id);
      if (session?.turnId) throw error('busy', 'Claude already has an active turn.');
      const tools = threadConfig.dynamicTools ?? [];
      if (session && !session.ended && (session.work !== work || session.instructions !== threadConfig.developerInstructions || JSON.stringify(session.tools) !== JSON.stringify(tools))) throw error('fresh-context-required', 'Start fresh context before changing Claude guidance or tools.');
      if (!session || session.ended) {
        if (threadId) {
          try { await readFile(historyPath(work, id)); } catch (cause) { if (cause.code === 'ENOENT') throw error('native-unavailable', 'This Claude session is missing. Start fresh context; retained replies remain available.'); throw cause; }
        }
        session = await launch({ id, work, model, instructions: threadConfig.developerInstructions, permissionMode: threadConfig.permissionMode, tools, resume: Boolean(threadId) });
        if (!session.info.models?.some((entry) => entry.value === model)) { await stop(session); throw error('model-unavailable', 'This Claude model is unavailable. Refresh models in Settings and select a current model.'); }
        session.instructions = threadConfig.developerInstructions; sessions.set(id, session);
      }
      return { threadId: id };
    },
    async startTurn({ threadId, input, clientUserMessageId, model }) {
      const session = sessions.get(threadId);
      if (!session || session.ended) throw error('not-open', 'Open the Claude session before sending.');
      if (session.turnId) throw error('busy', 'Claude already has an active turn.');
      await session.control({ subtype: 'set_model', model });
      const content = [];
      for (const entry of input) {
        if (entry.type === 'text') content.push({ type: 'text', text: entry.text });
        if (entry.type === 'localImage') {
          const bytes = await readFile(entry.path); const format = imageFormat(bytes);
          if (!['png', 'jpg', 'gif', 'webp'].includes(format)) throw error('configuration-unavailable', 'Claude accepts PNG, JPEG, GIF and WebP references. Remove or convert this reference before sending.');
          content.push({ type: 'image', source: { type: 'base64', media_type: `image/${format === 'jpg' ? 'jpeg' : format}`, data: bytes.toString('base64') } });
        }
        // Explicit PDF translation: the frozen copy's exact bytes as one base64
        // document block, rather than a path.
        if (entry.type === 'localDocument') {
          const bytes = await readFile(entry.path);
          if (fileFormat(bytes) !== 'pdf') throw error('configuration-unavailable', 'This document is not a PDF, so Claude cannot receive it as one. Nothing was sent.');
          content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } });
        }
      }
      session.turnId = clientUserMessageId; session.turnless = false; session.sentPdf = content.some((block) => block.type === 'document'); session.items.clear(); session.streamed = new Map(); session.completed = new Map();
      session.write({ type: 'user', uuid: clientUserMessageId, session_id: threadId, message: { role: 'user', content }, parent_tool_use_id: null });
      emit(session, { type: 'turn-started' });
      return { turnId: session.turnId };
    },
    async interrupt({ threadId, turnId }) {
      const session = sessions.get(threadId);
      if (!session || session.turnId !== turnId) return {};
      session.interrupted = true;
      await session.control({ subtype: 'interrupt' });
      return {};
    },
    async listTurns({ threadId }) {
      const session = sessions.get(threadId);
      if (!session) throw error('native-unavailable', 'Claude native history needs its exact workspace binding.');
      let text;
      try { text = await readFile(historyPath(session.work, threadId), 'utf8'); } catch (cause) {
        if (cause.code === 'ENOENT' && session.turnless) return { data: [], nextCursor: null };
        if (cause.code === 'ENOENT') throw error('native-unavailable', 'Claude session history is unavailable.'); throw cause;
      }
      const turns = []; let turn; const counters = new Map();
      for (const line of text.split('\n').filter(Boolean)) {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && !entry.isMeta && !entry.message?.content?.some?.((block) => block.type === 'tool_result')) {
          turn = { id: entry.uuid, status: 'inProgress', items: [{ id: entry.uuid, type: 'userMessage', clientId: entry.uuid }] }; turns.push(turn);
        } else if (entry.type === 'assistant' && turn) {
          for (const [index, block] of (entry.message?.content ?? []).entries()) if (block.type === 'text') turn.items.push({ id: textOrdinal(counters, entry.message.id, `${entry.uuid ?? ''}:${index}`), type: 'agentMessage', text: block.text });
          if (entry.message?.stop_reason === 'end_turn') turn.status = 'completed';
        }
      }
      return { data: turns.reverse(), nextCursor: null };
    },
    bindHistory({ threadId, cwd: work }) { if (!sessions.has(threadId)) sessions.set(threadId, { id: threadId, work, ended: true }); },
    async close() { await Promise.all([...processes].map(stop)); },
  };
}
