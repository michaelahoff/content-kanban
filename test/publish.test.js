import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';
import { ControlledCodex } from './support/controlled-codex.js';
import { createApp } from '../server.js';
import { createPublisher } from '../publish.js';
import { describeSettings, parseDocument, playbookSettings } from '../public/playbook-format.js';
import { youtubeVideoTemplate } from '../public/card-template.js';

const block = (value) => `Done.\n\n\`\`\`frameboard-result\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const html = Buffer.from('<!doctype html><title>My first post</title><link rel="stylesheet" href="style.css"><h1>Hello</h1>\n');
const css = Buffer.from('h1 { color: rebeccapurple; }\n');
const temporary = async (t, prefix) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

// A graph flow Ideas → Draft → Publish → Published in a fresh app, which may
// be given its own publisher (one with a stand-in rsync).
async function board(t, publisherFor) {
  const dataDir = await temporary(t, 'frameboard-publish-');
  const codex = new ControlledCodex(dataDir);
  const app = await createApp({ dataDir, codexAdapter: codex, publisher: publisherFor?.(dataDir) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => (app.listening ? app.close(resolve) : resolve())));
  const port = app.address().port;
  const call = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (...args) => { const result = await call(...args); assert.ok(result.status < 300, JSON.stringify(result)); return result.body; };
  const raw = (url) => fetch(`http://127.0.0.1:${port}${url}`);
  // The path exactly as written: fetch would resolve . and .. segments first.
  const literal = (target) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: target }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); }).once('error', reject);
  });
  const project = (await ok('GET', '/api/workspace')).projects[0];
  const flow = await ok('POST', `/api/projects/${project.id}/flows`, { name: 'Blog', kind: 'graph' });
  const lane = Object.fromEntries(flow.stages.map((stage) => [stage.name, stage]));
  lane.Publish = await ok('POST', `/api/flows/${flow.id}/stages`, { name: 'Publish', color: 'green', x: 1140, y: 320 });
  lane.Published = await ok('POST', `/api/flows/${flow.id}/stages`, { name: 'Published', color: 'blue', x: 1520, y: 320 });
  const card = (stage, input = {}) => ok('POST', `/api/projects/${project.id}/cards`, { stageId: stage.id, ...input });
  const runs = async (cardId) => (await ok('GET', `/api/cards/${cardId}/lane-runs`)).runs;
  const playbook = (stage, settings, body = '') => setPlaybook(ok, flow.id, stage, settings, body);
  // Draft writes the post into its workspace, saves it under outputs and
  // routes the card on to Publish.
  await playbook(lane.Draft, { run: 'on-enter', model: 'test-model', advance: 'auto', routes: { next: lane.Publish.id } }, 'Write the post as post/index.html with post/style.css.');
  await playbook(lane.Published, { run: 'off' });
  async function draft(cardId, files, { send: index = 0, scratch = {} } = {}) {
    const send = await waitFor(() => codex.sends[index]);
    for (const [relative, bytes] of Object.entries({ ...files, ...scratch })) {
      const filename = path.join(dataDir, 'workspaces', cardId, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes);
    }
    codex.finish(send, 'completed', block({ notes: 'Drafted the post.', outputs: Object.keys(files).map((relative) => ({ path: relative })), route: 'next' }));
  }
  const chat = async (cardId, prompt) => {
    const { composer } = await ok('GET', `/api/cards/${cardId}/chat`);
    const saved = await ok('PUT', `/api/cards/${cardId}/chat/composer`, { ...composer, prompt, model: 'test-model' });
    return ok('POST', `/api/cards/${cardId}/chat/submissions`, { id: `chat-${cardId}`, composerRevision: saved.revision });
  };
  const settled = (cardId, stageId, after = null) => waitFor(async () => (await runs(cardId)).find((run) => run.stageId === stageId && run.id !== after && !['pending', 'queued'].includes(run.status)));
  return { dataDir, codex, call, ok, raw, literal, project, flow, lane, card, runs, playbook, draft, chat, settled };
}

