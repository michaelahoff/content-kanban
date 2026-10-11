import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';
import { supportedSchemaVersion } from '../store.js';
import { youtubeVideoTemplate } from '../public/card-template.js';

// A template with every control. "notes" is a reserved key (lane results
// report hand-off notes under it), so the hidden field is keyed authorNotes.
const blogPost = {
  name: 'Blog post',
  fields: [
    { key: 'headline', label: 'Headline' },
    { key: 'body', label: 'Body', control: 'textarea', countWords: true },
    { key: 'canonicalUrl', label: 'Canonical URL', control: 'url' },
    { key: 'authorNotes', label: 'Author notes', control: 'textarea', editor: false },
  ],
  imageRoles: [{ key: 'hero', label: 'Hero' }, { key: 'thumbnail', label: 'Thumbnail' }],
};
const keys = (list) => list.map((entry) => entry.key);
const templates = async (f) => (await f.ok('GET', '/api/templates')).templates;
const templateById = async (f, id) => (await templates(f)).find((template) => template.id === id);
// A PATCH sends the whole definition; `changes` overrides parts of the saved one.
const patchTemplate = (f, template, changes = {}) => f.call('PATCH', `/api/templates/${template.id}`,
  { revision: template.revision, name: template.name, title: template.title, fields: template.fields, imageRoles: template.imageRoles, ...changes });
const saveTemplate = async (f, template, changes) => {
  const saved = await patchTemplate(f, template, changes);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return saved.body;
};
// Projects beyond the fixture's first one get their own flow and lanes.
const createProject = async (f, name, templateId) => {
  const { project, flow } = await f.ok('POST', '/api/projects', { name, ...(templateId === undefined ? {} : { templateId }) });
  return { project, stages: flow.stages };
};
const createCard = (f, project, stageId, input = {}) => f.ok('POST', `/api/projects/${project.id}/cards`, { stageId, ...input });
const getCard = async (f, id) => (await f.ok('GET', `/api/cards/${id}`)).card;
const runs = async (f, cardId) => (await f.ok('GET', `/api/cards/${cardId}/lane-runs`)).runs;
const result = (value) => `Done.\n\n\`\`\`frameboard-result\n${JSON.stringify(value, null, 2)}\n\`\`\``;

test('the workspace lists the built-in template with its usage counts and each project’s template', async (t) => {
  const f = await fixture(t);
  await f.card({ title: 'Counted' });
  const workspace = await f.ok('GET', '/api/workspace');
  assert.equal(workspace.templates.length, 1);
  const [builtin] = workspace.templates;
  assert.equal(builtin.id, 'youtube-video');
  assert.equal(builtin.name, 'YouTube video');
  assert.equal(builtin.fields.length, 7);
  assert.deepEqual(keys(builtin.fields), keys(youtubeVideoTemplate.fields));
  assert.deepEqual(keys(builtin.imageRoles), ['original', 'inspiration']);
  assert.equal(builtin.builtin, true);
  assert.equal(builtin.revision, 1);
  assert.equal(builtin.cardCount, 1);
  assert.equal(builtin.projectCount, 1);
  assert.equal(workspace.projects.length, 1);
  for (const project of workspace.projects) assert.equal(project.templateId, 'youtube-video');
  assert.deepEqual(await templates(f), workspace.templates);
});

