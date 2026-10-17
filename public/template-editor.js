// The card template editor: a workspace dialog that manages the templates
// cards are built from. The nav lists every template, the form edits one
// draft at a time (kept in memory until Save). Fields list one row each;
// one field at a time opens to show its settings. A field's key is the identity card values are
// stored by, so keys lock once a saved template has cards.
import { $, escape, icon, toast, smallForm, help } from './ui.js';
import { state, loadTemplates, createTemplate, updateTemplate, deleteTemplate } from './state.js';
import { renderBoard } from './board.js';
import { validateTemplate, fieldKeyFrom, youtubeVideoTemplate, controls, maxFields, maxImageRoles, maxFieldLength } from './card-template.js';

const dialog = $('#template-dialog');
// selected is the saved template's ID, or null while drafting a new one.
// base is the draft as loaded (JSON) for the unsaved check; lockedKeys are
// the keys cards already used when the draft was loaded; stale marks a
// draft whose saved copy changed in another tab since.
let selected = null; let draft = null; let base = ''; let revision = null; let lockedKeys = { fields: new Set(), imageRoles: new Set() };
let busy = false; let stale = false; let problems = [];
// The index of the field whose settings are shown, or null when all are collapsed.
let openField = null;
const control = (action, label, symbol, cls = 'button secondary', attrs = '') => `<button type="button" class="${cls}" data-template-action="${action}" ${attrs}>${symbol ? icon(symbol) : ''}${label}</button>`;
const iconControl = (action, label, symbol, attrs = '', tip = label) => `<button type="button" class="icon-button template-icon" data-template-action="${action}" aria-label="${escape(label)}" title="${escape(tip)}" ${attrs}>${symbol}</button>`;
const lockIcon = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const lockedTip = 'Locked: cards store values by this key.';
const lock = (row) => row.locked ? `<span class="template-lock" title="${lockedTip}" role="img" aria-label="${lockedTip}">${lockIcon}</span>` : '';
const controlLabel = { text: 'Text', textarea: 'Text area', url: 'URL' };
const defaultMax = { text: 500, url: 4096, textarea: 200000 };
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const blank = () => ({ name: '', title: { label: 'Card title', max: 500 }, fields: [], imageRoles: [] });
const current = () => state.templates.find((template) => template.id === selected) ?? null;
const isDirty = () => JSON.stringify(draft) !== base;
const heading = () => draft.name.trim() || (selected ? 'Untitled template' : 'New template');

// Rows keep every definition key, so edits never change property order and
// the unsaved check can compare JSON. Absent settings are undefined, which
// JSON drops and validateTemplate treats as the default.
const fieldRow = (field = {}, locked = false) => ({ key: field.key ?? '', label: field.label ?? '', control: field.control ?? 'text', max: field.max, placeholder: field.placeholder, placement: field.placement, copy: field.copy, countWords: field.countWords, editor: field.editor, youtube: field.youtube, videoLabel: field.videoLabel, locked: locked || undefined });
const roleRow = (role = {}, locked = false) => ({ key: role.key ?? '', label: role.label ?? '', locked: locked || undefined });
const toDraft = (definition, lock = false) => ({ name: definition.name ?? '', title: { label: definition.title?.label ?? 'Card title', max: definition.title?.max ?? 500 },
  fields: (definition.fields ?? []).map((field) => fieldRow(field, lock)), imageRoles: (definition.imageRoles ?? []).map((role) => roleRow(role, lock)) });

// Loads a saved template into the draft. Keys lock once cards use the template.
function load(templateId, fallback = null) {
  const template = state.templates.find((entry) => entry.id === templateId) ?? fallback;
  selected = template?.id ?? null;
  revision = template?.revision ?? null;
  const lock = Boolean(template && template.cardCount > 0);
  draft = template ? toDraft(template, lock) : blank();
  lockedKeys = { fields: new Set(lock ? draft.fields.map((field) => field.key) : []), imageRoles: new Set(lock ? draft.imageRoles.map((role) => role.key) : []) };
  base = JSON.stringify(draft);
  problems = []; stale = false; openField = null;
}
// A new template, blank or copied. A copy counts as unsaved from the start.
function startDraft(definition, { dirty = false } = {}) {
  selected = null; revision = null; lockedKeys = { fields: new Set(), imageRoles: new Set() };
  draft = toDraft(definition);
  base = dirty ? '' : JSON.stringify(draft);
  problems = []; stale = false; openField = null;
}

