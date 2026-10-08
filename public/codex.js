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
  heading.textContent = !effective.supported ? 'This configuration is unavailable.' : effective.inherited ? 'Your full Codex setup will be used. It is not isolated.' : 'This configuration passes the installed configuration checks.';
  target.append(heading);
  for (const reason of effective.reasons) { const p = document.createElement('p'); p.textContent = reason; target.append(p); }
  if (effective.supported) { const p = document.createElement('p'); p.textContent = 'Models are saved globally for all card chats. Account access is checked when you submit.'; target.append(p); }
}
function showItems() {
  const target = $('#items'); target.replaceChildren();
  if (!discovery.items.length) { const p = document.createElement('p'); p.textContent = 'No optional native items were discovered.'; target.append(p); }
  const visible = [...discovery.items];
  for (const id of selected) if (!visible.some((item) => item.id === id)) visible.push({ id, name: id, reason: 'This saved selection is no longer available. Uncheck it to remove it.', selectable: false });
  for (const item of visible) {
    const label = document.createElement('label'); label.className = 'native-item';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(item.id); input.disabled = !item.selectable && !input.checked;
    input.addEventListener('change', () => { input.checked ? selected.add(item.id) : selected.delete(item.id); if (!item.selectable) input.disabled = true; $('#availability').textContent = 'Selection changed. Save, then discover again to validate.'; });
    label.append(input, document.createTextNode(`${item.name} (${item.kind ?? 'unavailable'})`));
    const description = document.createElement('small'); description.textContent = item.reason || item.description || item.nativeId; label.append(description); target.append(label);
  }
}
function showMode() {
  $('#isolated-items').disabled = $('#inherited').checked;
  $('#isolated-items').title = $('#inherited').checked ? 'Your full Codex setup is used; individual selection does not apply.' : '';
}
$('#inherited').addEventListener('change', () => { showMode(); $('#availability').textContent = 'Codex setup changed. Save, then discover again to validate.'; });
$('#instructions').addEventListener('input', () => { $('#availability').textContent = 'Instructions changed. Save, then discover again to validate.'; });
$('#configuration').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#save').disabled = true;
  try {
    settings = await request('PUT', '/api/providers/codex', { revision: settings.revision, selection: { enabled: settings.selection.enabled, instructions: $('#instructions').value, selected: [...selected], inherited: $('#inherited').checked } });
    $('#status').textContent = 'Selection saved. Discover again to validate it before use.';
    $('#availability').textContent = '';
  } catch (error) { $('#status').textContent = error.message; }
  finally { $('#save').disabled = false; }
});
$('#discover').addEventListener('click', async () => {
  $('#discover').disabled = true; $('#status').textContent = 'Discovering installed Codex…';
  try {
    const result = await request('POST', '/api/providers/codex/discover');
    discovery = result.discovery; showItems();
    // Server validation refers to saved selection. Never label an unsaved edit as verified.
    const savedMatches = settings.selection.instructions === $('#instructions').value && Boolean(settings.selection.inherited) === $('#inherited').checked
      && JSON.stringify([...selected].sort()) === JSON.stringify([...settings.selection.selected].sort());
    if (savedMatches) showAvailability(result.effective);
    else $('#availability').textContent = 'Save your edited selection, then discover again to validate it.';
    $('#status').textContent = `${discovery.harness.userAgent}. ${discovery.models.length} models listed; account access is checked on submission.`;
  } catch (error) { $('#status').textContent = error.message; }
  finally { $('#discover').disabled = false; }
});
try {
  settings = await request('GET', '/api/providers/codex');
  if (settings.discovery) { discovery = settings.discovery; }
  selected = new Set(settings.selection.selected); $('#instructions').value = settings.selection.instructions;
  $('#inherited').checked = settings.selection.inherited === true; showMode();
  if (discovery) showItems();
  for (const behavior of settings.mandatoryBehavior) { const li = document.createElement('li'); li.textContent = behavior; $('#mandatory').append(li); }
  $('#status').textContent = 'Saved settings loaded. Discover when you are ready to review installed capabilities.'; $('#save').disabled = false;
} catch (error) { $('#status').textContent = error.message; $('#discover').disabled = true; }