test('creating a template normalizes its fields, numbers a repeated name and refuses bad definitions', async (t) => {
  const f = await fixture(t);
  const created = await f.call('POST', '/api/templates', blogPost);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.id, 'blog-post');
  assert.equal(created.body.revision, 1);
  assert.equal(created.body.builtin, false);
  assert.deepEqual(created.body.title, { label: 'Card title', max: 500 });
  assert.deepEqual(created.body.fields, [
    { key: 'headline', label: 'Headline', control: 'text', max: 500 },
    { key: 'body', label: 'Body', control: 'textarea', max: 200000, countWords: true },
    { key: 'canonicalUrl', label: 'Canonical URL', control: 'url', max: 4096 },
    { key: 'authorNotes', label: 'Author notes', control: 'textarea', max: 200000, editor: false },
  ]);
  assert.deepEqual(created.body.imageRoles, blogPost.imageRoles);
  assert.equal(created.body.cardCount, 0);
  assert.equal(created.body.projectCount, 0);
  assert.equal((await f.ok('POST', '/api/templates', blogPost)).id, 'blog-post-2');
  assert.deepEqual((await templates(f)).map((template) => template.id), ['youtube-video', 'blog-post', 'blog-post-2']);
  const field = (key, extra = {}) => ({ key, label: key, ...extra });
  const refused = [
    [{ ...blogPost, fields: [field('title')] }, /“title” is reserved/],
    [{ ...blogPost, fields: [field('headline'), field('headline')] }, /already uses the key “headline”/],
    [{ ...blogPost, fields: [field('head line')] }, /must start with a letter/],
    [{ ...blogPost, fields: [field('1stLine')] }, /must start with a letter/],
    [{ ...blogPost, fields: [field('rating', { control: 'number' })] }, /control must be text, textarea or url/],
    [{ ...blogPost, fields: [field('body', { control: 'textarea', youtube: true })] }, /only a url field can fetch from YouTube/],
    [{ ...blogPost, imageRoles: [{ key: 'cover', label: 'Cover' }] }, /“cover” is the display image/],
    [{ ...blogPost, fields: Array.from({ length: 51 }, (_, index) => field(`field${index}`)) }, /up to 50 fields/],
    [{ ...blogPost, name: undefined }, /need a name/],
  ];
  for (const [input, message] of refused) {
    const response = await f.call('POST', '/api/templates', input);
    assert.equal(response.status, 400, JSON.stringify(input).slice(0, 120));
    assert.match(response.body.error, message);
  }
  assert.equal((await templates(f)).length, 3, 'Refused templates are not created');
});

test('a template PATCH needs the current revision, bumps it and posts an activity entry', async (t) => {
  const f = await fixture(t);
  const created = await f.ok('POST', '/api/templates', blogPost);
  const stale = await patchTemplate(f, { ...created, revision: 0 }, { name: 'Blog article' });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed in another tab/);
  assert.equal((await templateById(f, 'blog-post')).name, 'Blog post', 'A stale save changes nothing');
  const updated = await saveTemplate(f, created, { name: 'Blog article' });
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, 'Blog article');
  assert.equal((await templateById(f, 'blog-post')).revision, 2);
  const { events } = await f.ok('GET', '/api/events?since=0');
  const entry = events.find((event) => event.entity === 'template' && event.type === 'updated');
  assert.ok(entry, 'The activity feed carries the template update');
  assert.equal(entry.entityId, 'blog-post');
  assert.equal(entry.data.revision, 2);
  assert.ok(events.some((event) => event.entity === 'template' && event.type === 'created' && event.entityId === 'blog-post'));
  assert.equal((await patchTemplate(f, created, { name: 'Again' })).status, 409, 'The revision the first save was based on is stale now');
});

test('adding a field to a template backfills existing cards with an empty value and a field version', async (t) => {
  const f = await fixture(t);
  const template = await f.ok('POST', '/api/templates', blogPost);
  const { project, stages } = await createProject(f, 'Blog', template.id);
  const card = await createCard(f, project, stages[0].id, { title: 'Post', fields: { headline: 'Hello' } });
  assert.equal(card.template, 'blog-post');
  assert.ok(!('summary' in card.fields));
  const updated = await saveTemplate(f, template, { fields: [...template.fields, { key: 'summary', label: 'Summary', control: 'textarea' }] });
  assert.ok(keys(updated.fields).includes('summary'));
  const loaded = await getCard(f, card.id);
  assert.equal(loaded.fields.summary, '');
  assert.equal(loaded.fieldVersions.summary, 1);
  assert.equal(loaded.fields.headline, 'Hello', 'Other values are untouched');
  assert.equal(loaded.revision, card.revision, 'Backfilling is not a card edit');
  const saved = await f.ok('PATCH', `/api/cards/${card.id}`, { changes: { summary: 'x' }, baseVersions: { summary: 1 }, editingSessionId: 'session-1' });
  assert.deepEqual(saved.conflicts, []);
  assert.equal(saved.fields.summary, 'x');
  assert.equal(saved.fieldVersions.summary, 2);
  const later = await createCard(f, project, stages[0].id);
  assert.equal(later.fields.summary, '');
  assert.equal(later.fieldVersions.summary, 1);
});

