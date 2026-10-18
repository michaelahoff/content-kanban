// Starts the app and routes clicks, typing, pasting, and dragging to the board and editor.
import { $, escape, iconButton, imageURL, toast, wordCount, confirmDelete, smallForm, setTheme, setAccent } from './ui.js';
import { retry, request } from './api.js';
import { fieldInputId } from './card-template.js';
import { state, project, flow, flowCardCount, forgetFlow, locateCard, locateFlow, cardCount, loadWorkspace, loadCards, loadTemplates, templateOf, cardChanged, flushCards, createCard, moveCard, deleteCard, updateLane, updateFlow, deleteLane, deleteFlow, deleteProject, archiveProject, unarchiveProject, saveStatus, hasUnsavedWork, onStatusChange, useSavedCard, undoLastMove, loadPlaybooks, applyStages, applyFlowView, convertFlow, restoreFlowSelection, refreshSavedCard } from './state.js';
import { view, selectProject, renderApp, renderBoard, renderStatus, renderTabs, renderSidebar, editProject, editFlow, editLane, toggleCards, showTab, showFlow } from './board.js';
import { mountProjectChat } from './project-chat.js';
import { dropLibraryItems, libraryActivity, hasLibraryUploads } from './library.js';
import { openCard, closeCard, cardPanelOpen, renderImages, copyText, copyTrifecta, fetchYoutube, addImages, originalVideoMarkup, videoLinkMarkup } from './editor.js';
import { openPlaybooks, playbooksChanged } from './playbook-editor.js';
import { openTemplates, templatesChanged } from './template-editor.js';
import { renderBar, cardPlaybookActivity, hasUnsavedNotes } from './card-playbook.js';
import { cardLibraryActivity } from './card-library.js';
import { initializeChats, hasUnsentChatChanges, flushComposers, onActivity } from './chat.js';

const formDialog = $('#form-dialog');
const imageDialog = $('#image-dialog');
const app = $('#app');
let draggedId;
let dropTarget = null;
// One insertion line for cards, an upright one between lanes, and one in
// the sidebar's flow lists.
function insertionLine(tag = 'div') {
  const node = document.createElement(tag);
  node.className = 'drop-indicator';
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = '<span></span>';
  return node;
}
const dropIndicator = insertionLine();
// Lanes reorder across the board and flows down their project's list in the
// sidebar, by dragging or with Alt and the arrow keys. `move` saves the new
// place and redraws.
const reorderKinds = {
  lane: { across: true, indicator: insertionLine(), keys: { ArrowLeft: -1, ArrowRight: 1 }, move(id, position) {
    const f = flow();
    updateLane(f, f.lanes.find((lane) => lane.id === id), { position });
    renderBoard();
  } },
  flow: { across: false, indicator: insertionLine('li'), keys: { ArrowUp: -1, ArrowDown: 1 }, move(id, position) {
    const { project: p, flow: f } = locateFlow(id);
    updateFlow(p, f, { position });
    renderApp();
  } },
};
reorderKinds.lane.indicator.classList.add('upright');
// The lane or flow being dragged: { kind: 'lane' | 'flow', id, target }.
let reorder = null;

