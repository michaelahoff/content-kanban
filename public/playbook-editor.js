// The project's playbook folder: the map, one playbook per lane and shared
// skills. Each document is edited as plain Markdown; the side panel explains
// what the saved settings will do. Drafts stay here until Save.
import { $, escape, icon, toast, smallForm } from './ui.js';
import { project, loadPlaybooks, savePlaybook, deletePlaybook, previewLaneRun } from './state.js';
import { renderBoard } from './board.js';
import { parseDocument, playbookSettings, describeSettings, playbookTemplate, skillTemplate, setFields, skillName } from './playbook-format.js';
import { contextFields } from './chat-context.js';
import { defaultTemplate } from './card-template.js';

const dialog = $('#playbook-dialog');
// path → { text, hash } as saved; drafts → unsaved text by path.
let folder = null; let saved = new Map(); let drafts = new Map(); let selection = null; let previewing = null; let busy = false;
// Paths whose file changed on disk after the draft began.
let conflicts = new Set();
const control = (action, label, symbol, cls = 'button secondary', attrs = '') => `<button type="button" class="${cls}" data-playbook-action="${action}" ${attrs}>${symbol ? icon(symbol) : ''}${label}</button>`;
const slug = (name) => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lane';
const laneDocument = (laneId) => [...saved.values()].find((document) => document.laneId === laneId);
const currentPath = () => (selection.kind === 'lane' ? laneDocument(selection.laneId)?.path ?? null : selection.path);
// Lane playbooks whose lane was deleted, or that name no lane.
const unattached = () => [...saved.values()].filter((document) => document.path.startsWith('lanes/') && !project().lanes.some((lane) => lane.id === document.laneId));
const textOf = (path) => (drafts.has(path) ? drafts.get(path) : saved.get(path)?.text ?? '');
const dirty = (path) => drafts.has(path) && drafts.get(path) !== saved.get(path)?.text;
const runLabel = { 'on-enter': 'Auto', manual: 'Manual', off: 'Off' };

function remember(listing) {
  folder = listing.folder;
  saved = new Map();
  if (listing.map) saved.set('MAP.md', listing.map);
  for (const document of listing.lanes) saved.set(document.path, document);
  for (const document of listing.skills) saved.set(document.path, document);
}

export async function openPlaybooks({ laneId = null } = {}) {
  const p = project();
  if (!p) return;
  try { remember(await loadPlaybooks(p)); } catch (error) { return toast(error.message); }
  drafts = new Map(); conflicts = new Set(); previewing = null;
  selection = laneId ? { kind: 'lane', laneId } : { kind: 'map', path: 'MAP.md' };
  dialog.innerHTML = `<header class="playbook-header"><div><div class="playbook-breadcrumb">${escape(p.name)} ${icon('chevron')} Playbooks</div><h2 id="playbook-heading"></h2></div>${control('close', '<span class="sr-only">Close playbooks</span>', 'close', 'icon-button')}</header>
    <div class="playbook-workspace"><nav class="playbook-nav" aria-label="Playbook documents"></nav><div class="playbook-main"></div><aside class="playbook-inspector" aria-label="What this document does"></aside></div>
    <footer class="playbook-footer"><p id="playbook-status" role="status"></p><div class="playbook-footer-actions"></div></footer>`;
  render();
  dialog.showModal();
}

function render() {
  renderNav(); renderMain(); renderInspector(); renderFooter();
}

