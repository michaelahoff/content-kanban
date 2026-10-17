// The lane playbook settings form: two compact sections, "When & who" and
// "Context", of short rows, one per frontmatter key or pair of keys, with the
// field and image-role choices read from the project's card template.
// Checkbox lists are pill chips; the explanations live in help popovers on
// the section titles, so the sheet fits a phone-wide column. Rarely used
// groups (Set on entry, Skills, Library) fold into one "Add" row while empty.
// This module keeps no state. renderSettingsForm(context) returns HTML and
// applySettingsChange(context, action, data) returns the draft with one
// setting patched (or null when nothing changes). The editor owns the draft
// text, the DOM and its events; every write goes through withSetting so the
// rest of the file stays byte for byte as it is.
//
// context = { text, template, document (parseDocument result), settings
//   (playbookSettings result), kind: 'lane' | 'file',
//   lanes: [{ id, name, taken }], skillNames: [...], models: [{ provider, id,
//   displayName }] or null until the catalog has loaded, libraryMarkup: HTML
//   for the Library sources (empty when there are none),
//   expanded: groups the user opened while empty (['skills']),
//   graph: whether the flow is a graph, which shows the advance and routes rows }.
import { escape, icon, help } from './ui.js';
import { contextFields, setFields, imageRoles, fieldKey } from './card-template.js';
import { withSetting, withSettings, skillName, knownKeys, providers, providerNames, maxAutomaticMoves } from './playbook-format.js';

