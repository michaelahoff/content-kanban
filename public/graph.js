// The graph view of a flow. Each lane is a node on a canvas, where the user
// placed it, and each route in its lane playbook (routes: name → lane) is an
// arrow to another node. Cards sit in their node as they do in a lane, and
// drag between nodes the same way (app.js handles drops on [data-lane]).
// Dragging a node's port onto another node adds a route; clicking a route's
// label edits it. A node's place is saved on its lane, its routes in its
// playbook, and the canvas's pan and zoom in this browser only.
import { $, escape, icon, iconButton, imageURL, palette, smallForm, toast } from './ui.js';
import { searchText, moveNode, setRoutes, addLane } from './state.js';
import { activityMarkup } from './chat.js';
import { renderBoard } from './board.js';

const viewsKey = 'frameboard-graph-views';
const views = (() => { try { return JSON.parse(localStorage.getItem(viewsKey) || '{}'); } catch { return {}; } })();
let saveTimer = null;
const saveViews = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(viewsKey, JSON.stringify(views)); } catch { /* Optional display preference. */ } }, 300);
};
// Nodes snap to this grid when dropped; a single line spaces them this far apart.
const grid = 20;
const spacing = 380;
const zoomRange = [0.3, 1.6];
const routeName = /^[a-z0-9][a-z0-9 _-]{0,39}$/i;
// The flow on screen and the last render's options; null until a graph is shown.
let current = null;
let gesture = null;
let frame = 0;

const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));
const routesOf = (lane) => lane.playbook?.routes ?? [];
const laneOf = (id) => current?.flow.lanes.find((lane) => lane.id === id) ?? null;

// Lanes without a place yet (a board just converted elsewhere, or a lane added
// from another tab) are laid out in route order from the first lane, in
// columns to the right of the nodes already placed.
function placeMissing(f) {
  const missing = f.lanes.filter((lane) => lane.x === null || lane.x === undefined);
  if (!missing.length) return;
  const placed = f.lanes.filter((lane) => !missing.includes(lane));
  const left = placed.length ? Math.max(...placed.map((lane) => lane.x)) + spacing : 0;
  const depth = new Map();
  const queue = f.lanes.length ? [[f.lanes[0], 0]] : [];
  while (queue.length) {
    const [lane, level] = queue.shift();
    if (depth.has(lane.id)) continue;
    depth.set(lane.id, level);
    for (const route of routesOf(lane)) { const next = f.lanes.find((item) => item.id === route.laneId); if (next) queue.push([next, level + 1]); }
  }
  const rows = new Map();
  for (const lane of missing) {
    const column = placed.length ? 0 : depth.get(lane.id) ?? Math.max(0, ...depth.values()) + 1;
    const row = rows.get(column) ?? 0; rows.set(column, row + 1);
    lane.x = left + column * spacing; lane.y = 40 + row * 280;
  }
}

function cardMarkup(card, draggable, collapsed) {
  const title = escape(card.title || 'Untitled card');
  const image = collapsed ? '' : card.imageRoles.cover ? `<div class="card-image"><img src="${imageURL(card.imageRoles.cover)}" alt="" loading="lazy" draggable="false"></div>` : `<div class="card-image no-image">${icon('image')}</div>`;
  return `<article class="card graph-card" draggable="${draggable}" data-card="${card.id}"><button class="card-open" draggable="${draggable}" data-action="open-card" data-id="${card.id}" aria-label="Open ${title}" title="${title}">${image}<div class="card-body"><h3>${title}</h3>${activityMarkup(card.id)}</div></button></article>`;
}

