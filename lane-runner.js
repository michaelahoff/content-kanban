// Turns pending lane runs into card chat submissions. A run reads the project
// map, its lane playbook, the skills it names and the card's hand-off notes,
// and freezes all of it into one prompt. The chat worker delivers it.
import { composeLanePrompt, parseLaneResult, setFields } from './public/playbook-format.js';
import { submissionText } from './public/chat-context.js';
import { problemMessage } from './submission-inputs.js';

const providerName = (provider) => (provider === 'claude' ? 'Claude' : 'Codex');

export function createLaneRunner({ store, service, providers, ctx, paused = () => false }) {
  let draining = false; let again = false; let closed = false; let scheduled = null;
  const waitingForChat = new Set();

  // Everything a run would send, without queueing it. Also used for previews.
  function prepare(card, stage, project, stages, trigger) {
    const found = store.playbooks.settings(project.flowId, stage.id, card.template);
    if (!found) return { error: `${stage.name} has no lane playbook.` };
    const { document, settings } = found;
    if (settings.errors.length) return { error: `The playbook ${document.path} has errors: ${settings.errors.join(' ')}`, document, settings };
    if (!settings.instructions) return { error: 'This lane playbook has no instructions to run.', document, settings };
    const chat = store.chats.laneConversation(ctx, card.id);
    const provider = settings.provider ?? chat.composer.provider ?? chat.provider ?? 'codex';
    const discovery = store.providerCatalog(ctx, provider).discovery;
    const model = settings.model ?? (chat.composer.provider === provider ? chat.composer.model : null)
      ?? discovery?.models.find((entry) => entry.isDefault)?.id ?? discovery?.models[0]?.id ?? null;
    const map = store.playbooks.read(project.flowId, 'MAP.md');
    const skills = settings.skills.map((name) => store.playbooks.skill(project.flowId, name));
    const notes = store.playbooks.notes(card.id);
    const prompt = composeLanePrompt({ projectName: project.name, laneName: stage.name, lanes: stages, trigger, map, playbook: document,
      skills, notes: notes.text, settings, templateId: card.template });
    return { document, settings, chat, provider, model, map, skills, notes, prompt,
      warning: model ? '' : `No ${providerName(provider)} model is available. Refresh models in Settings or name one with model: in the playbook.` };
  }

  // The card and lane as they are now: null (and the run closed) if it moved on.
  function current(run) {
    const info = store.laneRuns.context(ctx, run.id);
    if (info.run.status !== 'pending') return null;
    const close = (reason) => { store.laneRuns.update(ctx, run.id, { status: 'cancelled', reason }); return null; };
    if (info.deleted || info.stageDeleted) return close('The card or its lane was deleted before this run started.');
    if (info.archived) return close('Cancelled because the project was archived.');
    if (info.card.stageId !== run.stageId) return close('The card left the lane before this run started.');
    return info;
  }

  // What a prepared run sends, from saved files, settings and the target.
  // The card, its conversation, provider settings and Library sources are
  // checked by the commit itself.
  const preparedParts = (prepared) => ({ playbook: prepared.document?.hash, map: prepared.map?.hash ?? null,
    skills: prepared.skills.map((skill) => [skill.name, skill.hash ?? null]), notes: prepared.notes.hash,
    target: [prepared.provider, prepared.model], prompt: prepared.prompt });
  const partNames = { playbook: 'lane playbook', map: 'project map', skills: 'named skills', notes: 'hand-off notes', target: 'provider or model', prompt: 'lane prompt' };
  const changedWhilePreparing = (error) => error.status === 409 && /changed while preparing/.test(error.message);
  // Repreparations in a row before a run that keeps changing fails visibly.
  const preparations = 3;

  async function start(run) {
    for (let attempt = 1; ; attempt += 1) {
      try { return await prepareAndQueue(run); }
      catch (error) {
        if (closed || error.code === 'lane-run-closed') return;
        if (!changedWhilePreparing(error)) return store.laneRuns.update(ctx, run.id, { status: 'failed', reason: error.message });
        // Prepare again from what is saved now; the run is still pending.
        if (attempt === preparations) {
          return store.laneRuns.update(ctx, run.id, { status: 'failed',
            reason: `${error.message} It changed during ${preparations} preparations in a row, so nothing was queued. Run playbook when it is settled.` });
        }
      }
    }
  }

  async function prepareAndQueue(run) {
    const finish = (status, reason) => store.laneRuns.update(ctx, run.id, { status, reason });
    let info = current(run);
    if (!info) return;
    const trigger = run.trigger === 'manual' ? 'manual' : 'enter';
    const enabled = (settings) => settings.run !== 'off' && (trigger === 'manual' || settings.run === 'on-enter');
    const cancelDisabled = () => finish('cancelled', 'The playbook was turned off or its trigger changed before this run started.');
    if (waitingForChat.has(run.id)) {
      if (store.chats.laneConversation(ctx, run.cardId).busy) {
        // Everything else is read when the chat is free; turning the
        // playbook off or to manual ends a waiting automatic run now.
        const saved = store.playbooks.settings(info.project.flowId, info.stage.id, info.card.template);
        if (saved && !saved.settings.errors.length && !enabled(saved.settings)) { waitingForChat.delete(run.id); return cancelDisabled(); }
        return;
      }
      waitingForChat.delete(run.id);
    }
    let prepared = prepare(info.card, info.stage, info.project, info.stages, trigger);
    if (prepared.error) return finish('failed', prepared.error);
    if (!enabled(prepared.settings)) return cancelDisabled();
    // Models are listed once and saved; list them now if that never happened.
    if (!prepared.model && !store.providerCatalog(ctx, prepared.provider).discovery && providers) {
      await providers.refresh(ctx, prepared.provider);
      if (closed || !(info = current(run))) return;
      prepared = prepare(info.card, info.stage, info.project, info.stages, trigger);
      if (prepared.error) return finish('failed', prepared.error);
      if (!enabled(prepared.settings)) return cancelDisabled();
    }
    if (!prepared.model) return finish('failed', prepared.warning);
    const { card, stage } = info;
    const { chat, settings, provider } = prepared;
    // A different provider, or conversation: fresh, needs empty fresh context.
    // That waits until the card chat has nothing running or queued.
    if (chat.used && (settings.conversation === 'fresh' || chat.provider !== provider) || chat.state !== 'active') {
      if (chat.busy) {
        waitingForChat.add(run.id);
        const reason = 'Waiting for the card chat to finish before starting fresh context for this lane run.';
        if (run.reason !== reason) store.laneRuns.update(ctx, run.id, { status: 'pending', reason });
        return;
      }
      store.chats.fresh(ctx, card.id, { cancelQueued: true });
    }
    // Called synchronously with the commit, after the asynchronous discovery
    // and byte checks: the run must still be pending in this lane, and every
    // saved input and the target must be what was prepared.
    const confirm = () => {
      const now = current(run);
      if (!now) throw Object.assign(new Error('This lane run was cancelled while it was being prepared.'), { status: 409, code: 'lane-run-closed' });
      const latest = prepare(now.card, now.stage, now.project, now.stages, trigger);
      // Preparing again reports the error or cancels the disabled run.
      if (latest.error || !enabled(latest.settings)) throw Object.assign(new Error('The lane playbook changed while preparing the lane run.'), { status: 409 });
      const [before, after] = [preparedParts(prepared), preparedParts(latest)];
      const differs = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
      // The prompt holds the documents; name it only for a lane or project rename.
      const changed = differs.length > 1 ? differs.filter((key) => key !== 'prompt') : differs;
      if (changed.length) throw Object.assign(new Error(`The ${changed.map((key) => partNames[key]).join(', ')} changed while preparing the lane run.`), { status: 409 });
    };
    // queueLane links the run and its submission in one commit.
    const submission = await service.queueLane(ctx, card.id, { id: `lane-${run.id}`, prompt: prepared.prompt, provider, model: prepared.model,
      selections: settings.selections, assets: settings.assets, authority: { fields: settings.mayEdit }, confirm,
      lane: { runId: run.id, stageId: stage.id, stageName: stage.name, trigger: run.trigger, entry: store.laneRuns.entry(card.id),
        playbook: { ...prepared.document }, map: prepared.map && { ...prepared.map },
        skills: prepared.skills.map(({ name, path, hash, text }) => ({ name, path, hash: hash ?? null, text })),
        notesHash: prepared.notes.hash, notesText: prepared.notes.text } });
    if (!submission.lane || submission.lane.runId !== run.id) finish('failed', 'A different submission already uses this lane run’s ID.');
  }

  async function drain() {
    // Maintenance holds pending runs; they start when it ends.
    if (paused()) return;
    if (draining) { again = true; return; }
    draining = true;
    try {
      do {
        again = false;
        for (const run of store.laneRuns.pending(ctx)) {
          if (closed || paused()) return;
          try { await start(run); } catch (error) { if (!closed) store.laneRuns.update(ctx, run.id, { status: 'failed', reason: error.message }); }
        }
      } while (again && !closed);
    } finally { draining = false; }
  }

  return {
    // Called from the store's commit hook: start after that commit has fully
    // finished, and fold a burst of commits (a streaming reply) into one pass.
    wake() {
      if (closed || scheduled) return;
      scheduled = setTimeout(() => { scheduled = null; void drain().catch((error) => { if (!closed) console.error(error); }); }, 50);
      scheduled.unref?.();
    },
    close() { closed = true; clearTimeout(scheduled); },
    idle: () => !draining,
    // The prompt the card's current lane would send now.
    async preview(cardId) {
      const { card, stage, project, stages } = store.laneRuns.place(ctx, cardId);
      const prepared = prepare(card, stage, project, stages, 'manual');
      const captured = prepared.prompt ? await service.previewLane(ctx, cardId, { selections: prepared.settings.selections, assets: prepared.settings.assets,
        provider: prepared.provider, model: prepared.model, prompt: prepared.prompt }) : null;
      // Sources that cannot be sent stay inspectable here; a run refuses them.
      const problems = captured?.problems ?? [];
      return { stageId: stage.id, path: prepared.document?.path ?? null, hash: prepared.document?.hash ?? null,
        error: prepared.error ?? (problems.length ? problemMessage(problems) : prepared.warning) ?? '',
        provider: prepared.provider ?? null, model: prepared.model ?? null,
        images: captured?.context.images ?? [], library: captured?.context.library ?? [], librarySelections: captured?.context.librarySelections ?? [],
        problems, warnings: captured?.context.warnings ?? [],
        prompt: captured ? submissionText({ prompt: prepared.prompt, context: captured.context, authority: { fields: prepared.settings.mayEdit } }) : '' };
    },
  };
}

