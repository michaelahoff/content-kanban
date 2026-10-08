import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';
import { parseDocument, playbookSettings, serializeDocument, parseLaneResult, composeLanePrompt } from '../public/playbook-format.js';
import { createPlaybooks } from '../playbooks.js';
import { referencePath } from '../public/chat-context.js';

const lanes = async (f) => { const workspace = await f.ok('GET', '/api/workspace'); return { flowId: workspace.projects[0].flowId, stages: workspace.flows[0].stages }; };
const runs = async (f, cardId) => (await f.ok('GET', `/api/cards/${cardId}/lane-runs`)).runs;
const result = (value) => `Done.\n\n\`\`\`frameboard-result\n${JSON.stringify(value, null, 2)}\n\`\`\``;

for (const context of [null, ['title', 'intro']]) test(`lane runs attach every card photo, including unassigned portraits and backgrounds, with ${context ? 'text-only' : 'default'} context`, async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  const images = [
    { id: '00000001-0000-4000-8000-000000000000.png', name: 'Original.png' },
    { id: '00000002-0000-4000-8000-000000000000.png', name: 'Portrait.png' },
    { id: '00000003-0000-4000-8000-000000000000.png', name: 'Studio.png' },
    { id: '00000004-0000-4000-8000-000000000000.png', name: 'Inspiration.png' },
  ];
  for (const [index, image] of images.entries()) await writeFile(path.join(f.dataDir, 'images', image.id), Buffer.from(`image-${index}`));
  await setPlaybook(f.ok, flowId, stages[1], { model: 'test-model', ...(context ? { context } : {}) }, 'Use the portrait and studio photos to make thumbnails.');
  const card = await f.card({ images, imageRoles: { original: images[0].id, inspiration: images[3].id, cover: images[0].id } });
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  const send = await waitFor(() => f.codex.sends[0]);
  const submission = (await f.chat(card.id)).submissions[0];
  assert.deepEqual(new Set(submission.context.images.map((image) => image.id)), new Set(images.map((image) => image.id)));
  assert.equal(send.input.filter((entry) => entry.type === 'localImage').length, 4);
  for (const [index, image] of images.entries()) {
    const frozen = submission.context.images.find((entry) => entry.id === image.id);
    assert.ok(send.input[0].text.includes(image.name));
    assert.deepEqual(await readFile(path.join(f.dataDir, 'workspaces', card.id, referencePath(frozen))), Buffer.from(`image-${index}`));
  }
  assert.deepEqual(submission.context.images.find((image) => image.id === images[0].id).labels, ['Original', 'Display', 'Attachment']);
  if (context) assert.ok(!send.input[0].text.includes('Script (field script'), 'Text context still limits card fields');
  const lanePreview = await f.ok('GET', `/api/cards/${card.id}/lane-runs/preview`);
  assert.deepEqual(lanePreview.images, submission.context.images);
  for (const image of images) assert.ok(lanePreview.prompt.includes(image.name), 'The prompt preview lists each attached photo');
});

test('playbooks accept comments and empty settings and preserve quoted separators', () => {
  const settings = playbookSettings(parseDocument('---\nrun: manual # Start on request\nmodel: test-model # Default\nmay_edit: [intro] # Allowed\nset:\n  title: "Episode #3, part 2" # Keep the quoted hash\n---\nDo the work.'), 'youtube-video');
  assert.deepEqual(settings.errors, []);
  assert.equal(settings.run, 'manual');
  assert.equal(settings.model, 'test-model');
  assert.equal(settings.set.title, 'Episode #3, part 2');
  assert.deepEqual(parseDocument('---\n---\nInstructions.'), { data: {}, body: 'Instructions.', errors: [] });
  const horizontalRule = '---\nA paragraph.\n---\nAnother paragraph.';
  assert.equal(parseDocument(horizontalRule).body, horizontalRule);
  const values = { set: { title: 'One\u2028Two', intro: 'First\u2029Second' }, context: ['Title, with comma', 'intro'] };
  assert.deepEqual(parseDocument(serializeDocument(values, '')).data, values);
});