export async function openTemplates({ templateId = null } = {}) {
  if (!dialog) return;
  if (dialog.open) {
    if (busy) return toast('Wait for the template save to finish.');
    if (templateId && templateId !== selected && state.templates.some((template) => template.id === templateId)) guard(() => { load(templateId); render(); });
    return;
  }
  // A draft left unsaved by a forced close (a browser can shut a dialog past
  // the prompt) is kept and shown again. The workspace copy of the list is
  // used when it cannot be refreshed.
  const kept = Boolean(draft && isDirty());
  try { await loadTemplates(); } catch { /* Stale counts at worst. */ }
  if (!kept) load(templateId && state.templates.some((template) => template.id === templateId) ? templateId : state.templates[0]?.id ?? null);
  dialog.innerHTML = `<header class="template-header"><div><div class="template-breadcrumb">Workspace ${icon('chevron')} Card templates</div><div class="template-title"><h2 id="template-heading"></h2>${help('card templates', helpMarkup)}</div></div>${control('close', '<span class="sr-only">Close card templates</span>', 'close', 'icon-button')}</header>
    <div class="template-workspace"><nav class="template-nav" aria-label="Card templates"></nav><div class="template-main"></div></div>
    <footer class="template-footer"><p id="template-status" role="status"></p><div class="template-footer-actions"></div></footer>`;
  render();
  dialog.showModal();
  if (kept) { templatesChanged(); toast('Your unsaved template changes were kept.'); }
}

const helpMarkup = `<p>A card template is the set of text fields and image roles a card carries. Each project picks the template for its new cards in Project settings; a card keeps the template it was created with.</p>
  <h3>Keys and labels</h3>
  <p>Every field has a key, such as <code>script</code>, that card values, lane playbooks and chats refer to. Labels, controls and limits can change at any time; a key is permanent once cards use the template.</p>
  <h3>Hidden fields</h3>
  <p>A field hidden from the editor stays out of search, chats and lane results, but a lane playbook can still fill it with <code>set:</code>. The YouTube video template's Prompt works this way.</p>
  <h3>Image roles</h3>
  <p>Roles label a card's images for agents, such as Original or Inspiration. Every card also has a display image, which playbooks call <code>display</code>.</p>
  <h3>Removing things</h3>
  <p>A field that cards hold text in cannot be removed: hide it from the editor instead. Its values stay stored and show again if the key comes back. A template can be deleted once no card and no project uses it, and the workspace keeps at least one.</p>`;

function render() {
  $('#template-heading', dialog).textContent = heading();
  renderNav(); renderMain(); renderFooter();
}

function renderNav() {
  const item = (attrs, label, meta, active, unsaved, title = '') => `<button type="button" class="template-nav-item ${active ? 'active' : ''}" ${attrs} ${active ? 'aria-current="true"' : ''} ${title ? `title="${escape(title)}"` : ''}><span>${label}</span>${unsaved ? '<i class="template-unsaved" title="Unsaved changes"></i>' : ''}<small>${meta}</small></button>`;
  const meta = (template) => [template.builtin ? 'Built in' : '', plural(template.cardCount ?? 0, 'card')].filter(Boolean).join(' · ');
  $('.template-nav', dialog).innerHTML = `<span class="template-nav-heading">Templates</span>
    ${state.templates.map((template) => item(`data-template-action="select" data-id="${escape(template.id)}"`, escape(template.name), meta(template), template.id === selected, template.id === selected && isDirty(), `${plural(template.cardCount ?? 0, 'card')} · ${plural(template.projectCount ?? 0, 'project')}`)).join('')}
    ${selected === null ? item('', escape(heading()), 'Not saved', true, isDirty()) : ''}
    <div class="template-nav-actions">${control('new', 'New template', 'plus', 'button small secondary')}${control('duplicate', 'Duplicate', null, 'button small secondary', selected === null ? 'disabled' : '')}</div>`;
}

