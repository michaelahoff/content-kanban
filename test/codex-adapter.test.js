import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from '../codex-adapter.js';
import { installedCodexSchema } from './support/json-schema.js';

const fake = fileURLToPath(new URL('./support/fake-codex.js', import.meta.url));
const schema = installedCodexSchema();

// Runs the adapter against the scripted app-server. When Codex is installed,
// every message in both directions is checked against its generated schema.
async function fixture(t, scenario = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'frameboard-fake-codex-'));
  await writeFile(path.join(home, 'scenario.json'), JSON.stringify(scenario));
  const env = { ...process.env, FAKE_CODEX_HOME: home, ...(schema ? { FAKE_CODEX_SCHEMA_DIR: schema.out } : {}) };
  const adapters = [];
  const adapter = (options = {}) => {
    const created = createCodexAdapter({ command: process.execPath, args: [fake], env, requestTimeoutMs: 5000, ...options });
    adapters.push(created);
    return created;
  };
  t.after(async () => {
    for (const created of adapters) await created.close();
    const violations = await readFile(path.join(home, 'violations.log'), 'utf8').catch(() => '');
    await rm(home, { recursive: true, force: true });
    assert.equal(violations, '', 'protocol messages must match the installed Codex schema');
  });
  return { home, adapter };
}

test('discovery starts the shared app-server only when asked and correlates concurrent requests', async (t) => {
  const f = await fixture(t, {
    delayMethods: { 'model/list': 30, 'skills/list': 10 },
    models: [{ id: 'gpt-6-luna', isDefault: true }, { id: 'gpt-5.6-luna' }, { id: 'gpt-reserve', hidden: true }],
    skills: [{ name: 'writer', description: 'Writes things', path: '/skills/writer/SKILL.md', scope: 'user', enabled: true }],
  });
  const codex = f.adapter();
  assert.equal(codex.running, false);
  const [first, second] = await Promise.all([codex.discover(), codex.discover()]);
  assert.equal(codex.running, true);
  assert.deepEqual(first, second);
  assert.deepEqual(first.models.map((model) => [model.id, model.isDefault]), [['gpt-6-luna', true], ['gpt-5.6-luna', false]]);
  assert.deepEqual(first.skills.map((skill) => [skill.id, skill.name]), [['/skills/writer/SKILL.md', 'writer']]);
  assert.match(first.harness.userAgent, /fake-codex/);
});

