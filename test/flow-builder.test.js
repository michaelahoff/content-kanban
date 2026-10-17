import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.js';
import { createFlowBuilder, composePlaybook, layoutGraph, projectSummary } from '../flow-builder.js';
import { builderTools } from '../flow-builder-tools.js';
import { parseDocument } from '../public/playbook-format.js';

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-builder-'));
  const store = await openStore({ dataDir });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const ctx = { workspaceId: store.owner.workspaceId, userId: store.owner.userId, actor: `user:${store.owner.userId}` };
  const builder = createFlowBuilder({ store });
  const project = store.workspace(ctx).projects[0];
  const call = async (name, input) => builder.call(ctx, project.id, name, input);
  const flows = () => store.workspace(ctx).flows.filter((flow) => flow.projectId === project.id);
  return { store, ctx, builder, project, call, flows, dataDir };
}

const leadTemplate = { name: 'Lead', title: { label: 'Company' }, fields: [
  { label: 'Contact', key: 'contact' }, { label: 'Website', control: 'url' }, { label: 'Research', control: 'textarea' },
  { label: 'Draft email', key: 'draftEmail', control: 'textarea', copy: true }, { label: 'Brief', control: 'textarea', hidden: true }] };
const emailLanes = [
  { name: 'New leads', color: 'lavender', playbook: { run: 'off', set: { brief: 'Warm, short, one clear ask.' } } },
  { name: 'Research', playbook: { run: 'on-enter', conversation: 'fresh', may_edit: ['research'], skills: ['voice'], routes: { done: 'Draft' }, advance: 'auto', instructions: 'Find three facts about the company and put them in Research.' } },
  { name: 'Draft', color: 'blue', playbook: { may_edit: ['draftEmail'], skills: ['voice'], routes: { ready: 'Review' }, instructions: 'Write the email into Draft email using the brief and the research.' } },
  { name: 'Review', color: 'amber', playbook: { run: 'off', routes: { approved: 'Sent', revise: 'Draft' } } },
  { name: 'Sent', color: 'green', playbook: { run: 'off' } },
];

test('the builder tools describe every tool with a JSON schema', () => {
  for (const tool of builderTools) {
    assert.equal(tool.type, 'function');
    assert.match(tool.name, /^[a-z_]+$/);
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const key of tool.inputSchema.required) assert.ok(tool.inputSchema.properties[key], `${tool.name} requires ${key}`);
  }
  assert.deepEqual(builderTools.map((tool) => tool.name).slice(0, 4), ['read_project', 'read_flow', 'read_template', 'create_flow']);
});

test('read_project describes the project, its flows and lanes, the templates, the Library and the providers', async (t) => {
  const f = await fixture(t);
  const seen = await f.call('read_project');
  assert.equal(seen.project.name, 'My project');
  assert.equal(seen.flows.length, 1);
  assert.deepEqual(seen.flows[0].lanes.map((lane) => lane.name), ['Ideas', 'In progress', 'Review', 'Done']);
  assert.equal(seen.flows[0].lanes[0].cardCount, 0);
  assert.equal(seen.templates[0].id, 'youtube-video');
  assert.ok(seen.templates[0].fields.find((field) => field.key === 'prompt').hidden, 'hidden fields are marked');
  assert.deepEqual(seen.library, { files: [], folders: [] });
  assert.deepEqual(seen.providers.map((provider) => [provider.provider, provider.enabled]), [['codex', true], ['claude', false]]);
  assert.match(projectSummary(f.store, f.ctx, f.project.id), /Flow “Main” \(board, id [\w-]+, template “YouTube video”, 0 cards\): Ideas \([\w-]+\) → In progress/);
  await assert.rejects(() => f.call('read_flow', { flowId: 'nope' }), /no flow with the ID “nope”/);
  await assert.rejects(() => f.call('no_such_tool', {}), /Unknown Frameboard tool/);
});

