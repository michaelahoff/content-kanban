import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.js';
import { serializeDocument } from '../public/playbook-format.js';

// A lane playbook whose only effect is setting Prompt on entry.
function lanePrompt(f, stage, prompt) {
  const existing = f.store.playbooks.forStage(stage.flowId, stage.id);
  f.store.playbooks.write(stage.flowId, existing?.path ?? `lanes/${stage.id}.md`, serializeDocument({ lane: stage.id, set: { prompt } }, ''), existing?.hash ?? null);
}
import { dropChatSchema } from './support/drop-chat-schema.js';

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-history-'));
  let time = Date.parse('2026-10-07T12:00:00Z');
  const notifications = [];
  let store = await openStore({ dataDir, clock: () => new Date(time).toISOString(), onCardEvent: (event) => notifications.push(event) });
  t.after(async () => { store?.close(); await rm(dataDir, { recursive: true, force: true }); });
  const ctx = { ...store.owner, actor: `user:${store.owner.userId}` };
  const workspace = store.workspace(ctx);
  const project = workspace.projects[0];
  const stages = workspace.flows[0].stages;
  return {
    dataDir, ctx, project, stages, notifications,
    get store() { return store; },
    advance(ms) { time += ms; },
    card(input = {}) { return store.createCard(ctx, project.id, { stageId: stages[0].id, ...input }); },
    states(id) { return store.savedCardStates(ctx, id); },
    save(card, input = {}, actor = ctx) { return store.updateCard(actor, card.id, { revision: card.revision, editingSessionId: 'editor-a', ...input }); },
    async reopen() { store.close(); store = null; store = await openStore({ dataDir, clock: () => new Date(time).toISOString() }); },
    close() { store.close(); store = null; },
  };
}
const image = { id: '00000001-0000-4000-8000-000000000000.png', name: 'Reference' };

test('upgrading an already-versioned database repairs legacy move foreign keys and preserves undo', async (t) => {
  const f = await fixture(t);
  const card = f.card();
  const moved = f.store.transitionCard(f.ctx, card.id, { action: 'move', toStageId: f.stages[1].id });
  f.close();
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  db.exec(`PRAGMA foreign_keys = OFF;
    ALTER TABLE card_moves RENAME TO current_card_moves;
    CREATE TABLE card_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES cards(id),
      event_id INTEGER REFERENCES card_events(id), before_card TEXT NOT NULL, after_card TEXT NOT NULL,
      placement TEXT NOT NULL, created_at TEXT NOT NULL, undone_at TEXT, undo_event_id INTEGER REFERENCES card_events(id));
    INSERT INTO card_moves SELECT * FROM current_card_moves;
    DROP TABLE current_card_moves;
    CREATE INDEX card_moves_by_card ON card_moves(card_id, id);
    ALTER TABLE projects DROP COLUMN archived_at;
    ALTER TABLE projects DROP COLUMN archive_generation;
    ALTER TABLE chat_attempts DROP COLUMN revoked;
    ALTER TABLE chat_submissions DROP COLUMN revoked;
    DROP TABLE library_drafts;
    DROP TABLE retained_versions;
    DROP TABLE retained_objects;
    DROP TABLE lane_runs;
    UPDATE meta SET value = '11' WHERE key = 'schema_version';`);
  db.close();
  const store = await openStore({ dataDir: f.dataDir });
  try {
    const undone = store.undoMove(f.ctx, card.id, { moveId: moved.card.lastMove.id, revision: moved.card.revision });
    assert.equal(undone.card.stageId, f.stages[0].id);
    const next = store.transitionCard(f.ctx, card.id, { action: 'move', toStageId: f.stages[1].id });
    assert.ok(next.card.lastMove.id > moved.card.lastMove.id);
    assert.equal(store.getCard(f.ctx, card.id).events.at(-1).id, next.event.id);
  } finally { store.close(); }
  const checked = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  try {
    assert.deepEqual(checked.prepare('PRAGMA foreign_key_check').all(), []);
    assert.ok(checked.prepare('PRAGMA foreign_key_list(card_moves)').all().filter((key) => key.from !== 'card_id').every((key) => key.table === 'activity_log'));
  } finally { checked.close(); }
});