test('a publish lane copies the saved outputs to a sandboxed local site, records the address and follows its route', async (t) => {
  const f = await board(t);
  const { Ideas, Draft, Publish, Published } = f.lane;
  await f.playbook(Publish, { action: 'publish', run: 'on-enter', publish: { to: 'blog', field: 'publishedVideoUrl' }, advance: 'auto', routes: { published: Published.id } });
  const card = await f.card(Ideas, { title: 'My First Post!' });
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: Draft.id });
  await f.draft(card.id, { 'post/index.html': html, 'post/style.css': css }, { scratch: { 'post/notes.txt': 'scratch, not declared' } });

  const run = await f.settled(card.id, Publish.id);
  assert.equal(run.status, 'completed', run.reason);
  assert.equal(run.trigger, 'enter');
  const url = '/sites/blog/my-first-post/';
  assert.deepEqual(run.result.publish, { status: 'published', url, files: ['index.html', 'style.css'], command: null, message: `Published 2 files to ${url}.` });
  assert.deepEqual(run.result.route, { name: 'published', to: 'Published', followed: true });
  assert.equal(run.reason, `Published 2 files to ${url}. Put the address in Published video URL. Followed published to Published.`);

  // The page is served as it was saved, sandboxed like any HTML preview.
  const page = await f.raw(`${url}index.html`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(page.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.deepEqual(Buffer.from(await page.arrayBuffer()), html);
  const folder = await f.raw(url);
  assert.equal(folder.status, 200, 'a folder serves its index.html');
  assert.deepEqual(Buffer.from(await folder.arrayBuffer()), html);
  assert.deepEqual(Buffer.from(await (await f.raw(`${url}style.css`)).arrayBuffer()), css);
  const head = await fetch(page.url, { method: 'HEAD' });
  assert.deepEqual([head.status, head.headers.get('content-length'), (await head.arrayBuffer()).byteLength], [200, String(html.length), 0]);
  assert.equal((await f.raw(`${url}notes.txt`)).status, 404, 'only saved outputs are published');
  for (const target of ['/sites/../x', `${url}../../etc`, `${url}%2e%2e/%2e%2e/etc/passwd`, '/sites/blog%2F..%2F..%2Fsites.db', '/sites/blog/', '/sites/.staging/', `${url}index.html%00`]) {
    assert.equal(await f.literal(target), 404, target);
  }
  assert.deepEqual(await readdir(path.join(f.dataDir, 'sites', '.staging')), [], 'staging folders are removed');

  // The address, the notes and the move are the action's own.
  const { card: moved, events } = await f.ok('GET', `/api/cards/${card.id}`);
  assert.equal(moved.fields.publishedVideoUrl, url);
  assert.equal(moved.stageId, Published.id);
  const move = events.filter((event) => event.type === 'moved').at(-1);
  assert.equal(move.actor, `automation:publish:${run.id}`);
  assert.deepEqual(move.data, { route: 'published' });
  const notes = (await f.ok('GET', `/api/cards/${card.id}/notes`)).text;
  assert.match(notes, /## Publish · \d{4}-\d\d-\d\d \d\d:\d\d UTC\n\nPublished 2 files to \/sites\/blog\/my-first-post\/\.\n\nFiles: index\.html, style\.css\./);
  assert.ok(notes.indexOf('Drafted the post.') < notes.indexOf('## Publish'), 'the action’s notes follow the drafting lane’s');
  assert.equal((await f.runs(card.id)).filter((item) => item.stageId === Published.id).length, 0, 'a lane with run: off does nothing');
});

test('Run playbook publishes again, replacing the page with the newest saved version of each file', async (t) => {
  const f = await board(t);
  const { Ideas, Draft, Publish, Published } = f.lane;
  await f.playbook(Publish, { action: 'publish', run: 'manual', publish: { to: 'blog' }, routes: { published: Published.id } });
  const settings = playbookSettings(parseDocument((await f.ok('GET', `/api/flows/${f.flow.id}/playbooks`)).lanes.find((item) => item.laneId === Publish.id).text), youtubeVideoTemplate);
  assert.equal(describeSettings(settings, youtubeVideoTemplate), 'Publishes to blog when you choose · 1 route');
  const card = await f.card(Ideas, { title: 'Twice' });
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: Draft.id });
  await f.draft(card.id, { 'post/index.html': html, 'post/style.css': css });
  await waitFor(async () => (await f.ok('GET', `/api/cards/${card.id}`)).card.stageId === Publish.id);
  assert.deepEqual((await f.runs(card.id)).filter((run) => run.stageId === Publish.id), [], 'a manual lane does not run on entry');

  const first = await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  assert.equal(first.trigger, 'manual');
  const done = await f.settled(card.id, Publish.id);
  assert.equal(done.status, 'completed', done.reason);
  assert.equal(done.reason, 'Published 2 files to /sites/blog/twice/.', 'advance: review leaves the move to the user');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.stageId, Publish.id);
  const folder = path.join(f.dataDir, 'sites', 'blog', 'twice');
  await writeFile(path.join(folder, 'stray.txt'), 'left behind');

  // A second draft saves a new index.html; style.css keeps its saved version.
  const changed = Buffer.from('<!doctype html><h1>Hello again</h1>\n');
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: Draft.id });
  await f.draft(card.id, { 'post/index.html': changed }, { send: 1 });
  await waitFor(async () => (await f.ok('GET', `/api/cards/${card.id}`)).card.stageId === Publish.id);
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const again = await f.settled(card.id, Publish.id, done.id);
  assert.equal(again.status, 'completed', again.reason);
  assert.deepEqual(Buffer.from(await (await f.raw('/sites/blog/twice/')).arrayBuffer()), changed);
  assert.deepEqual(Buffer.from(await (await f.raw('/sites/blog/twice/style.css')).arrayBuffer()), css);
  assert.deepEqual((await readdir(folder)).sort(), ['index.html', 'style.css'], 'the folder is replaced, not merged');
  assert.deepEqual((await readdir(path.join(f.dataDir, 'sites', 'blog'))), ['twice'], 'the old folder is gone');
});

