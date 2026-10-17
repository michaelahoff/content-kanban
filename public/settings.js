import { request, send } from './api.js';
import { escape, help } from './ui.js';
const $ = (selector) => document.querySelector(selector);
const names = { codex: 'Codex', claude: 'Claude' };
let providers = [];
const providerHelp = {
  codex: 'Uses your installed Codex harness and sign-in for card chats.',
  claude: 'Uses your installed Claude Code, sign-in and full setup, including its tools, MCP servers and skills, plus Frameboard card tools. Tools run without permission prompts inside Frameboard\'s retained-data boundary.'
};
function renderProviders() {
  $('#providers').innerHTML = providers.map((provider) => `<section class="provider-option" aria-label="${names[provider.provider]} settings">
    <div class="provider-row"><label class="provider-toggle"><input type="checkbox" role="switch" data-provider="${provider.provider}" ${provider.enabled ? 'checked' : ''}><span class="switch" aria-hidden="true"></span><strong>${names[provider.provider]}</strong><span class="provider-state" data-enabled-label="${provider.provider}">${provider.enabled ? 'On' : 'Off'}</span></label>${help(names[provider.provider], `<p>${providerHelp[provider.provider]}</p>`)}
    ${provider.provider === 'codex' ? '<a href="/codex.html" class="button secondary">Configuration</a>' : ''}</div>
    ${provider.provider === 'codex' ? '' : '<details class="provider-more"><summary>Instructions</summary><form id="claude-guidance"><label for="claude-instructions">Claude instructions</label><textarea id="claude-instructions" rows="4" maxlength="50000" placeholder="Guidance for all Claude card chats">' + escape(provider.selection.instructions) + '</textarea><button class="button secondary" type="submit">Save instructions</button></form></details>'}
  </section>`).join('');
}
function renderModels() {
  const enabled = providers.filter((provider) => provider.enabled);
  $('#refresh-models').disabled = !enabled.length;
  $('#models').innerHTML = enabled.length ? enabled.map((provider) => `<div class="model-provider"><strong>${names[provider.provider]}</strong>${provider.discovery ? ` <time title="Last refreshed">${escape(new Date(provider.updatedAt).toLocaleString())}</time>` : ''}
    ${provider.error ? `<p class="settings-error">${escape(provider.error)}${provider.discovery ? ' Saved models remain available.' : ''}</p>` : ''}
    ${provider.discovery?.protection ? `<p class="${provider.discovery.protection.supported ? 'settings-ok' : 'settings-error'}">${escape(provider.discovery.protection.supported ? 'Retained data protected' : provider.discovery.protection.reason)}</p>` : ''}
    ${provider.discovery ? `<ul class="model-list">${provider.discovery.models.map((model) => `<li class="chip" title="${escape(model.id)}">${escape(model.displayName ?? model.id)}</li>`).join('')}</ul>` : '<p>No models yet. Refresh to check.</p>'}
  </div>`).join('') : '<p>No provider enabled.</p>';
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
    document.querySelector(`[data-enabled-label="${provider.provider}"]`).textContent = provider.enabled ? 'On' : 'Off';
    $('#status').textContent = `${names[provider.provider]} ${provider.enabled ? 'on' : 'off'}.`;
    await loadModels();
  } catch (error) { input.checked = provider.enabled; $('#status').textContent = error.message; }
  finally { input.disabled = false; }
});
$('#providers').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { await save(providers.find((entry) => entry.provider === 'claude'), { instructions: $('#claude-instructions').value }); $('#status').textContent = 'Instructions saved. Existing chats need fresh context.'; }
  catch (error) { $('#status').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#refresh-models').addEventListener('click', async () => {
  $('#status').textContent = 'Refreshing models…';
  try { await loadModels(true); $('#status').textContent = providers.some((provider) => provider.error) ? 'Some providers could not refresh.' : 'Models refreshed.'; }
  catch (error) { $('#status').textContent = error.message; }
});
$('#providers-help').innerHTML = help('providers', '<p>Choose which providers are available across all projects and card chats: Claude, Codex, both, or neither. Switches save automatically. Running replies can finish; new prompts use the new setting.</p>');
$('#models-help').innerHTML = help('models', '<p>This list is saved globally and reused in every chat, including after restarting Frameboard. Refresh when your installed models change.</p>');
$('#backup-help').innerHTML = help('export', '<p>The backup includes the database and settings, every project (including archived ones), images, retained file versions, card workspaces and notes, playbooks and bound Codex conversation files.</p><p>Changes and new work pause while it runs; running replies finish first or you can stop them.</p><p>Not included: global credentials and configuration, unrelated native conversations and external service data.</p>');
let backupTimer = null;
function renderBackup(state) {
  $('#backup-start').disabled = state.active; $('#backup-cancel').hidden = !state.active;
  if (!$('#backup-output').value) $('#backup-output').value = state.defaultOutput;
  const last = state.last;
  $('#backup-status').textContent = state.phase === 'draining'
    ? `Paused. Waiting for ${state.running.length ? `${state.running.length} running ${state.running.length === 1 ? 'reply' : 'replies'}` : 'saves in progress'}…`
    : state.phase === 'exporting' ? 'Exporting and verifying…'
      : last?.status === 'completed' ? `Saved to ${last.backupDir}. ${last.label}`
        : last ? last.error : '';
  clearTimeout(backupTimer);
  if (state.active) backupTimer = setTimeout(() => request('/api/maintenance').then(renderBackup, (error) => { $('#backup-status').textContent = error.message; }), 1000);
}
$('#backup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { renderBackup(await send('POST', '/api/maintenance/export', { output: $('#backup-output').value.trim() })); }
  catch (error) { $('#backup-status').textContent = error.message; }
});
$('#backup-cancel').addEventListener('click', async () => {
  try { renderBackup(await send('POST', '/api/maintenance/cancel', {})); } catch (error) { $('#backup-status').textContent = error.message; }
});
request('/api/maintenance').then(renderBackup, () => {});
try {
  providers = (await request('/api/settings')).providers; renderProviders(); renderModels();
  await loadModels(); $('#status').textContent = '';
} catch (error) { $('#status').textContent = error.message; }
