// Protected card mutations share the board transaction and history boundary.
import { randomUUID } from 'node:crypto';
import { templates } from './public/card-template.js';

export const protectionMigration = `
  ALTER TABLE cards ADD COLUMN placement_version INTEGER NOT NULL DEFAULT 1;
  INSERT INTO card_field_versions SELECT id, 'images', revision FROM cards;
  INSERT INTO card_field_versions SELECT id, 'imageRoles', revision FROM cards;
  CREATE TRIGGER protection_created AFTER INSERT ON cards BEGIN
    INSERT INTO card_field_versions VALUES (NEW.id, 'images', 1);
    INSERT INTO card_field_versions VALUES (NEW.id, 'imageRoles', 1);
  END;
  CREATE TRIGGER protection_changed AFTER UPDATE ON cards BEGIN
    UPDATE cards SET placement_version = placement_version + 1 WHERE id = NEW.id
      AND (NEW.stage_id != OLD.stage_id OR NEW.position != OLD.position);
    UPDATE card_field_versions SET version = version + 1 WHERE card_id = NEW.id
      AND ((field = 'images' AND NEW.images != OLD.images) OR (field = 'imageRoles' AND NEW.image_roles != OLD.image_roles));
  END;
  CREATE TABLE card_proposals (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id),
    attempt_id TEXT NOT NULL REFERENCES chat_attempts(id), kind TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
  CREATE TABLE card_tool_calls (attempt_id TEXT NOT NULL REFERENCES chat_attempts(id), call_id TEXT NOT NULL,
    tool TEXT NOT NULL, arguments TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (attempt_id, call_id));
`;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const check = (value, message) => { if (!value) fail(400, message); };
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function createProtectionStore({ all, get, run, transaction, requireCard, retainedCard, recordChange, now, updateCard, transitionCard, item, registerOutput }) {
  const leases = new Map();
  const reviews = new Map();
  const versions = (id) => Object.fromEntries(all('SELECT field, version FROM card_field_versions WHERE card_id = ?', id).map((r) => [r.field, r.version]));
  function leased(cardId, field, except = null) {
    const time = Date.parse(now());
    for (const [key, lease] of leases) {
      if (lease.expires <= time) { leases.delete(key); continue; }
      if (lease.cardId === cardId && lease.owner !== except && lease.fields.includes(field)) return true;
    }
    return false;
  }
  function provenance(a, accepted) {
    const submission = get('SELECT * FROM chat_submissions WHERE id = ?', a.submission_id);
    return { cardId: a.card_id, attemptId: a.id, submissionId: submission.id, conversationId: submission.conversation_id,
      turnId: a.turn_id, origin: 'manual', accepted };
  }
  function proposal(ctx, a, kind, payload) {
    const id = randomUUID();
    run('INSERT INTO card_proposals (id, card_id, attempt_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, a.card_id, a.id, kind, JSON.stringify(payload), now());
    recordChange({ ...ctx, actor: `automation:${a.id}` }, 'chat', a.card_id, 'proposal_created', { projectId: retainedCard(ctx, a.card_id).project_id, data: { proposalId: id, ...provenance(a, false) } });
    return id;
  }
  function validateFields(card, fields, bases) {
    check(object(fields) && Object.keys(fields).length > 0 && object(bases), 'Fields and their base versions are required.');
    for (const [key, value] of Object.entries(fields)) {
      const field = key === 'title' ? templates[card.template].title : templates[card.template].fields.find((f) => f.key === key);
      check(field && typeof value === 'string' && value.length <= field.max && Number.isInteger(bases[key]) && bases[key] > 0, `Invalid field or base version: ${key}.`);
    }
  }
  function applyFields(ctx, card, fields, a, accepted) {
    const before = Object.fromEntries(Object.keys(fields).map((k) => [k, k === 'title' ? card.title : card.fields[k]]));
    const mutationContext = { ...ctx, actor: accepted ? ctx.actor : `automation:${a.id}` };
    const result = updateCard(mutationContext, card.id, {
      revision: card.revision, ...(Object.hasOwn(fields, 'title') ? { title: fields.title } : {}),
      fields: Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'title')) });
    recordChange(mutationContext, 'card', card.id, 'card_fields_applied', { projectId: card.projectId, data: { ...provenance(a, accepted), before, after: fields } });
    return result;
  }
  const api = {
    versions, leased,
    lease(ctx, cardId, input) {
      const card = requireCard(ctx, cardId);
      check(object(input) && typeof input.owner === 'string' && /^[\w-]{1,100}$/.test(input.owner) && Array.isArray(input.fields), 'A draft lease needs its tab identity and fields.');
      const allowed = ['title', ...templates[card.template].fields.map((f) => f.key), 'images', 'imageRoles'];
      check(input.fields.length <= allowed.length && input.fields.every((f) => allowed.includes(f)), 'Invalid draft fields.');
      const key = `${cardId}:${input.owner}`;
      check(input.sequence === undefined || Number.isInteger(input.sequence) && input.sequence > 0, 'Invalid draft heartbeat sequence.');
      const old = leases.get(key);
      if (input.sequence !== undefined && old && input.sequence <= old.sequence) return { expiresInMs: Math.max(0, old.expires - Date.parse(now())) };
      leases.set(key, { cardId, owner: input.owner, sequence: input.sequence ?? (old?.sequence ?? 0) + 1,
        fields: [...new Set(input.fields)], expires: Date.parse(now()) + 5000 });
      return { expiresInMs: 5000 };
    },
    proposals(ctx, cardId) {
      retainedCard(ctx, cardId);
      return all('SELECT * FROM card_proposals WHERE card_id = ? ORDER BY rowid', cardId).map((r) => ({ id: r.id, attemptId: r.attempt_id, kind: r.kind, payload: JSON.parse(r.payload), status: r.status, createdAt: r.created_at }));
    },
    receipt(ctx, attemptId, callId, tool, input) {
      const a = get('SELECT * FROM chat_attempts WHERE id = ?', attemptId);
      check(a, 'Invalid originating attempt.'); retainedCard(ctx, a.card_id);
      const row = get('SELECT * FROM card_tool_calls WHERE attempt_id = ? AND call_id = ?', attemptId, callId);
      if (!row) return null;
      if (row.tool !== tool || row.arguments !== JSON.stringify(input)) fail(409, 'This tool call identity already has a different payload.');
      return JSON.parse(row.result);
    },
    previewProposal(ctx, cardId, id) {
      const card = requireCard(ctx, cardId);
      const row = get('SELECT * FROM card_proposals WHERE id = ? AND card_id = ?', id, cardId);
      if (!row || row.status !== 'pending') fail(409, 'This proposal is no longer pending.');
      const payload = JSON.parse(row.payload);
      const baseVersions = versions(cardId); const reviewId = randomUUID(); const time = Date.parse(now());
      for (const [key, value] of reviews) if (value.expires <= time) reviews.delete(key);
      reviews.set(reviewId, { id, cardId, payload: row.payload, baseVersions, placementVersion: card.placementVersion, expires: time + 300000 });
      return { reviewId, baseVersions, placementVersion: card.placementVersion, payload,
        before: Object.fromEntries(Object.keys(payload.fields ?? {}).map((key) => [key, key === 'title' ? card.title : card.fields[key]])), fromStageId: card.stageId };
    },
    tool(ctx, attemptId, callId, tool, input, artifact = null) {
      return transaction(() => {
        const a = get('SELECT * FROM chat_attempts WHERE id = ?', attemptId);
        check(a && typeof callId === 'string' && callId.length <= 200 && object(input), 'Invalid originating tool call.');
        retainedCard(ctx, a.card_id);
        if (Object.keys(input).some((key) => ['cardId', 'card_id', 'attemptId', 'attempt_id'].includes(key))) fail(403, 'Card tools cannot target another card or attempt.');
        const old = get('SELECT * FROM card_tool_calls WHERE attempt_id = ? AND call_id = ?', a.id, callId);
        if (old) {
          if (old.tool !== tool || old.arguments !== JSON.stringify(input)) fail(409, 'This tool call identity already has a different payload.');
          return JSON.parse(old.result);
        }
        if (!['dispatching', 'accepted', 'running'].includes(a.status)) fail(409, 'This attempt no longer has card-tool authority.');
        const card = requireCard(ctx, a.card_id);
        let result;
        if (tool === 'read_card') result = { card, fieldVersions: versions(card.id), placementVersion: card.placementVersion,
          lanes: all('SELECT s.id, s.name FROM stages s JOIN projects p ON p.flow_id = s.flow_id WHERE p.id = ? AND s.deleted_at IS NULL ORDER BY s.position', card.projectId) };
        else if (tool === 'edit_fields' || tool === 'propose_changes') {
          const submission = JSON.parse(get('SELECT frozen FROM chat_submissions WHERE id = ?', a.submission_id).frozen);
          const bases = input.baseVersions ?? Object.fromEntries(submission.context.fields.map((f) => [f.key, f.version]));
          validateFields(card, input.fields, bases);
          // A model may re-read newer values but cannot manufacture a version
          // newer than the currently saved field to defeat a conflict check.
          const current = versions(card.id); const applied = {}; const proposed = {};
          for (const [key, value] of Object.entries(input.fields)) {
            if (tool === 'edit_fields' && submission.authority.fields.includes(key) && bases[key] === current[key] && !leased(card.id, key)) applied[key] = value;
            else proposed[key] = value;
          }
          if (Object.keys(applied).length) applyFields(ctx, card, applied, a, false);
          const proposalId = Object.keys(proposed).length ? proposal(ctx, a, 'fields', { fields: proposed, baseVersions: Object.fromEntries(Object.keys(proposed).map((key) => [key, bases[key]])) }) : null;
          result = { applied: Object.keys(applied), proposalId };
        } else if (tool === 'propose_move') {
          check(typeof input.toStageId === 'string', 'Choose a destination lane.');
          const target = get('SELECT s.id FROM stages s JOIN projects p ON p.flow_id = s.flow_id WHERE p.id = ? AND s.id = ? AND s.deleted_at IS NULL', card.projectId, input.toStageId);
          check(target, 'Choose a lane in this project.');
          result = { proposalId: proposal(ctx, a, 'move', { toStageId: input.toStageId, placementVersion: card.placementVersion, fieldVersions: versions(card.id) }) };
        } else if (tool === 'register_image' && artifact) {
          const output = registerOutput(ctx, a.id, callId, artifact);
          item(ctx, a.id, { id: `registered-${callId}`, kind: 'registeredImage', text: output.name, data: output, completed: true });
          result = { image: { id: output.imageId, hash: output.hash, name: output.name }, outputId: output.id, adopted: false };
        } else fail(400, 'Unknown card tool.');
        run('INSERT INTO card_tool_calls VALUES (?, ?, ?, ?, ?)', a.id, callId, tool, JSON.stringify(input), JSON.stringify(result));
        recordChange({ ...ctx, actor: `automation:${a.id}` }, 'chat', a.card_id, 'card_tool_called', { projectId: card.projectId, data: { tool, callId, ...provenance(a, false) } });
        return result;
      });
    },
    accept(ctx, cardId, id, input) {
      return transaction(() => {
        const card = requireCard(ctx, cardId);
        const row = get('SELECT * FROM card_proposals WHERE id = ? AND card_id = ?', id, cardId);
        if (!row || row.status !== 'pending') fail(409, 'This proposal is no longer pending.');
        check(object(input), 'Acceptance needs a reviewed selection.');
        const payload = JSON.parse(row.payload); const a = get('SELECT * FROM chat_attempts WHERE id = ?', row.attempt_id);
        if (input.reject === true) {
          run("UPDATE card_proposals SET status = 'rejected' WHERE id = ?", id);
          recordChange(ctx, 'chat', cardId, 'proposal_rejected', { projectId: card.projectId, data: { proposalId: id, ...provenance(a, true) } });
          return { ok: true };
        }
        const current = versions(cardId);
        const review = input.reviewId ? reviews.get(input.reviewId) : null;
        if (input.reviewId && (!review || review.id !== id || review.cardId !== cardId || review.payload !== row.payload || review.expires <= Date.parse(now()))) fail(409, 'This preview is no longer current. Review again.');
        const reviewedVersions = review?.baseVersions ?? payload.baseVersions ?? payload.fieldVersions;
        if (row.kind === 'move') {
          if (input.placementVersion !== card.placementVersion || (review?.placementVersion ?? payload.placementVersion) !== card.placementVersion) fail(409, 'The card moved after this proposal. Review its current placement.');
          for (const [key, version] of Object.entries(reviewedVersions)) if (current[key] !== version || leased(cardId, key)) fail(409, 'The card changed or has an unsaved draft. Review before moving.');
          transitionCard(ctx, cardId, { action: 'move', toStageId: payload.toStageId });
          run("UPDATE card_proposals SET status = 'accepted' WHERE id = ?", id);
        } else {
          check(Array.isArray(input.fields) && input.fields.length && new Set(input.fields).size === input.fields.length && input.fields.every((k) => Object.hasOwn(payload.fields, k)), 'Choose proposal fields to accept.');
          for (const key of input.fields) if (input.baseVersions?.[key] !== current[key] || reviewedVersions[key] !== current[key] || leased(cardId, key)) fail(409, 'A proposed field changed or has an unsaved draft. Review a new preview before accepting.');
          applyFields(ctx, card, Object.fromEntries(input.fields.map((k) => [k, payload.fields[k]])), a, true);
          for (const key of input.fields) { delete payload.fields[key]; delete payload.baseVersions[key]; }
          run('UPDATE card_proposals SET payload = ?, status = ? WHERE id = ?', JSON.stringify(payload), Object.keys(payload.fields).length ? 'pending' : 'accepted', id);
        }
        recordChange(ctx, 'chat', cardId, 'proposal_accepted', { projectId: card.projectId, data: { proposalId: id, ...provenance(a, true) } });
        return { card: requireCard(ctx, cardId) };
      });
    },
    previewAcceptance(ctx, cardId, input) {
      const card = requireCard(ctx, cardId);
      check(object(input) && typeof input.text === 'string' && ['replace', 'append'].includes(input.mode), 'Select reply text and Replace or Append.');
      const item = get('SELECT i.* FROM chat_items i JOIN chat_attempts a ON a.id = i.attempt_id WHERE i.sequence = ? AND a.card_id = ?', input.itemSequence, cardId);
      check(item && item.kind === 'agentMessage' && item.text.includes(input.text) && input.text.length, 'Select text from this card’s retained reply.');
      const before = input.field === 'title' ? card.title : card.fields[input.field];
      const value = input.mode === 'append' ? before + input.text : input.text;
      const bases = versions(cardId);
      validateFields(card, { [input.field]: value }, bases);
      return { field: input.field, before, value, version: bases[input.field], itemSequence: input.itemSequence, sourceText: item.text };
    },
    acceptText(ctx, cardId, input) {
      return transaction(() => {
        const preview = this.previewAcceptance(ctx, cardId, input);
        if (input.version !== preview.version || input.value !== preview.value || input.sourceText !== preview.sourceText || leased(cardId, input.field)) fail(409, 'The reply or destination changed, or has an unsaved draft. Preview again.');
        const item = get('SELECT attempt_id FROM chat_items WHERE sequence = ?', input.itemSequence);
        const a = get('SELECT * FROM chat_attempts WHERE id = ?', item.attempt_id);
        return { card: applyFields(ctx, requireCard(ctx, cardId), { [input.field]: preview.value }, a, true) };
      });
    },
  };
  return api;
}
