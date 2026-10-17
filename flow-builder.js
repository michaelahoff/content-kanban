// Implements the flow builder's tools (flow-builder-tools.js) over the store:
// the project chat's agent reads a project and creates or changes its flows,
// lanes, playbooks, templates, skills and cards through these calls only.
// Every write goes through the same store methods the board uses, so the
// activity log, playbook files and template rules are the ones users get.
import { laneColors, flowKinds } from './store.js';
import { parseDocument, serializeDocument, playbookSettings, resolveRoutes, resolveCreates, resolveLaneTemplate, mapTemplate, describeSettings,
  maxDocumentLength, skillName, hasWork, maxCreatedCards } from './public/playbook-format.js';
import { libraryPaths } from './public/library-format.js';
import { contextFields, fieldKey } from './public/card-template.js';
import { builderTools } from './flow-builder-tools.js';
import { archivedMessage } from './store-chat.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const check = (value, message) => { if (!value) fail(400, message); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string' && value.length <= max;
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
// Settings a playbook spec may carry, in the order the file writes them.
const settingKeys = ['run', 'provider', 'model', 'conversation', 'context', 'may_edit', 'set', 'skills', 'assets', 'advance', 'routes', 'creates', 'action', 'publish', 'template'];
const textKeys = ['run', 'provider', 'model', 'conversation', 'advance', 'action', 'template'];
const listKeys = ['context', 'may_edit', 'skills', 'assets'];
const mapKeys = ['set', 'routes'];
// Nodes of a graph laid out by the builder sit this far apart.
const nodeSpacing = 380; const rowSpacing = 230;
const toolNames = new Set(builderTools.map((tool) => tool.name));

const findTemplate = (templates, nameOrId) => templates.find((template) => template.id === nameOrId) ?? templates.find((template) => same(template.name, nameOrId)) ?? null;
const findLane = (lanes, nameOrId) => lanes.find((lane) => lane.id === nameOrId) ?? lanes.find((lane) => same(lane.name, nameOrId)) ?? null;
const stringList = (value, key) => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null;
  check(list && list.every((entry) => typeof entry === 'string'), `${key} must be a list of text.`);
  return list.map((entry) => entry.trim()).filter(Boolean);
};
const stringMap = (value, key) => {
  check(isObject(value) && Object.values(value).every((entry) => typeof entry === 'string'), `${key} must be an object of text values.`);
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name.trim(), entry]));
};

