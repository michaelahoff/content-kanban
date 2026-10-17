// Turns pending lane runs into card chat submissions. A run reads its flow's
// map, its lane playbook, the skills it names and the card's hand-off notes,
// and freezes all of it into one prompt. The chat worker delivers it.
import { composeLanePrompt, parseLaneResult, setFields, parseDocument, playbookSettings, resolveRoutes, resolveCreates, findRoute, maxAutomaticMoves, hasWork } from './public/playbook-format.js';
import { submissionText } from './public/chat-context.js';
import { problemMessage } from './submission-inputs.js';
import { uniqueSources } from './public/library-format.js';

const providerName = (provider) => (provider === 'claude' ? 'Claude' : 'Codex');
// The Library sources a run sends: its playbook's, then the card's own. A
// source both name is sent once, in the playbook's place.
export const laneAssets = (settings, card) => uniqueSources([...settings.assets, ...card.library ?? []]);

export function createLaneRunner({ store, service, providers, ctx, paused = () => false, publisher = null }) {
  let draining = false; let again = false; let closed = false; let scheduled = null;
  const waitingForChat = new Set();

  // Everything a run would send, without queueing it. Also used for previews.
  function prepare(card, stage, project, stages, trigger) {
    const template = store.templates.forCard(card);
    const found = store.playbooks.settings(project.flowId, stage.id, template);
    if (!found) return { error: `${stage.name} has no lane playbook.` };
    const { document, settings } = found;
    if (settings.errors.length) return { error: `The playbook ${document.path} has errors: ${settings.errors.join(' ')}`, document, settings };
    if (!hasWork(settings)) return { error: 'This lane playbook has no instructions to run.', document, settings };
    // creates: names a lane of this flow and a live card template (ADR 0010).
    // A run whose lane or template is not found fails rather than guessing.
    const creates = settings.creates ? resolveCreates(settings.creates, stages, store.templates.list(ctx)) : null;
    if (creates && !creates.lane) return { error: `creates: the lane “${settings.creates.lane}” is not in this flow.`, document, settings };
    if (creates && !creates.template) return { error: `creates: there is no card template named “${settings.creates.template}”.`, document, settings };
    const chat = store.chats.laneConversation(ctx, card.id);
    const provider = settings.provider ?? chat.composer.provider ?? chat.provider ?? 'codex';
    const discovery = store.providerCatalog(ctx, provider).discovery;
    const model = settings.model ?? (chat.composer.provider === provider ? chat.composer.model : null)
      ?? discovery?.models.find((entry) => entry.isDefault)?.id ?? discovery?.models[0]?.id ?? null;
    const map = store.playbooks.read(project.flowId, 'MAP.md');
    const skills = settings.skills.map((name) => store.playbooks.skill(project.flowId, name));
    const notes = store.playbooks.notes(card.id);
    const prompt = composeLanePrompt({ projectName: project.name, flowName: project.flowName, laneName: stage.name, lanes: stages, trigger, map, playbook: document,
      skills, notes: notes.text, settings, template, routes: resolveRoutes(settings.routes, stages, stage.id), creates });
    return { document, settings, chat, provider, model, map, skills, notes, prompt, assets: laneAssets(settings, card), creates,
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

  // What a prepared run sends, from saved files, settings, the Library sources
  // it names (the card's among them) and the target. The card's content, its
  // conversation, provider settings and the sources' current files are checked
  // by the commit itself.
  const preparedParts = (prepared) => ({ playbook: prepared.document?.hash, map: prepared.map?.hash ?? null,
    skills: prepared.skills.map((skill) => [skill.name, skill.hash ?? null]), notes: prepared.notes.hash,
    target: [prepared.provider, prepared.model], prompt: prepared.prompt, assets: prepared.assets,
    creates: [prepared.creates?.lane.id ?? null, prepared.creates?.template.id ?? null] });
  const partNames = { playbook: 'lane playbook', map: 'flow map', skills: 'named skills', notes: 'hand-off notes', target: 'provider and model', prompt: 'project, flow and lane names', assets: 'Library files',
    creates: 'created-card settings' };
  const listed = new Intl.ListFormat('en', { type: 'conjunction' });
  const conflict = (message) => Object.assign(new Error(message), { status: 409 });
  const closedRun = () => Object.assign(new Error('This lane run was cancelled while it was being prepared.'), { status: 409, code: 'lane-run-closed' });
  const changedWhilePreparing = (error) => error.status === 409 && /changed while preparing/.test(error.message);
  // A different provider, or conversation: fresh, needs empty fresh context.
  const needsFresh = ({ chat, settings, provider }) => chat.used && (settings.conversation === 'fresh' || chat.provider !== provider) || chat.state !== 'active';
  // Preparations in a row before a run whose inputs keep changing fails visibly.
  const maxPreparations = 5;
  const finish = (run, status, reason) => store.laneRuns.update(ctx, run.id, { status, reason });

  async function start(run) {
    for (let attempt = 1; ; attempt += 1) {
      try { return await prepareAndQueue(run); }
      catch (error) {
        if (closed || error.code === 'lane-run-closed') return;
        if (!changedWhilePreparing(error)) return finish(run, 'failed', error.message);
        // Prepare again from what is saved now; the run is still pending.
        if (attempt === maxPreparations) {
          return finish(run, 'failed', `${error.message} This run's inputs changed during ${maxPreparations} preparations in a row, so nothing was queued. Run playbook when they are settled.`);
        }
      }
    }
  }

  async function prepareAndQueue(run) {
    const end = (status, reason) => finish(run, status, reason);
    let info = current(run);
    if (!info) return;
    const trigger = run.trigger === 'manual' ? 'manual' : 'enter';
    const enabled = (settings) => settings.run !== 'off' && (trigger === 'manual' || settings.run === 'on-enter');
    const cancelDisabled = () => end('cancelled', 'The playbook was turned off or its trigger changed before this run started.');
    if (waitingForChat.has(run.id)) {
      if (store.chats.laneConversation(ctx, run.cardId).busy) {
        // Everything else is read when the chat is free; turning the
        // playbook off or to manual ends a waiting automatic run now.
        const saved = store.playbooks.settings(info.project.flowId, info.stage.id, store.templates.forCard(info.card));
        if (saved && !saved.settings.errors.length && !enabled(saved.settings)) { waitingForChat.delete(run.id); return cancelDisabled(); }
        return;
      }
      waitingForChat.delete(run.id);
    }
    let prepared = prepare(info.card, info.stage, info.project, info.stages, trigger);
    if (prepared.error) return end('failed', prepared.error);
    if (!enabled(prepared.settings)) return cancelDisabled();
    // A lane action needs no provider, model or conversation (ADR 0011).
    if (prepared.settings.action === 'publish') return performPublish(run, info, prepared);
    // Models are listed once and saved; list them now if that never happened.
    if (!prepared.model && !store.providerCatalog(ctx, prepared.provider).discovery && providers) {
      await providers.refresh(ctx, prepared.provider);
      if (closed || !(info = current(run))) return;
      prepared = prepare(info.card, info.stage, info.project, info.stages, trigger);
      if (prepared.error) return end('failed', prepared.error);
      if (!enabled(prepared.settings)) return cancelDisabled();
    }
    if (!prepared.model) return end('failed', prepared.warning);
    const { card, stage } = info;
    const { chat, settings, provider, assets } = prepared;
    // Fresh context waits until the card chat has nothing running or queued.
    if (needsFresh(prepared)) {
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
    // saved input and the target must be what was prepared. A Send into
    // the conversation since needs fresh context again.
    const confirm = () => {
      const now = current(run);
      if (!now) throw closedRun();
      const latest = prepare(now.card, now.stage, now.project, now.stages, trigger);
      if (latest.error) { end('failed', latest.error); throw closedRun(); }
      if (!enabled(latest.settings)) { cancelDisabled(); throw closedRun(); }
      if (needsFresh(latest)) throw conflict('The card chat changed while preparing the lane run.');
      const [before, after] = [preparedParts(prepared), preparedParts(latest)];
      const differs = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
      // The prompt holds the documents; name it only for a lane, flow or project rename.
      const changed = differs.length > 1 ? differs.filter((key) => key !== 'prompt') : differs;
      if (changed.length) throw conflict(`The ${listed.format(changed.map((key) => partNames[key]))} changed while preparing the lane run.`);
    };
    // queueLane links the run and its submission in one commit.
    const submission = await service.queueLane(ctx, card.id, { id: `lane-${run.id}`, prompt: prepared.prompt, provider, model: prepared.model,
      selections: settings.selections, assets, authority: { fields: settings.mayEdit }, confirm,
      lane: { runId: run.id, stageId: stage.id, stageName: stage.name, trigger: run.trigger, entry: store.laneRuns.entry(card.id),
        playbook: { ...prepared.document }, map: prepared.map && { ...prepared.map },
        skills: prepared.skills.map(({ name, path, hash, text }) => ({ name, path, hash: hash ?? null, text })),
        notesHash: prepared.notes.hash, notesText: prepared.notes.text } });
    if (!submission.lane || submission.lane.runId !== run.id) end('failed', 'A different submission already uses this lane run’s ID.');
  }

  // The publish lane action: Frameboard copies the card's saved outputs to a
  // site itself, outside the agent boundary. What follows (the address in a
  // field, hand-off notes, the lane's first route) applies only while the run
  // is still pending in this lane, as the action's own automatic edits.
  async function performPublish(run, info, prepared) {
    const end = (status, reason) => finish(run, status, reason);
    if (!publisher) return end('failed', 'Publishing is not available in this build.');
    // The lane before may still be saving its reply's outputs (its attempt
    // ends after they are saved, possibly after its route moved the card):
    // they are part of the post, so publishing waits until the chat is free.
    if (prepared.chat.busy) {
      waitingForChat.add(run.id);
      const reason = 'Waiting for the card chat to finish before publishing.';
      if (run.reason !== reason) store.laneRuns.update(ctx, run.id, { status: 'pending', reason });
      return;
    }
    const { settings } = prepared;
    try {
      let result;
      try { result = await publisher.publish({ store, ctx, card: info.card, settings, run }); }
      catch (error) { if (!closed) end('failed', error.status ? error.message : `Could not publish: ${error.message}`); return; }
      if (closed) return;
      const now = current(run);
      if (!now) return;
      const { stage, stages, project } = now;
      // With its field versions, which an edit is based on.
      const { card } = store.getCard(ctx, run.cardId);
      const template = store.templates.forCard(card);
      const automation = { ...ctx, actor: `automation:publish:${run.id}` };
      const label = (key) => setFields(template).find((field) => field.key === key)?.label ?? key;
      const said = [result.message];
      let route = null; let toStageId = null;
      if (result.status === 'published') {
        const field = settings.publish.field;
        if (field && !result.url) said.push(`${label(field)} was left as it is: this site has no url: in the publish settings, so there is no address to put there.`);
        else if (field && (field === 'title' ? card.title : card.fields[field]) !== result.url) {
          if (store.protection.leased(card.id, field)) said.push(`${label(field)} has unsaved edits, so the address was not put there.`);
          else try {
            const saved = store.updateCard(automation, card.id, { changes: { [field]: result.url }, baseVersions: { [field]: card.fieldVersions[field] } });
            said.push(saved.conflicts?.includes(field) ? `${label(field)} changed while publishing, so the address was not put there.` : `Put the address in ${label(field)}.`);
          } catch (error) {
            if (!error.status) throw error;
            said.push(`The address was not put in ${label(field)}: ${error.message}`);
          }
        }
        try {
          const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
          store.playbooks.appendNotes(card.id, `${stage.name} · ${stamp} UTC`, `${result.message}\n\nFiles: ${result.files.join(', ')}.`);
        } catch (error) { said.push(`Hand-off notes could not be saved: ${error.message}`); }
        // advance: auto follows the first route that leads somewhere, with
        // followRoute's guards: the playbook still says so now, nobody is
        // editing the card, and it has not looped too often.
        const found = settings.advance === 'auto' ? resolveRoutes(settings.routes, stages, stage.id).find((item) => item.laneId) : null;
        const target = found && stages.find((item) => item.id === found.laneId);
        if (target) {
          const latest = store.playbooks.settings(project.flowId, stage.id, template);
          const editing = Object.keys(card.fieldVersions ?? {}).some((key) => store.protection.leased(card.id, key));
          const held = latest?.settings.advance !== 'auto' ? 'This lane no longer moves cards on by itself.'
            : editing ? 'The card has unsaved edits.'
              : store.laneRuns.automaticMoves(card.id) >= maxAutomaticMoves ? `It made ${maxAutomaticMoves} automatic moves in a row, so this one waits for you.` : null;
          route = { name: found.name, to: target.name, followed: !held, ...(held ? { held } : {}) };
          toStageId = target.id;
          said.push(held ? `Left the card here rather than following ${found.name} to ${target.name}. ${held}` : `Followed ${found.name} to ${target.name}.`);
        }
      }
      const status = result.status === 'published' ? 'completed' : 'failed';
      try {
        // The run completes before the move, which cancels the card's pending runs.
        store.transaction(() => {
          store.laneRuns.update(ctx, run.id, { status, reason: said.join(' '), result: { publish: result, route } });
          if (route?.followed) store.transitionCard(automation, card.id, { action: 'move', toStageId, route: route.name });
        });
      } catch (error) {
        if (!route?.followed) throw error;
        route = { ...route, followed: false, held: error.message };
        said[said.length - 1] = `Could not follow ${route.name} to ${route.to}: ${error.message}`;
        store.laneRuns.update(ctx, run.id, { status, reason: said.join(' '), result: { publish: result, route } });
      }
    } catch (error) { if (!closed) end('failed', error.message); }
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
      const captured = prepared.prompt ? await service.previewLane(ctx, cardId, { selections: prepared.settings.selections, assets: prepared.assets,
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

// The route a lane result chose, from the routes of the playbook the run
// froze. With advance: auto the card moves along it at once, as the agent's
// move, and the next lane's playbook runs; otherwise, or when the card has
// left the lane, is being edited or has looped too often, the move waits for
// the user as a proposal.
function followRoute({ store, ctx, attempt, submission, run, card, template, name, outcome }) {
  const settings = playbookSettings(parseDocument(submission.lane.playbook?.text ?? ''), template);
  const { stage: lane, stages } = store.laneRuns.context(ctx, run.id);
  const route = findRoute(resolveRoutes(settings.routes, stages, run.stageId), name);
  const names = settings.routes.map((item) => `“${item.name}”`).join(', ');
  if (!route) return outcome.errors.push(`Ignored the route “${name}”: ${names ? `this lane's routes are ${names}` : 'this lane has no routes'}.`);
  const target = stages.find((stage) => stage.id === route.laneId);
  if (!target) return outcome.errors.push(`Ignored the route “${route.name}”: the node it led to no longer exists.`);
  if (target.id === card.stageId) return outcome.errors.push(`Ignored the route “${route.name}”: the card is already in ${target.name}.`);
  const editing = Object.keys(card.fieldVersions ?? {}).some((key) => store.protection.leased(card.id, key));
  // Moving on by itself also needs the lane's playbook to say so now: a flow
  // turned into a board, or a lane set back to review, stops a run in flight.
  const now = store.playbooks.settings(lane.flowId, lane.id, template);
  const held = settings.advance !== 'auto' ? null
    : card.stageId !== run.stageId || store.laneRuns.entry(card.id) !== submission.lane.entry ? 'The card left this lane before the run finished.'
      : now?.settings.advance !== 'auto' ? 'This lane no longer moves cards on by itself.'
        : editing ? 'The card has unsaved edits.'
          : store.laneRuns.automaticMoves(card.id) >= maxAutomaticMoves ? `It made ${maxAutomaticMoves} automatic moves in a row, so this one waits for you.` : null;
  if (settings.advance === 'auto' && !held) {
    store.transitionCard({ ...ctx, actor: `automation:${attempt.id}` }, card.id, { action: 'move', toStageId: target.id, route: route.name });
    outcome.route = { name: route.name, to: target.name, followed: true };
  } else {
    store.protection.tool(ctx, attempt.id, 'lane-result-route', 'propose_move', { toStageId: target.id, route: route.name });
    outcome.route = { name: route.name, to: target.name, followed: false, ...(held ? { held } : {}) };
  }
}

// Applies the result block of a completed lane run reply, through the same
// card tools and authority checks as any card chat, then saves its declared
// documents and workspace files while the attempt still holds authority. Each save has its own
// outcome, separate from the card effects. Returns a summary line.
export async function applyLaneResult({ store, ctx, attempt, submission, text }) {
  const run = store.laneRuns.bySubmission(submission.id);
  if (!run || run.status !== 'queued') return null;
  const live = store.chats.attempt(attempt.id);
  if (!live || !['dispatching', 'accepted', 'running'].includes(live.status)) throw new Error('This attempt no longer has card-tool authority.');
  const card = store.getCard(ctx, submission.cardId).card;
  const template = store.templates.forCard(card);
  // The cards this run may create (ADR 0010): the creates: setting of the
  // playbook text it froze, resolved against its flow's lanes and the live
  // card templates now. `missing` says which part is gone since it started.
  const frozen = playbookSettings(parseDocument(submission.lane.playbook?.text ?? ''), template).creates;
  const creates = frozen ? resolveCreates(frozen, store.laneRuns.context(ctx, run.id).stages, store.templates.list(ctx)) : null;
  const missing = !creates ? null : !creates.lane ? `the lane “${frozen.lane}” named by creates: is no longer in this flow`
    : !creates.template ? `there is no card template named “${frozen.template}” any more` : null;
  const result = parseLaneResult(text, template, { creates });
  const outcome = { applied: [], proposed: [], move: null, route: null, cards: [], notes: false, outputs: [], errors: [] };
  store.transaction(() => {
    if (!result) outcome.errors.push('The reply had no frameboard-result block, so nothing was applied.');
    else {
      // parseLaneResult cannot tell which part of creates: was not found; say so here.
      outcome.errors.push(...result.errors.map((message) => (missing && message.startsWith('Ignored “cards”: this lane does not create cards') ? `Ignored “cards”: ${missing}.` : message)));
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
      if (result.cards.length) {
        // Creating cards is authority the playbook grants, used while this
        // attempt still holds it. createCards checks everything before its
        // first write, so a refusal leaves the rest of the result to apply.
        if (store.chats.revocation(attempt.id)) outcome.errors.push('Created no cards: this attempt was stopped or its project archived.');
        else try {
          const created = store.createCards({ ...ctx, actor: `automation:${attempt.id}` },
            { parentId: card.id, stageId: creates.lane.id, templateId: creates.template.id, cards: result.cards, laneRunId: run.id });
          outcome.cards = created.map(({ id, title }) => ({ id, title }));
        } catch (error) {
          if (!error.status) throw error;
          outcome.errors.push(`Created no cards: ${error.message}`);
        }
      }
      if (result.route) followRoute({ store, ctx, attempt, submission, run, card, template, name: result.route, outcome });
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
  const automation = { ...ctx, actor: `automation:${attempt.id}` };
  for (const [index, output] of (result?.outputs ?? []).entries()) {
    try {
      const save = output.path === undefined ? store.savedOutputs.saveDocument : store.savedOutputs.saveFile;
      const saved = await save(automation, submission.cardId, { operationId: `lane:${attempt.id}:${index}`, attemptId: attempt.id,
        filename: output.filename, text: output.text, path: output.path, creationMethod: 'lane-result', sources: output.sources, requireLive: true });
      outcome.outputs.push({ filename: saved.filename, status: saved.status, outputId: saved.id, ...(saved.error ? { error: saved.error } : {}) });
    } catch (error) { outcome.outputs.push({ filename: output.filename, status: 'failed', error: error.message }); }
  }
  const saved = outcome.outputs.filter((output) => output.status === 'saved').map((output) => output.filename);
  const labels = (keys) => keys.map((key) => setFields(template).find((field) => field.key === key)?.label ?? key).join(', ');
  const summary = [
    outcome.applied.length ? `Applied ${labels(outcome.applied)}.` : '',
    outcome.proposed.length ? `Proposed ${labels(outcome.proposed)} for your review.` : '',
    outcome.move ? `Proposed moving to ${outcome.move}.` : '',
    outcome.route ? (outcome.route.followed ? `Followed ${outcome.route.name} to ${outcome.route.to}.` : `Proposed following ${outcome.route.name} to ${outcome.route.to} for your review.${outcome.route.held ? ` ${outcome.route.held}` : ''}`) : '',
    outcome.cards.length ? `Created ${outcome.cards.length} ${outcome.cards.length === 1 ? 'card' : 'cards'} in ${creates.lane.name}.` : '',
    outcome.notes ? 'Added hand-off notes.' : '',
    saved.length ? `Saved ${new Intl.ListFormat('en', { type: 'conjunction' }).format(saved)}.` : '',
    ...outcome.outputs.filter((output) => output.status !== 'saved').map((output) => `${output.filename} was not saved. ${output.error}`),
    ...outcome.errors,
  ].filter(Boolean).join(' ') || 'The result block changed nothing.';
  store.laneRuns.update(ctx, run.id, { status: 'completed', reason: summary, result: outcome });
  return summary;
}
