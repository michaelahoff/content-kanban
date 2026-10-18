// The project chat: a Chat tab beside the board where the user describes the
// process they want and the flow builder (an agent with Frameboard tools)
// creates and changes flows, lanes, playbooks, templates and skills. The
// transcript streams like a card chat; the board reloads as the builder works.
import { $, escape, icon, iconButton, toast, smallForm, help } from './ui.js';
import { request, send } from './api.js';
import { state, project, reloadProject } from './state.js';
import { attemptMarkup } from './chat-transcript.js';
import { onActivity, onDelta } from './chat.js';
import { providerNames } from './playbook-format.js';

const chats = new Map();
let catalog = null; let catalogLoading = null; let clock = null;
let navigation = { renderApp: () => {} };
const unfinished = new Set(['queued', 'running', 'interrupt-requested']);
// Tools whose results change what the board shows.
const writingTools = new Set(['create_flow', 'update_flow', 'delete_flow', 'create_lane', 'update_lane', 'delete_lane', 'write_playbook', 'set_routes', 'write_map', 'write_skill', 'delete_skill', 'create_template', 'update_template', 'delete_template', 'create_cards']);
const url = (id, action = '') => `/api/projects/${encodeURIComponent(id)}/chat${action ? `/${action}` : ''}`;
const providerName = (provider) => providerNames[provider] ?? provider;
const statusLabels = { queued: 'Queued', running: 'Working', 'interrupt-requested': 'Stopping', failed: 'Failed', interrupted: 'Stopped' };
const workLabels = { reasoning: 'Thinking…', dynamicToolCall: 'Changing the project…', mcpToolCall: 'Using a connected tool…', commandExecution: 'Running a command…', webSearch: 'Searching the web…' };
const examples = [
  'I want a process for drafting emails to new leads: research the company, draft a short email in our voice, let me review it, then mark it sent.',
  'Make a graph flow for YouTube videos: ideas go to a script draft, a review node sends them back for another pass or on to filming, then publishing.',
  'Set up a weekly newsletter flow with a template for issues: collect links, write a draft, edit, schedule.',
];
function preference(key, value) {
  try { if (value !== undefined) localStorage.setItem(key, value); return localStorage.getItem(key); } catch { return null; }
}
function entryFor(projectId) {
  if (!chats.has(projectId)) chats.set(projectId, { id: projectId, snapshot: null, draft: preference(`frameboard-project-chat-draft:${projectId}`) ?? '', provider: null, model: null, sending: false, error: '', scroll: 0, refreshTimer: null, renderPending: false });
  return chats.get(projectId);
}
const panel = () => $('#project-chat');
const shown = (entry) => panel() && project()?.id === entry.id;
export const projectChatBusy = (projectId) => Boolean(chats.get(projectId)?.snapshot?.busy);
const activeTurn = (snapshot) => snapshot?.turns.find((turn) => unfinished.has(turn.status)) ?? null;

async function loadCatalog() {
  if (catalogLoading) return catalogLoading;
  catalogLoading = request('/api/models').then((result) => { catalog = result.providers; }).finally(() => { catalogLoading = null; });
  return catalogLoading;
}
function showError(entry, error) {
  entry.error = error.message;
  const node = $('#project-chat-error');
  if (!node || !shown(entry)) return;
  node.hidden = !entry.error;
  node.textContent = entry.error;
}
async function refresh(entry) {
  const snapshot = await request(url(entry.id));
  const wasBusy = entry.snapshot?.busy;
  entry.snapshot = snapshot;
  // The Chat tab's dot follows the chat whichever tab is shown.
  if (wasBusy !== snapshot.busy && project()?.id === entry.id) navigation.renderTabs?.();
  if (!shown(entry)) return;
  paint(entry);
}
function scheduleRefresh(entry) {
  clearTimeout(entry.refreshTimer);
  entry.refreshTimer = setTimeout(() => void refresh(entry).catch((error) => showError(entry, error)), 100);
}
// The builder changed flows, lanes or templates: the board takes the server's view.
const reloads = new Map();
function scheduleReload(projectId) {
  clearTimeout(reloads.get(projectId));
  reloads.set(projectId, setTimeout(() => {
    reloads.delete(projectId);
    const p = state.projects.find((item) => item.id === projectId); if (!p) return;
    void reloadProject(p).then(() => {
      if (project() !== p) return;
      // With the chat shown, the panel the user is typing in stays; only the
      // sidebar and tabs take the new flows and counts.
      if (navigation.chatShown?.()) { navigation.renderSidebar?.(); navigation.renderTabs?.(); } else navigation.renderApp();
    }).catch(() => {});
  }, 300));
}