function renderNav() {
  const p = project();
  const item = (attrs, label, meta, active, unsaved) => `<button type="button" class="playbook-nav-item ${active ? 'active' : ''}" ${attrs} ${active ? 'aria-current="true"' : ''}><span>${label}</span>${unsaved ? '<i class="playbook-unsaved" title="Unsaved changes"></i>' : ''}${meta ? `<small>${meta}</small>` : ''}</button>`;
  const skills = [...saved.values()].filter((document) => document.path.startsWith('skills/'));
  const draftSkills = [...drafts.keys()].filter((path) => path.startsWith('skills/') && !saved.has(path));
  $('.playbook-nav', dialog).innerHTML = `<span class="playbook-nav-heading">Project</span>
    ${item('data-playbook-action="select" data-kind="map"', 'Project map', 'MAP.md', selection.kind === 'map', dirty('MAP.md'))}
    <span class="playbook-nav-heading">Lanes</span>
    ${p.lanes.map((lane) => {
      const document = laneDocument(lane.id);
      const settings = document && playbookSettings(parseDocument(textOf(document.path)), defaultTemplate);
      const meta = !document ? 'No playbook' : settings.errors.length ? 'Has errors' : settings.instructions ? runLabel[settings.run] : Object.keys(settings.set).length ? 'Sets fields' : 'Empty';
      return item(`data-playbook-action="select" data-kind="lane" data-id="${lane.id}"`, `<span class="lane-dot ${lane.color}"></span>${escape(lane.name)}`, meta, selection.kind === 'lane' && selection.laneId === lane.id, document && dirty(document.path));
    }).join('')}
    ${unattached().length ? `<span class="playbook-nav-heading">Not attached to a lane</span>${unattached().map((document) => item(`data-playbook-action="select" data-kind="file" data-path="${escape(document.path)}"`, escape(document.path.slice(6, -3)), document.laneId ? 'Its lane was deleted' : 'No lane: setting', selection.kind === 'file' && selection.path === document.path, dirty(document.path))).join('')}` : ''}
    <span class="playbook-nav-heading">Skills ${control('new-skill', '<span class="sr-only">New skill</span>', 'plus', 'icon-button', 'title="New skill"')}</span>
    ${[...skills.map((document) => document.path), ...draftSkills].sort().map((path) => item(`data-playbook-action="select" data-kind="skill" data-path="${escape(path)}"`, escape(path.slice(7, -3)), '', selection.kind === 'skill' && selection.path === path, dirty(path))).join('') || '<p class="playbook-nav-empty">Shared know-how lanes can include.</p>'}
    <div class="playbook-folder"><span>Files on this computer</span><code title="${escape(folder)}">${escape(folder)}</code>${control('copy-folder', 'Copy folder path', null, 'text-button')}</div>`;
}

function heading() {
  if (selection.kind === 'map') return 'Project map';
  if (selection.kind === 'skill') return `Skill · ${selection.path.slice(7, -3)}`;
  if (selection.kind === 'file') return selection.path;
  return `${project().lanes.find((lane) => lane.id === selection.laneId)?.name ?? 'Lane'} playbook`;
}

function renderMain() {
  $('#playbook-heading').textContent = heading();
  const main = $('.playbook-main', dialog);
  if (previewing) {
    main.innerHTML = `<div class="playbook-preview-head"><div><strong>Prompt preview</strong><span>${escape(previewing.card)} · ${escape(previewing.provider === 'claude' ? 'Claude' : previewing.provider === 'codex' ? 'Codex' : '')} ${escape(previewing.model ?? '')}</span></div>${control('close-preview', 'Back to editing', 'left')}</div>
      ${previewing.error ? `<p class="playbook-error">${escape(previewing.error)}</p>` : ''}<pre class="playbook-preview" tabindex="0">${escape(previewing.prompt)}</pre>`;
    return;
  }
  const path = currentPath();
  if (selection.kind === 'lane' && !path) {
    const lane = project().lanes.find((item) => item.id === selection.laneId);
    main.innerHTML = `<div class="playbook-empty">${icon('playbook')}<h3>${escape(lane.name)} has no playbook yet</h3><p>A playbook is a Markdown file that says what should happen when a card enters this lane: the work to do, the fields an agent may change and anything to set straight away.</p>${control('create-lane', 'Create playbook', 'plus', 'button primary')}</div>`;
    return;
  }
  const focused = document.activeElement?.id === 'playbook-text' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  main.innerHTML = `<label class="sr-only" for="playbook-text">${escape(path)}</label><textarea id="playbook-text" class="playbook-text" spellcheck="false" maxlength="200000">${escape(textOf(path))}</textarea>`;
  if (focused) { $('#playbook-text').focus(); $('#playbook-text').setSelectionRange(...focused); }
}