test('a card without saved outputs fails its publish run and stays where it is', async (t) => {
  const f = await board(t);
  const { Ideas, Publish, Published } = f.lane;
  await f.playbook(Publish, { action: 'publish', run: 'on-enter', publish: { to: 'blog', field: 'publishedVideoUrl' }, advance: 'auto', routes: { published: Published.id } });
  const card = await f.card(Ideas, { title: 'Empty' });
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: Publish.id });
  const run = await f.settled(card.id, Publish.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.reason, 'Nothing to publish: this card has no saved outputs. A lane before this one must save the finished files under outputs.');
  const { card: after } = await f.ok('GET', `/api/cards/${card.id}`);
  assert.equal(after.stageId, Publish.id);
  assert.equal(after.fields.publishedVideoUrl, '');
  assert.equal((await f.ok('GET', `/api/cards/${card.id}/notes`)).text, '');
  assert.equal(f.codex.sends.length, 0, 'no agent is involved');
});

test('publishing waits until the card chat has finished, so a reply still saving its outputs is part of the post', async (t) => {
  const f = await board(t);
  const { Ideas, Publish } = f.lane;
  await f.playbook(Publish, { action: 'publish', run: 'on-enter', publish: { to: 'blog' } });
  const card = await f.card(Ideas, { title: 'Busy' });
  await f.chat(card.id, 'Tidy the intro.');
  const send = await waitFor(() => f.codex.sends[0]);
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: Publish.id });
  const waiting = await waitFor(async () => (await f.runs(card.id)).find((run) => run.stageId === Publish.id && run.reason));
  assert.deepEqual([waiting.status, waiting.reason], ['pending', 'Waiting for the card chat to finish before publishing.']);
  f.codex.finish(send, 'completed', 'Tidied.');
  const run = await f.settled(card.id, Publish.id);
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /^Nothing to publish/);
});

// A stand-in rsync that records its arguments and what it was given to send.
async function fakeRsync(t, script) {
  const dir = await temporary(t, 'frameboard-rsync-');
  const program = path.join(dir, 'rsync');
  await writeFile(program, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/argv'\nls "$3" > '${dir}/sent'\n${script}\n`, { mode: 0o755 });
  return { program, argv: async () => (await readFile(path.join(dir, 'argv'), 'utf8')).trim().split('\n'), sent: async () => (await readFile(path.join(dir, 'sent'), 'utf8')).trim().split('\n') };
}
const remote = { action: 'publish', run: 'on-enter', publish: { to: 'deploy@203.0.113.9:/var/www/blog', url: 'https://blog.example.com/posts/', field: 'publishedVideoUrl' }, advance: 'auto' };

test('a remote target is sent with rsync, and the exact command and outcome are recorded', async (t) => {
  const rsync = await fakeRsync(t, 'exit 0');
  const f = await board(t, (dataDir) => createPublisher({ dataDir, rsync: rsync.program }));
  const { Ideas, Draft, Publish, Published } = f.lane;
  await f.playbook(Publish, { ...remote, routes: { published: Published.id } });
  const card = await f.card(Ideas, { title: 'Remote post' });
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: Draft.id });
  await f.draft(card.id, { 'post/index.html': html, 'post/style.css': css });

  const run = await f.settled(card.id, Publish.id);
  assert.equal(run.status, 'completed', run.reason);
  const [flags, del, staged, destination] = await rsync.argv();
  assert.deepEqual([flags, del, destination], ['-az', '--delete', 'deploy@203.0.113.9:/var/www/blog/remote-post/']);
  assert.ok(staged.startsWith(path.join(f.dataDir, 'sites', '.staging') + path.sep) && staged.endsWith('/'), staged);
  assert.deepEqual(await rsync.sent(), ['index.html', 'style.css']);
  const url = 'https://blog.example.com/posts/remote-post/';
  assert.deepEqual(run.result.publish, { status: 'published', url, files: ['index.html', 'style.css'],
    command: `${rsync.program} -az --delete ${staged} deploy@203.0.113.9:/var/www/blog/remote-post/`,
    message: `Published 2 files to deploy@203.0.113.9:/var/www/blog/remote-post/ with rsync, served at ${url}.` });
  const { card: after } = await f.ok('GET', `/api/cards/${card.id}`);
  assert.equal(after.fields.publishedVideoUrl, url);
  assert.equal(after.stageId, Published.id);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'sites')), ['.staging'], 'nothing is served locally for a remote target');
  assert.deepEqual(await readdir(path.join(f.dataDir, 'sites', '.staging')), []);
});