// Materialize the v4 tables exactly as the former write paths did. The move
// records remain intact so migration tests also exercise real preexisting undo.
function downgrade(db) {
  db.exec('PRAGMA foreign_keys = OFF;');
  dropChatSchema(db);
  db.exec(`
    INSERT INTO card_events SELECT card_event_id, workspace_id, project_id, entity_id, type, actor,
      from_stage_id, to_stage_id, note, data, created_at FROM activity_log WHERE card_event_id IS NOT NULL;
    INSERT INTO workspace_changes SELECT id, workspace_id, entity, entity_id, project_id, type, actor, data, created_at FROM activity_log;
    DROP TABLE provider_configurations;
    DROP TABLE saved_card_states;
    DROP TABLE activity_log;
    UPDATE meta SET value = '4' WHERE key = 'schema_version';
  `);
}

test('schema migration preserves available facts, feed cursors, deleted cards and existing move undo', async (t) => {
  const f = await fixture(t);
  lanePrompt(f, f.stages[1], 'On entry');
  let card = f.card({ title: 'Before', images: [image], imageRoles: { original: image.id } });
  card = f.save(card, { fields: { intro: 'Keep intro' } });
  const moved = f.store.transitionCard(f.ctx, card.id, { action: 'move', toStageId: f.stages[1].id, note: 'Review this' });
  const deleted = f.card({ title: 'Retained' });
  f.store.deleteCard(f.ctx, deleted.id);
  const oldFeed = f.store.events(f.ctx);
  const oldHistory = f.store.getCard(f.ctx, card.id).events;
  const oldCard = f.store.getCard(f.ctx, card.id).card;
  f.close();
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  downgrade(db);
  // A history-only fact has no feed counterpart and must also survive.
  db.prepare(`INSERT INTO card_events (workspace_id, project_id, card_id, type, actor, note, data, created_at)
    VALUES (?, ?, ?, 'historical_note', 'user:old', 'Known note', '{}', '2020-01-01T00:00:00.000Z')`).run(f.ctx.workspaceId, f.project.id, card.id);
  db.close();
  // reopen() expects an open handle; start directly after deliberately closing.
  const upgraded = await openStore({ dataDir: f.dataDir });
  try {
    const feed = upgraded.events(f.ctx);
    assert.deepEqual(feed.slice(0, oldFeed.length), oldFeed, 'Old cursor IDs and feed content stay stable');
    const history = upgraded.getCard(f.ctx, card.id).events;
    assert.deepEqual(history.slice(0, oldHistory.length), oldHistory);
    assert.equal(history.at(-1).note, 'Known note');
    const migratedCard = upgraded.getCard(f.ctx, card.id).card;
    const { fieldVersions, placementVersion, ...migratedContent } = migratedCard;
    const { fieldVersions: discardedVersions, placementVersion: discardedPlacement, ...oldContent } = oldCard;
    assert.deepEqual(migratedContent, oldContent);
    assert.ok(Object.values(fieldVersions).every((version) => version === oldCard.revision));
    assert.equal(placementVersion, 1, 'Migration starts a placement baseline without inventing old versions');
    assert.equal(feed.filter((entry) => entry.type === 'moved').length, 1, 'Known history/feed pairs are coalesced');
    const baseline = upgraded.savedCardStates(f.ctx, card.id);
    assert.equal(baseline.length, 1);
    assert.equal(baseline[0].source, 'history_begins');
    assert.equal(baseline[0].snapshot.fields.prompt, 'On entry');
    assert.equal(baseline[0].snapshot.fields.intro, 'Keep intro');
    assert.deepEqual(baseline[0].snapshot.imageRoles, oldCard.imageRoles);
    assert.ok(upgraded.savedCardStates(f.ctx, deleted.id)[0].snapshot.deletedAt);
    assert.equal(upgraded.activity(f.ctx).filter((entry) => entry.cardEventId !== null).length, oldHistory.length + 3);
    assert.ok(upgraded.activity(f.ctx).filter((entry) => entry.cardEventId !== null).every((entry) => entry.context === null), 'Do not invent historical labels');
    const undone = upgraded.undoMove(f.ctx, card.id, { moveId: moved.card.lastMove.id, revision: moved.card.revision });
    assert.equal(undone.card.stageId, f.stages[0].id);
    assert.equal(undone.event.data.originalEventId, moved.event.id);
    assert.equal(undone.card.fields.prompt, '');
    assert.equal(undone.card.fields.intro, 'Keep intro');
    assert.deepEqual(upgraded.savedCardStates(f.ctx, card.id).map((entry) => entry.source), ['history_begins', 'move_undone']);
  } finally { upgraded.close(); }
  const reopened = await openStore({ dataDir: f.dataDir });
  try {
    assert.equal(reopened.savedCardStates(f.ctx, card.id).filter((entry) => entry.source === 'history_begins').length, 1);
    assert.equal(reopened.savedCardStates(f.ctx, deleted.id).length, 1);
  } finally { reopened.close(); }
});

