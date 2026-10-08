import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openStore } from '../store.js';
import { compileConfiguration, queuedConfigurationDecision, openConfiguredThread } from '../codex-configuration.js';
const discovery = { cwd: '/card', harness: { userAgent: 'codex/0.160.1' }, skills: [{ id: '/skills/writer/SKILL.md' }], configuredMcpServers: [], errors: [], items: [{ id: 'skill:/skills/writer/SKILL.md', kind: 'skill', name: 'writer', selectable: false, reason: 'Skill dispatch is unverified.' }] };
const selection = { instructions: '', selected: [] };

test('legacy configuration IDs tolerate terminal metadata but still reject native option and harness changes', async () => {
  const oldDiscovery = { ...discovery, harness: { userAgent: 'frameboard/0.160.1 (Linux; x86_64) dumb (frameboard; 0)' } };
  const currentDiscovery = { ...oldDiscovery, harness: { userAgent: 'frameboard/0.160.1 (Linux; x86_64) Alacritty (frameboard; 0)' } };
  for (const inherited of [false, true]) {
    const chosen = { ...selection, inherited };
    const compiled = compileConfiguration(chosen, oldDiscovery);
    const { id, ...value } = compiled;
    if (inherited) delete value.inventory;
    const canonical = JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);
    const legacy = { ...compiled, id: createHash('sha256').update(canonical).digest('hex') };
    const frozen = compileConfiguration(chosen, currentDiscovery);
    assert.equal(compiled.id, frozen.id);
    assert.deepEqual(queuedConfigurationDecision(legacy, chosen, currentDiscovery), { status: 'ready' });
    const args = { frozen, discovery: currentDiscovery, currentSelection: chosen, cwd: '/card', model: 'test-model',
      threadId: 'one', binding: { threadId: 'one', provider: 'codex', cwd: '/card', configurationId: legacy.id }, bindingConfiguration: legacy };
    const native = { instructionSources: [], sandbox: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' };
    const adapter = { openThread: async () => ({ threadId: 'one', native }) };
    const resumed = await openConfiguredThread(adapter, args);
    assert.equal(resumed.threadId, 'one');
    assert.deepEqual(resumed.binding, args.binding);
    await assert.rejects(openConfiguredThread(adapter, { ...args, bindingConfiguration: { ...legacy, id: 'unrelated' } }), { kind: 'fresh-context-required' });
    for (const change of [{ instructions: 'Changed guidance' }, { nativeOptions: { ...frozen.nativeOptions, sandbox: 'danger-full-access' } }, { harness: 'frameboard/0.160.2 (Linux; x86_64)' }]) {
      await assert.rejects(openConfiguredThread(adapter, { ...args, frozen: { ...frozen, ...change, id: 'changed' } }), { kind: 'fresh-context-required' });
    }
  }
});

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
  assert.deepEqual(original.selection, { ...selection, enabled: true });
  const saved = store.saveProviderConfiguration(ctx, { revision: 0, selection: { instructions: 'selected guidance', selected: ['instruction:one'] } });
  assert.equal(saved.revision, 1);
  assert.throws(() => store.saveProviderConfiguration(ctx, { revision: 0, selection }), { status: 409 });
  store.close(); store = await openStore({ dataDir });
  assert.deepEqual(store.providerConfiguration(ctx), saved);
  assert.deepEqual(original.selection, { ...selection, enabled: true });
  assert.equal(store.events(ctx).at(-1).type, 'configuration_changed');
});

test('opt-in full Codex setup inherits native integrations without isolation claims; switching modes holds old work', async () => {
  const integrations = { ...discovery, configuredMcpServers: ['codex_apps'], items: [...discovery.items,
    { id: 'mcp:codex_apps', kind: 'mcp', name: 'codex_apps', selectable: false, reason: 'MCP isolation is unverified.' },
    { id: 'plugin:sites', kind: 'plugin', name: 'sites', selectable: false, reason: 'Plugin isolation is unverified.' },
    { id: 'instruction:/home/native/AGENTS.md', kind: 'instruction', name: 'AGENTS.md', nativeId: '/home/native/AGENTS.md', contentHash: 'one', selectable: true }] };
  assert.equal(compileConfiguration(selection, integrations).supported, false);
  const inherited = { ...selection, inherited: true };
  const frozen = compileConfiguration(inherited, integrations);
  assert.equal(frozen.supported, true, frozen.reasons.join(' '));
  assert.equal(frozen.inherited, true);
  assert.deepEqual(frozen.nativeOptions.config, {}, 'Native skills, MCP servers, plugins, hooks and project guidance stay as Codex configures them.');
  assert.equal(frozen.nativeOptions.sandbox, 'workspace-write');
  assert.notEqual(frozen.id, compileConfiguration(selection, discovery).id);
  const newer = { ...integrations, items: [...integrations.items, { id: 'plugin:new', kind: 'plugin', name: 'new' }] };
  assert.deepEqual(queuedConfigurationDecision(frozen, inherited, newer), { status: 'ready' });
  assert.equal(queuedConfigurationDecision(frozen, selection, integrations).status, 'held');
  assert.equal(queuedConfigurationDecision(compileConfiguration(selection, discovery), inherited, discovery).status, 'held');
  const native = { instructionSources: ['/home/native/AGENTS.md'], sandbox: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' };
  const opened = await openConfiguredThread({ openThread: async () => ({ threadId: 'one', native }) }, { frozen, discovery: integrations, currentSelection: inherited, cwd: '/card', model: 'gpt-6-luna' });
  assert.equal(opened.binding.configurationId, frozen.id);
  native.sandbox.networkAccess = true;
  await assert.rejects(openConfiguredThread({ openThread: async () => ({ threadId: 'one', native }) }, { frozen, discovery: integrations, currentSelection: inherited, cwd: '/card', model: 'gpt-6-luna' }), { kind: 'configuration-unavailable' });
});

test('the inherited mode is an explicit saved choice', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-provider-'));
  const store = await openStore({ dataDir });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const ctx = { ...store.owner, actor: 'user:test' };
  assert.throws(() => store.saveProviderConfiguration(ctx, { revision: 0, selection: { ...selection, inherited: 'yes' } }), { status: 400 });
  assert.equal(store.saveProviderConfiguration(ctx, { revision: 0, selection: { ...selection, inherited: true } }).selection.inherited, true);
});