test('result blocks accept Windows newlines and Markdown fences inside a field', () => {
  const value = { fields: { script: 'Example:\n```js\nconsole.log("ok");\n```\nEnd.' }, notes: 'Hand-off' };
  const parsed = parseLaneResult(result(value).replaceAll('\n', '\r\n'), 'youtube-video');
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.fields, value.fields);
});

test('a late result and native edits become proposals after leaving and returning to the lane', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[0], { run: 'manual', model: 'test-model', may_edit: ['intro'] }, 'Write an intro.');
  const card = await f.card();
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[0].id });
  assert.equal((await f.codex.tool(send, 'edit_fields', { fields: { intro: 'Native edit' }, baseVersions: card.fieldVersions })).success, true);
  f.codex.finish(send, 'completed', result({ fields: { intro: 'Late result' }, notes: 'Older run finished.' }));
  const completed = await waitFor(async () => (await runs(f, card.id)).find((run) => run.status === 'completed'));
  assert.deepEqual(completed.result.applied, []);
  assert.deepEqual(completed.result.proposed, ['intro']);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, '');
  assert.equal((await f.chat(card.id)).proposals.filter((proposal) => proposal.kind === 'fields').length, 2);
});

test('a result failure rolls back its field edits and ends the run', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[0], { run: 'manual', model: 'test-model', may_edit: ['intro'] }, 'Write an intro and propose a move.');
  const card = await f.card();
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  db.exec("CREATE TRIGGER reject_proposal BEFORE INSERT ON card_proposals BEGIN SELECT RAISE(FAIL, 'Proposal storage failed'); END;");
  db.close();
  f.codex.finish(send, 'completed', result({ fields: { intro: 'Must roll back' }, move: stages[1].name, notes: 'Must not be appended' }));
  const failed = await waitFor(async () => (await runs(f, card.id)).find((run) => run.status === 'failed'));
  assert.match(failed.reason, /Proposal storage failed/);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, '');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}/notes`)).text, '');
});

test('Stop prevents even a notes-only late result, and an explicit retry can finish the lane run', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[0], { run: 'manual', model: 'test-model', may_edit: ['intro'] }, 'Write an intro.');
  const card = await f.card();
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  f.codex.autoInterrupt = false;
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  f.codex.finish(send, 'completed', result({ notes: 'Do not save this stopped reply.' }));
  const failed = await waitFor(async () => (await runs(f, card.id)).find((run) => run.status === 'failed'));
  assert.match(failed.reason, /no longer has card-tool authority/);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}/notes`)).text, '');
  await f.ok('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: failed.submissionId });
  const retried = await waitFor(() => f.codex.sends[1]);
  f.codex.finish(retried, 'completed', result({ fields: { intro: 'Retried successfully' }, notes: 'New attempt.' }));
  await waitFor(async () => (await runs(f, card.id))[0]?.status === 'completed');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, 'Retried successfully');
});