test('ambiguous historical matches retain every fact without guessing which records are paired', async (t) => {
  const f = await fixture(t);
  const card = f.card();
  f.close();
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  downgrade(db);
  db.exec(`INSERT INTO card_events (workspace_id, project_id, card_id, type, actor, from_stage_id, to_stage_id, note, data, created_at)
    SELECT workspace_id, project_id, card_id, type, actor, from_stage_id, to_stage_id, 'A distinct known note', data, created_at FROM card_events;`);
  db.close();
  const store = await openStore({ dataDir: f.dataDir });
  try {
    const facts = store.activity(f.ctx, { cardId: card.id }).filter((entry) => entry.type === 'created');
    assert.equal(facts.length, 3, 'One old feed fact plus two history facts are retained');
    assert.deepEqual(store.getCard(f.ctx, card.id).events.map((entry) => entry.note), ['', 'A distinct known note']);
    assert.equal(store.savedCardStates(f.ctx, card.id).length, 1, 'Only the current card gets a baseline');
  } finally { store.close(); }
});

test('legacy JSON import begins saved history at the actual imported state and only once', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-history-json-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, 'board.json'), JSON.stringify({ revision: 1, board: { projects: [{ id: 'project', name: 'Imported', lanes: [{ id: 'lane', name: 'Ideas', color: 'blue', cards: [{ id: 'card', title: 'Existing', intro: 'Actual content', script: '', coverImageId: null, images: [image], originalImageId: image.id }] }] }] } }));
  for (let n = 0; n < 2; n++) {
    const store = await openStore({ dataDir });
    try {
      const ctx = { ...store.owner, actor: `user:${store.owner.userId}` };
      const states = store.savedCardStates(ctx, 'card');
      assert.equal(states.length, 1);
      assert.equal(states[0].source, 'history_begins');
      assert.equal(states[0].snapshot.fields.intro, 'Actual content');
      assert.equal(states[0].snapshot.imageRoles.original, image.id);
      assert.equal(states[0].snapshot.placement.index, 0);
      assert.equal(store.activity(ctx).filter((entry) => entry.type === 'history_begins').length, 1);
    } finally { store.close(); }
  }
});

