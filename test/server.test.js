import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.js';
import { emptyGraph, promptGraph } from '../public/flow-graph.js';

async function start(dataDir, options = {}) {
  const app = await createApp({ dataDir, ...options });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (method, url, body) => {
    const result = await call(method, url, body);
    assert.ok(result.status < 300, `${method} ${url} → ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const close = () => new Promise((resolve) => app.close(resolve));
  return { app, base, call, ok, close };
}

async function fixture(t, options) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-test-'));
  const server = await start(dataDir, options);
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const workspace = await server.ok('GET', '/api/workspace');
  const project = workspace.projects[0];
  const stages = workspace.flows.find((flow) => flow.id === project.flowId).stages;
  const card = (body = {}) => server.ok('POST', `/api/projects/${project.id}/cards`, { stageId: stages[0].id, ...body });
  const cards = async () => (await server.ok('GET', `/api/projects/${project.id}/cards`)).cards;
  return { ...server, dataDir, workspace, project, stages, card, cards };
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
const imageId = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000.png`;

function commandChain(commands) {
  const graph = emptyGraph();
  commands.forEach(([field, value], index) => {
    const nodeId = `set-${index}`;
    graph.nodes.push({ id: nodeId, type: 'set', position: { x: 360 + index * 312, y: 100 }, config: { field, value } });
    graph.edges.push({ id: `edge-${index}`, from: index ? `set-${index - 1}` : 'entry', to: nodeId });
  });
  return graph;
}

test('one Set field node saves multiple assignments and applies them together in row order', async (t) => {
  const f = await fixture(t);
  const graph = promptGraph('Original');
  const assignments = [
    { field: 'prompt', value: 'First prompt' },
    { field: 'intro', value: 'Set intro' },
    { field: 'title', value: 'Set title' },
    { field: 'prompt', value: 'Final prompt' },
  ];
  graph.nodes[1].config = { assignments };
  const saved = await f.ok('PATCH', `/api/stages/${f.stages[1].id}`, { entryGraph: graph });
  assert.deepEqual(saved.entryGraph.nodes[1].config.assignments, assignments);
  const card = await f.card({ fields: { script: 'Keep script' } });
  const moved = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[1].id });
  assert.equal(moved.card.title, 'Set title');
  assert.equal(moved.card.fields.prompt, 'Final prompt');
  assert.equal(moved.card.fields.intro, 'Set intro');
  assert.equal(moved.card.fields.script, 'Keep script');
  assert.equal(moved.card.revision, 2);
  const history = (await f.ok('GET', `/api/cards/${card.id}`)).events;
  assert.deepEqual(history.at(-1).data.steps.map((step) => step.field), ['prompt', 'intro', 'title', 'prompt']);
  assert.ok(history.at(-1).data.steps.every((step) => step.nodeId === 'set-prompt'));
  for (const invalid of [[], null, [{ field: 'prompt', value: 'Valid' }, { field: 'missing', value: 'Invalid' }], [{ field: 'title', value: 'x'.repeat(501) }]]) {
    const badGraph = structuredClone(graph);
    badGraph.nodes[1].config.assignments = invalid;
    assert.equal((await f.call('PATCH', `/api/stages/${f.stages[1].id}`, { entryGraph: badGraph })).status, 400);
  }
  assert.deepEqual((await f.ok('GET', '/api/workspace')).flows[0].stages[1].entryGraph, graph);
  const created = await f.card({ stageId: f.stages[1].id });
  assert.equal(created.title, 'Set title');
  assert.equal(created.fields.prompt, 'Final prompt');
  assert.equal(created.fields.intro, 'Set intro');
});

test('connected Set field commands run in edge order and preserve unrelated content', async (t) => {
  const f = await fixture(t);
  const graph = commandChain([['title', 'First title'], ['title', 'Final title'], ['intro', 'New introduction'], ['prompt', 'Review it']]);
  // Stored array order and canvas positions deliberately differ from execution.
  graph.nodes.reverse();
  graph.nodes[0].position = { x: 40, y: 360 };
  await f.ok('PATCH', `/api/stages/${f.stages[1].id}`, { entryGraph: graph });
  const created = await f.card({ title: 'Old title', fields: { script: 'Keep my script', prompt: 'Old prompt' } });
  const moved = await f.ok('POST', `/api/cards/${created.id}/transitions`, { action: 'move', toStageId: f.stages[1].id });
  assert.equal(moved.card.title, 'Final title');
  assert.equal(moved.card.fields.intro, 'New introduction');
  assert.equal(moved.card.fields.prompt, 'Review it');
  assert.equal(moved.card.fields.script, 'Keep my script');
  assert.equal(moved.card.revision, 2, 'The whole graph increments the revision once');
  assert.deepEqual(moved.fieldUpdate, { beforeRevision: 1, revision: 2, values: { title: 'Final title', intro: 'New introduction', prompt: 'Review it' } });
  const history = (await f.ok('GET', `/api/cards/${created.id}`)).events;
  assert.deepEqual(history.at(-1).data.steps.map((step) => step.nodeId), ['set-0', 'set-1', 'set-2', 'set-3']);
  assert.equal(history.at(-1).actor, `automation:${f.stages[1].id}`);
  const sameLane = await f.ok('POST', `/api/cards/${created.id}/transitions`, { action: 'move', toStageId: f.stages[1].id });
  assert.equal(sameLane.fieldUpdate, null);
  const initial = await f.card({ stageId: f.stages[1].id, fields: { script: 'Creation script' } });
  assert.equal(initial.title, 'Final title');
  assert.equal(initial.fields.script, 'Creation script');
  const reopened = await start(f.dataDir);
  try { assert.deepEqual((await reopened.ok('GET', '/api/workspace')).flows[0].stages[1].entryGraph, graph); }
  finally { await reopened.close(); }
});

test('invalid graphs cannot replace the saved graph, and clearing commands disables entry actions', async (t) => {
  const f = await fixture(t);
  const graph = commandChain([['prompt', 'Saved prompt'], ['intro', 'Saved intro']]);
  await f.ok('PATCH', `/api/stages/${f.stages[1].id}`, { entryGraph: graph });
  const invalid = [
    { ...graph, version: 2 },
    { ...graph, edges: [] },
    { ...graph, edges: [...graph.edges, { id: 'cycle', from: 'set-1', to: 'set-0' }] },
    { ...graph, edges: [...graph.edges, { id: 'missing', from: 'set-1', to: 'no-node' }] },
    { ...graph, nodes: [...graph.nodes, graph.nodes[1]] },
    commandChain([['missingField', 'Value']]),
    commandChain([['title', 'x'.repeat(501)]]),
    commandChain([['prompt', 42]]),
    { ...graph, nodes: graph.nodes.map((node) => node.type === 'set' ? { ...node, type: 'llm' } : node) },
    { ...graph, nodes: graph.nodes.map((node) => ({ ...node, position: { x: -10, y: 0 } })) },
  ];
  for (const entryGraph of invalid) {
    assert.equal((await f.call('PATCH', `/api/stages/${f.stages[1].id}`, { entryGraph })).status, 400);
  }
  assert.deepEqual((await f.ok('GET', '/api/workspace')).flows[0].stages[1].entryGraph, graph);
  const created = await f.card({ stageId: f.stages[1].id });
  await f.ok('PATCH', `/api/stages/${f.stages[1].id}`, { entryGraph: emptyGraph() });
  assert.equal((await f.ok('GET', `/api/cards/${created.id}`)).card.fields.prompt, 'Saved prompt', 'Saving settings does not run them on existing cards');
  const disabled = await f.card({ stageId: f.stages[1].id, fields: { prompt: 'Manual' } });
  assert.equal(disabled.fields.prompt, 'Manual');
  assert.equal(disabled.revision, 1);
});

test('existing lane prompt settings upgrade to a connected Set field graph without changing card history', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-graph-upgrade-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = await start(dataDir);
  let stageId, projectId, card;
  try {
    const workspace = await first.ok('GET', '/api/workspace');
    stageId = workspace.flows[0].stages[0].id;
    projectId = workspace.projects[0].id;
    card = await first.ok('POST', `/api/projects/${projectId}/cards`, { stageId, fields: { prompt: 'Existing card prompt' } });
  } finally { await first.close(); }
  const db = new DatabaseSync(path.join(dataDir, 'frameboard.db'));
  db.exec("DROP TABLE card_moves; ALTER TABLE stages DROP COLUMN entry_graph; UPDATE meta SET value = '2' WHERE key = 'schema_version';");
  db.prepare('UPDATE stages SET entry_prompt = ? WHERE id = ?').run('Existing lane prompt', stageId);
  db.close();
  const upgraded = await start(dataDir);
  try {
    const lane = (await upgraded.ok('GET', '/api/workspace')).flows[0].stages[0];
    assert.deepEqual(lane.entryGraph, promptGraph('Existing lane prompt'));
    const original = await upgraded.ok('GET', `/api/cards/${card.id}`);
    assert.deepEqual(original.card, card);
    assert.deepEqual(original.events.map((event) => event.type), ['created']);
    const newCard = await upgraded.ok('POST', `/api/projects/${projectId}/cards`, { stageId });
    assert.equal(newCard.fields.prompt, 'Existing lane prompt');
  } finally { await upgraded.close(); }
});

