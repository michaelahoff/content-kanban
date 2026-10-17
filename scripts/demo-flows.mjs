#!/usr/bin/env node
// Installs the demo flows under demo/<flow>/ into a running Frameboard over its
// HTTP API, or checks them without a server. The manifest format is described
// in docs/implementation/demo-flows.md.
//
//   node scripts/demo-flows.mjs [--base http://127.0.0.1:3000] [--only <flow-dir-name>]
//     [--replace] [--check] [demo]
//
// Standard library only, plus the playbook and card template modules the app
// itself uses, so `--check` reads playbooks exactly as the server will.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, playbookSettings, withSetting, resolveRoutes, resolveCreates } from '../public/playbook-format.js';
import { validateTemplate, youtubeVideoTemplate, templateIdPattern, roleKey } from '../public/card-template.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultBase = 'http://127.0.0.1:3000';

// Lane colors and flow kinds as store.js accepts them. test/demo-flows.test.js
// compares this list with store.js, so a new color there fails the test here.
export const laneColors = ['lavender', 'blue', 'amber', 'green', 'pink', 'gray', 'teal', 'cyan', 'orange', 'red', 'purple', 'lime'];
const flowKinds = ['board', 'graph'];
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };
// Playbook documents are written as lanes/<name>.md and skills/<name>.md.
const documentName = /^[a-z0-9][a-z0-9_-]{0,79}\.md$/i;
const maxCanvas = 1e6;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const asList = (value) => (Array.isArray(value) ? value : []);
const asEntry = (value) => (isObject(value) ? value : { invalid: true });
const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// --- Reading a flow folder -------------------------------------------------
// A file named by the manifest: where it is, or why it cannot be used.
function locate(root, relative) {
  if (typeof relative !== 'string' || !relative.trim()) return { file: typeof relative === 'string' ? relative : undefined, absolute: null, problem: 'name a file.' };
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(root + path.sep)) return { file: relative, absolute, problem: 'the file must be inside the flow folder.' };
  try {
    return { file: relative, absolute, problem: statSync(absolute).isFile() ? null : 'is not a file.' };
  } catch (error) {
    return { file: relative, absolute, problem: error.code === 'ENOENT' ? 'file not found.' : `cannot be read (${error.code ?? error.message}).` };
  }
}
// A document named by the manifest, with its text.
function load(root, relative) {
  const found = locate(root, relative);
  if (found.problem) return { ...found, text: null };
  try { return { ...found, text: readFileSync(found.absolute, 'utf8') }; }
  catch (error) { return { ...found, text: null, problem: `cannot be read (${error.code ?? error.message}).` }; }
}

// Loads demo/<flow>/flow.json and the files it names. A missing referenced
// file is not an error here: its entry has `text: null` and a `problem`, which
// checkFlow reports. Only a missing or malformed flow.json throws.
export function readFlow(dir) {
  const root = path.resolve(dir);
  let manifest;
  try { manifest = JSON.parse(readFileSync(path.join(root, 'flow.json'), 'utf8')); }
  catch (error) { throw new Error(`${path.join(root, 'flow.json')}: ${error.code === 'ENOENT' ? 'flow.json is missing.' : error.message}`); }
  if (!isObject(manifest)) throw new Error(`${path.join(root, 'flow.json')}: the manifest must be a JSON object.`);
  const remote = (folder, file) => `${folder}/${path.basename(String(file))}`;
  return {
    dir: root, name: path.basename(root), manifest,
    project: manifest.project,
    flow: { name: isObject(manifest.flow) ? manifest.flow.name ?? null : null, kind: isObject(manifest.flow) ? manifest.flow.kind ?? 'graph' : 'graph' },
    templates: asList(manifest.templates).map(asEntry),
    template: manifest.template ?? null,
    map: manifest.map === undefined ? null : load(root, manifest.map),
    skills: asList(manifest.skills).map((file) => ({ ...load(root, file), path: remote('skills', file) })),
    nodes: asList(manifest.nodes).map(asEntry).map((node) => ({ ...node, playbook: node.playbook === undefined ? null : { ...load(root, node.playbook), path: remote('lanes', node.playbook) } })),
    cards: asList(manifest.cards).map(asEntry).map((card) => ({ ...card,
      images: asList(card.images).map((image) => {
        const entry = typeof image === 'string' ? { file: image } : asEntry(image);
        return entry.invalid ? { file: undefined, problem: 'must be an object with a file.' } : { file: entry.file, roles: entry.roles, ...locate(root, entry.file) };
      }) })),
  };
}

