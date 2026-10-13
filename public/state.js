// The browser's copy of the workspace. Changes apply here immediately and are
// queued for the server; card text is saved after a short pause in typing.
import { request, send, enqueue, onSyncChange, syncState, retry } from './api.js';
import { emptyFields, emptyImageRoles, editorFields, normalizeCard, cardContentKeys } from './card-template.js';
import { id, showEdited } from './ui.js';

// `templates` holds the workspace's card template definitions by ID.
// `flowIds` remembers the flow shown for each project, by project ID.
export const state = { projects: [], projectId: null, flowIds: {}, cardId: null, uploads: 0, undoingCardId: null, templates: [] };
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
function editableValues(card) { return { ...contentValues(card), images: card.images, imageRoles: card.imageRoles, library: card.library ?? [] }; }
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
// A project holds one or more flows, each a board of lanes. The board shows
// one flow at a time; a card can move to a lane of any flow in its project.
export function flow(p = project()) { return p?.flows.find((item) => item.id === state.flowIds[p.id]) ?? p?.flows[0] ?? null; }
export const lanesOf = (p) => p.flows.flatMap((item) => item.lanes);
export const flowOfLane = (p, laneId) => p.flows.find((item) => item.lanes.some((lane) => lane.id === laneId)) ?? null;
export function locateCard(targetId = state.cardId) {
  for (const p of state.projects) for (const f of p.flows) for (const lane of f.lanes) {
    const card = lane.cards.find((item) => item.id === targetId);
    if (card) return { card, lane, flow: f, project: p };
  }
  return null;
}
export function cardCount(p) { return p.loaded ? lanesOf(p).reduce((sum, lane) => sum + lane.cards.length, 0) : p.cardCount; }
export const flowCardCount = (f) => f.lanes.reduce((sum, lane) => sum + lane.cards.length, 0);
// Card template definitions come with the workspace. A card keeps the template
// it was created with; a flow names the template for its new cards.
export const templateById = (templateId) => state.templates.find((template) => template.id === templateId) ?? null;
export function templateOf(card) {
  return templateById(card.template) ?? { id: card.template, name: card.template, title: { label: 'Card title', max: 500 }, fields: [], imageRoles: [] };
}
export const flowTemplate = (f = flow()) => templateById(f?.templateId) ?? state.templates[0] ?? null;
export function applyTemplates(templates) {
  state.templates = templates;
  let dropped = false;
  for (const p of state.projects) for (const lane of lanesOf(p)) for (const card of lane.cards) {
    const fields = Object.keys(card.fields); const roles = Object.keys(card.imageRoles);
    const template = templateOf(card);
    Object.assign(card, normalizeCard(template, card));
    // Keys the template gained are not local edits: the server added them
    // to every card with an empty value and field version 1.
    const baseline = savedValues.get(card.id);
    for (const key of Object.keys(card.fields).filter((key) => !fields.includes(key))) {
      if (baseline) baseline[key] = '';
      if (card.fieldVersions) card.fieldVersions[key] ??= 1;
    }
    for (const role of Object.keys(card.imageRoles).filter((role) => !roles.includes(role))) if (baseline?.imageRoles) baseline.imageRoles[role] = null;
    // A field the template dropped has no editor and the server refuses it in
    // any write, so its local copy and any draft in it go. Stored values come
    // back with the key if a template defines it again.
    const gone = templateById(card.template) ? Object.keys(card.fields).filter((key) => !template.fields.some((field) => field.key === key)) : [];
    for (const key of gone) { delete card.fields[key]; if (baseline) delete baseline[key]; }
    if (gone.length) { dropped = true; fieldListeners.forEach((listener) => listener(card, gone)); }
  }
  // A write that carried such a field before this tab heard of the change may be holding the queue.
  if (dropped && syncState().error) retry();
}
export function searchText(card) {
  // Hidden fields such as Prompt are often shared by every card, so they would match everything.
  return [card.title, ...editorFields(templateOf(card)).map((field) => card.fields[field.key] || '')].join('\n');
}