test('manual saves group by editor and idle time while activity stays append-only', async (t) => {
  const f = await fixture(t);
  let card = f.card({ title: 'Original' });
  card = f.save(card, { title: 'First' });
  const firstId = f.states(card.id).at(-1).id;
  const firstActivity = f.states(card.id).at(-1).activityId;
  f.advance(119999);
  card = f.save(card, { fields: { intro: 'Second' } });
  assert.equal(f.states(card.id).length, 2);
  assert.equal(f.states(card.id).at(-1).id, firstId);
  assert.equal(f.states(card.id).at(-1).snapshot.title, 'First');
  assert.equal(f.states(card.id).at(-1).snapshot.fields.intro, 'Second');
  assert.ok(f.states(card.id).at(-1).activityId > firstActivity);
  assert.equal(f.store.events(f.ctx).filter((entry) => entry.type === 'updated').length, 2);
  f.advance(120000);
  card = f.save(card, { title: 'After idle' });
  assert.equal(f.states(card.id).length, 3);
  const afterIdle = f.states(card.id).at(-1);
  f.store.endEditingSession(f.ctx, card.id, { editingSessionId: 'editor-a' });
  card = f.save(card, { title: 'After close' });
  assert.equal(f.states(card.id).length, 4);
  assert.equal(f.states(card.id).find((entry) => entry.id === afterIdle.id).snapshot.title, 'After idle');
  card = f.save(card, { title: 'Another tab', editingSessionId: 'editor-b' });
  card = f.save(card, { title: 'Back in first tab' });
  assert.equal(f.states(card.id).length, 6);
  card = f.save(card, { fields: { script: 'An agent edit' } }, { ...f.ctx, actor: 'automation:attempt' });
  assert.equal(f.states(card.id).at(-1).source, 'fields_changed');
  card = f.save(card, { title: 'After agent edit' });
  assert.equal(f.states(card.id).length, 8);
  await f.reopen();
  assert.equal(f.states(card.id).length, 8, 'Reopen retains states without adding a migration baseline');
  assert.equal(f.states(card.id).at(-1).snapshot.title, 'After agent edit');
});

test('all card mutation boundaries record complete states; entry Set effects share creation and movement', async (t) => {
  const f = await fixture(t);
  lanePrompt(f, f.stages[0], 'Created prompt');
  lanePrompt(f, f.stages[1], 'Moved prompt');
  let card = f.card({ title: 'Example', fields: { script: 'Keep' } });
  const neighbour = f.card({ title: 'Neighbour' });
  assert.equal(f.states(card.id).length, 1);
  assert.equal(f.states(card.id)[0].snapshot.fields.prompt, 'Created prompt');
  card = f.save(card, { title: 'Text' });
  card = f.save(card, { images: [image], imageRoles: { cover: image.id } });
  card = f.save(card, { imageRoles: { original: image.id } });
  card = f.save(card, { images: [{ ...image, name: 'Renamed reference' }] });
  card = f.save(card, { fields: { intro: 'More text' } });
  const reordered = f.store.transitionCard(f.ctx, card.id, { action: 'move', toStageId: f.stages[0].id });
  assert.equal(reordered.card.lastMove.id > 0, true);
  assert.equal(f.states(card.id).at(-1).snapshot.placement.afterCardId, neighbour.id);
  const beforeMoveCount = f.states(card.id).length;
  const moved = f.store.transitionCard(f.ctx, card.id, { action: 'move', toStageId: f.stages[1].id });
  assert.equal(f.states(card.id).length, beforeMoveCount + 1);
  assert.equal(f.states(card.id).at(-1).snapshot.fields.prompt, 'Moved prompt');
  assert.equal(f.states(card.id).at(-1).snapshot.fields.script, 'Keep');
  assert.equal(f.states(card.id).at(-1).snapshot.imageRoles.original, image.id);
  f.store.undoMove(f.ctx, card.id, { moveId: moved.card.lastMove.id, revision: moved.card.revision });
  f.store.setProjectPrompt(f.ctx, f.project.id, 'Bulk prompt');
  f.store.deleteCard(f.ctx, card.id);
  assert.deepEqual(f.states(card.id).map((entry) => entry.source), ['created', 'editing_session', 'images_changed', 'images_changed', 'images_changed', 'editing_session', 'reordered', 'moved', 'move_undone', 'bulk_prompt', 'deleted']);
  assert.ok(f.states(card.id).at(-1).snapshot.deletedAt);
  assert.equal(f.states(card.id).at(-1).snapshot.fields.prompt, 'Bulk prompt');
  assert.equal(f.states(card.id).at(-1).snapshot.imageRoles.original, image.id);
  f.store.deleteStage(f.ctx, f.stages[0].id);
  assert.equal(f.states(neighbour.id).at(-1).source, 'deleted');
  const otherProject = f.store.createProject(f.ctx, { name: 'Other' });
  const otherCard = f.store.createCard(f.ctx, otherProject.project.id, { stageId: otherProject.flow.stages[0].id });
  f.store.deleteProject(f.ctx, otherProject.project.id);
  assert.ok(f.states(otherCard.id).at(-1).snapshot.deletedAt);
});