// A field's collapsed summary: label, key, control and the options it has on.
function rowTitle(list, index) {
  const row = draft[list][index];
  const label = row.label.trim() ? `<span class="template-summary-label">${escape(row.label)}</span>` : '<span class="template-summary-label template-untitled">Untitled field</span>';
  const tags = [row.editor === false && 'hidden', row.placement === 'header' && 'header', row.copy && 'copy', row.countWords && 'words', row.youtube && 'lookup'].filter(Boolean);
  return `${label}${row.key ? `<code>${escape(row.key)}</code>` : ''}${lock(row)}<span class="template-summary-meta"><span class="template-control">${controlLabel[row.control] ?? row.control}</span>${tags.map((tag) => `<span class="template-tag">${tag}</span>`).join('')}</span>`;
}
function refreshTitle(rowNode) {
  const node = $('.template-row-title', rowNode);
  if (node) node.innerHTML = rowTitle(rowNode.dataset.list, Number(rowNode.dataset.index));
}
// A field whose key cards store values by cannot be removed, only hidden.
const rowActions = (index, count, name, locked = false) => [
  iconControl('move-up', `Move up ${name}`, icon('down', 'template-up'), index === 0 ? 'disabled' : '', 'Move up'),
  iconControl('move-down', `Move down ${name}`, icon('down'), index === count - 1 ? 'disabled' : '', 'Move down'),
  iconControl('remove', `Remove ${name}`, icon('trash'), locked ? 'disabled' : '', locked ? 'Cards store values by this key. Hide it from the editor instead.' : 'Remove'),
].join('');
const check = (name, label, checked, disabled = false, title = '') => `<label class="template-check" ${title ? `title="${escape(title)}"` : ''}><input type="checkbox" name="${name}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${label}</label>`;
const keyInput = (row, max, placeholder, rule) => `<input class="form-input template-key" name="key" value="${escape(row.key)}" maxlength="${max}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" title="${row.locked ? lockedTip : rule}" ${row.locked ? 'disabled' : ''}>`;

