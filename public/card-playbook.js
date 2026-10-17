// The card editor's view of its lane playbook: what the lane does, this
// card's latest lane runs, Run playbook, and the card's hand-off notes
// (notes.md in its workspace), which every lane run reads.
import { $, escape, icon, button, iconButton, help, toast } from './ui.js';
import { locateCard, lanesOf, laneRuns, runPlaybook, loadNotes, saveNotes, moveCard } from './state.js';
import { openPlaybooks } from './playbook-editor.js';
import { renderBoard } from './board.js';

let refreshTimer = null;
const cardStates = new Map();
let active = null;
const submissionLabels = { queued: 'Queued in the card chat', waiting: 'Waiting for the provider', dispatching: 'Starting…', running: 'Working…', 'interrupt-requested': 'Stopping…',
  completed: 'Applying the result…', failed: 'Failed', interrupted: 'Stopped', cancelled: 'Cancelled', held: 'Needs attention in the card chat', uncertain: 'Check delivery in the card chat' };

export function runLabel(run) {
  if (run.status === 'pending') return run.reason || 'Starting…';
  if (run.status === 'queued') return submissionLabels[run.submissionStatus] ?? 'Queued';
  const label = { completed: 'Done', failed: 'Failed', cancelled: 'Cancelled', held: 'Held' }[run.status] ?? run.status;
  return run.reason ? `${label} · ${run.reason}` : label;
}

// What the user can do after a run that did not finish cleanly. Retry
// resends one frozen submission; Run playbook is new whole work from what is
// saved now, for the card's current lane. Neither continues where a failed
// run stopped. `here` is false for a run in a lane the card has since left.
export function runGuidance(run, { here = true } = {}) {
  const repeat = run.possiblyDelivered ? ' The agent may already have received it, so either may repeat its work.' : '';
  const rerun = 'Run playbook starts a new run with the current playbook, inputs and notes.';
  if (run.submissionStatus === 'uncertain') return 'The agent may have received this run. Check delivery in the card chat before anything else is sent there; running the playbook again may repeat its work.';
  if (run.status !== 'failed') return '';
  if (!here) return run.retryable ? "Retry in the card chat resends that run's original submission; its field changes become proposals. Run playbook runs this lane's playbook instead." : '';
  if (!run.submissionId) return 'Nothing was sent, so there is nothing to retry. Fix the problem, then Run playbook to start new work.';
  if (run.submissionStatus === 'completed') return 'The reply is kept in the card chat, but its result was not applied. Run playbook to start new work.';
  if (run.conversationUncertain) return `Another prompt's delivery in the card chat is uncertain. Check delivery there first: Retry waits for it, and a new run queues behind it.${repeat}`;
  if (run.retryable) return `Retry in the card chat resends this run's original submission exactly as it was sent. ${rerun} Earlier notes and card changes stay either way.${repeat}`;
  return `${rerun}${repeat}`;
}

export function cardPlaybookMarkup() {
  return '<section id="card-playbook" class="card-playbook" aria-label="Lane playbook"></section>';
}
export function notesMarkup() {
  const about = help('Hand-off notes', "<p>Saved as <code>notes.md</code> in this card's workspace. Every lane run reads it first, and lane runs leave notes here for the next lane.</p><p>You can add your own.</p>");
  return `<section class="writing-section notes-section"><div class="field-heading"><span class="notes-heading"><label for="lane-notes">Hand-off notes</label>${about}</span><div class="field-tools"><span id="lane-notes-state"></span></div></div><div id="lane-notes-conflict" class="notes-conflict" role="alert" hidden></div><textarea id="lane-notes" placeholder="Notes for the next lane…" disabled>Loading notes…</textarea></section>`;
}

export function mountCardPlaybook(id) {
  if (active) void flushNotes(false, active);
  active = cardStates.get(id) ?? { id, runs: [], notes: null, draft: null, conflict: false, timer: null, saving: null };
  cardStates.set(id, active);
  renderBar(); void refresh();
}

// Board activity for this card (a lane run, notes saved elsewhere) or a
// playbook save refreshes what is shown.
export function cardPlaybookActivity(entry) {
  if (!active || !$('#card-playbook')) return;
  if (entry.entity === 'flow') renderBar();
  if ((entry.entity === 'card' || entry.entity === 'chat') && entry.entityId === active.id) {
    // Streaming replies log activity often; one refresh per burst is enough.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), 200);
  }
}

async function refresh() {
  const state = active;
  if (!state) return;
  try {
    const [{ runs: latest }, saved] = await Promise.all([laneRuns(state.id), loadNotes(state.id)]);
    if (state !== active) return;
    state.runs = latest;
    if (state.draft === null && !state.saving) state.notes = saved;
    else if (!state.saving && saved.hash !== state.notes.hash) { state.conflict = true; state.notes = { ...state.notes, newer: saved }; }
    renderBar(); renderNotes();
  } catch (error) { if (error.status !== 404) toast(error.message); }
}