test('an rsync failure fails the run with rsync’s own words and changes nothing on the card', async (t) => {
  const rsync = await fakeRsync(t, `echo 'rsync: [Receiver] mkdir "/var/www/blog/broken-post" failed: Permission denied (13)' >&2\necho 'rsync error: some files/attrs were not transferred (code 23)' >&2\nexit 23`);
  const f = await board(t, (dataDir) => createPublisher({ dataDir, rsync: rsync.program }));
  const { Ideas, Draft, Publish, Published } = f.lane;
  await f.playbook(Publish, { ...remote, routes: { published: Published.id } });
  const card = await f.card(Ideas, { title: 'Broken post' });
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: Draft.id });
  await f.draft(card.id, { 'post/index.html': html });

  const run = await f.settled(card.id, Publish.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.result.publish.status, 'failed');
  assert.equal(run.result.publish.url, null);
  assert.match(run.result.publish.command, /-az --delete \S+ deploy@203\.0\.113\.9:\/var\/www\/blog\/broken-post\/$/);
  assert.equal(run.reason, 'Could not publish to deploy@203.0.113.9:/var/www/blog/broken-post/: rsync exited with code 23: “rsync: [Receiver] mkdir "/var/www/blog/broken-post" failed: Permission denied (13) rsync error: some files/attrs were not transferred (code 23)”.');
  assert.equal(run.result.route, null);
  const { card: after } = await f.ok('GET', `/api/cards/${card.id}`);
  assert.equal(after.stageId, Publish.id);
  assert.equal(after.fields.publishedVideoUrl, '');
  assert.doesNotMatch((await f.ok('GET', `/api/cards/${card.id}/notes`)).text, /Publish ·/);
});

// The publisher on its own, with a stand-in store of saved outputs.
const savedStore = (outputs) => ({ savedOutputs: {
  list: () => outputs.map(({ id, filename, status = 'saved' }) => ({ id, filename, status })),
  content: async (ctx, cardId, id) => ({ stream: Readable.from([Buffer.from(outputs.find((output) => output.id === id).bytes)]) }),
} });
const publishWith = (publisher, outputs, publish, card = { id: 'card-1', title: 'A post' }) => publisher.publish({ store: savedStore(outputs), ctx: {}, card, settings: { publish: { url: null, field: null, ...publish } }, run: { id: 'run-1' } });

