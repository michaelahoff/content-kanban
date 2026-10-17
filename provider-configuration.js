import { createHash } from 'node:crypto';
import { roleInstructions, configurationDiscovery as codexDiscovery, compileConfiguration as codexCompile, queuedConfigurationDecision as codexDecision, openConfiguredThread as codexOpen } from './codex-configuration.js';

export async function configurationDiscovery(adapter, options, provider = 'codex') {
  return provider === 'codex' ? codexDiscovery(adapter, options) : adapter.discover(options);
}
// `role` names the agent's guidance (codex-configuration.js roleInstructions):
// a card chat or lane run by default, or a project chat's flow builder.
export function compileConfiguration(selection, discovery, dynamicTools = [], provider = 'codex', role = 'card') {
  if (provider === 'codex') return codexCompile(selection, discovery, dynamicTools, role);
  const value = { provider, workspace: discovery.cwd, harness: discovery.harness.userAgent, selected: [], inventory: [], ...(role === 'card' ? {} : { role }),
    instructions: selection.instructions ?? '', nativeOptions: { developerInstructions: [roleInstructions[role] ?? roleInstructions.card, selection.instructions].filter(Boolean).join('\n\n'), permissionMode: 'bypassPermissions', dynamicTools: structuredClone(dynamicTools) },
    ...(discovery.protection ? { protection: discovery.protection } : {}), supported: discovery.protection?.supported !== false, reasons: discovery.protection?.supported === false ? [discovery.protection.reason] : [] };
  return { ...value, id: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
export function queuedConfigurationDecision(frozen, selection, discovery) {
  if (selection.enabled === false) return { status: 'held', reason: 'This provider is disabled in Settings. Enable it before sending more prompts.' };
  if (frozen.provider === 'codex') return codexDecision(frozen, selection, discovery);
  const current = compileConfiguration(selection, discovery, frozen.nativeOptions.dynamicTools ?? [], frozen.provider, frozen.role ?? 'card');
  if (!current.supported) return { status: 'held', reason: current.reasons.join(' ') };
  return current.id === frozen.id ? { status: 'ready' } : { status: 'held', reason: 'Claude guidance changed. Cancel or resubmit this prompt with the current settings.' };
}
export async function openConfiguredThread(adapter, options) {
  if (options.frozen.provider === 'codex') return codexOpen(adapter, options);
  const { frozen, discovery, currentSelection, threadId, binding, cwd } = options;
  const decision = queuedConfigurationDecision(frozen, currentSelection, discovery);
  if (decision.status !== 'ready') throw Object.assign(new Error(decision.reason), { kind: 'configuration-unavailable' });
  if (frozen.workspace !== cwd || discovery.cwd !== cwd || (threadId && (binding?.provider !== frozen.provider || binding.cwd !== cwd || binding.threadId !== threadId))) throw Object.assign(new Error('Claude requires the exact saved workspace and session.'), { kind: 'binding-mismatch' });
  if (threadId && binding.configurationId !== frozen.id) throw Object.assign(new Error('Start fresh context before changing Claude guidance.'), { kind: 'fresh-context-required' });
  const result = await adapter.openThread({ ...options, threadConfig: frozen.nativeOptions });
  return { ...result, binding: { threadId: result.threadId, provider: frozen.provider, cwd, configurationId: frozen.id } };
}