function badges(lane, index) {
  const playbook = lane.playbook;
  const runs = playbook && playbook.hasInstructions && !playbook.errors.length && playbook.run !== 'off';
  const nowhere = routesOf(lane).filter((route) => !route.laneId);
  return [
    index === 0 ? '<span class="graph-badge start" title="New cards start here">Start</span>' : '',
    playbook?.errors.length ? `<button type="button" class="graph-badge error" data-action="edit-playbook" data-id="${lane.id}" title="${escape(playbook.errors.join(' '))}">Fix playbook</button>` : '',
    runs ? `<span class="graph-badge agent" title="${escape(playbook.summary)}">${icon('bolt')}${playbook.run === 'on-enter' ? 'Agent on entry' : 'Agent on request'}</span>` : '',
    playbook?.advance === 'auto' && routesOf(lane).some((route) => route.laneId) ? '<span class="graph-badge auto" title="When its agent chooses a route, the card moves at once">Moves on by itself</span>' : '',
    nowhere.length ? `<button type="button" class="graph-badge error" data-action="edit-playbook" data-id="${lane.id}" title="${escape(nowhere.map((route) => `${route.name} → ${route.target}`).join(', '))}">${nowhere.length === 1 ? 'A route leads nowhere' : `${nowhere.length} routes lead nowhere`}</button>` : '',
  ].join('');
}

function nodeMarkup(lane, index, { search, collapsed, readOnly }) {
  const cards = lane.cards.filter((card) => searchText(card).toLocaleLowerCase().includes(search));
  const ways = routesOf(lane).filter((route) => route.laneId).map((route) => `${route.name} to ${laneOf(route.laneId)?.name ?? ''}`);
  const marks = badges(lane, index);
  return `<section class="graph-node ${lane.color}" data-lane="${lane.id}" data-node="${lane.id}" tabindex="0" aria-label="${escape(lane.name)} node${readOnly ? '' : '; paste images here'}">
    <div class="graph-node-head" ${readOnly ? '' : 'data-node-drag title="Drag to move this node"'}><span class="lane-dot"></span><h2>${escape(lane.name)}</h2><span class="lane-count">${search ? `${cards.length}/` : ''}${lane.cards.length}</span>
      ${readOnly ? '' : `<div class="graph-node-actions">${iconButton('edit-playbook', `${lane.name} playbook`, 'playbook', `data-id="${lane.id}"`)}${iconButton('edit-lane', `Edit ${lane.name} node`, 'more', `data-id="${lane.id}"`)}${iconButton('add-card', `Add card to ${lane.name}`, 'plus', `data-lane-id="${lane.id}"`)}</div>`}</div>
    ${marks ? `<div class="graph-badges">${marks}</div>` : ''}
    <div class="lane-cards">${cards.map((card) => cardMarkup(card, !readOnly, collapsed)).join('') || `<p class="graph-empty">${search ? 'No matching cards' : readOnly ? 'No cards' : 'Drop or paste cards here'}</p>`}</div>
    <p class="sr-only">${ways.length ? `Routes: ${escape(ways.join('; '))}.` : 'No routes out of this node.'}</p>
    ${readOnly ? '' : `<button type="button" class="graph-port" data-graph-action="add-route" data-from="${lane.id}" aria-label="Add a route from ${escape(lane.name)}" title="Drag to another node to add a route"></button>`}
  </section>`;
}

