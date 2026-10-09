// A scripted stand-in for `codex app-server`, used for deterministic adapter
// tests. It persists threads in FAKE_CODEX_HOME so restarts and cold resumes
// behave like the installed harness, and it validates both directions of
// traffic against the installed schema (FAKE_CODEX_SCHEMA_DIR), recording any
// violation in violations.log.
//
// Turn input text drives its behavior:
//   tool:<name>  call a dynamic tool and report the result
//   approve      ask for command approval and report the decision
//   ask          ask the user for input and report the answer
//   stream       stream deltas until interrupted
//   crash        exit the process after the turn starts
//   image        produce an imageGeneration item
//   fail         fail the turn
//   slow:<ms>    wait before completing
//   anything else is echoed back.
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { validator } from './json-schema.js';

const home = process.env.FAKE_CODEX_HOME;
const scenario = existsSync(path.join(home, 'scenario.json')) ? JSON.parse(readFileSync(path.join(home, 'scenario.json'), 'utf8')) : {};
const store = path.join(home, 'threads.json');
const threads = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {};
const save = () => writeFileSync(store, JSON.stringify(threads));
const loaded = new Set();
const active = new Map();
const pendingServerRequests = new Map();
let nextServerRequest = 1;

let check = () => {};
if (process.env.FAKE_CODEX_SCHEMA_DIR) {
  const dir = process.env.FAKE_CODEX_SCHEMA_DIR;
  const load = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
  const files = Object.fromEntries(['ClientRequest', 'ClientNotification', 'ServerRequest', 'ServerNotification'].map((name) => [name, load(`${name}.json`)]));
  const v2 = load('codex_app_server_protocol.v2.schemas.json');
  const serverResponseFor = Object.fromEntries(files.ServerRequest.oneOf.map((branch) => [branch.properties.method.enum[0], branch.properties.params?.$ref?.split('/').pop().replace(/Params$/, 'Response')]));
  const responseFor = Object.fromEntries(files.ClientRequest.oneOf.map((branch) => [branch.properties.method.enum[0], branch.properties.params?.$ref?.split('/').pop().replace(/Params$/, 'Response')]));
  check = (kind, message, method) => {
    let found;
    if (kind === 'response' || kind === 'serverResponse') {
      const name = (kind === 'response' ? responseFor : serverResponseFor)[method];
      const responseFile = name && path.join(dir, `${name}.json`);
      const responseSchema = responseFile && existsSync(responseFile) ? load(`${name}.json`) : null;
      found = responseSchema ? validator(responseSchema).errors(responseSchema, message.result) : name && v2.definitions[name] ? validator(v2).errors(v2.definitions[name], message.result) : [];
    } else found = validator(files[kind]).errors(files[kind], message);
    if (found.length) appendFileSync(path.join(home, 'violations.log'), `${kind} ${method ?? message.method}: ${found.slice(0, 5).join('; ')}\n`);
  };
}

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => { const message = { jsonrpc: '2.0', method, params }; check('ServerNotification', message); write(message); };
const ask = (method, params) => new Promise((resolve) => {
  const id = `srv-${nextServerRequest++}`;
  const message = { jsonrpc: '2.0', id, method, params };
  check('ServerRequest', message);
  pendingServerRequests.set(id, { resolve, method });
  write(message);
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

const sandbox = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
const models = scenario.models ?? [{ id: 'gpt-6-luna', isDefault: true }, { id: 'gpt-5.6-luna' }];
const modelEntry = (model) => ({
  id: model.id, model: model.id, displayName: model.displayName ?? model.id, description: '', hidden: Boolean(model.hidden), isDefault: Boolean(model.isDefault),
  defaultReasoningEffort: 'medium', supportedReasoningEfforts: [], inputModalities: ['text', 'image'], additionalSpeedTiers: [], serviceTiers: [],
});
function threadView(record, { includeTurns = false } = {}) {
  return {
    id: record.id, sessionId: record.id, cliVersion: '0.0.0-fake', createdAt: record.createdAt, updatedAt: record.updatedAt, cwd: record.cwd,
    ephemeral: false, modelProvider: 'openai', model: record.model, preview: '', projectId: null, source: 'appServer',
    status: active.has(record.id) ? { type: 'active', activeFlags: [] } : loaded.has(record.id) ? { type: 'idle' } : { type: 'notLoaded' },
    turns: includeTurns ? record.turns : [], path: path.join(home, `${record.id}.jsonl`),
  };
}
function sessionResponse(record, extra = {}) {
  return { thread: threadView(record), model: record.model, modelProvider: 'openai', cwd: record.cwd, approvalPolicy: record.approvalPolicy ?? 'on-request',
    approvalsReviewer: 'user', sandbox, reasoningEffort: null, instructionSources: record.instructionSources, ...extra };
}
function requireThread(threadId) {
  const record = threads[threadId];
  if (!record || record.missing) fail(-32600, `no rollout found for thread id ${threadId}`);
  return record;
}
function requireModel(model) {
  if (model && !models.some((entry) => entry.id === model)) fail(-32600, `The model \`${model}\` does not exist or you do not have access to it.`);
}
// Instruction files the scenario says the harness would load anyway.
const instructionSourcesFor = (config) => [...(scenario.globalInstructionFiles ?? []), ...(config?.project_doc_max_bytes === 0 ? [] : scenario.projectInstructionFiles ?? [])];

async function runTurn(record, turn, text) {
  const threadId = record.id;
  const turnId = turn.id;
  const item = (value) => notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: value });
  const agentMessage = async (message) => {
    const id = randomUUID();
    notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { type: 'agentMessage', id, text: '' } });
    for (const delta of [message.slice(0, Math.ceil(message.length / 2)), message.slice(Math.ceil(message.length / 2))]) {
      if (delta) notify('item/agentMessage/delta', { threadId, turnId, itemId: id, delta });
    }
    const value = { type: 'agentMessage', id, text: message };
    turn.items.push(value);
    item(value);
  };
  const finish = (status, error = null) => {
    if (turn.status !== 'inProgress') return;
    Object.assign(turn, { status, error, completedAt: Math.floor(Date.now() / 1000) });
    active.delete(threadId);
    save();
    notify('turn/completed', { threadId, turn: { ...turn, items: [] } });
  };
  active.set(threadId, { turn, finish });
  notify('turn/started', { threadId, turn: { ...turn, items: [] } });
  const user = turn.items[0];
  notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: user });
  item(user);
  if (text === 'crash') { await sleep(20); process.exit(1); }
  if (text.startsWith('slow:')) await sleep(Number(text.slice(5)));
  if (text.startsWith('tool:')) {
    const result = await ask('item/tool/call', { threadId, turnId, callId: randomUUID(), tool: text.slice(5), namespace: null, arguments: { probe: true } });
    const value = { type: 'dynamicToolCall', id: randomUUID(), tool: text.slice(5), namespace: null, arguments: { probe: true }, status: result.success ? 'completed' : 'failed', contentItems: result.contentItems, success: result.success, durationMs: 1 };
    turn.items.push(value);
    item(value);
    await agentMessage(`tool result: ${result.contentItems.map((part) => part.text).join('')}`);
  } else if (text === 'approve') {
    const result = await ask('item/commandExecution/requestApproval', { threadId, turnId, itemId: randomUUID(), startedAtMs: Date.now(), command: 'touch probe.txt', cwd: record.cwd, reason: 'needs approval' });
    if (turn.status !== 'inProgress') return;
    await agentMessage(`decision: ${result.decision}`);
  } else if (text === 'ask') {
    const result = await ask('item/tool/requestUserInput', { threadId, turnId, itemId: randomUUID(), isBlocking: true, questions: [{ id: 'q1', header: 'Choice', question: 'Which?', isOther: false, isSecret: false, options: null }] });
    await agentMessage(`answer: ${JSON.stringify(result.answers)}`);
  } else if (text === 'stream') {
    const id = randomUUID();
    notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { type: 'agentMessage', id, text: '' } });
    for (let n = 1; turn.status === 'inProgress' && n < 500; n++) {
      notify('item/agentMessage/delta', { threadId, turnId, itemId: id, delta: `${n}\n` });
      await sleep(10);
    }
    return;
  } else if (text === 'image') {
    const value = { type: 'imageGeneration', id: randomUUID(), status: 'completed', result: 'iVBORw0KGgo=', revisedPrompt: 'a kite', savedPath: path.join(home, 'generated.png') };
    turn.items.push(value);
    item(value);
  } else if (text === 'fail') {
    finish('failed', { message: 'The model failed.' });
    return;
  } else await agentMessage(`echo: ${text}`);
  finish('completed');
}