test('failed checkpoint writes roll back card effects, activity, move snapshots and listener notifications', async (t) => {
  const f = await fixture(t);
  const card = f.card();
  const feed = f.store.events(f.ctx);
  const states = f.states(card.id);
  const notified = f.notifications.length;
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  db.exec("CREATE TRIGGER fail_state BEFORE INSERT ON saved_card_states BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END;");
  try {
    assert.throws(() => f.save(card, { title: 'Must roll back' }), /injected checkpoint failure/);
    assert.throws(() => f.store.transitionCard(f.ctx, card.id, { action: 'move', toStageId: f.stages[1].id }), /injected checkpoint failure/);
    assert.deepEqual(f.store.getCard(f.ctx, card.id).card, card);
    assert.deepEqual(f.store.events(f.ctx), feed);
    assert.deepEqual(f.states(card.id), states);
    assert.equal(f.notifications.length, notified);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM card_moves').get().count, 0);
  } finally { db.exec('DROP TRIGGER fail_state'); db.close(); }
  const saved = f.save(card, { title: 'Valid' });
  const after = f.store.events(f.ctx);
  const afterStates = f.states(card.id);
  assert.throws(() => f.save(card, { title: 'Stale' }), { status: 409 });
  assert.throws(() => f.save(saved, { editingSessionId: [] }), { status: 400 });
  assert.deepEqual(f.store.events(f.ctx), after);
  assert.deepEqual(f.states(card.id), afterStates);
});

test('retained history reads are workspace-scoped and recording preserves labels after rename/deletion', async (t) => {
  const f = await fixture(t);
  const card = f.card({ title: 'Historical title' });
  const initial = f.store.activity(f.ctx, { cardId: card.id })[0];
  f.store.updateProject(f.ctx, f.project.id, { name: 'New project name' });
  f.store.updateStage(f.ctx, f.stages[0].id, { name: 'New lane name' });
  f.store.deleteCard(f.ctx, card.id);
  assert.equal(initial.context.cardTitle, 'Historical title');
  assert.equal(initial.context.projectName, f.project.name);
  assert.equal(initial.context.stageName, f.stages[0].name);
  assert.deepEqual(f.store.activity(f.ctx, { cardId: card.id })[0], initial);
  const foreign = { ...f.ctx, workspaceId: 'another-workspace' };
  assert.throws(() => f.store.savedCardStates(foreign, card.id), { status: 404 });
  assert.throws(() => f.store.endEditingSession(foreign, card.id, { editingSessionId: 'editor-a' }), { status: 404 });
  assert.throws(() => f.store.activity(foreign, { cardId: card.id }), { status: 404 });
  assert.deepEqual(f.store.activity(foreign), []);
  const db = new DatabaseSync(path.join(f.dataDir, 'frameboard.db'));
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM card_events').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workspace_changes').get().count, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