function fieldMarkup(field, index, count) {
  const url = field.control === 'url';
  const open = openField === index;
  const name = field.label || `field ${index + 1}`;
  return `<li class="template-row ${open ? 'open' : ''}" data-list="fields" data-index="${index}">
    <div class="template-row-head">
      <button type="button" class="template-row-toggle" data-template-action="toggle" aria-expanded="${open}" ${open ? `aria-controls="template-field-${index}"` : ''} title="${open ? 'Collapse' : 'Edit'}">${icon('chevron', 'template-caret')}<span class="template-row-title">${rowTitle('fields', index)}</span></button>
      <div class="template-row-actions">${rowActions(index, count, name, Boolean(field.locked))}</div>
    </div>
    ${open ? `<div class="template-row-body" id="template-field-${index}">
      <div class="template-pair">
        <label class="template-field"><span>Label</span><input class="form-input" name="label" value="${escape(field.label)}" maxlength="100" placeholder="e.g. Hook" autocomplete="off"></label>
        <label class="template-field"><span>Key ${lock(field)}</span>${keyInput(field, 60, 'e.g. hook', 'Letters and numbers, camelCase. Permanent once cards use it.')}</label>
      </div>
      <div class="template-pair">
        <div class="template-field"><span id="template-control-${index}">Control</span><div class="template-segments" role="radiogroup" aria-labelledby="template-control-${index}">${controls.map((option) => `<label class="chip"><input type="radio" name="control" value="${option}" ${field.control === option ? 'checked' : ''}>${controlLabel[option]}</label>`).join('')}</div></div>
        <label class="template-field"><span>Max length</span><input class="form-input template-number" type="number" name="max" value="${escape(field.max ?? '')}" min="1" max="${maxFieldLength}" step="1"></label>
      </div>
      <label class="template-field"><span>Placeholder</span><input class="form-input" name="placeholder" value="${escape(field.placeholder ?? '')}" maxlength="500" placeholder="Shown while the field is empty" autocomplete="off"></label>
      <div class="template-field"><span id="template-options-${index}">Options</span><div class="template-checks" role="group" aria-labelledby="template-options-${index}">
        ${check('header', 'Header', field.placement === 'header')}
        ${check('copy', 'Copy button', field.copy)}
        ${check('countWords', 'Word count', field.countWords)}
        ${check('hidden', 'Hidden', field.editor === false, false, 'Hidden from the card editor')}
        ${url ? check('youtube', 'YouTube lookup', field.youtube) : ''}
      </div></div>
      ${url ? `<label class="template-field"><span>Video label</span><input class="form-input" name="videoLabel" value="${escape(field.videoLabel ?? '')}" maxlength="100" placeholder="e.g. original video" autocomplete="off"></label>` : ''}
    </div>` : ''}</li>`;
}
function roleMarkup(role, index, count) {
  return `<li class="template-row template-role" data-list="imageRoles" data-index="${index}">
    <input class="form-input" name="label" value="${escape(role.label)}" maxlength="50" placeholder="Label, e.g. Thumbnail draft" aria-label="Image role label" autocomplete="off">
    <span class="template-role-key">${keyInput(role, 30, 'key', 'Lowercase letters and numbers. Permanent once cards use it.').replace('name="key"', 'name="key" aria-label="Image role key"')}${lock(role)}</span>
    <div class="template-row-actions">${rowActions(index, count, role.label || `image role ${index + 1}`)}</div></li>`;
}

// Where the keyboard is, so a re-render can put it back: a control's name
// (or button action), its row, and the caret in a text input.
function focusState() {
  const active = document.activeElement;
  if (!active || !dialog.contains(active)) return null;
  const name = active.name || active.dataset.templateAction;
  if (!name) return null;
  const row = active.closest('[data-list]');
  return { name, list: row?.dataset.list, index: Number(row?.dataset.index), selection: typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null };
}
function restoreFocus(saved) {
  if (!saved) return;
  const scope = saved.list ? $(`[data-list="${saved.list}"][data-index="${saved.index}"]`, dialog) : $('.template-main', dialog);
  let node = scope && ($(`[name="${saved.name}"]:checked`, scope) ?? $(`[name="${saved.name}"]`, scope) ?? $(`[data-template-action="${saved.name}"]`, scope));
  // A row moved to an end loses that direction's button: take the next one.
  if (node?.disabled) node = $('[data-template-action]:not(:disabled)', node.parentElement);
  if (!node) return;
  node.focus();
  if (saved.selection && typeof node.selectionStart === 'number') node.setSelectionRange(...saved.selection);
}