export function renderGraph(container, p, f, { search = '', collapsed = false } = {}) {
  const readOnly = Boolean(p.archivedAt);
  current = { flow: f, container, project: p, options: { search, collapsed }, readOnly, viewport: null, world: null };
  placeMissing(f);
  container.innerHTML = `<div class="graph-viewport ${readOnly ? 'read-only' : ''}" data-graph-viewport>
      <div class="graph-world"><svg class="graph-edges" aria-hidden="true"><defs>${['', '-auto'].map((kind) => `<marker id="graph-arrow${kind}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto"><path class="graph-arrowhead${kind ? ' auto' : ''}" d="M0 1 9 5 0 9Z"/></marker>`).join('')}</defs><g data-graph-edges></g><path class="graph-edge drafting" data-graph-draft d="" hidden/></svg>
        ${f.lanes.map((lane, index) => nodeMarkup(lane, index, { search, collapsed, readOnly })).join('')}
        <div class="graph-labels" data-graph-labels></div></div>
      ${f.lanes.length ? '' : `<div class="graph-empty-canvas"><span class="empty-symbol">${icon('graph')}</span><p>This graph has no nodes yet.</p><span>${readOnly ? '' : 'Double-click the canvas or use Add node.'}</span></div>`}
      <div class="graph-legend" aria-hidden="true"><span><i class="review"></i>Waits for your review</span><span><i class="auto"></i>Moves on by itself</span>${readOnly ? '' : '<span class="graph-tip">Drag a node’s dot onto another node to add a route · Ctrl + scroll to zoom</span>'}</div>
      <div class="graph-controls" role="group" aria-label="Zoom">${iconButton('graph-zoom-out', 'Zoom out', 'minus')}<button type="button" class="graph-zoom-level" data-action="graph-zoom-reset" title="Reset zoom to 100%"></button>${iconButton('graph-zoom-in', 'Zoom in', 'plus')}${iconButton('graph-fit', 'Fit the graph on screen', 'fit')}</div>
    </div>`;
  current.viewport = $('[data-graph-viewport]', container);
  current.world = $('.graph-world', container);
  // The page's style policy refuses style attributes, so places are set here.
  for (const node of current.world.querySelectorAll('[data-node]')) place(node, laneOf(node.dataset.node));
  // A flow opened for the first time in this browser is fitted on screen,
  // without shrinking its text below legibility (70%): a wider graph starts
  // at its left edge and pans from there.
  if (views[f.id]) applyView(); else fit({ readable: true });
  drawEdges();
}

const place = (element, { x, y }) => { element.style.left = `${x}px`; element.style.top = `${y}px`; };

// --- Pan and zoom ----------------------------------------------------------
const view = () => (views[current.flow.id] ??= { x: 40, y: 40, z: 1 });
function applyView() {
  const { x, y, z } = view();
  current.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  current.viewport.style.setProperty('--grid-size', `${24 * z}px`);
  current.viewport.style.setProperty('--grid-x', `${x}px`);
  current.viewport.style.setProperty('--grid-y', `${y}px`);
  const level = $('.graph-zoom-level', current.viewport);
  if (level) level.textContent = `${Math.round(z * 100)}%`;
  saveViews();
}
function zoomAt(clientX, clientY, factor) {
  const v = view();
  const rect = current.viewport.getBoundingClientRect();
  const z = clamp(v.z * factor, zoomRange);
  const px = clientX - rect.left; const py = clientY - rect.top;
  v.x = px - ((px - v.x) * z) / v.z; v.y = py - ((py - v.y) * z) / v.z; v.z = z;
  applyView();
}
const zoomCenter = (factor) => { const rect = current.viewport.getBoundingClientRect(); zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor); };
function fit({ readable = false } = {}) {
  const nodes = [...boxes().values()];
  const v = view();
  if (!nodes.length) { Object.assign(v, { x: 40, y: 40, z: 1 }); return applyView(); }
  // Room for routes that loop around the nodes.
  const minX = Math.min(...nodes.map((box) => box.x)) - 40; const minY = Math.min(...nodes.map((box) => box.y)) - 60;
  const maxX = Math.max(...nodes.map((box) => box.x + box.w)) + 40; const maxY = Math.max(...nodes.map((box) => box.y + box.h)) + 90;
  const { clientWidth: width, clientHeight: height } = current.viewport;
  const pad = 48;
  const z = clamp(Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxY - minY), 1), readable ? [0.7, 1] : zoomRange);
  const x = (maxX - minX) * z > width - pad * 2 ? pad - minX * z : (width - (maxX - minX) * z) / 2 - minX * z;
  Object.assign(v, { z, x, y: Math.max(pad - minY * z, (height - (maxY - minY) * z) / 2 - minY * z) });
  applyView();
}
// A point on screen in canvas coordinates.
function toWorld(clientX, clientY) {
  const rect = current.viewport.getBoundingClientRect(); const v = view();
  return { x: (clientX - rect.left - v.x) / v.z, y: (clientY - rect.top - v.y) / v.z };
}

