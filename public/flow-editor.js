// A lane's command canvas. Drafts stay here until Save; only the shared graph
// module knows what a valid graph means or how commands execute.
import { $, escape, icon, id, toast } from './ui.js';
import { emptyGraph, setFields, validateGraph, assignmentsFor } from './flow-graph.js';
import { project, saveLaneGraph } from './state.js';
import { renderBoard } from './board.js';

const dialog = $('#flow-dialog');
let lane, graph, selectedId, connectingFrom, zoom = 1, saving = false, drag;
const NODE_WIDTH = 240, NODE_HEIGHT = 144;
const control = (action, label, symbol, cls = 'button secondary', attrs = '') => `<button type="button" class="${cls}" data-flow-action="${action}" ${attrs}>${symbol ? icon(symbol) : ''}${label}</button>`;
const fieldLabel = (key) => setFields.find((field) => field.key === key)?.label || key;
const selected = () => graph.nodes.find((node) => node.id === selectedId);
const nodeLabel = (node) => assignmentsFor(node).length === 1 ? fieldLabel(assignmentsFor(node)[0].field) : `${assignmentsFor(node).length} fields`;
const preview = (node) => {
  const assignments = assignmentsFor(node);
  if (assignments.length > 1) return assignments.map((assignment) => fieldLabel(assignment.field)).join(', ');
  return assignments[0].value.trim() ? assignments[0].value.slice(0, 80) : 'Clear this field';
};
const rowId = (kind, index) => `flow-${kind}${index ? `-${index}` : ''}`;

export function openFlow(laneId) {
  lane = project()?.lanes.find((item) => item.id === laneId);
  if (!lane) return;
  graph = structuredClone(lane.entryGraph || emptyGraph());
  for (const node of graph.nodes) if (node.type === 'set') node.config = { assignments: assignmentsFor(node) };
  selectedId = graph.nodes.find((node) => node.type === 'set')?.id || graph.nodes[0].id;
  connectingFrom = null;
  zoom = 1;
  dialog.innerHTML = `<header class="flow-header"><div><div class="flow-breadcrumb">${escape(project().name)} ${icon('chevron')} ${escape(lane.name)}</div><h2 id="flow-heading">Lane commands</h2></div>${control('close', '<span class="sr-only">Close lane commands</span>', 'close', 'icon-button')}</header>
    <div class="flow-toolbar"><div>${control('add', 'Add Set field', 'plus', 'button primary')}${control('arrange', 'Arrange', 'board')}</div><p>Runs when a card enters this lane</p><div class="flow-zoom">${control('zoom-out', '−', null, 'button small secondary', 'aria-label="Zoom out"')}<span id="flow-zoom-label">100%</span>${control('zoom-in', '+', null, 'button small secondary', 'aria-label="Zoom in"')}</div></div>
    <div class="flow-workspace"><div class="flow-canvas" tabindex="0" aria-label="Command graph. Scroll to pan; use node headers to move nodes."><div class="flow-canvas-size"><div class="flow-world"><svg class="flow-wires" aria-label="Command connections"></svg><div class="flow-nodes"></div></div></div></div><aside class="flow-inspector" aria-label="Selected command"></aside></div>
    <footer class="flow-footer"><div><p id="flow-status" role="status"></p><p id="flow-error" role="alert" hidden></p></div><div>${control('close', 'Cancel', null)}${control('save', 'Save commands', 'check', 'button primary')}</div></footer>`;
  renderCanvas();
  renderInspector();
  dialog.showModal();
}