function list(items) { return items.length ? items.map((entry) => `<li>${entry}</li>`).join('') : '<li class="muted">None</li>'; }
function renderInspector() {
  const inspector = $('.playbook-inspector', dialog);
  const path = currentPath();
  if (selection.kind === 'map') {
    inspector.innerHTML = `<span class="playbook-kicker">PROJECT MAP</span><h3>Read first by every lane run</h3><p class="field-help">Describe what this project makes, the lanes in order and the rules that hold everywhere. Each lane run starts with this file, so an agent always knows where it is.</p>`;
    return;
  }
  if (selection.kind === 'file') {
    inspector.innerHTML = `<span class="playbook-kicker">UNATTACHED PLAYBOOK</span><h3>Not used by any lane</h3><p class="field-help">Set <code>lane:</code> to a lane's ID to attach it, or delete the file. Lane IDs: ${project().lanes.map((lane) => `${escape(lane.name)} <code>${escape(lane.id)}</code>`).join(', ')}</p>`;
    return;
  }
  if (selection.kind === 'skill') {
    const name = selection.path.slice(7, -3);
    const users = project().lanes.filter((lane) => {
      const document = laneDocument(lane.id);
      return document && playbookSettings(parseDocument(textOf(document.path)), defaultTemplate).skills.includes(name);
    });
    inspector.innerHTML = `<span class="playbook-kicker">SKILL</span><h3>Shared know-how</h3><p class="field-help">A lane includes this skill when its playbook mentions <code>skills/${escape(name)}.md</code> or lists <code>${escape(name)}</code> under <code>skills:</code>.</p><h4>Used by</h4><ul>${list(users.map((lane) => escape(lane.name)))}</ul>`;
    return;
  }
  if (!path) {
    inspector.innerHTML = `<span class="playbook-kicker">LANE PLAYBOOK</span><h3>How lane runs work</h3><ol class="playbook-steps"><li>When a card enters the lane, any <code>set:</code> values apply at once. Undo last move reverses them.</li><li>If the playbook has instructions and <code>run: on-enter</code>, the card chat receives the project map, this playbook, its skills and the card's hand-off notes.</li><li>The agent replies with a result block. Fields listed under <code>may_edit</code> update; other changes and lane moves wait for your review.</li></ol>`;
    return;
  }
  const settings = playbookSettings(parseDocument(textOf(path)), defaultTemplate);
  const fields = setFields(defaultTemplate);
  const label = (key) => fields.find((field) => field.key === key)?.label ?? key;
  const knownSkills = new Set([...saved.keys(), ...drafts.keys()].filter((entry) => entry.startsWith('skills/')).map((entry) => entry.slice(7, -3)));
  const lane = project().lanes.find((item) => item.id === selection.laneId);
  inspector.innerHTML = `<span class="playbook-kicker">LANE PLAYBOOK</span><h3>${escape(describeSettings(settings, defaultTemplate))}</h3>
    ${settings.errors.length ? `<div class="playbook-problems" role="alert"><strong>Fix before this lane can run</strong><ul>${settings.errors.map((error) => `<li>${escape(error)}</li>`).join('')}</ul></div>` : ''}
    ${settings.warnings.length ? `<ul class="playbook-warnings">${settings.warnings.map((warning) => `<li>${escape(warning)}</li>`).join('')}</ul>` : ''}
    <dl class="playbook-facts">
      <dt>When</dt><dd>${!settings.instructions ? 'No instructions, so no agent runs' : settings.run === 'on-enter' ? 'Each time a card enters this lane' : settings.run === 'manual' ? 'When you choose Run playbook on a card' : 'Turned off'}</dd>
      <dt>Agent</dt><dd>${settings.provider ? (settings.provider === 'claude' ? 'Claude' : 'Codex') : 'The card chat’s provider'}${settings.model ? ` · ${escape(settings.model)}` : ' · its selected or default model'}</dd>
      <dt>Conversation</dt><dd>${settings.conversation === 'fresh' ? 'Starts fresh context each run' : 'Continues the card chat'}</dd>
      <dt>Sends</dt><dd>${escape([...settings.selections.fields.map(label), 'All card photos (with original, inspiration and display labels)'].join(', '))}</dd>
      <dt>May edit</dt><dd>${escape(settings.mayEdit.map(label).join(', ') || 'Nothing directly; changes become proposals')}</dd>
    </dl>
    <h4>Sets on entry</h4><ul>${list(Object.entries(settings.set).map(([key, value]) => `<strong>${escape(label(key))}</strong> ${value ? `= ${escape(value.length > 80 ? `${value.slice(0, 80)}…` : value)}` : '(cleared)'}`))}</ul>
    <h4>Skills</h4><ul>${list(settings.skills.map((name) => `${escape(name)}${knownSkills.has(name) ? '' : ' <span class="playbook-missing">missing</span>'}`))}</ul>
    <details class="playbook-reference"><summary>Settings reference</summary>
      <p><code>run:</code> on-enter, manual or off</p><p><code>provider:</code> codex or claude · <code>model:</code> a model ID from Settings</p>
      <p><code>conversation:</code> continue or fresh</p><p><code>context:</code> card fields to send: ${escape(contextFields(defaultTemplate).map((field) => field.key).join(', '))}. Every card photo is always included; original, inspiration and display identify their roles.</p>
      <p><code>may_edit:</code> fields the agent changes directly</p><p><code>set:</code> one <code>field: value</code> per line, applied on entry. Use <code>|</code> for several lines. Fields: ${escape(fields.map((field) => field.key).join(', '))}</p>
      <p><code>skills:</code> skill names to include</p></details>
    ${lane?.cards.length ? `<div class="playbook-try"><label class="form-label" for="playbook-preview-card">Preview the saved playbook's prompt for</label><select id="playbook-preview-card" class="form-input">${lane.cards.map((card) => `<option value="${card.id}">${escape(card.title || 'Untitled card')}</option>`).join('')}</select>${control('preview', 'Preview prompt', 'search', 'button small secondary')}</div>` : ''}`;
}

