// Opt-in native gates against the installed harness and a credential-free local
// Responses peer. This is real registration/dispatch, not account/model proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCodexAdapter } from '../codex-adapter.js';
import { configurationDiscovery, compileConfiguration, openConfiguredThread, queuedConfigurationDecision } from '../codex-configuration.js';
import { createResponsesFixture } from './support/responses-fixture.js';
import { installedCodexSchema } from './support/json-schema.js';
import { createApp } from '../server.js';
import { randomUUID } from 'node:crypto';

const enabled = process.env.FRAMEBOARD_NATIVE_TEST === '1';
const schema = enabled ? installedCodexSchema() : null;

test('installed native: full access executes outside-workspace commands and ordinary follow-up restores the sandbox', { skip: !enabled, timeout: 45000 }, async (t) => {
  const f = await nativeFixture(t); const opened = await f.open();
  const outside = await mkdtemp('/var/tmp/frameboard-native-permission-');
  t.after(() => rm(outside, { recursive: true, force: true }));
  const fullFile = path.join(outside, 'full.txt'); const ordinaryFile = path.join(outside, 'ordinary.txt');
  f.peer.respond({ functionCall: { name: 'exec_command', arguments: { cmd: `printf full > '${fullFile}'`, yield_time_ms: 1000 } } });
  await f.turn(opened.threadId, { tool: false, fullAccess: true });
  assert.equal(await readFile(fullFile, 'utf8'), 'full');
  await f.open(opened.threadId);
  f.peer.respond({ functionCall: { name: 'exec_command', arguments: { cmd: `printf ordinary > '${ordinaryFile}'`, yield_time_ms: 1000 } } });
  await f.turn(opened.threadId, { tool: false, fullAccess: false });
  await assert.rejects(readFile(ordinaryFile), { code: 'ENOENT' });
});