// A playbook document from a spec: the settings block (lane first), with
// route, creates and template names resolved to IDs where they can be, and
// the Markdown body. It is read back the way a lane run reads it, against the
// card template it is written for, and refused with the problems when it
// would misbehave. `lanes` are the lanes routes may lead to ({ id, name });
// `skills` the skill names that exist (or will).
export function composePlaybook(spec, { laneId, lanes, templates, flowTemplate, skills, where, existingBody = '' }) {
  check(isObject(spec), `${where}: the playbook must be an object of settings and instructions.`);
  const unknown = Object.keys(spec).filter((key) => key !== 'instructions' && !settingKeys.includes(key));
  check(!unknown.length, `${where}: unknown playbook ${unknown.length === 1 ? 'setting' : 'settings'} ${unknown.join(', ')}. Settings are ${settingKeys.join(', ')} and instructions.`);
  const data = { lane: laneId };
  for (const key of settingKeys) {
    const value = spec[key];
    if (value === undefined || value === null) continue;
    if (textKeys.includes(key)) { check(typeof value === 'string', `${where}: ${key} must be text.`); if (value.trim()) data[key] = value.trim(); }
    else if (listKeys.includes(key)) { const list = stringList(value, `${where}: ${key}`); if (list.length) data[key] = list; }
    else if (mapKeys.includes(key)) { const entries = stringMap(value, `${where}: ${key}`); if (Object.keys(entries).length) data[key] = entries; }
    else if (key === 'creates') {
      check(isObject(value) && typeof value.lane === 'string' && typeof value.template === 'string', `${where}: creates needs a lane and a template.`);
      data.creates = { lane: findLane(lanes, value.lane)?.id ?? value.lane, template: findTemplate(templates, value.template)?.id ?? value.template };
    } else if (key === 'publish') {
      check(isObject(value) && typeof value.to === 'string' && Object.keys(value).every((entry) => ['to', 'url', 'field'].includes(entry) && (value[entry] === undefined || typeof value[entry] === 'string')), `${where}: publish takes to, url and field as text.`);
      data.publish = Object.fromEntries(['to', 'url', 'field'].filter((entry) => value[entry]?.trim()).map((entry) => [entry, value[entry].trim()]));
    }
  }
  if (data.routes) data.routes = Object.fromEntries(Object.entries(data.routes).map(([name, target]) => [name, findLane(lanes, target)?.id ?? target]));
  if (data.template) data.template = findTemplate(templates, data.template)?.id ?? data.template;
  // Fields named by label are written by key, as the settings form does; a
  // name that is no field stays, so the check below reports it.
  const editable = contextFields((data.template && findTemplate(templates, data.template)) || flowTemplate);
  if (data.may_edit) data.may_edit = [...new Set(data.may_edit.map((name) => fieldKey(editable, name) ?? name))];
  check(spec.instructions === undefined || typeof spec.instructions === 'string', `${where}: instructions must be Markdown text.`);
  const body = (spec.instructions ?? existingBody ?? '').replace(/\r\n?/g, '\n').trim();
  const text = serializeDocument(data, body ? `\n${body}\n` : '\n');
  check(text.length <= maxDocumentLength, `${where}: the playbook is longer than ${maxDocumentLength.toLocaleString('en-US')} characters.`);
  const own = resolveLaneTemplate(text, templates, flowTemplate);
  const settings = playbookSettings(parseDocument(text), own.template);
  const problems = [...(own.error ? [own.error] : []), ...settings.errors];
  for (const route of resolveRoutes(settings.routes, lanes, laneId)) {
    if (!route.laneName) problems.push(`routes: “${route.name}” leads to “${route.target}”, which is not a lane of this flow.`);
    else if (!route.laneId) problems.push(`routes: “${route.name}” leads back to this lane.`);
  }
  if (settings.creates) {
    const resolved = resolveCreates(settings.creates, lanes, templates);
    if (!resolved.lane) problems.push(`creates: “${settings.creates.lane}” is not a lane of this flow.`);
    if (!resolved.template) problems.push(`creates: “${settings.creates.template}” is not a card template.`);
  }
  for (const name of settings.skills) if (!skills.has(name)) problems.push(`skills: “${name}” has no file yet. Write it with the skills argument or write_skill.`);
  if (problems.length) fail(400, `${where}: ${problems.join(' ')}`);
  const warnings = [...settings.warnings];
  if (settings.run !== 'off' && !hasWork(settings)) warnings.push(`${where} has run: ${settings.run} but no instructions, so no agent runs there; only its set: values apply.`);
  return { text, settings, template: own.template, warnings };
}

// Nodes without a place: left to right by how far they are from the start
// lane along the routes, branches stacked below each other.
export function layoutGraph(lanes) {
  const index = new Map(lanes.map((lane, position) => [lane.name.toLowerCase(), position]));
  const level = lanes.map(() => null);
  if (lanes.length) level[0] = 0;
  const queue = lanes.length ? [0] : [];
  while (queue.length) {
    const from = queue.shift();
    for (const target of Object.values(lanes[from].playbook?.routes ?? {})) {
      const to = index.get(String(target).trim().toLowerCase());
      if (to === undefined || to === from || level[to] !== null) continue;
      level[to] = level[from] + 1; queue.push(to);
    }
  }
  let next = Math.max(-1, ...level.filter((value) => value !== null)) + 1;
  const rows = new Map();
  return lanes.map((lane, position) => {
    const column = level[position] ?? next++;
    const row = rows.get(column) ?? 0; rows.set(column, row + 1);
    return { ...lane, x: lane.x ?? column * nodeSpacing, y: lane.y ?? 40 + row * rowSpacing };
  });
}

