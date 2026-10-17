import { help } from './ui.js';
const $ = (selector) => document.querySelector(selector);
let settings;
let discovery;
let selected = new Set();
async function request(method, url, value) {
  const response = await fetch(url, { method, headers: value === undefined ? {} : { 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function showAvailability(effective) {
  const target = $('#availability'); target.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = !effective.supported ? 'Unavailable.' : effective.inherited ? 'Full Codex setup in use (not isolated).' : 'Configuration checks passed.';
  target.append(heading);
  for (const reason of effective.reasons) { const p = document.createElement('p'); p.textContent = reason; target.append(p); }
  if (effective.supported) { const p = document.createElement('p'); p.textContent = 'Account access is checked when you submit.'; target.append(p); }
}
function showItems() {
  const target = $('#items'); target.replaceChildren();
  if (!discovery.items.length) { const p = document.createElement('p'); p.textContent = 'Nothing discovered.'; target.append(p); }
  const visible = [...discovery.items];
  for (const id of selected) if (!visible.some((item) => item.id === id)) visible.push({ id, name: id, reason: 'No longer available. Uncheck to remove.', selectable: false });
  for (const item of visible) {
    const label = document.createElement('label'); label.className = 'native-item';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(item.id); input.disabled = !item.selectable && !input.checked;
    input.addEventListener('change', () => { input.checked ? selected.add(item.id) : selected.delete(item.id); if (!item.selectable) input.disabled = true; $('#availability').textContent = 'Changed. Save, then discover to validate.'; });
    label.append(input, document.createTextNode(`${item.name} (${item.kind ?? 'unavailable'})`));
    const description = document.createElement('small'); description.textContent = item.reason || item.description || item.nativeId; label.append(description); target.append(label);
  }
}
function showMode() {
  $('#isolated-items').disabled = $('#inherited').checked;
  $('#isolated-items').title = $('#inherited').checked ? 'Full setup in use; individual selection does not apply.' : '';
}
$('#inherited').addEventListener('change', () => { showMode(); $('#availability').textContent = 'Changed. Save, then discover to validate.'; });
$('#instructions').addEventListener('input', () => { $('#availability').textContent = 'Changed. Save, then discover to validate.'; });
$('#configuration').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#save').disabled = true;
  try {
    settings = await request('PUT', '/api/providers/codex', { revision: settings.revision, selection: { enabled: settings.selection.enabled, instructions: $('#instructions').value, selected: [...selected], inherited: $('#inherited').checked } });
    $('#status').textContent = 'Saved. Discover to validate.';
    $('#availability').textContent = '';
  } catch (error) { $('#status').textContent = error.message; }
  finally { $('#save').disabled = false; }
});
$('#discover').addEventListener('click', async () => {
  $('#discover').disabled = true; $('#status').textContent = 'Discovering…';
  try {
    const result = await request('POST', '/api/providers/codex/discover');
    discovery = result.discovery; showItems();
    // Server validation refers to saved selection. Never label an unsaved edit as verified.
    const savedMatches = settings.selection.instructions === $('#instructions').value && Boolean(settings.selection.inherited) === $('#inherited').checked
      && JSON.stringify([...selected].sort()) === JSON.stringify([...settings.selection.selected].sort());
    if (savedMatches) showAvailability(result.effective);
    else $('#availability').textContent = 'Save your edits, then discover to validate.';
    $('#status').textContent = `${discovery.harness.userAgent}. ${discovery.models.length} models.`;
  } catch (error) { $('#status').textContent = error.message; }
  finally { $('#discover').disabled = false; }
});
$('#instructions-help').innerHTML = help('instructions', '<p>One selection for Codex across your card chats. Changes apply between turns. A conversation may need an empty fresh context before a changed configuration can be used.</p><p>Removing guidance holds queued prompts that include it until you cancel or resubmit them.</p>');
$('#setup-help').innerHTML = help('Codex setup', '<p>Card chats load your global instructions, skills, MCP servers, plugins/connectors and hooks exactly as Codex does outside Frameboard.</p><p>Connectors can act outside Frameboard, for example publishing or sending. Frameboard cannot exclude them for a card. Local hooks and tools run inside the retained-data boundary, which reaches public HTTP(S) hosts but not local or private ones.</p><p>This choice is separate from Full native access; neither bypasses retained-data protection, sandbox, approvals or card acceptance. Switching modes holds queued prompts and needs an empty fresh context for existing conversations.</p>');
$('#native-help').innerHTML = help('native configuration', '<p>New discoveries start unchecked. A selection makes a capability available; actions still follow their permission and card acceptance rules. Opening this page does not start Codex.</p>');
try {
  settings = await request('GET', '/api/providers/codex');
  if (settings.discovery) { discovery = settings.discovery; }
  selected = new Set(settings.selection.selected); $('#instructions').value = settings.selection.instructions;
  $('#inherited').checked = settings.selection.inherited === true; showMode();
  if (discovery) showItems();
  for (const behavior of settings.mandatoryBehavior) { const li = document.createElement('li'); li.textContent = behavior; $('#mandatory').append(li); }
  $('#status').textContent = ''; $('#save').disabled = false;
} catch (error) { $('#status').textContent = error.message; $('#discover').disabled = true; }