test('a stopped attempt finishing late cannot fail its running retry', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[0], { run: 'manual', model: 'test-model', may_edit: ['intro'] }, 'Write an intro.');
  const card = await f.card();
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const stopped = await waitFor(() => f.codex.sends[0]);
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  const failed = await waitFor(async () => (await runs(f, card.id)).find((run) => run.status === 'failed'));
  await f.ok('POST', `/api/cards/${card.id}/chat/retry`, { submissionId: failed.submissionId });
  const retried = await waitFor(() => f.codex.sends[1]);
  f.codex.finish(stopped, 'completed', result({ fields: { intro: 'Old intro' }, notes: 'Old attempt.' }));
  assert.equal((await runs(f, card.id))[0].status, 'queued');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}/notes`)).text, '');
  f.codex.finish(retried, 'completed', result({ fields: { intro: 'Current intro' }, notes: 'Current attempt.' }));
  await waitFor(async () => (await runs(f, card.id))[0]?.status === 'completed');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, 'Current intro');
  assert.match((await f.ok('GET', `/api/cards/${card.id}/notes`)).text, /Current attempt\./);
});

for (const mode of ['off', 'manual']) test(`changing a waiting automatic playbook to ${mode} cancels it before submission`, async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[1], { conversation: 'fresh', model: 'test-model' }, 'Start over.');
  const card = await f.card();
  await f.queue(card.id, await f.compose(card.id));
  const manual = await waitFor(() => f.codex.sends[0]);
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  await waitFor(async () => (await runs(f, card.id))[0]?.reason.includes('Waiting for the card chat'));
  await setPlaybook(f.ok, flowId, stages[1], { run: mode, conversation: 'fresh', model: 'test-model' }, 'Start over.');
  f.codex.finish(manual);
  await waitFor(async () => (await runs(f, card.id))[0]?.status !== 'pending');
  assert.equal((await runs(f, card.id))[0].status, 'cancelled');
  assert.equal((await f.chat(card.id)).submissions.length, 1);
  assert.equal(f.codex.sends.length, 1);
});

test('moving while provider discovery is pending cancels the run before any submission exists', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[1], { model: 'test-model' }, 'Write an intro.');
  const card = await f.card();
  const discover = f.codex.discover.bind(f.codex);
  let entered = false; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.codex.discover = async (...args) => { entered = true; await gate; return discover(...args); };
  t.after(release);
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  await waitFor(() => entered);
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[2].id });
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await runs(f, card.id))[0].status, 'cancelled');
  assert.deepEqual((await f.chat(card.id)).submissions, []);
  assert.deepEqual(f.codex.sends, []);
});

test('hand-off notes retain the latest entries within the editable size limit', async (t) => {
  const f = await fixture(t);
  const card = await f.card();
  const playbooks = createPlaybooks({ dataDir: f.dataDir });
  await mkdir(path.dirname(playbooks.notesPath(card.id)), { recursive: true });
  const base = playbooks.notes(card.id);
  playbooks.writeNotes(card.id, 'x'.repeat(199900), base.hash);
  const appended = playbooks.appendNotes(card.id, 'Latest run', 'y'.repeat(500));
  assert.equal(appended.text.length, 200000);
  assert.match(appended.text, /earlier hand-off notes omitted/);
  assert.ok(appended.text.endsWith('y'.repeat(500) + '\n'));
  assert.equal(playbooks.writeNotes(card.id, appended.text, appended.hash).hash, appended.hash);
});

test('recovery keeps the reply but ends the lane run with an explicit unapplied result', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[0], { run: 'manual', model: 'test-model', may_edit: ['intro'] }, 'Write an intro.');
  const card = await f.card();
  f.codex.ackGate = new Promise(() => {});
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  const turn = f.codex.threads.get(send.threadId).turns[0];
  turn.status = 'completed';
  turn.items.push({ type: 'agentMessage', id: 'recovered-result', text: result({ fields: { intro: 'Recovered intro' }, notes: 'Unapplied notes.' }) });
  f.codex.ackGate = null;
  await f.restart();
  const failed = await waitFor(async () => (await runs(f, card.id))[0]?.status === 'failed' && (await runs(f, card.id))[0]);
  assert.match(failed.reason, /recovered.*result was not applied/);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, '');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}/notes`)).text, '');
  assert.ok((await f.chat(card.id)).items.some((item) => item.text.includes('Recovered intro')));
  assert.equal(f.codex.sends.length, 1);
});

test('frontmatter settings parse field names loosely and report problems without guessing', () => {
  const document = parseDocument(`---
lane: abc
run: manual
provider: Claude
context: [Title, Title Options, original, display]
may_edit:
  - title_options
  - intro
set:
  prompt: |
    Two lines
    of prompt
  title: "Colon: kept"
skills: [voice]
---
# Titling
Use skills/hooks.md too.
`);
  assert.deepEqual(document.errors, []);
  const settings = playbookSettings(document, 'youtube-video');
  assert.equal(settings.run, 'manual');
  assert.equal(settings.provider, 'claude');
  assert.deepEqual(settings.selections, { fields: ['title', 'titleOptions'], roles: ['original', 'cover'] });
  assert.deepEqual(settings.mayEdit, ['titleOptions', 'intro']);
  assert.deepEqual(settings.set, { prompt: 'Two lines\nof prompt\n', title: 'Colon: kept' });
  assert.deepEqual(settings.skills, ['voice', 'hooks']);
  assert.equal(settings.instructions, '# Titling\nUse skills/hooks.md too.');
  const roundTrip = playbookSettings(parseDocument(serializeDocument(document.data, document.body)), 'youtube-video');
  assert.deepEqual({ ...roundTrip, instructions: '' }, { ...settings, instructions: '' });

  const bad = playbookSettings(parseDocument('---\nrun: sometimes\nmay_edit: [nonsense]\nset:\n  missing: x\ncolour: red\n---\nBody'), 'youtube-video');
  assert.equal(bad.errors.length, 3);
  assert.deepEqual(bad.warnings, ['Unknown setting “colour” is ignored.']);
  assert.match(parseDocument('---\nrun: on-enter\nBody without a closing line').errors[0], /Close the settings block/);
  assert.deepEqual(parseDocument('Just Markdown').data, {});
});