function renderMain(focus = focusState()) {
  const main = $('.template-main', dialog);
  main.innerHTML = `${problems.length ? `<div class="template-problems" role="alert"><strong>Fix before saving</strong><ul>${problems.map((problem) => `<li>${escape(problem)}</li>`).join('')}</ul></div>` : ''}
    <section class="template-section" aria-label="Template"><div class="template-grid">
      <label class="template-field template-wide"><span>Template name</span><input class="form-input" name="name" value="${escape(draft.name)}" maxlength="100" placeholder="e.g. Podcast episode" autocomplete="off"></label>
      <label class="template-field"><span>Title label</span><input class="form-input" name="titleLabel" value="${escape(draft.title.label)}" maxlength="100" placeholder="Card title" autocomplete="off"></label>
      <label class="template-field"><span>Title max length</span><input class="form-input template-number" type="number" name="titleMax" value="${escape(draft.title.max ?? '')}" min="1" max="10000" step="1"></label>
    </div></section>
    <section class="template-section" aria-labelledby="template-fields-heading">
      <div class="template-section-head"><h3 id="template-fields-heading">Fields</h3></div>
      ${draft.fields.length ? `<ol class="template-rows">${draft.fields.map((field, index) => fieldMarkup(field, index, draft.fields.length)).join('')}</ol>` : '<p class="template-empty">No fields. Cards have a title and images only.</p>'}
      <div class="template-section-actions">${control('add-field', 'Add field', 'plus', 'button small secondary', draft.fields.length >= maxFields ? 'disabled' : '')}</div>
    </section>
    <section class="template-section" aria-labelledby="template-roles-heading">
      <div class="template-section-head"><h3 id="template-roles-heading">Image roles</h3></div>
      ${draft.imageRoles.length ? `<ol class="template-rows">${draft.imageRoles.map((role, index) => roleMarkup(role, index, draft.imageRoles.length)).join('')}</ol>` : '<p class="template-empty">No extra roles. Cards still have a display image.</p>'}
      <div class="template-section-actions">${control('add-role', 'Add image role', 'plus', 'button small secondary', draft.imageRoles.length >= maxImageRoles ? 'disabled' : '')}</div>
    </section>`;
  restoreFocus(focus);
}

function renderFooter() {
  const status = $('#template-status', dialog);
  const dirty = isDirty();
  status.textContent = busy ? 'Saving…' : problems.length ? `${plural(problems.length, 'problem')} to fix before saving`
    : stale ? 'Changed in another tab · Revert loads it, Save replaces it'
      : dirty ? 'Unsaved changes · Ctrl+S saves' : selected ? 'Saved' : 'Not saved yet';
  status.classList.toggle('template-dirty', !busy && !problems.length && (dirty || stale));
  status.classList.toggle('template-invalid', !busy && problems.length > 0);
  const disabled = busy ? 'disabled' : '';
  const extras = `${current()?.builtin ? control('restore-builtin', 'Restore built-in fields', 'undo', 'text-button', disabled) : ''}${selected ? control('delete', 'Delete template', 'trash', 'text-button danger', disabled) : ''}`;
  const more = extras ? `<details class="template-more"><summary class="icon-button" aria-label="More template actions" title="More">${icon('more')}</summary><div class="template-menu">${extras}</div></details>` : '';
  $('.template-footer-actions', dialog).innerHTML = `${more}${selected && dirty ? control('revert', 'Revert', null, 'button secondary', disabled) : ''}${control('close', dirty ? 'Cancel' : 'Close', null, 'button secondary', disabled)}${control('save', 'Save', 'check', 'button primary', busy || (selected && !dirty) ? 'disabled' : '')}`;
}

// Applies a control's value to the draft. Returns true when other controls
// depend on it, so the form needs a full re-render.
function applyEdit(target) {
  const { name } = target;
  const rowNode = target.closest('[data-list]');
  const text = target.value;
  const number = text.trim() === '' ? undefined : Number(text);
  if (!rowNode) {
    if (name === 'name') { draft.name = text; $('#template-heading', dialog).textContent = heading(); }
    if (name === 'titleLabel') draft.title.label = text;
    if (name === 'titleMax') draft.title.max = number;
    return false;
  }
  const { list } = rowNode.dataset; const index = Number(rowNode.dataset.index); const row = draft[list][index];
  if (name === 'label' || name === 'key') row[name] = text;
  if (name === 'placeholder' || name === 'videoLabel') row[name] = text || undefined;
  if (name === 'max') row.max = number;
  if (name === 'control') {
    // A limit left at the old control's default follows the new one; only URL fields look up YouTube.
    if (row.max === defaultMax[row.control]) row.max = defaultMax[text];
    row.control = text;
    if (text !== 'url') row.youtube = undefined;
    return true;
  }
  if (name === 'header') row.placement = target.checked ? 'header' : undefined;
  if (name === 'hidden') row.editor = target.checked ? false : undefined;
  if (['copy', 'countWords', 'youtube'].includes(name)) row[name] = target.checked || undefined;
  refreshTitle(rowNode);
  return false;
}

