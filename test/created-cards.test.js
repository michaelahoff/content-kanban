import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';
import { parseDocument, playbookSettings, describeSettings, resolveCreates, composeLanePrompt, parseLaneResult, maxCreatedCards } from '../public/playbook-format.js';
import { youtubeVideoTemplate, validateTemplate } from '../public/card-template.js';
import { openStore } from '../store.js';

const result = (value) => `Done.\n\n\`\`\`frameboard-result\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const settingsOf = (text) => playbookSettings(parseDocument(text), youtubeVideoTemplate);
const sentText = (send) => send.input.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
const runs = async (f, cardId) => (await f.ok('GET', `/api/cards/${cardId}/lane-runs`)).runs;

// The card template created cards use. "internal" is hidden from the editor,
// so a lane result cannot set it.
const businessSite = { name: 'Business site', fields: [
  { key: 'location', label: 'Location' },
  { key: 'website', label: 'Website', control: 'url' },
  { key: 'brief', label: 'Brief', control: 'textarea' },
  { key: 'internal', label: 'Internal', control: 'textarea', editor: false },
] };
const site = { id: 'business-site', ...validateTemplate(businessSite).template };
const lanes = [{ id: 'intake', name: 'Intake' }, { id: 'research', name: 'Research' }];
const creating = resolveCreates({ lane: 'Research', template: 'Business site' }, lanes, [youtubeVideoTemplate, site]);

test('creates: names a lane and a card template, and reports what is missing', () => {
  const settings = settingsOf('---\nrun: manual\ncreates:\n  lane: Research\n  template: Business site\n---\nSplit the list.');
  assert.deepEqual(settings.errors, []);
  assert.deepEqual(settings.creates, { lane: 'Research', template: 'Business site' });
  assert.equal(settingsOf('---\nrun: manual\n---\nSplit.').creates, null);
  assert.deepEqual(settingsOf('---\ncreates:\n  lane: Research\n---\n').errors, ['creates: name the card template new cards use (template:).']);
  assert.deepEqual(settingsOf('---\ncreates:\n  template: Business site\n---\n').errors, ['creates: name the lane new cards go to (lane:).']);
  assert.deepEqual(settingsOf('---\ncreates: Research\n---\n').errors, ['creates needs a “lane:” line and a “template:” line.']);
  const extra = settingsOf('---\ncreates:\n  lane: Research\n  template: Business site\n  count: 3\n---\n');
  assert.deepEqual(extra.errors, []);
  assert.deepEqual(extra.warnings, ['creates: “count” ignored; it takes lane and template.']);
  assert.deepEqual(extra.creates, { lane: 'Research', template: 'Business site' }, 'an unknown key does not stop the setting');

  // By ID, then by name; a lane or template that is not found is null.
  assert.deepEqual(creating.lane, { id: 'research', name: 'Research' });
  assert.equal(creating.template.id, 'business-site');
  assert.equal(resolveCreates({ lane: 'intake', template: 'youtube-video' }, lanes, [youtubeVideoTemplate, site]).lane.name, 'Intake');
  assert.deepEqual(resolveCreates({ lane: 'Nowhere', template: 'Brochure' }, lanes, [site]), { lane: null, template: null });
  assert.equal(resolveCreates(null, lanes, [site]), null);

  assert.match(describeSettings(settings, youtubeVideoTemplate), /creates cards in Research/);
});

test('the prompt lists the created cards\' field keys and the result block lists the cards', () => {
  const base = { projectName: 'P', flowName: 'Sites', laneName: 'Intake', lanes, map: null, playbook: { path: 'lanes/intake.md' }, template: youtubeVideoTemplate,
    settings: settingsOf('---\ncreates:\n  lane: Research\n  template: Business site\n---\nSplit the list.') };
  const prompt = composeLanePrompt({ ...base, creates: creating });
  assert.ok(prompt.includes('## Creating cards'));
  assert.ok(prompt.includes('new cards in “Research”, each using the “Business site” card template'));
  assert.ok(prompt.includes('- Field keys for new cards: location (Location), website (Website), brief (Brief).'), 'hidden fields are not offered');
  assert.ok(prompt.includes('"cards": ['));
  assert.ok(prompt.includes('"location": "its starting value"'));
  const plain = composeLanePrompt({ ...base, settings: settingsOf('Work.') });
  assert.ok(!plain.includes('Creating cards') && !plain.includes('"cards"'));
  // A creates: setting whose lane or template is missing offers nothing.
  assert.ok(!composeLanePrompt({ ...base, creates: { lane: null, template: site } }).includes('Creating cards'));
});

test('a result\'s cards are checked against the creates: template', () => {
  const parse = (cards, creates = creating) => parseLaneResult(result({ notes: 'Split.', cards }), youtubeVideoTemplate, { creates });
  const valid = parse([{ title: ' Joe’s Diner ', fields: { location: 'Marfa, TX', Website: 'https://joes.example' } }, { title: 'Second' }]);
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.cards, [{ title: 'Joe’s Diner', fields: { location: 'Marfa, TX', website: 'https://joes.example' } }, { title: 'Second', fields: {} }]);

  const untitled = parse([{ fields: { location: 'Nowhere' } }, { title: '  ' }, 'A string', { title: 'Kept' }]);
  assert.deepEqual(untitled.cards.map((card) => card.title), ['Kept']);
  assert.deepEqual(untitled.errors, ['Ignored card 1: it needs a title.', 'Ignored card 2: it needs a title.', 'Ignored card 3: each card is an object with a title.']);

  const unknown = parse([{ title: 'B', fields: { bogus: 'x', internal: 'y', location: 4, brief: 'Kept' }, color: 'red' }]);
  assert.deepEqual(unknown.cards, [{ title: 'B', fields: { brief: 'Kept' } }], 'the card is still created');
  assert.deepEqual(unknown.errors, ['Ignored unknown field “bogus” on “B”.', 'Ignored unknown field “internal” on “B”.', 'Ignored Location on “B”: its value must be text.',
    'Ignored “color” on “B”: a new card takes a title and fields only.']);

  const many = parse(Array.from({ length: maxCreatedCards + 2 }, (_, index) => ({ title: `Card ${index + 1}` })));
  assert.equal(many.cards.length, maxCreatedCards);
  assert.deepEqual(many.errors, [`Ignored card 51: a lane run can create up to ${maxCreatedCards} cards.`, `Ignored card 52: a lane run can create up to ${maxCreatedCards} cards.`]);

  assert.deepEqual(parse({ title: 'One' }).errors, ['Ignored “cards”: it must be a list of cards, each with a title.']);
  for (const creates of [null, { lane: null, template: site }]) {
    const refused = parse([{ title: 'One' }], creates);
    assert.deepEqual(refused.cards, []);
    assert.match(refused.errors[0], /^Ignored “cards”: this lane does not create cards/);
  }
});

// A graph flow whose new cards use the Business site template: Intake creates
// cards in Research, whose playbook runs on entry and sets their brief.
async function sites(t) {
  const f = await fixture(t);
  const template = await f.ok('POST', '/api/templates', businessSite);
  const project = (await f.ok('GET', '/api/workspace')).projects[0];
  const flow = await f.ok('POST', `/api/projects/${project.id}/flows`, { name: 'Sites', kind: 'graph', templateId: template.id });
  const node = (name, x) => f.ok('POST', `/api/flows/${flow.id}/stages`, { name, color: 'teal', x, y: 320 });
  const Intake = await node('Intake', 0);
  const Research = await node('Research', 380);
  const intakePlaybook = (creates) => setPlaybook(f.ok, flow.id, Intake, { run: 'manual', model: 'test-model', creates }, 'Split the list into one card per business.');
  await intakePlaybook({ lane: 'Research', template: 'Business site' });
  await setPlaybook(f.ok, flow.id, Research, { run: 'on-enter', model: 'test-model', set: { brief: 'Find the website and opening hours.' } }, 'Research the business.');
  const card = (stage, input = {}) => f.ok('POST', `/api/projects/${project.id}/cards`, { stageId: stage.id, ...input });
  const cards = async () => (await f.ok('GET', `/api/projects/${project.id}/cards`)).cards;
  return { ...f, project, flow, template, Intake, Research, intakePlaybook, card, cards };
}

test('a lane run creates cards in its creates: lane, each knowing its origin, and each is worked on there', async (t) => {
  const f = await sites(t);
  const intakeStage = (await f.ok('GET', '/api/workspace')).flows.find((flow) => flow.id === f.flow.id).stages.find((stage) => stage.id === f.Intake.id);
  assert.deepEqual(intakeStage.playbook.creates, { lane: 'Research', template: 'Business site' }, 'the board reads the setting');
  assert.equal(intakeStage.playbook.action, null);
  // The list card uses another template, so the created cards' template is the creates: one.
  const intake = await f.card(f.Intake, { title: 'Businesses in Marfa', template: 'youtube-video' });
  assert.equal(intake.parentId, null);
  await f.ok('POST', `/api/cards/${intake.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  assert.ok(sentText(send).includes('## Creating cards'));
  assert.ok(sentText(send).includes('- Field keys for new cards: location (Location), website (Website), brief (Brief).'));
  f.codex.finish(send, 'completed', result({ notes: 'Two businesses.', cards: [{ title: 'Joe\'s Diner', fields: { location: 'Marfa, TX', bogus: 'x' } }, { title: 'Second' }] }));

  const run = await waitFor(async () => (await runs(f, intake.id)).find((item) => item.status === 'completed'));
  assert.match(run.reason, /Created 2 cards in Research\./);
  assert.match(run.reason, /Ignored unknown field “bogus” on “Joe's Diner”\./, 'a field a card cannot hold is reported');
  const created = (await f.cards()).filter((card) => card.parentId === intake.id);
  assert.deepEqual(created.map((card) => card.title), ['Joe\'s Diner', 'Second']);
  assert.deepEqual(run.result.cards, created.map(({ id, title }) => ({ id, title })));
  for (const card of created) {
    assert.equal(card.stageId, f.Research.id);
    assert.equal(card.template, f.template.id);
    assert.equal(card.fields.brief, 'Find the website and opening hours.', 'the Research playbook’s set: values apply');
  }
  assert.equal(created[0].fields.location, 'Marfa, TX');
  assert.ok(!('bogus' in created[0].fields));
  const { events } = await f.ok('GET', `/api/cards/${created[0].id}`);
  const made = events.find((event) => event.type === 'created');
  assert.deepEqual(made.data, { origin: intake.id, laneRunId: run.id });
  assert.match(made.actor, /^automation:/);
  assert.ok(events.some((event) => event.type === 'fields_set' && event.data.fields.includes('brief')));
  assert.equal((await f.ok('GET', `/api/cards/${intake.id}`)).card.stageId, f.Intake.id, 'the list card stays where it is');

  // Each created card entered an on-entry lane, so each gets its own run.
  for (const card of created) assert.ok((await runs(f, card.id)).some((item) => item.stageId === f.Research.id && ['pending', 'queued'].includes(item.status)));
  const research = await waitFor(() => (f.codex.sends.length >= 3 ? f.codex.sends.slice(1) : null));
  assert.equal(research.length, 2);
  assert.ok(research.every((item) => sentText(item).includes('## Lane playbook: Research')));
  assert.ok(research.some((item) => sentText(item).includes('Marfa, TX')));

  await f.restart();
  const after = (await f.cards()).filter((card) => card.parentId === intake.id);
  assert.deepEqual(after.map((card) => [card.title, card.parentId]), [['Joe\'s Diner', intake.id], ['Second', intake.id]], 'created cards keep their origin after a restart');
});