test('create_flow rebuilds the untouched starter flow as a graph with a new template, playbooks, routes, skills and a map', async (t) => {
  const f = await fixture(t);
  const template = await f.call('create_template', leadTemplate);
  assert.equal(template.id, 'lead');
  assert.deepEqual(template.fields.map((field) => field.key), ['contact', 'website', 'research', 'draftEmail', 'brief']);
  assert.ok(template.fields.at(-1).hidden);
  const main = f.flows()[0];
  const result = await f.call('create_flow', { flowId: main.id, name: 'Lead emails', kind: 'graph', templateId: 'Lead', lanes: emailLanes,
    map: '# Lead emails\n\nShort warm emails to inbound leads.', skills: { voice: '# Voice\n\nPlain words, no hype.' } });
  assert.equal(result.rebuilt, true);
  assert.deepEqual(result.problems, []);
  assert.equal(f.flows().length, 1, 'the starter flow was rebuilt, not joined by a second one');
  const flow = f.flows()[0];
  assert.equal(flow.id, main.id);
  assert.deepEqual([flow.name, flow.kind, flow.templateId], ['Lead emails', 'graph', 'lead']);
  assert.deepEqual(flow.stages.map((stage) => stage.name), ['New leads', 'Research', 'Draft', 'Review', 'Sent']);
  assert.deepEqual(flow.stages.map((stage) => stage.color), ['lavender', 'blue', 'blue', 'amber', 'green'], 'a lane without a color gets one');
  // Nodes are laid out left to right along the routes; Review's revise route back to Draft does not pull Draft forward.
  assert.deepEqual(flow.stages.map((stage) => [stage.x, stage.y]), [[0, 40], [380, 40], [760, 40], [1140, 40], [1520, 40]]);
  const byName = Object.fromEntries(flow.stages.map((stage) => [stage.name, stage]));
  assert.deepEqual(byName.Research.playbook.routes, [{ name: 'done', target: byName.Draft.id, laneId: byName.Draft.id }], 'route names become lane IDs');
  assert.equal(byName.Research.playbook.advance, 'auto');
  assert.equal(byName.Research.playbook.run, 'on-enter');
  assert.deepEqual(byName.Review.playbook.routes.map((route) => route.laneId), [byName.Sent.id, byName.Draft.id]);
  assert.equal(byName.Review.playbook.run, 'off');
  assert.match(byName.Draft.playbook.summary, /Runs on entry · Card chat provider · may edit Draft email · 1 route/);
  const listing = f.store.playbooks.list(flow.id);
  assert.equal(listing.map.text, '# Lead emails\n\nShort warm emails to inbound leads.');
  assert.deepEqual(listing.skills.map((skill) => skill.path), ['skills/voice.md']);
  assert.equal(listing.lanes.length, 5, 'the starter playbooks are gone');
  const research = parseDocument(listing.lanes.find((document) => document.laneId === byName.Research.id).text);
  assert.deepEqual(research.data, { lane: byName.Research.id, run: 'on-enter', conversation: 'fresh', may_edit: ['research'], skills: ['voice'], advance: 'auto', routes: { done: byName.Draft.id } });
  assert.equal(research.body.trim(), 'Find three facts about the company and put them in Research.');
  const seen = await f.call('read_flow', { flowId: flow.id });
  assert.equal(seen.lanes[0].playbook.settings.set.brief, 'Warm, short, one clear ask.');
  assert.deepEqual(seen.skills, [{ name: 'voice', text: '# Voice\n\nPlain words, no hype.' }]);
  // A card created in the start lane takes the template and the lane's set: values.
  const cards = await f.call('create_cards', { laneId: byName['New leads'].id, cards: [{ title: 'Acme', fields: { contact: 'Ada' } }] });
  const card = f.store.getCard(f.ctx, cards.cards[0].id).card;
  assert.deepEqual([card.template, card.fields.contact, card.fields.brief], ['lead', 'Ada', 'Warm, short, one clear ask.']);
  await assert.rejects(() => f.call('create_flow', { flowId: flow.id, lanes: emailLanes }), /holds 1 card, so it cannot be rebuilt/);
});