export function createFlowBuilder({ store }) {
  const workspace = (ctx) => store.workspace(ctx);
  function requireProject(ctx, projectId, { write = true } = {}) {
    const project = workspace(ctx).projects.find((entry) => entry.id === projectId) || fail(404, 'This project no longer exists.');
    if (write && project.archivedAt) fail(409, archivedMessage);
    return project;
  }
  const flowsOf = (ctx, projectId) => workspace(ctx).flows.filter((flow) => flow.projectId === projectId);
  const requireFlow = (ctx, projectId, flowId) => flowsOf(ctx, projectId).find((flow) => flow.id === flowId) || fail(404, `There is no flow with the ID “${flowId}” in this project. Call read_project for the current IDs.`);
  function requireLane(ctx, projectId, laneId) {
    for (const flow of flowsOf(ctx, projectId)) {
      const lane = flow.stages.find((stage) => stage.id === laneId);
      if (lane) return { flow, lane };
    }
    return fail(404, `There is no lane with the ID “${laneId}” in this project. Call read_project for the current IDs.`);
  }
  const requireTemplate = (ctx, nameOrId) => findTemplate(store.templates.list(ctx), nameOrId) || fail(404, `There is no card template “${nameOrId}”.`);
  const skillNames = (flowId) => new Set(store.playbooks.list(flowId).skills.map((document) => document.path.slice('skills/'.length, -'.md'.length)));
  const cardsByLane = (ctx, projectId) => {
    const counts = new Map();
    for (const card of store.listCards(ctx, projectId)) counts.set(card.stageId, (counts.get(card.stageId) ?? 0) + 1);
    return counts;
  };
  // What read_project says about one flow's lanes, and the problems a build left.
  const laneView = (stage, counts) => ({ id: stage.id, name: stage.name, color: stage.color, position: stage.position, ...(stage.x === null ? {} : { x: stage.x, y: stage.y }), cardCount: counts.get(stage.id) ?? 0,
    playbook: stage.playbook && { path: stage.playbook.path, run: stage.playbook.run, provider: stage.playbook.provider, model: stage.playbook.model, hasInstructions: stage.playbook.hasInstructions,
      summary: stage.playbook.summary, advance: stage.playbook.advance, routes: stage.playbook.routes, action: stage.playbook.action, creates: stage.playbook.creates, errors: stage.playbook.errors } });
  function flowResult(ctx, projectId, flowId) {
    const flow = requireFlow(ctx, projectId, flowId);
    const counts = cardsByLane(ctx, projectId);
    const problems = [];
    for (const stage of flow.stages) {
      for (const message of stage.playbook?.errors ?? []) problems.push(`Lane “${stage.name}”: ${message}`);
      for (const route of stage.playbook?.routes ?? []) if (!route.laneId) problems.push(`Lane “${stage.name}”: the route “${route.name}” leads nowhere (${route.target}).`);
    }
    return { flow: { id: flow.id, name: flow.name, kind: flow.kind, templateId: flow.templateId, lanes: flow.stages.map((stage) => laneView(stage, counts)), skills: [...skillNames(flow.id)] }, problems };
  }
  function writeDocument(ctx, flowId, relative, text) {
    const current = store.playbooks.read(flowId, relative);
    if (current?.text === text) return current;
    const document = store.playbooks.write(flowId, relative, text, current?.hash ?? null);
    store.recordPlaybookChange(ctx, flowId, relative, 'playbook_saved');
    return document;
  }
  function writePlaybook(ctx, flow, stage, text) {
    const current = store.playbooks.forStage(flow.id, stage.id);
    const relative = current?.path ?? store.playbooks.freePath(flow.id, stage.name);
    const document = store.playbooks.write(flow.id, relative, text, current?.hash ?? null, { laneIds: store.workspace(ctx).flows.find((entry) => entry.id === flow.id).stages.map((entry) => entry.id) });
    store.recordPlaybookChange(ctx, flow.id, relative, 'playbook_saved');
    return document;
  }
  function removePlaybooks(ctx, flowId, laneIds) {
    for (const document of store.playbooks.lanes(flowId)) {
      if (!laneIds.includes(document.laneId)) continue;
      store.playbooks.remove(flowId, document.path, document.hash);
      store.recordPlaybookChange(ctx, flowId, document.path, 'playbook_deleted');
    }
  }
  // The lanes of a create_flow call, checked before anything is made.
  function planLanes(input, kind) {
    check(Array.isArray(input) && input.length >= 1 && input.length <= 100, 'lanes must be a list of one to 100 lanes.');
    const plan = input.map((lane, position) => {
      check(isObject(lane) && isText(lane.name, 100) && lane.name.trim(), `Lane ${position + 1} needs a name of up to 100 characters.`);
      const unknown = Object.keys(lane).filter((key) => !['name', 'color', 'x', 'y', 'playbook'].includes(key));
      check(!unknown.length, `Lane “${lane.name}”: unknown ${unknown.join(', ')}. A lane takes name, color, x, y and playbook.`);
      check(lane.color === undefined || laneColors.includes(lane.color), `Lane “${lane.name}”: color must be one of ${laneColors.join(', ')}.`);
      for (const axis of ['x', 'y']) check(lane[axis] === undefined || (typeof lane[axis] === 'number' && Number.isFinite(lane[axis])), `Lane “${lane.name}”: ${axis} must be a number.`);
      return { name: lane.name.trim(), color: lane.color ?? laneColors[position % laneColors.length], x: lane.x, y: lane.y, playbook: lane.playbook ?? null };
    });
    for (const [position, lane] of plan.entries()) check(!plan.slice(0, position).some((other) => same(other.name, lane.name)), `Two lanes are called “${lane.name}”. Give each lane its own name.`);
    return kind === 'graph' ? layoutGraph(plan) : plan.map((lane) => ({ ...lane, x: undefined, y: undefined }));
  }
  function templateInput(input) {
    check(isObject(input), 'A template needs a name and fields.');
    const fields = Array.isArray(input.fields) ? input.fields.map((field) => {
      if (!isObject(field)) return field;
      const { hidden, ...rest } = field;
      return hidden === true ? { ...rest, editor: false } : rest;
    }) : input.fields;
    return { name: input.name, title: input.title, fields, imageRoles: input.imageRoles ?? [] };
  }
  const templateView = (template) => ({ id: template.id, name: template.name, builtin: template.builtin, title: template.title,
    fields: template.fields.map(({ editor, ...field }) => ({ ...field, ...(editor === false ? { hidden: true } : {}) })), imageRoles: template.imageRoles, cardCount: template.cardCount, flowCount: template.flowCount });

  const tools = {
    read_project(ctx, projectId) {
      const project = requireProject(ctx, projectId, { write: false });
      const counts = cardsByLane(ctx, projectId);
      const listing = store.library.list(ctx, projectId);
      const paths = libraryPaths(listing);
      const providers = ['codex', 'claude'].map((provider) => {
        const { selection } = store.providerConfiguration(ctx, provider);
        const models = store.providerCatalog(ctx, provider).discovery?.models ?? [];
        return { provider, enabled: selection.enabled ?? provider === 'codex', models: models.map((model) => model.id), defaultModel: models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null };
      });
      return {
        project: { id: project.id, name: project.name, archived: Boolean(project.archivedAt) },
        flows: flowsOf(ctx, projectId).map((flow) => ({ id: flow.id, name: flow.name, kind: flow.kind, templateId: flow.templateId, cardCount: flow.cardCount,
          lanes: flow.stages.map((stage) => laneView(stage, counts)), skills: [...skillNames(flow.id)] })),
        templates: store.templates.list(ctx).map(templateView),
        library: { files: listing.assets.slice(0, 200).map((asset) => ({ source: `asset:${asset.id}`, path: paths.assets.get(asset.id) })),
          folders: listing.folders.slice(0, 200).map((folder) => ({ source: `folder:${folder.id}`, path: paths.folders.get(folder.id) })) },
        providers,
      };
    },
    read_flow(ctx, projectId, input) {
      check(isObject(input) && typeof input.flowId === 'string', 'read_flow needs a flowId.');
      const flow = requireFlow(ctx, projectId, input.flowId);
      const templates = store.templates.list(ctx);
      const flowTemplate = store.templates.get(flow.templateId) ?? templates[0];
      const listing = store.playbooks.list(flow.id);
      return {
        id: flow.id, name: flow.name, kind: flow.kind, templateId: flow.templateId, map: listing.map?.text ?? '',
        lanes: flow.stages.map((stage) => {
          const document = listing.lanes.find((entry) => entry.laneId === stage.id);
          if (!document) return { id: stage.id, name: stage.name, color: stage.color, playbook: null };
          const own = resolveLaneTemplate(document.text, templates, flowTemplate);
          const { errors, warnings, selections, lane: _lane, ...settings } = playbookSettings(parseDocument(document.text), own.template);
          return { id: stage.id, name: stage.name, color: stage.color, playbook: { path: document.path, text: document.text, settings, errors: [...(own.error ? [own.error] : []), ...errors], warnings } };
        }),
        skills: listing.skills.map((document) => ({ name: document.path.slice('skills/'.length, -'.md'.length), text: document.text })),
      };
    },
    read_template(ctx, projectId, input) {
      check(isObject(input) && typeof input.templateId === 'string', 'read_template needs a templateId.');
      return templateView(requireTemplate(ctx, input.templateId));
    },
    create_flow(ctx, projectId, input) {
      check(isObject(input), 'create_flow needs lanes.');
      requireProject(ctx, projectId);
      const existing = input.flowId === undefined ? null : requireFlow(ctx, projectId, input.flowId);
      if (existing?.cardCount) fail(409, `“${existing.name}” holds ${existing.cardCount} ${existing.cardCount === 1 ? 'card' : 'cards'}, so it cannot be rebuilt. Create a new flow, or move its cards first.`);
      const kind = input.kind ?? existing?.kind ?? 'board';
      check(flowKinds.includes(kind), `kind must be ${flowKinds.join(' or ')}.`);
      const name = String(input.name ?? existing?.name ?? '').trim();
      check(name && name.length <= 100, 'A new flow needs a name of up to 100 characters.');
      const templates = store.templates.list(ctx);
      const template = input.templateId === undefined ? (existing ? store.templates.get(existing.templateId) : null) ?? store.templates.get(store.templates.defaultId(ctx)) : requireTemplate(ctx, input.templateId);
      check(input.map === undefined || (typeof input.map === 'string' && input.map.length <= maxDocumentLength), 'map must be Markdown text.');
      const skillsInput = input.skills === undefined ? {} : stringMap(input.skills, 'skills');
      for (const [skill, text] of Object.entries(skillsInput)) check(skillName.test(skill) && text.length <= maxDocumentLength, `Skill names use letters, numbers, - and _ (“${skill}”), and a skill is up to ${maxDocumentLength.toLocaleString('en-US')} characters.`);
      const skills = new Set([...(existing ? skillNames(existing.id) : []), ...Object.keys(skillsInput)]);
      const plan = planLanes(input.lanes, kind);
      // Every playbook is checked against the planned lanes before any write.
      const planned = plan.map((lane, position) => ({ id: `planned-${position}`, name: lane.name }));
      const warnings = [];
      plan.forEach((lane, position) => {
        if (!lane.playbook) return;
        warnings.push(...composePlaybook(lane.playbook, { laneId: planned[position].id, lanes: planned, templates, flowTemplate: template, skills, where: `Lane “${lane.name}”` }).warnings);
      });
      // Build: the flow row, then its lanes from scratch.
      const flowId = existing ? existing.id : store.createFlow(ctx, projectId, { name, kind, templateId: template.id }).id;
      const before = store.workspace(ctx).flows.find((flow) => flow.id === flowId).stages;
      removePlaybooks(ctx, flowId, before.map((stage) => stage.id));
      for (const stage of before) store.deleteStage(ctx, stage.id);
      if (existing) {
        if (existing.kind !== kind) store.convertFlow(ctx, flowId, { kind });
        if (existing.name !== name || existing.templateId !== template.id) store.updateFlow(ctx, flowId, { name, templateId: template.id });
      }
      const created = plan.map((lane) => store.createStage(ctx, flowId, { name: lane.name, color: lane.color, ...(lane.x === undefined ? {} : { x: lane.x, y: lane.y ?? 40 }) }));
      const lanes = created.map((stage) => ({ id: stage.id, name: stage.name }));
      const flow = { id: flowId };
      for (const [skill, text] of Object.entries(skillsInput)) writeDocument(ctx, flowId, `skills/${skill}.md`, text);
      plan.forEach((lane, position) => {
        if (!lane.playbook) return;
        writePlaybook(ctx, flow, created[position], composePlaybook(lane.playbook, { laneId: created[position].id, lanes, templates, flowTemplate: template, skills, where: `Lane “${lane.name}”` }).text);
      });
      const routes = kind === 'graph' ? new Map(plan.map((lane, position) => [created[position].id,
        Object.entries(lane.playbook?.routes ?? {}).map(([routeName, target]) => ({ name: routeName, to: findLane(lanes, target)?.name ?? target }))])) : null;
      writeDocument(ctx, flowId, 'MAP.md', input.map ?? mapTemplate(name, lanes, template, routes));
      const result = flowResult(ctx, projectId, flowId);
      return { ...result, problems: [...result.problems, ...warnings], ...(existing ? { rebuilt: true } : { created: true }) };
    },
    update_flow(ctx, projectId, input) {
      check(isObject(input) && typeof input.flowId === 'string', 'update_flow needs a flowId.');
      requireProject(ctx, projectId);
      const flow = requireFlow(ctx, projectId, input.flowId);
      const changes = {};
      if (input.name !== undefined) changes.name = input.name;
      if (input.templateId !== undefined) changes.templateId = requireTemplate(ctx, input.templateId).id;
      if (Object.keys(changes).length) store.updateFlow(ctx, flow.id, changes);
      if (input.kind !== undefined) { check(flowKinds.includes(input.kind), `kind must be ${flowKinds.join(' or ')}.`); store.convertFlow(ctx, flow.id, { kind: input.kind }); }
      return flowResult(ctx, projectId, flow.id);
    },
    delete_flow(ctx, projectId, input) {
      check(isObject(input) && typeof input.flowId === 'string', 'delete_flow needs a flowId.');
      requireProject(ctx, projectId);
      const flow = requireFlow(ctx, projectId, input.flowId);
      if (flow.cardCount) fail(409, `“${flow.name}” holds ${flow.cardCount} ${flow.cardCount === 1 ? 'card' : 'cards'}. Move or delete them first, or ask the user to delete the flow from the board.`);
      store.deleteFlow(ctx, flow.id);
      return { deleted: flow.name };
    },
    create_lane(ctx, projectId, input) {
      check(isObject(input) && typeof input.flowId === 'string' && isText(input.name, 100) && input.name.trim(), 'create_lane needs a flowId and a name.');
      requireProject(ctx, projectId);
      const flow = requireFlow(ctx, projectId, input.flowId);
      check(!flow.stages.some((stage) => same(stage.name, input.name)), `“${flow.name}” already has a lane called “${input.name.trim()}”.`);
      const color = input.color ?? laneColors[flow.stages.length % laneColors.length];
      check(laneColors.includes(color), `color must be one of ${laneColors.join(', ')}.`);
      let place = {};
      if (flow.kind === 'graph') {
        for (const axis of ['x', 'y']) check(input[axis] === undefined || (typeof input[axis] === 'number' && Number.isFinite(input[axis])), `${axis} must be a number.`);
        place = { x: input.x ?? Math.max(-nodeSpacing, ...flow.stages.map((stage) => stage.x ?? 0)) + nodeSpacing, y: input.y ?? 40 };
      }
      const stage = store.createStage(ctx, flow.id, { name: input.name.trim(), color, ...place });
      if (input.position !== undefined) { check(Number.isInteger(input.position) && input.position >= 0, 'position must be a whole number, 0 first.'); store.updateStage(ctx, stage.id, { position: input.position }); }
      const warnings = [];
      if (input.playbook !== undefined) {
        const current = store.workspace(ctx).flows.find((entry) => entry.id === flow.id);
        const composed = composePlaybook(input.playbook, { laneId: stage.id, lanes: current.stages, templates: store.templates.list(ctx), flowTemplate: store.templates.get(flow.templateId), skills: skillNames(flow.id), where: `Lane “${stage.name}”` });
        writePlaybook(ctx, flow, stage, composed.text);
        warnings.push(...composed.warnings);
      }
      const result = flowResult(ctx, projectId, flow.id);
      return { lane: result.flow.lanes.find((lane) => lane.id === stage.id), problems: [...result.problems, ...warnings] };
    },
    update_lane(ctx, projectId, input) {
      check(isObject(input) && typeof input.laneId === 'string', 'update_lane needs a laneId.');
      requireProject(ctx, projectId);
      const { flow, lane } = requireLane(ctx, projectId, input.laneId);
      const changes = {};
      for (const key of ['name', 'color', 'x', 'y', 'position']) if (input[key] !== undefined) changes[key] = input[key];
      check(Object.keys(changes).length, 'Give a name, color, x, y or position to change.');
      if (changes.name !== undefined) check(!flow.stages.some((stage) => stage.id !== lane.id && same(stage.name, changes.name)), `“${flow.name}” already has a lane called “${changes.name}”.`);
      store.updateStage(ctx, lane.id, changes);
      const result = flowResult(ctx, projectId, flow.id);
      return { lane: result.flow.lanes.find((entry) => entry.id === lane.id), problems: result.problems };
    },
    delete_lane(ctx, projectId, input) {
      check(isObject(input) && typeof input.laneId === 'string', 'delete_lane needs a laneId.');
      requireProject(ctx, projectId);
      const { flow, lane } = requireLane(ctx, projectId, input.laneId);
      const cards = store.listCards(ctx, projectId).filter((card) => card.stageId === lane.id);
      if (cards.length && input.moveCardsTo === undefined) fail(409, `“${lane.name}” holds ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}. Name a lane in moveCardsTo to move them first, or ask the user.`);
      if (input.moveCardsTo !== undefined) {
        const target = requireLane(ctx, projectId, input.moveCardsTo).lane;
        check(target.id !== lane.id, 'moveCardsTo must be another lane.');
        for (const card of cards) store.transitionCard(ctx, card.id, { action: 'move', toStageId: target.id });
      }
      removePlaybooks(ctx, flow.id, [lane.id]);
      store.deleteStage(ctx, lane.id);
      return { deleted: lane.name, movedCards: cards.length, ...flowResult(ctx, projectId, flow.id) };
    },
    write_playbook(ctx, projectId, input) {
      check(isObject(input) && typeof input.laneId === 'string', 'write_playbook needs a laneId and a playbook.');
      requireProject(ctx, projectId);
      const { flow, lane } = requireLane(ctx, projectId, input.laneId);
      const current = store.playbooks.forStage(flow.id, lane.id);
      const composed = composePlaybook(input.playbook, { laneId: lane.id, lanes: flow.stages, templates: store.templates.list(ctx), flowTemplate: store.templates.get(flow.templateId), skills: skillNames(flow.id),
        where: `Lane “${lane.name}”`, existingBody: current ? parseDocument(current.text).body : '' });
      const document = writePlaybook(ctx, flow, lane, composed.text);
      return { path: document.path, summary: describeSettings(composed.settings, composed.template), problems: [...composed.warnings, ...flowResult(ctx, projectId, flow.id).problems] };
    },
    set_routes(ctx, projectId, input) {
      check(isObject(input) && typeof input.laneId === 'string', 'set_routes needs a laneId and routes.');
      requireProject(ctx, projectId);
      const { flow, lane } = requireLane(ctx, projectId, input.laneId);
      const routes = Object.entries(stringMap(input.routes ?? {}, 'routes')).map(([name, target]) => {
        const to = findLane(flow.stages, target) || fail(400, `routes: “${name}” leads to “${target}”, which is not a lane of “${flow.name}”.`);
        return { name, to: to.id };
      });
      const { stages } = store.setRoutes(ctx, lane.id, { routes, baseHash: lane.playbook?.hash ?? null, ...(input.advance ? { advance: input.advance } : {}) });
      const saved = stages.find((stage) => stage.id === lane.id);
      return { routes: saved.playbook.routes.map((route) => ({ name: route.name, to: stages.find((stage) => stage.id === route.laneId)?.name ?? route.target })), advance: saved.playbook.advance };
    },
    write_map(ctx, projectId, input) {
      check(isObject(input) && typeof input.flowId === 'string' && typeof input.text === 'string' && input.text.length <= maxDocumentLength, 'write_map needs a flowId and Markdown text.');
      requireProject(ctx, projectId);
      const flow = requireFlow(ctx, projectId, input.flowId);
      return { path: writeDocument(ctx, flow.id, 'MAP.md', input.text).path };
    },
    write_skill(ctx, projectId, input) {
      check(isObject(input) && typeof input.flowId === 'string' && typeof input.name === 'string' && typeof input.text === 'string' && input.text.length <= maxDocumentLength, 'write_skill needs a flowId, a name and Markdown text.');
      check(skillName.test(input.name), 'Skill names use letters, numbers, - and _ (up to 80).');
      requireProject(ctx, projectId);
      const flow = requireFlow(ctx, projectId, input.flowId);
      return { path: writeDocument(ctx, flow.id, `skills/${input.name}.md`, input.text).path };
    },
    delete_skill(ctx, projectId, input) {
      check(isObject(input) && typeof input.flowId === 'string' && typeof input.name === 'string' && skillName.test(input.name), 'delete_skill needs a flowId and a skill name.');
      requireProject(ctx, projectId);
      const flow = requireFlow(ctx, projectId, input.flowId);
      const document = store.playbooks.read(flow.id, `skills/${input.name}.md`) || fail(404, `“${flow.name}” has no skill named “${input.name}”.`);
      store.playbooks.remove(flow.id, document.path, document.hash);
      store.recordPlaybookChange(ctx, flow.id, document.path, 'playbook_deleted');
      return { deleted: document.path };
    },
    create_template(ctx, projectId, input) {
      requireProject(ctx, projectId);
      return templateView(store.templates.create(ctx, templateInput(input)));
    },
    update_template(ctx, projectId, input) {
      check(isObject(input) && typeof input.templateId === 'string', 'update_template needs a templateId.');
      requireProject(ctx, projectId);
      const current = requireTemplate(ctx, input.templateId);
      const { templateId: _, ...rest } = input;
      return templateView(store.templates.update(ctx, current.id, { ...templateInput({ name: current.name, title: current.title, imageRoles: current.imageRoles, ...rest }), revision: current.revision }));
    },
    delete_template(ctx, projectId, input) {
      check(isObject(input) && typeof input.templateId === 'string', 'delete_template needs a templateId.');
      requireProject(ctx, projectId);
      const template = requireTemplate(ctx, input.templateId);
      store.templates.remove(ctx, template.id);
      return { deleted: template.name };
    },
    create_cards(ctx, projectId, input) {
      check(isObject(input) && typeof input.laneId === 'string' && Array.isArray(input.cards) && input.cards.length >= 1 && input.cards.length <= maxCreatedCards, `create_cards needs a laneId and one to ${maxCreatedCards} cards.`);
      requireProject(ctx, projectId);
      const { lane } = requireLane(ctx, projectId, input.laneId);
      for (const [index, card] of input.cards.entries()) check(isObject(card) && typeof card.title === 'string' && card.title.trim() && (card.fields === undefined || isObject(card.fields)), `Card ${index + 1} needs a title and, optionally, fields.`);
      const created = input.cards.map((card) => store.createCard(ctx, projectId, { stageId: lane.id, title: card.title.trim(), fields: card.fields ?? {} }));
      return { lane: lane.name, cards: created.map((card) => ({ id: card.id, title: card.title })) };
    },
  };
  return {
    tools: builderTools,
    // One tool call. Problems are thrown with a status and a message the
    // agent can act on; the worker turns them into a failed tool result.
    call(ctx, projectId, name, input = {}) {
      if (!toolNames.has(name) || !tools[name]) fail(400, `Unknown Frameboard tool “${name}”.`);
      check(isObject(input), 'Tool arguments must be an object.');
      return tools[name](ctx, projectId, input);
    },
  };
}