const listOf = (value) => (Array.isArray(value) ? value.map(String) : typeof value === 'string' && value.trim() ? value.split(',').map((item) => item.trim()) : []);
const cleanSkill = (name) => String(name).replace(/^skills\//i, '').replace(/\.md$/i, '');
// A playbook names an image role by its key, and the display image by "display".
const roleWord = (role) => role.aliases[0] ?? role.key;
const check = (id, action, label, { checked = false, disabled = false, attrs = '', note = '', title = '' } = {}) => `<label class="playbook-check"${title ? ` title="${title}"` : ''}><input type="checkbox" id="${id}" data-playbook-action="${action}" ${attrs} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${icon('check')}${label}${note ? ` <small>${note}</small>` : ''}</label>`;
const option = (value, label, selected, disabled = false) => `<option value="${escape(value)}" ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${escape(label)}</option>`;
const addButton = (action, label, attrs = '') => `<button type="button" class="playbook-add" data-playbook-action="${action}" ${attrs}>${icon('plus')}${label}</button>`;

// A form row: the label column names one control (label for=) or a group of
// them (a labelled group), and the control column holds them.
function row(key, label, control, { forId = null } = {}) {
  const head = forId ? `<label class="playbook-row-label" for="${forId}">${label}</label>` : `<span class="playbook-row-label" id="playbook-label-${key}">${label}</span>`;
  return `<div class="playbook-row" ${forId ? '' : `role="group" aria-labelledby="playbook-label-${key}"`}>${head}<div class="playbook-row-control">${control}</div></div>`;
}
const section = (key, title, about, rows) => (rows ? `<section class="playbook-section" aria-label="${escape(title)}"><h3 class="playbook-section-title">${escape(title)}${help(title, about)}</h3>${rows}</section>` : '');

// A playbook opened from its lane needs no lane row: the lane is the heading
// and the selected document. A file not attached to a lane gets a picker.
function laneRow({ kind, lanes, document }) {
  if (kind === 'lane') return '';
  const current = document.data.lane ? String(document.data.lane) : '';
  const free = lanes.filter((item) => !item.taken);
  const known = free.some((item) => item.id === current);
  const claimed = lanes.find((item) => item.id === current && item.taken);
  const options = [option('', 'Not attached', !current), ...free.map((item) => option(item.id, item.name, item.id === current)),
    ...(current && !known ? [option(current, claimed ? `${claimed.name} (has a playbook)` : `${current} (no such lane)`, true, true)] : [])];
  return row('lane', 'Lane', `<select id="playbook-field-lane" class="form-input" data-playbook-action="form-lane" title="Lanes without a playbook">${options.join('')}</select>`, { forId: 'playbook-field-lane' });
}

// Run mode is one joined segmented control; the fresh-context chip sits beside it.
function runRow({ settings }) {
  const modes = [['on-enter', 'On entry', 'Runs each time a card enters'], ['manual', 'Manual', 'Runs when you choose Run playbook on a card'], ['off', 'Off', 'Never runs']];
  const buttons = modes.map(([value, label, title]) => `<button type="button" class="chip" id="playbook-run-${value}" data-playbook-action="form-run" data-value="${value}" aria-pressed="${settings.run === value}" title="${title}">${label}</button>`).join('');
  const fresh = check('playbook-field-conversation', 'form-conversation', 'Fresh context', { checked: settings.conversation === 'fresh', title: 'Start a new conversation each run instead of continuing the card chat' });
  return row('run', 'Run', `<div class="playbook-inline"><div class="playbook-segments" role="group" aria-label="Run mode">${buttons}</div>${fresh}</div>`);
}

// Provider and model share a row. The model select lists the same saved
// models the card chat offers: the chosen provider's, or every enabled
// provider's grouped by provider until one is chosen. A model the list lacks
// (typed in Markdown, or from a provider now disabled) stays selected and is
// marked unavailable; until the catalog arrives (models null) it is shown as is.
function agentRow({ settings, models }) {
  const names = [option('', "Card chat's provider", !settings.provider), ...providers.map((name) => option(name, providerNames[name], settings.provider === name))];
  const provider = `<select id="playbook-field-provider" class="form-input" data-playbook-action="form-provider" aria-label="Provider">${names.join('')}</select>`;
  const current = settings.model ?? '';
  const choices = (models ?? []).filter((model) => !settings.provider || model.provider === settings.provider);
  const options = (list) => list.map((model) => option(model.id, model.displayName ?? model.id, model.id === current)).join('');
  const grouped = settings.provider ? options(choices)
    : providers.map((name) => { const own = choices.filter((model) => model.provider === name); return own.length ? `<optgroup label="${providerNames[name]}">${options(own)}</optgroup>` : ''; }).join('');
  const unlisted = current && !choices.some((model) => model.id === current) ? option(current, models ? `${current} (unavailable)` : current, true, Boolean(models)) : '';
  const model = `<select id="playbook-field-model" class="form-input" data-playbook-action="form-model" aria-label="Model">${option('', "Card chat's model", !current)}${grouped}${unlisted}</select>`;
  return row('agent', 'Agent', `<div class="playbook-agent">${provider}${model}</div>`);
}

// context: absent means every field and image role; a list names what to send.
function contextRow({ template, settings, document }) {
  const all = document.data.context === undefined;
  const toggle = check('playbook-field-context-all', 'form-context-all', 'Everything', { checked: all, title: 'Every card field and image role' });
  const fields = contextFields(template).map((field, index) => check(`playbook-context-field-${index}`, 'form-context', escape(field.label), { checked: settings.selections.fields.includes(field.key), attrs: `data-key="${escape(field.key)}" data-group="field"` }));
  const roles = imageRoles(template).map((role, index) => check(`playbook-context-role-${index}`, 'form-context', `${escape(role.label)} image`, { checked: settings.selections.roles.includes(role.key), attrs: `data-key="${escape(role.key)}" data-group="role"` }));
  return row('context', 'Sends', `<div class="playbook-choices">${toggle}${all ? '' : [...fields, ...roles].join('')}</div>`);
}

function mayEditRow({ template, settings }) {
  const boxes = contextFields(template).map((field, index) => check(`playbook-may-edit-${index}`, 'form-may-edit', escape(field.label), { checked: settings.mayEdit.includes(field.key), attrs: `data-key="${escape(field.key)}"` }));
  return row('may-edit', 'May edit', `<div class="playbook-choices">${boxes.join('')}</div>`);
}

// set: is a map keyed by whatever the user typed; each row keeps its key as
// written until its field picker changes it.
const setEntries = (document) => (document.data.set && typeof document.data.set === 'object' && !Array.isArray(document.data.set) ? Object.entries(document.data.set) : []);
const setResolved = (template, entries) => entries.map(([name]) => fieldKey(setFields(template), name));
const setBroken = (raw) => raw !== undefined && raw !== '' && (!raw || typeof raw !== 'object' || Array.isArray(raw));
function setRow({ template, document }) {
  if (setBroken(document.data.set)) return row('set', 'Set on entry', '<p class="playbook-missing">set: needs one “field: value” line per field. Fix it in Markdown.</p>');
  const fields = setFields(template);
  const entries = setEntries(document); const keys = setResolved(template, entries);
  const rows = entries.map(([name, value], index) => {
    const key = keys[index]; const field = fields.find((item) => item.key === key);
    const taken = new Set(keys.filter((other, at) => other && at !== index));
    const options = [...fields.map((item) => option(item.key, item.label, item.key === key, taken.has(item.key))), ...(key ? [] : [option(name, `${name} (not a card field)`, true, true)])];
    return `<div class="playbook-set-row"><label class="sr-only" for="playbook-set-field-${index}">Field ${index + 1}</label><select id="playbook-set-field-${index}" class="form-input" data-playbook-action="form-set-field" data-row="${escape(name)}">${options.join('')}</select>
      <label class="sr-only" for="playbook-set-value-${index}">Value for ${escape(field?.label ?? name)}</label><textarea id="playbook-set-value-${index}" class="form-input playbook-set-value" data-playbook-action="form-set-value" data-row="${escape(name)}" rows="1" ${field ? `maxlength="${field.max}"` : ''} placeholder="Empty clears the field">\n${escape(value)}</textarea>
      <button type="button" class="icon-button playbook-remove" data-playbook-action="form-set-remove" data-row="${escape(name)}" title="Remove">${icon('close')}<span class="sr-only">Remove ${escape(field?.label ?? name)}</span></button></div>`;
  });
  const free = fields.some((field) => !keys.includes(field.key));
  return row('set', 'Set on entry', `${rows.join('')}${addButton('form-set-add', 'Field', free ? '' : 'disabled')}`);
}

// skills: the explicit list, plus every skill the instructions mention by
// skills/<name>.md, which is included whether or not it is listed.
const explicitSkills = (document) => listOf(document.data.skills).map(cleanSkill);
function skillsRow({ settings, document, skillNames }) {
  const explicit = explicitSkills(document);
  const names = [...new Set([...skillNames, ...settings.skills])];
  const boxes = names.map((name, index) => {
    const listed = explicit.includes(name); const mentioned = settings.skills.includes(name) && !listed;
    const note = [mentioned ? 'in instructions' : '', skillNames.includes(name) ? '' : 'missing'].filter(Boolean).join(', ');
    return check(`playbook-skill-${index}`, 'form-skill', escape(name), { checked: listed || mentioned, disabled: mentioned, attrs: `data-name="${escape(name)}"`, note: escape(note), title: mentioned ? 'Mentioned in the instructions, so always included' : '' });
  });
  const add = `<div class="playbook-add-skill"><label class="sr-only" for="playbook-skill-name">Skill name to add</label><input id="playbook-skill-name" class="form-input" maxlength="80" autocomplete="off" placeholder="Skill name"><button type="button" class="button small secondary" data-playbook-action="form-skill-add">Add</button></div>`;
  return row('skills', 'Skills', `${boxes.length ? `<div class="playbook-choices">${boxes.join('')}</div>` : ''}${add}`);
}
const libraryRow = ({ libraryMarkup }) => row('assets', 'Library', `<div class="playbook-library">${libraryMarkup}${addButton('add-assets', 'Files', 'aria-label="Add Library files"')}</div>`);

// Set on entry, Skills and Library show as rows once they hold something (or
// the user opened Skills); until then each is one "+" button in an Add row.
function contextRows(context) {
  const { document, settings, libraryMarkup, expanded = [] } = context;
  const hasSet = setBroken(document.data.set) || setEntries(document).length > 0;
  const hasSkills = settings.skills.length > 0 || explicitSkills(document).length > 0 || expanded.includes('skills');
  const hasLibrary = Boolean(libraryMarkup);
  const adds = [hasSet ? '' : addButton('form-set-add', 'Set on entry', setFields(context.template).length ? '' : 'disabled'),
    hasSkills ? '' : addButton('show-skills', 'Skills'), hasLibrary ? '' : addButton('add-assets', 'Library files')].filter(Boolean);
  return `${contextRow(context)}${mayEditRow(context)}${hasSet ? setRow(context) : ''}${hasSkills ? skillsRow(context) : ''}${hasLibrary ? libraryRow(context) : ''}${adds.length ? row('more', 'Add', `<div class="playbook-inline">${adds.join('')}</div>`) : ''}`;
}

// advance: how a card leaves a graph node when its agent chooses a route.
function advanceRow({ settings }) {
  const modes = [['review', 'Wait for review'], ['auto', 'Move on by itself']];
  const buttons = modes.map(([value, label]) => `<button type="button" class="chip" id="playbook-advance-${value}" data-playbook-action="form-advance" data-value="${value}" aria-pressed="${settings.advance === value}">${label}</button>`).join('');
  return row('advance', 'Advance', `<div class="playbook-segments" role="group" aria-label="Advance">${buttons}</div>`);
}

// routes: a map of route name → lane. Each row picks the lane a route leads
// to; names are changed on the graph or in Markdown.
const routeEntries = (document) => (document.data.routes && typeof document.data.routes === 'object' && !Array.isArray(document.data.routes) ? Object.entries(document.data.routes) : []);
function routesRow({ document, lanes }) {
  const raw = document.data.routes;
  if (raw !== undefined && raw !== '' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    return row('routes', 'Routes', '<p class="playbook-missing">routes: needs one “name: lane” line per route. Fix it in Markdown.</p>');
  }
  const own = document.data.lane ? String(document.data.lane) : null;
  const others = lanes.filter((lane) => lane.id !== own);
  const rows = routeEntries(document).map(([name, target], index) => {
    const known = others.find((lane) => lane.id === target) ?? others.find((lane) => lane.name.toLowerCase() === String(target).toLowerCase());
    const options = [...others.map((lane) => option(lane.id, lane.name, lane === known)), ...(known ? [] : [option(target, `${target} (no such lane)`, true, true)])];
    return `<div class="playbook-route-row"><span class="playbook-route-name">${escape(name)}</span>${icon('arrow')}<label class="sr-only" for="playbook-route-${index}">Route ${escape(name)} leads to</label><select id="playbook-route-${index}" class="form-input" data-playbook-action="form-route-to" data-row="${escape(name)}">${options.join('')}</select>
      <button type="button" class="icon-button playbook-remove" data-playbook-action="form-route-remove" data-row="${escape(name)}" title="Remove">${icon('close')}<span class="sr-only">Remove route ${escape(name)}</span></button></div>`;
  });
  return row('routes', 'Routes', `${rows.join('')}${addButton('form-route-add', 'Route', others.length ? '' : 'disabled')}`);
}

const unknownKeys = (document) => Object.keys(document.data).filter((key) => !knownKeys.includes(key));
function unknownRow({ document }) {
  const keys = unknownKeys(document);
  if (!keys.length) return '';
  const lines = keys.map((key) => `<div class="playbook-unknown"><code>${escape(key)}</code><span>ignored</span><button type="button" class="text-button" data-playbook-action="form-unknown-remove" data-key="${escape(key)}">Remove<span class="sr-only"> ${escape(key)}</span></button></div>`);
  return row('unknown', 'Unknown', lines.join(''));
}

const whenHelp = `<p><strong>Run.</strong> On entry runs the instructions each time a card enters the lane. Manual waits for Run playbook on a card. Off never runs.</p>
  <p><strong>Fresh context</strong> starts a new conversation for each run instead of continuing the card chat.</p>
  <p><strong>Agent.</strong> A provider and one of the models saved in Settings. Leave both as they are to use the card chat’s.</p>`;
const contextHelp = `<p><strong>Sends.</strong> Card fields and image roles included in every run, besides the flow map, this playbook and its skills. Every card photo is always sent.</p>
  <p><strong>May edit.</strong> Fields the agent changes directly. Every other change becomes a proposal you review.</p>
  <p><strong>Set on entry.</strong> Values written to the card the moment it enters the lane. Undo last move reverses them.</p>
  <p><strong>Skills.</strong> Shared know-how sent with the instructions. Mentioning <code>skills/&lt;name&gt;.md</code> in the instructions includes it too.</p>
  <p><strong>Library.</strong> Files sent after the card photos as reference, in this order, then the card’s own Library files. Naming a file in the instructions does not send it.</p>`;
const routesHelp = `<p><strong>Advance.</strong> When the agent chooses a route, Wait for review makes the move a proposal; Move on by itself follows it at once and starts the next node’s playbook. A loop pauses for you after ${maxAutomaticMoves} automatic moves in a row.</p>
  <p><strong>Routes</strong> are the ways out of this node. The agent chooses one by name in its result; you can follow any of them from the card. Rename routes on the graph or in Markdown.</p>`;

// A graph flow's playbooks show their routes; a board's only when its file has them.
const graphRows = (context) => (context.graph || 'routes' in context.document.data || 'advance' in context.document.data ? advanceRow(context) + routesRow(context) : '');
export function renderSettingsForm(context) {
  return `<div class="playbook-form">${section('when', 'When & who', whenHelp, laneRow(context) + runRow(context) + agentRow(context))}${section('context', 'Context', contextHelp, contextRows(context))}${section('routes', 'Routes', routesHelp, graphRows(context))}${unknownRow(context)}</div>`;
}

// --- Changes ---------------------------------------------------------------
// The context: list in template order: fields, then image roles as words.
function contextList(template, fields, roles) {
  return [...contextFields(template).filter((field) => fields.includes(field.key)).map((field) => field.key), ...imageRoles(template).filter((role) => roles.includes(role.key)).map(roleWord)];
}
const toggled = (list, key, on) => (on ? (list.includes(key) ? list : [...list, key]) : list.filter((item) => item !== key));

function applyContext({ text, template, settings }, action, data) {
  const { fields, roles } = settings.selections;
  // Unchecking "send everything" writes what is sent now, so nothing changes until the user edits the list.
  if (action === 'form-context-all') return withSetting(text, 'context', data.checked ? undefined : contextList(template, fields, roles));
  if (action === 'form-context') {
    const next = data.group === 'role' ? contextList(template, fields, toggled(roles, data.key, data.checked)) : contextList(template, toggled(fields, data.key, data.checked), roles);
    return withSetting(text, 'context', next);
  }
  const edits = toggled(settings.mayEdit, data.key, data.checked);
  return withSetting(text, 'may_edit', contextFields(template).filter((field) => edits.includes(field.key)).map((field) => field.key));
}

function applySet({ text, template, document }, action, data) {
  const entries = setEntries(document);
  const at = entries.findIndex(([name]) => name === data.row);
  if (action === 'form-set-add') {
    const used = setResolved(template, entries);
    const field = setFields(template).find((item) => !used.includes(item.key));
    if (!field) throw new Error('Every card field already has a value here.');
    return withSetting(text, 'set', Object.fromEntries([...entries, [field.key, '']]));
  }
  if (at < 0) return null;
  if (action === 'form-set-remove') return withSetting(text, 'set', Object.fromEntries(entries.filter((entry, index) => index !== at)));
  const value = String(data.value ?? '');
  if (action === 'form-set-value') {
    if (entries[at][1] === value) return null;
    return withSetting(text, 'set', Object.fromEntries(entries.map((entry, index) => (index === at ? [entry[0], value] : entry))));
  }
  // The field picker moves the row's value to the chosen key.
  if (setResolved(template, [entries[at]])[0] === value) return null;
  return withSetting(text, 'set', Object.fromEntries(entries.map((entry, index) => (index === at ? [value, entry[1]] : entry))));
}

function applyRoutes({ text, document, lanes }, action, data) {
  const entries = routeEntries(document);
  if (action === 'form-route-add') {
    const own = document.data.lane ? String(document.data.lane) : null;
    const target = lanes.find((lane) => lane.id !== own);
    if (!target) throw new Error('Add another node first.');
    const taken = new Set(entries.map(([name]) => name.toLowerCase()));
    let name = taken.size ? 'route' : 'next';
    for (let index = 2; taken.has(name); index++) name = `route ${index}`;
    return withSetting(text, 'routes', Object.fromEntries([...entries, [name, target.id]]));
  }
  const at = entries.findIndex(([name]) => name === data.row);
  if (at < 0) return null;
  if (action === 'form-route-remove') return withSetting(text, 'routes', Object.fromEntries(entries.filter((entry, index) => index !== at)));
  const value = String(data.value ?? '');
  if (entries[at][1] === value) return null;
  return withSetting(text, 'routes', Object.fromEntries(entries.map((entry, index) => (index === at ? [entry[0], value] : entry))));
}

function applySkills({ text, document }, action, data) {
  const explicit = explicitSkills(document);
  let next;
  if (action === 'form-skill-add') {
    const name = String(data.name ?? '').trim();
    if (!skillName.test(name)) throw new Error('Skill names use letters, numbers, - and _ only.');
    if (explicit.includes(name)) return null;
    next = [...explicit, name];
  } else next = toggled(explicit, data.name, data.checked);
  return withSetting(text, 'skills', next.length ? next : undefined);
}

// Returns the draft with the control's setting changed, or null when the
// change is a no-op. Throws (with a plain-English message) when the draft
// refuses the edit; the editor shows the message.
export function applySettingsChange(context, action, data = {}) {
  const { text } = context;
  const value = String(data.value ?? '').trim();
  switch (action) {
    case 'form-lane': return withSetting(text, 'lane', value || undefined);
    case 'form-run': return withSetting(text, 'run', value);
    case 'form-provider': return withSetting(text, 'provider', value || undefined);
    case 'form-model': {
      // A model picked from a provider's group also picks that provider when
      // none is set, so the run does not send the model to the wrong provider.
      const chosen = (context.models ?? []).find((model) => model.id === value);
      if (chosen && !context.settings.provider) return withSettings(text, { provider: chosen.provider, model: value });
      return withSetting(text, 'model', value || undefined);
    }
    case 'form-conversation': return withSetting(text, 'conversation', data.checked ? 'fresh' : undefined);
    case 'form-context-all': case 'form-context': case 'form-may-edit': return applyContext(context, action, data);
    case 'form-set-field': case 'form-set-value': case 'form-set-remove': case 'form-set-add': return applySet(context, action, data);
    case 'form-skill': case 'form-skill-add': return applySkills(context, action, data);
    case 'form-unknown-remove': return withSetting(text, data.key, undefined);
    case 'form-advance': return withSetting(text, 'advance', value === 'auto' ? 'auto' : undefined);
    case 'form-route-to': case 'form-route-remove': case 'form-route-add': return applyRoutes(context, action, data);
    default: return null;
  }
}
