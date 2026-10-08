import { request, send } from './api.js';
import { escape } from './ui.js';
const $ = (selector) => document.querySelector(selector);
const names = { codex: 'Codex', claude: 'Claude' };
let providers = [];
function renderProviders() {
  $('#providers').innerHTML = providers.map((provider) => `<section class="provider-option" aria-label="${names[provider.provider]} settings">
    <label class="provider-toggle"><input type="checkbox" data-provider="${provider.provider}" ${provider.enabled ? 'checked' : ''}><strong>${names[provider.provider]}</strong><span data-enabled-label="${provider.provider}">${provider.enabled ? 'Enabled' : 'Disabled'}</span></label>
    <p>${provider.provider === 'codex' ? 'Uses your installed Codex harness and sign-in for card chats.' : 'Uses your installed Claude Code and sign-in. Supports text and image references. Apply suggestions using Use text; native tools are disabled.'}</p>
    ${provider.provider === 'codex' ? '<a href="/codex.html" class="button secondary">Codex configuration</a>' : '<form id="claude-guidance"><label for="claude-instructions">Claude instructions</label><textarea id="claude-instructions" rows="4" maxlength="50000" placeholder="Guidance for all Claude card chats">' + escape(provider.selection.instructions) + '</textarea><button class="button secondary" type="submit">Save instructions</button></form>'}
  </section>`).join('');
}
function renderModels() {
  const enabled = providers.filter((provider) => provider.enabled);
  $('#refresh-models').disabled = !enabled.length;
  $('#models').innerHTML = enabled.length ? enabled.map((provider) => `<div class="model-provider"><strong>${names[provider.provider]}</strong>
    ${provider.error ? `<p class="settings-error">${escape(provider.error)}${provider.discovery ? ' Previously saved models remain available.' : ''}</p>` : ''}
    ${provider.discovery ? `<ul>${provider.discovery.models.map((model) => `<li>${escape(model.displayName ?? model.id)} <small>(${escape(model.id)})</small></li>`).join('')}</ul><time>Last refreshed ${escape(new Date(provider.updatedAt).toLocaleString())}</time>` : '<p>No saved models yet. Refresh models to check your installation.</p>'}
  </div>`).join('') : '<p>Both providers are disabled. Enable a provider above to use card chats.</p>';
}
async function save(provider, selection) {
  const saved = await send('PUT', `/api/providers/${provider.provider}`, { revision: provider.revision, selection: { ...provider.selection, ...selection } });
  Object.assign(provider, saved, { enabled: saved.selection.enabled !== false });
}
async function loadModels(refresh = false) {
  $('#refresh-models').disabled = true;
  try { const result = refresh ? await send('POST', '/api/models/refresh', {}) : await request('/api/models'); providers = result.providers; renderModels(); }
  finally { $('#refresh-models').disabled = !providers.some((provider) => provider.enabled); }
}
$('#providers').addEventListener('change', async (event) => {
  const input = event.target;
  if (!input.dataset.provider) return;
  const provider = providers.find((entry) => entry.provider === input.dataset.provider);
  input.disabled = true;
  try {
    await save(provider, { enabled: input.checked });
    document.querySelector(`[data-enabled-label="${provider.provider}"]`).textContent = provider.enabled ? 'Enabled' : 'Disabled';
    $('#status').textContent = `${names[provider.provider]} ${provider.enabled ? 'enabled' : 'disabled'} across all card chats. Running replies can finish; new prompts use these settings.`;
    await loadModels();
  } catch (error) { input.checked = provider.enabled; $('#status').textContent = error.message; }
  finally { input.disabled = false; }
});
$('#providers').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { await save(providers.find((entry) => entry.provider === 'claude'), { instructions: $('#claude-instructions').value }); $('#status').textContent = 'Claude instructions saved. Existing conversations need fresh context to use changed guidance.'; }
  catch (error) { $('#status').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#refresh-models').addEventListener('click', async () => {
  $('#status').textContent = 'Refreshing models for enabled providers…';
  try { await loadModels(true); $('#status').textContent = providers.some((provider) => provider.error) ? 'Some providers could not refresh. See their details below.' : 'Models refreshed and saved for every chat.'; }
  catch (error) { $('#status').textContent = error.message; }
});
try {
  providers = (await request('/api/settings')).providers; renderProviders(); renderModels();
  await loadModels(); $('#status').textContent = 'Settings apply globally. Provider switches save automatically.';
} catch (error) { $('#status').textContent = error.message; }