const toLane = (stage) => ({ ...stage, cards: [] });
const toFlow = ({ stages, ...rest }) => ({ ...rest, lanes: stages.map(toLane) });
export async function loadWorkspace() {
  const { projects, flows, templates } = await request('/api/workspace');
  state.templates = templates ?? [];
  state.projects = projects.map(({ flowId, ...item }) => ({ ...item, loaded: false, flows: flows.filter((entry) => entry.projectId === item.id).map(toFlow) }));
}
export const loadTemplates = async () => applyTemplates((await request('/api/templates')).templates);
export async function loadCards(projectId) {
  const p = state.projects.find((item) => item.id === projectId);
  if (!p || p.loaded) return;
  const { cards } = await request(`${url('projects', projectId)}/cards`);
  for (const lane of lanesOf(p)) { lane.cards = cards.filter((card) => card.stageId === lane.id); lane.cards.forEach(rememberSaved); }
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
          : { revision: card.revision, title: card.title, fields: card.fields, images: card.images, imageRoles: card.imageRoles, library: card.library ?? [], editingSessionId });
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
            if (cardContentKeys.includes(key)) card[key] = value; else card.fields[key] = value;
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
      if (cardContentKeys.includes(key)) card[key] = value; else card.fields[key] = value;
      changed.push(key);
    }
    baseline[key] = structuredClone(value); card.fieldVersions[key] = saved.fieldVersions[key];
  }
  card.revision = saved.revision;
  if (saved.placementVersion !== card.placementVersion) {
    const destination = lanesOf(found.project).find((lane) => lane.id === saved.stageId);
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
  const template = flowTemplate(flowOfLane(p, lane.id));
  const card = { id: id(), projectId: p.id, stageId: lane.id, template: template.id, title: '', fields: emptyFields(template), images: [], imageRoles: emptyImageRoles(template), library: [], revision: 1, lastMove: null, enteredStageAt: at, createdAt: at, updatedAt: at };
  rememberSaved(card);
  lane.cards.push(card);
  enqueue(async () => {
    const previousValues = contentValues(card);
    const saved = await send('POST', `${url('projects', p.id)}/cards`, { id: card.id, stageId: lane.id, template: card.template, title: card.title, fields: card.fields, images: card.images, imageRoles: card.imageRoles });
    updateLocalValues(card, contentValues(saved), previousValues);
    adopt(card, saved, true);
    savedValues.set(card.id, structuredClone(editableValues(saved))); renewLease(card.id);
  });
  return card;
}