test('lane results read the last block and ignore what they cannot apply', () => {
  assert.equal(parseLaneResult('No block here', 'youtube-video'), null);
  const parsed = parseLaneResult(`${result({ fields: { title: 'Old' } })}\n${result({ fields: { 'Title Options': 'A\nB', unknown: 'x', intro: 5 }, notes: 'Next: intro', move: 'Review' })}`, 'youtube-video');
  assert.deepEqual(parsed.fields, { titleOptions: 'A\nB' });
  assert.equal(parsed.notes, 'Next: intro');
  assert.equal(parsed.move, 'Review');
  assert.equal(parsed.errors.length, 2);
  assert.match(parseLaneResult('```frameboard-result\n{oops}\n```', 'youtube-video').errors[0], /not valid JSON/);
  const settings = playbookSettings(parseDocument('---\nmay_edit: [intro]\n---\nWrite the hook.'), 'youtube-video');
  const prompt = composeLanePrompt({ projectName: 'Channel', laneName: 'Intro', lanes: [{ name: 'Ideas' }, { name: 'Intro' }],
    map: { path: 'MAP.md', text: 'The map' }, playbook: { path: 'lanes/intro.md' }, skills: [{ name: 'voice', path: 'skills/voice.md', text: 'Be warm.' }, { name: 'gone', text: null }],
    notes: 'Earlier notes', settings, templateId: 'youtube-video' });
  for (const part of ['The map', 'Write the hook.', 'Be warm.', 'skills/gone.md does not exist yet', 'Earlier notes', 'applies Intro directly', 'Lanes: Ideas, Intro']) assert.ok(prompt.includes(part), part);
});