test('installed native: durable HTTP worker follows up after process/app restart with the exact binding and frozen context', { skip: !enabled, timeout: 45000 }, async (t) => {
  const f = await nativeFixture(t);
  const dataDir = path.join(path.dirname(f.home), 'http-data');
  let app; let adapter = f.adapter;
  async function start() {
    // Only this credential-free gate selects the local Responses peer. The
    // production worker still explicitly uses the installed openai provider.
    const boundary = { ...adapter, openThread: (options) => adapter.openThread({ ...options, modelProvider: 'fb_fixture' }) };
    app = await createApp({ dataDir, codexAdapter: boundary });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  }
  const close = () => new Promise((resolve) => app.close(resolve));
  async function call(method, pathname, body) {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${pathname}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  }
  async function submit(cardId, prompt, model) {
    const composer = (await call('GET', `/api/cards/${cardId}/chat`)).composer;
    const saved = await call('PUT', `/api/cards/${cardId}/chat/composer`, { ...composer, prompt, model });
    const submission = await call('POST', `/api/cards/${cardId}/chat/submissions`, { id: randomUUID(), composerRevision: saved.revision });
    for (let i = 0; i < 200; i++) {
      const chat = await call('GET', `/api/cards/${cardId}/chat`);
      const state = chat.submissions.find((row) => row.id === submission.id);
      if (state.status === 'completed') return chat;
      assert.ok(!['held', 'failed', 'uncertain'].includes(state.status), JSON.stringify(state));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('Installed native HTTP turn did not complete.');
  }
  await start();
  try {
    const workspace = await call('GET', '/api/workspace'); const project = workspace.projects[0];
    const stageId = workspace.flows.find((flow) => flow.id === project.flowId).stages[0].id;
    const card = await call('POST', `/api/projects/${project.id}/cards`, { stageId, title: 'HTTP_NATIVE_CARD', fields: { intro: 'HTTP_NATIVE_FROZEN_INTRO', prompt: 'HTTP_NATIVE_LEGACY_PROMPT' } });
    const first = await submit(card.id, 'HTTP_NATIVE_FIRST_PROMPT', 'gpt-6-luna');
    const binding = first.conversations[0].binding;
    assert.ok(binding.threadId); assert.ok(first.items.some((item) => item.text === 'FB_FIXTURE_RESPONSE'));
    assert.equal(first.submissions[0].context.fields.find((field) => field.key === 'intro').value, 'HTTP_NATIVE_FROZEN_INTRO');
    const serialized = f.peer.requests.map((request) => request.serialized).join('\n');
    assert.match(serialized, /HTTP_NATIVE_FROZEN_INTRO/); assert.doesNotMatch(serialized, /HTTP_NATIVE_LEGACY_PROMPT/);
    await adapter.close({ signal: 'SIGKILL' }); await close();
    adapter = createCodexAdapter({ cwd: f.cwd, env: { ...process.env, CODEX_HOME: f.home }, requestTimeoutMs: 15000 });
    await start();
    const second = await submit(card.id, 'HTTP_NATIVE_FOLLOW_UP', 'gpt-5.6-luna');
    assert.deepEqual(second.conversations[0].binding, binding);
    assert.equal(second.submissions.length, 2); assert.equal(second.attempts.length, 2);
    assert.equal(second.conversations[0].model, 'gpt-5.6-luna');
    const turns = (await adapter.listTurns({ threadId: binding.threadId })).data;
    assert.ok(second.attempts.every((attempt) => turns.some((turn) => turn.items.some((item) => item.type === 'userMessage' && item.clientId === attempt.id))));
    assert.ok(f.peer.requests.every((request) => !request.authorization));
  } finally { if (app.listening) await close(); await adapter.close(); }
});

test('installed native: a crash mid-stream is reconciled read-only after restart, retains partial text and resumes exactly without resending', { skip: !enabled, timeout: 45000 }, async (t) => {
  const f = await nativeFixture(t);
  const dataDir = path.join(path.dirname(f.home), 'recovery-data');
  let app; let adapter = f.adapter;
  async function start() {
    const boundary = { ...adapter, openThread: (options) => adapter.openThread({ ...options, modelProvider: 'fb_fixture' }) };
    app = await createApp({ dataDir, codexAdapter: boundary });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  }
  const close = () => new Promise((resolve) => app.close(resolve));
  async function call(method, pathname, body) {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${pathname}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  }
  async function until(cardId, predicate) {
    for (let i = 0; i < 300; i++) { const chat = await call('GET', `/api/cards/${cardId}/chat`); if (predicate(chat)) return chat; await new Promise((resolve) => setTimeout(resolve, 50)); }
    assert.fail('Installed native recovery did not reach the expected state.');
  }
  async function submit(cardId, prompt) {
    const composer = (await call('GET', `/api/cards/${cardId}/chat`)).composer;
    const saved = await call('PUT', `/api/cards/${cardId}/chat/composer`, { ...composer, prompt, model: 'gpt-6-luna' });
    return call('POST', `/api/cards/${cardId}/chat/submissions`, { id: randomUUID(), composerRevision: saved.revision });
  }
  await start();
  try {
    const workspace = await call('GET', '/api/workspace'); const project = workspace.projects[0];
    const stageId = workspace.flows.find((flow) => flow.id === project.flowId).stages[0].id;
    const card = await call('POST', `/api/projects/${project.id}/cards`, { stageId, title: 'RECOVERY_NATIVE_CARD' });
    f.peer.respond({ text: 'FB_PARTIAL_BEFORE_CRASH', stall: true });
    const stalled = await submit(card.id, 'RECOVERY_STALLED_PROMPT');
    const before = await until(card.id, (chat) => chat.items.some((item) => item.text.includes('FB_PARTIAL_BEFORE_CRASH')));
    const binding = before.conversations[0].binding;
    const sentBefore = f.peer.requests.length;
    await adapter.close({ signal: 'SIGKILL' }); await close();
    adapter = createCodexAdapter({ cwd: f.cwd, env: { ...process.env, CODEX_HOME: f.home }, requestTimeoutMs: 15000 });
    await start();
    const recovered = await until(card.id, (chat) => chat.submissions[0].status === 'interrupted');
    assert.equal(recovered.attempts.length, 1);
    assert.equal(recovered.attempts[0].cause, 'restart');
    assert.ok(recovered.items.some((item) => item.text.includes('FB_PARTIAL_BEFORE_CRASH') && !item.completed));
    assert.equal(f.peer.requests.length, sentBefore, 'Reconciliation made no model request and resent nothing.');
    assert.equal(recovered.submissions[0].id, stalled.id);
    const follow = await submit(card.id, 'RECOVERY_FOLLOW_UP');
    const done = await until(card.id, (chat) => chat.submissions.find((row) => row.id === follow.id)?.status === 'completed');
    assert.deepEqual(done.conversations[0].binding, binding);
    assert.equal(f.peer.requests.filter((request) => request.serialized.includes('RECOVERY_STALLED_PROMPT')).length >= 1, true);
    assert.ok(!f.peer.requests.slice(sentBefore).some((request) => request.serialized.split('RECOVERY_STALLED_PROMPT').length > 2), 'The stalled prompt was never resent as a new user message.');
  } finally { if (app.listening) await close(); await adapter.close(); }
});

async function nativeFixture(t) {
  assert.ok(schema, 'Install Codex before running the native gates.');
  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-native-'));
  const home = path.join(root, 'home'); const cwd = path.join(root, 'card');
  await mkdir(home); await mkdir(cwd);
  const peer = await createResponsesFixture();
  await writeFile(path.join(home, 'config.toml'), `model_provider = "fb_fixture"\n[model_providers.fb_fixture]\nname = "Frameboard loopback test"\nbase_url = "${peer.baseUrl}"\nrequires_openai_auth = false\nwire_api = "responses"\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  await writeFile(path.join(cwd, 'AGENTS.md'), 'FB_UNSELECTED_PROJECT_SENTINEL');
  await mkdir(path.join(home, 'skills', 'unselected'), { recursive: true });
  await writeFile(path.join(home, 'skills', 'unselected', 'SKILL.md'), '---\nname: unselected\ndescription: FB_UNSELECTED_SKILL_SENTINEL\n---\nFB_SKILL_BODY\n');
  const adapter = createCodexAdapter({ cwd, env: { ...process.env, CODEX_HOME: home }, requestTimeoutMs: 15000 });
  t.after(async () => { await adapter.close(); await peer.close(); await rm(root, { recursive: true, force: true }); });
  const selection = { selected: [], instructions: 'FB_SELECTED_INSTRUCTION_SENTINEL' };
  const discovery = await configurationDiscovery(adapter);
  const tools = [{ type: 'function', name: 'fb_card_tool', description: 'FB_CARD_TOOL_SENTINEL', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
  const frozen = compileConfiguration(selection, discovery, tools);
  assert.equal(frozen.supported, true, frozen.reasons.join(' '));
  const bindings = new Map();
  async function open(threadId, model = 'gpt-6-luna', snapshot = frozen, current = discovery) {
    const opened = await openConfiguredThread(adapter, { binding: threadId ? bindings.get(threadId) : null, frozen: snapshot, currentSelection: { selected: snapshot.selected, instructions: snapshot.instructions }, discovery: current, threadId, cwd, model, modelProvider: 'fb_fixture' });
    bindings.set(opened.threadId, structuredClone(opened.binding));
    return opened;
  }
  async function turn(threadId, { tool = true, model, text = 'native gate', clientUserMessageId = 'native-attempt', fullAccess = false } = {}) {
    const before = peer.requests.length; const events = [];
    let complete;
    const done = new Promise((resolve) => { complete = resolve; });
    const remove = adapter.subscribe(threadId, {
      onToolCall: (request) => {
        assert.equal(request.tool, 'fb_card_tool');
        return { success: true, contentItems: [{ type: 'inputText', text: 'FB_TOOL_RESULT_SENTINEL' }] };
      },
      onEvent: (event) => { events.push(event); if (event.type === 'turn-completed') complete(event); },
    });
    if (tool) peer.respond({ functionCall: { name: 'fb_card_tool', arguments: {} } });
    try {
      const start = await adapter.startTurn({ threadId, input: [{ type: 'text', text }], clientUserMessageId, fullAccess, ...(model ? { model } : {}) });
      const terminal = await done;
      assert.equal(terminal.status, 'completed');
      const requests = peer.requests.slice(before);
      assert.ok(requests.length);
      assert.ok(requests.every((r) => !r.authorization), 'The loopback peer must never receive credentials.');
      const serialized = requests.map((r) => r.serialized).join('\n');
      assert.match(serialized, /FB_SELECTED_INSTRUCTION_SENTINEL/);
      assert.doesNotMatch(serialized, /FB_UNSELECTED_PROJECT_SENTINEL|FB_UNSELECTED_SKILL_SENTINEL/);
      if (tool) assert.ok(events.some((e) => e.type === 'item-completed' && e.item.type === 'dynamicToolCall' && e.item.success));
      return { ...start, events, serialized };
    } finally { remove(); }
  }
  return { adapter, home, cwd, peer, selection, discovery, frozen, open, turn };
}

test('installed native: three HTTP cards with text, approval and image work progress independently', { skip: !enabled, timeout: 45000 }, async (t) => {
  let app;
  t.after(() => app?.listening && new Promise((resolve) => app.close(resolve)));
  const f = await nativeFixture(t);
  const dataDir = path.join(path.dirname(f.home), 'concurrent-data');
  const boundary = { ...f.adapter, openThread: (options) => f.adapter.openThread({ ...options, modelProvider: 'fb_fixture' }) };
  app = await createApp({ dataDir, codexAdapter: boundary });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  async function call(method, pathname, body) {
    const res = await fetch(`http://127.0.0.1:${app.address().port}${pathname}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await res.json(); assert.ok(res.ok, JSON.stringify(value)); return value;
  }
  async function until(fn) {
    for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); }
    assert.fail('Installed concurrent cards did not reach the expected state.');
  }
  const workspace = await call('GET', '/api/workspace'); const project = workspace.projects[0];
  const stageId = workspace.flows.find((flow) => flow.id === project.flowId).stages[0].id;
  const cards = [];
  for (const title of ['Approval', 'Text', 'Image']) cards.push(await call('POST', `/api/projects/${project.id}/cards`, { stageId, title }));
  const [approval, text, image] = cards;
  const chat = (id) => call('GET', `/api/cards/${id}/chat`);
  async function submit(card) {
    const composer = (await chat(card.id)).composer;
    const saved = await call('PUT', `/api/cards/${card.id}/chat/composer`, { ...composer, prompt: `${card.title} concurrency gate`, model: 'gpt-6-luna' });
    await call('POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: saved.revision });
  }
  const outside = await mkdtemp('/var/tmp/frameboard-concurrent-');
  t.after(() => rm(outside, { recursive: true, force: true }));
  f.peer.respond({ functionCall: { name: 'exec_command', arguments: { cmd: `printf test > '${path.join(outside, 'approval.txt')}'`, sandbox_permissions: 'require_escalated', justification: 'Bounded native approval validation.', yield_time_ms: 1000 } } });
  await submit(approval);
  const pending = await until(async () => (await chat(approval.id)).requests.find((request) => request.status === 'pending'));
  f.peer.respond({ text: 'CONCURRENT_PARTIAL_TEXT', stall: true });
  await submit(text);
  await until(async () => (await chat(text.id)).items.some((item) => item.text === 'CONCURRENT_PARTIAL_TEXT'));
  // Native register_image imports a rendered file. Real raster generation and
  // recovery are validated separately against the signed-in account.
  const imageWorkspace = path.join(dataDir, 'workspaces', image.id);
  await mkdir(imageWorkspace, { recursive: true });
  await writeFile(path.join(imageWorkspace, 'rendered.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64'));
  f.peer.respond({ functionCall: { name: 'register_image', arguments: { path: 'rendered.png', name: 'Concurrent rendered image' } } });
  await submit(image);
  const rendered = await until(async () => { const value = await chat(image.id); return value.submissions[0].status === 'completed' && value; });
  assert.equal(rendered.outputs.length, 1); assert.equal(rendered.outputs[0].importStatus, 'imported');
  assert.equal(rendered.outputs[0].creationMethod, 'code-rendered');
  assert.equal((await chat(approval.id)).requests[0].status, 'pending');
  assert.equal((await chat(text.id)).attempts[0].status, 'running');
  await call('POST', `/api/cards/${text.id}/chat/stop`, {});
  await until(async () => (await chat(text.id)).submissions[0].status === 'interrupted');
  await call('POST', `/api/cards/${approval.id}/chat/answer`, { requestId: pending.id, response: { decision: 'accept', scope: 'once' } });
  await until(async () => (await chat(approval.id)).submissions[0].status === 'completed');
  const snapshots = await Promise.all(cards.map((card) => chat(card.id)));
  assert.ok(snapshots.every((value) => value.attempts.length === 1));
  assert.equal(new Set(snapshots.map((value) => value.conversations[0].binding.threadId)).size, 3);
  assert.ok(f.peer.requests.every((request) => !request.authorization));
});