test('create_flow checks every playbook against the planned lanes and template before creating anything', async (t) => {
  const f = await fixture(t);
  const before = f.flows();
  await assert.rejects(() => f.call('create_flow', { name: 'Broken', lanes: [{ name: 'A', playbook: { may_edit: ['nothing'], instructions: 'x' } }, { name: 'B' }] }), /Lane “A”: may_edit: “nothing” is not an editable card field/);
  await assert.rejects(() => f.call('create_flow', { name: 'Broken', kind: 'graph', lanes: [{ name: 'A', playbook: { routes: { next: 'Nowhere' } } }] }), /routes: “next” leads to “Nowhere”, which is not a lane/);
  await assert.rejects(() => f.call('create_flow', { name: 'Broken', lanes: [{ name: 'A', playbook: { skills: ['missing'], instructions: 'x' } }] }), /skills: “missing” has no file yet/);
  await assert.rejects(() => f.call('create_flow', { name: 'Broken', lanes: [{ name: 'A' }, { name: 'a' }] }), /Two lanes are called “a”/);
  await assert.rejects(() => f.call('create_flow', { name: 'Broken', lanes: [{ name: 'A', color: 'plaid' }] }), /color must be one of/);
  await assert.rejects(() => f.call('create_flow', { name: 'Broken', lanes: [{ name: 'A', playbook: { set: { prompt: 7 } } }] }), /set must be an object of text values/);
  await assert.rejects(() => f.call('create_flow', { name: 'Broken', lanes: [{ name: 'A', playbook: { bogus: 'x' } }] }), /unknown playbook setting bogus/);
  assert.deepEqual(f.flows().map((flow) => flow.id), before.map((flow) => flow.id), 'nothing was created');
  assert.deepEqual(f.flows()[0].stages.map((stage) => stage.name), ['Ideas', 'In progress', 'Review', 'Done']);
  // A new flow joins the existing one; its map is generated when none is given.
  const created = await f.call('create_flow', { name: 'Shorts', lanes: [{ name: 'Idea' }, { name: 'Cut', playbook: { instructions: 'Cut it to 60 seconds.', may_edit: ['script'] } }, { name: 'Posted' }] });
  assert.equal(created.created, true);
  assert.equal(f.flows().length, 2);
  assert.match(f.store.playbooks.read(created.flow.id, 'MAP.md').text, /^# Shorts — flow map/);
  assert.ok(f.store.playbooks.read(created.flow.id, 'MAP.md').text.includes('1. **Idea**'));
  assert.equal(created.flow.lanes[0].playbook, null, 'a board lane without a playbook has none');
  assert.deepEqual(created.problems, []);
  const warned = await f.call('create_flow', { name: 'Quiet', lanes: [{ name: 'A', playbook: { run: 'on-enter', set: { prompt: 'x' } } }] });
  assert.match(warned.problems[0], /has run: on-enter but no instructions/);
});

test('lanes, playbooks, routes, skills, templates and cards can be changed one at a time', async (t) => {
  const f = await fixture(t);
  const flow = f.flows()[0];
  const [ideas, progress, review, done] = flow.stages;
  // write_playbook replaces the settings block and keeps the instructions when none are given.
  const first = await f.call('write_playbook', { laneId: progress.id, playbook: { may_edit: ['intro'], instructions: 'Write the intro.' } });
  assert.equal(first.path, 'lanes/in-progress.md');
  assert.match(first.summary, /Runs on entry · Card chat provider · may edit Intro/);
  const second = await f.call('write_playbook', { laneId: progress.id, playbook: { run: 'manual', may_edit: ['intro', 'Title Options'] } });
  assert.match(second.summary, /Runs when you choose/);
  const document = parseDocument(f.store.playbooks.forStage(flow.id, progress.id).text);
  assert.deepEqual(document.data, { lane: progress.id, run: 'manual', may_edit: ['intro', 'titleOptions'] });
  assert.equal(document.body.trim(), 'Write the intro.');
  await assert.rejects(() => f.call('write_playbook', { laneId: progress.id, playbook: { may_edit: ['nope'] } }), /Lane “In progress”: may_edit: “nope”/);
  assert.equal(parseDocument(f.store.playbooks.forStage(flow.id, progress.id).text).data.run, 'manual', 'a refused write changes nothing');
  // Routes alone, by name; skills; map.
  const routed = await f.call('set_routes', { laneId: review.id, routes: { approved: 'Done', revise: 'In progress' }, advance: 'auto' });
  assert.deepEqual(routed, { routes: [{ name: 'approved', to: 'Done' }, { name: 'revise', to: 'In progress' }], advance: 'auto' });
  assert.deepEqual(parseDocument(f.store.playbooks.forStage(flow.id, review.id).text).data.routes, { approved: done.id, revise: progress.id });
  await assert.rejects(() => f.call('set_routes', { laneId: review.id, routes: { lost: 'Elsewhere' } }), /not a lane of “Main”/);
  await f.call('write_skill', { flowId: flow.id, name: 'voice', text: '# Voice' });
  assert.equal(f.store.playbooks.read(flow.id, 'skills/voice.md').text, '# Voice');
  await f.call('write_playbook', { laneId: progress.id, playbook: { skills: ['voice'], instructions: 'Use the voice.' } });
  await f.call('write_map', { flowId: flow.id, text: '# Main\n\nThe map.' });
  assert.equal(f.store.playbooks.read(flow.id, 'MAP.md').text, '# Main\n\nThe map.');
  await f.call('delete_skill', { flowId: flow.id, name: 'voice' });
  assert.equal(f.store.playbooks.read(flow.id, 'skills/voice.md'), null);
  // Lanes: add one with a playbook at a place, rename, delete with and without cards.
  const added = await f.call('create_lane', { flowId: flow.id, name: 'Polish', color: 'teal', position: 2, playbook: { may_edit: ['script'], instructions: 'Polish the script.' } });
  assert.deepEqual(f.flows()[0].stages.map((stage) => stage.name), ['Ideas', 'In progress', 'Polish', 'Review', 'Done']);
  assert.match(added.lane.playbook.summary, /may edit Script/);
  await f.call('update_lane', { laneId: added.lane.id, name: 'Final polish', color: 'cyan' });
  assert.deepEqual(f.flows()[0].stages[2].name, 'Final polish');
  await assert.rejects(() => f.call('update_lane', { laneId: added.lane.id, name: 'review' }), /already has a lane called “review”/);
  const card = f.store.createCard(f.ctx, f.project.id, { stageId: added.lane.id, title: 'Keep me' });
  await assert.rejects(() => f.call('delete_lane', { laneId: added.lane.id }), /holds 1 card\. Name a lane in moveCardsTo/);
  const removed = await f.call('delete_lane', { laneId: added.lane.id, moveCardsTo: ideas.id });
  assert.equal(removed.movedCards, 1);
  assert.equal(f.store.getCard(f.ctx, card.id).card.stageId, ideas.id);
  assert.deepEqual(f.flows()[0].stages.map((stage) => stage.name), ['Ideas', 'In progress', 'Review', 'Done']);
  assert.ok(!f.store.playbooks.lanes(flow.id).some((entry) => entry.laneId === added.lane.id), 'its playbook file went with it');
  // Flows: rename and convert; a flow with cards cannot be deleted.
  const renamed = await f.call('update_flow', { flowId: flow.id, name: 'Videos', kind: 'graph' });
  assert.deepEqual([renamed.flow.name, renamed.flow.kind], ['Videos', 'graph']);
  assert.equal(renamed.flow.lanes[0].playbook.routes[0].laneId, progress.id, 'a board turned into a graph routes each lane to the next');
  await assert.rejects(() => f.call('delete_flow', { flowId: flow.id }), /holds 1 card/);
  const other = await f.call('create_flow', { name: 'Spare', lanes: [{ name: 'Only' }] });
  assert.deepEqual(await f.call('delete_flow', { flowId: other.flow.id }), { deleted: 'Spare' });
  // Templates: update keeps keys cards use, delete refuses templates in use.
  const template = await f.call('create_template', { name: 'Post', fields: [{ label: 'Body', control: 'textarea' }] });
  const updated = await f.call('update_template', { templateId: template.id, fields: [{ key: 'body', label: 'Post body', control: 'textarea' }, { label: 'Slug' }] });
  assert.deepEqual(updated.fields.map((field) => [field.key, field.label]), [['body', 'Post body'], ['slug', 'Slug']]);
  assert.equal((await f.call('read_template', { templateId: 'Post' })).name, 'Post');
  await assert.rejects(() => f.call('delete_template', { templateId: 'youtube-video' }), /cards use this template|uses this template/);
  assert.deepEqual(await f.call('delete_template', { templateId: template.id }), { deleted: 'Post' });
  await assert.rejects(() => f.call('create_cards', { laneId: ideas.id, cards: [] }), /one to 50 cards/);
});

test('an archived project can be read but not changed by the builder', async (t) => {
  const f = await fixture(t);
  f.store.archiveProject(f.ctx, f.project.id);
  assert.ok((await f.call('read_project')).project.archived);
  await assert.rejects(() => f.call('create_flow', { name: 'Nope', lanes: [{ name: 'A' }] }), /archived/);
  await assert.rejects(() => f.call('write_map', { flowId: f.flows()[0].id, text: 'x' }), /archived/);
});

test('composePlaybook writes a document Frameboard reads back the same way, and layoutGraph places branches in rows', () => {
  const templates = [{ id: 'youtube-video', name: 'YouTube video', title: { label: 'Card title', max: 500 }, fields: [{ key: 'intro', label: 'Intro', control: 'textarea', max: 1000 }], imageRoles: [] }];
  const lanes = [{ id: 'a', name: 'Draft' }, { id: 'b', name: 'Review' }];
  const composed = composePlaybook({ run: 'on-enter', may_edit: ['Intro'], set: { intro: 'Line one\nLine two' }, routes: { next: 'review' }, instructions: 'Do it.\r\n' },
    { laneId: 'a', lanes, templates, flowTemplate: templates[0], skills: new Set(), where: 'Lane “Draft”' });
  const parsed = parseDocument(composed.text);
  assert.deepEqual(parsed.data, { lane: 'a', run: 'on-enter', may_edit: ['intro'], set: { intro: 'Line one\nLine two' }, routes: { next: 'b' } }, 'labels are written as keys');
  assert.equal(parsed.body, '\nDo it.\n');
  assert.deepEqual(composed.settings.mayEdit, ['intro']);
  assert.deepEqual(composed.warnings, []);
  assert.throws(() => composePlaybook({ routes: { back: 'Draft' } }, { laneId: 'a', lanes, templates, flowTemplate: templates[0], skills: new Set(), where: 'Lane “Draft”' }), /leads back to this lane/);
  const placed = layoutGraph([{ name: 'Start', playbook: { routes: { a: 'Left', b: 'Right' } } }, { name: 'Left', playbook: { routes: { on: 'End' } } }, { name: 'Right', playbook: { routes: { on: 'End' } } }, { name: 'End' }, { name: 'Lost', x: 5, y: 6 }]);
  assert.deepEqual(placed.map((lane) => [lane.x, lane.y]), [[0, 40], [380, 40], [380, 270], [760, 40], [5, 6]]);
});
