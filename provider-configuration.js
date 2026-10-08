import { createHash } from 'node:crypto';
import { cardInstructions, configurationDiscovery as codexDiscovery, compileConfiguration as codexCompile, queuedConfigurationDecision as codexDecision, openConfiguredThread as codexOpen } from './codex-configuration.js';

export async function configurationDiscovery(adapter, options, provider = 'codex') {
  return provider === 'codex' ? codexDiscovery(adapter, options) : adapter.discover(options);
}
export function compileConfiguration(selection, discovery, dynamicTools = [], provider = 'codex') {
  if (provider === 'codex') return codexCompile(selection, discovery, dynamicTools);
  const value = { provider, workspace: discovery.cwd, harness: discovery.harness.userAgent, selected: [], inventory: [],
    instructions: selection.instructions ?? '', nativeOptions: { developerInstructions: [cardInstructions, selection.instructions, 'Tools are disabled. Offer text suggestions; the user can apply them with Use text.'].filter(Boolean).join('\n\n') }, supported: true, reasons: [] };
  return { ...value, id: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
export function queuedConfigurationDecision(frozen, selection, discovery) {
  if (selection.enabled === false) return { status: 'held', reason: 'This provider is disabled in Settings. Enable it before sending more prompts.' };
  if (frozen.provider === 'codex') return codexDecision(frozen, selection, discovery);
  const current = compileConfiguration(selection, discovery, [], frozen.provider);
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