test('a field cannot be removed while a live card holds a value; removed values stay stored and return with the key', async (t) => {
  const f = await fixture(t);
  const template = await f.ok('POST', '/api/templates', blogPost);
  const { project, stages } = await createProject(f, 'Blog', template.id);
  const card = await createCard(f, project, stages[0].id, { fields: { headline: 'Keep me' } });
  // A deleted card's value does not lock the field, but it is never erased.
  const gone = await createCard(f, project, stages[0].id, { fields: { headline: 'Gone' } });
  await f.ok('DELETE', `/api/cards/${gone.id}`);
  const without = template.fields.filter((field) => field.key !== 'headline');
  const refused = await patchTemplate(f, template, { fields: without });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /“headline” is used by existing cards and cannot be removed/);
  assert.ok(keys((await templateById(f, template.id)).fields).includes('headline'));
  const emptied = await f.ok('PATCH', `/api/cards/${card.id}`, { revision: card.revision, fields: { headline: '' } });
  const removed = await saveTemplate(f, template, { fields: without });
  assert.deepEqual(keys(removed.fields), ['body', 'canonicalUrl', 'authorNotes']);
  // Observed: the stored value and its version row survive the removal. The key
  // is still in the card's fields although the template no longer has it.
  const hidden = await getCard(f, card.id);
  assert.ok(Object.hasOwn(hidden.fields, 'headline'));
  assert.equal(hidden.fields.headline, '');
  assert.equal(hidden.fieldVersions.headline, emptied.fieldVersions.headline);
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  assert.equal(db.prepare("SELECT json_extract(fields, '$.headline') AS value FROM cards WHERE id = ?").get(gone.id).value, 'Gone');
  db.close();
  assert.equal((await f.call('PATCH', `/api/cards/${card.id}`, { revision: hidden.revision, fields: { headline: 'Back' } })).status, 400, 'A removed field cannot be edited');
  const restored = await saveTemplate(f, removed, { fields: [{ key: 'headline', label: 'Headline' }, ...removed.fields] });
  assert.deepEqual(keys(restored.fields), ['headline', 'body', 'canonicalUrl', 'authorNotes']);
  const shown = await getCard(f, card.id);
  assert.equal(shown.fields.headline, '');
  assert.equal(shown.fieldVersions.headline, emptied.fieldVersions.headline, 'The kept version row is not reset to 1');
  assert.equal((await f.ok('PATCH', `/api/cards/${card.id}`, { revision: shown.revision, fields: { headline: 'Back' } })).fields.headline, 'Back');
});

test('a template is deleted only when no live card, project default or last-template rule needs it', async (t) => {
  const f = await fixture(t);
  const { projects } = await f.ok('GET', '/api/workspace');
  await f.ok('DELETE', `/api/projects/${projects[0].id}`);
  const last = await f.call('DELETE', '/api/templates/youtube-video');
  assert.equal(last.status, 409);
  assert.match(last.body.error, /at least one card template/);
  const template = await f.ok('POST', '/api/templates', blogPost);
  const blog = await createProject(f, 'Blog', template.id);
  const card = await createCard(f, blog.project, blog.stages[0].id, { fields: { headline: 'Kept' } });
  const inUse = await f.call('DELETE', '/api/templates/blog-post');
  assert.equal(inUse.status, 409);
  assert.match(inUse.body.error, /1 card uses this template/);
  const third = await createProject(f, 'Third project', template.id);
  await f.ok('DELETE', `/api/projects/${blog.project.id}`);
  const isDefault = await f.call('DELETE', '/api/templates/blog-post');
  assert.equal(isDefault.status, 409);
  assert.match(isDefault.body.error, /“Third project” uses this template for new cards/);
  await f.ok('PATCH', `/api/projects/${third.project.id}`, { templateId: 'youtube-video' });
  assert.deepEqual(await f.ok('DELETE', '/api/templates/blog-post'), { ok: true });
  assert.deepEqual((await templates(f)).map((entry) => entry.id), ['youtube-video']);
  assert.deepEqual((await f.ok('GET', '/api/workspace')).templates.map((entry) => entry.id), ['youtube-video']);
  assert.equal((await f.call('DELETE', '/api/templates/blog-post')).status, 404);
  assert.equal((await f.call('POST', '/api/projects', { name: 'Late', templateId: 'blog-post' })).status, 404);
  assert.ok((await f.ok('GET', '/api/events?since=0')).events.some((event) => event.entity === 'template' && event.type === 'deleted' && event.entityId === 'blog-post'));
  // The card in the deleted project keeps its template: retained reads still
  // resolve the deleted definition and its stored fields.
  const chat = await f.chat(card.id);
  assert.equal(chat.deleted, true);
  assert.deepEqual(chat.composer.selections.fields, ['title', 'headline', 'body', 'canonicalUrl']);
  assert.deepEqual(chat.composer.selections.roles, ['hero', 'thumbnail']);
  const { states } = await f.ok('GET', `/api/cards/${card.id}/states`);
  assert.equal(states.at(-1).snapshot.template, 'blog-post');
  assert.equal(states.at(-1).snapshot.fields.headline, 'Kept');
});

