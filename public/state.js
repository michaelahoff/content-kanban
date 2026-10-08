// The browser's copy of the workspace. Changes apply here immediately and are
// queued for the server; card text is saved after a short pause in typing.
import { request, send, enqueue, onSyncChange, syncState } from './api.js';
import { defaultTemplate, emptyFields, emptyImageRoles, templates } from './card-template.js';
import { id, showEdited } from './ui.js';
import { emptyGraph } from './flow-graph.js';

export const state = { projects: [], projectId: null, cardId: null, uploads: 0, undoingCardId: null };
const dirty = new Set();
const queuedCards = new Set();
const conflicts = new Map();
const statusListeners = new Set();
const fieldListeners = new Set();
const editingSessions = new Map();
const savedValues = new Map();
const leaseOwner = id();
const leaseTimers = new Map();
const leaseSequences = new Map();
let saveTimer = null;

const url = (...parts) => `/api/${parts.map(encodeURIComponent).join('/')}`;
const now = () => new Date().toISOString();
function notify() { statusListeners.forEach((listener) => listener()); }
export function onStatusChange(listener) {
  statusListeners.add(listener);
  onSyncChange(listener);
}
export function onCardFieldsChange(listener) { fieldListeners.add(listener); }
export function onCardPromptChange(listener) {
  onCardFieldsChange((card, keys) => { if (keys.includes('prompt')) listener(card); });
}
function contentValues(card) { return { ...card.fields, title: card.title }; }
function editableValues(card) { return { ...contentValues(card), images: card.images, imageRoles: card.imageRoles }; }
function rememberSaved(card) { savedValues.set(card.id, structuredClone(editableValues(card))); }
function changesFor(card) {
  const before = savedValues.get(card.id) ?? {};
  return Object.fromEntries(Object.entries(editableValues(card)).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])));
}
function renewLease(cardId) {
  const card = locateCard(cardId)?.card;
  if (!card) { clearInterval(leaseTimers.get(cardId)); leaseTimers.delete(cardId); return; }
  if (!card.fieldVersions) return;
  const fields = Object.keys(changesFor(card));
  const sequence = (leaseSequences.get(cardId) ?? 0) + 1; leaseSequences.set(cardId, sequence);
  void send('PUT', `${url('cards', cardId)}/draft-lease`, { owner: leaseOwner, fields, sequence }).catch(() => {});
  if (fields.length && !leaseTimers.has(cardId)) {
    const timer = setInterval(() => renewLease(cardId), 1500); timer.unref?.(); leaseTimers.set(cardId, timer);
  } else if (!fields.length) { clearInterval(leaseTimers.get(cardId)); leaseTimers.delete(cardId); }
}
function updateLocalValues(card, values, previousValues) {
  const updated = [];
  for (const [key, value] of Object.entries(values)) {
    const current = key === 'title' ? card.title : card.fields[key];
    // Typing after the request started is newer than the entry action.
    if (current !== previousValues[key] || current === value) continue;
    if (key === 'title') card.title = value;
    else card.fields[key] = value;
    updated.push(key);
  }
  if (updated.length) fieldListeners.forEach((listener) => listener(card, updated));
}
export function saveStatus() {
  const { pending, error } = syncState();
  return {
    error: error || (conflicts.size ? `${conflicts.size} ${conflicts.size === 1 ? 'card has' : 'cards have'} unsaved changes from a conflict. Other cards can still save.` : ''),
    retryable: !!error,
    conflicts: [...conflicts].map(([id, message]) => ({ id, message })),
    saving: !!(pending || [...dirty].some((id) => !conflicts.has(id)) || saveTimer),
    uploading: state.uploads > 0,
  };
}
export function hasUnsavedWork() {
  const status = saveStatus();
  return status.saving || status.uploading || !!status.error;
}

export function project() { return state.projects.find((item) => item.id === state.projectId); }
export function locateCard(targetId = state.cardId) {
  for (const p of state.projects) for (const lane of p.lanes) {
    const card = lane.cards.find((item) => item.id === targetId);
    if (card) return { card, lane, project: p };
  }
  return null;
}
export function cardCount(p) { return p.loaded ? p.lanes.reduce((sum, lane) => sum + lane.cards.length, 0) : p.cardCount; }
export function searchText(card) {
  // Hidden fields such as Prompt are often shared by every card, so they would match everything.
  return [card.title, ...templates[card.template].fields.filter((field) => field.editor !== false).map((field) => card.fields[field.key] || '')].join('\n');
}

