import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, supportedSchemaVersion } from '../store.js';

// Feature branches used v16 for either drafts or delivery, earlier
// retained/archive schemas did not have the columns added before merge, and
// the repair itself was once v20, before templates took that number.
for (const layout of ['delivery-v16', 'drafts-v16', 'merged-v19', 'repaired-v20']) {
  test(`upgrades ${layout} without losing card history or retained bytes`, async (t) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-schema-'));
    let store;
    t.after(async () => { store?.close(); await rm(dataDir, { recursive: true, force: true }); });
    store = await openStore({ dataDir });
    const ctx = { ...store.owner, actor: `user:${store.owner.userId}` };
    const workspace = store.workspace(ctx);
    const project = workspace.projects[0];
    const stages = workspace.flows[0].stages;
    const card = store.createCard(ctx, project.id, { stageId: stages[0].id, title: 'Keep this card' });
    const moved = store.transitionCard(ctx, card.id, { action: 'move', toStageId: stages[1].id });
    const events = store.events(ctx);
    const version = await store.retained.publish(ctx, { operationId: 'kept-file', projectId: project.id, kind: 'asset', filename: 'reference.txt' }, Buffer.from('Kept bytes'));
    store.close(); store = null;

    const db = new DatabaseSync(path.join(dataDir, 'frameboard.db'));
    try {
      db.exec(`PRAGMA foreign_keys = OFF;
        DROP TABLE card_templates;
        ALTER TABLE projects DROP COLUMN template_id;`);
      if (layout !== 'repaired-v20') db.exec(`ALTER TABLE projects DROP COLUMN archive_generation;
        ALTER TABLE retained_versions DROP COLUMN filename;`);
      if (!layout.startsWith('merged') && !layout.startsWith('repaired')) {
        db.exec(`DROP TABLE saved_outputs;
          ALTER TABLE retained_objects DROP COLUMN folder_id;
          DROP TABLE library_folders;`);
        if (layout === 'delivery-v16') db.exec('DROP TABLE library_drafts;');
        else db.exec('ALTER TABLE chat_attempts DROP COLUMN delivery;');
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(layout.match(/v(\d+)$/)[1]);
    } finally { db.close(); }

    store = await openStore({ dataDir });
    assert.deepEqual(store.events(ctx), events);
    assert.deepEqual(store.getCard(ctx, card.id).card, moved.card);
    const upgradedVersion = store.retained.version(ctx, version.id);
    assert.equal(upgradedVersion.filename, 'reference.txt');
    assert.equal(upgradedVersion.hash, version.hash);
    const chunks = [];
    for await (const chunk of await store.retained.read(ctx, version.id)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'Kept bytes');
    store.undoMove(ctx, card.id, { moveId: moved.card.lastMove.id, revision: moved.card.revision });
    store.archiveProject(ctx, project.id);
    store.close(); store = null;

    const checked = new DatabaseSync(path.join(dataDir, 'frameboard.db'), { readOnly: true });
    try {
      assert.equal(checked.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(supportedSchemaVersion));
      assert.equal(checked.prepare('SELECT archive_generation FROM projects WHERE id = ?').get(project.id).archive_generation, 1);
      assert.equal(checked.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(checked.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(checked.prepare('SELECT template_id FROM projects WHERE id = ?').get(project.id).template_id, 'youtube-video');
      for (const name of ['library_drafts', 'library_folders', 'saved_outputs', 'card_templates']) {
        assert.ok(checked.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
      }
      assert.ok(checked.prepare("SELECT name FROM pragma_table_info('chat_attempts') WHERE name = 'delivery'").get());
    } finally { checked.close(); }
    store = await openStore({ dataDir });
    assert.equal(store.getCard(ctx, card.id).card.title, 'Keep this card');
  });
}