test('a project’s template is the default for its new cards, which can name another live template', async (t) => {
  const f = await fixture(t);
  const template = await f.ok('POST', '/api/templates', blogPost);
  const { project, stages } = await createProject(f, 'Second');
  assert.equal(project.templateId, 'youtube-video');
  const changed = await f.ok('PATCH', `/api/projects/${project.id}`, { templateId: template.id });
  assert.equal(changed.templateId, 'blog-post');
  assert.equal(changed.name, 'Second');
  const workspace = await f.ok('GET', '/api/workspace');
  assert.equal(workspace.projects.find((entry) => entry.id === project.id).templateId, 'blog-post');
  assert.equal(workspace.templates.find((entry) => entry.id === 'blog-post').projectCount, 1);
  const own = await createCard(f, project, stages[0].id);
  assert.equal(own.template, 'blog-post');
  assert.deepEqual(Object.keys(own.fields), ['headline', 'body', 'canonicalUrl', 'authorNotes']);
  assert.deepEqual(Object.keys(own.imageRoles), ['cover', 'hero', 'thumbnail']);
  const video = await createCard(f, project, stages[0].id, { template: 'youtube-video' });
  assert.equal(video.template, 'youtube-video');
  assert.ok('intro' in video.fields);
  const unknown = await f.call('POST', `/api/projects/${project.id}/cards`, { stageId: stages[0].id, template: 'nope' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /Unknown card template/);
  const missing = await f.call('POST', '/api/projects', { name: 'Bad', templateId: 'nope' });
  assert.equal(missing.status, 404);
  assert.equal((await f.call('PATCH', `/api/projects/${project.id}`, { templateId: 'nope' })).status, 404);
  // Changing the default never changes existing cards.
  await f.ok('PATCH', `/api/projects/${project.id}`, { templateId: 'youtube-video' });
  assert.equal((await getCard(f, own.id)).template, 'blog-post');
  assert.equal((await createCard(f, project, stages[0].id)).template, 'youtube-video');
});

test('a card chat with a custom template offers its roles and visible fields and labels images by role', async (t) => {
  const f = await fixture(t);
  const template = await f.ok('POST', '/api/templates', blogPost);
  const { project, stages } = await createProject(f, 'Blog', template.id);
  const images = [{ id: '00000001-0000-4000-8000-000000000000.png', name: 'Hero.png' }, { id: '00000002-0000-4000-8000-000000000000.png', name: 'Thumb.png' }];
  for (const [index, image] of images.entries()) await writeFile(path.join(f.dataDir, 'images', image.id), Buffer.from(`image-${index}`));
  const card = await createCard(f, project, stages[0].id, { title: 'Post', images, imageRoles: { hero: images[0].id, thumbnail: images[1].id, cover: images[0].id } });
  const { composer } = await f.chat(card.id);
  assert.deepEqual(composer.selections.roles, ['hero', 'thumbnail']);
  assert.deepEqual(composer.selections.fields, ['title', 'headline', 'body', 'canonicalUrl']);
  const narrowed = await f.compose(card.id, 'Describe the hero', 'test-model', { selections: { ...composer.selections, roles: ['hero'] } });
  assert.deepEqual(narrowed.selections.roles, ['hero']);
  const foreign = await f.call('PUT', `/api/cards/${card.id}/chat/composer`, { ...narrowed, selections: { ...narrowed.selections, roles: ['original'] } });
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.error, /Invalid image roles/);
  const hiddenField = await f.call('PUT', `/api/cards/${card.id}/chat/composer`, { ...narrowed, selections: { ...narrowed.selections, fields: ['title', 'authorNotes'] } });
  assert.equal(hiddenField.status, 400);
  const every = await f.compose(card.id, 'Describe every image', 'test-model', { selections: { ...composer.selections, roles: ['hero', 'thumbnail', 'cover'] } });
  await f.queue(card.id, every);
  const [submission] = (await f.chat(card.id)).submissions;
  const labels = Object.fromEntries(submission.context.images.map((image) => [image.id, image.labels]));
  assert.deepEqual(labels, { [images[0].id]: ['Hero', 'Display'], [images[1].id]: ['Thumbnail'] });
  assert.deepEqual(submission.context.fields.map((field) => field.key), ['title', 'headline', 'body', 'canonicalUrl']);
  const send = await waitFor(() => f.codex.sends[0]);
  assert.ok(send.input[0].text.includes('Hero, Display: Hero.png'));
  assert.ok(send.input[0].text.includes('Thumbnail: Thumb.png'));
});

