import { configurationDiscovery, compileConfiguration } from './provider-configuration.js';

// A saved workspace-wide catalog is shared by every chat and survives restarts.
// Failed refreshes retain the last successful inventory. Concurrent refreshes
// share one native discovery per provider.
export function createProviderService({ store, adapters }) {
  const pending = new Map();
  const enabled = (ctx, provider) => store.providerConfiguration(ctx, provider).selection.enabled !== false;
  return {
    snapshot(ctx) {
      return { providers: Object.keys(adapters).map((provider) => ({ ...store.providerConfiguration(ctx, provider),
        enabled: enabled(ctx, provider), ...store.providerCatalog(ctx, provider) })) };
    },
    assertEnabled(ctx, provider) {
      if (!enabled(ctx, provider)) throw Object.assign(new Error(`${provider === 'claude' ? 'Claude' : 'Codex'} is disabled. Enable it in Settings to send prompts.`), { status: 409 });
    },
    async refresh(ctx, provider) {
      this.assertEnabled(ctx, provider);
      if (!pending.has(provider)) {
        const task = (async () => {
          const discovery = await configurationDiscovery(adapters[provider], {}, provider);
          const catalog = store.saveProviderCatalog(ctx, provider, discovery);
          return { ...catalog, effective: compileConfiguration(store.providerConfiguration(ctx, provider).selection, discovery, [], provider) };
        })();
        pending.set(provider, task);
        task.finally(() => pending.delete(provider)).catch(() => {});
      }
      return pending.get(provider);
    },
    async catalog(ctx, { refresh = false } = {}) {
      const results = await Promise.all(this.snapshot(ctx).providers.map(async (provider) => {
        if (!provider.enabled || (!refresh && provider.discovery)) return provider;
        try { return { ...provider, ...await this.refresh(ctx, provider.provider) }; }
        catch (error) { return { ...provider, error: error.message }; }
      }));
      return { providers: results };
    },
    async drain() { await Promise.allSettled([...pending.values()]); },
  };
}