test('installed native: exact resume, persisted dynamic tools, model change, unload and crash isolation', { skip: !enabled, timeout: 45000 }, async (t) => {
  const f = await nativeFixture(t);
  const a = await f.open(); const b = await f.open(); assert.notEqual(a.threadId, b.threadId);
  await f.turn(a.threadId); await f.turn(b.threadId);
  await f.adapter.unsubscribeThread({ threadId: a.threadId });
  assert.equal((await f.open(a.threadId)).threadId, a.threadId);
  await f.turn(a.threadId);
  // Unlike unsubscribe, archive removes the actual loaded native session.
  await f.adapter.archiveThread({ threadId: a.threadId });
  assert.ok(!(await f.adapter.listLoadedThreads()).data.includes(a.threadId));
  await f.adapter.unarchiveThread({ threadId: a.threadId });
  assert.equal((await f.open(a.threadId)).threadId, a.threadId);
  await f.turn(a.threadId);
  await f.adapter.close({ signal: 'SIGKILL' });
  assert.equal((await f.open(a.threadId)).threadId, a.threadId);
  await f.turn(a.threadId, { model: 'gpt-5.6-luna' });
  assert.equal((await f.adapter.readThread({ threadId: a.threadId })).thread.model, 'gpt-5.6-luna');
  await f.open(b.threadId); await f.turn(b.threadId);
  const full = await f.adapter.listTurns({ threadId: a.threadId, limit: 2 });
  assert.equal(full.data.length, 2); assert.ok(full.nextCursor);
  assert.equal(full.data[0].items.find((item) => item.type === 'userMessage').clientId, 'native-attempt');
  const items = await f.adapter.listItems({ threadId: a.threadId, turnId: full.data[0].id, limit: 100 });
  assert.ok(items.data.length, 'Full item reconciliation must be available.');
  t.diagnostic(`${schema.version}; gpt-6-luna → gpt-5.6-luna; loopback provider; configuration ${f.frozen.id}; ${f.peer.requests.length} credential-free requests.`);
});

