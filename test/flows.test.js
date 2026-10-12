import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';

const blogPost = { name: 'Blog post', fields: [{ key: 'headline', label: 'Headline' }, { key: 'body', label: 'Body', control: 'textarea' }], imageRoles: [] };

// A project with its first flow and a second one.
async function twoFlows(t, secondInput = { name: 'Shorts' }) {
  const f = await fixture(t);
  const workspace = await f.ok('GET', '/api/workspace');
  const project = workspace.projects[0];
  const main = workspace.flows.find((flow) => flow.projectId === project.id);
  const second = await f.ok('POST', `/api/projects/${project.id}/flows`, secondInput);
  const card = (flow, input = {}) => f.ok('POST', `/api/projects/${project.id}/cards`, { stageId: flow.stages[0].id, ...input });
  const flows = async () => (await f.ok('GET', '/api/workspace')).flows.filter((flow) => flow.projectId === project.id);
  return { ...f, project, main, second, card, flows };
}

test('a project holds several flows, each with its own lanes, template, playbook folder and flow map', async (t) => {
  const f = await twoFlows(t);
  const template = await f.ok('POST', '/api/templates', blogPost);
  const blog = await f.ok('POST', `/api/projects/${f.project.id}/flows`, { name: 'Blog', templateId: template.id });
  assert.equal(f.second.projectId, f.project.id);
  assert.equal(f.second.name, 'Shorts');
  assert.equal(f.second.templateId, 'youtube-video', 'a flow without a chosen template uses the workspace default');
  assert.deepEqual(f.second.stages.map((stage) => stage.name), ['Ideas', 'In progress', 'Review', 'Done']);
  assert.ok(f.second.stages.every((stage) => !f.main.stages.some((other) => other.id === stage.id)), 'each flow has lanes of its own');
  assert.deepEqual((await f.flows()).map((flow) => [flow.name, flow.position, flow.templateId]), [['Main', 0, 'youtube-video'], ['Shorts', 1, 'youtube-video'], ['Blog', 2, 'blog-post']]);
  // The project's flowId is its first flow.
  assert.equal((await f.ok('GET', '/api/workspace')).projects[0].flowId, f.main.id);

  const listing = await f.ok('GET', `/api/flows/${blog.id}/playbooks`);
  assert.equal(listing.folder, path.join(f.dataDir, 'flows', blog.id));
  assert.match(listing.map.text, /^# Blog — flow map/);
  assert.ok(listing.map.text.includes('- **Headline**: (what goes here)'));
  assert.deepEqual(listing.stages.map((stage) => stage.id), blog.stages.map((stage) => stage.id));

  const post = await f.card(blog);
  assert.equal(post.template, 'blog-post', 'a new card takes its flow\'s template');
  assert.deepEqual(Object.keys(post.fields), ['headline', 'body']);
  assert.equal((await f.card(f.main)).template, 'youtube-video');
  assert.deepEqual((await f.flows()).map((flow) => flow.cardCount), [1, 0, 1], 'each flow counts its own live cards');
  assert.equal((await f.ok('GET', '/api/templates')).templates.find((entry) => entry.id === 'blog-post').flowCount, 1);
  const created = (await f.ok('GET', '/api/events?since=0')).events.find((event) => event.entity === 'flow' && event.type === 'created' && event.entityId === blog.id);
  assert.equal(created.projectId, f.project.id);

  // A flow's lanes belong to that flow's project only.
  const other = await f.ok('POST', '/api/projects', { name: 'Other' });
  const refused = await f.call('POST', `/api/projects/${other.project.id}/cards`, { stageId: f.second.stages[0].id });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Choose a lane in this project/);
});