test('lane entry prompts apply atomically to creation and transitions, with history and revisions', async (t) => {
  const f = await fixture(t);
  const prompt = 'Review the script.\nSuggest a better hook.';
  await f.ok('PATCH', `/api/stages/${f.stages[1].id}`, { entryPrompt: prompt });
  const card = await f.card({ fields: { prompt: 'Draft prompt', script: 'Keep the script' } });
  const move = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'approve' });
  assert.equal(move.card.fields.prompt, prompt);
  assert.equal(move.card.fields.script, 'Keep the script');
  assert.equal(move.card.revision, 2);
  assert.deepEqual(move.promptUpdate, { beforeRevision: 1, revision: 2, prompt });
  assert.equal((await f.call('PATCH', `/api/cards/${card.id}`, { revision: 1, title: 'Stale' })).status, 409);
  const { events } = await f.ok('GET', `/api/cards/${card.id}`);
  assert.deepEqual(events.map((event) => event.type), ['created', 'approved', 'fields_set']);
  assert.equal(events.at(-1).actor, `automation:${f.stages[1].id}`);
  const feed = await f.ok('GET', '/api/events?since=0');
  assert.ok(feed.events.some((event) => event.entityId === card.id && event.type === 'fields_set'));

  const created = await f.card({ stageId: f.stages[1].id, fields: { prompt: 'Replaced', intro: 'Retained' } });
  assert.equal(created.fields.prompt, prompt);
  assert.equal(created.fields.intro, 'Retained');
  await f.ok('PATCH', `/api/cards/${card.id}`, { revision: 2, fields: { prompt: 'My own edit' } });
  const reorder = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[1].id, beforeCardId: created.id });
  assert.equal(reorder.card.fields.prompt, 'My own edit');
  assert.equal(reorder.card.revision, 3);
  assert.equal(reorder.promptUpdate, null);
  await f.ok('PATCH', `/api/stages/${f.stages[0].id}`, { entryPrompt: 'Back to drafting' });
  const back = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'send_back' });
  assert.equal(back.card.fields.prompt, 'Back to drafting');
  const reentry = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[1].id });
  assert.equal(reentry.card.fields.prompt, prompt);
});