// Moves a card before another card, or to the end of a lane, which may be in
// another flow of its project. Returns false when the card is already there.
export function moveCard(targetId, laneId, beforeId = null) {
  const source = locateCard(targetId);
  const destination = source && lanesOf(source.project).find((lane) => lane.id === laneId);
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

// Across the whole project, so a move to another flow can be undone from where it started.
export function latestMoveCard(p = project()) {
  return (p ? lanesOf(p) : []).flatMap((lane) => lane.cards).filter((card) => card.lastMove)
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
      const destination = current && lanesOf(current.project).find((lane) => lane.id === result.card.stageId);
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

// Lanes belong to a flow; `f` is a flow from a project's `flows`.
export function addLane(f, { name, color }) {
  const lane = toLane({ id: id(), flowId: f.id, name, color, playbook: null, position: f.lanes.length, instructions: '', exitCriteria: [], approveTo: null, sendBackTo: null, automations: [] });
  f.lanes.push(lane);
  enqueue(() => send('POST', `${url('flows', f.id)}/stages`, { id: lane.id, name, color }));
}
export function updateLane(f, lane, { name, color, position }) {
  Object.assign(lane, { name, color });
  f.lanes.splice(f.lanes.indexOf(lane), 1);
  f.lanes.splice(position, 0, lane);
  f.lanes.forEach((item, index) => { item.position = index; });
  enqueue(() => send('PATCH', url('stages', lane.id), { name, color, position }));
}
// Lane playbooks, the flow map and skills are files on the server, one folder
// per flow. Saves queue behind earlier writes (a new lane exists before its
// playbook) and carry the hash they were based on, so newer edits on disk are
// not lost.
export function applyStages(f, stages) {
  for (const stage of stages) {
    const lane = f.lanes.find((item) => item.id === stage.id);
    if (lane) lane.playbook = stage.playbook;
  }
}
export const loadPlaybooks = (f) => request(`${url('flows', f.id)}/playbooks`);
export async function savePlaybook(f, path, text, baseHash) {
  const saved = await enqueue(() => send('PUT', `${url('flows', f.id)}/playbooks`, { path, text, baseHash }), undefined, { rejectOnError: true });
  applyStages(f, saved.stages);
  return saved.document;
}
export async function deletePlaybook(f, path, baseHash) {
  const saved = await enqueue(() => send('DELETE', `${url('flows', f.id)}/playbooks`, { path, baseHash }), undefined, { rejectOnError: true });
  applyStages(f, saved.stages);
}
export const laneRuns = (cardId) => request(`${url('cards', cardId)}/lane-runs`);
export const runPlaybook = (cardId) => enqueue(() => send('POST', `${url('cards', cardId)}/lane-runs`, {}), undefined, { rejectOnError: true });
export const previewLaneRun = (cardId) => request(`${url('cards', cardId)}/lane-runs/preview`);
// How a playbook draft's Library sources resolve in its flow's project, and the Library to choose from.
export const checkPlaybookAssets = (f, keys) => request(`${url('flows', f.id)}/playbooks/assets?${new URLSearchParams({ sources: keys.join(',') })}`);
export const loadLibraryListing = (p) => request(`${url('projects', p.id)}/library`);
export const loadNotes = (cardId) => request(`${url('cards', cardId)}/notes`);
export const saveNotes = (cardId, text, baseHash) => enqueue(() => send('PUT', `${url('cards', cardId)}/notes`, { text, baseHash }), undefined, { rejectOnError: true });
function forgetCards(lanes) {
  lanes.forEach((lane) => lane.cards.forEach((card) => { dirty.delete(card.id); conflicts.delete(card.id); }));
}
export function deleteLane(f, laneId) {
  forgetCards(f.lanes.filter((item) => item.id === laneId));
  f.lanes = f.lanes.filter((item) => item.id !== laneId);
  enqueue(() => send('DELETE', url('stages', laneId)));
}

// Projects and flows get their default lanes from the server, so creation waits for it.
export async function createProject(name, templateId = undefined) {
  const { project: { flowId, ...created }, flow: first } = await enqueue(() => send('POST', '/api/projects', { id: id(), name, ...(templateId ? { templateId } : {}) }));
  const p = { ...created, loaded: true, flows: [toFlow(first)] };
  state.projects.push(p);
  return p;
}
export function renameProject(p, name) {
  p.name = name;
  enqueue(() => send('PATCH', url('projects', p.id), { name }));
}
export function selectFlow(p, flowId) {
  state.flowIds[p.id] = flowId;
  try { localStorage.setItem('frameboard-flows', JSON.stringify(state.flowIds)); } catch { /* Optional preference. */ }
}
export function restoreFlowSelection() {
  try { Object.assign(state.flowIds, JSON.parse(localStorage.getItem('frameboard-flows') || '{}')); } catch { /* Optional preference. */ }
}
export async function createFlow(p, name, templateId = undefined) {
  const created = await enqueue(() => send('POST', `${url('projects', p.id)}/flows`, { id: id(), name, ...(templateId ? { templateId } : {}) }), undefined, { rejectOnError: true });
  // The change feed may have added it already.
  const f = p.flows.find((item) => item.id === created.id) ?? toFlow(created);
  if (!p.flows.includes(f)) p.flows.push(f);
  return f;
}
// A flow's name, its place among the project's flows, and the template its
// new cards use. Existing cards keep their template.
export function updateFlow(p, f, { name = f.name, templateId = f.templateId, position = p.flows.indexOf(f) }) {
  const changes = { ...(name !== f.name ? { name } : {}), ...(templateId !== f.templateId ? { templateId } : {}), ...(position !== p.flows.indexOf(f) ? { position } : {}) };
  if (!Object.keys(changes).length) return;
  Object.assign(f, { name, templateId });
  p.flows.splice(p.flows.indexOf(f), 1);
  p.flows.splice(position, 0, f);
  p.flows.forEach((item, index) => { item.position = index; });
  enqueue(() => send('PATCH', url('flows', f.id), changes));
}
// Deleting a flow deletes its cards; the server keeps at least one flow.
export async function deleteFlow(p, f) {
  await enqueue(() => send('DELETE', url('flows', f.id)), undefined, { rejectOnError: true });
  forgetFlow(p, f);
}
// Drops a deleted flow and any unsaved state of its cards, here or after another tab deleted it.
export function forgetFlow(p, f) {
  forgetCards(f.lanes);
  p.flows = p.flows.filter((item) => item !== f);
}
// Card templates are workspace settings, independent of card writes, so they
// are sent directly rather than queued behind a card save that may be failing.
export const createTemplate = async (input) => { const created = await send('POST', '/api/templates', input); await loadTemplates(); return created; };
export const updateTemplate = async (templateId, input) => { const updated = await send('PATCH', url('templates', templateId), input); await loadTemplates(); return updated; };
export const deleteTemplate = async (templateId) => { await send('DELETE', url('templates', templateId)); await loadTemplates(); };
// Archive and unarchive wait for the server: archiving cancels the project's
// work there, and the board then shows the project read-only.
export async function archiveProject(p) {
  const { archivedAt } = await enqueue(() => send('POST', `${url('projects', p.id)}/archive`, {}), undefined, { rejectOnError: true });
  p.archivedAt = archivedAt;
}
export async function unarchiveProject(p) {
  const { archivedAt } = await enqueue(() => send('POST', `${url('projects', p.id)}/unarchive`, {}), undefined, { rejectOnError: true });
  p.archivedAt = archivedAt;
}
export function deleteProject(p) {
  forgetCards(lanesOf(p));
  state.projects = state.projects.filter((item) => item.id !== p.id);
  enqueue(() => send('DELETE', url('projects', p.id)));
}
// Only cards whose template has a Prompt field take the shared prompt.
export const hasPromptField = (card) => templateOf(card).fields.some((field) => field.key === 'prompt');
export const promptLimit = (card) => templateOf(card).fields.find((field) => field.key === 'prompt')?.max ?? null;
// Throws before any card changes when the prompt is too long for one of them.
export function setProjectPrompt(p, prompt) {
  const cards = lanesOf(p).flatMap((lane) => lane.cards).filter(hasPromptField);
  for (const card of cards) if (prompt.length > promptLimit(card)) throw new Error(`Prompts for “${templateOf(card).name}” cards can be up to ${promptLimit(card).toLocaleString()} characters. Nothing was changed.`);
  for (const card of cards) {
    card.fields.prompt = prompt;
    cardChanged(card);
  }
  flushCards();
  return cards.length;
}
