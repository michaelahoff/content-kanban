import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeAdapter } from '../claude-adapter.js';
import { waitFor } from './support/chat-fixture.js';
const fixtureCommand = fileURLToPath(new URL('./support/fake-claude.js', import.meta.url));
async function fixture(t, extra = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'frameboard-claude-'));
  const options = { command: process.execPath, args: [fixtureCommand], cwd: directory, env: { ...process.env, CLAUDE_CONFIG_DIR: directory }, ...extra };
  const adapter = createClaudeAdapter(options);
  t.after(async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }); });
  return { adapter, directory, options };
}
test('Claude discovery initializes without inference, strips account details, and closes its process', async (t) => {
  const { adapter } = await fixture(t); const discovery = await adapter.discover();
  assert.deepEqual(discovery.models.map((model) => model.id), ['sonnet', 'opus']);
  assert.ok(!JSON.stringify(discovery).includes('must-not-persist')); assert.equal(adapter.running, false);
});
const pro = { apiProvider: 'firstParty', subscriptionType: 'Claude Pro' };
const sonnetEvidence = [{ harness: '2.1.291', model: 'claude-fixture-sonnet', account: pro, retainedDataProtection: false, pages: 600, checked: '2026-10-08' }];
test('Claude discovery reports its harness version, account kind and each model\'s recorded PDF route, keeping no account identity', async (t) => {
  const { adapter } = await fixture(t, { pdfEvidence: sonnetEvidence });
  const discovery = await adapter.discover();
  assert.equal(discovery.harness.version, '2.1.291');
  assert.deepEqual(discovery.harness.account, pro);
  assert.deepEqual(discovery.models.map((model) => [model.id, model.pdf.available]), [['sonnet', true], ['opus', false]]);
  assert.equal(discovery.models[0].pdf.pages, 600);
  assert.match(discovery.models[1].pdf.reason, /No passing PDF check is recorded for Claude Code 2\.1\.291 with claude-fixture-opus on a Claude Pro account/);
  assert.ok(!JSON.stringify(discovery).includes('fixture@example.com'));
});
test('Claude transport streams exact text/image input, resumes its native history, and stops without replay', async (t) => {
  const { adapter, directory, options } = await fixture(t);
  const opened = await adapter.openThread({ cwd: directory, model: 'sonnet', threadConfig: { developerInstructions: 'Guidance' } });
  const events = []; adapter.subscribe(opened.threadId, { onEvent: (event) => events.push(event) });
  const image = path.join(directory, 'image.png'); await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
  const attempt = randomUUID();
  await adapter.startTurn({ threadId: opened.threadId, model: 'sonnet', clientUserMessageId: attempt, input: [{ type: 'text', text: 'Hello' }, { type: 'localImage', path: image }] });
  await waitFor(() => events.find((event) => event.type === 'turn-completed'));
  assert.ok(events.some((event) => event.type === 'delta' && event.delta.includes('text,image')));
  const turns = await adapter.listTurns({ threadId: opened.threadId });
  assert.equal(turns.data[0].items[0].clientId, attempt); assert.equal(turns.data[0].status, 'completed');
  await adapter.close();
  const reopened = createClaudeAdapter(options); t.after(() => reopened.close());
  reopened.bindHistory({ threadId: opened.threadId, cwd: directory });
  assert.equal((await reopened.listTurns({ threadId: opened.threadId })).data[0].id, attempt);
  const resumed = await reopened.openThread({ threadId: opened.threadId, cwd: directory, model: 'opus', threadConfig: { developerInstructions: 'Guidance' } });
  assert.equal(resumed.threadId, opened.threadId);
  const after = []; reopened.subscribe(resumed.threadId, { onEvent: (event) => after.push(event) });
  const second = randomUUID();
  await reopened.startTurn({ threadId: resumed.threadId, model: 'opus', clientUserMessageId: second, input: [{ type: 'text', text: 'wait' }] });
  await reopened.interrupt({ threadId: resumed.threadId, turnId: second });
  await waitFor(() => after.find((event) => event.type === 'turn-completed' && event.status === 'interrupted'));
});
const userContent = async (directory, threadId) => (await readFile(path.join(directory, 'projects', directory.replace(/[^a-zA-Z0-9]/g, '-'), `${threadId}.jsonl`), 'utf8'))
  .trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.type === 'user').at(-1).message.content;
