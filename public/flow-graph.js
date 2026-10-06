// The saved command graph and its synchronous Set field runner. The editor
// and server share validation; neither relies on canvas position for order.
import { templates, defaultTemplate } from './card-template.js';

export const setFields = [
  { key: 'title', ...templates[defaultTemplate].title },
  ...templates[defaultTemplate].fields,
];
export function emptyGraph() {
  return { version: 1, nodes: [{ id: 'entry', type: 'entry', position: { x: 48, y: 100 } }], edges: [] };
}
export function promptGraph(prompt) {
  const graph = emptyGraph();
  if (prompt !== null) {
    graph.nodes.push({ id: 'set-prompt', type: 'set', position: { x: 360, y: 100 }, config: { field: 'prompt', value: prompt } });
    graph.edges.push({ id: 'entry-prompt', from: 'entry', to: 'set-prompt' });
  }
  return graph;
}
// Existing single-field nodes stay readable; new nodes use an assignment list.
export function assignmentsFor(node) {
  return node.config.assignments ?? [{ field: node.config.field, value: node.config.value }];
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const check = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { status: 400 }); };

// A stable topological order: independent commands run in their saved node
// order. Cycles and disconnected commands cannot be saved or executed.
function orderedNodes(graph) {
  const entry = graph.nodes.find((node) => node.type === 'entry');
  const reached = new Set([entry.id]);
  for (let i = 0; i < graph.nodes.length; i++) {
    for (const edge of graph.edges) if (reached.has(edge.from)) reached.add(edge.to);
  }
  check(reached.size === graph.nodes.length, 'Connect every Set field node to Card enters lane.');
  const remaining = new Set(graph.nodes.map((node) => node.id));
  const result = [];
  while (remaining.size) {
    const next = graph.nodes.find((node) => remaining.has(node.id) && !graph.edges.some((edge) => edge.to === node.id && remaining.has(edge.from)));
    check(next, 'Connections must not form a loop.');
    remaining.delete(next.id);
    result.push(next);
  }
  return result;
}

export function validateGraph(value) {
  check(object(value) && value.version === 1 && Array.isArray(value.nodes) && Array.isArray(value.edges), 'Invalid command graph.');
  check(value.nodes.length >= 1 && value.nodes.length <= 50 && value.edges.length <= 100, 'A flow can hold up to 49 commands and 100 connections.');
  check(JSON.stringify(value).length <= 4000000, 'The command graph can use up to 4,000,000 characters.');
  const ids = new Set();
  const nodes = value.nodes.map((node) => {
    check(object(node) && validId(node.id) && !ids.has(node.id), 'Every node needs a unique ID.');
    ids.add(node.id);
    check(node.type === 'entry' || node.type === 'set', 'Unknown command type. Only Set field is available now.');
    check(object(node.position) && ['x', 'y'].every((axis) => Number.isFinite(node.position[axis]) && node.position[axis] >= 0 && node.position[axis] <= 10000), 'Invalid node position.');
    const normalized = { id: node.id, type: node.type, position: { x: node.position.x, y: node.position.y } };
    if (node.type === 'set') {
      check(object(node.config), 'Set field needs a field and value.');
      const multiple = Object.hasOwn(node.config, 'assignments');
      const assignments = multiple ? node.config.assignments : [node.config];
      check(Array.isArray(assignments) && assignments.length > 0, 'Set field needs at least one field and value.');
      const checked = assignments.map((assignment) => {
        check(object(assignment), 'Each field needs a field and value.');
        const field = setFields.find((field) => field.key === assignment.field);
        check(field, 'Choose an available card field.');
        check(typeof assignment.value === 'string' && assignment.value.length <= field.max, `${field.label} can be up to ${field.max.toLocaleString('en-US')} characters.`);
        return { field: field.key, value: assignment.value };
      });
      normalized.config = multiple ? { assignments: checked } : checked[0];
    }
    return normalized;
  });
  check(nodes.filter((node) => node.type === 'entry').length === 1, 'A flow needs exactly one Card enters lane node.');
  const edgeIds = new Set(), pairs = new Set();
  const edges = value.edges.map((edge) => {
    check(object(edge) && validId(edge.id) && !edgeIds.has(edge.id), 'Every connection needs a unique ID.');
    edgeIds.add(edge.id);
    check(ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to, 'Connect two different nodes in this graph.');
    check(nodes.find((node) => node.id === edge.to).type !== 'entry', 'Card enters lane cannot have an incoming connection.');
    const pair = `${edge.from}:${edge.to}`;
    check(!pairs.has(pair), 'These nodes are already connected.');
    pairs.add(pair);
    return { id: edge.id, from: edge.from, to: edge.to };
  });
  const graph = { version: 1, nodes, edges };
  orderedNodes(graph);
  return graph;
}

export function executeGraph(graph, card) {
  const values = {}, steps = [];
  const template = templates[card.template];
  for (const node of orderedNodes(graph)) {
    if (node.type === 'entry') continue;
    // Add new command handlers here when their execution is implemented.
    for (const { field: key, value } of assignmentsFor(node)) {
      const field = key === 'title' ? template.title : template.fields.find((field) => field.key === key);
      check(field && value.length <= field.max, 'This card template cannot use the configured field value.');
      values[key] = value;
      steps.push({ nodeId: node.id, field: key });
    }
  }
  return { values, steps };
}