test('lane prompt settings distinguish disabled from empty and leave existing cards alone', async (t) => {
  const f = await fixture(t);
  const card = await f.card({ fields: { prompt: 'Keep' } });
  const lane = await f.ok('POST', `/api/flows/${f.project.flowId}/stages`, { name: 'Clear prompt', color: 'teal', entryPrompt: '' });
  assert.equal(lane.entryPrompt, '');
  for (const entryPrompt of [42, {}, false, 'x'.repeat(200001)]) {
    assert.equal((await f.call('PATCH', `/api/stages/${lane.id}`, { entryPrompt })).status, 400);
    assert.equal((await f.call('POST', `/api/flows/${f.project.flowId}/stages`, { name: 'Invalid', color: 'blue', entryPrompt })).status, 400);
  }
  await f.ok('PATCH', `/api/stages/${f.stages[0].id}`, { entryPrompt: 'Future entries only' });
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.prompt, 'Keep');
  const cleared = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: lane.id });
  assert.equal(cleared.card.fields.prompt, '');
  await f.ok('PATCH', `/api/stages/${lane.id}`, { entryPrompt: null });
  const disabled = await f.card({ stageId: lane.id, fields: { prompt: 'Manual' } });
  assert.equal(disabled.fields.prompt, 'Manual');
  await f.ok('PATCH', `/api/stages/${lane.id}`, { entryPrompt: 'Manual' });
  await f.ok('POST', `/api/cards/${disabled.id}/transitions`, { action: 'move', toStageId: f.stages[2].id });
  const unchanged = await f.ok('POST', `/api/cards/${disabled.id}/transitions`, { action: 'move', toStageId: lane.id });
  assert.equal(unchanged.card.revision, disabled.revision);
  assert.equal(unchanged.promptUpdate.prompt, 'Manual');
});

test('upgrading a database adds disabled lane entry prompts without changing its cards', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-upgrade-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = await start(dataDir);
  let card;
  try {
    const workspace = await first.ok('GET', '/api/workspace');
    card = await first.ok('POST', `/api/projects/${workspace.projects[0].id}/cards`, { stageId: workspace.flows[0].stages[0].id, fields: { prompt: 'Saved before upgrade' } });
  } finally { await first.close(); }
  const db = new DatabaseSync(path.join(dataDir, 'frameboard.db'));
  db.exec("DROP TABLE card_moves; ALTER TABLE stages DROP COLUMN entry_graph; ALTER TABLE stages DROP COLUMN entry_prompt; UPDATE meta SET value = '1' WHERE key = 'schema_version';");
  db.close();
  const reopened = await start(dataDir);
  try {
    assert.deepEqual((await reopened.ok('GET', `/api/cards/${card.id}`)).card, card);
    assert.ok((await reopened.ok('GET', '/api/workspace')).flows.every((flow) => flow.stages.every((stage) => stage.entryPrompt === null)));
  } finally { await reopened.close(); }
});

test('creates a workspace with a default project and keeps card text across restarts', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.stages.map((stage) => stage.name), ['Ideas', 'In progress', 'Review', 'Done']);
  assert.equal(f.project.name, 'My project');
  const created = await f.card({ id: 'card-1', stageId: f.stages[1].id, title: 'A film idea' });
  assert.equal(created.revision, 1);
  assert.deepEqual(created.fields, { originalVideoUrl: '', originalVideoTitle: '', titleOptions: '', intro: '', script: '', prompt: '', publishedVideoUrl: '' });
  const fields = { titleOptions: 'First title\nAnother angle', intro: 'A hook\nwith two lines', script: 'Full script', originalVideoTitle: 'An inspiring video', originalVideoUrl: 'https://example.com/inspiration?v=1&list=2', publishedVideoUrl: 'https://example.com/published' };
  const updated = await f.ok('PATCH', '/api/cards/card-1', { revision: 1, fields });
  assert.equal(updated.revision, 2);
  assert.ok(Date.parse(updated.updatedAt) >= Date.parse(created.updatedAt));
  await f.ok('PATCH', `/api/stages/${f.stages[0].id}`, { name: 'New ideas' });
  const reopened = await start(f.dataDir);
  const [loaded] = (await reopened.ok('GET', `/api/projects/${f.project.id}/cards`)).cards;
  assert.deepEqual(loaded, updated);
  assert.deepEqual(loaded.fields, { ...created.fields, ...fields });
  assert.equal((await reopened.ok('GET', '/api/workspace')).flows[0].stages[0].name, 'New ideas');
  await reopened.close();
});

test('uploads original image bytes and keeps the selected display image', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/api/images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const image = await fetch(`${f.base}/images/${id}`);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const card = await f.card({ title: 'Image card', images: [{ id, name: 'image.png' }], imageRoles: { cover: id } });
  assert.equal((await f.cards())[0].imageRoles.cover, id);
  const { events } = await f.ok('GET', `/api/cards/${card.id}`);
  assert.deepEqual(events.map((event) => event.type), ['created']);
  await f.ok('PATCH', `/api/cards/${card.id}`, { revision: 1, images: [], imageRoles: { cover: null } });
  const after = await f.ok('GET', `/api/cards/${card.id}`);
  assert.deepEqual(after.events.at(-1).data, { added: [], removed: [id], roles: ['cover'] });
});

