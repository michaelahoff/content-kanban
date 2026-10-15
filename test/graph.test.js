import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';
import { parseDocument, playbookSettings, resolveRoutes, composeLanePrompt, parseLaneResult, withSetting } from '../public/playbook-format.js';
import { youtubeVideoTemplate } from '../public/card-template.js';
import { DatabaseSync } from 'node:sqlite';
import { maxAutomaticMoves, supportedSchemaVersion } from '../store.js';

const result = (value) => `Done.\n\n\`\`\`frameboard-result\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const settingsOf = (text) => playbookSettings(parseDocument(text), youtubeVideoTemplate);
const runs = async (f, cardId) => (await f.ok('GET', `/api/cards/${cardId}/lane-runs`)).runs;
const sentText = (send) => send.input.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');

// A graph flow in the fixture's project, its lanes by name and its playbooks.
async function graph(t, kind = 'graph') {
  const f = await fixture(t);
  const workspace = await f.ok('GET', '/api/workspace');
  const project = workspace.projects[0];
  const flow = await f.ok('POST', `/api/projects/${project.id}/flows`, { name: 'Loop', kind });
  const lane = Object.fromEntries(flow.stages.map((stage) => [stage.name, stage]));
  const playbook = async (stage) => (await f.ok('GET', `/api/flows/${flow.id}/playbooks`)).lanes.find((document) => document.laneId === stage.id);
  const view = async () => (await f.ok('GET', '/api/workspace')).flows.find((item) => item.id === flow.id);
  const card = (stage, input = {}) => f.ok('POST', `/api/projects/${project.id}/cards`, { stageId: stage.id, ...input });
  return { ...f, project, flow, lane, playbook, view, card };
}

test('routes and advance are lane playbook settings, resolved by lane ID or name', () => {
  const lanes = [{ id: 'a', name: 'Draft' }, { id: 'b', name: 'Review' }, { id: 'c', name: 'Done' }];
  const settings = settingsOf('---\nlane: b\nadvance: auto\nroutes:\n  approved: c\n  needs work: draft\n  back: b\n  lost: z\n---\nReview it.');
  assert.deepEqual(settings.errors, []);
  assert.equal(settings.advance, 'auto');
  assert.deepEqual(resolveRoutes(settings.routes, lanes, 'b').map((route) => [route.name, route.laneId]),
    [['approved', 'c'], ['needs work', 'a'], ['back', null], ['lost', null]], 'a route back to its own lane or to no lane leads nowhere');
  assert.equal(settingsOf('---\nrun: off\n---\n').advance, 'review', 'routes wait for review unless advance says auto');
  assert.deepEqual(settingsOf('---\nadvance: sometimes\nroutes:\n  -bad: a\n  ok: ""\n---\n').errors,
    ['advance must be review or auto.', 'routes: “-bad” is not a route name. Use letters, numbers, spaces, - and _ (up to 40).', 'routes: “ok” needs the lane it leads to.']);
  assert.deepEqual(settingsOf('---\nroutes: [a, b]\n---\n').errors, ['routes needs one “name: lane” line per route.']);
  // The graph editor writes routes as one setting and leaves the rest alone.
  const text = '---\nlane: b # the review lane\nrun: on-enter\n---\n\nReview it.\n';
  assert.equal(withSetting(text, 'routes', { approved: 'c', revise: 'a' }), '---\nlane: b # the review lane\nrun: on-enter\nroutes:\n  approved: c\n  revise: a\n---\n\nReview it.\n');
});

test('a lane run prompt lists its routes and the result block names one', () => {
  const base = { projectName: 'P', flowName: 'Loop', laneName: 'Review', lanes: [], map: null, playbook: { path: 'lanes/review.md' }, template: youtubeVideoTemplate };
  const settings = settingsOf('---\nadvance: auto\n---\nChoose a route.');
  const routes = [{ name: 'approved', laneId: 'c', laneName: 'Done' }, { name: 'revise', laneId: 'a', laneName: 'Draft' }, { name: 'gone', laneId: null, laneName: null }];
  const prompt = composeLanePrompt({ ...base, settings, routes });
  assert.ok(prompt.includes('## Routes out of this step'));
  assert.ok(prompt.includes('- approved → Done\n- revise → Draft'));
  assert.ok(!prompt.includes('gone'), 'a route that leads nowhere is not offered');
  assert.ok(prompt.includes('Frameboard moves the card along the route you choose as soon as you finish'));
  assert.ok(prompt.includes('"route": "approved"'));
  assert.ok(!prompt.includes('"move": "Lane name"'));
  const review = composeLanePrompt({ ...base, settings: settingsOf('---\nrun: on-enter\n---\nChoose.'), routes });
  assert.ok(review.includes('The user reviews the route you choose before the card moves.'));
  const plain = composeLanePrompt({ ...base, settings: settingsOf('Work.'), routes: [] });
  assert.ok(!plain.includes('Routes out of this step') && plain.includes('"move": "Lane name"'));

  assert.equal(parseLaneResult(result({ route: ' revise ' }), youtubeVideoTemplate).route, 'revise');
  assert.deepEqual(parseLaneResult(result({ route: 7 }), youtubeVideoTemplate).errors, ['Ignored “route”: it must be the name of one of this step\'s routes.']);
});

test('a new graph flow is a placed loop whose routes live in node playbooks', async (t) => {
  const f = await graph(t);
  assert.equal(f.flow.kind, 'graph');
  assert.deepEqual(f.flow.stages.map((stage) => [stage.name, stage.x, stage.y]), [['Ideas', 0, 40], ['Draft', 380, 40], ['Review', 760, 40], ['Done', 1140, 40]]);
  const routes = (stage) => f.flow.stages.find((item) => item.id === stage.id).playbook.routes.map((route) => [route.name, route.laneId]);
  assert.deepEqual(routes(f.lane.Ideas), [['next', f.lane.Draft.id]]);
  assert.deepEqual(routes(f.lane.Review), [['approved', f.lane.Done.id], ['revise', f.lane.Draft.id]]);
  assert.deepEqual(routes(f.lane.Done), []);
  const review = await f.playbook(f.lane.Review);
  assert.match(review.text, new RegExp(`^---\\nlane: ${f.lane.Review.id}\\nrun: off\\nroutes:\\n  approved: ${f.lane.Done.id}\\n  revise: ${f.lane.Draft.id}\\n---`));
  assert.equal(f.flow.stages.every((stage) => stage.playbook.run === 'off'), true, 'nothing runs until the user writes instructions');

  // A project can start with a graph too; boards stay the default.
  const created = await f.ok('POST', '/api/projects', { name: 'Graphs', kind: 'graph' });
  assert.equal(created.flow.kind, 'graph');
  assert.equal((await f.ok('POST', `/api/projects/${f.project.id}/flows`, { name: 'Plain' })).kind, 'board');
  assert.equal((await f.call('POST', `/api/projects/${f.project.id}/flows`, { name: 'Odd', kind: 'tree' })).status, 400);

  // Nodes have places, and a node added to a graph gets a playbook.
  const node = await f.ok('POST', `/api/flows/${f.flow.id}/stages`, { name: 'Critique', color: 'pink', x: 400, y: 320 });
  assert.deepEqual([node.x, node.y], [400, 320]);
  assert.match((await f.playbook(node)).text, /run: off/);
  assert.deepEqual(await f.ok('PATCH', `/api/stages/${node.id}`, { x: 420, y: 340 }).then((stage) => [stage.x, stage.y]), [420, 340]);
  assert.equal((await f.call('PATCH', `/api/stages/${node.id}`, { x: 'left' })).status, 400);
});

test('routes are edited one setting at a time and refuse what would lead nowhere', async (t) => {
  const f = await graph(t);
  const { Ideas, Draft, Review, Done } = f.lane;
  const before = await f.playbook(Review);
  await writeFile(path.join(f.dataDir, 'flows', f.flow.id, before.path), before.text.replace('# Review', '# Review\n\n<!-- my own note -->'));
  const saved = await f.ok('PUT', `/api/stages/${Review.id}/routes`, { routes: [{ name: 'ship it', to: Done.id }, { name: 'revise', to: Draft.id }, { name: 'rethink', to: Ideas.id }], advance: 'auto' });
  assert.deepEqual(saved.stages.find((stage) => stage.id === Review.id).playbook.routes.map((route) => route.name), ['ship it', 'revise', 'rethink']);
  const after = await f.playbook(Review);
  assert.ok(after.text.includes('<!-- my own note -->'), 'the rest of the file stays');
  assert.match(after.text, /routes:\n {2}ship it: .+\n {2}revise: .+\n {2}rethink: .+\nadvance: auto\n---/);
  assert.ok((await f.ok('GET', '/api/events?since=0')).events.some((event) => event.entity === 'flow' && event.type === 'playbook_saved' && event.data.path === after.path));
  await f.ok('PUT', `/api/stages/${Review.id}/routes`, { routes: [], advance: 'review' });
  assert.doesNotMatch((await f.playbook(Review)).text, /routes:|advance:/);

  for (const [routes, message] of [
    [[{ name: '-x', to: Done.id }], /Route names/],
    [[{ name: 'a', to: Done.id }, { name: 'A', to: Draft.id }], /already a route named “A”/],
    [[{ name: 'loop', to: Review.id }], /another node/],
    [[{ name: 'away', to: (await f.ok('GET', '/api/workspace')).flows[0].stages[0].id }], /node in this flow/],
  ]) {
    const refused = await f.call('PUT', `/api/stages/${Review.id}/routes`, { routes });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, message);
  }

  // Deleting a node takes the routes to it out of the other playbooks.
  await f.ok('PUT', `/api/stages/${Draft.id}/routes`, { routes: [{ name: 'next', to: Review.id }, { name: 'skip', to: Done.id }] });
  await f.ok('PUT', `/api/stages/${Ideas.id}/routes`, { routes: [{ name: 'straight to review', to: Review.id }] });
  await f.ok('DELETE', `/api/stages/${Review.id}`);
  const view = await f.view();
  assert.deepEqual(view.stages.find((stage) => stage.id === Draft.id).playbook.routes.map((route) => route.name), ['skip']);
  assert.deepEqual(view.stages.find((stage) => stage.id === Ideas.id).playbook.routes, [], 'a node whose only route is gone has none');
});

test('a board becomes a single line of routes, and a graph a board in route order without its routes', async (t) => {
  const f = await graph(t, 'board');
  const { Ideas, Review, Done } = f.lane;
  const progress = f.lane['In progress'];
  // A lane that already has routes keeps them.
  await setPlaybook(f.ok, f.flow.id, Review, { run: 'off', routes: { approved: Done.id, again: Ideas.id } }, 'Check it.');
  const converted = await f.ok('POST', `/api/flows/${f.flow.id}/convert`, { kind: 'graph' });
  assert.equal(converted.kind, 'graph');
  assert.deepEqual(converted.stages.map((stage) => [stage.name, stage.x, stage.y]), [['Ideas', 0, 40], ['In progress', 380, 40], ['Review', 760, 40], ['Done', 1140, 40]]);
  const routes = (view, stage) => view.stages.find((item) => item.id === stage.id).playbook?.routes.map((route) => [route.name, route.laneId]) ?? null;
  assert.deepEqual(routes(converted, Ideas), [['next', progress.id]]);
  assert.deepEqual(routes(converted, Review), [['approved', Done.id], ['again', Ideas.id]]);
  assert.equal(routes(converted, Done), null, 'the last lane needs no playbook');
  assert.equal((await f.ok('POST', `/api/flows/${f.flow.id}/convert`, { kind: 'graph' })).kind, 'graph', 'converting to the same kind changes nothing');

  // Reorder the graph so route order differs from lane order, then go back.
  await f.ok('PUT', `/api/stages/${Ideas.id}/routes`, { routes: [{ name: 'fast', to: Review.id }], advance: 'auto' });
  await f.ok('PATCH', `/api/stages/${progress.id}`, { x: 2000 });
  const card = await f.card(progress, { title: 'Stays put' });
  const board = await f.ok('POST', `/api/flows/${f.flow.id}/convert`, { kind: 'board' });
  assert.equal(board.kind, 'board');
  assert.deepEqual(board.stages.map((stage) => [stage.name, stage.position, stage.x]), [['Ideas', 0, null], ['Review', 1, null], ['Done', 2, null], ['In progress', 3, null]]);
  for (const document of (await f.ok('GET', `/api/flows/${f.flow.id}/playbooks`)).lanes) assert.doesNotMatch(document.text, /routes:|advance:/, `${document.path} loses its routes`);
  assert.match((await f.playbook(Review)).text, /Check it\./, 'the rest of each playbook stays');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.stageId, progress.id, 'cards stay in their lanes');
  assert.ok((await f.ok('GET', '/api/events?since=0')).events.some((event) => event.entity === 'flow' && event.type === 'updated' && event.data.kind === 'board'));

  // A playbook whose settings cannot be read stops a conversion before any file changes.
  const broken = await f.playbook(Review);
  await f.ok('PUT', `/api/flows/${f.flow.id}/playbooks`, { path: broken.path, text: `---\nlane: ${Review.id}\nrun: [on\n---\nBody`, baseHash: broken.hash });
  const refused = await f.call('POST', `/api/flows/${f.flow.id}/convert`, { kind: 'graph' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Fix the settings in lanes\/.+ before converting/);
  assert.equal((await f.view()).kind, 'board');
  assert.doesNotMatch((await f.playbook(Ideas)).text, /routes:/);
});

test('an agent\'s route is followed at once with advance: auto, and proposed otherwise', async (t) => {
  const f = await graph(t);
  const { Ideas, Draft, Review, Done } = f.lane;
  await setPlaybook(f.ok, f.flow.id, Draft, { run: 'on-enter', model: 'test-model', may_edit: ['script'], advance: 'auto', routes: { next: Review.id } }, 'Draft the script.');
  await setPlaybook(f.ok, f.flow.id, Review, { run: 'on-enter', model: 'test-model', routes: { approved: Done.id, revise: Draft.id } }, 'Review the script.');
  const card = await f.card(Ideas, { title: 'Hooks' });
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: Draft.id, route: 'next' });

  const draft = await waitFor(() => f.codex.sends[0]);
  assert.ok(sentText(draft).includes('## Routes out of this step'));
  assert.ok(sentText(draft).includes('- next → Review'));
  f.codex.finish(draft, 'completed', result({ fields: { script: 'Draft one' }, notes: 'Drafted.', route: 'next' }));

  // The card moved on by itself and the Review playbook started.
  const review = await waitFor(() => f.codex.sends[1]);
  assert.ok(sentText(review).includes('The user reviews the route you choose before the card moves.'));
  const moved = await f.ok('GET', `/api/cards/${card.id}`);
  assert.equal(moved.card.stageId, Review.id);
  assert.equal(moved.card.fields.script, 'Draft one');
  const routeMove = moved.events.filter((event) => event.type === 'moved').at(-1);
  assert.match(routeMove.actor, /^automation:/);
  assert.deepEqual(routeMove.data, { route: 'next' });
  assert.match((await runs(f, card.id)).find((run) => run.stageId === Draft.id).reason, /Followed next to Review\./);

  // Review waits for the user: the route becomes a move proposal.
  f.codex.finish(review, 'completed', result({ notes: 'Looks good.', route: 'Approved' }));
  const done = await waitFor(async () => (await runs(f, card.id)).find((run) => run.stageId === Review.id && run.status === 'completed'));
  assert.match(done.reason, /Proposed following approved to Done for your review\./);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.stageId, Review.id);
  const proposal = (await f.chat(card.id)).proposals.find((item) => item.kind === 'move');
  assert.equal(proposal.payload.toStageId, Done.id);

  // A route the step does not have changes nothing.
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const again = await waitFor(() => f.codex.sends[2]);
  f.codex.finish(again, 'completed', result({ notes: 'Hmm.', route: 'publish' }));
  const ignored = await waitFor(async () => (await runs(f, card.id)).find((run) => run.status === 'completed' && run.id !== done.id && run.stageId === Review.id));
  assert.match(ignored.reason, /Ignored the route “publish”: this step's routes are “approved”, “revise”\./);
});

test('an automatic route waits for review when the card left the step or keeps looping', async (t) => {
  const f = await graph(t);
  const { Ideas, Draft, Review } = f.lane;
  await setPlaybook(f.ok, f.flow.id, Draft, { run: 'on-enter', model: 'test-model', advance: 'auto', routes: { next: Review.id } }, 'Draft.');
  await setPlaybook(f.ok, f.flow.id, Review, { run: 'on-enter', model: 'test-model', advance: 'auto', routes: { revise: Draft.id } }, 'Review.');

  // The card left Draft before its run finished: the route is only proposed.
  const left = await f.card(Ideas, { title: 'Wanderer' });
  await f.ok('POST', `/api/cards/${left.id}/transitions`, { action: 'move', toStageId: Draft.id });
  const first = await waitFor(() => f.codex.sends[0]);
  await f.ok('POST', `/api/cards/${left.id}/transitions`, { action: 'move', toStageId: Ideas.id });
  f.codex.finish(first, 'completed', result({ notes: 'Done.', route: 'next' }));
  const held = await waitFor(async () => (await runs(f, left.id)).find((run) => run.status === 'completed'));
  assert.match(held.reason, /Proposed following next to Review for your review\. The card left this step before the run finished\./);
  assert.equal((await f.ok('GET', `/api/cards/${left.id}`)).card.stageId, Ideas.id);

  // A loop that never converges pauses after maxAutomaticMoves moves in a row.
  const looping = await f.card(Ideas, { title: 'Looper' });
  await f.ok('POST', `/api/cards/${looping.id}/transitions`, { action: 'move', toStageId: Draft.id });
  for (let index = 1; index <= maxAutomaticMoves + 1; index++) {
    const send = await waitFor(() => f.codex.sends[index]);
    f.codex.finish(send, 'completed', result({ notes: `Pass ${index}.`, route: index % 2 ? 'next' : 'revise' }));
    await waitFor(async () => (await runs(f, looping.id)).filter((run) => run.status === 'completed').length === index);
  }
  const all = await runs(f, looping.id);
  assert.match(all[0].reason, new RegExp(`It made ${maxAutomaticMoves} automatic moves in a row, so this one waits for you\\.`));
  assert.equal(all.filter((run) => /^Followed/.test(run.reason)).length, maxAutomaticMoves);
  assert.equal(f.codex.sends.length, maxAutomaticMoves + 2, 'no run starts after the loop pauses');
  // A move by the user starts the count again.
  const { card } = await f.ok('GET', `/api/cards/${looping.id}`);
  const proposal = (await f.chat(looping.id)).proposals.find((item) => item.kind === 'move' && item.status === 'pending');
  await f.ok('POST', `/api/cards/${looping.id}/chat/proposals/${proposal.id}/accept`, { placementVersion: card.placementVersion });
  const resumed = await waitFor(() => f.codex.sends[maxAutomaticMoves + 2]);
  f.codex.finish(resumed, 'completed', result({ notes: 'Fresh start.', route: 'revise' }));
  await waitFor(async () => (await runs(f, looping.id)).some((run) => run.stageId === Review.id && /^Followed revise to Draft\./.test(run.reason)));
  assert.equal((await f.ok('GET', `/api/cards/${looping.id}`)).card.stageId, Draft.id);
});

test('graph flows survive a restart with their kind, places and routes', async (t) => {
  const f = await graph(t);
  await f.ok('PATCH', `/api/stages/${f.lane.Done.id}`, { x: 1500, y: 300 });
  await f.restart();
  const view = await f.view();
  assert.equal(view.kind, 'graph');
  assert.deepEqual([view.stages.at(-1).x, view.stages.at(-1).y], [1500, 300]);
  assert.deepEqual(view.stages.find((stage) => stage.id === f.lane.Review.id).playbook.routes.map((route) => route.name), ['approved', 'revise']);
  assert.match(await readFile(path.join(f.dataDir, 'flows', f.flow.id, 'MAP.md'), 'utf8'), /^# Loop — flow map/);
});

test('a database from before graph flows opens with every flow a board', async (t) => {
  const f = await fixture(t);
  await f.close();
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  db.exec('ALTER TABLE flows DROP COLUMN kind; ALTER TABLE stages DROP COLUMN graph_x; ALTER TABLE stages DROP COLUMN graph_y;');
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(supportedSchemaVersion - 1));
  db.close();
  await f.restart();
  const { flows } = await f.ok('GET', '/api/workspace');
  assert.deepEqual(flows.map((flow) => flow.kind), ['board']);
  assert.ok(flows[0].stages.every((stage) => stage.x === null && stage.y === null));
});
