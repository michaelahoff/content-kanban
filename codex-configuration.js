// Compiles explicit provider selection into an immutable effective configuration.
// Discovery is opt-in. Unsupported selections stay visible and cannot dispatch.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexError } from './codex-adapter.js';

export const cardInstructions = 'You are working in a Frameboard card workspace. Use Frameboard card tools for card changes. Tool availability does not grant authority to edit card fields, adopt images, change image roles, or move cards. Follow the authority frozen in each submission and request approval when required.';
export const mandatoryBehavior = [
  'Your installed Codex manages sign-in and conversation history. A listed model is not proof of account access.',
  'Codex uses workspace-write / on-request: workspace writes and sandboxed commands without network access can run automatically. Sandbox escapes require approval. Reads outside the workspace are possible. Frameboard grants answer individual requests without writing native global rules. Full native access retains card acceptance and cannot promise OS isolation.',
  'Generated images remain in the conversation until you accept them into the card gallery. Choosing image roles requires separate acceptance.',
  'Codex 0.160.1 cannot enforce the required restrictions for an automatic transfer summary. You can write a summary or start without one.',
];
const hash = (text) => createHash('sha256').update(text).digest('hex');
const canonical = (value) => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);
const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const fail = (kind, message) => { throw new CodexError(kind, message); };

export async function configurationDiscovery(adapter, { cwd } = {}) {
  const discovery = await adapter.discover(cwd ? { cwd } : {});
  const items = discovery.skills.map((s) => ({ ...s, id: `skill:${s.id}`, nativeId: s.id, kind: 'skill', selectable: false, reason: 'Exact native skill selection and all dispatch paths are not verified.' }));
  // Project instructions are excluded by project_doc_max_bytes. Native global
  // instruction files cannot be deselected; their explicit selection is required.
  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    const filename = path.join(discovery.harness.codexHome, name);
    let content;
    try { content = await readFile(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!content.trim()) continue;
    items.push({ id: `instruction:${filename}`, kind: 'instruction', nativeId: filename, name, contentHash: hash(content), selectable: true, reason: 'Codex loads this global file natively. It must be explicitly selected or this configuration is unavailable.' });
    break; // Native override precedence.
  }
  for (const name of new Set([...discovery.configuredMcpServers, ...discovery.mcpServers.map((s) => s.name)])) items.push({ id: `mcp:${name}`, kind: 'mcp', name, selectable: false, reason: 'Per-thread MCP exclusion and dispatch isolation are not proven.' });
  for (const plugin of discovery.plugins) items.push({ id: `plugin:${plugin.id ?? plugin.name}`, kind: 'plugin', name: plugin.name, selectable: false, reason: 'Plugin and account connector isolation are not proven.' });
  for (const hook of discovery.hooks) items.push({ id: `hook:${hook.key}`, kind: 'hook', name: hook.key, selectable: false, reason: 'Command-hook isolation is not proven.' });
  return { ...discovery, cwd: discovery.cwd ?? cwd ?? process.cwd(), items: items.map((item) => ({ ...item, checked: false })), mandatoryBehavior };
}