// --- Routes ----------------------------------------------------------------
// Node boxes in canvas coordinates; routes leave and enter at the heading.
function boxes() {
  return new Map([...(current?.world?.querySelectorAll('[data-node]') ?? [])].map((node) => {
    const head = $('.graph-node-head', node);
    return [node.dataset.node, { x: node.offsetLeft, y: node.offsetTop, w: node.offsetWidth, h: node.offsetHeight, hy: node.clientTop + head.offsetTop + head.offsetHeight / 2 }];
  }));
}
// A route leaves its node's port on the right and enters the other node's
// heading on the left. A route forward is one curve. Any other route doubles
// back along a horizontal run, each on its own level so loops read as loops:
// through the gap between the two nodes' rows when they are apart, otherwise
// over the top to a node wholly above or underneath both.
function routePath(a, b, offset, level) {
  const x1 = a.x + a.w; const y1 = a.y + a.hy + offset; const x2 = b.x; const y2 = b.y + b.hy;
  if (x2 >= x1 + 48) {
    const pull = Math.max(48, (x2 - x1) / 2);
    return { around: false, d: `M${x1} ${y1} C${x1 + pull} ${y1} ${x2 - pull} ${y2} ${x2} ${y2}`, label: [(x1 + x2) / 2, (y1 + y2) / 2] };
  }
  const [upper, lower] = a.y < b.y ? [a, b] : [b, a];
  const gap = lower.y - (upper.y + upper.h);
  const run = gap > 48 ? upper.y + upper.h + gap / 2 + (level % 2 ? 1 : -1) * Math.ceil(level / 2) * Math.min(18, gap / 6)
    : b.y + b.h < a.y ? Math.min(a.y, b.y) - 44 - level * 30 : Math.max(a.y + a.h, b.y + b.h) + 44 + level * 30;
  return { around: true, d: `M${x1} ${y1} C${x1 + 80} ${y1} ${x1 + 80} ${run} ${x1} ${run} L${x2} ${run} C${x2 - 80} ${run} ${x2 - 80} ${y2} ${x2} ${y2}`, label: [(x1 + x2) / 2, run] };
}
// Moves a label down until it clears the labels already placed.
function clear(label, placed) {
  const [x] = label; let [, y] = label;
  while (placed.some(([px, py]) => Math.abs(px - x) < 80 && Math.abs(py - y) < 22)) y += 22;
  placed.push([x, y]);
  return [x, y];
}
function drawEdges() {
  if (!current?.world) return;
  const box = boxes(); const paths = []; const labels = []; const placed = [];
  let level = 0;
  for (const lane of current.flow.lanes) {
    const ways = routesOf(lane).filter((route) => route.laneId && box.has(route.laneId) && box.has(lane.id));
    const automatic = lane.playbook?.advance === 'auto';
    ways.forEach((route, index) => {
      const a = box.get(lane.id); const b = box.get(route.laneId);
      const path = routePath(a, b, (index - (ways.length - 1) / 2) * 12, level);
      if (path.around) level++;
      const { d } = path; const label = clear(path.label, placed);
      const target = laneOf(route.laneId);
      paths.push(`<path class="graph-edge ${automatic ? 'auto' : ''}" d="${d}" marker-end="url(#graph-arrow${automatic ? '-auto' : ''})"/>`);
      labels.push(`<button type="button" class="graph-route ${automatic ? 'auto' : ''}" data-x="${label[0]}" data-y="${label[1]}" ${current.readOnly ? 'disabled' : ''} data-graph-action="edit-route" data-from="${lane.id}" data-route="${escape(route.name)}" title="${escape(`${lane.name} → ${target?.name ?? ''}: ${automatic ? 'moves on by itself' : 'waits for your review'}. Click to edit.`)}">${automatic ? icon('bolt') : ''}${escape(route.name)}</button>`);
    });
  }
  $('[data-graph-edges]', current.world).innerHTML = paths.join('');
  const layer = $('[data-graph-labels]', current.world);
  layer.innerHTML = labels.join('');
  for (const label of layer.children) place(label, { x: label.dataset.x, y: label.dataset.y });
}

