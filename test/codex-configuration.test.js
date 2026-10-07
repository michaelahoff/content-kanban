import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.js';
import { compileConfiguration, queuedConfigurationDecision, openConfiguredThread } from '../codex-configuration.js';
const discovery = { cwd: '/card', harness: { userAgent: 'codex/0.160.1' }, skills: [{ id: '/skills/writer/SKILL.md' }], configuredMcpServers: [], errors: [], items: [{ id: 'skill:/skills/writer/SKILL.md', kind: 'skill', name: 'writer', selectable: false, reason: 'Skill dispatch is unverified.' }] };
const selection = { instructions: '', selected: [] };

test('effective snapshots disable optional skills and are immutable; new discovery holds old queued work', () => {
  const frozen = compileConfiguration(selection, discovery);
  assert.equal(frozen.supported, true);
  assert.deepEqual(frozen.nativeOptions.config['skills.config'], [{ path: '/skills/writer/SKILL.md', enabled: false }]);
  assert.throws(() => frozen.nativeOptions.config['skills.config'].push({}), TypeError);
  assert.deepEqual(queuedConfigurationDecision(frozen, selection, discovery), { status: 'ready' });
  const next = { ...discovery, skills: [...discovery.skills, { id: '/skills/new/SKILL.md' }], items: [...discovery.items, { id: 'skill:/skills/new/SKILL.md', kind: 'skill' }] };
  assert.equal(queuedConfigurationDecision(frozen, selection, next).status, 'held');
  assert.equal(frozen.nativeOptions.config['skills.config'].length, 1);
});

test('unsupported selected items and unselected inherited action sources cannot broaden a configuration', () => {
  assert.equal(compileConfiguration({ ...selection, selected: [discovery.items[0].id] }, discovery).supported, false);
  assert.match(compileConfiguration(selection, { ...discovery, items: [...discovery.items, { id: 'mcp:publish', kind: 'mcp', name: 'publish', reason: 'MCP isolation is unverified.' }] }).reasons.join(' '), /MCP isolation/);
  const global = { id: 'instruction:/home/native/AGENTS.md', kind: 'instruction', name: 'AGENTS.md', nativeId: '/home/native/AGENTS.md', contentHash: 'one', selectable: true };
  const withGlobal = { ...discovery, items: [...discovery.items, global] };
  assert.match(compileConfiguration(selection, withGlobal).reasons.join(' '), /Unselected global instructions/);
  const chosen = { ...selection, selected: [global.id] };
  const frozen = compileConfiguration(chosen, withGlobal);
  assert.equal(frozen.supported, true);
  assert.equal(queuedConfigurationDecision(frozen, selection, withGlobal).status, 'held');
  assert.equal(queuedConfigurationDecision(frozen, chosen, { ...withGlobal, items: [...discovery.items, { ...global, contentHash: 'changed' }] }).status, 'held');
});

test('unexpected native instruction sources and changed sandbox hold configured dispatch before any turn', async () => {
  const frozen = compileConfiguration(selection, discovery);
  const args = { frozen, discovery, currentSelection: selection, cwd: '/card', model: 'gpt-6-luna' };
  await assert.rejects(openConfiguredThread({ openThread: () => assert.fail('must not open') }, { ...args, threadId: 'one' }), { kind: 'binding-mismatch' });
  await assert.rejects(openConfiguredThread({ openThread: () => assert.fail('must not open') }, { ...args, threadId: 'one', binding: { threadId: 'one', provider: 'codex', cwd: '/card', configurationId: 'old' } }), { kind: 'fresh-context-required' });
  const native = { instructionSources: [], sandbox: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' };
  const adapter = { openThread: async () => ({ threadId: 'one', native }) };
  assert.equal((await openConfiguredThread(adapter, args)).configurationId, frozen.id);
  await assert.rejects(openConfiguredThread(adapter, { ...args, cwd: '/another-card' }), { kind: 'configuration-unavailable' });
  native.instructionSources.push('/card/AGENTS.md');
  await assert.rejects(openConfiguredThread(adapter, args), { kind: 'configuration-unavailable' });
  native.instructionSources = []; native.sandbox.networkAccess = true;
  await assert.rejects(openConfiguredThread(adapter, args), { kind: 'configuration-unavailable' });
});

test('provider selection survives SQLite reopen, with conflict protection and untouched previous snapshots', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-provider-'));
  let store = await openStore({ dataDir });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const ctx = { ...store.owner, actor: 'user:test' };
  const original = store.providerConfiguration(ctx);
  assert.deepEqual(original.selection, selection);
  const saved = store.saveProviderConfiguration(ctx, { revision: 0, selection: { instructions: 'selected guidance', selected: ['instruction:one'] } });
  assert.equal(saved.revision, 1);
  assert.throws(() => store.saveProviderConfiguration(ctx, { revision: 0, selection }), { status: 409 });
  store.close(); store = await openStore({ dataDir });
  assert.deepEqual(store.providerConfiguration(ctx), saved);
  assert.deepEqual(original.selection, selection);
  assert.equal(store.events(ctx).at(-1).type, 'configuration_changed');
});