// --- Checking a flow without a server --------------------------------------
// Returns { errors, warnings }: lists of readable lines. Errors would make the
// installed flow misbehave or the install fail; warnings are playbook notes.
export function checkFlow(dir) {
  const errors = []; const warnings = [];
  const bad = (where, message) => errors.push(`${where}: ${message}`);
  const warn = (where, message) => warnings.push(`${where}: ${message}`);
  let flow;
  try { flow = readFlow(dir); } catch (error) { return { errors: [error.message], warnings }; }
  const { manifest } = flow;

  if (typeof flow.project !== 'string' || !flow.project.trim() || flow.project.trim().length > 150) bad('project', 'name the project (up to 150 characters).');
  if (manifest.flow !== undefined && !isObject(manifest.flow)) bad('flow', 'must be an object with a name and a kind.');
  else {
    if (!flowKinds.includes(flow.flow.kind)) bad('flow.kind', `must be ${flowKinds.join(' or ')}.`);
    if (flow.flow.name !== null && (typeof flow.flow.name !== 'string' || !flow.flow.name.trim() || flow.flow.name.trim().length > 100)) bad('flow.name', 'a flow name is up to 100 characters.');
  }

  // Card templates: the manifest's own, then the built-in one every workspace has.
  const definitions = new Map([[youtubeVideoTemplate.id, youtubeVideoTemplate]]);
  const seenTemplates = new Set();
  flow.templates.forEach((raw, index) => {
    const at = `templates[${index}]`;
    if (raw.invalid) return bad(at, 'must be a card template object.');
    if (typeof raw.id !== 'string' || !templateIdPattern.test(raw.id)) return bad(at, 'needs an "id" of lowercase letters, numbers and - (up to 60); the installer matches templates by id.');
    if (seenTemplates.has(raw.id)) return bad(`template ${raw.id}`, 'its id is used twice.');
    seenTemplates.add(raw.id);
    const { template, errors: problems } = validateTemplate(raw);
    for (const message of problems) bad(`template ${raw.id}`, message);
    if (template) definitions.set(raw.id, { id: raw.id, ...template });
  });
  if (flow.template !== null && typeof flow.template !== 'string') bad('template', 'must be the id of a card template.');
  const flowTemplateId = typeof flow.template === 'string' ? flow.template : youtubeVideoTemplate.id;
  if (typeof flow.template === 'string' && !definitions.has(flow.template) && !seenTemplates.has(flow.template)) {
    bad('template', `“${flow.template}” is not in "templates" and is not the built-in ${youtubeVideoTemplate.id}.`);
  }
  const flowTemplate = definitions.get(flowTemplateId) ?? null;
  const templateChoices = [...definitions.values()].map((template) => ({ id: template.id, name: template.name }));

  // Documents.
  if (flow.map?.problem) bad(`map ${flow.map.file}`, flow.map.problem);
  const skillFiles = new Map();
  flow.skills.forEach((skill, index) => {
    if (skill.problem) return bad(`skills[${index}] ${skill.file}`, skill.problem);
    if (!documentName.test(path.basename(skill.file))) return bad(skill.file, 'skill file names are letters, numbers, - and _, ending in .md.');
    if (skillFiles.has(skill.path)) return bad(skill.file, `another skill is also called ${skill.path}.`);
    skillFiles.set(skill.path, skill);
  });

  // Nodes: names, colors, positions and playbook files.
  const lanes = [];
  const playbookPaths = new Map();
  flow.nodes.forEach((node, index) => {
    const at = `nodes[${index}]`;
    if (node.invalid) return bad(at, 'must be an object with a name, color and playbook.');
    const label = typeof node.name === 'string' && node.name.trim() ? `node ${node.name}` : at;
    if (typeof node.name !== 'string' || !node.name.trim() || node.name.trim().length > 100) bad(at, 'a node needs a name (up to 100 characters).');
    else if (lanes.some((lane) => sameName(lane.name, node.name))) bad(label, 'another node has the same name.');
    else lanes.push({ id: `node:${index}`, name: node.name.trim() });
    if (!laneColors.includes(node.color)) bad(label, `color must be one of ${laneColors.join(', ')}.`);
    for (const axis of ['x', 'y']) {
      if (node[axis] !== undefined && !(typeof node[axis] === 'number' && Number.isFinite(node[axis]) && Math.abs(node[axis]) <= maxCanvas)) bad(label, `${axis} must be a number.`);
    }
    if (flow.flow.kind === 'graph' && (node.x === undefined || node.y === undefined)) warn(label, 'has no x and y, so it is placed at the canvas origin.');
    if (node.playbook) {
      if (node.playbook.problem) bad(`${label} playbook ${node.playbook.file}`, node.playbook.problem);
      else if (!documentName.test(path.basename(node.playbook.file))) bad(node.playbook.file, 'playbook file names are letters, numbers, - and _, ending in .md.');
      else if (playbookPaths.has(node.playbook.path)) bad(node.playbook.file, `is also the playbook of ${playbookPaths.get(node.playbook.path)}; each node needs its own file (they install as ${node.playbook.path}).`);
      else playbookPaths.set(node.playbook.path, label);
    }
  });
  if (!flow.nodes.length) bad('nodes', 'a flow needs at least one node.');
  const laneOf = (name) => lanes.find((lane) => sameName(lane.name, name)) ?? null;

  // Playbooks, read as the server reads them.
  for (const node of flow.nodes) {
    if (node.invalid || !node.playbook?.text) continue;
    const own = laneOf(node.name);
    const where = node.playbook.file;
    if (!flowTemplate) { warn(where, 'not checked against a card template because the flow template is unusable.'); continue; }
    const settings = playbookSettings(parseDocument(node.playbook.text), flowTemplate);
    for (const message of settings.errors) bad(where, message);
    for (const message of settings.warnings) warn(where, message);
    // The installer sets lane: with the same patch, so it must apply cleanly.
    try { withSetting(node.playbook.text, 'lane', 'check'); } catch (error) { bad(where, `the installer cannot set lane: ${error.message}`); }
    for (const route of resolveRoutes(settings.routes, lanes, own?.id)) {
      if (!route.laneName) bad(where, `routes: “${route.name}” leads to “${route.target}”, which is not a node of this flow.`);
      else if (!route.laneId) bad(where, `routes: “${route.name}” leads back to its own node, which leads nowhere.`);
    }
    if (settings.creates) {
      const resolved = resolveCreates(settings.creates, lanes, templateChoices);
      if (!resolved.lane) bad(where, `creates: lane “${settings.creates.lane}” is not a node of this flow.`);
      if (!resolved.template) bad(where, `creates: template “${settings.creates.template}” is not in "templates" and is not ${youtubeVideoTemplate.id}.`);
    }
    for (const name of settings.skills) if (!skillFiles.has(`skills/${name}.md`)) bad(where, `skills: “${name}” has no file in "skills" (expected skills/${name}.md).`);
  }

  // Cards.
  flow.cards.forEach((card, index) => {
    const at = `cards[${index}]`;
    if (card.invalid) return bad(at, 'must be an object with a node, title and fields.');
    const label = typeof card.title === 'string' && card.title.trim() ? `card “${card.title.trim().slice(0, 40)}”` : at;
    if (typeof card.node !== 'string' || !laneOf(card.node)) bad(label, `node “${card.node}” is not a node of this flow.`);
    const templateId = card.template ?? flowTemplateId;
    const template = typeof templateId === 'string' ? definitions.get(templateId) : null;
    if (!template) return bad(label, `template “${templateId}” is not in "templates" and is not ${youtubeVideoTemplate.id}.`);
    if (card.title !== undefined && (typeof card.title !== 'string' || card.title.length > template.title.max)) bad(label, `title must be text of up to ${template.title.max} characters.`);
    if (card.title === undefined && card.youtube === undefined) warn(label, 'has no title.');
    if (card.fields !== undefined && !isObject(card.fields)) bad(label, '"fields" must be an object of field values.');
    else for (const [key, value] of Object.entries(card.fields ?? {})) {
      const field = template.fields.find((item) => item.key === key);
      if (!field) bad(label, `field “${key}” is not in template ${template.id} (${template.fields.map((item) => item.key).join(', ') || 'no fields'}).`);
      else if (typeof value !== 'string' || value.length > field.max) bad(label, `field “${key}” must be text of up to ${field.max.toLocaleString('en-US')} characters.`);
    }
    if (card.youtube !== undefined) {
      const field = typeof card.youtube === 'string' ? template.fields.find((item) => item.key === card.youtube) : null;
      if (!field) bad(label, `youtube: “${card.youtube}” is not a field of template ${template.id}.`);
      else if (field.control !== 'url') bad(label, `youtube: “${field.key}” is not a url field.`);
      else if (typeof card.fields?.[field.key] !== 'string' || !card.fields[field.key].trim()) bad(label, `youtube: field “${field.key}” needs the video URL in "fields".`);
    }
    if (asList(manifest.cards)[index].images !== undefined && !Array.isArray(asList(manifest.cards)[index].images)) bad(label, '"images" must be a list.');
    const claimed = new Map();
    for (const image of card.images) {
      const name = image.file ?? '(no file)';
      if (image.problem) bad(label, `image ${name}: ${image.problem}`);
      else if (!imageTypes[path.extname(image.absolute).toLowerCase()]) bad(label, `image ${name}: use a ${Object.keys(imageTypes).join(', ')} file.`);
      if (image.roles !== undefined && !Array.isArray(image.roles)) { bad(label, `image ${name}: "roles" must be a list.`); continue; }
      for (const role of image.roles ?? []) {
        const key = typeof role === 'string' ? roleKey(template, role) : null;
        if (!key) bad(label, `image ${name}: “${role}” is not an image role of template ${template.id} (${template.imageRoles.map((item) => item.key).join(', ') || 'none'}, cover).`);
        else if (claimed.has(key)) bad(label, `image ${name}: the role “${key}” is already given to ${claimed.get(key)}.`);
        else claimed.set(key, name);
      }
    }
  });
  return { errors, warnings };
}

