import { $, escape, toast, smallForm } from './ui.js';
import { request, send, enqueue } from './api.js';
import { state, locateCard, flushCards, saveStatus } from './state.js';
import { contextFields } from './chat-context.js';

const chats = new Map();
let selected = null; let navigation; let activity = []; let pollTimer; let polling = false;
let hidden = preference('frameboard-chat-hidden') === 'true';
function preference(key, value) {
  try { if (value !== undefined) localStorage.setItem(key, value); return localStorage.getItem(key); } catch { return null; }
}
const url = (id, action = '') => `/api/cards/${encodeURIComponent(id)}/chat${action ? `/${action}` : ''}`;
const labels = { 'input-needed': '? Input needed', 'needs-attention': '! Needs attention', working: '◌ Working', done: '✓ Done' };
export function activityMarkup(cardId) {
  const entry = activity.find((entry) => entry.cardId === cardId);
  if (!entry) return '';
  const elapsed = entry.state === 'working' && entry.startedAt ? ` · ${Math.max(0, Math.floor((Date.now() - Date.parse(entry.startedAt)) / 1000))}s` : '';
  return `<span class="chat-activity ${entry.state}">${labels[entry.state]}${elapsed}</span>`;
}
function rememberView() {
  const item = chats.get(selected);
  if (!item) return;
  item.view.scroll = $('#chat-transcript')?.scrollTop ?? item.view.scroll;
  item.view.editorScroll = $('.editor-content')?.scrollTop ?? item.view.editorScroll;
  item.view.preview = $('#chat-context-preview')?.open ?? item.view.preview;
  preference(`frameboard-chat-view:${selected}`, JSON.stringify(item.view));
}
function newItem(id) {
  let view; let pending;
  try { view = JSON.parse(preference(`frameboard-chat-view:${id}`)); pending = JSON.parse(preference(`frameboard-chat-send:${id}`)); } catch { /* Optional browser view state. */ }
  return { id, snapshot: null, composer: null, dirty: false, version: 0, view: { tab: 'editor', scroll: 0, editorScroll: 0, preview: false, ...view },
    pending, sending: false, models: [], error: '', timer: null, saving: null };
}
function active(item) { return item.snapshot?.attempts.some((attempt) => ['dispatching', 'accepted', 'running', 'interrupt-requested'].includes(attempt.status)); }
function updateComposerControls(item) {
  if (selected !== item.id || !$('#chat-prompt')) return;
  const locked = item.sending || Boolean(item.pending);
  document.querySelectorAll('#chat-composer input, #chat-composer textarea').forEach((input) => { input.disabled = locked; });
  $('#chat-model').disabled = locked || active(item);
  $('[data-action="chat-send"]').disabled = item.sending;
  $('[data-action="chat-stop"]').disabled = !active(item);
  $('[data-action="chat-fresh"]').disabled = active(item);
}
function applyLayout() {
  const dialog = $('#card-dialog'); if (!dialog?.open) return;
  dialog.classList.toggle('with-chat', !hidden);
  document.body.classList.toggle('workbench-open', !hidden);
  dialog.classList.toggle('chat-tab', !hidden && chats.get(selected)?.view.tab === 'chat');
  const panel = $('#card-chat'); if (panel) panel.hidden = hidden;
  const handle = $('#chat-resizer'); if (handle) handle.hidden = hidden;
  const toggle = $('[data-action="toggle-chat"]');
  if (toggle) { toggle.textContent = hidden ? 'Show chat' : 'Hide chat'; toggle.setAttribute('aria-expanded', String(!hidden)); }
  const width = Number(preference('frameboard-chat-width'));
  if (width) dialog.style.setProperty('--chat-width', `${Math.max(300, Math.min(width, dialog.clientWidth - 520))}px`);
  const tabs = $('.workbench-tabs'); if (tabs) tabs.hidden = hidden;
  document.querySelectorAll('[data-action="workbench-tab"]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.tab === chats.get(selected)?.view.tab)));
}
function setDialogMode() {
  const dialog = $('#card-dialog');
  // Visible workbenches allow choosing a different card on the board. Hidden
  // chats return to the established modal editor. Reopen synchronously so its
  // asynchronous close event cannot discard the selected card.
  if (dialog.open) dialog.close();
  if (hidden) dialog.showModal(); else dialog.show();
  applyLayout();
}
export function mountChat(cardId) {
  rememberView(); selected = cardId;
  if (!chats.has(cardId)) chats.set(cardId, newItem(cardId));
  const item = chats.get(cardId);
  const dialog = $('#card-dialog');
  const editor = document.createElement('div'); editor.id = 'card-editor-pane';
  while (dialog.firstChild) editor.append(dialog.firstChild);
  dialog.append(editor);
  dialog.insertAdjacentHTML('afterbegin', `<div class="workbench-tabs" role="tablist" aria-label="Card workbench"><button role="tab" data-action="workbench-tab" data-tab="editor">Editor</button><button role="tab" data-action="workbench-tab" data-tab="chat">Chat</button></div>`);
  dialog.insertAdjacentHTML('beforeend', `<div id="chat-resizer" role="separator" tabindex="0" aria-label="Resize chat" aria-orientation="vertical"></div><aside id="card-chat" aria-label="Card chat"><div class="chat-header"><div><h2>Card chat</h2><span>Codex · Current conversation</span></div><button class="button small secondary" data-action="chat-fresh">Start fresh context</button></div><div id="chat-error" role="alert" hidden></div><div id="chat-transcript" class="chat-transcript" aria-label="Conversation history"></div><div id="chat-requests"></div><div id="chat-composer" class="chat-composer"></div></aside>`);
  $('.editor-header-right').insertAdjacentHTML('afterbegin', '<button class="button small secondary" data-action="toggle-chat" aria-expanded="true">Hide chat</button>');
  setDialogMode();
  if (item.snapshot) { renderComposer(item); renderTranscript(item); }
  else $('#chat-transcript').textContent = 'Loading saved conversation…';
  void refresh(item).catch((error) => showError(item, error));
  wireResize();
  $('#chat-transcript').addEventListener('scroll', rememberView, { passive: true });
  $('.editor-content').scrollTop = item.view.editorScroll;
}
export function unmountChat() { rememberView(); selected = null; document.body.classList.remove('workbench-open'); }
export function hasUnsentChatChanges() { return [...chats.values()].some((item) => item.dirty || item.saving || item.sending || item.pending); }
export function flushComposers() { for (const item of chats.values()) if (item.dirty) void saveComposer(item).catch((error) => showError(item, error)); }
function showError(item, error) {
  item.error = error.message;
  item.errorStatus = error.status;
  if (selected === item.id && $('#chat-error')) {
    $('#chat-error').hidden = false;
    $('#chat-error').innerHTML = `<span>${escape(item.error)}</span>${item.dirty ? '<div><button class="button small secondary" data-action="chat-save-draft">Retry draft save</button><button class="button small secondary" data-action="chat-load-draft">Use saved draft</button></div>' : ''}`;
  }
}
async function saveComposer(item) {
  clearTimeout(item.timer);
  if (item.saving) return item.saving;
  item.saving = (async () => {
    while (item.dirty) {
      const version = item.version;
      const saved = await send('PUT', url(item.id, 'composer'), structuredClone(item.composer));
      item.composer.revision = saved.revision;
      if (version === item.version) item.dirty = false;
    }
  })();
  try { await item.saving; } finally { item.saving = null; }
}
function composerChanged(item) {
  item.version++; item.dirty = true;
  clearTimeout(item.timer);
  item.timer = setTimeout(() => void saveComposer(item).then(() => refreshPreview(item)).catch((error) => showError(item, error)), 450);
}
async function refresh(item) {
  const version = item.version;
  const snapshot = await request(url(item.id));
  item.snapshot = snapshot;
  if (item.errorStatus === 404) { item.error = ''; item.errorStatus = null; if (selected === item.id && $('#chat-error')) $('#chat-error').hidden = true; }
  if (item.pending && snapshot.submissions.some((submission) => submission.id === item.pending.id)) {
    item.pending = null; preference(`frameboard-chat-send:${item.id}`, 'null');
  }
  let changed = false;
  if (!item.dirty && !item.saving && !item.sending && version === item.version
    && (!item.composer || snapshot.composer.revision >= item.composer.revision)) {
    changed = JSON.stringify(item.composer) !== JSON.stringify(snapshot.composer);
    item.composer = snapshot.composer;
  }
  if (selected !== item.id || !$('#card-chat')) return;
  if (!$('#chat-prompt') || changed || item.gallerySignature !== JSON.stringify(locateCard(item.id)?.card.images)) renderComposer(item);
  renderTranscript(item);
  updateComposerControls(item);
  if (item.view.preview) void refreshPreview(item);
  if (!hidden && (item.view.tab === 'chat' || matchMedia('(min-width: 1180px)').matches) && !document.hidden) await send('POST', url(item.id, 'viewed'), {});
}
function renderComposer(item) {
  if (!item.composer) return;
  const card = locateCard(item.id)?.card; if (!card) return;
  const composer = item.composer;
  const focused = $('#chat-composer').contains(document.activeElement) ? document.activeElement : null;
  const focusId = focused?.id;
  const selection = focused?.tagName === 'TEXTAREA' ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
  item.gallerySignature = JSON.stringify(card.images);
  const images = [...card.images, ...composer.selections.images.filter((id) => !card.images.some((image) => image.id === id))
    .map((id) => ({ id, name: 'Unavailable reference (removed from gallery)' }))];
  const choices = item.models.length ? item.models : composer.model ? [{ id: composer.model, displayName: composer.model }] : [];
  $('#chat-composer').innerHTML = `<div class="chat-model-row"><label for="chat-model">Model</label><select id="chat-model" ${active(item) ? 'disabled' : ''}><option value="">Choose a model…</option>${choices.map((model) => `<option value="${escape(model.id)}" ${composer.model === model.id ? 'selected' : ''}>${escape(model.displayName)}</option>`).join('')}</select><button class="button small secondary" data-action="chat-discover">Discover</button></div>
    <details id="chat-context-preview" ${item.view.preview ? 'open' : ''}><summary>What will be sent</summary><p class="chat-hint">Saved card values at Send. Images are attached once with all selected labels.</p><fieldset class="chat-selections"><legend>Card fields</legend>${contextFields(card.template).map((field) => `<label><input type="checkbox" data-chat-field="${field.key}" ${composer.selections.fields.includes(field.key) ? 'checked' : ''}>${escape(field.label)}</label>`).join('')}</fieldset><fieldset class="chat-selections"><legend>Image references</legend>${[['original', 'Original'], ['inspiration', 'Inspiration'], ['cover', 'Display']].map(([role, label]) => `<label><input type="checkbox" data-chat-role="${role}" ${composer.selections.roles.includes(role) ? 'checked' : ''}>${label}</label>`).join('')}${images.map((image) => `<label><input type="checkbox" data-chat-image="${image.id}" ${composer.selections.images.includes(image.id) ? 'checked' : ''}>${escape(image.name)}</label>`).join('')}</fieldset><div id="chat-exact-preview"></div></details>
    <label class="sr-only" for="chat-prompt">Prompt for this card</label><textarea id="chat-prompt" maxlength="200000" placeholder="Ask about this card…" ${item.pending ? 'disabled' : ''}>${escape(composer.prompt)}</textarea><div class="chat-send-row"><span id="chat-save-state">${item.dirty ? 'Saving draft…' : 'Draft saved'}</span><button class="button small secondary" data-action="chat-stop" ${active(item) ? '' : 'disabled'}>Stop</button><button class="button primary" data-action="chat-send">${item.pending ? 'Retry Send' : 'Send'}</button></div><p class="chat-hint">Codex uses workspace-write / on-request. Reads outside the workspace are possible. <a href="/codex.html" target="_blank" rel="noopener">Configuration and permission limits</a></p>`;
  $('#chat-context-preview').addEventListener('toggle', () => { rememberView(); if ($('#chat-context-preview').open) void refreshPreview(item); });
  if (item.view.preview) void refreshPreview(item);
  updateComposerControls(item);
  if (focusId) { const input = document.getElementById(focusId); input?.focus(); if (selection) input?.setSelectionRange(...selection); }
}
function contextMarkup(context) {
  return `${context.fields.map((field) => `<p><strong>${escape(field.label)} <small>v${field.version}</small></strong><br>${escape(field.value)}</p>`).join('')}${context.images.map((image) => `<figure><img src="/images/${encodeURIComponent(image.id)}" alt="${escape(image.name)}"><figcaption>${escape(image.labels.join(', '))}: ${escape(image.name)}<br><small>Version ${escape(image.id)} · SHA-256 ${escape(image.hash)}</small></figcaption></figure>`).join('')}`;
}
function frozenMarkup(submission) {
  return `<details class="chat-frozen"><summary>Submitted context · ${escape(submission.model)}</summary><p>${escape(submission.prompt)}</p>${contextMarkup(submission.context)}<small>Configuration ${escape(submission.configuration.id)}</small></details>`;
}
async function refreshPreview(item) {
  if (selected !== item.id || !$('#chat-context-preview')?.open || item.dirty || item.saving) return;
  try {
    const preview = await send('POST', url(item.id, 'preview'), {});
    if (selected !== item.id || !$('#chat-exact-preview')) return;
    $('#chat-exact-preview').innerHTML = contextMarkup(preview.context);
  } catch (error) { showError(item, error); }
}
function renderTranscript(item) {
  const timeline = $('#chat-transcript'); if (!timeline || !item.snapshot) return;
  const nearEnd = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 32;
  const scroll = timeline.scrollTop || item.view.scroll;
  const snapshot = item.snapshot;
  const html = snapshot.conversations.map((conversation) => {
    const submissions = snapshot.submissions.filter((submission) => submission.conversationId === conversation.id);
    return `<div class="chat-divider">${conversation.state === 'previous' ? 'Previous conversation' : conversation.state === 'native-unavailable' ? 'Native context unavailable · history retained' : 'Current conversation'}</div>${submissions.map((submission) => {
      const attempts = snapshot.attempts.filter((attempt) => attempt.submissionId === submission.id);
      return `<article class="chat-submission"><div class="chat-prompt-sent">${escape(submission.prompt)}</div>${frozenMarkup(submission)}<p class="chat-status">${escape(submission.status)}${submission.reason ? ` · ${escape(submission.reason)}` : ''}</p>${attempts.map((attempt) => `${attempt.previousAttemptId ? '<div class="chat-divider">Retry · original inputs retained</div>' : ''}${snapshot.items.filter((entry) => entry.attemptId === attempt.id).map((entry) => `<div class="chat-item ${entry.kind === 'notice' ? 'chat-notice' : ''}">${escape(entry.text || ({ imageGeneration: 'Image output retained; image import and adoption are a later milestone.', dynamicToolCall: 'Tool result', commandExecution: 'Command execution' }[entry.kind] ?? entry.kind))}${!entry.completed && entry.kind === 'agentMessage' ? '<small>Partial response</small>' : ''}</div>`).join('')}`).join('')}${['queued', 'held'].includes(submission.status) ? `<button class="button small secondary" data-action="chat-cancel" data-id="${escape(submission.id)}">Cancel submission</button>` : ''}${['failed', 'interrupted'].includes(submission.status) && conversation.state === 'active' ? `<button class="button small secondary" data-action="chat-retry" data-id="${escape(submission.id)}">Retry original submission</button>` : ''}</article>`;
    }).join('')}`;
  }).join('');
  if (timeline.dataset.rendered !== html) {
    const openDetails = [...timeline.querySelectorAll('details[open]')].map((node) => [...timeline.querySelectorAll('details')].indexOf(node));
    timeline.innerHTML = html || '<p class="chat-empty">Send a prompt to start this card’s conversation.</p>';
    timeline.dataset.rendered = html;
    openDetails.forEach((index) => { const node = timeline.querySelectorAll('details')[index]; if (node) node.open = true; });
    timeline.scrollTop = nearEnd && !item.view.scroll ? timeline.scrollHeight : scroll;
  }
  $('#chat-requests').innerHTML = snapshot.requests.filter((request) => request.status === 'pending').map((request) => `<div class="chat-request"><strong>? Input needed</strong><p>${escape(request.params.command ?? request.method)}</p>${/item\/(commandExecution|fileChange)\/requestApproval$/.test(request.method) ? `<button class="button small secondary" data-action="chat-answer" data-id="${escape(request.id)}" data-decision="accept">Allow once</button><button class="button small secondary" data-action="chat-answer" data-id="${escape(request.id)}" data-decision="decline">Deny</button>` : '<p>Stop to cancel this request. Additional input controls are not available yet.</p>'}</div>`).join('');
  if ($('#chat-save-state')) $('#chat-save-state').textContent = item.dirty || item.saving ? 'Saving draft…' : 'Draft saved';
}
async function sendPrompt(item) {
  if (item.sending) return;
  item.sending = true; updateComposerControls(item);
  try {
    flushCards(); await enqueue(() => Promise.resolve());
    if (saveStatus().error) throw new Error('Resolve the card save before sending its context.');
    await saveComposer(item);
    if (!item.pending) item.pending = { id: crypto.randomUUID(), composerRevision: item.composer.revision };
    preference(`frameboard-chat-send:${item.id}`, JSON.stringify(item.pending));
    const submission = await send('POST', url(item.id, 'submissions'), item.pending);
    item.pending = null; preference(`frameboard-chat-send:${item.id}`, 'null');
    item.error = ''; if (selected === item.id) $('#chat-error').hidden = true;
    // Queue clearing and composer revision are read from the authoritative
    // snapshot. No later draft is erased by retrying the browser submission ID.
    item.composer = null;
    item.sending = false;
    await refresh(item);
    if (selected === item.id) { renderComposer(item); $('#chat-prompt')?.focus(); }
    return submission;
  } catch (error) {
    // A definite rejection made no submission. Network/5xx ambiguity retains
    // the browser ID for a deduplicated retry, including across reload.
    if (error.status && (error.status < 500 || error.status === 503)) { item.pending = null; preference(`frameboard-chat-send:${item.id}`, 'null'); }
    showError(item, error);
    if (selected === item.id) renderComposer(item);
  } finally { item.sending = false; updateComposerControls(item); }
}
function wireResize() {
  const handle = $('#chat-resizer');
  const resize = (width) => {
    const max = Math.max(300, $('#card-dialog').clientWidth - 520);
    const value = Math.round(Math.max(300, Math.min(max, width)));
    $('#card-dialog').style.setProperty('--chat-width', `${value}px`); preference('frameboard-chat-width', String(value));
  };
  handle.addEventListener('pointerdown', (event) => {
    handle.setPointerCapture(event.pointerId);
    const move = (event) => resize($('#card-dialog').getBoundingClientRect().right - event.clientX);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', () => handle.removeEventListener('pointermove', move), { once: true });
  });
  handle.addEventListener('keydown', (event) => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); resize($('#card-chat').clientWidth + (event.key === 'ArrowLeft' ? 20 : -20)); } });
}
async function poll() {
  if (polling) return; polling = true;
  try {
    const next = (await request('/api/chat-activity')).entries;
    if (JSON.stringify(next) !== JSON.stringify(activity)) { activity = next; navigation?.renderBoard(); renderActivityList(); }
    const item = chats.get(selected); if (item) await refresh(item);
  } catch (error) { const item = chats.get(selected); if (item) showError(item, error); }
  finally { polling = false; }
}
function renderActivityList() {
  const list = $('#chat-activity-list'); if (!list) return;
  list.innerHTML = activity.length ? activity.map((entry) => `<button class="chat-activity-entry" data-action="chat-activity-card" data-id="${entry.cardId}" data-project="${entry.projectId}" ${entry.deleted ? 'disabled' : ''}><strong>${escape(entry.title || 'Untitled card')}${entry.deleted ? ' (deleted)' : ''}</strong><span>${labels[entry.state]}</span></button>`).join('') : '<p>No active card chats.</p>';
}
export function initializeChats(callbacks) {
  navigation = callbacks; clearInterval(pollTimer); pollTimer = setInterval(() => void poll(), 800);
  document.addEventListener('input', (event) => {
    if (event.target.id !== 'chat-prompt') return;
    const item = chats.get(selected); if (!item?.composer) return;
    item.composer.prompt = event.target.value; composerChanged(item);
  });
  document.addEventListener('change', (event) => {
    const item = chats.get(selected); if (!item?.composer) return;
    const target = event.target;
    if (target.id === 'chat-model') { item.composer.model = target.value || null; composerChanged(item); return; }
    for (const [attribute, key] of [['chatField', 'fields'], ['chatRole', 'roles'], ['chatImage', 'images']]) if (target.dataset[attribute]) {
      const set = new Set(item.composer.selections[key]);
      if (target.checked) set.add(target.dataset[attribute]); else set.delete(target.dataset[attribute]);
      item.composer.selections[key] = [...set]; composerChanged(item);
    }
  });
  document.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]'); if (!target) return;
    const item = chats.get(selected); const action = target.dataset.action;
    try {
      if (action === 'workspace-chat-activity') { const list = $('#chat-activity-list'); list.hidden = !list.hidden; renderActivityList(); }
      if (action === 'chat-activity-card') { await navigation.switchProject(target.dataset.project); navigation.openCard(target.dataset.id); }
      if (!item) return;
      if (action === 'toggle-chat') { rememberView(); hidden = !hidden; preference('frameboard-chat-hidden', String(hidden)); setDialogMode(); }
      if (action === 'workbench-tab') { rememberView(); item.view.tab = target.dataset.tab; applyLayout(); rememberView(); }
      if (action === 'chat-send') await sendPrompt(item);
      if (action === 'chat-save-draft') { await saveComposer(item); item.error = ''; $('#chat-error').hidden = true; await refresh(item); }
      if (action === 'chat-load-draft') smallForm({ title: 'Use the saved composer?', description: 'Discard this card’s local unsent prompt and reference selections. Copy anything you want to keep first. Other card drafts and running responses are unaffected.', submit: 'Use saved draft', onSubmit: async () => {
        if (item.saving) await item.saving.catch(() => {});
        clearTimeout(item.timer); item.version++; item.dirty = false;
        item.composer = (await request(url(item.id))).composer;
        item.error = ''; if (selected === item.id) { $('#chat-error').hidden = true; renderComposer(item); }
      } });
      if (action === 'chat-discover') {
        target.disabled = true;
        const result = await send('POST', url(item.id, 'discover'), {});
        item.models = result.discovery.models;
        if (selected === item.id) renderComposer(item);
        if (!result.effective.supported) showError(item, new Error(result.effective.reasons.join(' ')));
      }
      if (action === 'chat-stop') { await send('POST', url(item.id, 'stop'), {}); await refresh(item); }
      if (action === 'chat-cancel' || action === 'chat-retry') { await send('POST', url(item.id, action === 'chat-cancel' ? 'cancel' : 'retry'), { submissionId: target.dataset.id }); await refresh(item); }
      if (action === 'chat-answer') { await send('POST', url(item.id, 'answer'), { requestId: target.dataset.id, response: { decision: target.dataset.decision } }); await refresh(item); }
      if (action === 'chat-fresh') smallForm({ title: 'Start empty fresh context?', description: 'Retain this conversation as previous history and reset its permissions. Cancel any queued or held submissions for the old conversation. No native conversation or turn starts until Send.', submit: 'Start fresh and cancel queued work', onSubmit: async () => { await saveComposer(item); item.snapshot = await send('POST', url(item.id, 'fresh'), { cancelQueued: true }); renderTranscript(item); } });
    } catch (error) { if (item) showError(item, error); else toast(error.message); }
    finally { if (action === 'chat-discover' && target.isConnected) target.disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { rememberView(); flushComposers(); } });
  void poll();
}