test('installed native: newly discovered skills and global instructions hold frozen work after restart', { skip: !enabled, timeout: 45000 }, async (t) => {
  const f = await nativeFixture(t); const a = await f.open(); await f.turn(a.threadId);
  await f.adapter.close({ signal: 'SIGKILL' });
  await mkdir(path.join(f.home, 'skills', 'new'), { recursive: true });
  await writeFile(path.join(f.home, 'skills', 'new', 'SKILL.md'), '---\nname: new\ndescription: FB_NEW_SKILL_SENTINEL\n---\nNew guidance.\n');
  const latest = await configurationDiscovery(f.adapter);
  assert.ok(latest.skills.some((s) => /\/new\/SKILL.md$/.test(s.id)));
  assert.equal(queuedConfigurationDecision(f.frozen, f.selection, latest).status, 'held');
  const revised = compileConfiguration(f.selection, latest, f.frozen.nativeOptions.dynamicTools);
  assert.equal(revised.supported, true);
  await f.open(a.threadId, 'gpt-6-luna', revised, latest).then(() => assert.fail('A changed loaded binding requires fresh context.'), (e) => assert.equal(e.kind, 'fresh-context-required'));
  const fresh = await f.open(undefined, 'gpt-6-luna', revised, latest);
  const output = await f.turn(fresh.threadId); assert.doesNotMatch(output.serialized, /FB_NEW_SKILL_SENTINEL/);
  await f.adapter.close();
  await writeFile(path.join(f.home, 'AGENTS.md'), 'FB_GLOBAL_INSTRUCTION_SENTINEL');
  const global = await configurationDiscovery(f.adapter);
  const blocked = compileConfiguration(f.selection, global);
  assert.equal(blocked.supported, false); assert.match(blocked.reasons.join(' '), /Unselected global instructions/);
});