// --- HTTP ------------------------------------------------------------------
export async function request(base, method, route, body, contentType) {
  const raw = Buffer.isBuffer(body);
  let response;
  try {
    response = await fetch(`${base.replace(/\/+$/, '')}${route}`, { method,
      headers: body === undefined ? {} : { 'Content-Type': raw ? contentType : 'application/json' },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  } catch (error) {
    throw new Error(`Could not reach Frameboard at ${base} (${error.cause?.code ?? error.message}). Start it with "npm start", or pass --base.`);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* Not JSON: reported below if the request failed. */ }
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status}): ${data?.error ?? (text.slice(0, 200) || response.statusText)}`);
  return data;
}

// --- Installing a flow -----------------------------------------------------
// Returns { project, flow, stages, cards, problems }, or { skipped: true, ... }
// when the project exists and `replace` is not set. Problems are things that
// were installed but will not work as written (a route that leads nowhere);
// anything that stops the install throws with the server's message.
export async function installFlow(base, dir, { replace = false, log = () => {} } = {}) {
  const flow = readFlow(dir);
  const { errors } = checkFlow(dir);
  if (errors.length) throw new Error(`${flow.name} has problems, so nothing was installed:\n${errors.map((line) => `  - ${line}`).join('\n')}`);
  const say = (message) => log(`${flow.name}: ${message}`);
  const api = (method, route, body, contentType) => request(base, method, route, body, contentType);
  const problems = [];
  const projectName = flow.project.trim();

  const workspace = await api('GET', '/api/workspace');
  const existing = workspace.projects.find((project) => sameName(project.name, projectName));
  if (existing) {
    if (!replace) {
      say(`project “${projectName}” already exists; skipped (use --replace to delete and reinstall it).`);
      const current = workspace.flows.find((item) => item.projectId === existing.id) ?? null;
      return { skipped: true, project: existing, flow: current, stages: current?.stages ?? [], cards: [], problems };
    }
    if (existing.archivedAt) await api('POST', `/api/projects/${existing.id}/unarchive`);
    await api('DELETE', `/api/projects/${existing.id}`);
    say(`deleted the existing project “${projectName}”.`);
  }

  // Templates are matched by id and left alone when they exist.
  const templates = new Map(workspace.templates.map((template) => [template.id, template]));
  const templateIds = new Map();
  for (const definition of flow.templates) {
    if (templates.has(definition.id)) { say(`template ${definition.id}: already exists.`); templateIds.set(definition.id, definition.id); continue; }
    const created = await api('POST', '/api/templates', definition);
    templates.set(created.id, created); templateIds.set(definition.id, created.id);
    if (created.id !== definition.id) problems.push(`template ${definition.id} was created as ${created.id} because that id was taken; playbooks that name ${definition.id} will not find it.`);
    say(`template ${created.id}: created.`);
  }

  const createdProject = await api('POST', '/api/projects', { name: projectName, kind: flow.flow.kind,
    ...(flow.template ? { templateId: templateIds.get(flow.template) ?? flow.template } : {}) });
  const flowId = createdProject.flow.id;
  say(`project “${projectName}” created (${flow.flow.kind}).`);
  if (flow.flow.name && flow.flow.name !== createdProject.flow.name) {
    await api('PATCH', `/api/flows/${flowId}`, { name: flow.flow.name });
    say(`flow renamed to “${flow.flow.name}”.`);
  }

  // The project starts with starter nodes; the manifest's come first so the
  // flow is never empty, then the starter ones go.
  const starterIds = createdProject.flow.stages.map((stage) => stage.id);
  const created = [];
  for (const node of flow.nodes) {
    const stage = await api('POST', `/api/flows/${flowId}/stages`, { name: node.name.trim(), color: node.color,
      ...(node.x !== undefined ? { x: node.x } : {}), ...(node.y !== undefined ? { y: node.y } : {}) });
    created.push(stage);
    say(`node ${stage.name}: created (${node.color}${node.x !== undefined || node.y !== undefined ? `, ${node.x ?? 0},${node.y ?? 0}` : ''}).`);
  }
  for (const id of starterIds) await api('DELETE', `/api/stages/${id}`);
  say(`removed the ${starterIds.length} starter nodes.`);
  const stageOf = (name) => created.find((stage) => sameName(stage.name, name));

  // Playbooks. A graph node starts with a "run: off" playbook; the manifest's
  // file replaces it at the manifest's own file name. The starter nodes'
  // playbooks are left over once their nodes are gone, so they are removed.
  const folder = `/api/flows/${flowId}/playbooks`;
  const listing = await api('GET', folder);
  const mine = new Set(created.map((stage) => stage.id));
  const documents = new Map();
  for (const document of listing.lanes) {
    if (mine.has(document.laneId)) { documents.set(document.path, document); continue; }
    await api('DELETE', folder, { path: document.path, baseHash: document.hash });
    say(`removed the starter playbook ${document.path}.`);
  }
  const put = async (relative, text, current) => {
    await api('PUT', folder, { path: relative, text, baseHash: current?.hash ?? null });
  };
  if (flow.map) {
    await put('MAP.md', flow.map.text, listing.map);
    say(`MAP.md: written from ${flow.map.file}.`);
  }
  for (const skill of flow.skills) {
    await put(skill.path, skill.text, listing.skills.find((document) => document.path === skill.path));
    say(`${skill.path}: written.`);
  }
  const playbooks = flow.nodes.map((node) => ({ node, stage: stageOf(node.name) })).filter(({ node }) => node.playbook);
  for (const { node, stage } of playbooks) {
    const auto = [...documents.values()].find((document) => document.laneId === stage.id);
    if (auto && auto.path !== node.playbook.path) {
      await api('DELETE', folder, { path: auto.path, baseHash: auto.hash });
      documents.delete(auto.path);
    }
  }
  for (const { node, stage } of playbooks) {
    const current = documents.get(node.playbook.path);
    if (current && current.laneId !== stage.id && mine.has(current.laneId)) throw new Error(`${node.playbook.path} is already the playbook of another node.`);
    let text;
    try { text = withSetting(node.playbook.text, 'lane', stage.id); }
    catch (error) { throw new Error(`${node.playbook.file}: ${error.message}`); }
    await put(node.playbook.path, text, current);
    say(`node ${stage.name}: playbook ${node.playbook.path} written (lane: ${stage.id}).`);
  }

  // Cards, in the order of the manifest.
  const cards = [];
  for (const entry of flow.cards) {
    const stage = stageOf(entry.node);
    const templateId = entry.template ? templateIds.get(entry.template) ?? entry.template : createdProject.flow.templateId;
    const template = templates.get(templateId);
    const fields = { ...(entry.fields ?? {}) };
    let title = entry.title ?? '';
    const images = []; const roles = {};
    let cover = null;
    const add = (image) => {
      if (!images.some((item) => item.id === image.id)) images.push({ id: image.id, name: image.name });
      return image.id;
    };
    let thumbnail = null;
    if (entry.youtube !== undefined) {
      const url = fields[entry.youtube];
      const found = await api('POST', '/api/youtube', { url, transcript: true });
      if (!title) title = found.title;
      const titled = template.fields.find((field) => field.key === 'originalVideoTitle');
      if (titled && !fields.originalVideoTitle) fields.originalVideoTitle = found.title.slice(0, titled.max);
      const transcript = template.fields.find((field) => field.transcript);
      if (transcript && found.transcript?.text && !fields[transcript.key]) fields[transcript.key] = found.transcript.text.trim().slice(0, transcript.max);
      if (found.transcriptError) say(`card “${title}”: no transcript (${found.transcriptError})`);
      thumbnail = add(found.image);
    }
    // Uploaded files claim their roles; the video's thumbnail and the first
    // image are the defaults for the display image and the original.
    for (const image of entry.images) {
      const bytes = readFileSync(image.absolute);
      const uploaded = await api('POST', '/api/images', bytes, imageTypes[path.extname(image.absolute).toLowerCase()]);
      const id = add({ id: uploaded.id, name: path.basename(image.file) });
      for (const role of image.roles ?? []) {
        const key = roleKey(template, role);
        if (key === 'cover') cover = id; else roles[key] = id;
      }
    }
    if (thumbnail) {
      const original = roleKey(template, 'original');
      if (original && original !== 'cover' && !roles[original]) roles[original] = thumbnail;
    }
    if (images.length) roles.cover = cover ?? thumbnail ?? images[0].id;
    const card = await api('POST', `/api/projects/${createdProject.project.id}/cards`, { stageId: stage.id, title, fields, template: templateId, images, imageRoles: roles });
    cards.push(card);
    say(`card “${title || '(untitled)'}” created in ${stage.name}${images.length ? ` with ${images.length} image${images.length === 1 ? '' : 's'}` : ''}.`);
  }

  // The server's own reading of what was written.
  const after = (await api('GET', '/api/workspace')).flows.find((item) => item.id === flowId);
  for (const stage of after.stages) {
    for (const message of stage.playbook?.errors ?? []) problems.push(`node ${stage.name}: ${message}`);
    for (const route of stage.playbook?.routes ?? []) if (!route.laneId) problems.push(`node ${stage.name}: route “${route.name}” leads nowhere (${route.target}).`);
  }
  say(problems.length ? `installed with ${problems.length} problem${problems.length === 1 ? '' : 's'}.` : `installed: ${after.stages.length} nodes, ${cards.length} cards.`);
  return { project: createdProject.project, flow: after, stages: after.stages, cards, problems };
}

// --- Command line ----------------------------------------------------------
const usage = `Usage: node scripts/demo-flows.mjs [--base <url>] [--only <flow>] [--replace] [--check] [demo]

  --base <url>    the running Frameboard (default ${defaultBase})
  --only <flow>   one flow folder under demo/ (repeat or separate with commas)
  --replace       delete a project with the same name first
  --check         read every manifest and playbook without a server; exit 1 on problems
  demo            the folder holding the flow folders (default: demo/ in this repository)`;

export function parseArguments(argv) {
  const options = { base: defaultBase, only: [], replace: false, check: false, root: null, help: false };
  for (let index = 0; index < argv.length; index++) {
    const [name, inline] = argv[index].startsWith('--') ? argv[index].split(/=(.*)/s) : [argv[index]];
    const value = () => {
      const found = inline ?? argv[++index];
      if (found === undefined || found.startsWith('--')) throw new Error(`${name} needs a value.\n${usage}`);
      return found;
    };
    if (name === '--base') options.base = value();
    else if (name === '--only') options.only.push(...value().split(',').map((item) => item.trim()).filter(Boolean));
    else if (name === '--replace') options.replace = true;
    else if (name === '--check') options.check = true;
    else if (name === '--help' || name === '-h') options.help = true;
    else if (name.startsWith('-')) throw new Error(`Unknown option ${name}.\n${usage}`);
    else if (options.root) throw new Error(`Only one demo folder can be given.\n${usage}`);
    else options.root = name;
  }
  return options;
}

export function findFlows(root, only = []) {
  const found = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, 'flow.json'))).map((entry) => entry.name).sort();
  const missing = only.filter((name) => !found.includes(name));
  if (missing.length) throw new Error(`No flow named ${missing.join(', ')} in ${root} (found: ${found.join(', ') || 'none'}).`);
  return (only.length ? found.filter((name) => only.includes(name)) : found).map((name) => path.join(root, name));
}

export async function main(argv = process.argv.slice(2), { out = console.log, err = console.error } = {}) {
  let options;
  try { options = parseArguments(argv); } catch (error) { err(error.message); return 2; }
  if (options.help) { out(usage); return 0; }
  const given = options.root && (existsSync(path.resolve(options.root)) ? path.resolve(options.root) : path.resolve(repoRoot, options.root));
  const root = given || path.join(repoRoot, 'demo');
  let dirs;
  try { dirs = findFlows(root, options.only); } catch (error) { err(error.code === 'ENOENT' ? `Demo folder ${root} does not exist.` : error.message); return 1; }
  if (!dirs.length) { err(`No demo flows (folders with a flow.json) in ${root}.`); return 1; }
  const relative = (dir) => path.relative(process.cwd(), dir) || dir;

  let failed = 0;
  const installable = [];
  for (const dir of dirs) {
    const { errors, warnings } = checkFlow(dir);
    const flowName = relative(dir);
    if (errors.length) {
      failed += 1;
      err(`${flowName}: ${errors.length} problem${errors.length === 1 ? '' : 's'}${options.check ? '' : ', not installed'}`);
      for (const line of errors) err(`  - ${line}`);
    } else {
      installable.push(dir);
      if (options.check) out(`${flowName}: ok${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : ''}`);
    }
    for (const line of warnings) out(`  warning: ${flowName}: ${line}`);
  }
  if (options.check) return failed ? 1 : 0;

  if (installable.length) {
    try { await request(options.base, 'GET', '/api/workspace'); } catch (error) { err(error.message); return 1; }
  }
  for (const dir of installable) {
    try {
      const result = await installFlow(options.base, dir, { replace: options.replace, log: out });
      for (const problem of result.problems) err(`${path.basename(dir)}: ${problem}`);
      if (result.problems.length) failed += 1;
    } catch (error) {
      failed += 1;
      err(`${path.basename(dir)}: ${error.message}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