test('playbook files are created per flow, saved with hash checks and summarized for the board', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  const listed = await f.ok('GET', `/api/flows/${flowId}/playbooks`);
  assert.match(listed.map.text, /My project — project map/);
  assert.match(listed.map.text, /\*\*In progress\*\*/);
  assert.equal(listed.folder, path.join(f.dataDir, 'flows', flowId));
  assert.deepEqual(listed.lanes, []);
  const text = serializeDocument({ lane: stages[1].id, run: 'manual', may_edit: ['intro'] }, 'Write an intro.');
  const created = await f.ok('PUT', `/api/flows/${flowId}/playbooks`, { path: 'lanes/drafting.md', text, baseHash: null });
  assert.equal(created.document.text, text);
  assert.equal(await readFile(path.join(f.dataDir, 'flows', flowId, 'lanes', 'drafting.md'), 'utf8'), text);
  assert.equal(created.stages[1].playbook.summary, 'Runs when you choose · Card chat provider · may edit Intro');
  assert.equal((await f.ok('GET', '/api/workspace')).flows[0].stages[1].playbook.path, 'lanes/drafting.md');
  // Another editor changed the file: the stale save is refused, nothing lost.
  await writeFile(path.join(f.dataDir, 'flows', flowId, 'lanes', 'drafting.md'), `${text}\nEdited in VS Code.`);
  const stale = await f.call('PUT', `/api/flows/${flowId}/playbooks`, { path: 'lanes/drafting.md', text: 'Mine', baseHash: created.document.hash });
  assert.equal(stale.status, 409);
  assert.match(await readFile(path.join(f.dataDir, 'flows', flowId, 'lanes', 'drafting.md'), 'utf8'), /Edited in VS Code/);
  assert.equal((await f.call('PUT', `/api/flows/${flowId}/playbooks`, { path: 'lanes/drafting.md', text: 'x', baseHash: null })).status, 409);
  assert.equal((await f.call('PUT', `/api/flows/${flowId}/playbooks`, { path: 'lanes/other.md', text: serializeDocument({ lane: stages[1].id }, ''), baseHash: null })).status, 409, 'One playbook per lane');
  assert.equal((await f.call('PUT', `/api/flows/${flowId}/playbooks`, { path: 'lanes/foreign.md', text: serializeDocument({ lane: 'not-a-lane' }, ''), baseHash: null })).status, 400);
  for (const bad of ['../escape.md', 'lanes/../../x.md', 'notes.md', 'skills/.hidden.md', 'lanes/a/b.md']) {
    assert.equal((await f.call('PUT', `/api/flows/${flowId}/playbooks`, { path: bad, text: 'x', baseHash: null })).status, 400, bad);
  }
  const skill = await f.ok('PUT', `/api/flows/${flowId}/playbooks`, { path: 'skills/voice.md', text: '# Voice', baseHash: null });
  assert.equal((await f.ok('GET', `/api/flows/${flowId}/playbooks`)).skills[0].path, 'skills/voice.md');
  await f.ok('DELETE', `/api/flows/${flowId}/playbooks`, { path: 'skills/voice.md', baseHash: skill.document.hash });
  assert.deepEqual((await f.ok('GET', `/api/flows/${flowId}/playbooks`)).skills, []);
  assert.equal((await f.call('DELETE', `/api/flows/${flowId}/playbooks`, { path: 'MAP.md', baseHash: listed.map.hash })).status, 400);
  assert.equal((await f.call('GET', '/api/flows/unknown/playbooks')).status, 404);
});

test('set: values apply on creation and entry; a playbook with errors applies nothing', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[1], { run: 'off', set: { prompt: 'Lane prompt', title: 'Lane title' } });
  const card = await f.card({ fields: { script: 'Keep' } });
  const moved = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  assert.equal(moved.card.title, 'Lane title');
  assert.equal(moved.card.fields.prompt, 'Lane prompt');
  assert.equal(moved.card.fields.script, 'Keep');
  assert.deepEqual(moved.fieldUpdate, { beforeRevision: 1, revision: 2, values: { prompt: 'Lane prompt', title: 'Lane title' } });
  assert.equal(moved.laneRunId, null, 'run: off sets values but starts no agent');
  const history = (await f.ok('GET', `/api/cards/${card.id}`)).events;
  assert.equal(history.at(-1).type, 'fields_set');
  assert.match(history.at(-1).data.playbook, /^lanes\//);
  const created = await f.card({ stageId: stages[1].id });
  assert.equal(created.fields.prompt, 'Lane prompt');
  await setPlaybook(f.ok, flowId, stages[2], { set: { prompt: 'Never' }, may_edit: ['nonsense'] });
  const broken = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[2].id });
  assert.equal(broken.card.fields.prompt, 'Lane prompt');
  assert.equal(broken.fieldUpdate, null);
});

test('retired command graphs become set: values in a lane playbook once', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  const graph = { version: 1, nodes: [{ id: 'entry', type: 'entry', position: { x: 0, y: 0 } },
    { id: 'b', type: 'set', position: { x: 0, y: 0 }, config: { assignments: [{ field: 'title', value: 'Final' }, { field: 'intro', value: 'Line one\nLine two' }] } },
    { id: 'a', type: 'set', position: { x: 0, y: 0 }, config: { field: 'title', value: 'First' } }],
  edges: [{ id: 'e1', from: 'entry', to: 'a' }, { id: 'e2', from: 'a', to: 'b' }] };
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  db.prepare('UPDATE stages SET entry_graph = ? WHERE id = ?').run(JSON.stringify(graph), stages[2].id);
  db.close();
  await f.restart();
  const { lanes: documents } = await f.ok('GET', `/api/flows/${flowId}/playbooks`);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].path, 'lanes/review.md');
  const settings = playbookSettings(parseDocument(documents[0].text), 'youtube-video');
  assert.deepEqual(settings.set, { title: 'Final', intro: 'Line one\nLine two' });
  assert.equal(settings.run, 'off');
  const card = await f.card({ stageId: stages[2].id });
  assert.equal(card.title, 'Final');
  await f.restart();
  assert.equal((await f.ok('GET', `/api/flows/${flowId}/playbooks`)).lanes.length, 1, 'The migration does not repeat');
});