export function mountProjectChat(callbacks) {
  navigation = { ...navigation, ...callbacks };
  clearInterval(clock); clock = setInterval(tick, 1000);
}
// Called by renderApp whenever the Chat tab is shown; the panel is fresh markup.
export function renderProjectChat() {
  const node = panel(); const p = project();
  if (!node || !p) return;
  const entry = entryFor(p.id);
  node.innerHTML = `<div class="project-chat-head"><div><h2>Project chat</h2><p class="project-chat-sub">Describe the process you want and the flow builder sets up the flows, lanes, playbooks and card templates; come back here to change them. ${help('the project chat', '<p>The flow builder is an agent with Frameboard tools. It reads this project, asks what it needs to know, then creates or changes flows, lanes, lane playbooks, card templates, skills and example cards. It never edits cards on its own: lane runs do that.</p><p>Each message is one turn of the chosen provider. The conversation continues until you start fresh context.</p>')}</p></div>${iconButton('project-chat-fresh', 'Start fresh context', 'plus')}</div>
    <div id="project-chat-error" role="alert" hidden></div>
    <div id="project-chat-transcript" class="chat-transcript" aria-label="Project chat history"></div>
    <div id="project-chat-progress" role="status" hidden></div>
    <div id="project-chat-composer" class="chat-composer project-chat-composer"></div>`;
  $('#project-chat-transcript').addEventListener('scroll', () => { entry.scroll = $('#project-chat-transcript').scrollTop; }, { passive: true });
  if (!catalog) void loadCatalog().then(() => { if (shown(entry)) renderComposer(entry); }, (error) => toast(error.message));
  paint(entry);
  void refresh(entry).catch((error) => showError(entry, error));
}
function paint(entry) {
  if (!shown(entry)) return;
  renderTranscript(entry);
  renderProgress(entry);
  renderComposer(entry);
  const error = $('#project-chat-error'); if (error) { error.hidden = !entry.error; error.textContent = entry.error; }
}
function renderTranscript(entry) {
  const timeline = $('#project-chat-transcript'); if (!timeline) return;
  const snapshot = entry.snapshot;
  if (!snapshot) { timeline.textContent = 'Loading…'; return; }
  const nearEnd = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 32;
  const rendered = timeline.dataset.rendered !== undefined;
  const html = snapshot.turns.length ? snapshot.conversations.map((conversation) => {
    const turns = snapshot.turns.filter((turn) => turn.conversationId === conversation.id);
    if (!turns.length && conversation.state === 'previous') return '';
    const divider = conversation.state === 'previous' ? 'Previous conversation' : snapshot.conversations.length > 1 ? 'Current conversation' : '';
    return `${divider ? `<div class="chat-divider">${divider}</div>` : ''}${turns.map((turn) => turnMarkup(snapshot, turn)).join('')}`;
  }).join('') : emptyMarkup(snapshot);
  if (timeline.dataset.rendered !== html) {
    const open = new Set([...timeline.querySelectorAll('details[open]')].map((node) => node.dataset.detailKey).filter(Boolean));
    timeline.innerHTML = html;
    timeline.dataset.rendered = html;
    timeline.querySelectorAll('details').forEach((node) => { node.open = open.has(node.dataset.detailKey); });
    timeline.scrollTop = nearEnd && (rendered || !entry.scroll) ? timeline.scrollHeight : entry.scroll;
  }
}
function emptyMarkup(snapshot) {
  if (snapshot.archived) return '<p class="chat-empty">This project is archived. Its chat has no messages.</p>';
  return `<div class="project-chat-empty"><p>Tell the flow builder what you want to make and how the work should move. It will ask what it needs to know, then build the flow. Try one of these:</p>${examples.map((text) => `<button type="button" class="project-chat-example" data-action="project-chat-example" data-text="${escape(text)}">${escape(text)}</button>`).join('')}</div>`;
}
function turnMarkup(snapshot, turn) {
  const items = snapshot.items.filter((item) => item.turnId === turn.id);
  const running = unfinished.has(turn.status);
  const status = turn.status === 'completed' ? '' : `<div class="chat-meta"><span class="chat-status">${escape(statusLabels[turn.status] ?? turn.status)}${turn.reason ? ` · ${escape(turn.reason)}` : ''}</span></div>`;
  return `<article class="chat-submission" data-turn="${escape(turn.id)}"><div class="chat-prompt-sent"><span class="chat-speaker">You</span>${escape(turn.prompt)}</div>${attemptMarkup(items, turn.id, () => '', running, providerName(turn.provider))}${status}</article>`;
}
function renderProgress(entry) {
  const node = $('#project-chat-progress'); if (!node) return;
  const turn = activeTurn(entry.snapshot);
  let label = null;
  if (turn?.status === 'queued') label = 'Getting started…';
  else if (turn?.status === 'interrupt-requested') label = 'Stopping…';
  else if (turn) {
    const last = entry.snapshot.items.filter((item) => item.turnId === turn.id).at(-1);
    label = last?.kind === 'agentMessage' && !last.completed ? 'Writing a reply…' : last && !last.completed ? workLabels[last.kind] ?? 'Working…' : 'Working…';
  }
  const signature = JSON.stringify([label, turn?.startedAt]);
  if (node.dataset.rendered !== signature) {
    node.hidden = !label;
    node.innerHTML = label ? `<span class="chat-thinking" aria-hidden="true"><i></i><i></i><i></i></span><span>${escape(label)}</span>${turn?.startedAt ? `<span class="chat-elapsed" data-started-at="${escape(turn.startedAt)}" aria-hidden="true"></span>` : ''}` : '';
    node.dataset.rendered = signature;
  }
  tick();
}
function tick() {
  const timer = $('#project-chat-progress [data-started-at]');
  if (timer) timer.textContent = `${Math.max(0, Math.floor((Date.now() - Date.parse(timer.dataset.startedAt)) / 1000))}s`;
}
// The provider and model this message goes to: the entry's choice, else the
// chat's last, else the provider's default model.
function choice(entry) {
  const snapshot = entry.snapshot;
  const enabled = (catalog ?? []).filter((item) => item.enabled);
  let provider = entry.provider ?? snapshot?.provider ?? null;
  if (catalog && !enabled.some((item) => item.provider === provider)) provider = enabled[0]?.provider ?? provider;
  const models = (catalog ?? []).find((item) => item.provider === provider)?.discovery?.models ?? [];
  const remembered = entry.model ?? (snapshot?.provider === provider ? snapshot.model : null);
  const model = remembered && models.some((item) => item.id === remembered) ? remembered : models.find((item) => item.isDefault)?.id ?? models[0]?.id ?? null;
  return { provider, model, models, enabled };
}
function renderComposer(entry) {
  const node = $('#project-chat-composer'); if (!node) return;
  const snapshot = entry.snapshot;
  if (snapshot?.archived) { node.innerHTML = ''; node.hidden = true; return; }
  node.hidden = false;
  const focused = node.contains(document.activeElement) ? document.activeElement.id : null;
  const prompt = $('#project-chat-prompt');
  const selection = prompt && focused === 'project-chat-prompt' ? [prompt.selectionStart, prompt.selectionEnd] : null;
  const { provider, model, models, enabled } = choice(entry);
  const busy = Boolean(activeTurn(snapshot));
  const notice = catalog && !enabled.length ? 'Enable Claude or Codex in Settings to send.' : catalog && provider && !models.length ? `No ${providerName(provider)} models yet. Refresh models in Settings.` : '';
  node.innerHTML = `${notice ? `<p class="chat-hint chat-composer-notice">${escape(notice)}</p>` : ''}
    <label class="sr-only" for="project-chat-prompt">Message to the flow builder</label><textarea id="project-chat-prompt" maxlength="200000" placeholder="Describe the flow you want, or a change to make…" ${entry.sending ? 'disabled' : ''}>${escape(entry.draft)}</textarea>
    <div class="chat-send-row"><select id="project-chat-provider" aria-label="Provider" title="Provider" ${busy ? 'disabled' : ''}>${enabled.length ? '' : '<option value="" disabled selected>Provider…</option>'}${enabled.map((item) => `<option value="${item.provider}" ${item.provider === provider ? 'selected' : ''}>${providerName(item.provider)}</option>`).join('')}</select><select id="project-chat-model" aria-label="Model" title="Model" ${busy ? 'disabled' : ''}>${models.length ? '' : '<option value="">Model…</option>'}${models.map((item) => `<option value="${escape(item.id)}" ${item.id === model ? 'selected' : ''}>${escape(item.displayName ?? item.id)}</option>`).join('')}</select><a class="icon-button chat-tool" href="/settings.html" target="_blank" rel="noopener" aria-label="Model settings" title="Model settings">${icon('settings')}</a><span class="project-chat-key chat-hint">Ctrl+Enter sends</span><button type="button" class="button small secondary" data-action="project-chat-stop" ${busy ? '' : 'disabled'}>Stop</button><button type="button" class="button primary small" data-action="project-chat-send" ${entry.sending || busy || !model || !entry.draft.trim() ? 'disabled' : ''}>Send</button></div>`;
  if (focused) { const input = document.getElementById(focused); input?.focus(); if (selection && input?.setSelectionRange) input.setSelectionRange(...selection); }
}
async function sendMessage(entry) {
  const text = entry.draft.trim();
  if (!text || entry.sending) return;
  const { provider, model } = choice(entry);
  if (!model) return toast('Choose a provider and model first.');
  entry.sending = true; renderComposer(entry);
  try {
    await send('POST', url(entry.id, 'turns'), { id: crypto.randomUUID(), prompt: text, provider, model });
    entry.draft = ''; preference(`frameboard-project-chat-draft:${entry.id}`, '');
    entry.error = '';
    await refresh(entry);
  } catch (error) { showError(entry, error); }
  finally { entry.sending = false; renderComposer(entry); $('#project-chat-prompt')?.focus(); }
}
// Deltas carry their character offset: a duplicate is ignored, an overlap
// appends only its new suffix and a gap reloads the snapshot.
function applyDelta(delta) {
  const entry = chats.get(delta.projectId);
  if (!entry?.snapshot) return;
  const item = entry.snapshot.items.find((candidate) => candidate.turnId === delta.turnId && candidate.nativeId === delta.itemId);
  if (!item || delta.offset > item.text.length) { scheduleRefresh(entry); return; }
  if (item.completed || delta.offset + delta.text.length <= item.text.length) return;
  item.text += delta.text.slice(item.text.length - delta.offset);
  if (!entry.renderPending && shown(entry)) {
    entry.renderPending = true;
    requestAnimationFrame(() => { entry.renderPending = false; if (shown(entry)) { renderTranscript(entry); renderProgress(entry); } });
  }
}
onDelta((delta) => { if (delta.projectId) applyDelta(delta); });
onActivity((entry) => {
  if (entry.entity !== 'project-chat') return;
  const chat = chats.get(entry.entityId);
  if (chat) scheduleRefresh(chat);
  if ((entry.type === 'tool_called' && writingTools.has(entry.data?.tool)) || ['turn_completed', 'turn_failed', 'turn_interrupted'].includes(entry.type)) scheduleReload(entry.projectId ?? entry.entityId);
});
document.addEventListener('input', (event) => {
  if (event.target.id !== 'project-chat-prompt') return;
  const entry = project() && entryFor(project().id); if (!entry) return;
  entry.draft = event.target.value; preference(`frameboard-project-chat-draft:${entry.id}`, entry.draft);
  const button = $('[data-action="project-chat-send"]'); if (button) button.disabled = entry.sending || Boolean(activeTurn(entry.snapshot)) || !choice(entry).model || !entry.draft.trim();
});
document.addEventListener('change', (event) => {
  if (!['project-chat-provider', 'project-chat-model'].includes(event.target.id)) return;
  const entry = project() && entryFor(project().id); if (!entry) return;
  if (event.target.id === 'project-chat-provider') { entry.provider = event.target.value; entry.model = null; renderComposer(entry); }
  if (event.target.id === 'project-chat-model') { entry.model = event.target.value || null; }
});
document.addEventListener('keydown', (event) => {
  if (event.target.id === 'project-chat-prompt' && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void sendMessage(entryFor(project().id)); }
});
document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action^="project-chat-"]'); if (!target) return;
  const entry = project() && entryFor(project().id); if (!entry) return;
  const action = target.dataset.action;
  try {
    if (action === 'project-chat-send') await sendMessage(entry);
    if (action === 'project-chat-example') { entry.draft = target.dataset.text; preference(`frameboard-project-chat-draft:${entry.id}`, entry.draft); renderComposer(entry); const prompt = $('#project-chat-prompt'); prompt.focus(); prompt.setSelectionRange(prompt.value.length, prompt.value.length); }
    if (action === 'project-chat-stop') { await send('POST', url(entry.id, 'stop'), {}); await refresh(entry); }
    if (action === 'project-chat-fresh') smallForm({ title: 'Start fresh context?', description: 'Keeps this conversation as history. The next message starts a new conversation with the provider, which no longer remembers the earlier one.', submit: 'Start fresh', onSubmit: async () => { entry.snapshot = await send('POST', url(entry.id, 'fresh'), {}); paint(entry); } });
  } catch (error) { showError(entry, error); }
});
