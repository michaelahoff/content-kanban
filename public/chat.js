import { $, escape, toast, smallForm } from './ui.js';
import { request, send, enqueue } from './api.js';
import { state, locateCard, flushCards, saveStatus, refreshSavedCard } from './state.js';
import { contextFields } from './chat-context.js';

const chats = new Map();
let selected = null; let navigation; let activity = []; let events = null; let activityTimer = null; let refreshTimer = null; let clockTimer;
let hidden = preference('frameboard-chat-hidden') === 'true';
function preference(key, value) {
  try { if (value !== undefined) localStorage.setItem(key, value); return localStorage.getItem(key); } catch { return null; }
}
const url = (id, action = '') => `/api/cards/${encodeURIComponent(id)}/chat${action ? `/${action}` : ''}`;
const labels = { 'input-needed': '? Input needed', 'needs-attention': '! Needs attention', working: '◌ Working', done: '✓ Done' };
// The timer counts wall-clock time from the server's attempt start.
function activityLabel(entry) {
  if (entry.state !== 'working') return labels[entry.state];
  if (entry.waitingForProvider) return `${labels.working} · waiting for provider`;
  return entry.startedAt ? `${labels.working} · ${Math.max(0, Math.floor((Date.now() - Date.parse(entry.startedAt)) / 1000))}s` : labels.working;
}
export function activityMarkup(cardId) {
  const entry = activity.find((entry) => entry.cardId === cardId);
  if (!entry) return '';
  return `<span class="chat-activity ${entry.state}" data-activity-card="${escape(entry.cardId)}">${escape(activityLabel(entry))}</span>`;
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
  dialog.insertAdjacentHTML('beforeend', `<div id="chat-resizer" role="separator" tabindex="0" aria-label="Resize chat" aria-orientation="vertical"></div><aside id="card-chat" aria-label="Card chat"><div class="chat-header"><div><h2>Card chat</h2><span>Codex · Current conversation</span></div><button class="button small secondary" data-action="chat-fresh">Start fresh context</button></div><div id="chat-error" role="alert" hidden></div><div id="chat-transcript" class="chat-transcript" aria-label="Conversation history"></div><div id="chat-requests"></div><div id="chat-proposals"></div><div id="chat-grants"></div><div id="chat-composer" class="chat-composer"></div></aside>`);
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
  if (!snapshot.deleted) refreshSavedCard((await request(`/api/cards/${encodeURIComponent(item.id)}`)).card);
  if (selected !== item.id || !$('#card-chat')) return;
  if (!$('#chat-prompt') || changed || item.referenceSignature !== referenceSignature(item, locateCard(item.id)?.card)) renderComposer(item);
  renderTranscript(item);
  updateComposerControls(item);
  if (item.view.preview) void refreshPreview(item);
  if (!hidden && (item.view.tab === 'chat' || matchMedia('(min-width: 1180px)').matches) && !document.hidden) await send('POST', url(item.id, 'viewed'), {});
}
// Reference choices depend on the gallery and this chat's saved versions.
function referenceSignature(item, card) {
  return JSON.stringify([card?.images, (item.snapshot?.outputs ?? []).filter((o) => o.importStatus === 'imported').map((o) => [o.imageId, o.inGallery])]);
}
function renderComposer(item) {
  if (!item.composer) return;
  const card = locateCard(item.id)?.card; if (!card) return;
  const composer = item.composer;
  const focused = $('#chat-composer').contains(document.activeElement) ? document.activeElement : null;
  const focusId = focused?.id;
  const selection = focused?.tagName === 'TEXTAREA' ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
  item.referenceSignature = referenceSignature(item, card);
  const versions = (item.snapshot?.outputs ?? []).filter((o) => o.importStatus === 'imported' && !card.images.some((image) => image.id === o.imageId))
    .map((o) => ({ id: o.imageId, name: `Chat version · ${o.name}` }));
  const known = [...card.images, ...versions];
  const images = [...known, ...composer.selections.images.filter((id) => !known.some((image) => image.id === id))
    .map((id) => ({ id, name: 'Unavailable reference (removed from gallery and chat)' }))];
  const choices = item.models.length ? item.models : composer.model ? [{ id: composer.model, displayName: composer.model }] : [];
  $('#chat-composer').innerHTML = `<div class="chat-model-row"><label for="chat-model">Model</label><select id="chat-model" ${active(item) ? 'disabled' : ''}><option value="">Choose a model…</option>${choices.map((model) => `<option value="${escape(model.id)}" ${composer.model === model.id ? 'selected' : ''}>${escape(model.displayName)}</option>`).join('')}</select><button class="button small secondary" data-action="chat-discover">Discover</button></div>
    <details id="chat-context-preview" ${item.view.preview ? 'open' : ''}><summary>What will be sent</summary><p class="chat-hint">Saved card values at Send. Images are attached once with all selected labels.</p><fieldset class="chat-selections"><legend>Card fields</legend>${contextFields(card.template).map((field) => `<label><input type="checkbox" data-chat-field="${field.key}" ${composer.selections.fields.includes(field.key) ? 'checked' : ''}>${escape(field.label)}</label>`).join('')}</fieldset><fieldset class="chat-selections"><legend>Image references</legend>${[['original', 'Original'], ['inspiration', 'Inspiration'], ['cover', 'Display']].map(([role, label]) => `<label><input type="checkbox" data-chat-role="${role}" ${composer.selections.roles.includes(role) ? 'checked' : ''}>${label}</label>`).join('')}${images.map((image) => `<label><input type="checkbox" data-chat-image="${image.id}" ${composer.selections.images.includes(image.id) ? 'checked' : ''}>${escape(image.name)}</label>`).join('')}</fieldset><fieldset class="chat-selections"><legend>Allow requested text edits</legend><p>Only check fields you explicitly ask Codex to edit. Suggestions remain proposals.</p>${contextFields(card.template).map((field) => `<label><input type="checkbox" data-chat-authority="${field.key}" ${composer.authority.fields.includes(field.key) ? 'checked' : ''}>${escape(field.label)}</label>`).join('')}</fieldset><div id="chat-exact-preview"></div></details>
    <label class="sr-only" for="chat-prompt">Prompt for this card</label><textarea id="chat-prompt" maxlength="200000" placeholder="Ask about this card…" ${item.pending ? 'disabled' : ''}>${escape(composer.prompt)}</textarea><div class="chat-send-row"><span id="chat-save-state">${item.dirty ? 'Saving draft…' : 'Draft saved'}</span><button class="button small secondary" data-action="chat-stop" ${active(item) ? '' : 'disabled'}>Stop</button><button class="button primary" data-action="chat-send">${item.pending ? 'Retry Send' : 'Send'}</button></div><p class="chat-hint">Ask for images in your prompt. Codex native image generation and exact-reference edits are kept in this chat. Edit attaches an exact version without removing other references. Add to gallery never sets Display, Original or Inspiration.</p><p class="chat-hint">Codex can write in its workspace and run sandboxed commands without network access automatically. Escape requests need approval. Outside reads are possible. Full native access keeps card acceptance rules. <a href="/codex.html" target="_blank" rel="noopener">Configuration and permission limits</a></p>`;
  $('#chat-context-preview').addEventListener('toggle', () => { rememberView(); if ($('#chat-context-preview').open) void refreshPreview(item); });
  if (item.view.preview) void refreshPreview(item);
  updateComposerControls(item);
  if (focusId) { const input = document.getElementById(focusId); input?.focus(); if (selection) input?.setSelectionRange(...selection); }
}
const methods = { 'native-image-generation': 'Codex native image generation', 'code-rendered': 'Rendered by Codex code and registered' };
function outputMarkup(item, output) {
  if (!output) return '';
  const sources = output.references.filter((reference) => reference.source === 'chat-output');
  const status = output.generationStatus !== 'completed'
    ? `<p class="chat-output-error">Generation ${escape(output.generationStatus)}${output.native.failure ? ` · ${escape(output.native.failure.type)}${output.native.failure.resetsAt ? ` · resets ${escape(new Date(output.native.failure.resetsAt * 1000).toLocaleString())}` : ''}` : ''}. Send a deliberate new request to try again.</p>`
    : output.importStatus === 'imported' ? output.available ? `<img class="chat-output-image" src="/images/${encodeURIComponent(output.imageId)}" alt="${escape(output.name)}">`
      : '<p class="chat-output-error">Image file unavailable. Its history and provenance are retained; it will not be regenerated.</p>'
      : output.importStatus === 'failed' ? `<p class="chat-output-error">Generated, but not saved: ${escape(output.error)}</p><button class="button small secondary" data-action="chat-retry-save" data-id="${escape(output.id)}">Retry saving</button>`
        : '<p class="chat-hint">Saving generated image…</p>';
  const actions = output.importStatus === 'imported' && output.available ? `<div class="chat-output-actions"><button class="button small secondary" data-action="chat-edit-image" data-id="${escape(output.imageId)}">Edit</button>${output.inGallery ? '<span class="chat-hint">In gallery</span>' : `<button class="button small secondary" data-action="chat-adopt" data-id="${escape(output.id)}">Add to gallery</button>`}</div>` : '';
  return `<figure class="chat-output">${status}<figcaption>${escape(output.name)}<small>${escape(methods[output.creationMethod] ?? output.creationMethod)} · conversation model ${escape(output.conversationModel)} · image model not reported by Codex${output.toolPrompt ? ` · tool prompt: ${escape(output.toolPrompt)}` : ''}${sources.length ? ` · edited from ${sources.map((reference) => escape(reference.name)).join(', ')}` : ''}${output.references.length ? ` · ${output.references.length} exact reference(s)` : ''}${output.hash ? ` · SHA-256 ${escape(output.hash.slice(0, 12))}…` : ''}</small></figcaption>${actions}</figure>`;
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
// Possible delivery is never resent automatically; these are explicit choices.
function recoveryMarkup(submission, attempts) {
  if (submission.status === 'uncertain') {
    const attempt = attempts.at(-1);
    return `<div class="chat-recovery"><p class="chat-hint">Codex may have received this prompt. Nothing is resent automatically.</p><button class="button small secondary" data-action="chat-reconcile">Check native history</button><button class="button small secondary" data-action="chat-resolve" data-id="${escape(attempt.id)}">Mark interrupted…</button></div>`;
  }
  if (submission.status === 'held' && submission.hold === 'outside') return `<div class="chat-recovery"><button class="button small secondary" data-action="chat-continue" data-id="${escape(submission.id)}">Continue in this conversation</button><span class="chat-hint">or start fresh context</span></div>`;
  if (submission.status === 'waiting' && submission.retryAt) return `<p class="chat-hint">Next automatic try at ${escape(new Date(submission.retryAt).toLocaleTimeString())}.</p>`;
  return '';
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
      return `<article class="chat-submission"><div class="chat-prompt-sent">${escape(submission.prompt)}</div>${frozenMarkup(submission)}<p class="chat-status">${escape(submission.status)}${submission.reason ? ` · ${escape(submission.reason)}` : ''}</p>${attempts.map((attempt) => `${attempt.previousAttemptId ? `<div class="chat-divider">${snapshot.attempts.find((a) => a.id === attempt.previousAttemptId)?.status === 'not-delivered' ? 'Not sent before Codex stopped · sent again with original inputs' : 'Retry · original inputs retained'}</div>` : ''}${snapshot.items.filter((entry) => entry.attemptId === attempt.id).map((entry) => `<div data-item-sequence="${entry.sequence}" class="chat-item ${entry.kind === 'notice' ? 'chat-notice' : ''}">${['imageGeneration', 'registeredImage'].includes(entry.kind) ? outputMarkup(item, (snapshot.outputs ?? []).find((o) => o.attemptId === entry.attemptId && (o.nativeId === entry.nativeId || o.id === entry.data.outputId))) : escape(entry.text || ({ dynamicToolCall: 'Tool result', commandExecution: 'Command execution' }[entry.kind] ?? entry.kind))}${!entry.completed && entry.kind === 'agentMessage' ? '<small>Partial response</small>' : ''}${entry.kind === 'agentMessage' ? `<button class="button small secondary" data-action="chat-use-text" data-sequence="${entry.sequence}">Use selected reply text</button>` : ''}</div>`).join('')}`).join('')}${recoveryMarkup(submission, attempts)}${['queued', 'waiting', 'held'].includes(submission.status) ? `<button class="button small secondary" data-action="chat-cancel" data-id="${escape(submission.id)}">Cancel submission</button>` : ''}${['failed', 'interrupted'].includes(submission.status) && conversation.state === 'active' ? `<button class="button small secondary" data-action="chat-retry" data-id="${escape(submission.id)}">Retry original submission</button>` : ''}</article>`;
    }).join('')}`;
  }).join('');
  if (timeline.dataset.rendered !== html) {
    const openDetails = [...timeline.querySelectorAll('details[open]')].map((node) => [...timeline.querySelectorAll('details')].indexOf(node));
    timeline.innerHTML = html || '<p class="chat-empty">Send a prompt to start this card’s conversation.</p>';
    timeline.dataset.rendered = html;
    openDetails.forEach((index) => { const node = timeline.querySelectorAll('details')[index]; if (node) node.open = true; });
    timeline.scrollTop = nearEnd && !item.view.scroll ? timeline.scrollHeight : scroll;
  }
  renderRequests(item);
  renderProposals(item);
  const current = snapshot.conversations.find((c) => c.state !== 'previous');
  $('#chat-grants').innerHTML = current?.grants.length ? `<p class="chat-hint">${current.grants.some((g) => g.kind === 'full') ? 'Full native access for this conversation. Remaining requests are approved individually; full sandbox mode begins with the next response. Stop active work before revoking.' : `${current.grants.length} exact operation allowance(s)`}. Card acceptance still applies. <button class="button small secondary" data-action="chat-revoke-grants">Revoke allowances</button></p>` : '';
  if ($('#chat-save-state')) $('#chat-save-state').textContent = item.dirty || item.saving ? 'Saving draft…' : 'Draft saved';
}
function renderRequests(item) {
  const html = item.snapshot.requests.filter((r) => r.status === 'pending').map((r) => {
    const input = r.method === 'item/tool/requestUserInput';
    const supported = /^item\/(commandExecution|fileChange|permissions)\/requestApproval$/.test(r.method);
    const scoped = r.method === 'item/commandExecution/requestApproval' && r.params.command && r.params.cwd
      || r.method === 'item/permissions/requestApproval' && r.params.permissions && r.params.cwd
      || r.method === 'item/fileChange/requestApproval' && r.params.changes?.length;
    const detail = input ? r.params.questions?.map((q) => q.question).join('\n')
      : [r.params.command, r.params.cwd, r.params.reason, r.params.permissions ? JSON.stringify(r.params.permissions, null, 2) : '', r.params.changes ? JSON.stringify(r.params.changes, null, 2) : ''].filter(Boolean).join('\n');
    return `<div class="chat-request"><strong>? ${escape(locateCard(item.id)?.card.title || 'This card')} · Input needed</strong><pre>${escape(detail || r.method)}</pre>${input ? `<button class="button small secondary" data-action="chat-input" data-id="${escape(r.id)}">Answer questions</button>` : supported ? `<button class="button small secondary" data-action="chat-answer" data-id="${escape(r.id)}" data-decision="accept">Allow once</button>${scoped ? `<button class="button small secondary" data-action="chat-answer" data-id="${escape(r.id)}" data-decision="accept" data-scope="conversation">Allow this exact operation for conversation</button>` : ''}<button class="button small secondary" data-action="chat-full-access" data-id="${escape(r.id)}">Full native access…</button><button class="button small secondary" data-action="chat-answer" data-id="${escape(r.id)}" data-decision="decline">Deny</button>` : '<p>This request is unsupported. Stop remains available.</p>'}</div>`;
  }).join('');
  const panel = $('#chat-requests'); if (panel.dataset.rendered !== html) { panel.innerHTML = html; panel.dataset.rendered = html; }
  if (item.reveal === 'requests' && html) { item.reveal = null; panel.scrollIntoView({ block: 'nearest' }); panel.querySelector('button')?.focus(); }
}
function renderProposals(item) {
  const html = (item.snapshot.proposals ?? []).filter((p) => p.status === 'pending').map((p) => `<div class="chat-request"><strong>Card proposal · ${p.kind === 'move' ? 'Lane move' : 'Text changes'}</strong><p>${escape(p.kind === 'move' ? 'Requires your acceptance' : Object.keys(p.payload.fields).join(', '))}</p><button class="button small secondary" data-action="chat-proposal" data-id="${escape(p.id)}">Review proposal</button></div>`).join('');
  const panel = $('#chat-proposals'); if (panel.dataset.rendered !== html) { panel.innerHTML = html; panel.dataset.rendered = html; }
}
async function answerInput(item, id) {
  const r = item.snapshot.requests.find((r) => r.id === id && r.status === 'pending');
  if (!r) throw new Error('This request is no longer pending.');
  smallForm({ title: 'Answer this card’s questions', fields: r.params.questions.map((q, index) => `<label class="form-label" for="chat-question-${index}">${escape(q.question)}</label>${q.options?.length ? `<p>${q.options.map((o) => `${escape(o.label)}: ${escape(o.description)}`).join('<br>')}</p>` : ''}<input class="form-input" id="chat-question-${index}" name="answer-${index}" type="${q.isSecret ? 'password' : 'text'}" maxlength="200000" required autocomplete="off">`).join(''), submit: 'Send answers', onSubmit: async (data) => {
    const answers = Object.fromEntries(r.params.questions.map((q, index) => [q.id, { answers: [String(data.get(`answer-${index}`))] }]));
    await send('POST', url(item.id, 'answer'), { requestId: id, response: { answers } }); await refresh(item);
  } });
}
async function reviewProposal(item, id) {
  const preview = await send('POST', url(item.id, `proposals/${id}/preview`), {});
  const p = item.snapshot.proposals.find((p) => p.id === id);
  const lanes = locateCard(item.id)?.project.lanes ?? [];
  const label = (key) => contextFields(locateCard(item.id).card.template).find((f) => f.key === key)?.label ?? key;
  smallForm({ title: 'Review card proposal', fields: p.kind === 'move'
    ? `<p>${escape(lanes.find((l) => l.id === preview.fromStageId)?.name ?? 'Current lane')} → ${escape(lanes.find((l) => l.id === preview.payload.toStageId)?.name ?? 'Missing lane')}</p>`
    : Object.entries(preview.payload.fields).map(([key, value]) => `<label><input type="checkbox" name="field" value="${escape(key)}" checked> ${escape(label(key))}</label><p>Current</p><pre class="chat-review-text">${escape(preview.before[key])}</pre><p>Proposed</p><pre class="chat-review-text">${escape(value)}</pre>`).join(''), submit: p.kind === 'move' ? 'Accept lane move' : 'Apply selected fields', onSubmit: async (data) => {
      await send('POST', url(item.id, `proposals/${id}/accept`), { reviewId: preview.reviewId, fields: data.getAll('field'), baseVersions: preview.baseVersions, placementVersion: preview.placementVersion });
      await refresh(item);
    }, extra: `<button class="button secondary" type="button" data-action="chat-reject-proposal" data-id="${escape(id)}">Reject proposal</button>` });
}
function useSelectedText(item, sequence) {
  const selection = window.getSelection(); const text = selection?.toString() ?? '';
  const entry = item.snapshot.items.find((i) => i.sequence === sequence);
  const source = selection?.anchorNode?.parentElement?.closest('[data-item-sequence]');
  if (!text || !entry?.text.includes(text) || Number(source?.dataset.itemSequence) !== sequence) throw new Error('Select text within this reply first.');
  const card = locateCard(item.id).card;
  smallForm({ title: 'Use selected reply text', fields: `<label class="form-label" for="chat-text-field">Destination</label><select class="form-input" id="chat-text-field" name="field">${contextFields(card.template).map((f) => `<option value="${f.key}">${escape(f.label)}</option>`).join('')}</select><label class="form-label" for="chat-text-mode">Action</label><select class="form-input" id="chat-text-mode" name="mode"><option value="replace">Replace</option><option value="append">Append</option></select><pre class="chat-review-text">${escape(text)}</pre>`, submit: 'Preview result', onSubmit: async (data) => {
    const input = { itemSequence: sequence, text, field: String(data.get('field')), mode: String(data.get('mode')) };
    const preview = await send('POST', url(item.id, 'text-preview'), input);
    setTimeout(() => smallForm({ title: 'Apply reviewed text?', fields: `<p>Destination: ${escape(input.field)} · ${escape(input.mode)}</p><pre class="chat-review-text">${escape(preview.value)}</pre>`, submit: 'Apply text', onSubmit: async () => { await send('POST', url(item.id, 'accept-text'), { ...input, ...preview }); await refresh(item); } }), 0);
  } });
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
async function loadActivity() {
  const result = await request('/api/chat-activity');
  if (JSON.stringify(result.entries) !== JSON.stringify(activity)) { activity = result.entries; navigation?.renderBoard(); renderActivityList(); }
  return result.cursor;
}
function scheduleActivity() {
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => void loadActivity().catch(() => { /* The stream retries and resyncs. */ }), 100);
}
function scheduleRefresh() {
  const item = chats.get(selected); if (!item) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refresh(item).catch((error) => showError(item, error)), 100);
}
// Deltas carry their character offset: a duplicate is ignored, an overlap
// appends only its new suffix and a gap reloads the snapshot.
function applyDelta(delta) {
  const item = chats.get(delta.cardId);
  if (!item?.snapshot || delta.cardId !== selected) return;
  const entry = item.snapshot.items.find((candidate) => candidate.attemptId === delta.attemptId && candidate.nativeId === delta.itemId);
  if (!entry || delta.offset > entry.text.length) { scheduleRefresh(); return; }
  if (entry.completed || delta.offset + delta.text.length <= entry.text.length) return;
  entry.text += delta.text.slice(entry.text.length - delta.offset);
  if (!item.renderPending) {
    item.renderPending = true;
    requestAnimationFrame(() => { item.renderPending = false; if (selected === item.id) renderTranscript(item); });
  }
}
// Durable activity arrives by cursor; EventSource reconnects with
// Last-Event-ID, and the server asks for a snapshot reload when replay is
// incomplete.
function connect(cursor) {
  events?.close();
  let reconnecting = false;
  events = new EventSource(`/api/stream?since=${cursor}`);
  events.addEventListener('activity', (event) => {
    const entry = JSON.parse(event.data);
    if (entry.entity === 'chat' || entry.entity === 'card' || entry.entity === 'project') scheduleActivity();
    if ((entry.entity === 'chat' || entry.entity === 'card') && entry.entityId === selected) scheduleRefresh();
  });
  events.addEventListener('delta', (event) => applyDelta(JSON.parse(event.data)));
  events.addEventListener('resync', () => { scheduleActivity(); scheduleRefresh(); });
  events.addEventListener('error', () => { reconnecting = true; });
  events.addEventListener('open', () => { if (reconnecting) { reconnecting = false; scheduleActivity(); scheduleRefresh(); } });
}
function tickTimers() {
  document.querySelectorAll('[data-activity-card]').forEach((node) => {
    const entry = activity.find((candidate) => candidate.cardId === node.dataset.activityCard);
    if (entry?.state === 'working') node.textContent = activityLabel(entry);
  });
}
function renderActivityList() {
  const list = $('#chat-activity-list'); if (!list) return;
  list.innerHTML = activity.length ? activity.map((entry) => `<button class="chat-activity-entry" data-action="chat-activity-card" data-id="${escape(entry.cardId)}" data-project="${escape(entry.projectId)}" ${entry.requestId ? 'data-reveal="requests"' : ''} ${entry.deleted ? 'disabled' : ''}><strong>${escape(entry.title || 'Untitled card')}${entry.deleted ? ' (deleted)' : ''}</strong><span data-activity-card="${escape(entry.cardId)}">${escape(activityLabel(entry))}</span>${entry.reason ? `<span>${escape(entry.reason)}</span>` : ''}</button>`).join('') : '<p>No active card chats.</p>';
}
export function initializeChats(callbacks) {
  navigation = callbacks;
  clearInterval(clockTimer); clockTimer = setInterval(tickTimers, 1000);
  void loadActivity().then(connect, () => connect(0));
  document.addEventListener('input', (event) => {
    if (event.target.id !== 'chat-prompt') return;
    const item = chats.get(selected); if (!item?.composer) return;
    item.composer.prompt = event.target.value; composerChanged(item);
  });
  document.addEventListener('change', (event) => {
    const item = chats.get(selected); if (!item?.composer) return;
    const target = event.target;
    if (target.dataset.chatAuthority) {
      const fields = new Set(item.composer.authority.fields);
      if (target.checked) fields.add(target.dataset.chatAuthority); else fields.delete(target.dataset.chatAuthority);
      item.composer.authority.fields = [...fields]; composerChanged(item); return;
    }
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
      if (action === 'chat-activity-card') {
        await navigation.switchProject(target.dataset.project);
        if (target.dataset.reveal) { if (!chats.has(target.dataset.id)) chats.set(target.dataset.id, newItem(target.dataset.id)); Object.assign(chats.get(target.dataset.id), { reveal: target.dataset.reveal }); chats.get(target.dataset.id).view.tab = 'chat'; }
        navigation.openCard(target.dataset.id);
      }
      if (!item) return;
      if (action === 'toggle-chat') { rememberView(); hidden = !hidden; preference('frameboard-chat-hidden', String(hidden)); setDialogMode(); scheduleRefresh(); }
      if (action === 'workbench-tab') { rememberView(); item.view.tab = target.dataset.tab; applyLayout(); rememberView(); scheduleRefresh(); }
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
      if (action === 'chat-reconcile') { await send('POST', url(item.id, 'reconcile'), {}); await refresh(item); }
      if (action === 'chat-continue') { await send('POST', url(item.id, 'continue'), { submissionId: target.dataset.id }); await refresh(item); }
      if (action === 'chat-resolve') smallForm({ title: 'Mark this delivery interrupted?', description: 'Codex may already have received this prompt. Marking it interrupted unblocks this card’s queue and lets you retry deliberately, which may send it twice. Nothing is resent automatically.', submit: 'Mark interrupted', onSubmit: async () => { await send('POST', url(item.id, 'resolve'), { attemptId: target.dataset.id }); await refresh(item); } });
      if (action === 'chat-stop') { await send('POST', url(item.id, 'stop'), {}); await refresh(item); }
      if (action === 'chat-cancel' || action === 'chat-retry') { await send('POST', url(item.id, action === 'chat-cancel' ? 'cancel' : 'retry'), { submissionId: target.dataset.id }); await refresh(item); }
      if (action === 'chat-answer') { await send('POST', url(item.id, 'answer'), { requestId: target.dataset.id, response: { decision: target.dataset.decision, scope: target.dataset.scope ?? 'once' } }); await refresh(item); }
      if (action === 'chat-input') await answerInput(item, target.dataset.id);
      if (action === 'chat-proposal') await reviewProposal(item, target.dataset.id);
      if (action === 'chat-reject-proposal') { await send('POST', url(item.id, `proposals/${target.dataset.id}/accept`), { reject: true }); $('#form-dialog').close(); await refresh(item); }
      if (action === 'chat-use-text') useSelectedText(item, Number(target.dataset.sequence));
      if (action === 'chat-adopt') { const result = await send('POST', url(item.id, `outputs/${target.dataset.id}/adopt`), {}); refreshSavedCard(result.card); await refresh(item); toast(result.adopted ? 'Added to gallery. Choose roles in the editor.' : 'Already in the gallery.'); }
      if (action === 'chat-retry-save') { await send('POST', url(item.id, `outputs/${target.dataset.id}/retry-save`), {}); await refresh(item); }
      if (action === 'chat-edit-image') {
        // Edit adds this exact version; existing selections stay visible and removable.
        if (!item.composer || item.sending || item.pending) throw new Error('Wait for the saved composer and any Send in progress.');
        if (!item.composer.selections.images.includes(target.dataset.id)) { item.composer.selections.images = [...item.composer.selections.images, target.dataset.id]; composerChanged(item); }
        item.view.preview = true; renderComposer(item); $('#chat-prompt')?.focus();
      }
      if (action === 'chat-revoke-grants') { await send('POST', url(item.id, 'revoke-grants'), {}); await refresh(item); }
      if (action === 'chat-full-access') smallForm({ title: 'Allow full native access?', description: 'Approve remaining native requests individually. From the next response Codex runs without its sandbox or approval prompts for this conversation. It can reach app storage and anything your account can reach. Card acceptance keeps its own rules. Stop active work before revoking; fresh context resets the allowance.', submit: 'Allow full native access', onSubmit: async () => { await send('POST', url(item.id, 'answer'), { requestId: target.dataset.id, response: { decision: 'accept', scope: 'full' } }); await refresh(item); } });
      if (action === 'chat-fresh') smallForm({ title: 'Start empty fresh context?', description: 'Retain this conversation as previous history and reset its permissions. Cancel any queued or held submissions for the old conversation. No native conversation or turn starts until Send.', submit: 'Start fresh and cancel queued work', onSubmit: async () => { await saveComposer(item); item.snapshot = await send('POST', url(item.id, 'fresh'), { cancelQueued: true }); renderTranscript(item); } });
    } catch (error) { if (item) showError(item, error); else toast(error.message); }
    finally { if (action === 'chat-discover' && target.isConnected) target.disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { rememberView(); flushComposers(); } else scheduleRefresh(); });
  matchMedia('(min-width: 1180px)').addEventListener('change', scheduleRefresh);
}