// A new route's name: "next" for a node's first, then the destination's name.
function suggestName(lane, target) {
  const taken = new Set(routesOf(lane).map((route) => route.name.toLowerCase()));
  const base = !taken.size ? 'next' : (target.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 36) || 'route');
  const safe = /^[a-z0-9]/.test(base) ? base : `to ${base}`.slice(0, 36);
  let name = safe;
  for (let index = 2; taken.has(name); index++) name = `${safe} ${index}`;
  return name;
}
const routeList = (lane) => routesOf(lane).filter((route) => route.laneId).map((route) => ({ name: route.name, to: route.laneId }));
async function saveRoutes(lane, routes, advance) {
  await setRoutes(current.flow, lane, routes, advance);
  renderBoard();
}
async function connect(fromId, toId) {
  const lane = laneOf(fromId); const target = laneOf(toId);
  if (!lane || !target) return;
  if (fromId === toId) return toast('A route leads to another node. To repeat a step, route through a review node and back.');
  const existing = routesOf(lane).find((route) => route.laneId === toId);
  if (existing) return toast(`“${existing.name}” already leads from ${lane.name} to ${target.name}.`);
  const name = suggestName(lane, target);
  try {
    await saveRoutes(lane, [...routeList(lane), { name, to: toId }]);
    toast(`Added the route “${name}” from ${lane.name} to ${target.name}. Click its label to rename it.`);
  } catch (error) { toast(error.message); }
}

// Edits one route, or adds one when `name` is null: its name, the node it
// leads to and, for every route out of the node, whether a route its agent
// chooses is followed at once or waits for review.
export function routeForm(fromId, name = null) {
  const lane = laneOf(fromId);
  if (!lane) return;
  const route = name === null ? null : routesOf(lane).find((item) => item.name === name);
  const targets = current.flow.lanes.filter((item) => item.id !== lane.id);
  if (!targets.length) return toast('Add another node first.');
  const advance = lane.playbook?.advance ?? 'review';
  const choice = (value, label, help, symbol) => `<label class="kind-option"><input type="radio" name="advance" value="${value}" ${advance === value ? 'checked' : ''}><span>${icon(symbol)}<strong>${label}</strong><small>${help}</small></span></label>`;
  const fields = `<label class="form-label" for="name-input">Route name</label><input class="form-input" id="name-input" name="name" value="${escape(route?.name ?? suggestName(lane, targets[0]))}" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9 _\\-]*" required autocomplete="off" placeholder="e.g. approved">
    <p class="field-help">The agent in ${escape(lane.name)} picks a route by this name, so name the outcome: approved, revise, too long.</p>
    <label class="form-label" for="route-to">Leads to</label><select class="form-input" id="route-to" name="to">${targets.map((item) => `<option value="${item.id}" ${item.id === route?.laneId ? 'selected' : ''}>${escape(item.name)}</option>`).join('')}</select>
    <fieldset class="kind-field"><legend class="form-label">When the agent in ${escape(lane.name)} picks a route</legend>${choice('review', 'Wait for my review', 'The move is a proposal you accept in the card chat.', 'clock')}${choice('auto', 'Move on by itself', 'The card follows the route at once and the next node’s playbook runs. Loops pause after a dozen moves in a row.', 'bolt')}</fieldset>
    <p class="field-help">This applies to every route out of ${escape(lane.name)}. You can always move a card along a route yourself from the card.</p>`;
  smallForm({
    title: route ? `Route from ${lane.name}` : `New route from ${lane.name}`,
    fields, submit: route ? 'Save route' : 'Add route',
    extra: route ? `<button type="button" class="text-button danger" data-graph-action="delete-route" data-from="${lane.id}" data-route="${escape(route.name)}">${icon('trash')}Delete route</button>` : '',
    onSubmit: async (data) => {
      const next = String(data.get('name')).trim();
      if (!routeName.test(next)) throw new Error('Route names start with a letter or number and use letters, numbers, spaces, - and _.');
      const list = routeList(lane);
      const at = route ? list.findIndex((item) => item.name === route.name) : -1;
      const entry = { name: next, to: String(data.get('to')) };
      if (at < 0) list.push(entry); else list.splice(at, 1, entry);
      await saveRoutes(lane, list, String(data.get('advance')));
    },
  });
}