function renderFooter() {
  const path = currentPath();
  const status = $('#playbook-status');
  const unsaved = [...drafts.keys()].filter(dirty);
  status.textContent = previewing ? 'Previews use saved files.' : !path ? ''
    : conflicts.has(path) && dirty(path) ? 'This file changed on disk. Your draft is kept: Revert shows the newer file, Save replaces it.'
      : dirty(path) ? 'Unsaved changes · Ctrl+S saves' : saved.has(path) ? `Saved · ${path}` : 'Not saved yet';
  status.classList.toggle('playbook-dirty', Boolean(path && dirty(path)));
  const deletable = path && saved.has(path) && path !== 'MAP.md';
  $('.playbook-footer-actions', dialog).innerHTML = `${deletable ? control('delete', 'Delete', 'trash', 'text-button danger') : ''}${path && dirty(path) && saved.has(path) ? control('revert', 'Revert') : ''}${control('close', unsaved.length ? 'Close…' : 'Close')}${path && !previewing ? control('save', 'Save', 'check', 'button primary', dirty(path) || !saved.has(path) ? '' : 'disabled') : ''}`;
}

async function save() {
  const path = currentPath();
  if (!path || busy) return;
  busy = true;
  try {
    const document = await savePlaybook(project(), path, textOf(path), saved.get(path)?.hash ?? null);
    saved.set(path, { ...document, laneId: path.startsWith('lanes/') ? parseDocument(document.text).data.lane ?? null : undefined });
    drafts.delete(path); conflicts.delete(path);
    renderBoard();
    toast(`${heading()} saved.`);
  } catch (error) {
    toast(error.message);
    if (error.status === 409) { conflicts.add(path); await reloadFromDisk().catch(() => {}); }
  } finally { busy = false; render(); }
}

// Newer saved copies replace ours; a draft based on an older copy is flagged.
async function reloadFromDisk() {
  const before = new Map([...saved].map(([path, document]) => [path, document.hash]));
  remember(await loadPlaybooks(project()));
  for (const path of drafts.keys()) if (dirty(path) && before.get(path) !== saved.get(path)?.hash) conflicts.add(path);
  const path = currentPath();
  if (path && dirty(path)) { renderNav(); renderInspector(); renderFooter(); } else render();
}

function select(next) {
  previewing = null;
  selection = next;
  render();
  $('#playbook-text')?.focus();
}