const methods = {
  initialize: () => ({ userAgent: 'fake-codex/0.0.0', codexHome: scenario.codexHome ?? home, platformFamily: 'unix', platformOs: 'linux' }),
  'model/list': () => ({ data: models.map(modelEntry), nextCursor: null }),
  'skills/list': ({ cwds }) => ({ data: (cwds ?? []).map((cwd) => ({ cwd, skills: scenario.skills ?? [], errors: [] })) }),
  'hooks/list': ({ cwds }) => ({ data: (cwds ?? []).map((cwd) => ({ cwd, hooks: scenario.hooks ?? [], warnings: [], errors: [] })) }),
  'plugin/installed': () => ({ marketplaces: scenario.plugins?.length ? [{ name: 'fake', path: null, interface: null, plugins: scenario.plugins }] : [], marketplaceLoadErrors: [] }),
  'mcpServerStatus/list': () => ({ data: scenario.mcpServers ?? [], nextCursor: null }),
  'config/read': () => ({ config: { mcp_servers: scenario.configuredMcpServers ?? {}, ...(scenario.features ? { features: scenario.features } : {}) }, origins: {} }),
  'configRequirements/read': () => ({ requirements: scenario.requirements ?? null }),
  'thread/start': (params) => {
    requireModel(params.model);
    const now = Math.floor(Date.now() / 1000);
    const record = { id: randomUUID(), cwd: params.cwd ?? home, model: params.model ?? models.find((entry) => entry.isDefault)?.id, createdAt: now, updatedAt: now, turns: [],
      approvalPolicy: params.approvalPolicy, dynamicTools: params.dynamicTools ?? [], config: params.config ?? {}, developerInstructions: params.developerInstructions ?? null };
    record.instructionSources = instructionSourcesFor(record.config);
    threads[record.id] = record;
    loaded.add(record.id);
    save();
    notify('thread/started', { thread: threadView(record) });
    return sessionResponse(record);
  },
  'thread/resume': (params) => {
    const record = requireThread(params.threadId);
    // Like the installed harness, a loaded thread ignores replacement settings.
    if (!loaded.has(record.id)) record.resumedConfig = params.config ?? null;
    loaded.add(record.id);
    requireModel(params.model);
    return sessionResponse(record, { instructionSources: instructionSourcesFor(record.resumedConfig ?? record.config) });
  },
  'thread/loaded/list': ({ cursor, limit }) => {
    const ids = [...loaded]; const start = Number(cursor ?? 0); const size = limit ?? 100;
    return { data: ids.slice(start, start + size), nextCursor: start + size < ids.length ? String(start + size) : null };
  },
  'thread/archive': ({ threadId }) => { const record = requireThread(threadId); record.archived = true; loaded.delete(threadId); save(); return {}; },
  'thread/unarchive': ({ threadId }) => { const record = requireThread(threadId); record.archived = false; save(); return { thread: threadView(record) }; },
  'thread/unsubscribe': ({ threadId }) => { loaded.delete(threadId); return { status: 'unsubscribed' }; },
  'thread/items/list': ({ threadId, turnId, cursor, limit }) => {
    const items = requireThread(threadId).turns.filter((t) => !turnId || t.id === turnId).flatMap((t) => t.items.map((item) => ({ turnId: t.id, item })));
    const start = Number(cursor ?? 0); const size = limit ?? 100;
    return { data: items.slice(start, start + size), nextCursor: start + size < items.length ? String(start + size) : null, backwardsCursor: null };
  },
  'thread/read': ({ threadId, includeTurns }) => ({ thread: threadView(requireThread(threadId), { includeTurns }) }),
  'thread/turns/list': ({ threadId, cursor, limit }) => {
    const record = requireThread(threadId);
    const newest = [...record.turns].reverse();
    const start = cursor ? Number(cursor) : 0;
    const size = limit ?? 25;
    const data = newest.slice(start, start + size).map((turn) => ({ ...turn, itemsView: 'summary' }));
    return { data, nextCursor: start + size < newest.length ? String(start + size) : null, backwardsCursor: null };
  },
  'turn/start': (params) => {
    const record = requireThread(params.threadId);
    if (!loaded.has(record.id)) fail(-32600, `thread not loaded: ${record.id}`);
    if (active.has(record.id)) fail(-32600, 'thread already has an active turn');
    requireModel(params.model);
    if (params.model) record.model = params.model;
    const text = params.input.map((part) => part.text ?? '').join('');
    const turn = { id: randomUUID(), status: 'inProgress', error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null,
      items: [{ type: 'userMessage', id: randomUUID(), clientId: params.clientUserMessageId ?? null, content: params.input }] };
    record.turns.push(turn);
    record.updatedAt = Math.floor(Date.now() / 1000);
    save();
    setImmediate(() => runTurn(record, turn, text));
    return { turn: { ...turn, items: [] } };
  },
  'turn/interrupt': ({ threadId, turnId }) => {
    const running = active.get(threadId);
    if (!running || running.turn.id !== turnId) fail(-32600, 'no active turn to interrupt');
    setImmediate(() => running.finish('interrupted'));
    return {};
  },
};

createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method && message.id === undefined) { check('ClientNotification', message); return; }
  if (!message.method) {
    const pending = pendingServerRequests.get(message.id);
    pendingServerRequests.delete(message.id);
    if (pending && !message.error) check('serverResponse', message, pending.method);
    pending?.resolve(message.result ?? {});
    return;
  }
  check('ClientRequest', message);
  try {
    if ((scenario.hangMethods ?? []).includes(message.method)) return;
    if (scenario.delayMethods?.[message.method]) await sleep(scenario.delayMethods[message.method]);
    const handler = methods[message.method] ?? (() => fail(-32601, `unsupported method ${message.method}`));
    const response = { jsonrpc: '2.0', id: message.id, result: await handler(message.params ?? {}) };
    check('response', response, message.method);
    write(response);
  } catch (error) {
    write({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});