const threadConfig = {
  developerInstructions: 'Frameboard card chat instructions.',
  config: { project_doc_max_bytes: 0 },
  dynamicTools: [{ type: 'function', name: 'read_card', description: 'Read the card.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
  sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
};
// Collects one thread's events until its turn completes.
function collect(codex, threadId, handlers = {}) {
  const events = [];
  let done;
  const completed = new Promise((resolve) => { done = resolve; });
  const unsubscribe = codex.subscribe(threadId, {
    ...handlers,
    onEvent(event) { events.push(event); handlers.onEvent?.(event); if (event.type === 'turn-completed') done(event); },
  });
  return { events, completed, unsubscribe, text: () => events.filter((event) => event.type === 'delta').map((event) => event.delta).join('') };
}

test('threads sharing one app-server receive only their own events, in order', async (t) => {
  const f = await fixture(t);
  const codex = f.adapter();
  const [a, b] = await Promise.all([
    codex.openThread({ cwd: f.home, model: 'gpt-6-luna', threadConfig }),
    codex.openThread({ cwd: f.home, model: 'gpt-6-luna', threadConfig }),
  ]);
  assert.notEqual(a.threadId, b.threadId);
  assert.equal(a.resumed, false);
  const streams = [collect(codex, a.threadId), collect(codex, b.threadId)];
  const turns = await Promise.all([
    codex.startTurn({ threadId: a.threadId, input: [{ type: 'text', text: 'alpha' }], clientUserMessageId: 'attempt-a' }),
    codex.startTurn({ threadId: b.threadId, input: [{ type: 'text', text: 'beta' }], clientUserMessageId: 'attempt-b' }),
  ]);
  await Promise.all(streams.map((stream) => stream.completed));
  for (const [index, stream] of streams.entries()) {
    assert.ok(stream.events.every((event) => event.threadId === [a, b][index].threadId && event.turnId === turns[index].turnId));
    assert.deepEqual(stream.events.map((event) => event.seq), stream.events.map((event, n) => stream.events[0].seq + n));
    assert.equal(stream.events[0].type, 'turn-started');
    assert.equal(stream.events.at(-1).type, 'turn-completed');
    assert.equal(stream.events.at(-1).status, 'completed');
  }
  assert.equal(streams[0].text(), 'echo: alpha');
  assert.equal(streams[1].text(), 'echo: beta');
  const user = streams[0].events.find((event) => event.type === 'item-completed' && event.item.type === 'userMessage');
  assert.equal(user.item.clientId, 'attempt-a');
});

async function open(codex, home, extra = {}) {
  return codex.openThread({ cwd: home, model: 'gpt-6-luna', threadConfig, ...extra });
}
async function turn(codex, threadId, text, extra = {}) {
  const stream = collect(codex, threadId);
  const result = await codex.startTurn({ threadId, input: [{ type: 'text', text }], clientUserMessageId: 'attempt', ...extra });
  await stream.completed; stream.unsubscribe(); return { ...result, ...stream };
}

test('cold resume preserves exact identity and tools without re-registering them, with explicit model changes', async (t) => {
  const f = await fixture(t); const codex = f.adapter(); const a = await open(codex, f.home);
  await turn(codex, a.threadId, 'first');
  await codex.archiveThread({ threadId: a.threadId });
  assert.ok(!(await codex.listLoadedThreads()).data.includes(a.threadId));
  await codex.unarchiveThread({ threadId: a.threadId });
  await open(codex, f.home, { threadId: a.threadId });
  await codex.close();
  const b = await open(codex, f.home, { threadId: a.threadId });
  assert.equal(b.threadId, a.threadId); assert.equal(b.resumed, true);
  const remove = codex.subscribe(b.threadId, { onToolCall: () => ({ success: true, contentItems: [{ type: 'inputText', text: 'card read' }] }) });
  const result = await turn(codex, b.threadId, 'tool:read_card', { model: 'gpt-5.6-luna' });
  assert.equal(result.text(), 'tool result: card read'); remove();
  assert.equal((await codex.readThread({ threadId: b.threadId })).thread.model, 'gpt-5.6-luna');
  await assert.rejects(open(codex, f.home, { threadId: b.threadId, threadConfig: { ...threadConfig, developerInstructions: 'replacement' } }), { kind: 'fresh-context-required' });
  await assert.rejects(open(codex, f.home, { threadId: 'missing' }), { kind: 'native-unavailable' });
  await assert.rejects(open(codex, f.home, { model: 'unavailable' }), { kind: 'model-unavailable' });
});

test('approval and input requests stay on their thread; Stop invalidates late approval responses', async (t) => {
  const f = await fixture(t); const codex = f.adapter(); const a = await open(codex, f.home); const b = await open(codex, f.home);
  let waiting; const approval = new Promise((resolve) => { waiting = resolve; });
  const remove = codex.subscribe(a.threadId, { onRequest: (request) => { waiting(request); } });
  const stream = collect(codex, a.threadId);
  const started = await codex.startTurn({ threadId: a.threadId, input: [{ type: 'text', text: 'approve' }] });
  const request = await approval;
  await codex.interrupt({ threadId: a.threadId, turnId: started.turnId }); await stream.completed;
  assert.equal(stream.events.at(-1).status, 'interrupted');
  assert.throws(() => request.respond({ decision: 'accept' }), { kind: 'request-expired' }); remove(); stream.unsubscribe();
  const input = codex.subscribe(b.threadId, { onRequest: (request) => { assert.equal(request.threadId, b.threadId); return { answers: { q1: { answers: ['blue'] } } }; } });
  assert.match((await turn(codex, b.threadId, 'ask')).text(), /blue/); input();
});

test('process failure fences old requests, reports interruption, and requires exact reopen before any new turn', async (t) => {
  const f = await fixture(t); const codex = f.adapter(); const a = await open(codex, f.home);
  const exited = new Promise((resolve) => codex.subscribe(a.threadId, { onEvent: (event) => { if (event.type === 'process-exited') resolve(event); } }));
  await codex.startTurn({ threadId: a.threadId, input: [{ type: 'text', text: 'crash' }] });
  assert.equal((await exited).error.kind, 'process-exited');
  await assert.rejects(codex.startTurn({ threadId: a.threadId, input: [] }), { kind: 'not-open' });
  await open(codex, f.home, { threadId: a.threadId });
  assert.equal((await turn(codex, a.threadId, 'reopened')).text(), 'echo: reopened');
});

test('read-only paged reconciliation retains attempt IDs and image provenance without resuming', async (t) => {
  const f = await fixture(t); const codex = f.adapter(); const a = await open(codex, f.home);
  await turn(codex, a.threadId, 'one'); await turn(codex, a.threadId, 'two');
  const image = await turn(codex, a.threadId, 'image');
  const artifact = image.events.find((e) => e.type === 'artifact');
  assert.equal(artifact.nativeKind, 'imageGeneration'); assert.equal(artifact.result, 'iVBORw0KGgo='); assert.match(artifact.savedPath, /generated.png$/);
  await codex.close();
  const first = await codex.listTurns({ threadId: a.threadId, limit: 2 });
  const second = await codex.listTurns({ threadId: a.threadId, limit: 2, cursor: first.nextCursor });
  assert.equal(first.data.length, 2); assert.equal(second.data.length, 1);
  assert.equal(second.data[0].items[0].clientId, 'attempt');
  const items = await codex.listItems({ threadId: a.threadId, turnId: second.data[0].id, limit: 1 });
  assert.equal(items.data[0].item.type, 'userMessage'); assert.ok(items.nextCursor);
  assert.equal((await codex.readThread({ threadId: a.threadId })).thread.status.type, 'notLoaded');
});

test('two concurrent submissions cannot accidentally steer the same turn, and streaming Stop is ordered', async (t) => {
  const f = await fixture(t); const codex = f.adapter(); const a = await open(codex, f.home);
  const stream = collect(codex, a.threadId);
  const started = codex.startTurn({ threadId: a.threadId, input: [{ type: 'text', text: 'stream' }] });
  await assert.rejects(codex.startTurn({ threadId: a.threadId, input: [] }), { kind: 'busy' });
  const result = await started;
  await codex.interrupt({ threadId: a.threadId, turnId: result.turnId });
  await stream.completed; assert.equal(stream.events.at(-1).status, 'interrupted'); stream.unsubscribe();
});

test('uninstalled harness fails explicitly and never substitutes a network provider', async (t) => {
  const codex = createCodexAdapter({ command: '/no/such/codex', requestTimeoutMs: 1000 });
  t.after(() => codex.close()); await assert.rejects(codex.discover(), { kind: 'unavailable' });
});

test('RPC timeouts fail without replay; exact bindings cannot be replaced by supplied paths or history', async (t) => {
  const f = await fixture(t, { hangMethods: ['model/list'] });
  const codex = f.adapter({ requestTimeoutMs: 50 });
  await assert.rejects(codex.discover(), { kind: 'timeout', method: 'model/list' });
  await assert.rejects(open(codex, f.home, { threadId: '' }), { kind: 'binding-mismatch' });
  await assert.rejects(open(codex, f.home, { threadId: 'exact', threadConfig: { ...threadConfig, path: '/another/rollout.jsonl' } }), { kind: 'configuration-unavailable' });
  await assert.rejects(open(codex, f.home, { threadId: 'exact', threadConfig: { ...threadConfig, history: [] } }), { kind: 'configuration-unavailable' });
});