test('rejects stale card edits without blocking edits to other cards', async (t) => {
  const f = await fixture(t);
  const first = await f.card();
  const second = await f.card();
  const responses = await Promise.all([1, 2].map((n) => f.call('PATCH', `/api/cards/${first.id}`, { revision: 1, title: `Tab ${n}` })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.match(responses.find((response) => response.status === 409).body.error, /another tab/);
  assert.equal((await f.call('PATCH', `/api/cards/${second.id}`, { revision: 1, title: 'Unaffected' })).status, 200);
  assert.equal((await f.call('PATCH', `/api/cards/${first.id}`, { title: 'No revision' })).status, 400);
});

test('invalid card data cannot replace a saved card', async (t) => {
  const f = await fixture(t);
  const card = await f.card({ title: 'Kept' });
  for (const body of [
    { revision: 1, imageRoles: { cover: imageId(1) } },
    { revision: 1, images: [{ id: imageId(1), name: 'a.png' }], imageRoles: { original: imageId(2) } },
    { revision: 1, images: [{ id: '../board.json', name: 'a.png' }] },
    { revision: 1, images: [{ id: imageId(1), name: 'a.png' }, { id: imageId(1), name: 'b.png' }] },
    { revision: 1, fields: { notAField: 'x' } },
    { revision: 1, fields: { intro: 5 } },
    { revision: 1, fields: { originalVideoTitle: 'x'.repeat(501) } },
    { revision: 1, title: 'x'.repeat(501) },
    { revision: 1, imageRoles: { thumbnail: null } },
  ]) assert.equal((await f.call('PATCH', `/api/cards/${card.id}`, body)).status, 400, JSON.stringify(body).slice(0, 80));
  const [saved] = await f.cards();
  assert.deepEqual(saved, card);
  assert.equal((await f.call('POST', `/api/projects/${f.project.id}/cards`, { stageId: 'missing' })).status, 404);
  assert.equal((await f.call('PATCH', '/api/cards/missing', { revision: 1 })).status, 404);
  assert.equal((await f.call('PATCH', `/api/cards/${card.id}`, null)).status, 400);
  assert.equal((await fetch(`${f.base}/api/cards/${card.id}`, { method: 'PATCH', body: '{' })).status, 400);
});

test('rejects duplicate IDs, empty names, and unknown lane colors; accepts every palette color', async (t) => {
  const f = await fixture(t);
  await f.card({ id: 'same' });
  assert.equal((await f.call('POST', `/api/projects/${f.project.id}/cards`, { id: 'same', stageId: f.stages[0].id })).status, 400);
  assert.equal((await f.call('POST', `/api/flows/${f.project.flowId}/stages`, { id: f.stages[0].id, name: 'Copy', color: 'blue' })).status, 400);
  assert.equal((await f.call('POST', `/api/flows/${f.project.flowId}/stages`, { name: '  ', color: 'blue' })).status, 400);
  assert.equal((await f.call('POST', '/api/projects', { name: '' })).status, 400);
  assert.equal((await f.call('PATCH', `/api/stages/${f.stages[0].id}`, { color: 'magenta' })).status, 400);
  for (const color of ['teal', 'cyan', 'orange', 'red', 'purple', 'lime']) {
    assert.equal((await f.ok('PATCH', `/api/stages/${f.stages[0].id}`, { color })).color, color);
  }
});

test('adds, reorders, and deletes lanes; deleting a lane removes its cards', async (t) => {
  const f = await fixture(t);
  const added = await f.ok('POST', `/api/flows/${f.project.flowId}/stages`, { id: 'published', name: 'Published', color: 'teal' });
  assert.equal(added.position, 4);
  await f.ok('PATCH', '/api/stages/published', { position: 0 });
  const names = async () => (await f.ok('GET', '/api/workspace')).flows[0].stages.map((stage) => [stage.name, stage.position]);
  assert.deepEqual(await names(), [['Published', 0], ['Ideas', 1], ['In progress', 2], ['Review', 3], ['Done', 4]]);
  const card = await f.card({ stageId: 'published' });
  await f.ok('DELETE', '/api/stages/published');
  assert.deepEqual(await names(), [['Ideas', 0], ['In progress', 1], ['Review', 2], ['Done', 3]]);
  assert.deepEqual(await f.cards(), []);
  assert.equal((await f.call('GET', `/api/cards/${card.id}`)).status, 404);
  assert.equal((await f.ok('GET', '/api/events')).events.find((event) => event.entityId === card.id && event.type === 'deleted').data.reason, 'lane deleted');
});

test('moves are advisory: approve, send back, and drag anywhere, with history and unmet criteria', async (t) => {
  const f = await fixture(t);
  const [ideas, progress, review, done] = f.stages;
  const a = await f.card({ id: 'a', title: 'A' });
  await f.card({ id: 'b' });
  await f.card({ id: 'c' });
  await f.ok('PATCH', `/api/stages/${ideas.id}`, { instructions: 'Is this worth making?', exitCriteria: [{ field: 'intro', rule: 'filled', label: 'Intro written' }, { imageRole: 'original', rule: 'set' }, { field: 'title', rule: 'filled' }] });

  const approved = await f.ok('POST', '/api/cards/a/transitions', { action: 'approve', note: 'Good angle' });
  assert.equal(approved.card.stageId, progress.id);
  assert.equal(approved.card.revision, a.revision, 'moves do not conflict with content edits');
  assert.ok(approved.card.enteredStageAt > a.enteredStageAt || approved.card.enteredStageAt === approved.event.createdAt);
  assert.deepEqual([approved.event.type, approved.event.fromStageId, approved.event.toStageId, approved.event.note], ['approved', ideas.id, progress.id, 'Good angle']);
  assert.deepEqual(approved.event.data.unmet, ['Intro written', 'original image is set']);
  assert.match(approved.event.actor, /^user:/);

  const back = await f.ok('POST', '/api/cards/a/transitions', { action: 'send_back' });
  assert.deepEqual([back.event.type, back.card.stageId, back.event.data], ['sent_back', ideas.id, {}]);
  assert.equal((await f.call('POST', '/api/cards/a/transitions', { action: 'send_back' })).status, 400);

  // Dragging skips stages freely and places the card before another.
  const jumped = await f.ok('POST', '/api/cards/b/transitions', { action: 'move', toStageId: done.id });
  assert.equal(jumped.event.type, 'moved');
  assert.equal((await f.call('POST', '/api/cards/b/transitions', { action: 'approve' })).status, 400);
  await f.ok('POST', '/api/cards/a/transitions', { action: 'move', toStageId: done.id, beforeCardId: 'b' });
  await f.ok('POST', '/api/cards/c/transitions', { action: 'move', toStageId: done.id, beforeCardId: 'b' });
  assert.deepEqual((await f.cards()).map((card) => card.id), ['a', 'c', 'b']);

  // Reordering within a lane is not a review decision, so it is not logged.
  const reordered = await f.ok('POST', '/api/cards/b/transitions', { action: 'move', toStageId: done.id, beforeCardId: 'a' });
  assert.equal(reordered.event, null);
  assert.deepEqual((await f.cards()).map((card) => card.id), ['b', 'a', 'c']);

  // A configured approve target overrides the next lane.
  await f.ok('PATCH', `/api/stages/${ideas.id}`, { approveTo: review.id });
  const d = await f.card({ id: 'd' });
  assert.equal((await f.ok('POST', `/api/cards/${d.id}/transitions`, { action: 'approve' })).card.stageId, review.id);
  assert.equal((await f.call('PATCH', `/api/stages/${ideas.id}`, { approveTo: ideas.id })).status, 400);
  assert.equal((await f.call('PATCH', `/api/stages/${ideas.id}`, { exitCriteria: [{ field: 'intro', rule: 'set' }] })).status, 400);
  assert.equal((await f.call('POST', '/api/cards/a/transitions', { action: 'teleport' })).status, 400);
  assert.equal((await f.call('POST', '/api/cards/a/transitions', { action: 'move', toStageId: 'elsewhere' })).status, 400);

  const history = (await f.ok('GET', '/api/cards/a')).events.map((event) => event.type);
  assert.deepEqual(history, ['created', 'approved', 'sent_back', 'moved']);
});

test('many inserts at the same spot keep a stable order', async (t) => {
  const f = await fixture(t);
  await f.card({ id: 'end' });
  const expected = ['end'];
  // Each insert halves the same gap, so positions run out of precision and
  // the lane gets renumbered along the way.
  for (let i = 0; i < 70; i++) {
    await f.card({ id: `n${i}`, stageId: f.stages[1].id });
    await f.ok('POST', `/api/cards/n${i}/transitions`, { action: 'move', toStageId: f.stages[0].id, beforeCardId: 'end' });
    expected.splice(-1, 0, `n${i}`);
  }
  assert.deepEqual((await f.cards()).map((card) => card.id), expected);
});

test('deletes cards and projects without erasing their history', async (t) => {
  const f = await fixture(t);
  const card = await f.card();
  await f.ok('DELETE', `/api/cards/${card.id}`);
  assert.deepEqual(await f.cards(), []);
  assert.equal((await f.call('DELETE', `/api/cards/${card.id}`)).status, 404);
  const { project, flow } = await f.ok('POST', '/api/projects', { id: 'second', name: 'Second' });
  assert.deepEqual(flow.stages.map((stage) => stage.name), ['Ideas', 'In progress', 'Review', 'Done']);
  await f.ok('POST', `/api/projects/${project.id}/cards`, { stageId: flow.stages[0].id });
  assert.deepEqual((await f.ok('GET', '/api/workspace')).projects.map((item) => [item.name, item.cardCount]), [['My project', 0], ['Second', 1]]);
  await f.ok('PATCH', '/api/projects/second', { name: 'Renamed' });
  await f.ok('DELETE', '/api/projects/second');
  assert.deepEqual((await f.ok('GET', '/api/workspace')).projects.map((item) => item.name), ['My project']);
  assert.equal((await f.call('GET', '/api/projects/second/cards')).status, 404);
  const { events } = await f.ok('GET', '/api/events');
  assert.deepEqual(events.filter((event) => event.entity === 'card').map((event) => [event.type, event.data.reason]), [['created', undefined], ['deleted', 'card deleted'], ['created', undefined], ['deleted', 'project deleted']]);
  assert.deepEqual((await f.ok('GET', `/api/events?since=${events[1].id}`)).events.map((event) => event.id), events.slice(2).map((event) => event.id));
});

test('sets one prompt on every card in a project', async (t) => {
  const f = await fixture(t);
  const first = await f.card();
  await f.card({ stageId: f.stages[2].id });
  const { cards } = await f.ok('POST', `/api/projects/${f.project.id}/prompt`, { prompt: 'Shared' });
  assert.equal(cards.length, 2);
  assert.deepEqual((await f.cards()).map((card) => [card.fields.prompt, card.revision]), [['Shared', 2], ['Shared', 2]]);
  assert.equal((await f.call('PATCH', `/api/cards/${first.id}`, { revision: 1, title: 'stale' })).status, 409);
});

test('change feed includes content, image flags, ordering, and structure without cluttering history', async (t) => {
  const f = await fixture(t);
  const a = await f.card({ images: [{ id: imageId(1), name: 'image.png' }], imageRoles: { cover: imageId(1) } });
  const b = await f.card();
  const { eventCursor } = await f.ok('GET', '/api/workspace');
  await f.ok('PATCH', `/api/cards/${a.id}`, { revision: 1, fields: { intro: 'New intro' } });
  await f.ok('PATCH', `/api/cards/${a.id}`, { revision: 2, imageRoles: { inspiration: imageId(1) } });
  await f.ok('POST', `/api/cards/${b.id}/transitions`, { action: 'move', toStageId: a.stageId, beforeCardId: a.id });
  await f.ok('POST', `/api/projects/${f.project.id}/prompt`, { prompt: 'Prompt' });
  const stage = await f.ok('POST', `/api/flows/${f.project.flowId}/stages`, { name: 'New lane', color: 'blue' });
  await f.ok('PATCH', `/api/stages/${stage.id}`, { name: 'Renamed lane', position: 0 });
  await f.ok('DELETE', `/api/stages/${stage.id}`);
  const { project } = await f.ok('POST', '/api/projects', { name: 'New project' });
  await f.ok('PATCH', `/api/projects/${project.id}`, { name: 'Renamed project' });
  await f.ok('DELETE', `/api/projects/${project.id}`);
  const { events } = await f.ok('GET', `/api/events?since=${eventCursor}`);
  assert.deepEqual(events.map((event) => [event.entity, event.entityId, event.type]), [
    ['card', a.id, 'updated'], ['card', a.id, 'images_changed'], ['card', b.id, 'reordered'],
    ['card', a.id, 'updated'], ['card', b.id, 'updated'],
    ['stage', stage.id, 'created'], ['stage', stage.id, 'updated'], ['stage', stage.id, 'deleted'],
    ['project', project.id, 'created'], ['project', project.id, 'updated'], ['project', project.id, 'deleted'],
  ]);
  assert.ok(events.every((event) => event.actor === `user:${f.workspace.user.id}`));
  const history = (await f.ok('GET', `/api/cards/${a.id}`)).events;
  assert.deepEqual(history.map((event) => event.type), ['created', 'images_changed']);
  assert.deepEqual(history[1].data, { added: [], removed: [], roles: ['inspiration'] });
  assert.deepEqual((await f.ok('GET', `/api/cards/${b.id}`)).events.map((event) => event.type), ['created']);
  const lastCursor = events.at(-1).id;
  assert.deepEqual((await f.ok('GET', `/api/events?since=${lastCursor}`)).events, []);
  // Invalid writes cannot publish notifications.
  await f.call('PATCH', `/api/cards/${a.id}`, { revision: 1, title: 'Stale' });
  await f.call('POST', `/api/projects/${f.project.id}/cards`, { id: a.id, stageId: a.stageId });
  assert.deepEqual((await f.ok('GET', `/api/events?since=${lastCursor}`)).events, []);
});

test('change feed is workspace-scoped and paginates without losing notifications', async (t) => {
  const f = await fixture(t);
  const { openStore } = await import('../store.js');
  const store = await openStore({ dataDir: f.dataDir });
  t.after(() => store.close());
  const ctx = { ...store.owner, actor: `user:${store.owner.userId}` };
  const cursor = store.workspace(ctx).eventCursor;
  for (let i = 0; i < 505; i++) store.createCard(ctx, f.project.id, { stageId: f.stages[0].id });
  const first = (await f.ok('GET', `/api/events?since=${cursor}`)).events;
  assert.equal(first.length, 500);
  const second = (await f.ok('GET', `/api/events?since=${first.at(-1).id}`)).events;
  assert.equal(second.length, 5);
  assert.equal(new Set([...first, ...second].map((event) => event.entityId)).size, 505);
  assert.deepEqual(store.events({ workspaceId: 'another-workspace' }), []);
});

test('notifies listeners of card events only after they are saved', async (t) => {
  const seen = [];
  const f = await fixture(t, { onCardEvent: (event) => seen.push(event.type) });
  await f.card({ id: 'x' });
  await f.call('POST', `/api/projects/${f.project.id}/cards`, { id: 'x', stageId: f.stages[0].id });
  await f.ok('POST', '/api/cards/x/transitions', { action: 'approve' });
  assert.deepEqual(seen, ['created', 'approved']);
});

test('rejects unsupported, disguised, and oversized image uploads', async (t) => {
  const f = await fixture(t);
  for (const [type, body] of [['image/svg+xml', '<svg/>'], ['image/png', 'not a PNG']]) {
    assert.equal((await fetch(`${f.base}/api/images`, { method: 'POST', headers: { 'Content-Type': type }, body })).status, 400);
  }
  assert.equal((await fetch(`${f.base}/api/images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(20 * 1024 * 1024 + 1) })).status, 413);
});

test('blocks cross-origin writes, untrusted hosts, and non-public files', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/api/projects`, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(`${f.base}/api/workspace`, { headers: { Host: 'example.com' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  for (const url of ['/data/board.json', '/frameboard.db', '/server.js', '/store.js', '/legacy-board.js', '/images/%2e%2e%2fframeboard.db', '/%2e%2e/server.js', '/api/board']) assert.equal((await fetch(`${f.base}${url}`)).status, 404, url);
  assert.equal((await fetch(`${f.base}/api/workspace`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${f.base}/card-template.js`)).status, 200);
  const page = await fetch(f.base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('keeps a corrupt legacy board intact and reports a startup error', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-corrupt-'));
  try {
    await writeFile(path.join(dataDir, 'board.json'), 'not json');
    await assert.rejects(createApp({ dataDir }), /Your data has not been changed/);
    assert.equal(await readFile(path.join(dataDir, 'board.json'), 'utf8'), 'not json');
    assert.deepEqual((await readdir(dataDir)).sort(), ['board.json', 'images']);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('imports a board.json once, keeping lanes, order, card text, images, and flags', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-import-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const legacyCard = (id, extra = {}) => ({ id, title: id, intro: '', script: '', images: [], coverImageId: null, ...extra });
  const board = { projects: [
    { id: 'p1', name: 'Channel', lanes: [
      { id: 'l1', name: 'Icahn Ideas', color: 'lavender', cards: [
        legacyCard('c2', { titleOptions: 'One\nTwo', prompt: 'P', intro: 'I', script: 'S', updatedAt: '2026-09-24T22:08:28.879Z', originalVideoUrl: 'https://youtu.be/x', originalVideoTitle: 'T', publishedVideoUrl: 'https://y',
          images: [{ id: imageId(1), name: 'a.png' }, { id: imageId(2), name: 'b.png' }], coverImageId: imageId(2), originalImageId: imageId(1), inspirationImageId: null }),
        legacyCard('c1'),
      ] },
      { id: 'l2', name: 'Big 3 Completion', color: 'amber', cards: [legacyCard('old', { museVideoTitle: 'Old title', museVideoUrl: 'https://youtu.be/62NJbICVWkQ' })] },
    ] },
    { id: 'p2', name: 'Empty', lanes: [] },
  ] };
  await writeFile(path.join(dataDir, 'board.json'), JSON.stringify({ revision: 1469, board }));
  const first = await start(dataDir);
  const workspace = await first.ok('GET', '/api/workspace');
  assert.deepEqual(workspace.projects.map((project) => [project.id, project.name, project.cardCount]), [['p1', 'Channel', 3], ['p2', 'Empty', 0]]);
  assert.deepEqual(workspace.flows.find((flow) => flow.id === workspace.projects[0].flowId).stages.map((stage) => [stage.id, stage.name, stage.color, stage.position]), [['l1', 'Icahn Ideas', 'lavender', 0], ['l2', 'Big 3 Completion', 'amber', 1]]);
  const cards = (await first.ok('GET', '/api/projects/p1/cards')).cards;
  assert.deepEqual(cards.map((card) => [card.id, card.stageId]), [['c2', 'l1'], ['c1', 'l1'], ['old', 'l2']]);
  const [full, empty, old] = cards;
  assert.deepEqual(full.fields, { originalVideoUrl: 'https://youtu.be/x', originalVideoTitle: 'T', titleOptions: 'One\nTwo', intro: 'I', script: 'S', prompt: 'P', publishedVideoUrl: 'https://y' });
  assert.deepEqual(full.imageRoles, { cover: imageId(2), original: imageId(1), inspiration: null });
  assert.equal(full.images.length, 2);
  assert.equal(full.updatedAt, '2026-09-24T22:08:28.879Z');
  assert.deepEqual([empty.updatedAt, empty.createdAt, empty.enteredStageAt, empty.revision], [null, null, null, 1]);
  assert.deepEqual([old.fields.originalVideoTitle, old.fields.originalVideoUrl], ['Old title', 'https://youtu.be/62NJbICVWkQ']);
  const { events } = await first.ok('GET', '/api/cards/c2');
  assert.deepEqual(events.map((event) => [event.type, event.actor, event.toStageId, event.data, event.createdAt]), [['created', `user:${workspace.user.id}`, 'l1', {}, full.updatedAt]]);
  await first.ok('PATCH', '/api/cards/c1', { revision: 1, title: 'Edited after import' });
  await first.close();
  assert.ok((await readdir(dataDir)).includes('board.json.migrated'));
  assert.ok(!(await readdir(dataDir)).includes('board.json'));
  // A board.json that reappears later is ignored rather than imported twice.
  await writeFile(path.join(dataDir, 'board.json'), JSON.stringify({ revision: 1, board: { projects: [] } }));
  const second = await start(dataDir);
  assert.equal((await second.ok('GET', '/api/projects/p1/cards')).cards[1].title, 'Edited after import');
  await second.close();
});

test('migrates the real 36-card board shape with order, content, roles, and creation history intact', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-migration-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const text = await readFile(new URL('./fixtures/legacy-board.json', import.meta.url), 'utf8');
  await writeFile(path.join(dataDir, 'board.json'), text);
  const f = await start(dataDir);
  t.after(() => f.close());
  const { migrateBoard } = await import('../legacy-board.js');
  const board = migrateBoard(JSON.parse(text).board);
  const workspace = await f.ok('GET', '/api/workspace');
  assert.equal(workspace.projects.reduce((sum, p) => sum + p.cardCount, 0), 36);
  for (const project of board.projects) {
    const savedProject = workspace.projects.find((p) => p.id === project.id);
    const flow = workspace.flows.find((flow) => flow.id === savedProject.flowId);
    assert.deepEqual(flow.stages.map(({ id, name, color }) => ({ id, name, color })), project.lanes.map(({ id, name, color }) => ({ id, name, color })));
    const { cards } = await f.ok('GET', `/api/projects/${project.id}/cards`);
    assert.deepEqual(cards.map((card) => [card.id, card.stageId]), project.lanes.flatMap((lane) => lane.cards.map((card) => [card.id, lane.id])));
    for (const lane of project.lanes) for (const original of lane.cards) {
      const card = cards.find((card) => card.id === original.id);
      assert.equal(card.title, original.title);
      for (const key of Object.keys(card.fields)) assert.equal(card.fields[key], original[key] ?? '');
      assert.deepEqual(card.images, original.images);
      assert.deepEqual(card.imageRoles, { cover: original.coverImageId ?? null, original: original.originalImageId ?? null, inspiration: original.inspirationImageId ?? null });
      assert.equal(card.updatedAt, original.updatedAt ?? null);
      const { events } = await f.ok('GET', `/api/cards/${card.id}`);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'created');
      assert.equal(events[0].toStageId, lane.id);
      if (original.updatedAt) assert.equal(events[0].createdAt, original.updatedAt);
    }
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'board.json.migrated'), 'utf8')), JSON.parse(text));
});

test('recognizes YouTube video links and rejects other URLs', async () => {
  const { youtubeVideoId } = await import('../server.js');
  for (const url of ['https://www.youtube.com/watch?v=62NJbICVWkQ&t=4s', 'https://youtu.be/62NJbICVWkQ?si=x', 'https://m.youtube.com/shorts/62NJbICVWkQ', 'https://www.youtube.com/live/62NJbICVWkQ']) {
    assert.equal(youtubeVideoId(url), '62NJbICVWkQ', url);
  }
  for (const url of ['https://example.com/watch?v=62NJbICVWkQ', 'https://www.youtube.com/@channel', 'not a url']) assert.equal(youtubeVideoId(url), null, url);
});

test('fetches a YouTube title and stores its thumbnail as a local image', async (t) => {
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16]);
  const requested = [];
  const fakeFetch = async (url) => {
    requested.push(url);
    if (url.startsWith('https://www.youtube.com/oembed')) return new Response(JSON.stringify({ title: 'A great video' }));
    if (url.includes('maxresdefault')) return new Response('', { status: 404 });
    return new Response(jpeg);
  };
  const f = await fixture(t, { fetch: fakeFetch });
  const post = (url) => fetch(`${f.base}/api/youtube`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  const response = await post('https://youtu.be/62NJbICVWkQ');
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.title, 'A great video');
  assert.match(result.image.id, /^[a-f0-9-]{36}\.jpg$/);
  assert.equal(result.image.name, 'A great video thumbnail.jpg');
  assert.ok(requested.some((url) => url.endsWith('/vi/62NJbICVWkQ/hqdefault.jpg')));
  assert.deepEqual(Buffer.from(await (await fetch(`${f.base}/images/${result.image.id}`)).arrayBuffer()), jpeg);
  assert.equal((await post('https://example.com/video')).status, 400);
});

test('undo restores lane, position, and command changes while keeping later unrelated edits and history', async (t) => {
  const hooks = [];
  const f = await fixture(t, { onCardEvent: (event) => hooks.push(event) });
  const a = await f.card({ title: 'First' });
  const card = await f.card({ title: 'Before title', fields: { prompt: 'Before prompt', intro: 'Before intro' } });
  const b = await f.card({ title: 'Third' });
  await f.ok('PATCH', `/api/stages/${f.stages[1].id}`, { entryGraph: commandChain([['prompt', 'Lane prompt'], ['intro', 'Lane intro'], ['title', 'Lane title']]) });
  const moved = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[1].id });
  assert.ok(moved.card.lastMove.id);
  // Adding commands to the original lane must not cause them to run on undo.
  await f.ok('PATCH', `/api/stages/${f.stages[0].id}`, { entryPrompt: 'Do not run on undo' });
  const image = { id: imageId(99), name: 'Later inspiration' };
  const edited = await f.ok('PATCH', `/api/cards/${card.id}`, { revision: moved.card.revision, fields: { script: 'Newer script' }, images: [image], imageRoles: { cover: image.id } });
  const reopened = await start(f.dataDir);
  let undo;
  try {
    const loaded = (await reopened.ok('GET', `/api/cards/${card.id}`)).card;
    assert.deepEqual(loaded.lastMove, moved.card.lastMove);
    undo = await reopened.ok('POST', `/api/cards/${card.id}/undo-move`, { moveId: loaded.lastMove.id, revision: loaded.revision });
  } finally { await reopened.close(); }
  assert.equal(undo.card.stageId, card.stageId);
  assert.equal(undo.card.enteredStageAt, card.enteredStageAt);
  assert.equal(undo.card.title, card.title);
  assert.equal(undo.card.fields.prompt, card.fields.prompt);
  assert.equal(undo.card.fields.intro, card.fields.intro);
  assert.equal(undo.card.fields.script, 'Newer script');
  assert.deepEqual(undo.card.images, [image]);
  assert.equal(undo.card.imageRoles.cover, image.id);
  assert.equal(undo.card.revision, edited.revision + 1);
  assert.equal(undo.card.lastMove, null);
  assert.deepEqual((await f.cards()).map((item) => item.id), [a.id, card.id, b.id]);
  const history = (await f.ok('GET', `/api/cards/${card.id}`)).events;
  assert.deepEqual(history.map((event) => event.type), ['created', 'moved', 'fields_set', 'images_changed', 'move_undone']);
  assert.equal(history.at(-1).data.originalEventId, moved.event.id);
  assert.deepEqual(new Set(history.at(-1).data.fields), new Set(['prompt', 'intro', 'title']));
  assert.ok(hooks.some((event) => event.type === 'fields_set'));
  const repeated = await f.call('POST', `/api/cards/${card.id}/undo-move`, { moveId: moved.card.lastMove.id, revision: undo.card.revision });
  assert.equal(repeated.status, 409);
});

test('undo conflicts leave the entire card and event feed unchanged', async (t) => {
  const hooks = [];
  const f = await fixture(t, { onCardEvent: (event) => hooks.push(event) });
  const card = await f.card();
  await f.ok('PATCH', `/api/stages/${f.stages[1].id}`, { entryPrompt: 'Automatic prompt' });
  const moved = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[1].id });
  const edited = await f.ok('PATCH', `/api/cards/${card.id}`, { revision: moved.card.revision, fields: { prompt: 'My newer prompt' } });
  const cursor = (await f.ok('GET', '/api/workspace')).eventCursor;
  const hookCount = hooks.length;
  assert.equal((await f.call('POST', `/api/cards/${card.id}/undo-move`, { moveId: edited.lastMove.id, revision: moved.card.revision })).status, 409);
  const conflict = await f.call('POST', `/api/cards/${card.id}/undo-move`, { moveId: edited.lastMove.id, revision: edited.revision });
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /prompt was edited/);
  assert.deepEqual((await f.ok('GET', `/api/cards/${card.id}`)).card, edited);
  assert.equal((await f.ok('GET', '/api/workspace')).eventCursor, cursor);
  assert.equal(hooks.length, hookCount);
  const newer = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[2].id });
  assert.equal((await f.call('POST', `/api/cards/${card.id}/undo-move`, { moveId: edited.lastMove.id, revision: newer.card.revision })).status, 409);
  await f.ok('DELETE', `/api/stages/${f.stages[1].id}`);
  const missingLane = await f.call('POST', `/api/cards/${card.id}/undo-move`, { moveId: newer.card.lastMove.id, revision: newer.card.revision });
  assert.equal(missingLane.status, 409);
  assert.match(missingLane.body.error, /original lane has been deleted/);
  assert.equal((await f.call('POST', '/api/cards/unknown/undo-move', { moveId: 1, revision: 1 })).status, 404);
});

test('undo restores reordering and uses surviving neighbours when an anchor is removed', async (t) => {
  const f = await fixture(t);
  const a = await f.card({ title: 'A' });
  const b = await f.card({ title: 'B' });
  const c = await f.card({ title: 'C' });
  const d = await f.card({ title: 'D' });
  const move = (body) => f.ok('POST', `/api/cards/${b.id}/transitions`, { action: 'move', toStageId: b.stageId, ...body });
  const moved = await move({});
  assert.deepEqual((await f.cards()).map((card) => card.id), [a.id, c.id, d.id, b.id]);
  const noOp = await move({});
  assert.deepEqual(noOp.card.lastMove, moved.card.lastMove, 'A no-op must not replace the undo snapshot');
  await f.ok('DELETE', `/api/cards/${c.id}`);
  const undo = await f.ok('POST', `/api/cards/${b.id}/undo-move`, { moveId: moved.card.lastMove.id, revision: moved.card.revision });
  assert.equal(undo.card.revision, b.revision, 'Position changes do not acknowledge unseen content');
  assert.deepEqual((await f.cards()).map((card) => card.id), [a.id, b.id, d.id]);
  assert.equal(undo.event.type, 'move_undone');
  const again = await move({ beforeCardId: a.id });
  await f.ok('DELETE', `/api/cards/${a.id}`);
  await f.ok('DELETE', `/api/cards/${d.id}`);
  await f.ok('POST', `/api/cards/${b.id}/undo-move`, { moveId: again.card.lastMove.id, revision: again.card.revision });
  assert.deepEqual((await f.cards()).map((card) => card.id), [b.id]);
});

test('schema upgrade enables future undo without inventing snapshots for older moves', async (t) => {
  const f = await fixture(t);
  const card = await f.card();
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.stages[1].id });
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  db.exec("DROP TABLE card_moves; UPDATE meta SET value = '3' WHERE key = 'schema_version';");
  db.close();
  const reopened = await start(f.dataDir);
  try {
    assert.equal((await reopened.ok('GET', `/api/cards/${card.id}`)).card.lastMove, null);
    const moved = await reopened.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'approve' });
    const undone = await reopened.ok('POST', `/api/cards/${card.id}/undo-move`, { moveId: moved.card.lastMove.id, revision: moved.card.revision });
    assert.equal(undone.card.stageId, f.stages[1].id);
  } finally { await reopened.close(); }
});
