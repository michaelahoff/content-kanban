// The project sidebar with each project's flows, the board of lanes and
// cards, and the project, flow and lane forms.
import { $, escape, icon, button, iconButton, imageURL, palette, smallForm, nameField, themeToggleMarkup, accentSwitchMarkup, help } from './ui.js';
import { state, project, flow, locateCard, cardCount, flowCardCount, searchText, saveStatus, createProject, renameProject, createFlow, updateFlow, selectFlow, addLane, updateLane, latestMoveCard } from './state.js';
import { activityMarkup } from './chat.js';
import { renderLibrary } from './library.js';
import { renderGraph, nodeForm } from './graph.js';
import { renderProjectChat, projectChatBusy } from './project-chat.js';

// A graph flow shows its lanes as nodes joined by routes (graph.js); the
// forms call them nodes there.
const isGraph = (f) => f?.kind === 'graph';
const flowIcon = (f) => (isGraph(f) ? 'graph' : 'board');

const app = $('#app');
export const view = { query: '', pasteLaneId: null, cardsCollapsed: false, tab: 'board' };
try { view.cardsCollapsed = localStorage.getItem('frameboard-cards-collapsed') === 'true'; } catch { /* Optional display preference. */ }

export function toggleCards() {
  view.cardsCollapsed = !view.cardsCollapsed;
  try { localStorage.setItem('frameboard-cards-collapsed', String(view.cardsCollapsed)); } catch { /* Optional display preference. */ }
  renderBoard();
}

function rememberProject() {
  try { localStorage.setItem('frameboard-project', state.projectId || ''); } catch { /* The board itself is stored on disk. */ }
}
export function selectProject(projectId) {
  state.projectId = projectId;
  view.pasteLaneId = null;
  view.query = '';
  rememberProject();
}
export function renderStatus() {
  const { error: saveError, saving, uploading, retryable, conflicts } = saveStatus();
  document.querySelectorAll('[data-undo-move]').forEach((node) => {
    const card = node.dataset.undoMove === 'card' ? locateCard(state.cardId)?.card : latestMoveCard();
    node.dataset.id = card?.id || '';
    node.dataset.moveId = card?.lastMove?.id || '';
    node.disabled = !card?.lastMove || saving || !!state.undoingCardId || conflicts.some((item) => item.id === card?.id);
    node.title = card?.lastMove ? `Undo last move of “${card.title || 'Untitled card'}”, including values its playbook set` : 'Undo last move';
  });
  const conflictLinks = conflicts.map(({ id }) => button('open-card', `Review ${escape(locateCard(id)?.card.title || 'Untitled card')}`, null, 'button small', `data-id="${escape(id)}"`)).join('');
  const label = saveError ? 'Changes not saved' : uploading ? 'Uploading images…' : saving ? 'Saving…' : 'All changes saved';
  const busy = !saveError && (uploading || saving);
  document.querySelectorAll('[data-save-status]').forEach((node) => {
    node.innerHTML = `${icon(saveError ? 'close' : 'check')}<span class="sr-only">${label}</span>`;
    node.title = label;
    node.classList.toggle('save-error', !!saveError);
    node.classList.toggle('saving', busy);
  });
  const banner = $('#save-error');
  if (banner) {
    banner.hidden = !saveError;
    banner.innerHTML = `<span>${escape(saveError)}</span>${retryable ? button('retry-save', 'Retry save', null, 'button small') : ''}${conflictLinks}`;
  }
  const editorError = $('#editor-save-error');
  if (editorError) {
    editorError.hidden = !saveError;
    const conflict = conflicts.find(({ id }) => id === state.cardId);
    editorError.innerHTML = `<span>${escape(conflict?.message || saveError)}</span>${retryable ? button('retry-save', 'Retry save', null, 'button small') : ''}${conflict ? button('use-saved-card', 'Use saved version', null, 'button small', `data-id="${escape(conflict.id)}"`) : conflictLinks}`;
  }
}
export function showTab(tab) {
  view.tab = tab;
  renderApp();
}
export function showFlow(flowId) {
  selectFlow(project(), flowId);
  view.tab = 'board';
  view.pasteLaneId = null;
  renderApp();
}
const flowCount = (p, f) => (p.loaded ? flowCardCount(f) : f.cardCount ?? '');
// The board shows the current flow, chosen in the sidebar; the Library and
// the project chat (the flow builder) are shared by every flow in the project.
const tabs = (p) => {
  const f = flow(p);
  const tab = (name, action, label) => `<button type="button" role="tab" class="board-tab ${view.tab === name ? 'active' : ''}" data-action="${action}" aria-selected="${view.tab === name}">${label}</button>`;
  return `<div class="project-tabs" role="tablist" aria-label="Project views">${tab('board', 'show-board', `${icon(flowIcon(f))} ${escape(f?.name ?? 'Board')} ${f ? `<span data-flow-count="${f.id}">${flowCount(p, f)}</span>` : ''}`)}${tab('library', 'show-library', `${icon('upload')} Library`)}${tab('chat', 'show-chat', `${icon('chat')} Chat ${projectChatBusy(p.id) ? '<span class="project-chat-dot" title="The flow builder is working"></span>' : ''}`)}</div>`;
};
const searchBox = () => `<label class="search">${icon('search')}<input id="search" type="search" placeholder="Find a card…" aria-label="Find a card" value="${escape(view.query)}"></label>`;
const projectView = (p, tools) => view.tab === 'library'
  ? `<div class="board-toolbar">${tabs(p)}</div><section id="library" class="library" aria-label="${escape(p.name)} library"></section>`
  : view.tab === 'chat'
    ? `<div class="board-toolbar">${tabs(p)}</div><section id="project-chat" class="project-chat" aria-label="${escape(p.name)} project chat"></section>`
    : `<div class="board-toolbar">${tabs(p)}<div class="board-tools">${tools}</div></div><div id="board" class="board" aria-label="${escape(p.name)}: ${escape(flow(p)?.name ?? '')} flow"></div>`;