function makeCard(laneId) {
  const p = project();
  if (p?.archivedAt) return toast('Unarchive this project to add cards.');
  const f = flow(p);
  const lane = f?.lanes.find((item) => item.id === laneId) || f?.lanes[0];
  if (!lane) return toast('Add a lane first.');
  const card = createCard(lane);
  renderBoard();
  openCard(card.id);
  return card;
}
// Another tab, or this one, added, changed or deleted a flow. Applying an
// entry twice changes nothing, so this tab's own changes pass through too.
async function flowActivity(entry) {
  const p = state.projects.find((item) => item.id === entry.projectId);
  if (!p) return;
  const existing = p.flows.find((item) => item.id === entry.entityId);
  if (entry.type === 'created' && !existing) {
    const created = (await request('/api/workspace')).flows.find((item) => item.id === entry.entityId);
    if (!created || p.flows.some((item) => item.id === created.id)) return;
    const { stages, ...rest } = created;
    p.flows.push({ ...rest, lanes: stages.map((stage) => ({ ...stage, cards: [] })) });
  } else if (entry.type === 'updated' && existing) {
    const shown = `${existing.name} ${existing.templateId} ${p.flows.indexOf(existing)} ${existing.kind}`;
    // A conversion reorders lanes and rewrites playbooks: take the server's view.
    if (entry.data.kind && entry.data.kind !== existing.kind) {
      const latest = (await request('/api/workspace')).flows.find((item) => item.id === existing.id);
      if (latest) applyFlowView(existing, latest);
    }
    if (entry.data.name) existing.name = entry.data.name;
    if (entry.data.templateId) existing.templateId = entry.data.templateId;
    if (Number.isInteger(entry.data.position) && p.flows.indexOf(existing) !== entry.data.position) {
      p.flows.splice(p.flows.indexOf(existing), 1);
      p.flows.splice(Math.min(entry.data.position, p.flows.length), 0, existing);
    }
    // This tab's own change comes back already applied; redrawing would
    // only take focus from the flow just moved with the keyboard.
    if (`${existing.name} ${existing.templateId} ${p.flows.indexOf(existing)} ${existing.kind}` === shown) return;
  } else if (entry.type === 'deleted' && existing) {
    forgetFlow(p, existing);
    if (state.cardId && !locateCard()) closeCard();
  } else return;
  if (p === project()) renderApp();
}
// Shows a flow from the sidebar, switching project first when needed. Without
// a flow it only switches project. Resolves false if the cards fail to load.
async function openFlow(projectId, flowId = null) {
  if (projectId && projectId !== state.projectId) {
    selectProject(projectId);
    try { await loadCards(projectId); } catch (error) { toast(error.message); return false; }
    if (state.projectId !== projectId) return false;
  }
  if (flowId) showFlow(flowId); else renderApp();
  return true;
}
// An agent moved a card along a route: show it in its new lane or node, with
// the values the lane set, unless this tab is still saving it.
async function agentMoved(cardId) {
  if (!locateCard(cardId)) return;
  try { refreshSavedCard((await request(`/api/cards/${encodeURIComponent(cardId)}`)).card); } catch { return; }
  renderBoard();
}
async function switchProject(projectId) {
  selectProject(projectId);
  try { await loadCards(projectId); } catch (error) { return toast(error.message); }
  if (state.projectId === projectId) renderApp();
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const targetId = target.dataset.id;
  const action = target.dataset.action;
  if (action === 'add-project') editProject(true);
  if (action === 'edit-project') editProject();
  if (action === 'switch-project') switchProject(targetId);
  if (action === 'toggle-sidebar') $('.sidebar').classList.toggle('mobile-open');
  if (action === 'set-theme') setTheme(target.dataset.theme);
  if (action === 'set-accent') setAccent(target.dataset.accent);
  if (action === 'toggle-cards') toggleCards();
  if (action === 'show-board') showTab('board');
  if (action === 'show-flow') void openFlow(target.dataset.projectId, targetId);
  if (action === 'add-flow') void openFlow(target.dataset.projectId).then((opened) => opened && editFlow(true));
  if (action === 'edit-flow') void openFlow(target.dataset.projectId, targetId).then((opened) => opened && editFlow());
  if (action === 'show-library') showTab('library');
  if (action === 'show-chat') showTab('chat');
  if (action === 'add-lane') editLane();
  if (action === 'edit-lane') editLane(targetId);
  if (action === 'edit-playbook') {
    if (formDialog.open) formDialog.close();
    openPlaybooks({ laneId: targetId });
  }
  if (action === 'open-playbooks') openPlaybooks();
  if (action === 'manage-templates') {
    if (formDialog.open) formDialog.close();
    openTemplates();
  }
  if (action === 'add-card') makeCard(target.dataset.laneId);
  if (action === 'open-card') openCard(targetId);
  if (action === 'close-card') closeCard();
  if (action === 'close-form') formDialog.close();
  if (action === 'close-image') imageDialog.close();
  if (action === 'retry-save') retry();
  if (action === 'undo-move') {
    undoLastMove(targetId, Number(target.dataset.moveId)).then(() => {
      if (state.cardId === targetId && $('#card-lane')) { $('#card-lane').value = locateCard(targetId)?.card.stageId; renderBar(); }
      renderBoard();
      toast('Move undone.');
    }).catch((error) => toast(error.message));
  }
  if (action === 'use-saved-card') {
    smallForm({
      title: 'Use the saved version?',
      description: 'Discards your unsaved changes to this card.',
      submit: 'Use saved version', danger: true,
      onSubmit: async () => {
        await useSavedCard(targetId);
        renderBoard();
        if (state.cardId === targetId) openCard(targetId);
      },
    });
  }
  if (action === 'copy-field') {
    const field = target.dataset.field;
    const name = templateOf(locateCard().card).fields.find((item) => item.key === field).label;
    return copyText(locateCard().card.fields[field], name);
  }
  if (action === 'copy-trifecta') return copyTrifecta(target);
  if (action === 'fetch-youtube') return fetchYoutube(target);
  if (action === 'delete-project') {
    const p = project();
    confirmDelete(`Delete “${p.name}”?`, `Deletes ${p.flows.length === 1 ? '1 flow' : `${p.flows.length} flows`} and ${cardCount(p)} cards. Cannot be undone.`, () => {
      deleteProject(p);
      selectProject(state.projects[0]?.id);
      renderApp();
      toast('Project deleted.');
    });
  }
  if (action === 'archive-project') {
    const p = project();
    smallForm({
      title: `Archive “${p.name}”?`,
      description: 'Cancels queued and running work. Everything stays readable; unarchive any time (cancelled work is not restarted).',
      submit: 'Archive project',
      onSubmit: async () => {
        await archiveProject(p);
        if (locateCard()?.project === p) closeCard();
        renderApp();
        toast('Project archived.');
      },
    });
  }
  if (action === 'unarchive-project') {
    const p = project();
    target.disabled = true;
    unarchiveProject(p).then(() => { renderApp(); toast('Project unarchived.'); })
      .catch((error) => { target.disabled = false; toast(error.message); });
  }
  if (action === 'delete-flow') {
    const p = project();
    const f = p.flows.find((item) => item.id === targetId);
    const count = flowCardCount(f);
    confirmDelete(`Delete the “${f.name}” flow?`, `Deletes ${f.lanes.length} ${f.lanes.length === 1 ? 'lane' : 'lanes'} and ${count} ${count === 1 ? 'card' : 'cards'}. Move cards you want to keep first.`, async () => {
      try { await deleteFlow(p, f); } catch (error) { return toast(error.message); }
      if (locateCard() === null && state.cardId) closeCard();
      renderApp();
      toast('Flow deleted.');
    });
  }
  if (action === 'delete-lane') {
    const f = flow();
    const lane = f.lanes.find((item) => item.id === targetId);
    const noun = f.kind === 'graph' ? 'node' : 'lane';
    confirmDelete(`Delete “${lane.name}”?`, `Deletes ${lane.cards.length} ${lane.cards.length === 1 ? 'card' : 'cards'}.${f.kind === 'graph' ? ' Routes leading here are removed.' : ''}`, () => {
      deleteLane(f, targetId);
      renderApp();
      toast(f.kind === 'graph' ? 'Node deleted.' : 'Lane deleted.');
    });
  }
  if (action === 'convert-flow') {
    const p = project();
    const f = p.flows.find((item) => item.id === targetId);
    const toGraph = f.kind !== 'graph';
    smallForm({
      title: toGraph ? `Turn “${f.name}” into a graph?` : `Turn “${f.name}” into a board?`,
      description: toGraph
        ? 'Lanes become nodes joined in a line by routes named “next”. Cards and playbooks are kept.'
        : 'Nodes become lanes in route order. Routes, advance settings and layout are removed. Cannot be undone.',
      submit: toGraph ? 'Turn into a graph' : 'Turn into a board', danger: !toGraph,
      onSubmit: async () => {
        await convertFlow(f, toGraph ? 'graph' : 'board');
        renderApp();
        toast(toGraph ? 'This flow is now a graph.' : 'This flow is now a board.');
      },
    });
  }
  if (action === 'delete-card') {
    const found = locateCard();
    confirmDelete('Delete this card?', `“${found.card.title || 'Untitled card'}” and its images will be removed. Cannot be undone.`, () => {
      deleteCard(found.card.id);
      closeCard();
      renderBoard();
      toast('Card deleted.');
    });
  }
  if (action === 'set-display') {
    const { card } = locateCard();
    if (card.imageRoles.cover === targetId) return;
    card.imageRoles.cover = targetId;
    cardChanged(card);
    renderImages();
    renderBoard();
  }
  if (action === 'set-image-role') {
    const { card } = locateCard();
    const { role } = target.dataset;
    card.imageRoles[role] = card.imageRoles[role] === targetId ? null : targetId;
    cardChanged(card);
    renderImages();
  }
  if (action === 'remove-image') {
    const found = locateCard();
    const item = found.card.images.find((image) => image.id === targetId);
    confirmDelete('Remove this image?', `Remove “${item.name}”?`, () => {
      found.card.images = found.card.images.filter((image) => image.id !== targetId);
      const roles = found.card.imageRoles;
      for (const role of Object.keys(roles)) if (roles[role] === targetId) roles[role] = null;
      if (roles.cover === null) roles.cover = found.card.images[0]?.id || null;
      cardChanged(found.card);
      renderImages();
      renderBoard();
    });
  }
  if (action === 'preview-image') {
    const item = locateCard().card.images.find((image) => image.id === targetId);
    imageDialog.innerHTML = `${iconButton('close-image', 'Close image preview', 'close')}<img src="${imageURL(item.id)}" alt="${escape(item.name)}"><p>${escape(item.name)}</p>`;
    imageDialog.showModal();
  }
});
document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'search') { view.query = target.value; renderBoard(); }
  const found = target.id?.startsWith('card-') && locateCard();
  if (!found) return;
  const { card } = found;
  const field = templateOf(card).fields.find((item) => fieldInputId(item.key) === target.id);
  if (target.id === 'card-title') {
    if (card.title === target.value) return;
    card.title = target.value;
  } else {
    const key = field?.key;
    if (!key || card.fields[key] === target.value) return;
    card.fields[key] = target.value;
  }
  const count = field?.countWords && $(`#${field.key}-count`);
  if (count) count.textContent = `${wordCount(target.value).toLocaleString()} words`;
  if (field?.control === 'url') $(`#${target.id}-link`).innerHTML = field.youtube ? originalVideoMarkup(card, field) : videoLinkMarkup(target.value, field.videoLabel || field.label);
  cardChanged(card);
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'card-lane') {
    const before = locateCard()?.flow;
    if (moveCard(state.cardId, event.target.value)) {
      renderBoard(); renderBar();
      const after = locateCard();
      if (after && after.flow !== before) toast(`Moved to ${after.flow.name} › ${after.lane.name}.`);
    } else event.target.value = locateCard()?.card.stageId;
  }
  if (event.target.id === 'image-files') {
    addImages(event.target.files, state.cardId);
    event.target.value = '';
  }
});
document.addEventListener('focusin', (event) => {
  const lane = event.target.closest('[data-lane]');
  if (lane) view.pasteLaneId = lane.dataset.lane;
});
document.addEventListener('paste', (event) => {
  if (!state.projects.length || formDialog.open || imageDialog.open) return;
  const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  if (!cardPanelOpen() && event.target.closest('input, textarea, [contenteditable]')) return;
  event.preventDefault();
  // The Library tab has no lanes to paste a new card into.
  if (!cardPanelOpen() && view.tab === 'library') return;
  let targetId = cardPanelOpen() ? state.cardId : null;
  if (!targetId && project()?.archivedAt) return;
  if (!targetId) targetId = makeCard(view.pasteLaneId)?.id;
  if (targetId) addImages(files, targetId);
});
document.addEventListener('dragstart', (event) => {
  // A drag whose element was redrawn away never reports dragend; start clean.
  draggedId = null;
  reorder = null;
  const handle = event.target.closest?.('[data-lane-handle], [draggable="true"][data-flow]');
  if (handle) {
    const kind = handle.dataset.laneHandle ? 'lane' : 'flow';
    const node = kind === 'lane' ? handle.closest('[data-lane]') : handle;
    reorder = { kind, id: node.dataset[kind], target: null };
    event.dataTransfer.setData(`application/x-frameboard-${kind}`, reorder.id);
    event.dataTransfer.effectAllowed = 'move';
    const rect = node.getBoundingClientRect();
    event.dataTransfer.setDragImage(node, event.clientX - rect.left, event.clientY - rect.top);
    node.classList.add('dragging');
    return;
  }
  const card = event.target.closest('[data-card]');
  if (!card) return;
  draggedId = card.dataset.card;
  event.dataTransfer.setData('text/plain', draggedId);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
function clearDropTarget() {
  for (const indicator of [dropIndicator, ...Object.values(reorderKinds).map((kind) => kind.indicator)]) {
    indicator.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
    indicator.remove();
  }
  dropTarget = null;
  if (reorder) reorder.target = null;
  document.querySelectorAll('.drag-over').forEach((node) => node.classList.remove('drag-over'));
}
function clearDrag() {
  clearDropTarget();
  document.querySelectorAll('.dragging').forEach((node) => node.classList.remove('dragging'));
}
function insertionTarget(lane, y) {
  const cards = [...lane.querySelectorAll('[data-card]')].filter((card) => card.dataset.card !== draggedId);
  const before = cards.find((card) => {
    const rect = card.getBoundingClientRect();
    return y <= rect.top + rect.height / 2;
  });
  return { laneId: lane.dataset.lane, beforeId: before?.dataset.card || null };
}
function showDropTarget(lane, y) {
  // Keep the slot stable when the pointer is inside the gap it just opened.
  const rect = dropIndicator.getBoundingClientRect();
  if (dropTarget?.laneId === lane.dataset.lane && y >= rect.top && y <= rect.bottom) return;
  const target = insertionTarget(lane, y);
  if (dropIndicator.isConnected && dropTarget?.laneId === target.laneId && dropTarget.beforeId === target.beforeId) return;
  clearDropTarget();
  dropTarget = target;
  lane.classList.add('drag-over');
  const cards = $('.lane-cards', lane);
  const before = [...cards.querySelectorAll('[data-card]')].find((card) => card.dataset.card === target.beforeId);
  openSlot(dropIndicator, cards, before || cards.querySelector('.empty-lane, .graph-empty'));
}
// Puts the insertion line in `list` before `before` (the end when null),
// opening its own gap there. It lies flat between cards and flows and
// stands upright between lanes.
function openSlot(indicator, list, before, upright = false) {
  list.insertBefore(indicator, before);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const style = getComputedStyle(list);
  const gap = parseFloat(upright ? style.columnGap : style.rowGap) || 0;
  const margin = upright ? 'marginInline' : 'marginBlock';
  const scale = upright ? 'scaleY' : 'scaleX';
  const easing = 'cubic-bezier(.22, 1, .36, 1)';
  // Cancel out the extra flex gap at first, then ease the neighbours apart.
  indicator.animate([
    { flexBasis: '0px', [margin]: `${-gap / 2}px`, opacity: 0 },
    { flexBasis: '26px', [margin]: '0px', opacity: 1 },
  ], { duration: 180, easing });
  $('span', indicator).animate([
    { transform: `${scale}(0)`, opacity: 0 },
    { transform: `${scale}(1)`, opacity: 1 },
  ], { duration: 220, easing });
}
// Where cards, lanes or flows (`kind`) sit, apart from the one being dragged, so
// they can slide from there to their new places after a drop.
function positions(kind, skipId) {
  return new Map([...document.querySelectorAll(`[data-${kind}]`)]
    .filter((node) => node.dataset[kind] !== skipId)
    .map((node) => [node.dataset[kind], node.getBoundingClientRect()]));
}
function slide(kind, previous) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const node of document.querySelectorAll(`[data-${kind}]`)) {
    const before = previous.get(node.dataset[kind]);
    if (!before) continue;
    const after = node.getBoundingClientRect();
    const x = before.left - after.left, y = before.top - after.top;
    if (Math.abs(x) < 1 && Math.abs(y) < 1) continue;
    node.animate([
      { transform: `translate(${x}px, ${y}px)` },
      { transform: getComputedStyle(node).transform },
    ], { duration: 200, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  }
}
const reorderNode = () => document.querySelector(`[data-${reorder.kind}="${reorder.id}"]`);
// The pointer's place along the line a lane or flow moves on, and where a
// rectangle starts and ends on it.
const along = (event) => (reorderKinds[reorder.kind].across ? event.clientX : event.clientY);
const span = (rect) => (reorderKinds[reorder.kind].across ? [rect.left, rect.right] : [rect.top, rect.bottom]);
// Where a dragged lane or flow would land among its siblings: before the
// first whose middle is past the pointer. `same` marks a drop that would
// leave it where it is.
function reorderTarget(point) {
  const list = reorderNode().parentElement;
  const items = [...list.querySelectorAll(`:scope > [data-${reorder.kind}]`)];
  const others = items.filter((node) => node.dataset[reorder.kind] !== reorder.id);
  const before = others.find((node) => { const [start, end] = span(node.getBoundingClientRect()); return point <= (start + end) / 2; }) || null;
  const position = before ? others.indexOf(before) : others.length;
  // Past the last sibling the line goes before whatever follows the list
  // (Add a lane, Add a new flow).
  let after = items.at(-1).nextElementSibling;
  if (after === reorderKinds[reorder.kind].indicator) after = after.nextElementSibling;
  return { list, before: before || after, position, same: position === items.indexOf(reorderNode()) };
}
// Lanes reorder within the board, flows within their project's list.
const overReorderList = (event) => !!reorderNode()?.parentElement.contains(event.target);
function showReorderTarget(point) {
  const { indicator, across } = reorderKinds[reorder.kind];
  // Keep the slot stable when the pointer is inside the gap it just opened.
  const [start, end] = span(indicator.getBoundingClientRect());
  if (indicator.isConnected && point >= start && point <= end) return;
  const target = reorderTarget(point);
  if (indicator.isConnected && reorder.target?.position === target.position) return;
  clearDropTarget();
  reorder.target = target;
  openSlot(indicator, target.list, target.before, across);
}
function dropReorder(event) {
  const { kind, id } = reorder;
  const target = !overReorderList(event) ? null : reorder.target ?? reorderTarget(along(event));
  const previous = positions(kind, id);
  clearDrag();
  reorder = null;
  if (!target) return;
  event.preventDefault();
  if (target.same) return;
  reorderKinds[kind].move(id, target.position);
  slide(kind, previous);
}
// Alt with an arrow key moves the focused lane left or right, or the focused
// flow up or down, one place.
document.addEventListener('keydown', (event) => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || cardPanelOpen() || formDialog.open || imageDialog.open) return;
  const lane = event.target.matches?.('#board > [data-lane]') && $('[data-lane-handle]', event.target) ? event.target : null;
  const node = lane || event.target.closest?.('.flow-link')?.closest('[draggable="true"][data-flow]');
  if (!node) return;
  const kind = lane ? 'lane' : 'flow';
  const step = reorderKinds[kind].keys[event.key];
  if (!step) return;
  event.preventDefault();
  const id = node.dataset[kind];
  const siblings = [...node.parentElement.querySelectorAll(`:scope > [data-${kind}]`)];
  const position = siblings.indexOf(node) + step;
  if (position < 0 || position >= siblings.length) return;
  const previous = positions(kind);
  reorderKinds[kind].move(id, position);
  slide(kind, previous);
  document.querySelector(kind === 'lane' ? `#board > [data-lane="${id}"]` : `[data-flow="${id}"] .flow-link`)?.focus();
});
document.addEventListener('dragend', () => { draggedId = null; reorder = null; clearDrag(); });
// A card dropped on another flow of its project in the sidebar moves to that
// flow's first lane.
const flowDropTarget = (event) => {
  const row = draggedId && !cardPanelOpen() && event.target.closest?.('[data-flow-drop]');
  const f = row && project()?.flows.find((item) => item.id === row.dataset.flowDrop);
  return f && f !== flow() && f.lanes.length && !project().archivedAt ? { row, flow: f } : null;
};
document.addEventListener('dragenter', (event) => {
  if (reorder) { if (overReorderList(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } return; }
  if (flowDropTarget(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; return; }
  if (!draggedId || cardPanelOpen() || formDialog.open || imageDialog.open || !event.target.closest('[data-lane]')) return;
  // Opening the insertion gap can put a different child under the pointer.
  // Accept that child immediately, including a drop before the next dragover.
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});
document.addEventListener('dragover', (event) => {
  const files = event.dataTransfer.types.includes('Files');
  if (files) event.preventDefault();
  if (formDialog.open || imageDialog.open) return;
  if (reorder) {
    if (!overReorderList(event)) { clearDropTarget(); return; }
    event.preventDefault();
    showReorderTarget(along(event));
    event.dataTransfer.dropEffect = 'move';
    return;
  }
  if (cardPanelOpen() && files) { $('#image-drop').classList.add('drag-over'); return; }
  const flowDrop = !files && flowDropTarget(event);
  if (flowDrop) {
    event.preventDefault();
    clearDropTarget();
    flowDrop.row.classList.add('drag-over');
    event.dataTransfer.dropEffect = 'move';
    return;
  }
  if (files && event.target.closest('#library')) { $('[data-library-drop]')?.classList.add('drag-over'); event.dataTransfer.dropEffect = project()?.archivedAt ? 'none' : 'copy'; return; }
  const lane = event.target.closest('[data-lane]');
  if (!lane || (!files && !draggedId)) { clearDropTarget(); return; }
  event.preventDefault();
  if (files) {
    clearDropTarget();
    lane.classList.add('drag-over');
  } else showDropTarget(lane, event.clientY);
  event.dataTransfer.dropEffect = files ? 'copy' : 'move';
});
document.addEventListener('dragleave', (event) => {
  const lane = event.target.closest('[data-lane]');
  if (lane && !lane.contains(event.relatedTarget)) {
    const rect = lane.getBoundingClientRect();
    if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return;
    if (dropTarget?.laneId === lane.dataset.lane) clearDropTarget();
    lane.classList.remove('drag-over');
  } else if (!lane && !event.relatedTarget) clearDropTarget();
});
document.addEventListener('drop', (event) => {
  if (reorder) { dropReorder(event); return; }
  const files = [...event.dataTransfer.files];
  if (files.length) event.preventDefault();
  const lane = event.target.closest('[data-lane]');
  const target = lane && draggedId && !files.length
    ? dropTarget?.laneId === lane.dataset.lane ? dropTarget : insertionTarget(lane, event.clientY)
    : null;
  const previous = target ? positions('card', draggedId) : null;
  clearDrag();
  if (formDialog.open || imageDialog.open) return;
  if (cardPanelOpen() && files.length) { addImages(files, state.cardId); return; }
  if (files.length && event.target.closest('#library')) { dropLibraryItems(event.dataTransfer, files); return; }
  const flowDrop = !files.length && flowDropTarget(event);
  if (flowDrop) {
    event.preventDefault();
    if (moveCard(draggedId, flowDrop.flow.lanes[0].id)) { renderBoard(); toast(`Moved to ${flowDrop.flow.name} › ${flowDrop.flow.lanes[0].name}.`); }
    draggedId = null;
    return;
  }
  if (!lane) return;
  event.preventDefault();
  if (files.length) {
    if (!files.some((file) => file.type.startsWith('image/'))) return toast('Drop image files to create a card.');
    const card = makeCard(lane.dataset.lane);
    if (card) addImages(files, card.id);
  } else if (target && moveCard(draggedId, target.laneId, target.beforeId)) {
    renderBoard();
    slide('card', previous);
  }
  draggedId = null;
});
for (const dialog of [formDialog, imageDialog]) {
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (event) => { downOnBackdrop = event.target === dialog && (event.offsetX < 0 || event.offsetY < 0 || event.offsetX > dialog.clientWidth || event.offsetY > dialog.clientHeight); });
  dialog.addEventListener('click', (event) => { if (downOnBackdrop && event.target === dialog) dialog.close(); downOnBackdrop = false; });
}
window.addEventListener('beforeunload', (event) => {
  if (hasUnsavedWork() || hasUnsentChatChanges() || hasUnsavedNotes() || hasLibraryUploads()) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { flushCards(); flushComposers(); } });
window.addEventListener('online', () => { if (saveStatus().error) retry(); });
onStatusChange(renderStatus);

try {
  await loadWorkspace();
  restoreFlowSelection();
  try { state.projectId = localStorage.getItem('frameboard-project'); } catch { /* Optional preference. */ }
  if (!project()) state.projectId = (state.projects.find((item) => !item.archivedAt) ?? state.projects[0])?.id;
  await loadCards(state.projectId);
  renderApp();
  initializeChats({ openCard, switchProject, renderBoard });
  mountProjectChat({ renderApp, renderTabs, renderSidebar, chatShown: () => view.tab === 'chat' });
  // Playbook files saved in another tab change lane summaries on the board.
  onActivity((entry) => {
    cardPlaybookActivity(entry);
    libraryActivity(entry);
    cardLibraryActivity(entry);
    if (entry.entity === 'card' && entry.type === 'moved' && entry.actor?.startsWith('automation:')) void agentMoved(entry.entityId);
    // Another tab changed the card templates: reload them and redraw the board.
    if (entry.entity === 'template') void loadTemplates().then(() => { renderBoard(); templatesChanged(); }).catch(() => {});
    // Another tab archived or unarchived a project.
    const changed = entry.entity === 'project' && ['archived', 'unarchived'].includes(entry.type) && state.projects.find((item) => item.id === entry.entityId);
    if (changed && Boolean(changed.archivedAt) !== (entry.type === 'archived')) {
      changed.archivedAt = entry.type === 'archived' ? entry.createdAt : null;
      if (changed.archivedAt && locateCard()?.project === changed) closeCard();
      renderApp();
    }
    if (entry.entity !== 'flow') return;
    if (['created', 'updated', 'deleted'].includes(entry.type)) return void flowActivity(entry).catch(() => {});
    playbooksChanged();
    const f = state.projects.flatMap((item) => item.flows).find((item) => item.id === entry.entityId);
    if (f) void loadPlaybooks(f).then((listing) => { applyStages(f, listing.stages); renderBoard(); renderBar(); }).catch(() => {});
  });
} catch (error) {
  app.innerHTML = `<div class="loading-screen"><h1>Couldn’t open your workspace</h1><p>${escape(error.message)}</p><p>Make sure the local server is running, then reload this page.</p><a class="button primary" href="/">Try again</a></div>`;
}