function canvasSize() {
  const width = Math.max(900, ...graph.nodes.map((node) => node.position.x + NODE_WIDTH + 80));
  const height = Math.max(600, ...graph.nodes.map((node) => node.position.y + NODE_HEIGHT + 80));
  const size = $('.flow-canvas-size', dialog), world = $('.flow-world', dialog);
  size.style.width = `${width * zoom}px`;
  size.style.height = `${height * zoom}px`;
  world.style.width = `${width}px`;
  world.style.height = `${height}px`;
  world.style.transform = `scale(${zoom})`;
  $('#flow-zoom-label').textContent = `${Math.round(zoom * 100)}%`;
}
function renderCanvas() {
  $('.flow-nodes', dialog).innerHTML = graph.nodes.map((node) => {
    const entry = node.type === 'entry';
    return `<article class="flow-node ${entry ? 'flow-trigger' : ''} ${node.id === selectedId ? 'selected' : ''}" data-node="${node.id}">
      ${entry ? '' : `<button type="button" class="flow-port flow-port-in" data-flow-action="input" data-node-id="${node.id}" aria-label="Connect to ${escape(nodeLabel(node))}" title="Connect here"></button>`}
      <button type="button" class="flow-node-handle" data-flow-action="select" data-node-id="${node.id}" aria-label="${entry ? 'Card enters lane' : `Set ${escape(nodeLabel(node))}`}. Drag to move, or use arrow keys.">${icon(entry ? 'arrow' : 'edit')}<span>${entry ? 'TRIGGER' : 'SET FIELD'}</span>${icon('grip')}</button>
      <button type="button" class="flow-node-content" data-flow-action="select" data-node-id="${node.id}"><strong data-node-label>${entry ? 'Card enters lane' : escape(nodeLabel(node))}</strong><span data-node-preview>${entry ? 'New cards and cards moved here' : escape(preview(node))}</span></button>
      <button type="button" class="flow-port flow-port-out ${connectingFrom === node.id ? 'connecting' : ''}" data-flow-action="output" data-node-id="${node.id}" aria-label="Connect from ${entry ? 'Card enters lane' : escape(nodeLabel(node))}" title="Connect to another node"></button>
    </article>`;
  }).join('');
  for (const node of graph.nodes) {
    const element = $(`[data-node="${node.id}"]`, dialog);
    element.style.left = `${node.position.x}px`;
    element.style.top = `${node.position.y}px`;
  }
  canvasSize();
  renderWires();
  feedback();
}
function renderWires() {
  $('.flow-wires', dialog).innerHTML = graph.edges.map((edge) => {
    const source = graph.nodes.find((node) => node.id === edge.from), target = graph.nodes.find((node) => node.id === edge.to);
    const x1 = source.position.x + NODE_WIDTH, y1 = source.position.y + NODE_HEIGHT / 2;
    const x2 = target.position.x, y2 = target.position.y + NODE_HEIGHT / 2;
    const bend = Math.max(60, Math.abs(x2 - x1) / 2);
    const path = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
    return `<g class="flow-wire" tabindex="0" role="button" data-flow-action="remove-edge" data-edge-id="${edge.id}" aria-label="Remove connection from ${escape(source.type === 'entry' ? 'Card enters lane' : nodeLabel(source))} to ${escape(nodeLabel(target))}"><path class="flow-wire-hit" d="${path}"/><path class="flow-wire-line" d="${path}"/><circle cx="${x2 - 7}" cy="${y2}" r="3"/></g>`;
  }).join('');
}
function renderInspector() {
  const node = selected(), inspector = $('.flow-inspector', dialog);
  const scrollTop = inspector.dataset.nodeId === node.id ? inspector.scrollTop : 0;
  inspector.dataset.nodeId = node.id;
  if (node.type === 'entry') {
    inspector.innerHTML = `<span class="flow-inspector-kicker">TRIGGER</span><h3>Card enters lane</h3><p class="field-help">Connected commands run when a card is created in “${escape(lane.name)}” or moved here. Reordering within this lane does not run them.</p><div class="flow-inspector-note">Start with Set field, then connect more commands in the order you want them to run.</div>`;
    return;
  }
  const assignments = assignmentsFor(node);
  inspector.innerHTML = `<span class="flow-inspector-kicker">COMMAND</span><h3>Set field</h3><p class="field-help">Set several card fields in one command. Values apply from top to bottom.</p><div class="flow-fields-heading"><span>Fields to set</span>${control('add-field', '<span class="sr-only">Add field</span>', 'plus', 'icon-button flow-add-field', 'title="Add field"')}</div><div class="flow-assignments">${assignments.map((assignment, index) => {
    const field = setFields.find((field) => field.key === assignment.field);
    return `<div class="flow-assignment" data-assignment-index="${index}"><div class="flow-assignment-heading"><label class="form-label" for="${rowId('field', index)}">Field${assignments.length > 1 ? ` ${index + 1}` : ''}</label>${assignments.length > 1 ? control('remove-field', `<span class="sr-only">Remove field ${index + 1}</span>`, 'close', 'icon-button', `data-assignment-index="${index}" title="Remove field ${index + 1}"`) : ''}</div><select id="${rowId('field', index)}" class="form-input flow-field-select">${setFields.map((field) => `<option value="${field.key}" ${field.key === assignment.field ? 'selected' : ''}>${escape(field.label)}</option>`).join('')}</select><label class="form-label flow-value-label" for="${rowId('value', index)}">Value</label><textarea id="${rowId('value', index)}" class="form-input flow-field-value" maxlength="${field.max}" placeholder="Enter the value to set…">${escape(assignment.value)}</textarea><span id="${rowId('value-count', index)}" class="flow-value-count">${assignment.value.length.toLocaleString()} / ${field.max.toLocaleString()}</span></div>`;
  }).join('')}</div><p class="field-help">An empty value clears that field. Other card fields stay as they are.</p><div class="flow-inspector-actions">${control('remove-node', 'Delete command', 'trash', 'text-button danger')}</div>`;
  inspector.scrollTop = scrollTop;
}
function feedback(message = '') {
  let status;
  try {
    const valid = validateGraph(graph);
    const count = valid.nodes.length - 1;
    status = count ? `${count} ${count === 1 ? 'command' : 'commands'} · Save to apply on future entries` : 'No commands · Cards keep their values';
  } catch (error) { status = error.message; }
  $('#flow-status').textContent = connectingFrom ? 'Select an input circle to connect. Press Escape to cancel the connection.' : status;
  $('#flow-error').hidden = !message;
  $('#flow-error').textContent = message;
}
function selectNode(nodeId) {
  selectedId = nodeId;
  dialog.querySelectorAll('.flow-node').forEach((node) => node.classList.toggle('selected', node.dataset.node === nodeId));
  renderInspector();
}
function addNode() {
  if (graph.nodes.length >= 50) return feedback('A flow can hold up to 49 commands.');
  const from = selected();
  const node = { id: id(), type: 'set', position: { x: Math.min(9700, from.position.x + 312), y: from.position.y }, config: { assignments: [{ field: 'prompt', value: '' }] } };
  // Avoid placing two commands on top of one another when adding a branch.
  while (graph.nodes.some((other) => Math.abs(other.position.x - node.position.x) < NODE_WIDTH && Math.abs(other.position.y - node.position.y) < NODE_HEIGHT)) {
    node.position.y += 180;
  }
  node.position.y = Math.min(9700, node.position.y);
  graph.nodes.push(node);
  graph.edges.push({ id: id(), from: from.id, to: node.id });
  selectedId = node.id;
  connectingFrom = null;
  renderCanvas();
  renderInspector();
  $(`[data-node="${node.id}"]`, dialog).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#flow-value').focus();
}
function connect(to) {
  if (!connectingFrom) return feedback('Select an output circle first, then this input circle.');
  const from = connectingFrom;
  if (from === to || graph.edges.some((edge) => edge.from === from && edge.to === to)) return feedback('Choose a different node that is not already connected.');
  const reached = new Set([to]);
  for (let i = 0; i < graph.nodes.length; i++) for (const edge of graph.edges) if (reached.has(edge.from)) reached.add(edge.to);
  if (reached.has(from)) return feedback('This connection would form a loop.');
  if (graph.edges.length >= 100) return feedback('A flow can hold up to 100 connections.');
  graph.edges.push({ id: id(), from, to });
  connectingFrom = null;
  renderCanvas();
}
function removeNode() {
  const node = selected();
  if (node.type === 'entry') return;
  const before = graph.edges.filter((edge) => edge.to === node.id), after = graph.edges.filter((edge) => edge.from === node.id);
  graph.nodes = graph.nodes.filter((item) => item.id !== node.id);
  graph.edges = graph.edges.filter((edge) => edge.from !== node.id && edge.to !== node.id);
  // Deleting a command keeps the surrounding chain connected.
  for (const incoming of before) for (const outgoing of after) {
    if (!graph.edges.some((edge) => edge.from === incoming.from && edge.to === outgoing.to)) graph.edges.push({ id: id(), from: incoming.from, to: outgoing.to });
  }
  selectedId = graph.nodes.find((node) => node.type === 'entry').id;
  connectingFrom = null;
  renderCanvas();
  renderInspector();
}
function arrange() {
  try { validateGraph(graph); } catch (error) { return feedback(error.message); }
  const depths = new Map();
  const pending = new Set(graph.nodes.map((node) => node.id));
  const rows = new Map();
  while (pending.size) {
    const node = graph.nodes.find((node) => pending.has(node.id) && graph.edges.filter((edge) => edge.to === node.id).every((edge) => depths.has(edge.from)));
    const depth = Math.max(0, ...graph.edges.filter((edge) => edge.to === node.id).map((edge) => depths.get(edge.from) + 1));
    depths.set(node.id, depth);
    const row = rows.get(depth) || 0;
    node.position = { x: 48 + depth * 312, y: 100 + row * 180 };
    // Long graphs can wrap into rows while preserving their connections.
    if (node.position.x > 9700) node.position = { x: 48 + (depth % 30) * 312, y: 100 + (Math.floor(depth / 30) + row) * 180 };
    rows.set(depth, row + 1);
    pending.delete(node.id);
  }
  renderCanvas();
}
async function save() {
  let valid;
  try { valid = validateGraph(graph); } catch (error) { return feedback(error.message); }
  saving = true;
  dialog.querySelectorAll('button, input, select, textarea').forEach((input) => { input.disabled = true; });
  $('#flow-status').textContent = 'Saving commands…';
  try {
    await saveLaneGraph(lane, valid);
    renderBoard();
    const countLabel = $(`[data-command-count="${lane.id}"]`);
    const count = valid.nodes.length - 1;
    if (countLabel) countLabel.textContent = count ? `${count} ${count === 1 ? 'command runs' : 'commands run'} on entry.` : 'No commands configured.';
    dialog.close();
    toast('Lane commands saved.');
  } catch (error) { feedback(error.message); }
  finally {
    saving = false;
    dialog.querySelectorAll('button, input, select, textarea').forEach((input) => { input.disabled = false; });
  }
}

