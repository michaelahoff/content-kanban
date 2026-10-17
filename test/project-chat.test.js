import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, waitFor } from './support/chat-fixture.js';
import { createClaudeAdapter } from '../claude-adapter.js';
import { compileConfiguration, queuedConfigurationDecision } from '../provider-configuration.js';
import { builderInstructions, builderTools } from '../flow-builder-tools.js';
import { cardInstructions } from '../codex-configuration.js';

const lanes = [{ name: 'Inbox', playbook: { run: 'off' } }, { name: 'Draft', playbook: { may_edit: ['intro'], instructions: 'Write the intro.' } }, { name: 'Done' }];
async function projectChat(t, options) {
  const f = await fixture(t, options);
  const { projects } = await f.ok('GET', '/api/workspace');
  const project = projects[0];
  const url = (action = '') => `/api/projects/${project.id}/chat${action ? `/${action}` : ''}`;
  const snapshot = () => f.ok('GET', url());
  const say = (prompt, extra = {}) => f.ok('POST', url('turns'), { id: randomUUID(), prompt, ...extra });
  const settled = (turnId) => waitFor(async () => (await snapshot()).turns.find((turn) => turn.id === turnId && !['queued', 'running', 'interrupt-requested'].includes(turn.status)));
  return { ...f, project, url, snapshot, say, settled };
}

test('the builder role freezes its own guidance and tools into a configuration that stays ready', async (t) => {
  const f = await fixture(t);
  const discovery = await f.codex.discover({ cwd: f.dataDir });
  const selection = { instructions: 'House style.', selected: [] };
  const card = compileConfiguration(selection, { ...discovery, items: [], errors: [], mandatoryBehavior: [] }, [], 'codex');
  const builder = compileConfiguration(selection, { ...discovery, items: [], errors: [], mandatoryBehavior: [] }, builderTools, 'codex', 'builder');
  assert.ok(card.nativeOptions.developerInstructions.startsWith(cardInstructions));
  assert.ok(builder.nativeOptions.developerInstructions.startsWith(builderInstructions.slice(0, 60)));
  assert.ok(builder.nativeOptions.developerInstructions.endsWith('House style.'));
  assert.equal(builder.role, 'builder');
  assert.equal(card.role, undefined, 'card configurations keep their identity');
  assert.notEqual(card.id, builder.id);
  assert.deepEqual(builder.nativeOptions.dynamicTools.map((tool) => tool.name), builderTools.map((tool) => tool.name));
  assert.deepEqual(queuedConfigurationDecision(builder, selection, { ...discovery, items: [], errors: [], mandatoryBehavior: [] }), { status: 'ready' });
  const claude = compileConfiguration(selection, { cwd: f.dataDir, harness: { userAgent: 'Claude Code' } }, builderTools, 'claude', 'builder');
  assert.equal(claude.role, 'builder');
  assert.ok(claude.nativeOptions.developerInstructions.includes('flow builder'));
  assert.deepEqual(queuedConfigurationDecision(claude, selection, { cwd: f.dataDir, harness: { userAgent: 'Claude Code' } }), { status: 'ready' });
});