export function renderBar() {
  const panel = $('#card-playbook');
  const found = active && locateCard(active.id);
  if (!panel || !found) return;
  const { lane } = found;
  const playbook = lane.playbook;
  const runnable = playbook && playbook.hasInstructions && playbook.run !== 'off' && !playbook.errors.length;
  const latest = active.runs[0];
  const guidance = latest && runGuidance(latest, { here: latest.stageId === lane.id });
  // A graph node's routes: the user can send the card along any of them.
  const routes = found.flow.kind === 'graph' && !found.project.archivedAt ? (playbook?.routes ?? []).filter((route) => found.flow.lanes.some((item) => item.id === route.laneId)) : [];
  const routeButtons = routes.map((route) => `<button type="button" class="chip" data-action="follow-route" data-to="${route.laneId}" data-route="${escape(route.name)}">${escape(route.name)}${icon('arrow')}${escape(found.flow.lanes.find((item) => item.id === route.laneId).name)}</button>`).join('');
  // A re-render (run activity, a playbook save) keeps the guidance open if it was.
  const guidanceOpen = panel.querySelector('.card-playbook-guidance')?.open ? ' open' : '';
  const summary = playbook
    ? `<span class="card-playbook-summary" title="${escape(playbook.summary ?? '')}">${escape(playbook.summary ?? '')}</span>`
    : `<button type="button" class="text-button card-playbook-write" data-action="open-lane-playbook" data-id="${lane.id}">Write one</button>`;
  const actions = playbook ? `<div class="card-playbook-actions">${button('run-playbook', 'Run playbook', 'arrow', 'button small secondary', runnable ? '' : 'disabled title="This lane has no runnable playbook"')}${iconButton('open-lane-playbook', 'Open playbook', 'edit', `data-id="${lane.id}"`)}</div>` : '';
  panel.innerHTML = `<div class="card-playbook-info">${icon('playbook')}<strong>${escape(lane.name)} playbook</strong>${summary}</div>${actions}
    ${routeButtons ? `<div class="card-routes" role="group" aria-label="Follow a route"><span>Routes</span>${routeButtons}</div>` : ''}
    ${latest ? `<p class="card-playbook-run ${latest.status === 'failed' ? 'failed' : ''}"><span>Last run${latest.stageId !== lane.id ? ` in ${escape(lanesOf(found.project).find((item) => item.id === latest.stageId)?.name ?? 'another lane')}` : ''}:</span> ${escape(runLabel(latest))}</p>` : ''}
    ${guidance ? `<details class="card-playbook-guidance"${guidanceOpen}><summary>What now?</summary><p>${escape(guidance)}</p></details>` : ''}`;
}

function renderNotes() {
  const input = $('#lane-notes');
  if (!active) return;
  const { notes, draft, conflict, saving } = active;
  if (!input || !notes) return;
  input.disabled = false;
  const text = draft ?? notes.text;
  if (input.value !== text) input.value = text;
  $('#lane-notes-state').textContent = saving ? 'Saving…' : draft !== null ? 'Unsaved' : '';
  const banner = $('#lane-notes-conflict');
  banner.hidden = !conflict;
  banner.innerHTML = conflict ? `<span title="A lane run may have added notes.">Notes changed while you were editing. Your text is kept.</span><div>${button('notes-use-newer', 'Use newer', null, 'button small secondary')}${button('notes-keep-mine', 'Keep mine', null, 'button small secondary')}</div>` : '';
}

async function flushNotes(force = false, state = active) {
  if (!state) return;
  clearTimeout(state.timer);
  if (state.saving) {
    await state.saving;
    if (state.draft !== null && (!state.conflict || force)) return flushNotes(force, state);
    return;
  }
  if (state.draft === null || (state.conflict && !force) || !state.notes) return;
  const text = state.draft;
  const operation = (async () => {
    try {
      const saved = await saveNotes(state.id, text, force && state.notes.newer ? state.notes.newer.hash : state.notes.hash);
      state.notes = saved; state.conflict = false;
      if (state.draft === text) state.draft = null;
    } catch (error) {
      if (error.status === 409) {
        state.conflict = true;
        try { state.notes = { ...state.notes, newer: await loadNotes(state.id) }; }
        catch (failure) { toast(failure.message); }
      } else toast(error.message);
    }
  })();
  state.saving = operation;
  renderNotes();
  try { await operation; } finally { state.saving = null; renderNotes(); }
}

document.addEventListener('input', (event) => {
  if (event.target.id !== 'lane-notes' || !active?.notes) return;
  const state = active;
  state.draft = event.target.value;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => void flushNotes(false, state), 700);
  renderNotes();
});
document.addEventListener('focusout', (event) => { if (event.target.id === 'lane-notes') void flushNotes(); });
document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || !active) return;
  const action = target.dataset.action;
  try {
    if (action === 'run-playbook') {
      target.disabled = true;
      const state = active;
      await flushNotes(false, state);
      if (state.draft !== null) throw new Error('Resolve the hand-off notes before running.');
      await runPlaybook(state.id);
      toast('Lane run started. Follow it in the chat.');
      await refresh();
    }
    if (action === 'open-lane-playbook') await openPlaybooks({ laneId: target.dataset.id });
    if (action === 'follow-route') {
      const id = active.id;
      if (moveCard(id, target.dataset.to, null, target.dataset.route)) {
        const found = locateCard(id);
        if ($('#card-lane')) $('#card-lane').value = found.card.stageId;
        renderBoard(); renderBar();
        toast(`Followed ${target.dataset.route} to ${found.lane.name}.`);
      }
    }
    if (action === 'notes-use-newer' && active.notes.newer) { active.draft = null; active.conflict = false; active.notes = active.notes.newer; renderNotes(); }
    if (action === 'notes-keep-mine') { await flushNotes(true); }
  } catch (error) { toast(error.message); renderBar(); }
});
export const hasUnsavedNotes = () => [...cardStates.values()].some((state) => state.draft !== null);