test('a card moves to a lane of another flow, runs that lane\'s playbook and can be moved back with undo', async (t) => {
  const f = await twoFlows(t);
  const [shortsIdeas] = f.second.stages;
  await f.ok('PUT', `/api/flows/${f.second.id}/playbooks`, { path: 'MAP.md', text: '# Shorts map: vertical video only.', baseHash: (await f.ok('GET', `/api/flows/${f.second.id}/playbooks`)).map.hash });
  await setPlaybook(f.ok, f.second.id, shortsIdeas, { run: 'on-enter', model: 'test-model', set: { prompt: 'Vertical' } }, 'Cut it down to a short.');
  const card = await f.card(f.main, { title: 'Long video' });

  const moved = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: shortsIdeas.id });
  assert.equal(moved.card.stageId, shortsIdeas.id);
  assert.equal(moved.card.fields.prompt, 'Vertical', 'the destination lane\'s set: values apply in the move');
  assert.deepEqual(moved.event.data, { fromFlowId: f.main.id, toFlowId: f.second.id });
  assert.ok(moved.laneRunId, 'an on-enter lane in another flow starts a lane run');
  const send = await waitFor(() => f.codex.sends[0]);
  const sent = send.input.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
  assert.ok(sent.includes('in its “Shorts” flow'));
  assert.ok(sent.includes('# Shorts map: vertical video only.'), 'the run reads the map of the flow it entered');
  assert.ok(sent.includes('Cut it down to a short.'));

  // Approve and send back stay within the card's current flow.
  const back = await f.call('POST', `/api/cards/${card.id}/transitions`, { action: 'send_back' });
  assert.equal(back.status, 400);
  assert.match(back.body.error, /already in the first lane/);

  const undone = await f.ok('POST', `/api/cards/${card.id}/undo-move`, { moveId: moved.card.lastMove.id, revision: moved.card.revision });
  assert.equal(undone.card.stageId, f.main.stages[0].id);
  assert.equal(undone.card.fields.prompt, '', 'undo reverses the values the other flow\'s lane set');
  const listed = (await f.ok('GET', `/api/projects/${f.project.id}/cards`)).cards;
  assert.equal(listed.find((entry) => entry.id === card.id).stageId, f.main.stages[0].id);
});

test('moving forward to another flow records the exit criteria the card did not meet', async (t) => {
  const f = await twoFlows(t);
  await f.ok('PATCH', `/api/stages/${f.main.stages[1].id}`, { exitCriteria: [{ field: 'intro', rule: 'filled' }] });
  const card = await f.card(f.main);
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.main.stages[1].id });
  const moved = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: f.second.stages[0].id });
  assert.deepEqual(moved.event.data.unmet, ['intro is filled']);
});

test('a flow is renamed, reordered and given another template without changing its cards', async (t) => {
  const f = await twoFlows(t);
  const template = await f.ok('POST', '/api/templates', blogPost);
  const before = await f.card(f.second);
  const renamed = await f.ok('PATCH', `/api/flows/${f.second.id}`, { name: '  Clips  ', templateId: template.id, position: 0 });
  assert.equal(renamed.name, 'Clips');
  assert.equal(renamed.templateId, 'blog-post');
  assert.deepEqual((await f.flows()).map((flow) => [flow.name, flow.position]), [['Clips', 0], ['Main', 1]]);
  assert.equal((await f.ok('GET', '/api/workspace')).projects[0].flowId, f.second.id, 'the first flow follows the order');
  assert.equal((await f.ok('GET', `/api/cards/${before.id}`)).card.template, 'youtube-video', 'existing cards keep their template');
  assert.equal((await f.card(f.second)).template, 'blog-post');
  assert.equal((await f.call('PATCH', `/api/flows/${f.second.id}`, { templateId: 'nope' })).status, 404);
  assert.equal((await f.call('PATCH', `/api/flows/${f.second.id}`, { name: ' ' })).status, 400);
  const updated = (await f.ok('GET', '/api/events?since=0')).events.filter((event) => event.entity === 'flow' && event.type === 'updated');
  assert.deepEqual(updated.at(-1).data, { name: 'Clips', templateId: 'blog-post', position: 0 });
  // The template is in use as this flow's default.
  const inUse = await f.call('DELETE', '/api/templates/blog-post');
  assert.equal(inUse.status, 409);
});

test('deleting a flow deletes its cards and keeps its files; a project keeps at least one flow', async (t) => {
  const f = await twoFlows(t);
  const doomed = await f.card(f.second, { title: 'Goes with the flow' });
  const kept = await f.card(f.main, { title: 'Stays' });
  // A move into the flow, so undo would need the deleted lane.
  const moved = await f.ok('POST', `/api/cards/${kept.id}/transitions`, { action: 'move', toStageId: f.main.stages[1].id });
  assert.deepEqual(await f.ok('DELETE', `/api/flows/${f.second.id}`), { ok: true });
  assert.deepEqual((await f.flows()).map((flow) => flow.id), [f.main.id]);
  assert.equal((await f.call('GET', `/api/cards/${doomed.id}`)).status, 404);
  assert.deepEqual((await f.ok('GET', `/api/projects/${f.project.id}/cards`)).cards.map((card) => card.id), [kept.id]);
  assert.equal((await f.call('GET', `/api/flows/${f.second.id}/playbooks`)).status, 404);
  assert.equal((await f.call('POST', `/api/flows/${f.second.id}/stages`, { name: 'Late', color: 'blue' })).status, 404);
  assert.equal((await f.call('POST', `/api/cards/${kept.id}/transitions`, { action: 'move', toStageId: f.second.stages[0].id })).status, 400);
  assert.ok(await readFile(path.join(f.dataDir, 'flows', f.second.id, 'MAP.md'), 'utf8'), 'the playbook folder stays on disk');
  await f.ok('POST', `/api/cards/${kept.id}/undo-move`, { moveId: moved.card.lastMove.id, revision: moved.card.revision });

  const last = await f.call('DELETE', `/api/flows/${f.main.id}`);
  assert.equal(last.status, 400);
  assert.match(last.body.error, /at least one flow/);
});