test('installed native: missing rollout cannot be resumed or silently replaced; reconciliation performs no inference', { skip: !enabled, timeout: 45000 }, async (t) => {
  const f = await nativeFixture(t); const a = await f.open(); await f.turn(a.threadId);
  const empty = await f.open();
  await f.adapter.close();
  await assert.rejects(f.open(empty.threadId), { kind: 'native-unavailable' });
  const before = f.peer.requests.length;
  const view = await f.adapter.readThread({ threadId: a.threadId });
  const turns = await f.adapter.listTurns({ threadId: a.threadId, limit: 1 }); assert.equal(turns.data.length, 1);
  assert.equal(f.peer.requests.length, before);
  await f.adapter.close(); await rm(view.thread.path);
  // SQLite metadata can survive a missing rollout. Metadata alone is no proof
  // of retained history; exact resume must still fail without a new binding.
  await assert.rejects(f.open(a.threadId), { kind: 'native-unavailable' });
  assert.equal(f.peer.requests.length, before);
});

test('installed native: two shared-process configurations keep distinct instructions after crash', { skip: !enabled, timeout: 45000 }, async (t) => {
  const f = await nativeFixture(t);
  const aConfig = compileConfiguration({ ...f.selection, instructions: f.selection.instructions + '\nFB_CARD_A_SENTINEL' }, f.discovery, f.frozen.nativeOptions.dynamicTools);
  const bConfig = compileConfiguration({ ...f.selection, instructions: f.selection.instructions + '\nFB_CARD_B_SENTINEL' }, f.discovery, f.frozen.nativeOptions.dynamicTools);
  const a = await f.open(undefined, 'gpt-6-luna', aConfig); const b = await f.open(undefined, 'gpt-6-luna', bConfig);
  const first = await f.turn(a.threadId); assert.match(first.serialized, /FB_CARD_A_SENTINEL/); assert.doesNotMatch(first.serialized, /FB_CARD_B_SENTINEL/);
  const other = await f.turn(b.threadId); assert.match(other.serialized, /FB_CARD_B_SENTINEL/); assert.doesNotMatch(other.serialized, /FB_CARD_A_SENTINEL/);
  await f.adapter.archiveThread({ threadId: a.threadId });
  const loaded = (await f.adapter.listLoadedThreads()).data;
  assert.ok(!loaded.includes(a.threadId)); assert.ok(loaded.includes(b.threadId));
  await f.adapter.unarchiveThread({ threadId: a.threadId });
  await f.open(a.threadId, 'gpt-6-luna', aConfig);
  const reloaded = await f.turn(a.threadId); assert.match(reloaded.serialized, /FB_CARD_A_SENTINEL/); assert.doesNotMatch(reloaded.serialized, /FB_CARD_B_SENTINEL/);
  const retained = await f.turn(b.threadId); assert.match(retained.serialized, /FB_CARD_B_SENTINEL/); assert.doesNotMatch(retained.serialized, /FB_CARD_A_SENTINEL/);
  await f.adapter.close({ signal: 'SIGKILL' });
  await f.open(a.threadId, 'gpt-6-luna', aConfig); await f.open(b.threadId, 'gpt-6-luna', bConfig);
  const restoredA = await f.turn(a.threadId); const restoredB = await f.turn(b.threadId);
  assert.match(restoredA.serialized, /FB_CARD_A_SENTINEL/); assert.doesNotMatch(restoredA.serialized, /FB_CARD_B_SENTINEL/);
  assert.match(restoredB.serialized, /FB_CARD_B_SENTINEL/); assert.doesNotMatch(restoredB.serialized, /FB_CARD_A_SENTINEL/);
});