test('a project chat message becomes one native turn of the flow builder, whose tools build the flow', async (t) => {
  const f = await projectChat(t);
  const empty = await f.snapshot();
  assert.deepEqual([empty.provider, empty.model, empty.busy, empty.turns, empty.conversations.length], ['codex', null, false, [], 1]);
  const turn = await f.say('Build me an intro-writing flow.', { model: 'test-model' });
  assert.deepEqual([turn.status, turn.provider, turn.model], ['queued', 'codex', 'test-model']);
  const send = await waitFor(() => f.codex.sends[0]);
  const text = send.input[0].text;
  assert.ok(text.startsWith(`## Project “My project” (${f.project.id}) right now`), 'the message begins with the project summary');
  assert.ok(text.includes('Flow “Main” (board, id'));
  assert.ok(text.endsWith('## Message\n\nBuild me an intro-writing flow.'));
  const thread = f.codex.threads.get(send.threadId);
  assert.ok(thread.config.developerInstructions.includes("You are Frameboard's flow builder"));
  assert.ok(thread.config.developerInstructions.includes('read_project'));
  assert.deepEqual(thread.config.dynamicTools.map((tool) => tool.name).slice(0, 4), ['read_project', 'read_flow', 'read_template', 'create_flow']);
  assert.ok(send.threadId !== undefined && thread.cwd.endsWith(`project-chat-${f.project.id}`), 'the chat has its own workspace');
  assert.equal((await f.snapshot()).turns[0].status, 'running');
  await assert.rejects(f.say('Another one'), /Wait for the current reply/);

  const seen = await f.codex.tool(send, 'read_project', {});
  assert.equal(seen.success, true);
  assert.equal(JSON.parse(seen.contentItems[0].text).project.name, 'My project');
  const mainId = JSON.parse(seen.contentItems[0].text).flows[0].id;
  const built = await f.codex.tool(send, 'create_flow', { flowId: mainId, name: 'Intros', lanes }, 'call-1');
  assert.equal(built.success, true, built.contentItems[0].text);
  const result = JSON.parse(built.contentItems[0].text);
  assert.deepEqual(result.flow.lanes.map((lane) => lane.name), ['Inbox', 'Draft', 'Done']);
  const repeated = await f.codex.tool(send, 'create_flow', { flowId: mainId, name: 'Intros', lanes }, 'call-1');
  assert.deepEqual(JSON.parse(repeated.contentItems[0].text), result, 'a repeated call identity gets the first result');
  const refused = await f.codex.tool(send, 'create_flow', { flowId: mainId, name: 'Intros', lanes: [{ name: 'A', color: 'plaid' }] }, 'call-2');
  assert.equal(refused.success, false);
  assert.match(refused.contentItems[0].text, /color must be one of/);
  const unknown = await f.codex.tool(send, 'delete_project', {}, 'call-3');
  assert.match(unknown.contentItems[0].text, /Unknown Frameboard tool/);
  const workspace = await f.ok('GET', '/api/workspace');
  assert.deepEqual(workspace.flows.find((flow) => flow.id === mainId).stages.map((stage) => stage.name), ['Inbox', 'Draft', 'Done']);
  assert.equal(workspace.flows.find((flow) => flow.id === mainId).name, 'Intros');

  f.codex.emit(send.threadId, { type: 'delta', turnId: send.turnId, itemId: 'reply', delta: 'Built ' });
  f.codex.emit(send.threadId, { type: 'delta', turnId: send.turnId, itemId: 'reply', delta: 'it.' });
  f.codex.finish(send, 'completed', 'Built it.');
  const done = await f.settled(turn.id);
  assert.equal(done.status, 'completed');
  const after = await f.snapshot();
  assert.deepEqual(after.items.filter((item) => item.kind === 'agentMessage').map((item) => [item.text, item.completed]).at(-1), ['Built it.', true]);
  assert.equal(after.busy, false);
  assert.deepEqual([after.provider, after.model], ['codex', 'test-model'], 'the chat remembers the last choice');
  const events = (await f.ok('GET', '/api/events?since=0')).events.filter((event) => event.entity === 'project-chat');
  assert.deepEqual(events.map((event) => event.type).filter((type, index, all) => all.indexOf(type) === index), ['turn_queued', 'turn_running', 'tool_called', 'transcript_updated', 'turn_completed']);
  const call = events.find((event) => event.type === 'tool_called');
  assert.equal(call.actor, `automation:project-chat:${turn.id}`);
  assert.deepEqual([call.projectId, call.data.tool], [f.project.id, 'read_project']);
  const created = (await f.ok('GET', '/api/events?since=0')).events.find((event) => event.entity === 'stage' && event.type === 'created');
  assert.equal(created.actor, `automation:project-chat:${turn.id}`, 'the builder\'s changes name the turn that made them');
});

test('deltas stream to the browser with the project, and a second message continues the same native conversation', async (t) => {
  const f = await projectChat(t);
  const stream = await f.stream({ since: (await f.ok('GET', '/api/workspace')).eventCursor });
  const first = await f.say('Hello', { model: 'test-model' });
  const send = await waitFor(() => f.codex.sends[0]);
  f.codex.emit(send.threadId, { type: 'delta', turnId: send.turnId, itemId: 'reply', delta: 'Hi' });
  const delta = await stream.until((frame) => frame.event === 'delta');
  assert.deepEqual(delta.data, { projectId: f.project.id, turnId: first.id, itemId: 'reply', offset: 0, text: 'Hi' });
  f.codex.finish(send, 'completed', 'Hi there.');
  await f.settled(first.id);
  const second = await f.say('And again', { model: 'test-model' });
  const next = await waitFor(() => f.codex.sends[1]);
  assert.equal(next.threadId, send.threadId, 'the conversation resumes its native thread');
  assert.ok(next.input[0].text.includes('## Message\n\nAnd again'));
  f.codex.finish(next, 'completed', 'Done.');
  assert.equal((await f.settled(second.id)).status, 'completed');
  assert.equal((await f.snapshot()).conversations.length, 1);
  assert.ok((await f.snapshot()).conversations[0].bound);
});