test('entering a lane runs its playbook: map, skills and notes go in; fields, proposals, a move and notes come out', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  const map = (await f.ok('GET', `/api/flows/${flowId}/playbooks`)).map;
  await f.ok('PUT', `/api/flows/${flowId}/playbooks`, { path: 'MAP.md', text: '# Channel map\nWe make explainers.', baseHash: map.hash });
  await f.ok('PUT', `/api/flows/${flowId}/playbooks`, { path: 'skills/titling.md', text: 'Titles under 60 characters.', baseHash: null });
  await setPlaybook(f.ok, flowId, stages[1], { model: 'test-model', may_edit: ['titleOptions'], context: ['title', 'intro'] },
    'Brainstorm ten titles. Follow skills/titling.md. Propose a move to Review.');
  const card = await f.card({ title: 'Black holes', fields: { intro: 'Old intro' } });
  const notes = await f.ok('GET', `/api/cards/${card.id}/notes`);
  await f.ok('PUT', `/api/cards/${card.id}/notes`, { text: '## Ideas\n\nAngle: the sound of black holes.', baseHash: notes.hash });
  const moved = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  assert.ok(moved.laneRunId);
  const send = await waitFor(() => f.codex.sends[0]);
  const prompt = send.input[0].text;
  for (const part of ['We make explainers.', 'Brainstorm ten titles.', 'Titles under 60 characters.', 'the sound of black holes', 'frameboard-result', 'Card text-edit authority: titleOptions']) assert.ok(prompt.includes(part), part);
  assert.ok(!prompt.includes('Script (field script'), 'context: limits the card fields sent');
  const queued = (await f.chat(card.id)).submissions[0];
  assert.equal(queued.lane.runId, moved.laneRunId);
  assert.equal(queued.lane.playbook.path, 'lanes/in-progress.md');
  assert.equal((await f.chat(card.id)).composer.prompt, '', 'The composer is untouched');
  f.codex.finish(send, 'completed', result({ fields: { titleOptions: 'One\nTwo', intro: 'New intro', title: 'Black holes' }, notes: 'Picked a sound angle.', move: 'review' }));
  const run = await waitFor(async () => (await runs(f, card.id)).find((entry) => entry.status === 'completed'));
  assert.deepEqual(run.result.applied, ['titleOptions']);
  assert.deepEqual(run.result.proposed, ['intro']);
  assert.equal(run.result.move, 'Review');
  const saved = (await f.ok('GET', `/api/cards/${card.id}`)).card;
  assert.equal(saved.fields.titleOptions, 'One\nTwo');
  assert.equal(saved.fields.intro, 'Old intro');
  const chat = await f.chat(card.id);
  assert.deepEqual(chat.proposals.map((proposal) => proposal.kind).sort(), ['fields', 'move']);
  assert.match(chat.items.find((item) => item.nativeId === 'lane-result').text, /Applied Title Options\. Proposed Intro for your review\. Proposed moving to Review\. Added hand-off notes\./);
  const after = await f.ok('GET', `/api/cards/${card.id}/notes`);
  assert.match(after.text, /^## Ideas\n\nAngle: the sound of black holes\.\n\n## In progress · .* UTC\n\nPicked a sound angle\.\n$/);
  assert.equal(await readFile(path.join(f.dataDir, 'workspaces', card.id, 'notes.md'), 'utf8'), after.text);
});