export function compileConfiguration(selection, discovery, dynamicTools = []) {
  const selected = [...new Set(selection.selected ?? [])].sort();
  const reasons = [];
  const items = discovery.items;
  for (const id of selected) {
    const item = items.find((entry) => entry.id === id);
    if (!item) reasons.push(`The selected item ${id} is unavailable.`);
    else if (!item.selectable) reasons.push(`${item.name}: ${item.reason}`);
  }
  for (const item of items) {
    if (item.kind === 'instruction' && !selected.includes(item.id)) reasons.push(`Unselected global instructions ${item.nativeId} cannot be excluded by this installed harness.`);
    // Disabling these controls is not yet sufficient evidence of isolation.
    if (['mcp', 'plugin', 'hook'].includes(item.kind)) reasons.push(`${item.name}: ${item.reason}`);
  }
  if (discovery.errors.length) reasons.push('Native discovery was incomplete; resolve its reported errors before submitting.');
  if (!/\b0\.160\.1\b/.test(discovery.harness.userAgent)) reasons.push('Configuration isolation is verified only for Codex 0.160.1. Revalidate this installed version before submitting.');
  const nativeOptions = {
    developerInstructions: [cardInstructions, selection.instructions ?? ''].filter(Boolean).join('\n\n'),
    sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
    config: {
      project_doc_max_bytes: 0, 'skills.bundled.enabled': false,
      'skills.config': discovery.skills.map((s) => ({ path: s.id, enabled: false })).sort((a, b) => a.path.localeCompare(b.path)),
      'features.apps': false, 'features.plugins': false, 'features.hooks': false,
      ...Object.fromEntries(discovery.configuredMcpServers.map((name) => [`mcp_servers.${name}.enabled`, false])),
    },
    dynamicTools: structuredClone(dynamicTools),
  };
  const value = {
    provider: 'codex', workspace: discovery.cwd, harness: discovery.harness.userAgent, selected,
    instructions: selection.instructions ?? '',
    inventory: items.map(({ id, kind, contentHash }) => ({ id, kind, ...(contentHash ? { contentHash } : {}) })).sort((a, b) => a.id.localeCompare(b.id)),
    nativeOptions, supported: reasons.length === 0, reasons: [...new Set(reasons)],
  };
  return freeze({ ...value, id: hash(canonical(value)) });
}

// Call immediately before dispatch. Never mutate the queued snapshot. Newly
// discovered skills must be disabled too; warm native state cannot prove this.
export function queuedConfigurationDecision(frozen, currentSelection, discovery) {
  if (!frozen.supported) return { status: 'held', reason: frozen.reasons.join(' ') };
  const removed = frozen.selected.filter((id) => !currentSelection.selected.includes(id));
  if (removed.length || frozen.instructions !== currentSelection.instructions) return { status: 'held', reason: 'The queued configuration includes removed or changed guidance. Explicitly cancel or resubmit under the new configuration.' };
  const checked = compileConfiguration({ selected: frozen.selected, instructions: frozen.instructions }, discovery, frozen.nativeOptions.dynamicTools);
  if (!checked.supported || checked.id !== frozen.id) return { status: 'held', reason: checked.reasons.join(' ') || 'The installed configuration inventory changed. Explicitly cancel or resubmit after reviewing the new discovery.' };
  return { status: 'ready' };
}

export async function openConfiguredThread(adapter, { frozen, discovery, currentSelection, threadId, binding = null, cwd, model, modelProvider = 'openai' }) {
  if (frozen.workspace !== cwd || discovery.cwd !== cwd) fail('configuration-unavailable', 'Refresh discovery and freeze configuration for the exact card workspace before submitting.');
  if (threadId && (!binding || binding.threadId !== threadId || binding.cwd !== cwd || binding.provider !== 'codex')) fail('binding-mismatch', 'Resume requires the exact durable native binding.');
  if (threadId && binding.configurationId !== frozen.id) fail('fresh-context-required', 'The persisted conversation uses another effective configuration. Explicitly choose empty fresh context for this change.');
  const decision = queuedConfigurationDecision(frozen, currentSelection, discovery);
  if (decision.status !== 'ready') fail('configuration-unavailable', decision.reason);
  const opened = await adapter.openThread({ threadId, cwd, model, modelProvider, threadConfig: frozen.nativeOptions });
  const expectedSources = frozen.inventory.filter((item) => item.kind === 'instruction' && frozen.selected.includes(item.id)).map((item) => item.id.slice('instruction:'.length));
  const actual = opened.native.instructionSources ?? [];
  if (canonical([...expectedSources].sort()) !== canonical([...actual].sort())) fail('configuration-unavailable', 'Codex loaded instruction sources outside the frozen selection. Nothing will be submitted.');
  if (opened.native.sandbox.type !== 'workspaceWrite' || opened.native.sandbox.networkAccess || opened.native.approvalPolicy !== 'on-request' || opened.native.approvalsReviewer !== 'user') fail('configuration-unavailable', 'Codex did not apply the ordinary sandbox and approval baseline. Nothing will be submitted.');
  return { ...opened, configurationId: frozen.id, binding: { threadId: opened.threadId, provider: 'codex', cwd, configurationId: frozen.id } };
}
