import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { createApp } from '../server.js';
import { laneColors } from '../store.js';
import { ControlledCodex } from './support/controlled-codex.js';
import { installFlow, checkFlow, readFlow, main, laneColors as installerColors } from '../scripts/demo-flows.mjs';

// A valid 1x1 PNG.
function pixel() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}
const png = pixel();
const thumbnail = Buffer.from([255, 216, 255, 224, 0, 16]);
// Stand-ins for YouTube so the test runs offline.
const fakeYoutube = async (url) => (url.startsWith('https://www.youtube.com/oembed')
  ? new Response(JSON.stringify({ title: 'A borrowed idea' }))
  : new Response(thumbnail));
const captions = `  ${'word '.repeat(30)}`;

const clip = {
  id: 'clip', name: 'Clip', title: { label: 'Clip title', max: 200 },
  fields: [
    { key: 'sourceUrl', label: 'Source URL', control: 'url', youtube: true },
    { key: 'originalVideoTitle', label: 'Original video title', control: 'text', max: 500 },
    { key: 'transcript', label: 'Transcript', control: 'textarea', max: 40, transcript: true },
    { key: 'summary', label: 'Summary', control: 'textarea', max: 5000 },
  ],
  imageRoles: [{ key: 'original', label: 'Original' }, { key: 'draft', label: 'Draft' }],
};
const manifest = () => ({
  project: 'Demo clips',
  flow: { name: 'Main', kind: 'graph' },
  templates: [clip],
  template: 'clip',
  map: 'MAP.md',
  skills: ['skills/voice.md'],
  nodes: [
    { name: 'Inbox', color: 'lavender', x: 0, y: 40, playbook: 'lanes/inbox.md' },
    { name: 'Draft', color: 'blue', x: 380, y: 40, playbook: 'lanes/draft.md' },
    { name: 'Review', color: 'amber', x: 760, y: 40, playbook: 'lanes/review.md' },
  ],
  cards: [
    { node: 'Inbox', title: 'Hello clip', fields: { summary: 'Short.' }, images: [{ file: 'assets/pixel.png', roles: ['original'] }] },
    { node: 'Inbox', fields: { sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, youtube: 'sourceUrl' },
    { node: 'Review', title: 'Built-in template', template: 'youtube-video', fields: { intro: 'An intro.' } },
  ],
});
const files = {
  'MAP.md': '# Demo clips\n\nA tiny flow: Inbox, Draft, Review.\n',
  'skills/voice.md': '# Voice\n\nWrite plainly.\n',
  'lanes/inbox.md': '---\nrun: off\nroutes:\n  next: Draft\n---\n# Inbox\n\nNew clips arrive here.\n',
  'lanes/draft.md': '---\nrun: on-enter\nprovider: claude\nskills: [voice]\nroutes:\n  ready: review\ncreates:\n  lane: Inbox\n  template: youtube-video\n---\n# Draft\n\nWrite the post.\n',
  // A stale lane setting is replaced by the lane's real ID.
  'lanes/review.md': '---\nlane: stale-id\nrun: manual\nroutes:\n  revise: Draft\n---\n# Review\n\nCheck the draft.\n',
  'assets/pixel.png': png,
};

async function writeFlow(dir, value = manifest(), documents = files) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'flow.json'), JSON.stringify(value, null, 2));
  for (const [name, content] of Object.entries(documents)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}