function close() {
  const unsaved = [...drafts.keys()].filter(dirty);
  if (!unsaved.length) return dialog.close();
  smallForm({ title: 'Discard unsaved playbook changes?', description: `${unsaved.length} ${unsaved.length === 1 ? 'document has' : 'documents have'} unsaved changes: ${unsaved.join(', ')}.`, submit: 'Discard changes', danger: true,
    onSubmit: () => { drafts = new Map(); dialog.close(); } });
}

dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
dialog.addEventListener('input', (event) => {
  if (event.target.id !== 'playbook-text') return;
  drafts.set(currentPath(), event.target.value);
  clearTimeout(dialog.inspectTimer);
  dialog.inspectTimer = setTimeout(() => { renderNav(); renderInspector(); renderFooter(); }, 150);
  renderFooter();
});
dialog.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
});
dialog.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-playbook-action]');
  if (!target) return;
  const action = target.dataset.playbookAction;
  try {
    if (action === 'close') close();
    if (action === 'select') {
      const { kind } = target.dataset;
      select(kind === 'map' ? { kind, path: 'MAP.md' } : kind === 'lane' ? { kind, laneId: target.dataset.id } : { kind, path: target.dataset.path });
    }
    if (action === 'save') await save();
    if (action === 'revert') { drafts.delete(currentPath()); conflicts.delete(currentPath()); render(); }
    if (action === 'copy-folder') { await navigator.clipboard.writeText(folder); toast('Folder path copied.'); }
    if (action === 'create-lane') {
      const lane = project().lanes.find((item) => item.id === selection.laneId);
      let path = `lanes/${slug(lane.name)}.md`;
      for (let index = 2; saved.has(path); index++) path = `lanes/${slug(lane.name)}-${index}.md`;
      busy = true;
      try {
        const document = await savePlaybook(project(), path, playbookTemplate(lane), null);
        saved.set(path, { ...document, laneId: lane.id });
      } finally { busy = false; }
      renderBoard(); render();
      $('#playbook-text')?.focus();
    }
    if (action === 'new-skill') {
      smallForm({ title: 'New skill', description: 'Skills are shared Markdown files a lane playbook can include, such as a voice guide or a checklist.',
        fields: '<label class="form-label" for="skill-name">Skill name</label><input class="form-input" id="skill-name" name="skill" maxlength="80" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]*" placeholder="voice" required autocomplete="off">',
        submit: 'Create skill', onSubmit: async (data) => {
          const name = String(data.get('skill')).trim().toLowerCase();
          if (!skillName.test(name)) throw new Error('Use letters, numbers, - and _ only.');
          const path = `skills/${name}.md`;
          if (saved.has(path)) throw new Error('A skill with that name already exists.');
          const document = await savePlaybook(project(), path, skillTemplate(name), null);
          saved.set(path, document);
          select({ kind: 'skill', path });
        } });
    }
    if (action === 'delete') {
      const path = currentPath();
      smallForm({ title: `Delete ${path}?`, description: selection.kind === 'lane' ? 'The lane keeps its cards. Cards entering it will no longer run anything until you create a new playbook.' : 'Lanes that mention this skill will include a note that it is missing.',
        submit: 'Delete file', danger: true, onSubmit: async () => {
          await deletePlaybook(project(), path, saved.get(path).hash);
          saved.delete(path); drafts.delete(path);
          if (selection.kind === 'skill' || selection.kind === 'file') selection = { kind: 'map', path: 'MAP.md' };
          renderBoard(); render();
        } });
    }
    if (action === 'preview') {
      const cardId = $('#playbook-preview-card').value;
      const card = project().lanes.flatMap((lane) => lane.cards).find((item) => item.id === cardId);
      const result = await previewLaneRun(cardId);
      previewing = { card: card?.title || 'Untitled card', ...result };
      render();
    }
    if (action === 'close-preview') { previewing = null; render(); }
  } catch (error) {
    toast(error.message);
    if (error.status === 409) await reloadFromDisk().catch(() => {});
  }
});
// Another tab or a lane run's editor saved a playbook: refresh saved copies,
// keeping drafts. Called by the board's activity stream.
export function playbooksChanged() {
  if (dialog.open && !busy) void reloadFromDisk().catch(() => {});
}