// What the agent is told about the project at the top of every message:
// enough to act on a simple request without a read_project call.
export function projectSummary(store, ctx, projectId) {
  const workspace = store.workspace(ctx);
  const project = workspace.projects.find((entry) => entry.id === projectId);
  if (!project) return '';
  const templates = new Map(store.templates.list(ctx).map((template) => [template.id, template.name]));
  const flows = workspace.flows.filter((flow) => flow.projectId === projectId);
  const lanes = (flow) => flow.stages.map((stage) => `${stage.name} (${stage.id}${stage.playbook?.hasInstructions ? stage.playbook.run === 'on-enter' ? ', runs on entry' : `, run: ${stage.playbook.run}` : ''})`).join(flow.kind === 'graph' ? ', ' : ' → ');
  return [`## Project “${project.name}” (${project.id}) right now`, '',
    ...flows.map((flow) => `- Flow “${flow.name}” (${flow.kind}, id ${flow.id}, template “${templates.get(flow.templateId) ?? flow.templateId}”, ${flow.cardCount} ${flow.cardCount === 1 ? 'card' : 'cards'}): ${lanes(flow) || 'no lanes'}`),
    `- Card templates: ${[...templates].map(([id, name]) => `“${name}” (${id})`).join(', ')}`].join('\n');
}