// Applies the result block of a completed lane run reply, through the same
// card tools and authority checks as any card chat. Returns a summary line.
export function applyLaneResult({ store, ctx, attempt, submission, text }) {
  const run = store.laneRuns.bySubmission(submission.id);
  if (!run || run.status !== 'queued') return null;
  const live = store.chats.attempt(attempt.id);
  if (!live || !['dispatching', 'accepted', 'running'].includes(live.status)) throw new Error('This attempt no longer has card-tool authority.');
  const card = store.getCard(ctx, submission.cardId).card;
  const result = parseLaneResult(text, card.template);
  const outcome = { applied: [], proposed: [], move: null, notes: false, errors: [] };
  store.transaction(() => {
    if (!result) outcome.errors.push('The reply had no frameboard-result block, so nothing was applied.');
    else {
      outcome.errors.push(...result.errors);
      const current = (key) => (key === 'title' ? card.title : card.fields[key]);
      const changed = Object.fromEntries(Object.entries(result.fields).filter(([key, value]) => {
        if (value === current(key)) return false;
        if (!Number.isInteger(submission.lane.fieldVersions[key])) {
          outcome.errors.push(`Ignored ${key}: no field version was recorded for this run.`);
          return false;
        }
        return true;
      }));
      if (Object.keys(changed).length) {
        const baseVersions = Object.fromEntries(Object.keys(changed).map((key) => [key, submission.lane.fieldVersions[key]]));
        const fields = store.protection.tool(ctx, attempt.id, 'lane-result-fields', 'edit_fields', { fields: changed, baseVersions });
        outcome.applied = fields.applied ?? [];
        outcome.proposed = Object.keys(changed).filter((key) => !outcome.applied.includes(key));
        outcome.proposalId = fields.proposalId ?? null;
      }
      if (result.move) {
        const { stages } = store.laneRuns.context(ctx, run.id);
        const target = stages.find((stage) => stage.id === result.move) ?? stages.find((stage) => stage.name.toLowerCase() === result.move.toLowerCase());
        if (!target) outcome.errors.push(`Ignored the move to “${result.move}”: there is no lane with that name.`);
        else if (target.id === card.stageId) outcome.errors.push(`Ignored the move: the card is already in ${target.name}.`);
        else {
          store.protection.tool(ctx, attempt.id, 'lane-result-move', 'propose_move', { toStageId: target.id });
          outcome.move = target.name;
        }
      }
    }
  });
  // Notes are written outside the transaction, so recheck the attempt's
  // authority immediately before appending them.
  if (result?.notes.trim()) {
    if (store.chats.revocation(attempt.id)) outcome.errors.push('Hand-off notes were not saved: this attempt was stopped or its project archived.');
    else try {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      store.playbooks.appendNotes(card.id, `${submission.lane.stageName} · ${stamp} UTC`, result.notes);
      outcome.notes = true;
    } catch (error) { outcome.errors.push(`Hand-off notes could not be saved: ${error.message}`); }
  }
  const labels = (keys) => keys.map((key) => setFields(card.template).find((field) => field.key === key)?.label ?? key).join(', ');
  const summary = [
    outcome.applied.length ? `Applied ${labels(outcome.applied)}.` : '',
    outcome.proposed.length ? `Proposed ${labels(outcome.proposed)} for your review.` : '',
    outcome.move ? `Proposed moving to ${outcome.move}.` : '',
    outcome.notes ? 'Added hand-off notes.' : '',
    ...outcome.errors,
  ].filter(Boolean).join(' ') || 'The result block changed nothing.';
  store.laneRuns.update(ctx, run.id, { status: 'completed', reason: summary, result: outcome });
  return summary;
}