test('file() serves regular files under the sites folder and nothing else', async (t) => {
  const dataDir = await temporary(t, 'frameboard-sites-');
  const publisher = createPublisher({ dataDir });
  assert.equal(publisher.root, path.join(dataDir, 'sites'));
  assert.equal(await publisher.file('blog/post/index.html'), null, 'no sites folder yet');
  const post = path.join(publisher.root, 'blog', 'post');
  await mkdir(path.join(post, 'empty'), { recursive: true });
  await mkdir(path.join(publisher.root, '.staging', 'x'), { recursive: true });
  await writeFile(path.join(publisher.root, '.staging', 'x', 'index.html'), 'staged');
  await writeFile(path.join(post, 'index.html'), html);
  await writeFile(path.join(post, 'style.css'), css);
  await writeFile(path.join(post, 'data.bin'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(post, '.hidden'), 'secret');
  const outside = path.join(dataDir, 'outside.txt');
  await writeFile(outside, 'outside the sites folder');
  await symlink(outside, path.join(post, 'link.txt'));
  await symlink(dataDir, path.join(publisher.root, 'escape'));

  const { stream, ...page } = await publisher.file('blog/post/index.html');
  assert.deepEqual(page, { path: path.join(post, 'index.html'), size: html.length, type: 'text/html; charset=utf-8', kind: 'html' });
  assert.equal(await text(stream), html.toString());
  assert.equal(await text((await publisher.file('blog/post/')).stream), html.toString(), 'a trailing slash means index.html');
  assert.equal((await publisher.file('blog/post')).path, path.join(post, 'index.html'), 'so does a folder');
  assert.equal(await text((await publisher.file('blog/post/style.css')).stream), css.toString());
  assert.deepEqual([(await publisher.file('blog/post/data.bin')).type, (await publisher.file('blog/post/data.bin')).kind], ['application/octet-stream', null]);
  for (const relative of ['', '/', '/etc/passwd', 'blog', 'blog/', 'blog/post/empty', 'blog/post/empty/', '../outside.txt', 'blog/../outside.txt', 'blog/./post/index.html',
    'blog//post/index.html', 'blog/post/index.html/', 'blog\\post\\index.html', 'blog/post/index.html\0', '.staging/x/index.html', 'blog/post/.hidden',
    'blog/post/link.txt', 'escape/outside.txt', 'blog/post/missing.html', null, 7]) {
    assert.equal(await publisher.file(relative), null, JSON.stringify(relative));
  }
});

test('publish() names its target, chooses the newest version of each file and links the page', async (t) => {
  const dataDir = await temporary(t, 'frameboard-sites-');
  const publisher = createPublisher({ dataDir });
  for (const to of ['', 'my site', '../blog', '-blog', 'x'.repeat(61), '--rsh=evil@host:/x', 'deploy@host:/var/www/$(reboot)', 'deploy@-oProxyCommand=x:/p']) {
    await assert.rejects(publishWith(publisher, [{ id: 'a', filename: 'index.html', bytes: 'x' }], { to }), (error) => error.status === 400 && /publish: /.test(error.message), to);
  }
  await assert.rejects(publishWith(publisher, [{ id: 'a', filename: 'index.html', bytes: 'x', status: 'failed' }], { to: 'blog' }), { status: 409, message: /^Nothing to publish/ });

  const published = await publishWith(publisher, [
    { id: 'a', filename: 'page.html', bytes: 'old' }, { id: 'b', filename: '.htaccess', bytes: 'Options +Indexes' },
    { id: 'c', filename: 'page.html', bytes: 'new' }, { id: 'd', filename: 'photo.png', bytes: 'png' }, { id: 'e', filename: `${'é'.repeat(200)}.txt`, bytes: 'long' },
  ], { to: 'blog', url: 'https://example.com/blog/' }, { id: 'card-9', title: '¿¿¿' });
  assert.equal(published.url, 'https://example.com/blog/card-9/page.html', 'a title without letters uses the card ID; one page without index.html is linked by name');
  assert.deepEqual(published.files, ['htaccess', 'page.html', 'photo.png', `${'é'.repeat(125)}.txt`], 'no hidden files, and names fit in 255 bytes');
  assert.equal(await readFile(path.join(publisher.root, 'blog', 'card-9', 'page.html'), 'utf8'), 'new');
});

test('an rsync that cannot start or does not finish fails visibly', async (t) => {
  const dataDir = await temporary(t, 'frameboard-sites-');
  const missing = await publishWith(createPublisher({ dataDir, rsync: path.join(dataDir, 'no-rsync') }), [{ id: 'a', filename: 'index.html', bytes: 'x' }], { to: 'deploy@203.0.113.9:/var/www/blog' });
  assert.equal(missing.status, 'failed');
  assert.match(missing.message, /^Could not publish to deploy@203\.0\.113\.9:\/var\/www\/blog\/a-post\/: rsync is not installed on this computer \(.*ENOENT\)\.$/);
  const slow = await fakeRsync(t, 'sleep 5');
  const started = Date.now();
  const stopped = await publishWith(createPublisher({ dataDir, rsync: slow.program, timeoutMs: 300 }), [{ id: 'a', filename: 'index.html', bytes: 'x' }], { to: 'deploy@203.0.113.9:/var/www/blog' });
  assert.ok(Date.now() - started < 4000, 'the timeout stops rsync and what it started');
  assert.equal(stopped.status, 'failed');
  assert.match(stopped.message, /rsync did not finish within 0\.3 seconds and was stopped\.$/);
  assert.deepEqual(await readdir(path.join(dataDir, 'sites', '.staging')), []);
});