test('Claude transport translates a PDF into a native document block of its exact bytes, and refuses bytes that are not a PDF', async (t) => {
  const { adapter, directory } = await fixture(t);
  const opened = await adapter.openThread({ cwd: directory, model: 'sonnet', threadConfig: { developerInstructions: '' } });
  const events = []; adapter.subscribe(opened.threadId, { onEvent: (event) => events.push(event) });
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n'); const brief = path.join(directory, 'brief.pdf'); await writeFile(brief, bytes);
  await adapter.startTurn({ threadId: opened.threadId, model: 'sonnet', clientUserMessageId: randomUUID(), input: [{ type: 'text', text: 'Read it' }, { type: 'localDocument', path: brief }] });
  await waitFor(() => events.find((event) => event.type === 'turn-completed'));
  assert.deepEqual((await userContent(directory, opened.threadId))[1], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } });
  const zip = path.join(directory, 'renamed.pdf'); await writeFile(zip, Buffer.from('PK\x03\x04', 'latin1'));
  await assert.rejects(adapter.startTurn({ threadId: opened.threadId, model: 'sonnet', clientUserMessageId: randomUUID(), input: [{ type: 'text', text: 'Read it' }, { type: 'localDocument', path: zip }] }), /not a PDF/);
});
test('a PDF Claude removes as unprocessable fails the turn, never letting it count as completed without the PDF', async (t) => {
  const { adapter, directory } = await fixture(t);
  const opened = await adapter.openThread({ cwd: directory, model: 'sonnet', threadConfig: { developerInstructions: '' } });
  const events = []; adapter.subscribe(opened.threadId, { onEvent: (event) => events.push(event) });
  const brief = path.join(directory, 'brief.pdf'); await writeFile(brief, Buffer.from('%PDF-1.4\nunprocessable\n%%EOF\n'));
  await adapter.startTurn({ threadId: opened.threadId, model: 'sonnet', clientUserMessageId: randomUUID(), input: [{ type: 'text', text: 'Read it' }, { type: 'localDocument', path: brief }] });
  const completed = await waitFor(() => events.find((event) => event.type === 'turn-completed'));
  assert.match(events.find((event) => event.type === 'input-rejected')?.reason ?? '', /could not process a PDF/);
  assert.equal(completed.status, 'failed');
  assert.match(completed.error.message, /removed it/);
});
test('a removed-document error in a turn that sent no PDF leaves that turn to complete', async (t) => {
  const { adapter, directory } = await fixture(t);
  const opened = await adapter.openThread({ cwd: directory, model: 'sonnet', threadConfig: { developerInstructions: '' } });
  const events = []; adapter.subscribe(opened.threadId, { onEvent: (event) => events.push(event) });
  await adapter.startTurn({ threadId: opened.threadId, model: 'sonnet', clientUserMessageId: randomUUID(), input: [{ type: 'text', text: 'earlier document removed' }] });
  const completed = await waitFor(() => events.find((event) => event.type === 'turn-completed'));
  assert.equal(completed.status, 'completed');
  assert.ok(!events.some((event) => event.type === 'input-rejected'));
});
test('a Claude session opened here that has had no turn yet lists no turns instead of reporting its history missing', async (t) => {
  const { adapter, directory } = await fixture(t);
  const opened = await adapter.openThread({ cwd: directory, model: 'sonnet', threadConfig: { developerInstructions: '' } });
  assert.deepEqual(await adapter.listTurns({ threadId: opened.threadId }), { data: [], nextCursor: null });
  const other = await fixture(t); other.adapter.bindHistory({ threadId: opened.threadId, cwd: directory });
  await assert.rejects(other.adapter.listTurns({ threadId: opened.threadId }), /history is unavailable/, 'a bound session without its history is still missing');
});
test('a reply streamed after a thinking block completes as one text item, live and from history', async (t) => {
  const { adapter, directory } = await fixture(t);
  const opened = await adapter.openThread({ cwd: directory, model: 'sonnet', threadConfig: { developerInstructions: '' } });
  const events = []; adapter.subscribe(opened.threadId, { onEvent: (event) => events.push(event) });
  await adapter.startTurn({ threadId: opened.threadId, model: 'sonnet', clientUserMessageId: randomUUID(), input: [{ type: 'text', text: 'think' }] });
  await waitFor(() => events.find((event) => event.type === 'turn-completed'));
  const streamed = events.filter((event) => event.type === 'delta').map((event) => event.itemId);
  const completed = events.filter((event) => event.type === 'item-completed').map((event) => event.item.id);
  assert.deepEqual([...new Set(streamed)], completed);
  const history = (await adapter.listTurns({ threadId: opened.threadId })).data[0].items.filter((item) => item.type === 'agentMessage');
  assert.deepEqual(history.map((item) => item.id), completed);
});
test('Claude rejects missing installations and unavailable models before input delivery', async (t) => {
  const missing = createClaudeAdapter({ command: '/nonexistent/frameboard-claude', timeoutMs: 1000 });
  await assert.rejects(missing.discover(), /not installed/); await missing.close();
  const { adapter, directory } = await fixture(t);
  await assert.rejects(adapter.openThread({ cwd: directory, model: 'invalid', threadConfig: { developerInstructions: '' } }), { kind: 'model-unavailable' });
  const opened = await adapter.openThread({ cwd: directory, model: 'sonnet', threadConfig: { developerInstructions: '' } });
  await assert.rejects(adapter.startTurn({ threadId: opened.threadId, model: 'invalid', clientUserMessageId: randomUUID(), input: [{ type: 'text', text: 'Never send' }] }), /Model unavailable/);
  assert.deepEqual(await adapter.listTurns({ threadId: opened.threadId }), { data: [], nextCursor: null }, 'nothing was sent, so there is no turn');
});