test('an archived project accepts no new flows or flow changes, and a project has no template of its own', async (t) => {
  const f = await twoFlows(t);
  assert.match((await f.call('PATCH', `/api/projects/${f.project.id}`, { templateId: 'youtube-video' })).body.error, /Each flow chooses the card template/);
  assert.equal((await f.ok('PATCH', `/api/projects/${f.project.id}`, { name: 'Renamed' })).name, 'Renamed');
  await f.ok('POST', `/api/projects/${f.project.id}/archive`, {});
  assert.equal((await f.call('POST', `/api/projects/${f.project.id}/flows`, { name: 'Late' })).status, 409);
  assert.equal((await f.call('PATCH', `/api/flows/${f.second.id}`, { name: 'Late' })).status, 409);
  assert.equal((await f.call('DELETE', `/api/flows/${f.second.id}`)).status, 409);
  // Archived flows stay readable.
  assert.deepEqual((await f.flows()).map((flow) => flow.id), [f.main.id, f.second.id]);
});

test('a database from before multiple flows gives each flow its project and template on upgrade', async (t) => {
  const f = await fixture(t);
  const second = await f.ok('POST', '/api/projects', { name: 'Second' });
  await f.close();
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  db.exec(`PRAGMA foreign_keys = OFF; DROP INDEX flows_by_project;
    ALTER TABLE flows DROP COLUMN project_id; ALTER TABLE flows DROP COLUMN position; ALTER TABLE flows DROP COLUMN template_id; ALTER TABLE flows DROP COLUMN deleted_at;`);
  db.prepare('UPDATE projects SET template_id = NULL WHERE id = ?').run(second.project.id);
  db.prepare("UPDATE meta SET value = '21' WHERE key = 'schema_version'").run();
  db.close();
  await f.restart();
  const workspace = await f.ok('GET', '/api/workspace');
  assert.equal(workspace.flows.length, 2);
  for (const project of workspace.projects) {
    const flows = workspace.flows.filter((flow) => flow.projectId === project.id);
    assert.equal(flows.length, 1);
    assert.equal(flows[0].id, project.flowId);
    assert.equal(flows[0].templateId, 'youtube-video');
    assert.equal(flows[0].position, 0);
  }
  assert.equal((await f.ok('POST', `/api/projects/${second.project.id}/flows`, { name: 'Added' })).position, 1);
});

test('card tools list every flow\'s lanes and propose a move into another flow', async (t) => {
  const f = await twoFlows(t);
  const card = await f.card(f.main);
  await f.queue(card.id, await f.compose(card.id));
  const send = await waitFor(() => f.codex.sends[0]);
  const tool = async (...args) => { const result = await f.codex.tool(send, ...args); assert.ok(result.success, result.contentItems[0].text); return JSON.parse(result.contentItems[0].text); };
  const read = await tool('read_card', {});
  assert.deepEqual(read.lanes.map((lane) => `${lane.flow} › ${lane.name}`), [...f.main.stages.map((stage) => `Main › ${stage.name}`), ...f.second.stages.map((stage) => `Shorts › ${stage.name}`)]);
  await tool('propose_move', { toStageId: f.second.stages[2].id });
  const [proposal] = (await f.chat(card.id)).proposals;
  const preview = await f.ok('POST', `/api/cards/${card.id}/chat/proposals/${proposal.id}/preview`, {});
  const accepted = await f.ok('POST', `/api/cards/${card.id}/chat/proposals/${proposal.id}/accept`, preview);
  assert.equal(accepted.card.stageId, f.second.stages[2].id);
  // With its first flow deleted, the project's lanes come from the flows it has left.
  await f.ok('PATCH', `/api/flows/${f.second.id}`, { position: 0 });
  await f.ok('DELETE', `/api/flows/${f.main.id}`);
  const after = await tool('read_card', {}, 'read-again');
  assert.deepEqual(after.lanes.map((lane) => lane.id), f.second.stages.map((stage) => stage.id));
});