test('Stop ends a running turn, fresh context starts a new native conversation, and a provider switch needs one', async (t) => {
  const f = await projectChat(t);
  const turn = await f.say('Take your time', { model: 'test-model' });
  const send = await waitFor(() => f.codex.sends[0]);
  const stopped = await f.ok('POST', f.url('stop'), {});
  assert.ok(['interrupt-requested', 'interrupted'].includes(stopped.turn.status));
  const after = await f.settled(turn.id);
  assert.equal(after.status, 'interrupted');
  assert.deepEqual(f.codex.interrupts.map((entry) => entry.turnId), [send.turnId]);
  assert.ok((await f.snapshot()).items.some((item) => item.text === 'Stopped partial reply'));
  await assert.rejects(f.ok('POST', f.url('stop'), {}), /Nothing is running/);
  const claude = await f.ok('GET', '/api/providers/claude');
  await f.ok('PUT', '/api/providers/claude', { revision: claude.revision, selection: { ...claude.selection, enabled: true } });
  await assert.rejects(f.say('Switch', { provider: 'claude' }), /Start fresh context before switching providers/);
  const fresh = await f.ok('POST', f.url('fresh'), {});
  assert.deepEqual(fresh.conversations.map((conversation) => conversation.state), ['previous', 'active']);
  const again = await f.say('New start', { model: 'other-model' });
  const next = await waitFor(() => f.codex.sends[1]);
  assert.notEqual(next.threadId, send.threadId, 'fresh context opens a new native thread');
  f.codex.finish(next, 'completed', 'Fresh.');
  assert.equal((await f.settled(again.id)).model, 'other-model');
  assert.equal((await f.snapshot()).turns.length, 2);
});

test('a turn without a model takes the provider default, and one with an unavailable model fails in the transcript', async (t) => {
  const f = await projectChat(t);
  const turn = await f.say('Default please');
  const send = await waitFor(() => f.codex.sends[0]);
  assert.equal(send.model, 'test-model');
  assert.equal((await f.snapshot()).turns[0].model, 'test-model');
  f.codex.finish(send, 'completed', 'OK.');
  await f.settled(turn.id);
  const bad = await f.say('Use a ghost model', { model: 'ghost-model' });
  const failed = await f.settled(bad.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /ghost-model is not available for Codex/);
  assert.equal(f.codex.sends.length, 1, 'nothing was sent');
  const disabled = await f.ok('GET', '/api/providers/codex');
  await f.ok('PUT', '/api/providers/codex', { revision: disabled.revision, selection: { ...disabled.selection, enabled: false } });
  await assert.rejects(f.say('Now?'), /disabled|Enable/);
});

test('a restart ends an unfinished turn and the next message continues the bound conversation', async (t) => {
  const f = await projectChat(t);
  const turn = await f.say('Keep going', { model: 'test-model' });
  const send = await waitFor(() => f.codex.sends[0]);
  await f.restart();
  const after = (await f.snapshot()).turns.find((entry) => entry.id === turn.id);
  assert.equal(after.status, 'interrupted');
  assert.match(after.reason, /Frameboard restarted/);
  assert.equal((await f.snapshot()).busy, false);
  const again = await f.say('Still there?', { model: 'test-model' });
  const next = await waitFor(() => f.codex.sends[1]);
  assert.equal(next.threadId, send.threadId);
  f.codex.finish(next, 'completed', 'Yes.');
  assert.equal((await f.settled(again.id)).status, 'completed');
});

test('an archived project\'s chat stays readable and refuses new messages', async (t) => {
  const f = await projectChat(t);
  const turn = await f.say('Before archive', { model: 'test-model' });
  f.codex.finish(await waitFor(() => f.codex.sends[0]), 'completed', 'Done.');
  await f.settled(turn.id);
  await f.ok('POST', `/api/projects/${f.project.id}/archive`, {});
  const seen = await f.snapshot();
  assert.ok(seen.archived);
  assert.equal(seen.turns.length, 1);
  await assert.rejects(f.say('After archive'), /archived/);
  await assert.rejects(f.ok('POST', f.url('fresh'), {}), /archived/);
});

const fakeClaude = fileURLToPath(new URL('./support/fake-claude.js', import.meta.url));
test('Claude gets the flow builder\'s tools through the SDK-hosted MCP server', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'frameboard-claude-builder-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const claude = createClaudeAdapter({ command: process.execPath, args: [fakeClaude], cwd: home, env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
  const f = await projectChat(t, { claudeAdapter: { ...claude, protectRetainedData: undefined } });
  const settings = await f.ok('GET', '/api/providers/claude');
  await f.ok('PUT', '/api/providers/claude', { revision: settings.revision, selection: { ...settings.selection, enabled: true } });
  const turn = await f.say('tool:read_project {}', { provider: 'claude', model: 'sonnet' });
  const done = await f.settled(turn.id);
  assert.equal(done.status, 'completed', done.reason);
  const reply = (await f.snapshot()).items.find((item) => item.text?.startsWith('Tool reply'));
  const result = JSON.parse(reply.text.slice('Tool reply '.length));
  assert.deepEqual(result.tools, builderTools.map((tool) => tool.name));
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.text).project.name, 'My project');
  assert.ok((await f.snapshot()).items.some((item) => item.kind === 'dynamicToolCall' && item.data.tool === 'read_project'), 'the call shows in the transcript activity');
  assert.ok((await f.snapshot()).conversations[0].bound);
  assert.equal(f.codex.sends.length, 0);
});