test('a lane playbook sets, sends, applies and proposes a custom template’s fields and ignores unknown ones', async (t) => {
  const f = await fixture(t);
  const template = await f.ok('POST', '/api/templates', blogPost);
  const { project, stages } = await createProject(f, 'Blog', template.id);
  await setPlaybook(f.ok, project.flowId, stages[1], { set: { headline: 'From the lane' }, may_edit: ['body'], context: ['headline', 'hero'], model: 'test-model' }, 'Write the body.');
  const card = await createCard(f, project, stages[0].id, { title: 'Post' });
  const moved = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  assert.equal(moved.card.fields.headline, 'From the lane');
  assert.ok(moved.laneRunId);
  const send = await waitFor(() => f.codex.sends[0]);
  const text = send.input[0].text;
  assert.ok(text.includes('headline (Headline)'), 'Field keys name the template’s fields');
  assert.ok(text.includes('body (Body)'));
  assert.ok(!/\bintro\b/.test(text), 'Nothing from the built-in template leaks in');
  assert.ok(text.includes('Headline (field headline'));
  assert.ok(!text.includes('Body (field body'), 'context: limits the fields sent');
  assert.ok(text.includes('Card text-edit authority: body'));
  f.codex.finish(send, 'completed', result({ fields: { body: 'Done', headline: 'Changed', intro: 'nope' }, notes: 'n' }));
  const run = await waitFor(async () => (await runs(f, card.id)).find((entry) => entry.status === 'completed'));
  assert.deepEqual(run.result.applied, ['body']);
  assert.deepEqual(run.result.proposed, ['headline']);
  assert.deepEqual(run.result.errors, ['Ignored unknown field “intro”.']);
  assert.equal(run.result.notes, true);
  assert.match(run.reason, /Applied Body\. Proposed Headline for your review\./);
  const saved = await getCard(f, card.id);
  assert.equal(saved.fields.body, 'Done');
  assert.equal(saved.fields.headline, 'From the lane');
  assert.ok((await f.chat(card.id)).proposals.some((proposal) => proposal.kind === 'fields'));
});

test('playbook summaries and errors are checked against each project’s own template', async (t) => {
  const f = await fixture(t);
  const template = await f.ok('POST', '/api/templates', blogPost);
  const workspace = await f.ok('GET', '/api/workspace');
  const video = { project: workspace.projects[0], stages: workspace.flows.find((flow) => flow.id === workspace.projects[0].flowId).stages };
  const blog = await createProject(f, 'Blog', template.id);
  const settings = { run: 'manual', may_edit: ['headline'], set: { headline: 'Draft' } };
  await setPlaybook(f.ok, video.project.flowId, video.stages[1], settings, 'Edit the headline.');
  await setPlaybook(f.ok, blog.project.flowId, blog.stages[1], settings, 'Edit the headline.');
  const videoLane = (await f.ok('GET', `/api/flows/${video.project.flowId}/playbooks`)).stages[1].playbook;
  assert.deepEqual(videoLane.errors, ['may_edit: “headline” is not an editable card field.', 'set: “headline” is not a card field.']);
  assert.equal(videoLane.summary, 'Has errors');
  const blogLane = (await f.ok('GET', `/api/flows/${blog.project.flowId}/playbooks`)).stages[1].playbook;
  assert.deepEqual(blogLane.errors, []);
  assert.equal(blogLane.summary, 'Runs when you choose · Card chat provider · may edit Headline · sets Headline');
  const board = await f.ok('GET', '/api/workspace');
  assert.equal(board.flows.find((flow) => flow.id === blog.project.flowId).stages[1].playbook.summary, blogLane.summary);
  assert.equal(board.flows.find((flow) => flow.id === video.project.flowId).stages[1].playbook.summary, 'Has errors');
});

