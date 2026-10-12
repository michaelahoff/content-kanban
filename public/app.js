// Starts the app and routes clicks, typing, pasting, and dragging to the board and editor.
import { $, escape, iconButton, imageURL, toast, wordCount, confirmDelete, smallForm, setTheme, setAccent } from './ui.js';
import { retry, request } from './api.js';
import { fieldInputId } from './card-template.js';
import { state, project, flow, locateCard, cardCount, loadWorkspace, loadCards, loadTemplates, templateOf, flowTemplate, cardChanged, flushCards, createCard, moveCard, deleteCard, deleteLane, deleteFlow, deleteProject, archiveProject, unarchiveProject, saveStatus, hasUnsavedWork, onStatusChange, useSavedCard, undoLastMove, loadPlaybooks, applyStages, restoreFlowSelection } from './state.js';
import { view, selectProject, renderApp, renderBoard, renderStatus, editProject, editFlow, editLane, editProjectPrompt, toggleCards, showTab, showFlow } from './board.js';
import { dropLibraryItems, libraryActivity, hasLibraryUploads } from './library.js';
import { openCard, closeCard, cardPanelOpen, renderImages, copyText, copyTrifecta, fetchYoutube, addImages, originalVideoMarkup, videoLinkMarkup } from './editor.js';
import { openPlaybooks, playbooksChanged } from './playbook-editor.js';
import { openTemplates, templatesChanged } from './template-editor.js';
import { renderBar, cardPlaybookActivity, hasUnsavedNotes } from './card-playbook.js';
import { initializeChats, hasUnsentChatChanges, flushComposers, onActivity } from './chat.js';

