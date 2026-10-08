import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server.js';
import { promptGraph } from '../public/flow-graph.js';

async function waitFor(condition) {
  for (let n = 0; n < 200; n++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for client saves');
}

async function fixture(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'frameboard-client-'));
  const nativeFetch = globalThis.fetch;
  const previousDocument = globalThis.document;
  const server = await createApp({ dataDir: path.join(temporary, 'data') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    globalThis.fetch = nativeFetch;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  const call = async (method, url, body) => {
    const response = await nativeFetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${url}: ${response.status}`);
    return response.json();
  };
  // Fresh module copies isolate each client's queue, dirty cards, and conflicts.
  await mkdir(path.join(temporary, 'public'));
  await writeFile(path.join(temporary, 'package.json'), '{"type":"module"}');
  for (const file of ['api.js', 'state.js', 'ui.js', 'card-template.js', 'flow-graph.js']) {
    await copyFile(new URL(`../public/${file}`, import.meta.url), path.join(temporary, 'public', file));
  }
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
  globalThis.fetch = (url, options) => nativeFetch(`${base}${url}`, options);
  const client = await import(pathToFileURL(path.join(temporary, 'public/state.js')));
  const api = await import(pathToFileURL(path.join(temporary, 'public/api.js')));
  await client.loadWorkspace();
  client.state.projectId = client.state.projects[0].id;
  await client.loadCards(client.state.projectId);
  const idle = () => waitFor(() => !api.syncState().pending && !client.saveStatus().saving);
  const card = async (lane = client.project().lanes[0]) => {
    const created = client.createCard(lane);
    await idle();
    return created;
  };
  return { client, api, nativeFetch, base, call, idle, card };
}

test('moving a stale card does not authorize overwriting another tab’s content', async (t) => {
  const f = await fixture(t);
  const card = await f.card();
  await f.call('PATCH', `/api/cards/${card.id}`, { revision: 1, fields: { intro: 'Other tab’s intro' } });
  f.client.moveCard(card.id, f.client.project().lanes[1].id);
  await f.idle();
  assert.equal(card.revision, 1);
  card.title = 'My title';
  f.client.cardChanged(card);
  f.client.flushCards();
  await f.idle();
  const saved = (await f.call('GET', `/api/cards/${card.id}`)).card;
  assert.equal(saved.fields.intro, 'Other tab’s intro');
  assert.equal(saved.title, 'My title');
  assert.equal(card.title, 'My title');
  assert.equal(card.fields.intro, 'Other tab’s intro');
  assert.deepEqual(f.client.saveStatus().conflicts, []);
});

test('shared prompts preserve unrelated newer fields and save matching prompt versions', async (t) => {
  const f = await fixture(t);
  const stale = await f.card();
  const other = await f.card();
  await f.call('PATCH', `/api/cards/${stale.id}`, { revision: 1, fields: { script: 'External script' } });
  f.client.setProjectPrompt(f.client.project(), 'Shared prompt');
  await f.idle();
  assert.equal(stale.revision, 3);
  assert.equal(stale.fields.prompt, 'Shared prompt');
  const saved = (await f.call('GET', `/api/cards/${stale.id}`)).card;
  assert.equal(saved.fields.script, 'External script');
  assert.equal(saved.fields.prompt, 'Shared prompt');
  assert.equal((await f.call('GET', `/api/cards/${other.id}`)).card.fields.prompt, 'Shared prompt');
});

test('conflicts do not block other writes, and loading the saved card resolves only that draft', async (t) => {
  const f = await fixture(t);
  const stale = await f.card();
  const other = await f.card();
  await f.call('PATCH', `/api/cards/${stale.id}`, { revision: 1, title: 'External title' });
  stale.title = 'Unsaved draft';
  other.title = 'Independent draft';
  f.client.cardChanged(stale);
  f.client.cardChanged(other);
  f.client.flushCards();
  await f.idle();
  f.api.retry();
  await f.idle();
  assert.equal(stale.title, 'Unsaved draft');
  assert.equal((await f.call('GET', `/api/cards/${other.id}`)).card.title, 'Independent draft');
  const project = await f.client.createProject('Still works');
  assert.equal(project.name, 'Still works');
  await f.client.useSavedCard(stale.id);
  assert.equal(stale.title, 'External title');
  assert.equal(stale.revision, 2);
  assert.deepEqual(f.client.saveStatus().conflicts, []);
  assert.equal(f.client.hasUnsavedWork(), false);
  stale.fields.intro = 'An edit after resolution';
  f.client.cardChanged(stale);
  f.client.flushCards();
  await f.idle();
  assert.equal((await f.call('GET', `/api/cards/${stale.id}`)).card.fields.intro, stale.fields.intro);
});

test('edits made during a save are persisted with the acknowledged revision', async (t) => {
  const f = await fixture(t);
  const card = await f.card();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reached = false;
  globalThis.fetch = async (url, options) => {
    const response = await f.nativeFetch(`${f.base}${url}`, options);
    if (options?.method === 'PATCH' && !reached) {
      reached = true;
      await held;
    }
    return response;
  };
  card.title = 'First edit';
  f.client.cardChanged(card);
  f.client.flushCards();
  await waitFor(() => reached);
  card.title = 'Edit during save';
  f.client.cardChanged(card);
  f.client.flushCards();
  release();
  await f.idle();
  assert.equal((await f.call('GET', `/api/cards/${card.id}`)).card.title, 'Edit during save');
  assert.equal(card.revision, 3);
});

test('temporary failures can still retry the latest draft', async (t) => {
  const f = await fixture(t);
  const card = await f.card();
  let failed = false;
  globalThis.fetch = (url, options) => {
    if (options?.method === 'PATCH' && !failed) {
      failed = true;
      return Promise.resolve(new Response(JSON.stringify({ error: 'Disk temporarily unavailable' }), { status: 503 }));
    }
    return f.nativeFetch(`${f.base}${url}`, options);
  };
  card.title = 'First draft';
  f.client.cardChanged(card);
  f.client.flushCards();
  await waitFor(() => f.api.syncState().error);
  card.title = 'Latest draft';
  f.client.cardChanged(card);
  f.client.flushCards();
  f.api.retry();
  await f.idle();
  assert.equal((await f.call('GET', `/api/cards/${card.id}`)).card.title, 'Latest draft');
  assert.equal(f.client.hasUnsavedWork(), false);
});

test('typing an unsubmitted field during a save cannot acknowledge an unseen external field version', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.call('PATCH', `/api/cards/${card.id}`, { revision: 1, fields: { intro: 'External intro' } });
  let release; const gate = new Promise((resolve) => { release = resolve; }); let reached = false;
  globalThis.fetch = async (url, options) => {
    const response = await f.nativeFetch(`${f.base}${url}`, options);
    if (options?.method === 'PATCH' && !reached) { reached = true; await gate; }
    return response;
  };
  card.title = 'Matching title'; f.client.cardChanged(card); f.client.flushCards();
  await waitFor(() => reached);
  card.fields.intro = 'Draft typed during save'; f.client.cardChanged(card); f.client.flushCards();
  release(); await f.idle();
  const saved = (await f.call('GET', `/api/cards/${card.id}`)).card;
  assert.equal(saved.title, 'Matching title'); assert.equal(saved.fields.intro, 'External intro');
  assert.equal(card.fields.intro, 'Draft typed during save');
  assert.equal(f.client.saveStatus().conflicts.length, 1);
});

test('entry prompts flush earlier drafts and acknowledge only their own content changes', async (t) => {
  const f = await fixture(t);
  const lane = f.client.project().lanes[1];
  // Simulates a rule configured elsewhere, so the local lane is out of date.
  await f.call('PATCH', `/api/stages/${lane.id}`, { entryPrompt: 'Lane instructions' });
  const card = await f.card();
  card.fields.intro = 'Unsaved intro';
  card.fields.prompt = 'Earlier prompt';
  f.client.cardChanged(card);
  let notifications = 0;
  f.client.onCardPromptChange(() => notifications++);
  f.client.moveCard(card.id, lane.id);
  await f.idle();
  const saved = (await f.call('GET', `/api/cards/${card.id}`)).card;
  assert.equal(saved.fields.intro, 'Unsaved intro');
  assert.equal(saved.fields.prompt, 'Lane instructions');
  assert.equal(card.fields.prompt, saved.fields.prompt);
  assert.equal(card.revision, saved.revision);
  assert.equal(notifications, 1);
  card.title = 'Edit after automatic prompt';
  f.client.cardChanged(card);
  f.client.flushCards();
  await f.idle();
  assert.equal((await f.call('GET', `/api/cards/${card.id}`)).card.title, card.title);
  assert.equal(f.client.hasUnsavedWork(), false);
  const created = await f.card(lane);
  assert.equal(created.fields.prompt, 'Lane instructions');
  assert.equal(created.revision, (await f.call('GET', `/api/cards/${created.id}`)).card.revision);
});

test('an entry prompt acknowledges only its own fields while unrelated edits can save', async (t) => {
  const f = await fixture(t);
  const lane = f.client.project().lanes[1];
  await f.call('PATCH', `/api/stages/${lane.id}`, { entryPrompt: 'Lane prompt' });
  const card = await f.card();
  await f.call('PATCH', `/api/cards/${card.id}`, { revision: 1, fields: { intro: 'Other tab intro' } });
  f.client.moveCard(card.id, lane.id);
  await f.idle();
  assert.equal(card.fields.prompt, 'Lane prompt');
  assert.equal(card.revision, 3);
  assert.equal(f.client.saveStatus().conflicts.length, 0);
  card.title = 'My draft';
  f.client.cardChanged(card);
  f.client.flushCards();
  await f.idle();
  const saved = (await f.call('GET', `/api/cards/${card.id}`)).card;
  assert.equal(saved.fields.intro, 'Other tab intro');
  assert.equal(saved.title, 'My draft');
  await f.client.useSavedCard(card.id);
  assert.equal(card.fields.intro, 'Other tab intro');
  assert.equal(card.fields.prompt, 'Lane prompt');
});

test('typing during a lane transition preserves the newer draft and saves against the action revision', async (t) => {
  const f = await fixture(t);
  const lane = f.client.project().lanes[1];
  await f.call('PATCH', `/api/stages/${lane.id}`, { entryPrompt: 'Automatic prompt' });
  const card = await f.card();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reached = false;
  globalThis.fetch = async (url, options) => {
    const response = await f.nativeFetch(`${f.base}${url}`, options);
    if (url.endsWith('/transitions')) { reached = true; await held; }
    return response;
  };
  f.client.moveCard(card.id, lane.id);
  await waitFor(() => reached);
  card.fields.prompt = 'Typed after entering';
  card.fields.script = 'New script';
  f.client.cardChanged(card);
  f.client.flushCards();
  release();
  await f.idle();
  const saved = (await f.call('GET', `/api/cards/${card.id}`)).card;
  assert.equal(saved.fields.prompt, 'Typed after entering');
  assert.equal(saved.fields.script, 'New script');
  assert.equal(card.revision, saved.revision);
  assert.equal(f.client.hasUnsavedWork(), false);
});

test('a multi-field Set node refreshes title and text without overwriting typing during the move', async (t) => {
  const f = await fixture(t);
  const lane = f.client.project().lanes[1];
  const graph = promptGraph('Flow prompt');
  graph.nodes[1].config = { assignments: [{ field: 'prompt', value: 'Flow prompt' }, { field: 'title', value: 'Flow title' }, { field: 'intro', value: 'Flow intro' }] };
  await f.client.saveLaneGraph(lane, graph);
  const created = await f.card(lane);
  assert.equal(created.title, 'Flow title');
  assert.equal(created.fields.intro, 'Flow intro');
  const card = await f.card();
  let release, reached = false;
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url, options) => {
    const response = await f.nativeFetch(`${f.base}${url}`, options);
    if (url.endsWith('/transitions')) { reached = true; await held; }
    return response;
  };
  let updatedKeys;
  f.client.onCardFieldsChange((updated, keys) => { if (updated.id === card.id) updatedKeys = keys; });
  f.client.moveCard(card.id, lane.id);
  await waitFor(() => reached);
  card.fields.intro = 'Typed during the move';
  f.client.cardChanged(card);
  f.client.flushCards();
  release();
  await f.idle();
  const saved = (await f.call('GET', `/api/cards/${card.id}`)).card;
  assert.equal(card.title, 'Flow title');
  assert.equal(saved.fields.prompt, 'Flow prompt');
  assert.equal(saved.fields.intro, 'Typed during the move');
  assert.deepEqual(updatedKeys, ['prompt', 'title']);
  assert.equal(card.revision, saved.revision);
  assert.equal(f.client.hasUnsavedWork(), false);
});

test('failed graph saves keep the saved configuration and can retry without blocking other writes', async (t) => {
  const f = await fixture(t);
  const lane = f.client.project().lanes[0], previous = structuredClone(lane.entryGraph);
  let failed = false;
  globalThis.fetch = (url, options) => {
    if (options?.method === 'PATCH' && url.includes('/stages/') && !failed) {
      failed = true;
      return Promise.resolve(new Response(JSON.stringify({ error: 'Try again' }), { status: 503 }));
    }
    return f.nativeFetch(`${f.base}${url}`, options);
  };
  const graph = promptGraph('Retry prompt');
  await assert.rejects(f.client.saveLaneGraph(lane, graph), /Try again/);
  assert.deepEqual(lane.entryGraph, previous);
  assert.equal(f.client.hasUnsavedWork(), false);
  await f.client.saveLaneGraph(lane, graph);
  assert.deepEqual(lane.entryGraph, graph);
  assert.equal((await f.card(lane)).fields.prompt, 'Retry prompt');
});

test('undo saves earlier drafts, restores placement and fields, and keeps typing during the request', async (t) => {
  const f = await fixture(t);
  const [source, destination] = f.client.project().lanes;
  await f.call('PATCH', `/api/stages/${destination.id}`, { entryPrompt: 'Lane prompt' });
  const card = await f.card();
  const neighbour = await f.card();
  card.fields.prompt = 'Before prompt';
  f.client.cardChanged(card);
  f.client.moveCard(card.id, destination.id);
  await f.idle();
  card.fields.intro = 'Unrelated draft before undo';
  f.client.cardChanged(card);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reached = false;
  globalThis.fetch = async (url, options) => {
    const response = await f.nativeFetch(`${f.base}${url}`, options);
    if (url.endsWith('/undo-move')) { reached = true; await held; }
    return response;
  };
  let notifications = 0;
  f.client.onCardFieldsChange(() => notifications++);
  const undone = f.client.undoLastMove(card.id);
  await waitFor(() => reached);
  assert.equal(f.client.moveCard(card.id, source.id), false, 'Prevent a concurrent optimistic move during undo');
  card.fields.prompt = 'Typed during undo';
  card.fields.script = 'Newer script';
  f.client.cardChanged(card);
  f.client.flushCards();
  release();
  await undone;
  await f.idle();
  assert.deepEqual(source.cards.map((item) => item.id), [card.id, neighbour.id]);
  assert.equal(card.lastMove, null);
  assert.equal(card.fields.prompt, 'Typed during undo');
  assert.equal(card.fields.intro, 'Unrelated draft before undo');
  const saved = (await f.call('GET', `/api/cards/${card.id}`)).card;
  assert.equal(saved.stageId, source.id);
  assert.equal(saved.fields.prompt, 'Typed during undo');
  assert.equal(saved.fields.script, 'Newer script');
  assert.equal(saved.revision, card.revision);
  assert.equal(notifications, 0, 'The response must not replace newer typing');
});

test('undo refreshes changed fields and a failed undo does not block other card saves', async (t) => {
  const f = await fixture(t);
  const [source, destination] = f.client.project().lanes;
  await f.call('PATCH', `/api/stages/${destination.id}`, { entryPrompt: 'Lane prompt' });
  const card = await f.card();
  const other = await f.card();
  f.client.moveCard(card.id, destination.id);
  await f.idle();
  let updatedKeys;
  f.client.onCardFieldsChange((updated, keys) => { if (updated.id === card.id) updatedKeys = keys; });
  await f.client.undoLastMove(card.id);
  assert.equal(card.fields.prompt, '');
  assert.equal(card.stageId, source.id);
  assert.deepEqual(updatedKeys, ['prompt']);
  f.client.moveCard(card.id, destination.id);
  await f.idle();
  card.fields.prompt = 'Newer saved prompt';
  f.client.cardChanged(card);
  await assert.rejects(f.client.undoLastMove(card.id), /prompt was edited/);
  assert.equal(card.fields.prompt, 'Newer saved prompt');
  assert.equal(card.stageId, destination.id);
  assert.equal(f.client.state.undoingCardId, null);
  assert.equal(f.api.syncState().error, '');
  other.title = 'Independent edit';
  f.client.cardChanged(other);
  f.client.flushCards();
  await f.idle();
  assert.equal((await f.call('GET', `/api/cards/${other.id}`)).card.title, 'Independent edit');
});

test('editor sessions group saves, flush on close and split when another card is selected', async (t) => {
  const f = await fixture(t);
  const first = await f.card();
  const second = await f.card();
  const states = async (card) => (await f.call('GET', `/api/cards/${card.id}/states`)).states;
  f.client.beginCardEditing(first.id);
  first.title = 'First save';
  f.client.cardChanged(first);
  f.client.flushCards();
  await f.idle();
  first.fields.intro = 'Second save';
  f.client.cardChanged(first);
  // Closing flushes the unsent draft before ending its session.
  f.client.endCardEditing(first.id);
  f.client.beginCardEditing(second.id);
  await f.idle();
  let saved = await states(first);
  assert.deepEqual(saved.map((entry) => entry.source), ['created', 'editing_session']);
  assert.equal(saved.at(-1).snapshot.fields.intro, 'Second save');
  assert.ok(saved.at(-1).closedAt);
  f.client.endCardEditing(second.id);
  f.client.beginCardEditing(first.id);
  first.title = 'Reopened';
  f.client.cardChanged(first);
  f.client.endCardEditing(first.id);
  await f.idle();
  saved = await states(first);
  assert.equal(saved.length, 3);
  assert.equal(saved[1].snapshot.title, 'First save');
  assert.equal(saved[2].snapshot.title, 'Reopened');
  assert.ok(saved[2].closedAt);
});

test('closing during an in-flight save retains subsequent typing in a separate checkpoint', async (t) => {
  const f = await fixture(t);
  const card = await f.card();
  f.client.beginCardEditing(card.id);
  let release;
  let saving = false;
  const held = new Promise((resolve) => { release = resolve; });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await nativeFetch(url, options);
    if (options?.method === 'PATCH' && !saving) { saving = true; await held; }
    return response;
  };
  card.title = 'First';
  f.client.cardChanged(card);
  f.client.flushCards();
  await waitFor(() => saving);
  card.fields.script = 'Typed during save';
  f.client.cardChanged(card);
  f.client.endCardEditing(card.id);
  release();
  await f.idle();
  const saved = (await f.call('GET', `/api/cards/${card.id}/states`)).states;
  assert.equal(saved.at(-1).snapshot.fields.script, 'Typed during save');
  assert.equal((await f.call('GET', `/api/cards/${card.id}`)).card.fields.script, 'Typed during save');
  assert.ok(saved[1].closedAt, 'The closed session is not reopened by a delayed save');
});