test('a database from before templates gains the built-in template and project defaults on upgrade', async (t) => {
  const f = await fixture(t);
  const card = await f.card({ title: 'Before templates', fields: { intro: 'Old' } });
  const { project: second, stages } = await createProject(f, 'Second');
  const other = await createCard(f, second, stages[0].id, { title: 'Also before' });
  await f.close();
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  db.exec('ALTER TABLE projects DROP COLUMN template_id; DROP TABLE card_templates;');
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(supportedSchemaVersion - 1));
  db.close();
  await f.restart();
  const workspace = await f.ok('GET', '/api/workspace');
  assert.deepEqual(workspace.templates.map((entry) => entry.id), ['youtube-video']);
  assert.equal(workspace.templates[0].builtin, true);
  assert.deepEqual(keys(workspace.templates[0].fields), keys(youtubeVideoTemplate.fields));
  assert.equal(workspace.projects.length, 2);
  for (const project of workspace.projects) assert.equal(project.templateId, 'youtube-video');
  assert.equal(workspace.templates[0].projectCount, 2);
  assert.equal(workspace.templates[0].cardCount, 2);
  const loaded = await getCard(f, card.id);
  assert.equal(loaded.template, 'youtube-video');
  assert.equal(loaded.fields.intro, 'Old');
  assert.deepEqual(Object.keys(loaded.fields).sort(), keys(youtubeVideoTemplate.fields).sort());
  const saved = await f.ok('PATCH', `/api/cards/${card.id}`, { revision: loaded.revision, fields: { intro: 'After upgrade' } });
  assert.equal(saved.fields.intro, 'After upgrade');
  const reloaded = await getCard(f, other.id);
  assert.equal(reloaded.title, 'Also before');
  const edited = await f.ok('PATCH', `/api/cards/${other.id}`, { changes: { script: 'Typed' }, baseVersions: { script: reloaded.fieldVersions.script }, editingSessionId: 'session-2' });
  assert.deepEqual(edited.conflicts, []);
  assert.equal(edited.fields.script, 'Typed');
  assert.equal((await createCard(f, second, stages[0].id)).template, 'youtube-video');
});