async function folder(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameboard-demo-flows-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function server(t) {
  const dataDir = await folder(t);
  const app = await createApp({ dataDir, fetch: fakeYoutube, transcript: async () => ({ text: captions }), codexAdapter: new ControlledCodex(dataDir) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => (app.listening ? app.close(resolve) : resolve())));
  const base = `http://127.0.0.1:${app.address().port}`;
  const get = async (route) => { const response = await fetch(`${base}${route}`); assert.equal(response.status, 200, route); return response.json(); };
  return { base, get, workspace: () => get('/api/workspace') };
}
// A server with the sample flow installed.
async function installed(t, options = {}) {
  const s = await server(t);
  const dir = await writeFlow(path.join(await folder(t), 'sample'));
  const lines = [];
  const result = await installFlow(s.base, dir, { ...options, log: (line) => lines.push(line) });
  const stage = (name) => result.stages.find((item) => item.name === name);
  return { ...s, dir, result, lines, stage };
}

test('the nodes are created in order with their colors and positions, and the starter nodes are gone', async (t) => {
  const { workspace, result, lines } = await installed(t);
  assert.deepEqual(result.problems, []);
  const flow = (await workspace()).flows.find((item) => item.id === result.flow.id);
  assert.equal(flow.kind, 'graph'); assert.equal(flow.templateId, 'clip');
  assert.deepEqual(flow.stages.map((stage) => [stage.name, stage.color, stage.x, stage.y]),
    [['Inbox', 'lavender', 0, 40], ['Draft', 'blue', 380, 40], ['Review', 'amber', 760, 40]]);
  assert.ok(!flow.stages.some((stage) => ['Ideas', 'Done'].includes(stage.name)), 'the starter nodes were removed');
  assert.equal((await workspace()).projects.filter((project) => project.name === 'Demo clips').length, 1);
  assert.ok(lines.length >= 10 && lines.every((line) => line.startsWith('sample: ')), 'one line per step');
  assert.ok((await workspace()).templates.some((template) => template.id === 'clip'), 'the template was created');
});

test('routes name nodes and resolve, creates and the lane setting are written, and the server finds no problem', async (t) => {
  const { get, result, stage } = await installed(t);
  const routes = (name) => stage(name).playbook.routes.map((route) => [route.name, route.target, route.laneId]);
  assert.deepEqual(routes('Inbox'), [['next', 'Draft', stage('Draft').id]]);
  assert.deepEqual(routes('Draft'), [['ready', 'review', stage('Review').id]], 'a route is left as written and resolves by name, whatever the case');
  assert.deepEqual(routes('Review'), [['revise', 'Draft', stage('Draft').id]], 'routes resolve to the new nodes, not the starter nodes of the same name');
  for (const name of ['Inbox', 'Draft', 'Review']) assert.deepEqual(stage(name).playbook.errors, []);
  assert.equal(stage('Draft').playbook.run, 'on-enter'); assert.equal(stage('Draft').playbook.provider, 'claude');
  const draft = (await get(`/api/flows/${result.flow.id}/playbooks`)).lanes.find((document) => document.laneId === stage('Draft').id);
  assert.match(draft.text, /creates:\n {2}lane: Inbox\n {2}template: youtube-video\n/, 'creates keeps the node by name');
  assert.match(draft.text, new RegExp(`\\nlane: ${stage('Draft').id}\\n---\\n`), 'the lane setting is the created node');
  if (stage('Draft').playbook.creates !== undefined) assert.ok(stage('Draft').playbook.creates, 'the API shows creates when it exposes it');
});

test('the map, the skill and each playbook are written at their own file names with no starter playbooks left', async (t) => {
  const { get, result, stage } = await installed(t);
  const listing = await get(`/api/flows/${result.flow.id}/playbooks`);
  assert.equal(listing.map.text, files['MAP.md']);
  assert.deepEqual(listing.skills.map((skill) => [skill.path, skill.text]), [['skills/voice.md', files['skills/voice.md']]]);
  assert.deepEqual(listing.lanes.map((lane) => [lane.path, lane.laneId]),
    [['lanes/draft.md', stage('Draft').id], ['lanes/inbox.md', stage('Inbox').id], ['lanes/review.md', stage('Review').id]]);
  const review = listing.lanes.find((lane) => lane.path === 'lanes/review.md');
  assert.ok(!review.text.includes('stale-id') && review.text.includes('Check the draft.'));
  assert.deepEqual(await get(`/api/flows/${result.flow.id}/playbooks`).then((value) => value.stages.map((item) => item.name)), ['Inbox', 'Draft', 'Review']);
});

test('a card with an asset sits in its node with the image as the display image and the original', async (t) => {
  const { base, get, result, stage } = await installed(t);
  const card = result.cards[0];
  const { card: saved } = await get(`/api/cards/${card.id}`);
  assert.equal(saved.stageId, stage('Inbox').id); assert.equal(saved.title, 'Hello clip');
  assert.equal(saved.template, 'clip'); assert.equal(saved.fields.summary, 'Short.');
  assert.deepEqual(saved.images.map((image) => image.name), ['pixel.png']);
  assert.equal(saved.imageRoles.cover, saved.images[0].id);
  assert.equal(saved.imageRoles.original, saved.images[0].id);
  assert.equal(saved.imageRoles.draft, null);
  const served = await fetch(`${base}/images/${saved.images[0].id}`);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
  const builtin = (await get(`/api/cards/${result.cards[2].id}`)).card;
  assert.equal(builtin.template, 'youtube-video'); assert.equal(builtin.stageId, stage('Review').id); assert.equal(builtin.fields.intro, 'An intro.');
});

test('a youtube card takes its title, the video title, the transcript and the thumbnail', async (t) => {
  const { base, get, result, stage } = await installed(t);
  const { card } = await get(`/api/cards/${result.cards[1].id}`);
  assert.equal(card.stageId, stage('Inbox').id);
  assert.equal(card.title, 'A borrowed idea');
  assert.equal(card.fields.originalVideoTitle, 'A borrowed idea');
  assert.equal(card.fields.sourceUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(card.fields.transcript, captions.trim().slice(0, 40), 'the transcript is trimmed, then cut to the field limit');
  assert.equal(card.images.length, 1);
  assert.equal(card.imageRoles.cover, card.images[0].id); assert.equal(card.imageRoles.original, card.images[0].id);
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/images/${card.images[0].id}`)).arrayBuffer()), thumbnail);
});

test('installing again skips the project; replace deletes it and installs once more', async (t) => {
  const { base, get, dir, result, workspace } = await installed(t);
  const lines = [];
  const again = await installFlow(base, dir, { log: (line) => lines.push(line) });
  assert.equal(again.skipped, true); assert.equal(again.project.id, result.project.id);
  assert.match(lines.join('\n'), /already exists; skipped/);
  assert.equal((await workspace()).projects.filter((project) => project.name === 'Demo clips').length, 1);
  assert.equal((await get(`/api/projects/${result.project.id}/cards`)).cards.length, 3, 'nothing was added');

  const replaced = await installFlow(base, dir, { replace: true });
  assert.notEqual(replaced.project.id, result.project.id);
  assert.deepEqual(replaced.problems, []);
  const after = await workspace();
  assert.deepEqual(after.projects.filter((project) => project.name === 'Demo clips').map((project) => project.id), [replaced.project.id]);
  assert.equal(after.templates.filter((template) => template.id === 'clip').length, 1, 'the template is not created twice');
  assert.equal((await get(`/api/projects/${replaced.project.id}/cards`)).cards.length, 3);
});

test('checkFlow accepts the sample and reads the manifest', async (t) => {
  const dir = await writeFlow(path.join(await folder(t), 'sample'));
  assert.deepEqual(checkFlow(dir), { errors: [], warnings: [] });
  const flow = readFlow(dir);
  assert.equal(flow.name, 'sample'); assert.equal(flow.nodes[1].playbook.path, 'lanes/draft.md'); assert.match(flow.map.text, /A tiny flow/);
  assert.equal(flow.cards[0].images[0].problem, null);
});

test('checkFlow reports a route to a missing node, a missing asset and the other broken references', async (t) => {
  const broken = manifest();
  broken.nodes.push({ name: 'Lost', color: 'plum', x: 'far', playbook: 'lanes/lost.md' });
  broken.cards.push({ node: 'Nowhere', title: 'Stray', fields: { bogus: 'x' } });
  broken.cards[0].images.push({ file: 'assets/missing.png', roles: ['original', 'sketch'] });
  broken.cards[1].youtube = 'summary';
  const documents = { ...files,
    'lanes/inbox.md': '---\nrun: sometimes\nroutes:\n  next: Draft\n  skip: Nowhere\n  loop: Inbox\n---\nInbox.\n',
    'lanes/draft.md': '---\nroutes:\n  ready: Review\nskills: [missing-skill]\ncreates:\n  lane: Nowhere\n  template: ghost\n---\nDraft.\n' };
  delete documents['lanes/lost.md'];
  const dir = await writeFlow(path.join(await folder(t), 'broken'), broken, documents);
  const { errors } = checkFlow(dir);
  const has = (pattern) => assert.ok(errors.some((line) => pattern.test(line)), `${pattern} in\n${errors.join('\n')}`);
  has(/lanes\/inbox\.md: routes: “skip” leads to “Nowhere”, which is not a node/);
  has(/lanes\/inbox\.md: routes: “loop” leads back to its own node/);
  has(/lanes\/inbox\.md: run must be/);
  has(/lanes\/draft\.md: creates: lane “Nowhere” is not a node/);
  has(/lanes\/draft\.md: creates: template “ghost” is not in "templates"/);
  has(/lanes\/draft\.md: skills: “missing-skill” has no file in "skills"/);
  has(/node Lost: color must be one of/);
  has(/node Lost: x must be a number/);
  has(/lanes\/lost\.md: file not found/);
  has(/node “Nowhere” is not a node of this flow/);
  has(/field “bogus” is not in template clip/);
  has(/image assets\/missing\.png: file not found/);
  has(/youtube: “summary” is not a url field/);
  has(/“sketch” is not an image role/);

  const mismatched = manifest(); mismatched.template = 'ghost'; mismatched.templates.push({ id: 'Bad Id', name: 'Bad' }, { ...clip, fields: [{ key: 'x', label: 'X', control: 'rich' }] });
  const second = await writeFlow(path.join(await folder(t), 'templates'), mismatched);
  const messages = checkFlow(second).errors.join('\n');
  assert.match(messages, /template: “ghost” is not in "templates"/); assert.match(messages, /templates\[1\]: needs an "id"/);
  assert.match(messages, /template clip: its id is used twice/);
  assert.match(checkFlow(path.join(await folder(t), 'empty')).errors[0], /flow\.json/);
});

test('installFlow refuses a flow with problems before it touches the server', async (t) => {
  const s = await server(t);
  const before = await s.workspace();
  const broken = manifest(); broken.nodes[0].playbook = 'lanes/nope.md';
  const dir = await writeFlow(path.join(await folder(t), 'broken'), broken);
  await assert.rejects(() => installFlow(s.base, dir), /nothing was installed[\s\S]*nope\.md: file not found/);
  const after = await s.workspace();
  assert.deepEqual(after.projects.map((project) => project.id), before.projects.map((project) => project.id));
  assert.deepEqual(after.templates.map((template) => template.id), before.templates.map((template) => template.id));
  const fine = await writeFlow(path.join(await folder(t), 'ok'));
  await assert.rejects(() => installFlow('http://127.0.0.1:1', fine), /Could not reach Frameboard/);
});

test('the command line checks, installs and reports', async (t) => {
  const s = await server(t);
  const root = await folder(t);
  await writeFlow(path.join(root, 'good'));
  await writeFlow(path.join(root, 'broken'), { ...manifest(), project: 'Broken' }, { ...files, 'lanes/inbox.md': '---\nroutes:\n  next: Nowhere\n---\n' });
  const run = async (...argv) => { const out = []; const err = []; const code = await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }); return { code, out, err }; };

  const checked = await run('--check', root);
  assert.equal(checked.code, 1);
  assert.ok(checked.out.some((line) => /good: ok/.test(line)) && checked.err.some((line) => /broken: 1 problem/.test(line)) && checked.err.some((line) => /Nowhere/.test(line)));
  assert.equal((await run('--check', '--only', 'good', root)).code, 0);
  assert.equal((await run('--only', 'nope', root)).code, 1);
  assert.equal((await run('--bogus')).code, 2);

  const first = await run('--base', s.base, '--only', 'good', root);
  assert.equal(first.code, 0, first.err.join('\n'));
  assert.ok(first.out.some((line) => /good: installed: 3 nodes, 3 cards/.test(line)));
  const second = await run('--base', s.base, root);
  assert.equal(second.code, 1, 'the broken flow is reported');
  assert.ok(second.out.some((line) => /already exists; skipped/.test(line)) && second.err.some((line) => /broken: 1 problem.*not installed/.test(line)));
  assert.equal((await run('--base', s.base, '--replace', '--only', 'good', root)).code, 0);
  assert.equal((await s.workspace()).projects.filter((project) => project.name === 'Demo clips').length, 1);
  assert.equal((await run('--base', 'http://127.0.0.1:1', '--only', 'good', root)).code, 1);
});

test('the lane colors the installer checks are the ones the store accepts', () => {
  assert.deepEqual([...installerColors], [...laneColors]);
});
