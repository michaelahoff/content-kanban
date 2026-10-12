// The lane playbook settings form: one control per frontmatter key, with the
// field and image-role choices read from the project's card template. This
// module keeps no state. renderSettingsForm(context) returns HTML and
// applySettingsChange(context, action, data) returns the draft with one
// setting patched (or null when nothing changes). The editor owns the draft
// text, the DOM and its events; every write goes through withSetting so the
// rest of the file stays byte for byte as it is.
//
// context = { text, template, document (parseDocument result), settings
//   (playbookSettings result), kind: 'lane' | 'file', lane: { id, name } | null,
//   lanes: [{ id, name, taken }], skillNames: [...], models: [{ provider, id,
//   displayName }], libraryMarkup: HTML for the Library files block }.
import { escape } from './ui.js';
import { contextFields, setFields, imageRoles, fieldKey } from './card-template.js';
import { withSetting, skillName, knownKeys } from './playbook-format.js';

const listOf = (value) => (Array.isArray(value) ? value.map(String) : typeof value === 'string' && value.trim() ? value.split(',').map((item) => item.trim()) : []);
const cleanSkill = (name) => String(name).replace(/^skills\//i, '').replace(/\.md$/i, '');
// A playbook names an image role by its key, and the display image by "display".
const roleWord = (role) => role.aliases[0] ?? role.key;
const check = (id, action, label, { checked = false, disabled = false, attrs = '', note = '' } = {}) => `<label class="playbook-check"><input type="checkbox" id="${id}" data-playbook-action="${action}" ${attrs} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${label}${note ? ` <small>${note}</small>` : ''}</label>`;
const option = (value, label, selected, disabled = false) => `<option value="${escape(value)}" ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${escape(label)}</option>`;

// A form row: the label column names one control (label for=) or a group of
// them (a labelled group), and the control column holds them and any help.
function row(key, label, control, { forId = null, help = '' } = {}) {
  const head = forId ? `<label class="playbook-row-label" for="${forId}">${label}</label>` : `<span class="playbook-row-label" id="playbook-label-${key}">${label}</span>`;
  return `<div class="playbook-row" ${forId ? '' : `role="group" aria-labelledby="playbook-label-${key}"`}>${head}<div class="playbook-row-control">${control}${help ? `<p class="field-help">${help}</p>` : ''}</div></div>`;
}

function laneRow({ kind, lane, lanes, document }) {
  if (kind === 'lane') return row('lane', 'Lane', `<p class="playbook-static">${escape(lane?.name ?? 'Lane')} <code>${escape(lane?.id ?? '')}</code></p>`);
  const current = document.data.lane ? String(document.data.lane) : '';
  const free = lanes.filter((item) => !item.taken);
  const known = free.some((item) => item.id === current);
  const claimed = lanes.find((item) => item.id === current && item.taken);
  const options = [option('', 'Not attached', !current), ...free.map((item) => option(item.id, item.name, item.id === current)),
    ...(current && !known ? [option(current, claimed ? `${claimed.name} (another file is its playbook)` : `${current} (no such lane)`, true, true)] : [])];
  return row('lane', 'Lane', `<select id="playbook-field-lane" class="form-input" data-playbook-action="form-lane">${options.join('')}</select>`,
    { forId: 'playbook-field-lane', help: 'Attach this file to a lane that has no playbook yet, or leave it unattached.' });
}

function runRow({ settings }) {
  const modes = [['on-enter', 'On entry'], ['manual', 'Manual'], ['off', 'Off']];
  const buttons = modes.map(([value, label]) => `<button type="button" class="chip" id="playbook-run-${value}" data-playbook-action="form-run" data-value="${value}" aria-pressed="${settings.run === value}">${label}</button>`).join('');
  return row('run', 'Run', `<div class="playbook-segments">${buttons}</div>`, { help: 'On entry runs the instructions each time a card enters the lane. Manual waits for Run playbook on a card.' });
}

function providerRow({ settings }) {
  const options = [option('', "Card chat's provider", !settings.provider), option('codex', 'Codex', settings.provider === 'codex'), option('claude', 'Claude', settings.provider === 'claude')];
  return row('provider', 'Provider', `<select id="playbook-field-provider" class="form-input" data-playbook-action="form-provider">${options.join('')}</select>`, { forId: 'playbook-field-provider' });
}

// Free text with the saved model list as suggestions: the chosen provider's
// models, or every enabled provider's until one is chosen.
function modelRow({ settings, models }) {
  const choices = models.filter((model) => !settings.provider || model.provider === settings.provider);
  const list = `<datalist id="playbook-models">${choices.map((model) => option(model.id, model.displayName ?? model.id, false)).join('')}</datalist>`;
  const input = `<input id="playbook-field-model" class="form-input" list="playbook-models" data-playbook-action="form-model" value="${escape(settings.model ?? '')}" maxlength="200" autocomplete="off" placeholder="Card chat's selected or default model">`;
  return row('model', 'Model', input + list, { forId: 'playbook-field-model', help: 'A model ID from Settings. Leave empty to use the card chat’s model.' });
}

function conversationRow({ settings }) {
  return row('conversation', 'Conversation', check('playbook-field-conversation', 'form-conversation', 'Start fresh context for each run', { checked: settings.conversation === 'fresh' }));
}

// context: absent means every field and image role; a list names what to send.
function contextRow({ template, settings, document }) {
  const all = document.data.context === undefined;
  const toggle = check('playbook-field-context-all', 'form-context-all', 'Send every card field and image role', { checked: all });
  const fields = contextFields(template).map((field, index) => check(`playbook-context-field-${index}`, 'form-context', escape(field.label), { checked: settings.selections.fields.includes(field.key), attrs: `data-key="${escape(field.key)}" data-group="field"` }));
  const roles = imageRoles(template).map((role, index) => check(`playbook-context-role-${index}`, 'form-context', `${escape(role.label)} image`, { checked: settings.selections.roles.includes(role.key), attrs: `data-key="${escape(role.key)}" data-group="role"` }));
  const choices = all ? '' : `<div class="playbook-choices">${[...fields, ...roles].join('')}</div>`;
  return row('context', 'What to send', toggle + choices, { help: 'Card fields and image roles included in every run, besides the flow map, this playbook and its skills.' });
}

function mayEditRow({ template, settings }) {
  const boxes = contextFields(template).map((field, index) => check(`playbook-may-edit-${index}`, 'form-may-edit', escape(field.label), { checked: settings.mayEdit.includes(field.key), attrs: `data-key="${escape(field.key)}"` }));
  return row('may-edit', 'May edit', `<div class="playbook-choices">${boxes.join('')}</div>`, { help: 'Fields the agent changes directly. Every other change becomes a proposal you review.' });
}

// set: is a map keyed by whatever the user typed; each row keeps its key as
// written until its field picker changes it.
const setEntries = (document) => (document.data.set && typeof document.data.set === 'object' && !Array.isArray(document.data.set) ? Object.entries(document.data.set) : []);
const setResolved = (template, entries) => entries.map(([name]) => fieldKey(setFields(template), name));
function setRow({ template, document }) {
  const raw = document.data.set;
  if (raw !== undefined && raw !== '' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    return row('set', 'Set on entry', '<p class="playbook-missing">set: needs one “field: value” line per field. Fix it in Markdown.</p>');
  }
  const fields = setFields(template);
  const entries = setEntries(document); const keys = setResolved(template, entries);
  const rows = entries.map(([name, value], index) => {
    const key = keys[index]; const field = fields.find((item) => item.key === key);
    const taken = new Set(keys.filter((other, at) => other && at !== index));
    const options = [...fields.map((item) => option(item.key, item.label, item.key === key, taken.has(item.key))), ...(key ? [] : [option(name, `${name} (not a card field)`, true, true)])];
    return `<div class="playbook-set-row"><label class="sr-only" for="playbook-set-field-${index}">Field ${index + 1}</label><select id="playbook-set-field-${index}" class="form-input" data-playbook-action="form-set-field" data-row="${escape(name)}">${options.join('')}</select>
      <label class="sr-only" for="playbook-set-value-${index}">Value for ${escape(field?.label ?? name)}</label><textarea id="playbook-set-value-${index}" class="form-input playbook-set-value" data-playbook-action="form-set-value" data-row="${escape(name)}" rows="1" ${field ? `maxlength="${field.max}"` : ''} placeholder="Leave empty to clear the field">\n${escape(value)}</textarea>
      <button type="button" class="text-button" data-playbook-action="form-set-remove" data-row="${escape(name)}">Remove<span class="sr-only"> ${escape(field?.label ?? name)}</span></button></div>`;
  });
  const free = fields.some((field) => !keys.includes(field.key));
  const add = `<button type="button" class="button small secondary" data-playbook-action="form-set-add" ${free ? '' : 'disabled'}>Add field</button>`;
  return row('set', 'Set on entry', `${rows.join('')}${add}`, { help: 'Values written to the card the moment it enters the lane. Undo last move reverses them.' });
}

// skills: the explicit list, plus every skill the instructions mention by
// skills/<name>.md, which is included whether or not it is listed.
const explicitSkills = (document) => listOf(document.data.skills).map(cleanSkill);
function skillsRow({ settings, document, skillNames }) {
  const explicit = explicitSkills(document);
  const names = [...new Set([...skillNames, ...settings.skills])];
  const boxes = names.map((name, index) => {
    const listed = explicit.includes(name); const mentioned = settings.skills.includes(name) && !listed;
    const note = [mentioned ? 'mentioned in the instructions' : '', skillNames.includes(name) ? '' : 'missing'].filter(Boolean).join(', ');
    return check(`playbook-skill-${index}`, 'form-skill', escape(name), { checked: listed || mentioned, disabled: mentioned, attrs: `data-name="${escape(name)}"`, note: escape(note) });
  });
  const add = `<div class="playbook-add-skill"><label class="sr-only" for="playbook-skill-name">Skill name to add</label><input id="playbook-skill-name" class="form-input" maxlength="80" autocomplete="off" placeholder="Skill name"><button type="button" class="button small secondary" data-playbook-action="form-skill-add">Add</button></div>`;
  return row('skills', 'Skills', `${boxes.length ? `<div class="playbook-choices">${boxes.join('')}</div>` : ''}${add}`, { help: 'Shared know-how sent with the instructions. Mentioning skills/&lt;name&gt;.md in the instructions includes it too.' });
}

const unknownKeys = (document) => Object.keys(document.data).filter((key) => !knownKeys.includes(key));
function unknownRow({ document }) {
  const keys = unknownKeys(document);
  if (!keys.length) return '';
  const lines = keys.map((key) => `<div class="playbook-unknown"><code>${escape(key)}</code><span>is not a setting and is ignored.</span><button type="button" class="text-button" data-playbook-action="form-unknown-remove" data-key="${escape(key)}">Remove<span class="sr-only"> ${escape(key)}</span></button></div>`);
  return row('unknown', 'Unknown settings', lines.join(''));
}

function problems(settings) {
  if (!settings.errors.length) return '';
  return `<div class="playbook-problems" role="alert"><strong>Fix before this lane can run</strong><ul>${settings.errors.map((error) => `<li>${escape(error)}</li>`).join('')}</ul></div>`;
}

export function renderSettingsForm(context) {
  return `<div class="playbook-form">${problems(context.settings)}${laneRow(context)}${runRow(context)}${providerRow(context)}${modelRow(context)}${conversationRow(context)}${contextRow(context)}${mayEditRow(context)}${setRow(context)}${skillsRow(context)}${row('assets', 'Library files', `<div class="playbook-library">${context.libraryMarkup}</div>`)}${unknownRow(context)}</div>`;
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
    case 'form-model': return withSetting(text, 'model', value || undefined);
    case 'form-conversation': return withSetting(text, 'conversation', data.checked ? 'fresh' : undefined);
    case 'form-context-all': case 'form-context': case 'form-may-edit': return applyContext(context, action, data);
    case 'form-set-field': case 'form-set-value': case 'form-set-remove': case 'form-set-add': return applySet(context, action, data);
    case 'form-skill': case 'form-skill-add': return applySkills(context, action, data);
    case 'form-unknown-remove': return withSetting(text, data.key, undefined);
    default: return null;
  }
}