const formDialog = $('#form-dialog');
const imageDialog = $('#image-dialog');
const app = $('#app');
let draggedId;
let dropTarget = null;
const dropIndicator = document.createElement('div');
dropIndicator.className = 'drop-indicator';
dropIndicator.setAttribute('aria-hidden', 'true');
dropIndicator.innerHTML = '<span></span>';

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
    if (entry.data.name) existing.name = entry.data.name;
    if (entry.data.templateId) existing.templateId = entry.data.templateId;
    if (Number.isInteger(entry.data.position) && p.flows.indexOf(existing) !== entry.data.position) {
      p.flows.splice(p.flows.indexOf(existing), 1);
      p.flows.splice(Math.min(entry.data.position, p.flows.length), 0, existing);
    }
  } else if (entry.type === 'deleted' && existing) {
    p.flows = p.flows.filter((item) => item !== existing);
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
  if (action === 'set-project-prompt') editProjectPrompt();
  if (action === 'toggle-cards') toggleCards();
  if (action === 'show-board') showTab('board');
  if (action === 'show-flow') void openFlow(target.dataset.projectId, targetId);
  if (action === 'add-flow') void openFlow(target.dataset.projectId).then((opened) => opened && editFlow(true));
  if (action === 'edit-flow') void openFlow(target.dataset.projectId, targetId).then((opened) => opened && editFlow());
  if (action === 'show-library') showTab('library');
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
      description: 'This discards your unsaved text and image changes on this card. Copy anything you want to keep first. Other cards are unaffected.',
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
    confirmDelete(`Delete “${p.name}”?`, `This will delete the project, its ${p.flows.length === 1 ? 'flow' : `${p.flows.length} flows`} and their lanes, and ${cardCount(p)} cards. This cannot be undone.`, () => {
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
      description: 'Archiving cancels this project’s queued and pending work and stops running agent work. Its cards, chats, history and saved images are kept and stay readable. You can unarchive it later; cancelled work is not restarted.',
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
    unarchiveProject(p).then(() => { renderApp(); toast('Project unarchived. Cancelled work was not restarted.'); })
      .catch((error) => { target.disabled = false; toast(error.message); });
  }
  if (action === 'delete-flow') {
    const p = project();
    const f = p.flows.find((item) => item.id === targetId);
    const count = f.lanes.reduce((sum, lane) => sum + lane.cards.length, 0);
    confirmDelete(`Delete the “${f.name}” flow?`, `This will delete its ${f.lanes.length} lanes and ${count} ${count === 1 ? 'card' : 'cards'}. Move any cards you want to keep to another flow first. Its playbook files stay on disk.`, async () => {
      try { await deleteFlow(p, f); } catch (error) { return toast(error.message); }
      if (locateCard() === null && state.cardId) closeCard();
      renderApp();
      toast('Flow deleted.');
    });
  }
  if (action === 'delete-lane') {
    const lane = flow().lanes.find((item) => item.id === targetId);
    confirmDelete(`Delete “${lane.name}”?`, `This will also delete ${lane.cards.length} ${lane.cards.length === 1 ? 'card' : 'cards'} in this lane. Move any cards you want to keep to another lane first.`, () => {
      deleteLane(flow(), targetId);
      renderApp();
      toast('Lane deleted.');
    });
  }
  if (action === 'delete-card') {
    const found = locateCard();
    confirmDelete('Delete this card?', `“${found.card.title || 'Untitled card'}” and its text and images will be removed from the board. This cannot be undone.`, () => {
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
    confirmDelete('Remove this image?', `Remove “${item.name}” from this card?`, () => {
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
  const card = event.target.closest('[data-card]');
  if (!card) return;
  draggedId = card.dataset.card;
  event.dataTransfer.setData('text/plain', draggedId);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
function clearDropTarget() {
  dropIndicator.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
  dropIndicator.remove();
  dropTarget = null;
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
  cards.insertBefore(dropIndicator, before || cards.querySelector('.empty-lane'));
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const gap = parseFloat(getComputedStyle(cards).rowGap) || 0;
    const easing = 'cubic-bezier(.22, 1, .36, 1)';
    // Cancel out the extra flex gap at first, then ease the cards apart.
    dropIndicator.animate([
      { flexBasis: '0px', marginBlock: `${-gap / 2}px`, opacity: 0 },
      { flexBasis: '26px', marginBlock: '0px', opacity: 1 },
    ], { duration: 180, easing });
    $('span', dropIndicator).animate([
      { transform: 'scaleX(0)', opacity: 0 },
      { transform: 'scaleX(1)', opacity: 1 },
    ], { duration: 220, easing });
  }
}
function cardPositions() {
  return new Map([...document.querySelectorAll('[data-card]')]
    .filter((card) => card.dataset.card !== draggedId)
    .map((card) => [card.dataset.card, card.getBoundingClientRect()]));
}
function slideCards(previous) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const card of document.querySelectorAll('[data-card]')) {
    const before = previous.get(card.dataset.card);
    if (!before) continue;
    const after = card.getBoundingClientRect();
    const x = before.left - after.left, y = before.top - after.top;
    if (Math.abs(x) < 1 && Math.abs(y) < 1) continue;
    card.animate([
      { transform: `translate(${x}px, ${y}px)` },
      { transform: getComputedStyle(card).transform },
    ], { duration: 200, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  }
}
document.addEventListener('dragend', () => { draggedId = null; clearDrag(); });
// A card dropped on another flow of its project in the sidebar moves to that
// flow's first lane.
const flowTabTarget = (event) => {
  const tab = draggedId && !cardPanelOpen() && event.target.closest?.('[data-flow-drop]');
  const f = tab && project()?.flows.find((item) => item.id === tab.dataset.flowDrop);
  return f && f !== flow() && f.lanes.length && !project().archivedAt ? { tab, flow: f } : null;
};
document.addEventListener('dragenter', (event) => {
  if (flowTabTarget(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; return; }
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
  if (cardPanelOpen() && files) { $('#image-drop').classList.add('drag-over'); return; }
  const tabTarget = !files && flowTabTarget(event);
  if (tabTarget) {
    event.preventDefault();
    clearDropTarget();
    tabTarget.tab.classList.add('drag-over');
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
  const files = [...event.dataTransfer.files];
  if (files.length) event.preventDefault();
  const lane = event.target.closest('[data-lane]');
  const target = lane && draggedId && !files.length
    ? dropTarget?.laneId === lane.dataset.lane ? dropTarget : insertionTarget(lane, event.clientY)
    : null;
  const previous = target ? cardPositions() : null;
  clearDrag();
  if (formDialog.open || imageDialog.open) return;
  if (cardPanelOpen() && files.length) { addImages(files, state.cardId); return; }
  if (files.length && event.target.closest('#library')) { dropLibraryItems(event.dataTransfer, files); return; }
  const tabTarget = !files.length && flowTabTarget(event);
  if (tabTarget) {
    event.preventDefault();
    if (moveCard(draggedId, tabTarget.flow.lanes[0].id)) { renderBoard(); toast(`Moved to ${tabTarget.flow.name} › ${tabTarget.flow.lanes[0].name}.`); }
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
    slideCards(previous);
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
  // Playbook files saved in another tab change lane summaries on the board.
  onActivity((entry) => {
    cardPlaybookActivity(entry);
    libraryActivity(entry);
    // Another tab changed the card templates: reload them and redraw the board,
    // or the whole app when the header's Set prompt button may have changed.
    if (entry.entity === 'template') void loadTemplates().then(() => { if (flowTemplate()?.id === entry.entityId) renderApp(); else renderBoard(); templatesChanged(); }).catch(() => {});
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