// A new node at a place on the canvas, or to the right of the others.
export function nodeForm(at = null) {
  const f = current?.flow;
  if (!f) return;
  const place = at ?? { x: f.lanes.length ? Math.max(...f.lanes.map((lane) => lane.x ?? 0)) + spacing : 0, y: f.lanes.length ? Math.min(...f.lanes.map((lane) => lane.y ?? 0)) : 40 };
  const color = palette[f.lanes.length % palette.length];
  smallForm({
    title: 'Add a node',
    description: 'A node is a lane of this flow: it holds cards and has its own playbook. Connect it with routes once it is on the canvas.',
    fields: `<label class="form-label" for="name-input">Node name</label><input class="form-input" id="name-input" name="name" maxlength="100" required autocomplete="off" placeholder="e.g. Critique">
      <fieldset class="color-field"><legend>Node color</legend>${palette.map((item) => `<label class="color-option ${item}" title="${item}"><input type="radio" name="color" value="${item}" ${item === color ? 'checked' : ''}><span>${icon('check')}<span class="sr-only">${item}</span></span></label>`).join('')}</fieldset>`,
    submit: 'Add node',
    onSubmit: (data) => {
      addLane(f, { name: String(data.get('name')).trim(), color: String(data.get('color')), x: Math.round(place.x / grid) * grid, y: Math.round(place.y / grid) * grid });
      renderBoard();
      document.querySelector('.header-actions [data-action="add-card"]')?.removeAttribute('disabled');
    },
  });
}