const toLane = (stage) => ({ ...stage, cards: [] });
export async function loadWorkspace() {
  const { projects, flows } = await request('/api/workspace');
  state.projects = projects.map((item) => ({ ...item, loaded: false, lanes: flows.find((flow) => flow.id === item.flowId).stages.map(toLane) }));
}
export async function loadCards(projectId) {
  const p = state.projects.find((item) => item.id === projectId);
  if (!p || p.loaded) return;
  const { cards } = await request(`${url('projects', projectId)}/cards`);
  for (const lane of p.lanes) { lane.cards = cards.filter((card) => card.stageId === lane.id); lane.cards.forEach(rememberSaved); }
  p.loaded = true;
}

// Copies server-assigned timestamps onto the local card.
function adopt(card, saved, contentSaved = false) {
  if (!dirty.has(card.id)) card.updatedAt = saved.updatedAt;
  if ('enteredStageAt' in saved) card.enteredStageAt = saved.enteredStageAt;
  // A move acknowledges position, not the local content. Its revision may
  // belong to another tab's content and must never authorize our next edit.
  if (contentSaved) {
    card.revision = saved.revision;
    if (saved.fieldVersions) card.fieldVersions = saved.fieldVersions;
  }
  if (saved.placementVersion) card.placementVersion = saved.placementVersion;
  if ('lastMove' in saved) card.lastMove = saved.lastMove;
  showEdited(card);
}

export function cardChanged(card) {
  card.updatedAt = now();
  showEdited(card);
  dirty.add(card.id);
  renewLease(card.id);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushCards, 450);
  notify();
}
export function flushCards() {
  clearTimeout(saveTimer);
  saveTimer = null;
  for (const cardId of dirty) if (!queuedCards.has(cardId) && !conflicts.has(cardId)) queueCardSave(cardId);
  notify();
}
export function beginCardEditing(cardId) {
  if (!editingSessions.has(cardId)) editingSessions.set(cardId, id());
}
export function endCardEditing(cardId) {
  const editingSessionId = editingSessions.get(cardId);
  if (!editingSessionId) return;
  flushCards();
  editingSessions.delete(cardId);
  enqueue(() => send('POST', `${url('cards', cardId)}/editing-session/end`, { editingSessionId }));
}
function queueCardSave(cardId) {
  const editingSessionId = editingSessions.get(cardId);
  queuedCards.add(cardId);
  enqueue(async () => {
    dirty.delete(cardId);
    const card = locateCard(cardId)?.card;
    if (card) {
      try {
        const changes = changesFor(card);
        const sentValues = structuredClone(editableValues(card));
        const sentVersions = { ...card.fieldVersions };
        const saved = await send('PATCH', url('cards', cardId), card.fieldVersions
          ? { changes, baseVersions: card.fieldVersions, editingSessionId }
          : { revision: card.revision, title: card.title, fields: card.fields, images: card.images, imageRoles: card.imageRoles, editingSessionId });
        const previous = savedValues.get(card.id) ?? {};
        const failed = new Set(saved.conflicts ?? []);
        const acknowledged = editableValues(saved);
        const local = editableValues(card);
        for (const key of Object.keys(acknowledged)) {
          if (!Object.hasOwn(changes, key) && JSON.stringify(local[key]) !== JSON.stringify(sentValues[key])
            && saved.fieldVersions[key] !== sentVersions[key]) failed.add(key);
        }
        for (const [key, value] of Object.entries(acknowledged)) {
          if (failed.has(key)) continue;
          if (JSON.stringify(local[key]) === JSON.stringify(changes[key] ?? previous[key])) {
            if (key === 'title' || key === 'images' || key === 'imageRoles') card[key] = value; else card.fields[key] = value;
            if (JSON.stringify(local[key]) !== JSON.stringify(value)) fieldListeners.forEach((listener) => listener(card, [key]));
          }
          previous[key] = structuredClone(value);
        }
        savedValues.set(card.id, previous);
        const oldVersions = card.fieldVersions;
        adopt(card, saved, true);
        for (const key of failed) card.fieldVersions[key] = oldVersions[key];
        renewLease(card.id);
        if (failed.size) throw Object.assign(new Error(`Unsaved conflicts in ${[...failed].join(', ')}. Your draft has been kept. Load the saved card to resolve.`), { status: 409 });
      } catch (error) {
        if (locateCard(cardId)) dirty.add(cardId);
        throw error;
      }
    }
    queuedCards.delete(cardId);
    // Edits made while this request was in flight still need their own save.
    if (dirty.has(cardId)) flushCards();
  }, (failure) => {
    queuedCards.delete(cardId);
    if (locateCard(cardId)) conflicts.set(cardId, failure.message);
    notify();
  });
}

