import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, waitFor } from './support/chat-fixture.js';
import { ControlledCodex } from './support/controlled-codex.js';

async function enable(f, provider, enabled) {
  const settings = await f.ok('GET', `/api/providers/${provider}`);
  return f.ok('PUT', `/api/providers/${provider}`, { revision: settings.revision, selection: { ...settings.selection, enabled } });
}
test('global provider toggles are independent, persistent, and revision protected', async (t) => {
  const f = await fixture(t);
  let settings = await f.ok('GET', '/api/settings');
  assert.deepEqual(settings.providers.map((p) => [p.provider, p.enabled]), [['codex', true], ['claude', false]]);
  assert.equal(f.codex.running, false);
  await enable(f, 'claude', true); await enable(f, 'codex', false);
  await f.restart();
  settings = await f.ok('GET', '/api/settings');
  assert.deepEqual(settings.providers.map((p) => [p.provider, p.enabled]), [['codex', false], ['claude', true]]);
  const newChat = await f.chat((await f.card()).id);
  assert.equal(newChat.composer.provider, 'claude');
  assert.equal(newChat.conversations[0].provider, 'claude');
  const stale = await f.call('PUT', '/api/providers/claude', { revision: 0, selection: { instructions: '', selected: [], enabled: false } });
  assert.equal(stale.status, 409);
  await enable(f, 'claude', false);
  assert.ok((await f.ok('GET', '/api/settings')).providers.every((p) => !p.enabled));
  assert.equal((await f.ok('GET', '/api/models')).providers.filter((p) => p.enabled).length, 0);
});
test('global models discover once, share concurrent requests, survive restart, and retain a failed refresh', async (t) => {
  const f = await fixture(t); let calls = 0;
  const discover = f.codex.discover.bind(f.codex);
  f.codex.discover = async (...args) => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return discover(...args); };
  const results = await Promise.all([f.ok('GET', '/api/models'), f.ok('GET', '/api/models')]);
  assert.equal(calls, 1); assert.equal(results[0].providers[0].discovery.models[0].id, 'test-model');
  await f.chat((await f.card()).id); await f.chat((await f.card()).id);
  await f.ok('GET', '/api/models'); assert.equal(calls, 1);
  await f.restart(); await f.ok('GET', '/api/models'); assert.equal(calls, 1);
  f.codex.discover = async () => { calls++; throw new Error('Native harness is offline'); };
  const failed = await f.ok('POST', '/api/models/refresh', {});
  assert.equal(failed.providers[0].error, 'Native harness is offline');
  assert.equal(failed.providers[0].discovery.models[0].id, 'test-model');
  await enable(f, 'codex', false); await f.ok('POST', '/api/models/refresh', {}); assert.equal(calls, 2);
});
test('disabled providers reject sends and queued work without starting the harness', async (t) => {
  const f = await fixture(t); const card = await f.card(); const composer = await f.compose(card.id);
  await enable(f, 'codex', false);
  const response = await f.call('POST', `/api/cards/${card.id}/chat/submissions`, { id: 'disabled-send', composerRevision: composer.revision });
  assert.equal(response.status, 409); assert.match(response.body.error, /disabled/);
  assert.equal(f.codex.running, false); assert.equal(f.codex.sends.length, 0);
});
test('Claude has its own catalog and native binding; switching providers retains history and requires fresh context', async (t) => {
  const claude = new ControlledCodex('/tmp/frameboard-controlled-claude'); claude.models = ['sonnet', 'opus'];
  const f = await fixture(t, { claudeAdapter: claude });
  await enable(f, 'claude', true);
  const models = await f.ok('GET', '/api/models');
  assert.deepEqual(models.providers[1].discovery.models.map((model) => model.id), ['sonnet', 'opus']);
  const card = await f.card();
  await f.queue(card.id, await f.compose(card.id, 'Claude prompt', 'sonnet', { provider: 'claude' }));
  await waitFor(() => claude.sends[0]);
  assert.equal(f.codex.sends.length, 0);
  let snapshot = await f.chat(card.id);
  assert.equal(snapshot.submissions[0].provider, 'claude'); assert.equal(snapshot.conversations[0].binding.provider, 'claude');
  assert.equal(claude.threads.get(claude.sends[0].threadId).config.dynamicTools, undefined);
  claude.finish(claude.sends[0], 'completed', 'Claude reply retained');
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'completed');
  await f.queue(card.id, await f.compose(card.id, 'Claude followup', 'opus', { provider: 'claude' }));
  await waitFor(() => claude.sends[1]); assert.equal(claude.sends[0].threadId, claude.sends[1].threadId);
  claude.finish(claude.sends[1]);
  await waitFor(async () => (await f.chat(card.id)).submissions[1].status === 'completed');
  const composer = await f.compose(card.id, 'Codex prompt', 'test-model', { provider: 'codex' });
  const refused = await f.call('POST', `/api/cards/${card.id}/chat/submissions`, { id: 'switch-refused', composerRevision: composer.revision });
  assert.equal(refused.status, 409); assert.match(refused.body.error, /fresh context/);
  await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  await f.queue(card.id, (await f.chat(card.id)).composer);
  await waitFor(() => f.codex.sends[0]);
  snapshot = await f.chat(card.id);
  assert.deepEqual(snapshot.conversations.map((c) => [c.provider, c.state]), [['claude', 'previous'], ['codex', 'active']]);
  assert.ok(snapshot.items.some((item) => item.text === 'Claude reply retained'));
  f.codex.finish(f.codex.sends[0]);
});

test('disabling a provider lets its running reply finish and holds the next queued prompt', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id, 'First reply'));
  await waitFor(() => f.codex.sends[0]);
  const next = await f.queue(card.id, await f.compose(card.id, 'Queued follow-up'));
  await enable(f, 'codex', false);
  f.codex.finish(f.codex.sends[0]);
  await waitFor(async () => (await f.chat(card.id)).submissions.find((submission) => submission.id === next.id)?.status === 'held');
  assert.equal(f.codex.sends.length, 1);
  const snapshot = await f.chat(card.id);
  assert.equal(snapshot.submissions[0].status, 'completed');
  assert.match(snapshot.submissions[1].reason, /disabled/);
});

test('model discovery returns current enablement when a provider is disabled during the refresh', async (t) => {
  const f = await fixture(t);
  const discover = f.codex.discover.bind(f.codex);
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let started = false;
  f.codex.discover = async (...args) => { started = true; await gate; return discover(...args); };
  const loading = f.ok('GET', '/api/models');
  await waitFor(() => started);
  const saved = await enable(f, 'codex', false);
  release();
  const result = (await loading).providers.find((provider) => provider.provider === 'codex');
  assert.equal(result.enabled, false);
  assert.equal(result.revision, saved.revision);
  assert.equal(result.discovery.models[0].id, 'test-model');
});