// Each project in the sidebar lists its flows beneath it, ending with Add a
// new flow. A card dragged onto another flow of its project moves to that
// flow's first lane; a flow dragged up or down the list changes its place.
function projectLink(item) {
  const current = item.id === state.projectId;
  const shown = current ? flow(item) : null;
  const draggable = !item.archivedAt && item.flows.length > 1 ? 'draggable="true"' : '';
  const flowRow = (f) => `<li class="flow-row ${f === shown ? 'active' : ''}" data-flow="${f.id}" ${draggable}><button type="button" class="flow-link" ${draggable} ${draggable ? 'aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"' : ''} data-action="show-flow" data-project-id="${item.id}" data-id="${f.id}" data-flow-drop="${f.id}" ${f === shown ? 'aria-current="page"' : ''}><span>${escape(f.name)}</span>${isGraph(f) ? `<span class="flow-kind" title="Graph flow">${icon('graph')}<span class="sr-only">graph</span></span>` : ''}<span class="flow-count" data-flow-count="${f.id}">${flowCount(item, f)}</span></button>${item.archivedAt ? '' : iconButton('edit-flow', `${f.name} flow settings`, 'more', `data-project-id="${item.id}" data-id="${f.id}"`)}</li>`;
  const add = item.archivedAt ? '' : `<li><button type="button" class="add-flow-link" data-action="add-flow" data-project-id="${item.id}">${icon('plus')}<span>Add a new flow</span></button></li>`;
  return `<div class="project-group"><button class="project-link ${current ? 'active' : ''}" data-action="switch-project" data-id="${item.id}">${icon('board')}<span>${escape(item.name)}</span><span class="project-count">${cardCount(item)}</span></button>
    <ul class="flow-list" aria-label="${escape(item.name)} flows">${item.flows.map(flowRow).join('')}${add}</ul></div>`;
}
// An archived project is read-only: no lane, card or playbook actions.
const archivedHeader = (p) => `<header class="board-header"><div><div class="heading-row"><h1>${escape(p.name)}</h1><span class="archived-badge">Archived</span></div></div><div class="header-actions">${button('unarchive-project', 'Unarchive', 'undo', 'button primary')}</div></header>
      <p class="archived-banner" role="note">${escape(archivedNotice)}</p>
      ${projectView(p, searchBox())}`;
