// The project sidebar, the board of lanes and cards, and the project and lane forms.
import { $, escape, icon, button, iconButton, imageURL, palette, wordCount, lastEditedMarkup, smallForm, nameField, toast } from './ui.js';
import { state, project, locateCard, cardCount, searchText, saveStatus, createProject, renameProject, addLane, updateLane, setProjectPrompt, latestMoveCard } from './state.js';
import { activityMarkup } from './chat.js';

const app = $('#app');
export const view = { query: '', pasteLaneId: null, cardsCollapsed: false };
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
    node.title = card?.lastMove ? `Undo the last move of “${card.title || 'Untitled card'}”, including values its lane playbook set` : 'Move a card to enable undo';
  });
  const conflictLinks = conflicts.map(({ id }) => button('open-card', `Review ${escape(locateCard(id)?.card.title || 'Untitled card')}`, null, 'button small', `data-id="${escape(id)}"`)).join('');
  const label = saveError ? 'Changes not saved' : uploading ? 'Uploading images…' : saving ? 'Saving…' : 'All changes saved';
  document.querySelectorAll('[data-save-status]').forEach((node) => {
    node.innerHTML = `${icon(saveError ? 'close' : 'check')}<span>${label}</span>`;
    node.classList.toggle('save-error', !!saveError);
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
const projectLink = (item) => `<button class="project-link ${item.id === state.projectId ? 'active' : ''}" data-action="switch-project" data-id="${item.id}" ${item.id === state.projectId ? 'aria-current="page"' : ''}>${icon('board')}<span>${escape(item.name)}</span><span class="project-count">${cardCount(item)}</span></button>`;
// An archived project is read-only: no lane, card or playbook actions.
const archivedHeader = (p) => `<header class="board-header"><div><div class="heading-row"><h1>${escape(p.name)}</h1><span class="archived-badge">Archived</span></div></div><div class="header-actions">${button('unarchive-project', 'Unarchive', 'undo', 'button primary')}</div></header>
      <p class="archived-banner" role="note">${escape(archivedNotice)}</p>
      <div class="board-toolbar"><div class="board-tab">${icon('board')} Board <span id="total-count">${cardCount(p)}</span></div><div class="board-tools"><label class="search">${icon('search')}<input id="search" type="search" placeholder="Find a card…" aria-label="Find a card" value="${escape(view.query)}"></label></div></div>
      <div id="board" class="board" aria-label="${escape(p.name)} kanban board"></div>`;
export const archivedNotice = 'This project is archived. Its work was cancelled; cards, chats, history and saved images stay readable. Unarchive it to make changes or start new work. Cancelled work is not restarted.';

export function renderApp() {
  const p = project();
  document.title = `${p?.name || 'Workspace'} · Frameboard`;
  app.innerHTML = `
    <aside class="sidebar" aria-label="Projects">
      <a class="brand" href="/" aria-label="Frameboard home"><span class="brand-mark">${icon('board')}</span>Frameboard<span class="brand-period">.</span></a>
      <div class="sidebar-section"><span>Projects</span>${iconButton('add-project', 'Add project', 'plus')}</div>
      <nav class="project-list">${state.projects.filter((item) => !item.archivedAt).map(projectLink).join('')}</nav>
      ${state.projects.some((item) => item.archivedAt) ? `<div class="sidebar-section"><span>Archived</span></div><nav class="project-list archived-projects" aria-label="Archived projects">${state.projects.filter((item) => item.archivedAt).map(projectLink).join('')}</nav>` : ''}
      <div class="sidebar-bottom"><a class="button secondary" href="/settings.html" aria-label="General settings">Settings</a><div class="local-label"><span class="online-dot"></span>Saved on this computer</div></div>
    </aside>
    <main class="main">
      <div class="topbar"><div class="breadcrumbs">${iconButton('toggle-sidebar', 'Toggle projects', 'menu')}</div><div class="workspace-chat-activity"><button class="button small secondary" data-action="workspace-chat-activity">Chat activity</button><div id="chat-activity-list" hidden></div></div><div class="save-status" data-save-status></div></div>
      <div id="save-error" class="error-banner" role="alert" hidden></div>
      ${p?.archivedAt ? archivedHeader(p) : p ? `<header class="board-header"><div><div class="heading-row"><h1>${escape(p.name)}</h1>${iconButton('edit-project', 'Project settings', 'more')}</div></div><div class="header-actions">${button('open-playbooks', 'Playbooks', 'playbook', 'button secondary')}${button('set-project-prompt', 'Set prompt', 'text', 'button secondary')}${button('add-lane', 'Add lane', 'plus', 'button secondary')}${button('add-card', 'New card', 'plus', 'button primary', p.lanes.length ? '' : 'disabled')}</div></header>
      <div class="board-toolbar"><div class="board-tab">${icon('board')} Board <span id="total-count">${cardCount(p)}</span></div><div class="board-tools">${button('undo-move', 'Undo last move', 'undo', 'button small secondary', 'data-undo-move="board" disabled')}${button('toggle-cards', view.cardsCollapsed ? 'Expand cards' : 'Collapse cards', null, 'button small secondary', `aria-pressed="${view.cardsCollapsed}" aria-controls="board"`)}<span class="paste-hint">${icon('image')} Paste an image to start a card</span><label class="search">${icon('search')}<input id="search" type="search" placeholder="Find a card…" aria-label="Find a card" value="${escape(view.query)}"></label></div></div>
      <div id="board" class="board" aria-label="${escape(p.name)} kanban board"></div>` : `<div class="no-projects"><span class="empty-symbol">${icon('board')}</span><h1>Room for your ideas.</h1><p>Create a project and make it your own.</p>${button('add-project', 'Create a project', 'plus', 'button primary')}</div>`}
    </main>`;
  renderBoard();
  renderStatus();
}
function cardMarkup(card, draggable = true) {
  const title = escape(card.title || 'Untitled card');
  if (view.cardsCollapsed) return `<article class="card" draggable="${draggable}" data-card="${card.id}"><button class="card-open" draggable="${draggable}" data-action="open-card" data-id="${card.id}" aria-label="Open ${title}" title="${title}"><div class="card-body"><h3>${title}</h3>${activityMarkup(card.id)}</div></button></article>`;
  const words = wordCount(`${card.fields.titleOptions} ${card.fields.intro} ${card.fields.script}`);
  return `<article class="card" draggable="${draggable}" data-card="${card.id}">
    <button class="card-open" draggable="${draggable}" data-action="open-card" data-id="${card.id}" aria-label="Open ${title}">
      ${card.imageRoles.cover ? `<div class="card-image"><img src="${imageURL(card.imageRoles.cover)}" alt="" loading="lazy" draggable="false"><span class="card-open-label">Open card ${icon('arrow')}</span></div>` : `<div class="card-image no-image">${icon('image')}<span class="card-open-label">Open card ${icon('arrow')}</span></div>`}
      <div class="card-body"><h3>${escape(card.title || 'Untitled card')}</h3>${activityMarkup(card.id)}${card.fields.intro.trim() ? `<p>${escape(card.fields.intro)}</p>` : ''}<div class="card-meta"><span>${icon('text')}${words.toLocaleString()} words</span><span>${icon('image')}${card.images.length}</span></div><span class="edited-at" data-edited-card="${card.id}">${lastEditedMarkup(card)}</span></div>
    </button></article>`;
}
export function renderBoard() {
  const container = $('#board');
  const p = project();
  if (!container || !p) return;
  const search = view.query.toLocaleLowerCase().trim();
  container.classList.toggle('cards-collapsed', view.cardsCollapsed);
  const toggle = $('[data-action="toggle-cards"]');
  if (toggle) {
    toggle.textContent = view.cardsCollapsed ? 'Expand cards' : 'Collapse cards';
    toggle.setAttribute('aria-pressed', String(view.cardsCollapsed));
  }
  if (p.archivedAt) {
    container.innerHTML = p.lanes.map((lane) => {
      const cards = lane.cards.filter((card) => searchText(card).toLocaleLowerCase().includes(search));
      return `<section class="lane" data-lane="${lane.id}" aria-label="${escape(lane.name)} lane"><div class="lane-heading"><span class="lane-dot ${lane.color}"></span><h2>${escape(lane.name)}</h2><span class="lane-count">${search ? `${cards.length}/` : ''}${lane.cards.length}</span></div>
        <div class="lane-cards">${cards.map((card) => cardMarkup(card, false)).join('')}</div></section>`;
    }).join('');
    $('#total-count').textContent = cardCount(p);
    renderStatus();
    return;
  }
  container.innerHTML = p.lanes.map((lane) => {
    const cards = lane.cards.filter((card) => searchText(card).toLocaleLowerCase().includes(search));
    return `<section class="lane" data-lane="${lane.id}" tabindex="0" aria-label="${escape(lane.name)} lane; paste images here">
      <div class="lane-heading"><span class="lane-dot ${lane.color}"></span><h2>${escape(lane.name)}</h2><span class="lane-count">${search ? `${cards.length}/` : ''}${lane.cards.length}</span>${lane.playbook?.hasInstructions && lane.playbook.run === 'on-enter' && !lane.playbook.errors.length ? `<span class="lane-playbook-badge" title="${escape(lane.playbook.summary)}">Auto</span>` : lane.playbook?.errors.length ? '<span class="lane-playbook-badge error" title="This lane playbook has errors">!</span>' : ''}<div class="lane-actions">${iconButton('edit-playbook', `${lane.name} playbook`, 'playbook', `data-id="${lane.id}"`)}${iconButton('edit-lane', `Edit ${lane.name} lane`, 'more', `data-id="${lane.id}"`)}${iconButton('add-card', `Add card to ${lane.name}`, 'plus', `data-lane-id="${lane.id}"`)}</div></div>
      <div class="lane-cards">${cards.map((card) => cardMarkup(card)).join('')}${!cards.length ? `<div class="empty-lane">${icon(search ? 'search' : 'image')}<p>${search ? 'No matching cards' : 'A blank canvas'}</p><span>${search ? 'Try another search.' : 'Add a card or paste an image.'}</span>${!search ? button('add-card', 'Add your first card', 'plus', 'empty-add', `data-lane-id="${lane.id}"`) : ''}</div>` : ''}</div>
      ${button('add-card', 'Add card', 'plus', 'lane-add', `data-lane-id="${lane.id}"`)}
    </section>`;
  }).join('') + `<button class="add-lane-column" data-action="add-lane">${icon('plus')}<span>Add a lane</span></button>`;
  $('#total-count').textContent = cardCount(p);
  document.querySelectorAll('.project-link').forEach((node) => {
    const item = state.projects.find((item) => item.id === node.dataset.id);
    if (item) $('.project-count', node).textContent = cardCount(item);
  });
  renderStatus();
}
export function editProject(isNew = false) {
  const p = project();
  smallForm({ title: isNew ? 'A new space for your ideas' : 'Project settings', fields: nameField(isNew ? '' : p.name), submit: isNew ? 'Create project' : 'Save changes', extra: isNew ? '' : `${button('archive-project', 'Archive project', null, 'text-button')}${button('delete-project', 'Delete project', 'trash', 'text-button danger')}`, onSubmit: async (data) => {
    if (isNew) {
      const next = await createProject(data.get('name').trim());
      selectProject(next.id);
    } else renameProject(p, data.get('name').trim());
    renderApp();
  } });
}
export function editLane(laneId) {
  const p = project();
  const lane = p.lanes.find((item) => item.id === laneId);
  const fields = nameField(lane?.name, 'Lane name', 100)
    + `<fieldset class="color-field"><legend>Lane color</legend>${palette.map((color) => `<label class="color-option ${color}" title="${color}"><input type="radio" name="color" value="${color}" ${color === (lane?.color || palette[p.lanes.length % palette.length]) ? 'checked' : ''}><span>${icon('check')}<span class="sr-only">${color}</span></span></label>`).join('')}</fieldset>`
    + (lane ? `<label class="form-label" for="lane-position">Position</label><select class="form-input" id="lane-position" name="position">${p.lanes.map((item, index) => `<option value="${index}" ${item.id === laneId ? 'selected' : ''}>${index + 1}${index === 0 ? ' · First lane' : index === p.lanes.length - 1 ? ' · Last lane' : ''}</option>`).join('')}</select>` : '')
    + (lane ? `<div class="lane-command-settings"><span class="form-label">When a card enters this lane</span><p class="field-help">${escape(lane.playbook ? `${lane.playbook.summary}. Defined in ${lane.playbook.path}.` : 'Nothing happens yet. Write a lane playbook to set fields or have an agent work on each card.')}</p>${button('edit-playbook', lane.playbook ? 'Open playbook' : 'Write a playbook', 'playbook', 'button secondary', `data-id="${laneId}"`)}</div>` : '<p class="field-help lane-command-settings">After adding this lane, open its playbook to decide what happens when a card enters it.</p>');
  smallForm({ title: lane ? 'Edit lane' : 'Add a lane', fields, submit: lane ? 'Save changes' : 'Add lane', extra: lane ? button('delete-lane', 'Delete lane', 'trash', 'text-button danger', `data-id="${laneId}"`) : '', onSubmit: (data) => {
    const values = { name: data.get('name').trim(), color: data.get('color') };
    if (lane) updateLane(p, lane, { ...values, position: Number(data.get('position')) });
    else addLane(p, values);
    renderBoard();
    // Enable the new-card action when adding the first lane.
    $('.header-actions [data-action="add-card"]').disabled = !p.lanes.length;
  } });
}
export function editProjectPrompt() {
  const p = project();
  const cards = p.lanes.flatMap((lane) => lane.cards);
  if (!cards.length) return toast('Add a card before applying a shared prompt.');
  const current = cards.map((card) => card.fields.prompt);
  const commonPrompt = current.every((prompt) => prompt === current[0]) ? current[0] : '';
  smallForm({
    title: 'Set prompt for all cards',
    description: `This replaces the prompt on all ${cards.length} cards in “${p.name}”.`,
    fields: `<label class="form-label" for="prompt-input">Shared prompt</label><textarea class="form-input prompt-input" id="prompt-input" name="prompt" maxlength="200000" placeholder="Write the prompt to apply to every card…">${escape(commonPrompt)}</textarea>`,
    submit: 'Apply to all cards',
    onSubmit: (data) => {
      setProjectPrompt(p, String(data.get('prompt') || ''));
      renderBoard();
      toast(`Prompt applied to ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}.`);
    },
  });
}
