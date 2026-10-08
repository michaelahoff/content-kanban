import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeAdapter } from '../claude-adapter.js';
import { waitFor } from './support/chat-fixture.js';
const fixtureCommand = fileURLToPath(new URL('./support/fake-claude.js', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'frameboard-claude-'));
  const options = { command: process.execPath, args: [fixtureCommand], cwd: directory, env: { ...process.env, CLAUDE_CONFIG_DIR: directory } };
  const adapter = createClaudeAdapter(options);
  t.after(async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }); });
  return { adapter, directory, options };
}
test('Claude discovery initializes without inference, strips account details, and closes its process', async (t) => {
  const { adapter } = await fixture(t); const discovery = await adapter.discover();
  assert.deepEqual(discovery.models.map((model) => model.id), ['sonnet', 'opus']);
  assert.ok(!JSON.stringify(discovery).includes('must-not-persist')); assert.equal(adapter.running, false);
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
test('Claude rejects missing installations and unavailable models before input delivery', async (t) => {
  const missing = createClaudeAdapter({ command: '/nonexistent/frameboard-claude', timeoutMs: 1000 });
  await assert.rejects(missing.discover(), /not installed/); await missing.close();
  const { adapter, directory } = await fixture(t);
  await assert.rejects(adapter.openThread({ cwd: directory, model: 'invalid', threadConfig: { developerInstructions: '' } }), { kind: 'model-unavailable' });
  const opened = await adapter.openThread({ cwd: directory, model: 'sonnet', threadConfig: { developerInstructions: '' } });
  await assert.rejects(adapter.startTurn({ threadId: opened.threadId, model: 'invalid', clientUserMessageId: randomUUID(), input: [{ type: 'text', text: 'Never send' }] }), /Model unavailable/);
  await assert.rejects(adapter.listTurns({ threadId: opened.threadId }), { kind: 'native-unavailable' });
});

test('native Claude transport completes card submissions and keeps follow-up context across an app restart', async (t) => {
  const { options } = await fixture(t);
  // Use a separate adapter owned by the app, exercising the full queue/worker boundary.
  const { fixture: appFixture } = await import('./support/chat-fixture.js');
  const f = await appFixture(t, { claudeAdapter: createClaudeAdapter(options) });
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