test('native Claude transport completes card submissions and keeps follow-up context across an app restart', async (t) => {
  const { options } = await fixture(t);
  // Use a separate adapter owned by the app, exercising the full queue/worker boundary.
  const { fixture: appFixture } = await import('./support/chat-fixture.js');
  const f = await appFixture(t, { claudeAdapter: { ...createClaudeAdapter(options), protectRetainedData: undefined } });
  const settings = await f.ok('GET', '/api/providers/claude');
  await f.ok('PUT', '/api/providers/claude', { revision: settings.revision, selection: { ...settings.selection, enabled: true } });
  const card = await f.card();
  await f.queue(card.id, await f.compose(card.id, 'Native fixture first turn', 'sonnet', { provider: 'claude' }));
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'completed');
  let snapshot = await f.chat(card.id);
  const binding = snapshot.conversations[0].binding;
  assert.equal(binding.provider, 'claude'); assert.ok(snapshot.items.some((item) => item.text.includes('Fixture reply')));
  assert.equal(f.codex.sends.length, 0);
  await f.restart();
  await f.queue(card.id, await f.compose(card.id, 'Native fixture second turn', 'opus', { provider: 'claude' }));
  await waitFor(async () => (await f.chat(card.id)).submissions[1].status === 'completed');
  snapshot = await f.chat(card.id); assert.deepEqual(snapshot.conversations[0].binding, binding);
  assert.equal(snapshot.submissions.length, 2); assert.equal(snapshot.attempts.length, 2);
});

test('a Claude lane run reports through its result block without native tools', async (t) => {
  const { options } = await fixture(t);
  const { fixture: appFixture } = await import('./support/chat-fixture.js');
  const { setPlaybook } = await import('./support/playbooks.js');
  const f = await appFixture(t, { claudeAdapter: { ...createClaudeAdapter(options), protectRetainedData: undefined } });
  const settings = await f.ok('GET', '/api/providers/claude');
  await f.ok('PUT', '/api/providers/claude', { revision: settings.revision, selection: { ...settings.selection, enabled: true } });
  const workspace = await f.ok('GET', '/api/workspace'); const stages = workspace.flows[0].stages;
  await setPlaybook(f.ok, workspace.projects[0].flowId, stages[1], { provider: 'claude', may_edit: ['intro'] }, 'Write an intro.');
  const images = ['Original', 'Portrait', 'Studio', 'Inspiration'].map((name, index) => ({ id: `0000000${index + 1}-0000-4000-8000-000000000000.png`, name: `${name}.png` }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  for (const image of images) await writeFile(path.join(f.dataDir, 'images', image.id), png);
  const card = await f.card({ images, imageRoles: { original: images[0].id, inspiration: images[3].id, cover: images[0].id } });
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  const run = await waitFor(async () => (await f.ok('GET', `/api/cards/${card.id}/lane-runs`)).runs.find((entry) => entry.status === 'completed'));
  assert.deepEqual(run.result.applied, ['intro']);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, 'Fixture intro');
  const chat = await f.chat(card.id);
  assert.equal(chat.submissions[0].model, 'sonnet', 'The provider default model is used');
  assert.equal(chat.submissions[0].provider, 'claude');
  const binding = chat.conversations[0].binding;
  const work = path.join(f.dataDir, 'workspaces', card.id);
  const history = await readFile(path.join(options.env.CLAUDE_CONFIG_DIR, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), `${binding.threadId}.jsonl`), 'utf8');
  const sent = history.trim().split('\n').map((line) => JSON.parse(line)).find((entry) => entry.type === 'user').message.content;
  assert.deepEqual(sent.map((entry) => entry.type), ['text', 'image', 'image', 'image', 'image']);
  for (const image of sent.filter((entry) => entry.type === 'image')) assert.deepEqual(Buffer.from(image.source.data, 'base64'), png);
  assert.match((await f.ok('GET', `/api/cards/${card.id}/notes`)).text, /Fixture notes/);
});