test('a reply without a result block applies nothing and says so', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[1], { model: 'test-model', may_edit: ['intro'] }, 'Write an intro.');
  const card = await f.card();
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  f.codex.finish(await waitFor(() => f.codex.sends[0]), 'completed', 'I forgot the block.');
  const run = await waitFor(async () => (await runs(f, card.id)).find((entry) => entry.status === 'completed'));
  assert.match(run.reason, /no frameboard-result block/);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, '');
});

test('leaving the lane or undoing the move cancels a run that has not started', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[1], { model: 'test-model' }, 'Do the work.');
  const card = await f.card();
  // A manual prompt keeps the card chat busy, so the lane run waits in line.
  await f.queue(card.id, await f.compose(card.id));
  const manual = await waitFor(() => f.codex.sends[0]);
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  await waitFor(async () => (await runs(f, card.id))[0]?.status === 'queued');
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[2].id });
  const [cancelled] = await runs(f, card.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.reason, /moved to Review/);
  assert.equal(cancelled.submissionStatus, 'cancelled');

  const back = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  await waitFor(async () => (await runs(f, card.id))[0]?.status === 'queued');
  await f.ok('POST', `/api/cards/${card.id}/undo-move`, { moveId: back.card.lastMove.id, revision: back.card.revision });
  assert.equal((await runs(f, card.id))[0].status, 'cancelled');
  f.codex.finish(manual);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.codex.sends.length, 1, 'Cancelled lane runs never reach the provider');
});

test('manual playbooks run on request, preview their prompt and refuse while off', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[0], { run: 'manual', model: 'test-model' }, 'Research this idea.');
  const card = await f.card();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(await runs(f, card.id), [], 'Creating a card never starts an agent');
  const preview = await f.ok('GET', `/api/cards/${card.id}/lane-runs/preview`);
  assert.match(preview.prompt, /Research this idea\./);
  assert.match(preview.prompt, /asked you to run the “Ideas” lane playbook/);
  assert.equal(preview.model, 'test-model');
  const requested = await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  assert.equal((await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {})).id, requested.id, 'A double click does not queue twice');
  const send = await waitFor(() => f.codex.sends[0]);
  assert.match(send.input[0].text, /Research this idea\./);
  await setPlaybook(f.ok, flowId, stages[0], { run: 'off' }, 'Research this idea.');
  assert.equal((await f.call('POST', `/api/cards/${card.id}/lane-runs`, {})).status, 409);
  assert.equal((await f.call('POST', `/api/cards/${(await f.card({ stageId: stages[3].id })).id}/lane-runs`, {})).status, 409, 'A lane without a playbook');
});

test('a lane run picks the provider default model, and conversation: fresh waits for an idle chat', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[1], { conversation: 'fresh' }, 'Start over.');
  const card = await f.card();
  await f.queue(card.id, await f.compose(card.id));
  const manual = await waitFor(() => f.codex.sends[0]);
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  const waiting = await waitFor(async () => (await runs(f, card.id))[0]?.reason.includes('Waiting for the card chat') && (await runs(f, card.id))[0]);
  assert.equal(waiting.status, 'pending');
  f.codex.finish(manual);
  const lane = await waitFor(() => f.codex.sends[1]);
  assert.equal(lane.model, 'test-model');
  const chat = await f.chat(card.id);
  assert.equal(chat.conversations.length, 2);
  assert.equal(chat.submissions.at(-1).conversationId, chat.conversations.at(-1).id);
});

test('a playbook with errors records a failed run instead of guessing', async (t) => {
  const f = await fixture(t);
  const { flowId, stages } = await lanes(f);
  await setPlaybook(f.ok, flowId, stages[1], { model: 'test-model', may_edit: ['everything'] }, 'Do things.');
  const card = await f.card();
  const moved = await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[1].id });
  const [run] = await runs(f, card.id);
  assert.equal(run.id, moved.laneRunId);
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /may_edit: “everything”/);
  await setPlaybook(f.ok, flowId, stages[2], { model: 'missing-model' }, 'Do things.');
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: stages[2].id });
  const failed = await waitFor(async () => (await runs(f, card.id)).find((entry) => entry.stageId === stages[2].id && entry.status === 'failed'));
  assert.match(failed.reason, /missing-model is not available/);
});