async function save() {
  // Ctrl+S on an unchanged template would only bump its revision.
  if (busy || !draft || (selected && !isDirty())) return;
  const { template, errors } = validateTemplate(draft, { locked: [...lockedKeys.fields] });
  problems = errors;
  if (errors.length) { renderMain(); renderFooter(); $('.template-main', dialog).scrollTop = 0; return; }
  busy = true; renderFooter();
  const submitted = JSON.stringify(draft);
  try {
    const saved = selected ? await updateTemplate(selected, { revision, ...template }) : await createTemplate(template);
    busy = false;
    // Edits typed while the save was pending stay as the unsaved draft on
    // top of the saved copy, with keys the save made permanent now locked.
    const typed = JSON.stringify(draft) !== submitted ? draft : null;
    load(saved.id, saved);
    if (typed) {
      for (const row of typed.fields) row.locked = lockedKeys.fields.has(row.key) || undefined;
      for (const row of typed.imageRoles) row.locked = lockedKeys.imageRoles.has(row.key) || undefined;
      draft = typed;
    }
    render();
    renderBoard();
    toast('Template saved.');
  } catch (error) {
    busy = false;
    toast(error.message);
    if (error.status === 409) { await reloadList(); return; }
    problems = [error.message];
    render();
    $('.template-main', dialog).scrollTop = 0;
  }
}
async function reloadList() {
  try { await loadTemplates(); } catch { return render(); }
  templatesChanged();
}

function remove() {
  const template = current();
  if (!template) return;
  smallForm({ title: `Delete “${template.name}”?`, description: 'Only a template no card and no project uses can be deleted. Cards keep the template they were created with.', submit: 'Delete template', danger: true,
    onSubmit: async () => {
      busy = true; renderFooter();
      try { await deleteTemplate(template.id); } finally { busy = false; renderFooter(); }
      load(state.templates[0]?.id ?? null);
      render(); renderBoard();
      toast('Template deleted.');
    } });
}

// Runs next at once, or after the user agrees to drop the unsaved draft.
function guard(next) {
  if (!isDirty()) return next();
  smallForm({ title: 'Discard unsaved template changes?', description: `“${heading()}” has changes that are not saved.`, submit: 'Discard changes', danger: true, onSubmit: next });
}
function close() {
  if (busy) return toast('Wait for the template save to finish.');
  guard(() => { draft = null; dialog.close(); });
}