test('installed native: explicitly selected global guidance is exact on cold resume; removal holds queued work', { skip: !enabled, timeout: 45000 }, async (t) => {
  const f = await nativeFixture(t); await f.adapter.close();
  await writeFile(path.join(f.home, 'AGENTS.md'), 'FB_SELECTED_GLOBAL_SENTINEL');
  const discovered = await configurationDiscovery(f.adapter);
  const global = discovered.items.find((item) => item.kind === 'instruction'); assert.ok(global);
  const selection = { ...f.selection, selected: [global.id] };
  const frozen = compileConfiguration(selection, discovered, f.frozen.nativeOptions.dynamicTools);
  assert.equal(frozen.supported, true, frozen.reasons.join(' '));
  const a = await f.open(undefined, 'gpt-6-luna', frozen, discovered);
  assert.match((await f.turn(a.threadId)).serialized, /FB_SELECTED_GLOBAL_SENTINEL/);
  await f.adapter.close({ signal: 'SIGKILL' });
  await f.open(a.threadId, 'gpt-6-luna', frozen, discovered);
  assert.match((await f.turn(a.threadId)).serialized, /FB_SELECTED_GLOBAL_SENTINEL/);
  const before = f.peer.requests.length;
  assert.equal(queuedConfigurationDecision(frozen, f.selection, discovered).status, 'held');
  await assert.rejects(openConfiguredThread(f.adapter, { frozen, discovery: discovered, currentSelection: f.selection, threadId: a.threadId, binding: a.binding, cwd: f.cwd, model: 'gpt-6-luna', modelProvider: 'fb_fixture' }), { kind: 'configuration-unavailable' });
  assert.equal(f.peer.requests.length, before);
});