dialog.addEventListener('click', (event) => {
  const target = event.target.closest('[data-flow-action]');
  if (!target || saving) return;
  const action = target.dataset.flowAction;
  if (action === 'close') dialog.close();
  if (action === 'add') addNode();
  if (action === 'add-field') {
    const node = selected(), assignments = assignmentsFor(node);
    const unused = setFields.find((field) => !assignments.some((assignment) => assignment.field === field.key));
    assignments.push({ field: unused?.key ?? 'prompt', value: '' });
    renderCanvas();
    renderInspector();
    $(`#${rowId('field', assignments.length - 1)}`).focus();
  }
  if (action === 'remove-field') {
    const assignments = assignmentsFor(selected());
    if (assignments.length > 1) assignments.splice(Number(target.dataset.assignmentIndex), 1);
    renderCanvas();
    renderInspector();
    $('#flow-field').focus();
  }
  if (action === 'select') selectNode(target.dataset.nodeId);
  if (action === 'output') {
    connectingFrom = connectingFrom === target.dataset.nodeId ? null : target.dataset.nodeId;
    renderCanvas();
  }
  if (action === 'input') connect(target.dataset.nodeId);
  if (action === 'remove-node') removeNode();
  if (action === 'remove-edge') { graph.edges = graph.edges.filter((edge) => edge.id !== target.dataset.edgeId); renderCanvas(); }
  if (action === 'arrange') arrange();
  if (action === 'zoom-in' || action === 'zoom-out') { zoom = Math.min(1.5, Math.max(.5, zoom + (action === 'zoom-in' ? .1 : -.1))); canvasSize(); }
  if (action === 'save') save();
});
dialog.addEventListener('input', (event) => {
  if (!event.target.classList.contains('flow-field-value') || saving) return;
  const node = selected();
  const index = Number(event.target.closest('[data-assignment-index]').dataset.assignmentIndex);
  const assignment = assignmentsFor(node)[index];
  assignment.value = event.target.value;
  $(`[data-node="${node.id}"] [data-node-preview]`, dialog).textContent = preview(node);
  $(`#${rowId('value-count', index)}`).textContent = `${assignment.value.length.toLocaleString()} / ${setFields.find((field) => field.key === assignment.field).max.toLocaleString()}`;
  feedback();
});
dialog.addEventListener('change', (event) => {
  if (!event.target.classList.contains('flow-field-select') || saving) return;
  const node = selected();
  const index = Number(event.target.closest('[data-assignment-index]').dataset.assignmentIndex);
  assignmentsFor(node)[index].field = event.target.value;
  renderCanvas();
  renderInspector();
  $(`#${rowId('field', index)}`).focus();
});
dialog.addEventListener('cancel', (event) => {
  if (saving || connectingFrom) event.preventDefault();
  if (connectingFrom) { connectingFrom = null; renderCanvas(); }
});
dialog.addEventListener('keydown', (event) => {
  const wire = event.target.closest('.flow-wire');
  if (wire && (event.key === 'Enter' || event.key === ' ' || event.key === 'Delete')) {
    event.preventDefault();
    wire.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
  const handle = event.target.closest('.flow-node-handle');
  const offsets = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (!handle || !offsets[event.key] || saving) return;
  event.preventDefault();
  const node = graph.nodes.find((node) => node.id === handle.dataset.nodeId);
  const [dx, dy] = offsets[event.key], step = event.shiftKey ? 4 : 16;
  node.position.x = Math.min(9700, Math.max(24, node.position.x + dx * step));
  node.position.y = Math.min(9700, Math.max(24, node.position.y + dy * step));
  moveNodeElement(node);
});
function moveNodeElement(node) {
  const element = $(`[data-node="${node.id}"]`, dialog);
  element.style.left = `${node.position.x}px`;
  element.style.top = `${node.position.y}px`;
  canvasSize();
  renderWires();
}
dialog.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('.flow-node-handle');
  if (!handle || event.button !== 0 || saving) return;
  const node = graph.nodes.find((node) => node.id === handle.dataset.nodeId);
  selectNode(node.id);
  const canvas = $('.flow-canvas', dialog);
  drag = { node, pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: { ...node.position }, scrollLeft: canvas.scrollLeft, scrollTop: canvas.scrollTop };
  handle.setPointerCapture(event.pointerId);
});
dialog.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const canvas = $('.flow-canvas', dialog);
  drag.node.position.x = Math.min(9700, Math.max(24, drag.start.x + (event.clientX - drag.x + canvas.scrollLeft - drag.scrollLeft) / zoom));
  drag.node.position.y = Math.min(9700, Math.max(24, drag.start.y + (event.clientY - drag.y + canvas.scrollTop - drag.scrollTop) / zoom));
  moveNodeElement(drag.node);
});
dialog.addEventListener('pointerup', () => { drag = null; });
dialog.addEventListener('pointercancel', () => { drag = null; });
dialog.addEventListener('close', () => { drag = null; connectingFrom = null; });