// Called only after the user agrees to discard this card's local draft.
export async function useSavedCard(cardId) {
  if (state.uploads) throw new Error('Wait for image uploads to finish before loading the saved card.');
  const { card: saved } = await request(url('cards', cardId));
  const card = locateCard(cardId)?.card;
  if (!card) return;
  Object.assign(card, saved);
  rememberSaved(card); renewLease(cardId);
  dirty.delete(cardId);
  conflicts.delete(cardId);
  showEdited(card);
  notify();
}

// Merge incoming agent/tab changes only into fields without local drafts.
export function refreshSavedCard(saved) {
  const found = locateCard(saved.id);
  if (!found || syncState().pending || queuedCards.has(saved.id)) return;
  const { card } = found; const baseline = savedValues.get(card.id);
  if (!baseline || !card.fieldVersions) return;
  const localChanges = changesFor(card); const values = editableValues(saved); const changed = [];
  for (const [key, value] of Object.entries(values)) {
    if (Object.hasOwn(localChanges, key)) continue;
    const before = editableValues(card)[key];
    if (JSON.stringify(before) !== JSON.stringify(value)) {
      if (['title', 'images', 'imageRoles'].includes(key)) card[key] = value; else card.fields[key] = value;
      changed.push(key);
    }
    baseline[key] = structuredClone(value); card.fieldVersions[key] = saved.fieldVersions[key];
  }
  card.revision = saved.revision;
  if (saved.placementVersion !== card.placementVersion) {
    const destination = found.project.lanes.find((lane) => lane.id === saved.stageId);
    if (destination) {
      found.lane.cards = found.lane.cards.filter((c) => c.id !== card.id);
      card.stageId = saved.stageId; card.position = saved.position;
      destination.cards.push(card); destination.cards.sort((a, b) => a.position - b.position);
      changed.push('placement');
    }
  }
  adopt(card, saved);
  if (changed.length) fieldListeners.forEach((listener) => listener(card, changed));
}

export function createCard(lane, p = project()) {
  const at = now();
  const card = { id: id(), projectId: p.id, stageId: lane.id, template: defaultTemplate, title: '', fields: emptyFields(), images: [], imageRoles: emptyImageRoles(), revision: 1, lastMove: null, enteredStageAt: at, createdAt: at, updatedAt: at };
  rememberSaved(card);
  lane.cards.push(card);
  enqueue(async () => {
    const previousValues = contentValues(card);
    const saved = await send('POST', `${url('projects', p.id)}/cards`, { id: card.id, stageId: lane.id, title: card.title, fields: card.fields, images: card.images, imageRoles: card.imageRoles });
    updateLocalValues(card, contentValues(saved), previousValues);
    adopt(card, saved, true);
    savedValues.set(card.id, structuredClone(editableValues(saved))); renewLease(card.id);
  });
  return card;
}

// Moves a card before another card, or to the end of a lane. Returns false
// when the card is already there.
export function moveCard(targetId, laneId, beforeId = null) {
  const source = locateCard(targetId);
  const destination = source?.project.lanes.find((lane) => lane.id === laneId);
  if (!source || !destination || targetId === beforeId || state.undoingCardId === targetId) return false;
  const oldIndex = source.lane.cards.indexOf(source.card);
  source.lane.cards.splice(oldIndex, 1);
  const beforeIndex = destination.cards.findIndex((card) => card.id === beforeId);
  destination.cards.splice(beforeIndex < 0 ? destination.cards.length : beforeIndex, 0, source.card);
  if (source.lane === destination && destination.cards.indexOf(source.card) === oldIndex) return false;
  const { card } = source;
  flushCards();
  card.stageId = laneId;
  card.updatedAt = now();
  showEdited(card);
  enqueue(async () => {
    const previousValues = contentValues(card);
    const result = await send('POST', `${url('cards', card.id)}/transitions`, { action: 'move', toStageId: laneId, beforeCardId: beforeIndex < 0 ? null : beforeId });
    if (result.fieldUpdate) {
      const baseline = savedValues.get(card.id);
      const keys = Object.keys(result.fieldUpdate.values);
      updateLocalValues(card, result.fieldUpdate.values, previousValues);
      for (const key of keys) {
        baseline[key] = result.fieldUpdate.values[key];
        card.fieldVersions[key] = result.card.fieldVersions[key];
      }
      card.revision = result.card.revision;
      renewLease(card.id);
    }
    adopt(card, result.card);
  });
  return true;
}