test('a new project’s map lists the card fields of its template', async (t) => {
  const f = await fixture(t);
  const template = await f.ok('POST', '/api/templates', blogPost);
  const { project } = await createProject(f, 'Blog', template.id);
  const { map } = await f.ok('GET', `/api/flows/${project.flowId}/playbooks`);
  assert.match(map.text, /^# Blog — project map/);
  const section = map.text.split('## Card fields')[1].split('## Rules')[0];
  assert.deepEqual(section.trim().split('\n'), ['- **Card title**: (what goes here)', '- **Headline**: (what goes here)', '- **Body**: (what goes here)', '- **Canonical URL**: (what goes here)']);
  assert.ok(!map.text.includes('Author notes'), 'Hidden fields are left out');
  const video = await createProject(f, 'Channel');
  const videoMap = (await f.ok('GET', `/api/flows/${video.project.flowId}/playbooks`)).map;
  assert.ok(videoMap.text.includes('- **Intro**: (what goes here)'));
  assert.ok(!videoMap.text.includes('**Prompt**'), 'The hidden prompt field is left out');
});

test('a saved composer whose selected field is later hidden still previews and sends, without that field', async (t) => {
  // A fresh fixture each test, so the built-in template needs no restoring.
  const f = await fixture(t);
  const card = await f.card({ title: 'Hidden later', fields: { intro: 'The hook' } });
  const { composer: initial } = await f.chat(card.id);
  const composer = await f.compose(card.id, 'Explain the hook', 'test-model', { selections: { ...initial.selections, fields: ['title', 'intro'] } });
  assert.deepEqual(composer.selections.fields, ['title', 'intro']);
  const video = await templateById(f, 'youtube-video');
  const hidden = await saveTemplate(f, video, { fields: video.fields.map((field) => (field.key === 'intro' ? { ...field, editor: false } : field)) });
  assert.equal(hidden.fields.find((field) => field.key === 'intro').editor, false);
  const preview = await f.call('POST', `/api/cards/${card.id}/chat/preview`, {});
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const previewed = preview.body.context.fields.map((field) => field.key);
  assert.ok(previewed.includes('title'));
  assert.ok(!previewed.includes('intro'), 'A hidden field is left out rather than failing the preview');
  const sent = await f.queue(card.id, composer);
  assert.equal(sent.status, 'queued');
  const [submission] = (await f.chat(card.id)).submissions;
  assert.equal(submission.id, sent.id);
  const frozen = submission.context.fields.map((field) => field.key);
  assert.ok(frozen.includes('title'));
  assert.ok(!frozen.includes('intro'), 'The frozen submission context has no hidden field');
  assert.ok(!JSON.stringify(submission.context).includes('The hook'), 'The hidden value is not sent');
});

test('adding an image role to a template leaves cards’ gallery version alone and fills the role on read', async (t) => {
  const f = await fixture(t);
  const template = await f.ok('POST', '/api/templates', { ...blogPost, imageRoles: [{ key: 'hero', label: 'Hero' }] });
  const { project, stages } = await createProject(f, 'Blog', template.id);
  const image = { id: '00000003-0000-4000-8000-000000000000.png', name: 'Hero.png' };
  await writeFile(path.join(f.dataDir, 'images', image.id), Buffer.from('hero'));
  const card = await createCard(f, project, stages[0].id, { title: 'Post', images: [image], imageRoles: { hero: image.id } });
  assert.deepEqual(Object.keys(card.imageRoles), ['cover', 'hero']);
  const updated = await saveTemplate(f, template, { imageRoles: [...template.imageRoles, { key: 'thumbnail', label: 'Thumbnail' }] });
  assert.deepEqual(keys(updated.imageRoles), ['hero', 'thumbnail']);
  const loaded = await getCard(f, card.id);
  assert.equal(loaded.fieldVersions.imageRoles, card.fieldVersions.imageRoles, 'Gaining a role is not a gallery edit');
  assert.equal(loaded.fieldVersions.images, card.fieldVersions.images);
  assert.equal(loaded.revision, card.revision);
  assert.equal(loaded.imageRoles.thumbnail, null, 'The new role is filled on read');
  assert.equal(loaded.imageRoles.hero, image.id);
  // A role edit based on the versions from before the template change still saves.
  const saved = await f.ok('PATCH', `/api/cards/${card.id}`, { changes: { imageRoles: { thumbnail: image.id } }, baseVersions: { imageRoles: card.fieldVersions.imageRoles, images: card.fieldVersions.images } });
  assert.deepEqual(saved.conflicts, []);
  assert.equal(saved.imageRoles.thumbnail, image.id);
  assert.equal(saved.imageRoles.hero, image.id, 'Other roles are kept');
  assert.ok(saved.fieldVersions.imageRoles > card.fieldVersions.imageRoles, 'The role edit itself bumps the gallery version');
});

test('creating a template refuses an empty role, reserved keys, names that read alike and a zero title limit', async (t) => {
  const f = await fixture(t);
  const field = (key, extra = {}) => ({ key, label: key, ...extra });
  const refused = [
    [{ ...blogPost, imageRoles: [''] }, /Image role 1: image roles need a label/],
    [{ ...blogPost, fields: [field('lane')] }, /the key “lane” is reserved/],
    [{ ...blogPost, fields: [field('image')] }, /the key “image” is reserved/],
    [{ ...blogPost, fields: [{ key: 'intro', label: 'Hook' }, { key: 'hook', label: 'Intro' }] }, /The field “Intro” reads the same as the field “Hook” in playbook settings/],
    [{ ...blogPost, imageRoles: [{ key: 'thumb', label: 'Display' }] }, /The image role “Display” reads the same as the display image in playbook settings/],
    [{ ...blogPost, title: { label: 'Card title', max: 0 } }, 'The title limit must be between 1 and 10,000 characters.'],
  ];
  for (const [input, message] of refused) {
    const response = await f.call('POST', '/api/templates', input);
    assert.equal(response.status, 400, JSON.stringify(input).slice(0, 120));
    if (typeof message === 'string') assert.equal(response.body.error, message); else assert.match(response.body.error, message);
  }
  assert.deepEqual((await templates(f)).map((template) => template.id), ['youtube-video'], 'Refused templates are not created');
});