// --- Pointer gestures: pan the canvas, move a node, draw a route -----------
function nodeAt(clientX, clientY) {
  const hit = document.elementFromPoint(clientX, clientY)?.closest?.('[data-node]');
  return hit && current.world.contains(hit) ? hit : null;
}
function scheduleEdges() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; drawEdges(); });
}
document.addEventListener('pointerdown', (event) => {
  const viewport = event.target.closest?.('[data-graph-viewport]');
  if (!viewport || viewport !== current?.viewport || event.button !== 0) return;
  if (event.target.closest('.graph-controls, .graph-legend, [data-card], input, select, textarea, a, button:not(.graph-port)')) return;
  const start = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
  const port = event.target.closest('.graph-port');
  const handle = event.target.closest('[data-node-drag]');
  if (port && !current.readOnly) {
    gesture = { ...start, kind: 'connect', from: port.dataset.from };
    port.setPointerCapture(event.pointerId);
  } else if (handle && !current.readOnly) {
    const node = handle.closest('[data-node]'); const lane = laneOf(node.dataset.node);
    gesture = { ...start, kind: 'node', node, lane, x: lane.x, y: lane.y };
    handle.setPointerCapture(event.pointerId);
  } else if (!event.target.closest('[data-node]')) {
    const v = view();
    gesture = { ...start, kind: 'pan', x: v.x, y: v.y };
    viewport.setPointerCapture(event.pointerId);
  } else return;
  event.preventDefault();
});
document.addEventListener('pointermove', (event) => {
  if (!gesture || event.pointerId !== gesture.pointerId || !current) return;
  const dx = event.clientX - gesture.startX; const dy = event.clientY - gesture.startY;
  if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
  gesture.moved = true;
  if (gesture.kind === 'pan') {
    current.viewport.classList.add('panning');
    Object.assign(view(), { x: gesture.x + dx, y: gesture.y + dy });
    applyView();
  } else if (gesture.kind === 'node') {
    const { z } = view();
    gesture.node.classList.add('moving');
    gesture.lane.x = gesture.x + dx / z; gesture.lane.y = gesture.y + dy / z;
    place(gesture.node, gesture.lane);
    scheduleEdges();
  } else if (gesture.kind === 'connect') {
    const box = boxes().get(gesture.from);
    const point = toWorld(event.clientX, event.clientY);
    const x1 = box.x + box.w; const y1 = box.y + box.hy; const pull = Math.max(40, Math.abs(point.x - x1) / 2);
    const draft = $('[data-graph-draft]', current.world);
    draft.hidden = false;
    draft.setAttribute('d', `M${x1} ${y1} C${x1 + pull} ${y1} ${point.x - pull} ${point.y} ${point.x} ${point.y}`);
    const over = nodeAt(event.clientX, event.clientY);
    current.world.querySelectorAll('.connect-target').forEach((node) => { if (node !== over) node.classList.remove('connect-target'); });
    if (over && over.dataset.node !== gesture.from) over.classList.add('connect-target');
  }
});
function endGesture(event) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const ended = gesture; gesture = null;
  if (!current) return;
  current.viewport.classList.remove('panning');
  if (ended.kind === 'node') {
    ended.node.classList.remove('moving');
    if (!ended.moved) return;
    const x = Math.round(ended.lane.x / grid) * grid; const y = Math.round(ended.lane.y / grid) * grid;
    ended.lane.x = ended.x; ended.lane.y = ended.y;
    moveNode(ended.lane, x, y);
    place(ended.node, { x, y });
    drawEdges();
  } else if (ended.kind === 'connect') {
    const draft = $('[data-graph-draft]', current.world);
    if (draft) draft.hidden = true;
    current.world.querySelectorAll('.connect-target').forEach((node) => node.classList.remove('connect-target'));
    // A click on the port, without dragging, opens the route form instead.
    if (!ended.moved) return routeForm(ended.from);
    const over = event.type === 'pointerup' && nodeAt(event.clientX, event.clientY);
    if (over) void connect(ended.from, over.dataset.node);
  }
}
document.addEventListener('pointerup', endGesture);
document.addEventListener('pointercancel', endGesture);
// Scrolling pans, as on a trackpad; with Ctrl or ⌘ (and pinching) it zooms.
// A node's card list keeps its own scrolling.
document.addEventListener('wheel', (event) => {
  const viewport = event.target.closest?.('[data-graph-viewport]');
  if (!viewport || viewport !== current?.viewport) return;
  const list = event.target.closest('.lane-cards');
  if (list && !event.ctrlKey && !event.metaKey && list.scrollHeight > list.clientHeight) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * (event.deltaMode ? 0.05 : 0.0015)));
  else { const v = view(); v.x -= event.deltaX; v.y -= event.deltaY; applyView(); }
}, { passive: false });
document.addEventListener('dblclick', (event) => {
  const viewport = event.target.closest?.('[data-graph-viewport]');
  if (!viewport || viewport !== current?.viewport || current.readOnly) return;
  if (event.target.closest('[data-node], button, .graph-legend, .graph-controls')) return;
  const point = toWorld(event.clientX, event.clientY);
  nodeForm({ x: point.x - 130, y: point.y - 24 });
});
document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-graph-action], [data-action^="graph-"]');
  if (!target || !current) return;
  const action = target.dataset.graphAction ?? target.dataset.action;
  if (action === 'graph-zoom-in') zoomCenter(1.25);
  if (action === 'graph-zoom-out') zoomCenter(1 / 1.25);
  if (action === 'graph-zoom-reset') zoomCenter(1 / view().z);
  if (action === 'graph-fit') fit();
  if (action === 'edit-route') routeForm(target.dataset.from, target.dataset.route);
  // A port pressed from the keyboard; a pointer click on it is handled as a gesture.
  if (action === 'add-route' && event.detail === 0) routeForm(target.dataset.from);
  if (action === 'delete-route') {
    const lane = laneOf(target.dataset.from);
    if (!lane) return;
    try {
      await saveRoutes(lane, routeList(lane).filter((route) => route.name !== target.dataset.route));
      $('#form-dialog').close();
      toast(`Deleted the route “${target.dataset.route}”.`);
    } catch (error) { toast(error.message); }
  }
});
// The canvas keeps its size with the window; routes follow the nodes as
// their cards load or change size.
new ResizeObserver(() => scheduleEdges()).observe(document.documentElement);