export function latestMoveCard(p = project()) {
  return p?.lanes.flatMap((lane) => lane.cards).filter((card) => card.lastMove)
    .sort((a, b) => b.lastMove.id - a.lastMove.id)[0] ?? null;
}
export async function undoLastMove(cardId, moveId = locateCard(cardId)?.card.lastMove?.id) {
  if (!moveId) throw new Error('There is no move to undo on this card.');
  if (state.undoingCardId) throw new Error('An undo is already in progress.');
  state.undoingCardId = cardId;
  flushCards();
  try {
    return await enqueue(async () => {
      const found = locateCard(cardId);
      if (!found) throw new Error('This card no longer exists.');
      if (conflicts.has(cardId)) throw new Error('Resolve this card’s save conflict before undoing its move.');
      const { card } = found;
      const previousValues = contentValues(card);
      const result = await send('POST', `${url('cards', cardId)}/undo-move`, { moveId, revision: card.revision, fieldVersions: card.fieldVersions, placementVersion: card.placementVersion });
      const current = locateCard(cardId);
      const destination = current?.project.lanes.find((lane) => lane.id === result.card.stageId);
      if (!current || !destination) return;
      current.lane.cards.splice(current.lane.cards.indexOf(card), 1);
      const index = destination.cards.findIndex((item) => item.id === result.beforeCardId);
      destination.cards.splice(index < 0 ? destination.cards.length : index, 0, card);
      card.stageId = destination.id;
      card.position = result.card.position;
      const versionsBeforeUndo = card.fieldVersions;
      adopt(card, result.card, true);
      card.fieldVersions = { ...versionsBeforeUndo };
      for (const [key, value] of Object.entries(result.fieldUpdate?.values ?? {})) {
        savedValues.get(card.id)[key] = value;
        card.fieldVersions[key] = result.card.fieldVersions[key];
      }
      renewLease(card.id);
      if (result.fieldUpdate) updateLocalValues(card, result.fieldUpdate.values, previousValues);
      return card;
    }, undefined, { rejectOnError: true });
  } finally {
    state.undoingCardId = null;
    notify();
  }
}

export function deleteCard(cardId) {
  const found = locateCard(cardId);
  if (!found) return;
  found.lane.cards = found.lane.cards.filter((card) => card.id !== cardId);
  dirty.delete(cardId);
  conflicts.delete(cardId);
  enqueue(() => send('DELETE', url('cards', cardId)));
}

export function addLane(p, { name, color }) {
  const lane = toLane({ id: id(), flowId: p.flowId, name, color, entryGraph: emptyGraph(), position: p.lanes.length, instructions: '', exitCriteria: [], approveTo: null, sendBackTo: null, automations: [] });
  p.lanes.push(lane);
  enqueue(() => send('POST', `${url('flows', p.flowId)}/stages`, { id: lane.id, name, color }));
}
export function updateLane(p, lane, { name, color, position }) {
  Object.assign(lane, { name, color });
  p.lanes.splice(p.lanes.indexOf(lane), 1);
  p.lanes.splice(position, 0, lane);
  p.lanes.forEach((item, index) => { item.position = index; });
  enqueue(() => send('PATCH', url('stages', lane.id), { name, color, position }));
}
export async function saveLaneGraph(lane, entryGraph) {
  const saved = await enqueue(() => send('PATCH', url('stages', lane.id), { entryGraph }), undefined, { rejectOnError: true });
  Object.assign(lane, { entryGraph: saved.entryGraph, entryPrompt: saved.entryPrompt });
}
export function deleteLane(p, laneId) {
  const lane = p.lanes.find((item) => item.id === laneId);
  lane.cards.forEach((card) => { dirty.delete(card.id); conflicts.delete(card.id); });
  p.lanes = p.lanes.filter((item) => item.id !== laneId);
  enqueue(() => send('DELETE', url('stages', laneId)));
}

// Projects get their default lanes from the server, so creation waits for it.
export async function createProject(name) {
  const { project: created, flow } = await enqueue(() => send('POST', '/api/projects', { id: id(), name }));
  const p = { ...created, loaded: true, lanes: flow.stages.map(toLane) };
  state.projects.push(p);
  return p;
}
export function renameProject(p, name) {
  p.name = name;
  enqueue(() => send('PATCH', url('projects', p.id), { name }));
}
export function deleteProject(p) {
  p.lanes.forEach((lane) => lane.cards.forEach((card) => { dirty.delete(card.id); conflicts.delete(card.id); }));
  state.projects = state.projects.filter((item) => item.id !== p.id);
  enqueue(() => send('DELETE', url('projects', p.id)));
}
export function setProjectPrompt(p, prompt) {
  const cards = p.lanes.flatMap((lane) => lane.cards);
  for (const card of cards) {
    card.fields.prompt = prompt;
    cardChanged(card);
  }
  flushCards();
  return cards.length;
}