test('a run whose creates: lane or template is not found fails before anything is sent', async (t) => {
  const f = await sites(t);
  const intake = await f.card(f.Intake, { title: 'Businesses in Marfa' });
  await f.intakePlaybook({ lane: 'Nowhere', template: 'Business site' });
  await f.ok('POST', `/api/cards/${intake.id}/lane-runs`, {});
  const lane = await waitFor(async () => (await runs(f, intake.id)).find((item) => item.status === 'failed'));
  assert.equal(lane.reason, 'creates: the lane “Nowhere” is not in this flow.');
  await f.intakePlaybook({ lane: 'Research', template: 'Brochure' });
  await f.ok('POST', `/api/cards/${intake.id}/lane-runs`, {});
  const template = await waitFor(async () => (await runs(f, intake.id)).find((item) => item.status === 'failed' && item.id !== lane.id));
  assert.equal(template.reason, 'creates: there is no card template named “Brochure”.');
  assert.equal(f.codex.sends.length, 0);
  assert.equal((await f.cards()).length, 1);
});

test('a result naming cards in a lane that does not create them creates none and says why', async (t) => {
  const f = await sites(t);
  const intake = await f.card(f.Intake, { title: 'Businesses in Marfa' });
  await f.ok('POST', `/api/cards/${intake.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  // The lane is renamed while the run works: the frozen playbook names it by name.
  await f.ok('PATCH', `/api/stages/${f.Research.id}`, { name: 'Deep research' });
  f.codex.finish(send, 'completed', result({ notes: 'Split.', cards: [{ title: 'Late' }] }));
  const run = await waitFor(async () => (await runs(f, intake.id)).find((item) => item.status === 'completed'));
  assert.match(run.reason, /Ignored “cards”: the lane “Research” named by creates: is no longer in this flow\./);
  assert.deepEqual(run.result.cards, []);
  assert.equal((await f.cards()).length, 1);
});

test('people create cards without an origin', async (t) => {
  const f = await sites(t);
  const intake = await f.card(f.Intake, { title: 'List' });
  const refused = await f.call('POST', `/api/projects/${f.project.id}/cards`, { stageId: f.Research.id, title: 'Child', parentId: intake.id });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'Cards get their origin from the lane run that creates them.');
  // Creating a card by hand in an on-entry lane still starts nothing.
  const plain = await f.card(f.Research, { title: 'By hand' });
  assert.equal(plain.parentId, null);
  assert.deepEqual(await runs(f, plain.id), []);
});

test('the store creates cards only in the flow of the lane that creates them', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-created-'));
  const store = await openStore({ dataDir });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const ctx = { ...store.owner, actor: 'automation:test' };
  const { projects, flows } = store.workspace(ctx);
  const [first, second] = flows[0].stages;
  const other = store.createFlow(ctx, projects[0].id, { name: 'Other' });
  const origin = store.createCard(ctx, projects[0].id, { stageId: first.id, title: 'Origin' });
  const input = { parentId: origin.id, stageId: second.id, templateId: 'youtube-video' };
  const refused = (changes, status, message) => assert.throws(() => store.createCards(ctx, { ...input, ...changes }), (error) => error.status === status && message.test(error.message));
  refused({ stageId: other.stages[0].id, cards: [{ title: 'Away' }] }, 400, /same flow as the lane that creates them/);
  refused({ templateId: 'brochure', cards: [{ title: 'Odd' }] }, 404, /card template does not exist/);
  refused({ parentId: 'missing', cards: [{ title: 'Lost' }] }, 404, /card no longer exists/);
  refused({ cards: Array.from({ length: maxCreatedCards + 1 }, () => ({ title: 'Many' })) }, 400, /up to 50 cards/);
  // A bad card refuses the whole list before anything is written.
  refused({ cards: [{ title: 'Fine' }, { title: 'Bad', fields: { nope: 'x' } }] }, 400, /Unknown card field “nope”/);
  refused({ cards: [{ title: 'Fine' }, { fields: {} }] }, 400, /needs a title/);
  assert.equal(store.listCards(ctx, projects[0].id).length, 1);

  const made = store.createCards(ctx, { ...input, cards: [{ title: 'One', fields: { intro: 'Hello' } }, { title: 'Two' }] });
  assert.deepEqual(made.map((card) => [card.title, card.parentId, card.stageId, card.fields.intro]), [['One', origin.id, second.id, 'Hello'], ['Two', origin.id, second.id, '']]);
  assert.ok(made[0].position < made[1].position, 'in order, at the end of the lane');
  assert.deepEqual(store.laneRuns.forCard(ctx, made[0].id), [], 'a lane with no playbook starts nothing');
  // Deleting the origin leaves its created cards, which still name it.
  store.deleteCard(ctx, origin.id);
  assert.deepEqual(store.listCards(ctx, projects[0].id).map((card) => card.parentId), [origin.id, origin.id]);
});

test('a lane that holds created cards names their template, and the board reads its settings against it', async (t) => {
  const f = await fixture(t);
  const workspace = await f.ok('GET', '/api/workspace');
  const project = workspace.projects[0];
  const flow = workspace.flows.find((item) => item.id === project.flowId);
  const research = flow.stages[1];
  const created = await f.ok('POST', '/api/templates', { name: 'Business site', fields: [{ key: 'research', label: 'Research', control: 'textarea' }], imageRoles: [] });
  // Written for Business site cards: its fields are not the flow template's.
  await setPlaybook(f.ok, flow.id, research, { run: 'on-enter', template: 'Business site', may_edit: ['research'], context: ['title', 'research'] }, 'Research the business.');
  const view = async () => (await f.ok('GET', '/api/workspace')).flows.find((item) => item.id === flow.id).stages.find((stage) => stage.id === research.id).playbook;
  let playbook = await view();
  assert.deepEqual(playbook.errors, [], 'settings are read against the named template');
  assert.match(playbook.summary, /for Business site cards/);
  // Without template: the same settings are errors against the flow's template.
  await setPlaybook(f.ok, flow.id, research, { run: 'on-enter', may_edit: ['research'] }, 'Research the business.');
  playbook = await view();
  assert.deepEqual(playbook.errors, ['may_edit: “research” is not an editable card field.']);
  // A template that does not exist is reported, and the flow's template stands in.
  await setPlaybook(f.ok, flow.id, research, { run: 'on-enter', template: 'Nowhere', may_edit: ['intro'] }, 'Work.');
  playbook = await view();
  assert.deepEqual(playbook.errors, ['template: “Nowhere” is not a card template, so these settings are read against the flow\'s template.']);
  assert.equal(created.id, 'business-site');
});