if (dialog) {
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  // A forced close (repeated Escape) brings an unsaved draft back with the prompt.
  dialog.addEventListener('close', () => { if (!busy && draft && isDirty()) { dialog.showModal(); close(); } });
  dialog.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
  });
  // Typing updates the draft in place; only the nav and footer re-render.
  dialog.addEventListener('input', (event) => {
    const { target } = event;
    if (!draft || !target.name || ['checkbox', 'radio'].includes(target.type) || target.tagName === 'SELECT') return;
    applyEdit(target);
    renderNav(); renderFooter();
  });
  dialog.addEventListener('change', (event) => {
    const { target } = event;
    if (!draft || !target.name || !(['checkbox', 'radio'].includes(target.type) || target.tagName === 'SELECT')) return;
    if (applyEdit(target)) renderMain();
    renderNav(); renderFooter();
  });
  // A new row's key comes from its label once either is left blank. Only the
  // row changes here: a re-render of the footer would swallow a click on
  // Save that caused this focus change.
  dialog.addEventListener('focusout', (event) => {
    const { target } = event;
    if (!draft || !['label', 'key'].includes(target.name)) return;
    const rowNode = target.closest('[data-list]');
    const row = rowNode && draft[rowNode.dataset.list][Number(rowNode.dataset.index)];
    if (!row || row.locked || row.key || !row.label.trim()) return;
    row.key = rowNode.dataset.list === 'fields' ? fieldKeyFrom(row.label) : fieldKeyFrom(row.label).toLowerCase().slice(0, 30);
    $('[name="key"]', rowNode).value = row.key;
    refreshTitle(rowNode);
  });
  dialog.addEventListener('click', (event) => {
    const target = event.target.closest('[data-template-action]');
    if (!target || !draft) return;
    const action = target.dataset.templateAction;
    target.closest('details')?.removeAttribute('open');
    if (action === 'close') return close();
    if (busy) return;
    if (action === 'select' && target.dataset.id !== selected) guard(() => { load(target.dataset.id); render(); });
    if (action === 'new') guard(() => { startDraft(blank()); render(); $('[name="name"]', dialog)?.focus(); });
    if (action === 'duplicate' && current()) guard(() => { startDraft({ ...current(), name: `${current().name} copy` }, { dirty: true }); render(); $('[name="name"]', dialog)?.focus(); });
    if (action === 'save') void save();
    if (action === 'revert') { load(selected); render(); }
    if (action === 'delete') remove();
    if (action === 'restore-builtin') {
      draft.title = { ...youtubeVideoTemplate.title };
      draft.fields = youtubeVideoTemplate.fields.map((field) => fieldRow(field, lockedKeys.fields.has(field.key)));
      draft.imageRoles = youtubeVideoTemplate.imageRoles.map((role) => roleRow(role, lockedKeys.imageRoles.has(role.key)));
      openField = null;
      renderMain(); renderNav(); renderFooter();
      toast('Built-in fields restored. Save to keep them.');
    }
    if (action === 'add-field' || action === 'add-role') {
      const list = action === 'add-field' ? 'fields' : 'imageRoles';
      draft[list].push(list === 'fields' ? fieldRow({ max: defaultMax.text }) : roleRow());
      if (list === 'fields') openField = draft.fields.length - 1;
      renderMain({ name: 'label', list, index: draft[list].length - 1 }); renderNav(); renderFooter();
    }
    if (action === 'toggle') {
      const index = Number(target.closest('[data-list]').dataset.index);
      openField = openField === index ? null : index;
      renderMain({ name: 'toggle', list: 'fields', index });
    }
    if (['move-up', 'move-down', 'remove'].includes(action)) {
      const rowNode = target.closest('[data-list]');
      const { list } = rowNode.dataset; const index = Number(rowNode.dataset.index); const rows = draft[list];
      const [row] = rows.splice(index, 1);
      const to = action === 'move-up' ? index - 1 : index + 1;
      if (action !== 'remove') rows.splice(to, 0, row);
      const at = action === 'remove' ? Math.min(index, rows.length - 1) : to;
      // The open field stays open wherever it moves.
      if (list === 'fields' && openField !== null) {
        if (action === 'remove') openField = openField === index ? null : openField > index ? openField - 1 : openField;
        else openField = openField === index ? to : openField === to ? index : openField;
      }
      renderMain(rows.length ? { name: action, list, index: at } : null);
      if (!rows.length) $(`[data-template-action="${list === 'fields' ? 'add-field' : 'add-role'}"]`, dialog)?.focus();
      renderNav(); renderFooter();
    }
  });
}

// Another tab changed a template and state.templates was reloaded: refresh
// the list, and the draft when it has no unsaved work. A draft whose saved
// copy changed is kept and flagged; one whose template was deleted becomes
// a new template so the work is not lost.
export function templatesChanged() {
  if (!dialog?.open || busy || !draft) return;
  const template = current();
  if (selected && !template) {
    selected = null; revision = null; base = ''; stale = false;
    lockedKeys = { fields: new Set(), imageRoles: new Set() };
    for (const row of [...draft.fields, ...draft.imageRoles]) row.locked = undefined;
    toast('This template was deleted in another tab. Saving creates it again.');
    render();
    return;
  }
  if (template && template.revision !== revision) {
    if (isDirty()) { stale = true; revision = template.revision; } else load(selected);
    render();
    return;
  }
  renderNav(); renderFooter();
}