export const archivedNotice = 'Archived: read-only. Unarchive to make changes.';

export function renderApp() {
  const p = project();
  document.title = `${p?.name || 'Workspace'} · Frameboard`;
  app.innerHTML = `
    <aside class="sidebar" aria-label="Projects">
      <a class="brand" href="/" aria-label="Frameboard home"><span class="brand-mark">${icon('board')}</span>Frameboard</a>
      <div class="sidebar-section"><span>Projects</span>${iconButton('add-project', 'Add project', 'plus')}</div>
      <nav class="project-list">${state.projects.filter((item) => !item.archivedAt).map(projectLink).join('')}</nav>
      ${state.projects.some((item) => item.archivedAt) ? `<div class="sidebar-section"><span>Archived</span></div><nav class="project-list archived-projects" aria-label="Archived projects">${state.projects.filter((item) => item.archivedAt).map(projectLink).join('')}</nav>` : ''}
      <div class="sidebar-bottom" title="Saved on this computer">${themeToggleMarkup()}${accentSwitchMarkup()}<a class="icon-button" href="/settings.html" aria-label="General settings" title="General settings">${icon('settings')}<span class="sr-only">Settings</span></a></div>
    </aside>
    <main class="main">
      <div class="topbar"><div class="breadcrumbs">${iconButton('toggle-sidebar', 'Toggle projects', 'menu')}</div><div class="workspace-chat-activity"><button type="button" class="icon-button" data-action="workspace-chat-activity" aria-label="Chat activity" title="Chat activity">${icon('bolt')}</button><div id="chat-activity-list" hidden></div></div><div class="save-status" data-save-status></div></div>
      <div id="save-error" class="error-banner" role="alert" hidden></div>
      ${p?.archivedAt ? archivedHeader(p) : p ? `<header class="board-header"><div><div class="heading-row"><h1>${escape(p.name)}</h1>${iconButton('edit-project', 'Project settings', 'more')}</div></div><div class="header-actions">${button('open-playbooks', 'Playbooks', 'playbook', 'button secondary')}${button('add-lane', isGraph(flow(p)) ? 'Add node' : 'Add lane', 'plus', 'button secondary')}${button('add-card', 'New card', 'plus', 'button primary', flow(p)?.lanes.length ? '' : 'disabled')}</div></header>
      ${projectView(p, `${button('undo-move', '<span class="sr-only">Undo last move</span>', 'undo', 'icon-button', 'data-undo-move="board" aria-label="Undo last move" disabled')}${button('toggle-cards', `<span class="sr-only">${view.cardsCollapsed ? 'Expand cards' : 'Collapse cards'}</span>`, view.cardsCollapsed ? 'down' : 'minus', 'icon-button', `aria-pressed="${view.cardsCollapsed}" aria-controls="board" aria-label="${view.cardsCollapsed ? 'Expand cards' : 'Collapse cards'}" title="${view.cardsCollapsed ? 'Expand cards' : 'Collapse cards'}"`)}${searchBox()}`)}` : `<div class="no-projects"><span class="empty-symbol">${icon('board')}</span><h1>No projects yet</h1><p>Create a project to start a board.</p>${button('add-project', 'Create a project', 'plus', 'button primary')}</div>`}
    </main>`;
  renderBoard();
  void renderLibrary();
  renderProjectChat();
  renderStatus();
}
// The Chat tab shows a dot while the flow builder works on this project.
export function renderTabs() {
  const p = project(); const list = $('.project-tabs');
  if (p && list) list.outerHTML = tabs(p);
}
function cardMarkup(card, draggable = true) {
  const title = escape(card.title || 'Untitled card');
  if (view.cardsCollapsed) return `<article class="card" draggable="${draggable}" data-card="${card.id}"><button class="card-open" draggable="${draggable}" data-action="open-card" data-id="${card.id}" aria-label="Open ${title}" title="${title}"><div class="card-body"><h3>${title}</h3>${activityMarkup(card.id)}</div></button></article>`;
  // A card shows what a viewer would see first: the display image and the title.
  // Agent activity is the only other thing worth a glance; the rest is in the editor.
  return `<article class="card" draggable="${draggable}" data-card="${card.id}">
    <button class="card-open" draggable="${draggable}" data-action="open-card" data-id="${card.id}" aria-label="Open ${title}">
      ${card.imageRoles.cover ? `<div class="card-image"><img src="${imageURL(card.imageRoles.cover)}" alt="" loading="lazy" draggable="false"></div>` : `<div class="card-image no-image">${icon('image')}<span>No display image</span></div>`}
      <div class="card-body"><h3>${title}</h3>${activityMarkup(card.id)}</div>
    </button></article>`;
}
// Card counts in the sidebar and on the Board tab.
function renderCounts() {
  document.querySelectorAll('.project-link').forEach((node) => {
    const item = state.projects.find((item) => item.id === node.dataset.id);
    if (item) $('.project-count', node).textContent = cardCount(item);
  });
  for (const f of project()?.flows ?? []) document.querySelectorAll(`[data-flow-count="${f.id}"]`).forEach((node) => { node.textContent = flowCardCount(f); });
}
export function renderBoard() {
  const container = $('#board');
  const p = project();
  const f = flow(p);
  if (!container || !f) return;
  const search = view.query.toLocaleLowerCase().trim();
  container.classList.toggle('cards-collapsed', view.cardsCollapsed);
  const toggle = $('[data-action="toggle-cards"]');
  if (toggle) {
    const text = view.cardsCollapsed ? 'Expand cards' : 'Collapse cards';
    toggle.innerHTML = `${icon(view.cardsCollapsed ? 'down' : 'minus')}<span class="sr-only">${text}</span>`;
    toggle.setAttribute('aria-label', text);
    toggle.title = text;
    toggle.setAttribute('aria-pressed', String(view.cardsCollapsed));
  }
  container.classList.toggle('graph-board', isGraph(f));
  if (isGraph(f)) {
    renderGraph(container, p, f, { search, collapsed: view.cardsCollapsed });
    renderCounts();
    renderStatus();
    return;
  }
  if (p.archivedAt) {
    container.innerHTML = f.lanes.map((lane) => {
      const cards = lane.cards.filter((card) => searchText(card).toLocaleLowerCase().includes(search));
      return `<section class="lane" data-lane="${lane.id}" aria-label="${escape(lane.name)} lane"><div class="lane-heading"><span class="lane-dot ${lane.color}"></span><h2>${escape(lane.name)}</h2><span class="lane-count">${search ? `${cards.length}/` : ''}${lane.cards.length}</span></div>
        <div class="lane-cards">${cards.map((card) => cardMarkup(card, false)).join('')}</div></section>`;
    }).join('');
    renderCounts();
    renderStatus();
    return;
  }
  // With more than one lane, a lane is dragged by its heading or moved with Alt and the arrow keys.
  const reorderable = f.lanes.length > 1;
  container.innerHTML = f.lanes.map((lane) => {
    const cards = lane.cards.filter((card) => searchText(card).toLocaleLowerCase().includes(search));
    return `<section class="lane" data-lane="${lane.id}" tabindex="0" aria-label="${escape(lane.name)} lane; paste images here" ${reorderable ? 'aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"' : ''}>
      <div class="lane-heading" ${reorderable ? `draggable="true" data-lane-handle="${lane.id}"` : ''}><span class="lane-dot ${lane.color}"></span><h2>${escape(lane.name)}</h2><span class="lane-count">${search ? `${cards.length}/` : ''}${lane.cards.length}</span>${lane.playbook?.hasInstructions && lane.playbook.run === 'on-enter' && !lane.playbook.errors.length ? `<span class="lane-playbook-badge" title="${escape(lane.playbook.summary)}">Auto</span>` : lane.playbook?.errors.length ? '<span class="lane-playbook-badge error" title="This lane playbook has errors">!</span>' : ''}<div class="lane-actions">${iconButton('edit-playbook', `${lane.name} playbook`, 'playbook', `data-id="${lane.id}"`)}${iconButton('edit-lane', `Edit ${lane.name} lane`, 'more', `data-id="${lane.id}"`)}${iconButton('add-card', `Add card to ${lane.name}`, 'plus', `data-lane-id="${lane.id}"`)}</div></div>
      <div class="lane-cards">${cards.map((card) => cardMarkup(card)).join('')}${!cards.length ? `<div class="empty-lane">${icon(search ? 'search' : 'image')}<p>${search ? 'No matching cards' : 'Add or paste a card'}</p></div>` : ''}</div>
      ${button('add-card', 'Add card', 'plus', 'lane-add', `data-lane-id="${lane.id}"`)}
    </section>`;
  }).join('') + `<button class="add-lane-column" data-action="add-lane">${icon('plus')}<span>Add a lane</span></button>`;
  renderCounts();
  renderStatus();
}
// Board or graph, chosen when a flow is made; Flow settings converts later.
const kindField = (kind = 'board') => `<fieldset class="kind-field"><legend class="form-label">View ${help('views', '<p><strong>Board</strong>: lanes in columns; cards move left to right.</p><p><strong>Graph</strong>: nodes joined by named routes. Agents choose the route, so a flow can branch and loop.</p><p>You can switch later in Flow settings.</p>')}</legend>${[
  ['board', 'Board'],
  ['graph', 'Graph'],
].map(([value, label]) => `<label class="kind-option"><input type="radio" name="kind" value="${value}" ${kind === value ? 'checked' : ''}><span>${icon(value)}<strong>${label}</strong></span></label>`).join('')}</fieldset>`;
const templateField = (selectedId, label = 'Card template') => `<label class="form-label" for="flow-template">${label}</label><div class="inline-field"><select class="form-input" id="flow-template" name="templateId">${state.templates.map((template, index) => `<option value="${escape(template.id)}" ${(selectedId ? template.id === selectedId : index === 0) ? 'selected' : ''}>${escape(template.name)}</option>`).join('')}</select>${button('manage-templates', 'Manage…', null, 'text-button')}</div>`;
// A new project starts with one flow; its card template is chosen here.
// Each flow's template is changed in that flow's settings.
export function editProject(isNew = false) {
  const p = project();
  smallForm({ title: isNew ? 'New project' : 'Project settings', fields: nameField(isNew ? '' : p.name) + (isNew ? templateField(null) + kindField() : ''), submit: isNew ? 'Create project' : 'Save changes', extra: isNew ? '' : `${button('archive-project', 'Archive project', null, 'text-button')}${button('delete-project', 'Delete project', 'trash', 'text-button danger')}`, onSubmit: async (data) => {
    if (isNew) {
      const next = await createProject(data.get('name').trim(), data.get('templateId') || undefined, data.get('kind') || 'board');
      selectProject(next.id);
    } else renameProject(p, data.get('name').trim());
    renderApp();
  } });
}
// A flow's name and the card template its new cards use; flows are
// reordered by dragging them in the sidebar. Deleting is offered while the
// project has another flow.
export function editFlow(isNew = false) {
  const p = project();
  const f = isNew ? null : flow(p);
  smallForm({
    title: isNew ? 'New flow' : 'Flow settings',
    fields: nameField(f?.name ?? '', 'Flow name', 100) + templateField(f?.templateId)
      + (isNew ? kindField() : `<div class="form-label" id="view-label">View</div><div class="segmented" role="group" aria-labelledby="view-label">${['board', 'graph'].map((kind) => button(isGraph(f) === (kind === 'graph') ? 'noop' : 'convert-flow', `${icon(kind)}${kind === 'graph' ? 'Graph' : 'Board'}`, null, 'chip', `aria-pressed="${isGraph(f) === (kind === 'graph')}" data-id="${f.id}"`)).join('')}</div>`),
    submit: isNew ? 'Create flow' : 'Save changes',
    extra: f && p.flows.length > 1 ? button('delete-flow', 'Delete flow', 'trash', 'text-button danger', `data-id="${f.id}"`) : '',
    onSubmit: async (data) => {
      const values = { name: data.get('name').trim(), templateId: data.get('templateId') || undefined };
      if (isNew) {
        const created = await createFlow(p, values.name, values.templateId, data.get('kind') || 'board');
        selectFlow(p, created.id);
        view.tab = 'board';
      } else updateFlow(p, f, values);
      renderApp();
    },
  });
}
export function editLane(laneId) {
  const f = flow();
  const lane = f.lanes.find((item) => item.id === laneId);
  if (isGraph(f)) return lane ? editNode(f, lane) : nodeForm();
  const fields = nameField(lane?.name, 'Lane name', 100)
    + `<fieldset class="color-field"><legend>Color</legend>${palette.map((color) => `<label class="color-option ${color}" title="${color}"><input type="radio" name="color" value="${color}" ${color === (lane?.color || palette[f.lanes.length % palette.length]) ? 'checked' : ''}><span>${icon('check')}<span class="sr-only">${color}</span></span></label>`).join('')}</fieldset>`
    + (lane ? `<div class="lane-command-settings">${button('edit-playbook', lane.playbook ? 'Open playbook' : 'Write a playbook', 'playbook', 'button secondary', `data-id="${laneId}" title="${escape(lane.playbook ? `${lane.playbook.summary}. ${lane.playbook.path}` : 'What happens when a card enters this lane')}"`)}</div>` : '');
  smallForm({ title: lane ? 'Edit lane' : 'Add a lane', fields, submit: lane ? 'Save changes' : 'Add lane', extra: lane ? button('delete-lane', 'Delete lane', 'trash', 'text-button danger', `data-id="${laneId}"`) : '', onSubmit: (data) => {
    const values = { name: data.get('name').trim(), color: data.get('color') };
    if (lane) updateLane(f, lane, values);
    else addLane(f, values);
    renderBoard();
    // Enable the new-card action when adding the first lane.
    $('.header-actions [data-action="add-card"]').disabled = !f.lanes.length;
  } });
}
// A node of a graph flow: its name, color and whether new cards start in it.
// Routes are edited on the canvas, everything else in its playbook.
function editNode(f, lane) {
  const first = f.lanes[0] === lane;
  const fields = `<label class="form-label" for="name-input">Node name</label><input class="form-input" id="name-input" name="name" value="${escape(lane.name)}" maxlength="100" required autocomplete="off">`
    + `<fieldset class="color-field"><legend>Color</legend>${palette.map((color) => `<label class="color-option ${color}" title="${color}"><input type="radio" name="color" value="${color}" ${color === lane.color ? 'checked' : ''}><span>${icon('check')}<span class="sr-only">${color}</span></span></label>`).join('')}</fieldset>`
    + `<label class="playbook-check node-start"><input type="checkbox" name="start" ${first ? 'checked disabled' : ''}>${icon('check')}New cards start here ${help('start node', '<p>New cards, and cards dropped on this flow in the sidebar, go to the start node. To change it, make another node the start.</p>')}</label>`
    + `<div class="lane-command-settings">${button('edit-playbook', 'Open playbook', 'playbook', 'button secondary', `data-id="${lane.id}" title="${escape(lane.playbook ? `${lane.playbook.summary}. ${lane.playbook.path}` : 'What happens when a card enters this node')}"`)}</div>`;
  smallForm({ title: 'Edit node', fields, submit: 'Save changes', extra: button('delete-lane', 'Delete node', 'trash', 'text-button danger', `data-id="${lane.id}"`), onSubmit: (data) => {
    updateLane(f, lane, { name: data.get('name').trim(), color: data.get('color'), position: data.get('start') ? 0 : f.lanes.indexOf(lane) });
    renderBoard();
  } });
}
