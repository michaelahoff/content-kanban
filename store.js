// All database access lives here. Every read and write is scoped to a
// workspace and attributed to an actor ("user:<id>", "automation:<id>", or
// "system:<name>") so more users and automatic steps can be added later.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { templates, defaultTemplate, emptyFields, emptyImageRoles } from './public/card-template.js';
import { readLegacyBoard } from './legacy-board.js';
import { createPlaybooks } from './playbooks.js';
import { parseDocument, playbookSettings, describeSettings } from './public/playbook-format.js';
import { chatMigration, recoveryMigration, createChatStore, archivedMessage } from './store-chat.js';
import { protectionMigration, createProtectionStore } from './store-protection.js';
import { imagesMigration, createImageStore } from './store-images.js';
import { retainedMigration, createRetainedMetadata } from './store-retained.js';
import { createRetainedStorage } from './retained-storage.js';
import { createLibrary } from './library.js';
import { libraryDraftsMigration, createDraftStore } from './store-drafts.js';

export const imageIdPattern = /^[a-f0-9-]{36}\.(png|jpg|webp|gif|avif)$/;

// Backup reads never migrate or recover app state. VACUUM includes SQLite's
// current committed contents, including WAL data, in one standalone database.
export function snapshotDatabase(filename, destination) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); }
  finally { db.close(); }
}

// Restore marks the staged database before activation. The next open applies
// the recovery hold in one commit, before the app creates any worker.
export function markRestored(filename, details) {
  const db = new DatabaseSync(filename);
  // A restored workspace exported before it was ever opened still carries a marker.
  try { db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('restore_recovery', ?)").run(JSON.stringify(details)); }
  finally { db.close(); }
}

export function inspectBackupDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('The database failed its integrity or foreign-key check.');
    const images = new Map(db.prepare('SELECT id, hash FROM image_versions').all().map((image) => [image.id, image]));
    const include = (references) => {
      for (const image of references ?? []) {
        if (!imageIdPattern.test(image.id)) throw new Error('The database contains an invalid image version.');
        const existing = images.get(image.id);
        if (existing?.hash && image.hash && existing.hash !== image.hash) throw new Error(`Conflicting image hashes: ${image.id}`);
        images.set(image.id, { id: image.id, hash: existing?.hash ?? image.hash ?? null });
      }
    };
    for (const row of db.prepare('SELECT images FROM cards').all()) include(JSON.parse(row.images));
    for (const row of db.prepare('SELECT snapshot FROM saved_card_states').all()) include(JSON.parse(row.snapshot).images);
    for (const row of db.prepare('SELECT before_card, after_card FROM card_moves').all()) { include(JSON.parse(row.before_card).images); include(JSON.parse(row.after_card).images); }
    for (const row of db.prepare('SELECT frozen FROM chat_submissions').all()) include(JSON.parse(row.frozen).context.images);
    const nativeThreads = [...new Set(db.prepare("SELECT binding FROM chat_conversations WHERE provider = 'codex' AND binding IS NOT NULL").all()
      .map((row) => JSON.parse(row.binding).threadId).filter((id) => /^[a-f0-9-]{36}$/.test(id)))];
    const table = (name) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    // Every committed version is required, including superseded, removed and
    // unavailable ones; unfinished publications are not retained content.
    const retained = table('retained_versions') ? db.prepare(`SELECT v.id, v.object_id, o.project_id, o.kind, o.filename AS label, v.filename, v.hash, v.size, v.base_version_id,
      o.current_version_id = v.id AS current, o.removed_at IS NOT NULL AS removed FROM retained_versions v JOIN retained_objects o ON o.id = v.object_id
      WHERE v.state = 'committed' ORDER BY v.rowid`).all().map((row) => ({ versionId: row.id, objectId: row.object_id, projectId: row.project_id, kind: row.kind,
      label: row.label, filename: row.filename, path: `retained/versions/${row.id}`, size: row.size, sha256: row.hash, current: Boolean(row.current), removed: Boolean(row.removed),
      baseVersionId: row.base_version_id })) : [];
    for (const version of retained) if (!/^[a-f0-9-]{36}$/.test(version.versionId) || !/^[a-f0-9]{64}$/.test(version.sha256 ?? '') || !Number.isSafeInteger(version.size)) throw new Error('The database contains an invalid retained version.');
    // Frozen submissions name the exact Library versions they captured; each
    // must be a retained committed version with the recorded hash and size.
    const versions = new Map(retained.map((version) => [version.versionId, version]));
    for (const row of db.prepare('SELECT id, frozen FROM chat_submissions').all()) for (const file of JSON.parse(row.frozen).context.library ?? []) {
      const version = versions.get(file.versionId);
      if (version?.sha256 !== file.hash || version.size !== file.size) throw new Error(`Submission ${row.id} references Library version ${file.versionId}, which is not retained with its recorded hash and size.`);
    }
    const archived = db.prepare("SELECT name FROM pragma_table_info('projects') WHERE name = 'archived_at'").get() ? 'archived_at' : 'NULL';
    const projects = db.prepare(`SELECT id, name, flow_id, ${archived} AS archived_at, deleted_at FROM projects ORDER BY position, rowid`).all()
      .map((row) => ({ id: row.id, name: row.name, flowId: row.flow_id, archivedAt: row.archived_at, deletedAt: row.deleted_at }));
    // Row counts let a restore compare complete store coverage, not just files.
    const tables = Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT count(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count]));
    // Saved outputs are retained image versions; unsaved ones only name a native file.
    const outputs = table('chat_outputs') ? db.prepare('SELECT id, card_id, attempt_id, import_status, image_id, provenance FROM chat_outputs ORDER BY rowid').all()
      .map((row) => ({ outputId: row.id, cardId: row.card_id, attemptId: row.attempt_id, importStatus: row.import_status, imageId: row.image_id,
        savedPath: JSON.parse(row.provenance).native?.savedPath ?? null })) : [];
    for (const output of outputs) if (output.importStatus === 'imported' && !images.has(output.imageId)) throw new Error(`Saved output ${output.outputId} has no retained image version.`);
    return { schemaVersion: db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value, images: [...images.values()], nativeThreads, retained, projects, tables, outputs };
  } finally { db.close(); }
}

export const laneColors = ['lavender', 'blue', 'amber', 'green', 'pink', 'gray', 'teal', 'cyan', 'orange', 'red', 'purple', 'lime'];
const defaultStages = [['Ideas', 'lavender'], ['In progress', 'blue'], ['Review', 'amber'], ['Done', 'green']];
const idPattern = /^[\w-]{1,100}$/;
const criterionRules = { field: 'filled', imageRole: 'set' };
// Released migration text embeds the retired lane command graph's empty value.
const emptyGraphJson = '{"version":1,"nodes":[{"id":"entry","type":"entry","position":{"x":48,"y":100}}],"edges":[]}';

// Each entry upgrades the schema by one version. Never edit a released entry;
// append a new one instead.
const migrations = [`
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE flows (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE stages (
    id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id), name TEXT NOT NULL, color TEXT NOT NULL, position INTEGER NOT NULL,
    instructions TEXT NOT NULL DEFAULT '', exit_criteria TEXT NOT NULL DEFAULT '[]',
    approve_to TEXT REFERENCES stages(id), send_back_to TEXT REFERENCES stages(id),
    automations TEXT NOT NULL DEFAULT '[]', deleted_at TEXT);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), flow_id TEXT NOT NULL REFERENCES flows(id),
    name TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT);
  CREATE TABLE cards (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), stage_id TEXT NOT NULL REFERENCES stages(id),
    position REAL NOT NULL, template TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    fields TEXT NOT NULL DEFAULT '{}', images TEXT NOT NULL DEFAULT '[]', image_roles TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1, entered_stage_at TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
  CREATE INDEX cards_by_stage ON cards(stage_id, position) WHERE deleted_at IS NULL;
  CREATE INDEX cards_by_project ON cards(project_id) WHERE deleted_at IS NULL;
  CREATE TABLE card_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT NOT NULL,
    card_id TEXT NOT NULL REFERENCES cards(id), type TEXT NOT NULL, actor TEXT NOT NULL,
    from_stage_id TEXT, to_stage_id TEXT, note TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
  CREATE INDEX card_events_by_card ON card_events(card_id, id);
  CREATE INDEX card_events_by_workspace ON card_events(workspace_id, id);
  CREATE TABLE workspace_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    entity TEXT NOT NULL, entity_id TEXT NOT NULL, project_id TEXT, type TEXT NOT NULL,
    actor TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
  CREATE INDEX changes_by_workspace ON workspace_changes(workspace_id, id);
`, `ALTER TABLE stages ADD COLUMN entry_prompt TEXT;`, `
  ALTER TABLE stages ADD COLUMN entry_graph TEXT NOT NULL DEFAULT '${emptyGraphJson}';
  UPDATE stages SET entry_graph = json_object('version', 1,
    'nodes', json_array(
      json_object('id', 'entry', 'type', 'entry', 'position', json_object('x', 48, 'y', 100)),
      json_object('id', 'set-prompt', 'type', 'set', 'position', json_object('x', 360, 'y', 100),
        'config', json_object('field', 'prompt', 'value', entry_prompt))),
    'edges', json_array(json_object('id', 'entry-prompt', 'from', 'entry', 'to', 'set-prompt')))
    WHERE entry_prompt IS NOT NULL;
`, `
  CREATE TABLE card_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES cards(id),
    event_id INTEGER REFERENCES card_events(id), before_card TEXT NOT NULL, after_card TEXT NOT NULL,
    placement TEXT NOT NULL, created_at TEXT NOT NULL, undone_at TEXT, undo_event_id INTEGER REFERENCES card_events(id));
  CREATE INDEX card_moves_by_card ON card_moves(card_id, id);
`, `
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    entity TEXT NOT NULL, entity_id TEXT NOT NULL, project_id TEXT, type TEXT NOT NULL,
    actor TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
    card_event_id INTEGER UNIQUE, legacy_change_id INTEGER UNIQUE,
    from_stage_id TEXT, to_stage_id TEXT, note TEXT NOT NULL DEFAULT '', context TEXT);
  CREATE INDEX activity_by_workspace ON activity_log(workspace_id, id);
  CREATE INDEX activity_by_entity ON activity_log(workspace_id, entity, entity_id, id);
  -- Merge only unambiguous pairs emitted by the old insertEvent boundary.
  -- Keep old feed IDs, so existing browser cursors remain valid.
  WITH pairs AS (
    SELECT c.id AS change_id, e.id AS event_id,
      COUNT(*) OVER (PARTITION BY c.id) AS change_matches,
      COUNT(*) OVER (PARTITION BY e.id) AS event_matches
    FROM workspace_changes c JOIN card_events e ON c.entity = 'card'
      AND c.workspace_id = e.workspace_id AND c.entity_id = e.card_id
      AND c.project_id = e.project_id AND c.type = e.type AND c.actor = e.actor
      AND c.data = e.data AND c.created_at = e.created_at)
  INSERT INTO activity_log (id, workspace_id, entity, entity_id, project_id, type, actor, data, created_at,
    card_event_id, legacy_change_id, from_stage_id, to_stage_id, note)
  SELECT c.id, c.workspace_id, c.entity, c.entity_id, c.project_id, c.type, c.actor, c.data, c.created_at,
    e.id, c.id, e.from_stage_id, e.to_stage_id, COALESCE(e.note, '')
  FROM workspace_changes c LEFT JOIN pairs p ON p.change_id = c.id AND p.change_matches = 1 AND p.event_matches = 1
    LEFT JOIN card_events e ON e.id = p.event_id ORDER BY c.id;
  INSERT INTO activity_log (workspace_id, entity, entity_id, project_id, type, actor, data, created_at,
    card_event_id, from_stage_id, to_stage_id, note)
  SELECT e.workspace_id, 'card', e.card_id, e.project_id, e.type, e.actor, e.data, e.created_at,
    e.id, e.from_stage_id, e.to_stage_id, e.note FROM card_events e
  WHERE NOT EXISTS (SELECT 1 FROM activity_log a WHERE a.card_event_id = e.id) ORDER BY e.id;
  CREATE TABLE saved_card_states (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    card_id TEXT NOT NULL REFERENCES cards(id), activity_id INTEGER NOT NULL REFERENCES activity_log(id),
    source TEXT NOT NULL, actor TEXT NOT NULL, snapshot TEXT NOT NULL,
    editing_session_id TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT);
  CREATE INDEX saved_states_by_card ON saved_card_states(workspace_id, card_id, id);
  -- Move history IDs now refer to the compatibility projection of activity.
  ALTER TABLE card_moves RENAME TO legacy_card_moves;
  CREATE TABLE card_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES cards(id),
    event_id INTEGER REFERENCES activity_log(card_event_id), before_card TEXT NOT NULL, after_card TEXT NOT NULL,
    placement TEXT NOT NULL, created_at TEXT NOT NULL, undone_at TEXT,
    undo_event_id INTEGER REFERENCES activity_log(card_event_id));
  INSERT INTO card_moves SELECT * FROM legacy_card_moves;
  DROP TABLE legacy_card_moves;
  CREATE INDEX card_moves_by_card ON card_moves(card_id, id);
`, `
  CREATE TABLE provider_configurations (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id), provider TEXT NOT NULL,
    revision INTEGER NOT NULL, selection TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, provider));
`, chatMigration, protectionMigration, imagesMigration, recoveryMigration, `
  CREATE TABLE provider_catalogs (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id), provider TEXT NOT NULL,
    discovery TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, provider));
`, `
  -- Some databases already reached v5 before move foreign keys were repaired.
  -- Their schema version alone cannot distinguish them from correct databases.
  ALTER TABLE card_moves RENAME TO legacy_card_moves;
  CREATE TABLE card_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES cards(id),
    event_id INTEGER REFERENCES activity_log(card_event_id), before_card TEXT NOT NULL, after_card TEXT NOT NULL,
    placement TEXT NOT NULL, created_at TEXT NOT NULL, undone_at TEXT,
    undo_event_id INTEGER REFERENCES activity_log(card_event_id));
  INSERT INTO card_moves SELECT * FROM legacy_card_moves;
  DROP TABLE legacy_card_moves;
  CREATE INDEX card_moves_by_card ON card_moves(card_id, id);
`, `
  -- A lane run is one execution of a lane playbook for a card. Once queued, its
  -- card chat submission owns delivery status; the run keeps the outcome.
  CREATE TABLE lane_runs (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), card_id TEXT NOT NULL REFERENCES cards(id),
    stage_id TEXT NOT NULL REFERENCES stages(id), move_id INTEGER, trigger TEXT NOT NULL, status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '', submission_id TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX lane_runs_by_card ON lane_runs(card_id, created_at);
  CREATE INDEX lane_runs_by_status ON lane_runs(workspace_id, status);
`, retainedMigration, `
  -- Archive (#49) takes a project out of active use. The revocation columns are
  -- a persistent effect fence: once set, no restart, unarchive or late native
  -- callback returns authority to that attempt, or Retry to that submission.
  ALTER TABLE projects ADD COLUMN archived_at TEXT;
  ALTER TABLE projects ADD COLUMN archive_generation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_attempts ADD COLUMN revoked TEXT;
  ALTER TABLE chat_submissions ADD COLUMN revoked TEXT;
  UPDATE chat_attempts SET revoked = 'stopped' WHERE cause = 'user';
`, libraryDraftsMigration, `
  -- What each delivery attempt actually did with a submission's inputs.
  ALTER TABLE chat_attempts ADD COLUMN delivery TEXT;
`];

// The newest schema this version can open; restore refuses newer backups.
export const supportedSchemaVersion = migrations.length;
const now = () => new Date().toISOString();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const check = (value, message) => { if (!value) fail(400, message); };
const isText = (value, max) => typeof value === 'string' && value.length <= max;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const checkName = (value, max, message) => check(isText(value, max) && value.trim(), message);

const stageFrom = (row) => ({
  id: row.id, flowId: row.flow_id, name: row.name, color: row.color, position: row.position, instructions: row.instructions,
  exitCriteria: JSON.parse(row.exit_criteria), approveTo: row.approve_to, sendBackTo: row.send_back_to, automations: JSON.parse(row.automations),
});
const cardFrom = (row) => ({
  id: row.id, projectId: row.project_id, stageId: row.stage_id, position: row.position, template: row.template, title: row.title,
  fields: JSON.parse(row.fields), images: JSON.parse(row.images), imageRoles: JSON.parse(row.image_roles), revision: row.revision,
  enteredStageAt: row.entered_stage_at, createdAt: row.created_at, updatedAt: row.updated_at,
});
const eventFrom = (row) => ({
  id: row.id, cardId: row.card_id, projectId: row.project_id, type: row.type, actor: row.actor, fromStageId: row.from_stage_id,
  toStageId: row.to_stage_id, note: row.note, data: JSON.parse(row.data), createdAt: row.created_at,
});
const changeFrom = (row) => ({
  id: row.id, entity: row.entity, entityId: row.entity_id, projectId: row.project_id,
  type: row.type, actor: row.actor, data: JSON.parse(row.data), createdAt: row.created_at,
});
const activityEventFrom = (row) => eventFrom({ ...row, id: row.card_event_id, card_id: row.entity_id });
const savedStateFrom = (row) => ({
  id: row.id, cardId: row.card_id, activityId: row.activity_id, source: row.source, actor: row.actor,
  snapshot: JSON.parse(row.snapshot), startedAt: row.started_at, updatedAt: row.updated_at, closedAt: row.closed_at,
});

// Applies a partial content update to a card and checks the result.
function cardContent(templateId, input, current, validateMembership = true) {
  const template = templates[templateId];
  const next = { title: current.title, fields: { ...current.fields }, images: current.images, imageRoles: { ...current.imageRoles } };
  if ('title' in input) {
    check(isText(input.title, template.title.max), `Card titles can be up to ${template.title.max} characters.`);
    next.title = input.title;
  }
  if ('fields' in input) {
    check(isObject(input.fields), 'Invalid card fields.');
    for (const [key, value] of Object.entries(input.fields)) {
      const field = template.fields.find((item) => item.key === key);
      check(field, `Unknown card field “${key}”.`);
      check(isText(value, field.max), `${field.label} must be text of up to ${field.max.toLocaleString('en-US')} characters.`);
      next.fields[key] = value;
    }
  }
  if ('images' in input) {
    check(Array.isArray(input.images) && input.images.length <= 200, 'A card can hold up to 200 images.');
    const seen = new Set();
    for (const image of input.images) {
      check(isObject(image) && imageIdPattern.test(image.id) && isText(image.name, 500) && !seen.has(image.id), 'Invalid image.');
      seen.add(image.id);
    }
    next.images = input.images.map(({ id, name }) => ({ id, name }));
  }
  if ('imageRoles' in input) {
    check(isObject(input.imageRoles), 'Invalid image flags.');
    for (const [role, imageId] of Object.entries(input.imageRoles)) {
      check(role in next.imageRoles, `Unknown image flag “${role}”.`);
      check(imageId === null || typeof imageId === 'string', 'Invalid image flags.');
      next.imageRoles[role] = imageId;
    }
  }
  for (const [role, imageId] of validateMembership ? Object.entries(next.imageRoles) : []) {
    check(imageId === null || next.images.some((image) => image.id === imageId), role === 'cover' ? 'The display image must belong to the card.' : 'Flagged images must belong to the card.');
  }
  return next;
}

function checkCriteria(value) {
  check(Array.isArray(value) && value.length <= 50, 'Exit criteria must be a list of up to 50 checks.');
  for (const item of value) {
    const kind = Object.keys(criterionRules).find((key) => key in (item || {}));
    check(isObject(item) && kind && isText(item[kind], 100) && item.rule === criterionRules[kind] && (item.label === undefined || isText(item.label, 200)), 'Each exit criterion needs a field with rule "filled" or an imageRole with rule "set".');
  }
}

function rejectCommands(input) {
  check(!('entryPrompt' in input) && !('entryGraph' in input), 'Lane commands are now lane playbooks. Put Set field values in the playbook’s set: setting.');
}
// The Set field values a retired command graph applied, in its run order:
// independent commands ran in saved node order once their inputs had run.
function legacySetValues(graph) {
  const values = {};
  const remaining = new Set(graph.nodes.map((node) => node.id));
  while (remaining.size) {
    const next = graph.nodes.find((node) => remaining.has(node.id) && !graph.edges.some((edge) => edge.to === node.id && remaining.has(edge.from)));
    if (!next) break;
    remaining.delete(next.id);
    if (next.type !== 'set') continue;
    for (const { field, value } of next.config.assignments ?? [next.config]) values[field] = value;
  }
  return values;
}

// Lists the exit criteria of a stage that a card does not meet yet.
function unmetCriteria(stage, card) {
  return stage.exitCriteria.filter((item) => item.field
    ? !String(item.field === 'title' ? card.title : card.fields[item.field] ?? '').trim()
    : !card.imageRoles[item.imageRole]).map((item) => item.label || (item.field ? `${item.field} is filled` : `${item.imageRole} image is set`));
}

export async function openStore({ dataDir, onCardEvent = () => {}, onCommit = () => {}, clock = now, retainedCheckpoint, playbooks = createPlaybooks({ dataDir }) }) {
  const now = clock;
  const file = path.join(dataDir, 'frameboard.db');
  const legacyFile = path.join(dataDir, 'board.json');
  const created = !existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  let pendingEvents = [];
  let depth = 0;
  // Runs fn atomically. Event hooks fire only after the data is committed.
  const transaction = (fn) => {
    if (depth) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth++;
    try {
      const result = fn();
      db.exec('COMMIT');
      const events = pendingEvents;
      pendingEvents = [];
      for (const event of events) {
        try { onCardEvent(event); } catch (error) { console.error(error); }
      }
      try { onCommit(); } catch (error) { console.error(error); }
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      pendingEvents = [];
      if (String(error.code).startsWith('ERR_SQLITE') && /UNIQUE|PRIMARY KEY/.test(error.message)) fail(400, 'Invalid or duplicate ID.');
      throw error;
    } finally { depth--; }
  };

  const schemaVersion = () => (get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    ? Number(get("SELECT value FROM meta WHERE key = 'schema_version'")?.value || 0) : 0);

  function insertFlow(workspaceId, name, stages) {
    const flowId = randomUUID();
    run('INSERT INTO flows (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)', flowId, workspaceId, name, now());
    stages.forEach(([id, stageName, color], position) => run('INSERT INTO stages (id, flow_id, name, color, position) VALUES (?, ?, ?, ?, ?)', id, flowId, stageName, color, position));
    return flowId;
  }
  function insertEvent(workspaceId, card, type, actor, { from = null, to = null, note = '', data = {}, at = now() } = {}) {
    const eventId = (get('SELECT MAX(card_event_id) AS id FROM activity_log').id ?? 0) + 1;
    const activityId = recordChange({ workspaceId, actor }, 'card', card.id, type,
      { projectId: card.projectId, data, at, eventId, from, to, note });
    const event = activityEventFrom(get('SELECT * FROM activity_log WHERE id = ?', activityId));
    pendingEvents.push(event);
    return event;
  }
  // One append-only log serves activity and the synchronization feed. Legacy
  // card history is a filtered projection; the old tables are migration input.
  function recordChange(ctx, entity, entityId, type, { projectId = null, data = {}, at = now(), eventId = null, from = null, to = null, note = '' } = {}) {
    const card = ['card', 'chat'].includes(entity) ? get('SELECT title, stage_id FROM cards WHERE id = ?', entityId) : null;
    const context = {
      projectName: projectId ? get('SELECT name FROM projects WHERE id = ?', projectId)?.name : undefined,
      cardTitle: card?.title,
      stageName: get('SELECT name FROM stages WHERE id = ?', card?.stage_id ?? (entity === 'stage' ? entityId : ''))?.name,
      fromStageName: from ? get('SELECT name FROM stages WHERE id = ?', from)?.name : undefined,
      toStageName: to ? get('SELECT name FROM stages WHERE id = ?', to)?.name : undefined,
    };
    const { lastInsertRowid } = run(`INSERT INTO activity_log
      (workspace_id, entity, entity_id, project_id, type, actor, data, created_at, card_event_id, from_stage_id, to_stage_id, note, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.workspaceId, entity, entityId, projectId, type, ctx.actor, JSON.stringify(data), at, eventId, from, to, note, JSON.stringify(context));
    return Number(lastInsertRowid);
  }

  function retainedCard(ctx, id) {
    const row = get('SELECT c.*, p.archived_at AS project_archived_at FROM cards c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.workspace_id = ?', id, ctx.workspaceId);
    return row || fail(404, 'This card does not exist.');
  }
  function snapshotFor(row) {
    const order = all('SELECT id FROM cards WHERE stage_id = ? AND deleted_at IS NULL ORDER BY position', row.stage_id);
    const index = order.findIndex((item) => item.id === row.id);
    return { ...cardFrom(row), deletedAt: row.deleted_at,
      placement: { index: index < 0 ? null : index, beforeCardId: index < 0 ? null : order[index + 1]?.id ?? null, afterCardId: index > 0 ? order[index - 1].id : null } };
  }
  function recordSavedState(ctx, id, source, at, editingSessionId = null) {
    const row = retainedCard(ctx, id);
    const activityId = get("SELECT MAX(id) AS id FROM activity_log WHERE workspace_id = ? AND entity = 'card' AND entity_id = ?", ctx.workspaceId, id).id;
    const snapshot = JSON.stringify(snapshotFor(row));
    const previous = get('SELECT * FROM saved_card_states WHERE workspace_id = ? AND card_id = ? ORDER BY id DESC LIMIT 1', ctx.workspaceId, id);
    const grouped = source === 'editing_session' && editingSessionId && previous?.source === source
      && previous.actor === ctx.actor && previous.editing_session_id === editingSessionId && !previous.closed_at
      && Date.parse(at) - Date.parse(previous.updated_at) < 120000;
    if (grouped) {
      run('UPDATE saved_card_states SET snapshot = ?, activity_id = ?, updated_at = ? WHERE id = ?', snapshot, activityId, at, previous.id);
    } else {
      if (previous && !previous.closed_at) run('UPDATE saved_card_states SET closed_at = ? WHERE id = ?', at, previous.id);
      run(`INSERT INTO saved_card_states (workspace_id, card_id, activity_id, source, actor, snapshot, editing_session_id, started_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ctx.workspaceId, id, activityId, source, ctx.actor, snapshot, editingSessionId, at, at,
      source === 'editing_session' && editingSessionId ? null : at);
    }
  }
  function recordMissingBaselines() {
    const at = now();
    for (const row of all(`SELECT c.id, c.project_id, p.workspace_id FROM cards c JOIN projects p ON p.id = c.project_id
      WHERE NOT EXISTS (SELECT 1 FROM saved_card_states s WHERE s.card_id = c.id)`)) {
      const ctx = { workspaceId: row.workspace_id, actor: 'system:history-migration' };
      recordChange(ctx, 'card', row.id, 'history_begins', { projectId: row.project_id, data: { reason: 'Saved card states begin here; earlier states were not reconstructed.' }, at });
      recordSavedState(ctx, row.id, 'history_begins', at);
    }
  }

  // A lane playbook's set: values apply in the same transaction as creation or
  // movement. The revision before them lets a client acknowledge just these
  // fields without treating another tab's unseen content as its own draft.
  function applyEntrySet(ctx, card, stage, at) {
    const found = playbooks.settings(stage.flowId, stage.id, card.template);
    if (!found || found.settings.errors.length || !Object.keys(found.settings.set).length) return null;
    const values = found.settings.set;
    const changedFields = Object.keys(values).filter((key) => values[key] !== (key === 'title' ? card.title : card.fields[key]));
    const revision = card.revision + Number(changedFields.length > 0);
    if (changedFields.length) {
      const fields = { ...card.fields, ...Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'title')) };
      run('UPDATE cards SET title = ?, fields = ?, revision = ?, updated_at = ? WHERE id = ?',
        values.title ?? card.title, JSON.stringify(fields), revision, at, card.id);
      insertEvent(ctx.workspaceId, card, 'fields_set', `automation:${stage.id}`, { to: stage.id, data: { fields: changedFields, playbook: found.document.path, playbookHash: found.document.hash, revision }, at });
    }
    return { beforeRevision: card.revision, revision, values };
  }

  // Lane runs: an on-enter playbook asks for one when a card arrives; the lane
  // runner turns pending runs into card chat submissions after the commit.
  const laneRunFrom = (row) => row && ({ id: row.id, cardId: row.card_id, stageId: row.stage_id, moveId: row.move_id, trigger: row.trigger,
    status: row.status, reason: row.reason, submissionId: row.submission_id, result: row.result ? JSON.parse(row.result) : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
    submissionStatus: row.submission_id ? get('SELECT status FROM chat_submissions WHERE id = ?', row.submission_id)?.status ?? null : null });
  function requestLaneRun(ctx, card, stage, trigger, moveId = null) {
    const found = playbooks.settings(stage.flowId, stage.id, card.template);
    if (!found) return null;
    const { settings } = found;
    if (trigger === 'enter' && (settings.run !== 'on-enter' || !settings.instructions)) return null;
    const id = randomUUID(); const at = now();
    const problem = settings.errors.length ? `The playbook ${found.document.path} has errors: ${settings.errors.join(' ')}`
      : !settings.instructions ? 'This lane playbook has no instructions to run.' : settings.run === 'off' ? 'This lane playbook is turned off (run: off).' : '';
    run('INSERT INTO lane_runs (id, workspace_id, card_id, stage_id, move_id, trigger, status, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, ctx.workspaceId, card.id, stage.id, moveId, trigger, problem ? 'failed' : 'pending', problem, at, at);
    recordChange(ctx, 'card', card.id, problem ? 'lane_run_failed' : 'lane_run_requested', { projectId: card.projectId, data: { laneRunId: id, stageId: stage.id, trigger, reason: problem }, at });
    return id;
  }
  // Cancels runs that have not started work. Running replies finish; their
  // result arrives as proposals because the card is no longer in that lane.
  function cancelLaneRuns(ctx, cardId, keep, reason) {
    for (const row of all("SELECT * FROM lane_runs WHERE card_id = ? AND status IN ('pending', 'queued', 'held')", cardId)) {
      if (keep(row)) continue;
      if (row.submission_id && row.status !== 'pending') {
        if (!chats.cancelQueued(ctx, row.submission_id, reason)) continue;
      }
      run("UPDATE lane_runs SET status = 'cancelled', reason = ?, updated_at = ? WHERE id = ?", reason, now(), row.id);
    }
  }

  // First run: create the schema, then import board.json or start fresh.
  async function initialize() {
    const legacy = await readLegacyBoard(legacyFile);
    transaction(() => {
      for (const sql of migrations) db.exec(sql);
      run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", String(supportedSchemaVersion));
      const workspaceId = randomUUID();
      const userId = randomUUID();
      run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', workspaceId, 'Personal workspace', now());
      run('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)', userId, 'You', now());
      run("INSERT INTO meta (key, value) VALUES ('owner_user_id', ?), ('owner_workspace_id', ?)", userId, workspaceId);
      const projects = legacy?.board.projects ?? [{ id: randomUUID(), name: 'My project', lanes: defaultStages.map(([name, color]) => ({ id: randomUUID(), name, color, cards: [] })) }];
      projects.forEach((project, projectIndex) => {
        const flowId = insertFlow(workspaceId, project.name, project.lanes.map((lane) => [lane.id, lane.name, lane.color]));
        run('INSERT INTO projects (id, workspace_id, flow_id, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?)', project.id, workspaceId, flowId, project.name, projectIndex, now());
        for (const lane of project.lanes) lane.cards.forEach((card, cardIndex) => {
          const fields = Object.fromEntries(Object.keys(emptyFields()).map((key) => [key, card[key] ?? '']));
          const imageRoles = { cover: card.coverImageId ?? null, original: card.originalImageId ?? null, inspiration: card.inspirationImageId ?? null };
          run('INSERT INTO cards (id, project_id, stage_id, position, template, title, fields, images, image_roles, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            card.id, project.id, lane.id, cardIndex + 1, defaultTemplate, card.title, JSON.stringify(fields), JSON.stringify(card.images), JSON.stringify(imageRoles), card.updatedAt ?? null);
          insertEvent(workspaceId, { id: card.id, projectId: project.id }, 'created', `user:${userId}`, { to: lane.id, at: card.updatedAt ?? now() });
        });
      });
      recordMissingBaselines();
    });
    if (legacy) {
      let target = `${legacyFile}.migrated`;
      if (existsSync(target)) target += `-${Date.now()}`;
      await rename(legacyFile, target);
    }
  }

  try {
    if (!schemaVersion()) await initialize();
    const version = schemaVersion();
    if (version > supportedSchemaVersion) throw new Error('This data was saved by a newer version of Frameboard.');
    if (version < supportedSchemaVersion) transaction(() => {
      for (const sql of migrations.slice(version)) db.exec(sql);
      recordMissingBaselines();
      run("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(supportedSchemaVersion));
    });
  } catch (error) {
    db.close();
    if (created) await rm(file, { force: true });
    throw error;
  }

  const meta = (key) => get('SELECT value FROM meta WHERE key = ?', key)?.value;
  const owner = { userId: meta('owner_user_id'), workspaceId: meta('owner_workspace_id') };

  const activeStages = (flowId) => all('SELECT * FROM stages WHERE flow_id = ? AND deleted_at IS NULL ORDER BY position', flowId).map(stageFrom);
  // Every flow gets a playbook folder with a starter map, and retired lane
  // command graphs become set: values in their lane's playbook. The file is
  // written before the graph is cleared, so a crash only repeats a no-op.
  try {
    for (const flow of all('SELECT f.id, p.name FROM flows f JOIN projects p ON p.flow_id = f.id WHERE p.deleted_at IS NULL')) {
      playbooks.ensure(flow.id, { projectName: flow.name, lanes: activeStages(flow.id) });
    }
    for (const row of all('SELECT * FROM stages WHERE entry_graph != ?', emptyGraphJson)) {
      const values = legacySetValues(JSON.parse(row.entry_graph));
      // A lane that already has a playbook keeps its old graph untouched
      // rather than losing values that could not be merged automatically.
      if (Object.keys(values).length && !row.deleted_at && !playbooks.migrateSet(row.flow_id, stageFrom(row), values)) continue;
      transaction(() => run('UPDATE stages SET entry_graph = ? WHERE id = ?', emptyGraphJson, row.id));
    }
  } catch (error) {
    db.close();
    throw error;
  }
  // Lane playbook summaries for the board, read once per flow.
  function withPlaybooks(flowId, stages) {
    const documents = playbooks.lanes(flowId);
    return stages.map((stage) => {
      const document = documents.find((entry) => entry.laneId === stage.id);
      if (!document) return { ...stage, playbook: null };
      const settings = playbookSettings(parseDocument(document.text), defaultTemplate);
      return { ...stage, playbook: { path: document.path, hash: document.hash, run: settings.run, provider: settings.provider, model: settings.model,
        hasInstructions: Boolean(settings.instructions), errors: settings.errors, summary: describeSettings(settings, defaultTemplate) } };
    });
  }
  // Archived projects stay readable; only reads pass { allowArchived: true }.
  const checkActive = (row, allowArchived) => { if (row.archived_at && !allowArchived) fail(409, archivedMessage); return row; };
  function requireProject(ctx, id, { allowArchived = false } = {}) {
    return checkActive(get('SELECT * FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', id, ctx.workspaceId) || fail(404, 'This project no longer exists. Reload the page.'), allowArchived);
  }
  function requireStage(ctx, id) {
    const row = get(`SELECT s.*, (SELECT archived_at FROM projects WHERE flow_id = s.flow_id) AS archived_at FROM stages s JOIN flows f ON f.id = s.flow_id
      WHERE s.id = ? AND f.workspace_id = ? AND s.deleted_at IS NULL`, id, ctx.workspaceId);
    return row ? stageFrom(checkActive(row)) : fail(404, 'This lane no longer exists. Reload the page.');
  }
  function requireCard(ctx, id, { allowArchived = false } = {}) {
    const row = get(`SELECT c.*, p.archived_at FROM cards c JOIN projects p ON p.id = c.project_id
      WHERE c.id = ? AND p.workspace_id = ? AND c.deleted_at IS NULL AND p.deleted_at IS NULL`, id, ctx.workspaceId);
    return row ? withLastMove(cardFrom(checkActive(row, allowArchived))) : fail(404, 'This card no longer exists. Reload the page.');
  }
  function withLastMove(card) {
    const move = get('SELECT id, created_at, undone_at FROM card_moves WHERE card_id = ? ORDER BY id DESC LIMIT 1', card.id);
    return { ...card, fieldVersions: Object.fromEntries(all('SELECT field, version FROM card_field_versions WHERE card_id = ?', card.id).map((r) => [r.field, r.version])),
      placementVersion: get('SELECT placement_version FROM cards WHERE id = ?', card.id).placement_version, lastMove: move && !move.undone_at ? { id: move.id, createdAt: move.created_at } : null };
  }
  const orderedCards = (stageId, except = '') => all('SELECT id FROM cards WHERE stage_id = ? AND deleted_at IS NULL AND id != ? ORDER BY position', stageId, except);
  function undoAnchor(stageId, cardId, placement) {
    const rows = orderedCards(stageId, cardId);
    if (rows.some((row) => row.id === placement.beforeCardId)) return placement.beforeCardId;
    const previous = rows.findIndex((row) => row.id === placement.afterCardId);
    return rows[previous < 0 ? Math.min(placement.index, rows.length) : previous + 1]?.id ?? null;
  }
  function requireFlow(ctx, id) {
    const row = get('SELECT f.*, (SELECT archived_at FROM projects WHERE flow_id = f.id) AS archived_at FROM flows f WHERE f.id = ? AND f.workspace_id = ?', id, ctx.workspaceId);
    return checkActive(row || fail(404, 'This flow no longer exists. Reload the page.'));
  }
  const checkId = (id) => check(id === undefined || (typeof id === 'string' && idPattern.test(id)), 'Invalid or duplicate ID.');

  // Returns a sort position that places a card before another card in the
  // stage, or at the end. Renumbers the stage when positions get too close.
  function positionFor(stageId, beforeCardId, movingId = '') {
    const rows = all('SELECT id, position FROM cards WHERE stage_id = ? AND deleted_at IS NULL AND id != ? ORDER BY position', stageId, movingId);
    const index = beforeCardId ? rows.findIndex((row) => row.id === beforeCardId) : -1;
    if (index < 0) return rows.length ? Math.floor(rows.at(-1).position) + 1 : 1;
    const after = rows[index].position;
    const before = index ? rows[index - 1].position : after - 1;
    const middle = (before + after) / 2;
    if (middle > before && middle < after) return middle;
    rows.forEach((row, i) => run('UPDATE cards SET position = ? WHERE id = ?', i + 1, row.id));
    return index + 0.5;
  }
  function renumberStages(flowId, ordered) {
    ordered.forEach((stage, position) => run('UPDATE stages SET position = ? WHERE id = ?', position, stage.id));
    return activeStages(flowId);
  }
  function deleteCards(ctx, rows, reason) {
    const at = now();
    for (const row of rows) {
      chats.cancelCard(ctx, row.id, reason);
      run("UPDATE lane_runs SET status = 'cancelled', reason = ?, updated_at = ? WHERE card_id = ? AND status IN ('pending', 'queued', 'held')", reason, at, row.id);
      run('UPDATE cards SET deleted_at = ? WHERE id = ?', at, row.id);
      insertEvent(ctx.workspaceId, cardFrom(row), 'deleted', ctx.actor, { from: row.stage_id, data: { reason }, at });
      recordSavedState(ctx, row.id, 'deleted', at);
    }
  }

  const chats = createChatStore({ all, get, run, transaction, retainedCard, requireCard, recordChange, now });

  const protection = createProtectionStore({ all, get, run, transaction, requireCard, retainedCard, recordChange, now,
    laneEntry: (cardId) => api.laneRuns.entry(cardId),
    updateCard: (...args) => api.updateCard(...args), transitionCard: (...args) => api.transitionCard(...args), item: (...args) => chats.item(...args), registerOutput: (...args) => images.registered(...args) });
  // Adoption appends one exact version to the gallery. It never assigns a
  // role, and an already adopted version is not added again.
  function adoptImage(ctx, cardId, image, data) {
    const card = requireCard(ctx, cardId);
    if (card.images.some((entry) => entry.id === image.id)) return { card, adopted: false };
    if (protection.leased(cardId, 'images')) fail(409, 'This card has an unsaved gallery change. Save or discard it, then add the image again.');
    check(card.images.length < 200, 'A card can hold up to 200 images.');
    const at = now();
    run('UPDATE cards SET images = ?, revision = revision + 1, updated_at = ? WHERE id = ?', JSON.stringify([...card.images, image]), at, cardId);
    insertEvent(ctx.workspaceId, card, 'image_adopted', ctx.actor, { data: { ...data, imageId: image.id }, at });
    recordSavedState(ctx, cardId, 'image_adopted', at);
    return { card: requireCard(ctx, cardId), adopted: true };
  }
  const images = createImageStore({ all, get, run, transaction, retainedCard, recordChange, now, adopt: adoptImage, revoked: (attemptId) => chats.revocation(attemptId) });
  const api = {
    owner,
    playbooks,
    transaction,
    chats,
    protection,
    images,
    close: () => db.close(),

    providerConfiguration(ctx, provider = 'codex') {
      check(['codex', 'claude'].includes(provider), 'Unknown chat provider.');
      const row = get('SELECT * FROM provider_configurations WHERE workspace_id = ? AND provider = ?', ctx.workspaceId, provider);
      return row ? { provider, revision: row.revision, selection: JSON.parse(row.selection), updatedAt: row.updated_at }
        : { provider, revision: 0, selection: { instructions: '', selected: [], enabled: provider === 'codex' }, updatedAt: null };
    },

    saveProviderConfiguration(ctx, input, provider = 'codex') {
      this.providerConfiguration(ctx, provider);
      check(isObject(input) && Number.isInteger(input.revision), 'Configuration needs its current revision.');
      check(isObject(input.selection) && isText(input.selection.instructions, 50000) && Array.isArray(input.selection.selected)
        && input.selection.selected.length <= 500 && input.selection.selected.every((id) => isText(id, 4000))
        && (input.selection.enabled === undefined || typeof input.selection.enabled === 'boolean')
        && (input.selection.inherited === undefined || typeof input.selection.inherited === 'boolean'), 'Invalid provider selection.');
      return transaction(() => {
        const current = this.providerConfiguration(ctx, provider);
        if (current.revision !== input.revision) fail(409, 'Configuration changed in another tab. Reload before saving.');
        const selection = { instructions: input.selection.instructions, selected: [...new Set(input.selection.selected)].sort(),
          ...(input.selection.inherited ? { inherited: true } : {}),
          enabled: input.selection.enabled ?? current.selection.enabled ?? (provider === 'codex') };
        const revision = current.revision + 1;
        const at = now();
        run(`INSERT INTO provider_configurations (workspace_id, provider, revision, selection, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, provider) DO UPDATE SET revision = excluded.revision, selection = excluded.selection, updated_at = excluded.updated_at`, ctx.workspaceId, provider, revision, JSON.stringify(selection), at);
        recordChange(ctx, 'provider', provider, 'configuration_changed', { data: { revision }, at });
        return this.providerConfiguration(ctx, provider);
      });
    },

    providerCatalog(ctx, provider) {
      this.providerConfiguration(ctx, provider);
      const row = get('SELECT * FROM provider_catalogs WHERE workspace_id = ? AND provider = ?', ctx.workspaceId, provider);
      return row ? { discovery: JSON.parse(row.discovery), updatedAt: row.updated_at } : { discovery: null, updatedAt: null };
    },
    saveProviderCatalog(ctx, provider, discovery) {
      this.providerConfiguration(ctx, provider);
      return transaction(() => {
        const at = now();
        run(`INSERT INTO provider_catalogs VALUES (?, ?, ?, ?)
          ON CONFLICT (workspace_id, provider) DO UPDATE SET discovery = excluded.discovery, updated_at = excluded.updated_at`,
          ctx.workspaceId, provider, JSON.stringify(discovery), at);
        recordChange(ctx, 'provider', provider, 'catalog_refreshed', { at });
        return this.providerCatalog(ctx, provider);
      });
    },

    workspace(ctx) {
      const workspace = get('SELECT id, name FROM workspaces WHERE id = ?', ctx.workspaceId);
      const user = ctx.userId ? get('SELECT id, name FROM users WHERE id = ?', ctx.userId) : null;
      const projects = all(`SELECT p.id, p.name, p.flow_id, p.position, p.archived_at, (SELECT COUNT(*) FROM cards c WHERE c.project_id = p.id AND c.deleted_at IS NULL) AS card_count
        FROM projects p WHERE p.workspace_id = ? AND p.deleted_at IS NULL ORDER BY p.position`, ctx.workspaceId)
        .map((row) => ({ id: row.id, name: row.name, flowId: row.flow_id, position: row.position, cardCount: row.card_count, archivedAt: row.archived_at }));
      const flows = all('SELECT id, name FROM flows WHERE workspace_id = ? ORDER BY created_at', ctx.workspaceId).map((row) => ({ ...row, stages: withPlaybooks(row.id, activeStages(row.id)) }));
      const eventCursor = get('SELECT MAX(id) AS cursor FROM activity_log WHERE workspace_id = ?', ctx.workspaceId).cursor ?? 0;
      return { workspace, user, projects, flows, eventCursor };
    },

    createProject(ctx, input) {
      check(isObject(input), 'Invalid project.');
      checkId(input.id);
      checkName(input.name, 150, 'Projects need a name (up to 150 characters).');
      return transaction(() => {
        const { count } = get('SELECT COUNT(*) AS count FROM projects WHERE workspace_id = ? AND deleted_at IS NULL', ctx.workspaceId);
        check(count < 200, 'A workspace can hold up to 200 projects.');
        const id = input.id ?? randomUUID();
        const name = input.name.trim();
        const flowId = insertFlow(ctx.workspaceId, name, defaultStages.map(([stageName, color]) => [randomUUID(), stageName, color]));
        const position = (get('SELECT MAX(position) AS position FROM projects WHERE workspace_id = ?', ctx.workspaceId).position ?? -1) + 1;
        run('INSERT INTO projects (id, workspace_id, flow_id, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, ctx.workspaceId, flowId, name, position, now());
        recordChange(ctx, 'project', id, 'created', { projectId: id, data: { flowId } });
        playbooks.ensure(flowId, { projectName: name, lanes: activeStages(flowId) });
        return { project: { id, name, flowId, position, cardCount: 0, archivedAt: null }, flow: { id: flowId, name, stages: withPlaybooks(flowId, activeStages(flowId)) } };
      });
    },

    updateProject(ctx, id, input) {
      check(isObject(input), 'Invalid project.');
      requireProject(ctx, id);
      checkName(input.name, 150, 'Projects need a name (up to 150 characters).');
      return transaction(() => {
        run('UPDATE projects SET name = ? WHERE id = ?', input.name.trim(), id);
        recordChange(ctx, 'project', id, 'updated', { projectId: id });
        return { id, name: input.name.trim() };
      });
    },

    deleteProject(ctx, id) {
      requireProject(ctx, id);
      transaction(() => {
        deleteCards(ctx, all('SELECT * FROM cards WHERE project_id = ? AND deleted_at IS NULL', id), 'project deleted');
        run('UPDATE projects SET deleted_at = ? WHERE id = ?', now(), id);
        recordChange(ctx, 'project', id, 'deleted', { projectId: id });
      });
    },

    // Archive takes a project out of active use in one commit: pending lane runs
    // and queued submissions are cancelled, running work is asked to stop (the
    // worker sends native Stop after this commit), and every unfinished attempt
    // and submission is revoked for good. Cards, chats and history stay readable.
    archiveProject(ctx, id) {
      requireProject(ctx, id);
      return transaction(() => {
        const at = now(); const reason = 'Cancelled because the project was archived.';
        for (const row of all('SELECT id FROM cards WHERE project_id = ? AND deleted_at IS NULL', id)) {
          chats.revokeCard(ctx, row.id, reason);
          run("UPDATE lane_runs SET status = 'cancelled', reason = ?, updated_at = ? WHERE card_id = ? AND status = 'pending'", reason, at, row.id);
        }
        run('UPDATE projects SET archived_at = ?, archive_generation = archive_generation + 1 WHERE id = ?', at, id);
        recordChange(ctx, 'project', id, 'archived', { projectId: id, at });
        return { id, archivedAt: at };
      });
    },

    // Unarchive restores access only. Revoked work stays cancelled and revoked.
    unarchiveProject(ctx, id) {
      const project = requireProject(ctx, id, { allowArchived: true });
      if (project.archived_at) transaction(() => {
        run('UPDATE projects SET archived_at = NULL WHERE id = ?', id);
        recordChange(ctx, 'project', id, 'unarchived', { projectId: id });
      });
      return { id, archivedAt: null };
    },

    setProjectPrompt(ctx, projectId, prompt) {
      requireProject(ctx, projectId);
      check(isText(prompt, 200000), 'Prompts can be up to 200,000 characters.');
      return transaction(() => {
        const at = now();
        return all('SELECT * FROM cards WHERE project_id = ? AND deleted_at IS NULL', projectId).map(cardFrom)
          .filter((card) => templates[card.template].fields.some((field) => field.key === 'prompt'))
          .map((card) => {
            run('UPDATE cards SET fields = ?, revision = revision + 1, updated_at = ? WHERE id = ?', JSON.stringify({ ...card.fields, prompt }), at, card.id);
            recordChange(ctx, 'card', card.id, 'updated', { projectId, data: { revision: card.revision + 1 }, at });
            recordSavedState(ctx, card.id, 'bulk_prompt', at);
            return { id: card.id, revision: card.revision + 1, updatedAt: at };
          });
      });
    },

    createStage(ctx, flowId, input) {
      check(isObject(input), 'Invalid lane.');
      requireFlow(ctx, flowId);
      checkId(input.id);
      checkName(input.name, 100, 'Lanes need a name (up to 100 characters).');
      check(laneColors.includes(input.color), 'Choose a lane color.');
      rejectCommands(input);
      return transaction(() => {
        const stages = activeStages(flowId);
        check(stages.length < 100, 'A project can hold up to 100 lanes.');
        const id = input.id ?? randomUUID();
        run('INSERT INTO stages (id, flow_id, name, color, position) VALUES (?, ?, ?, ?, ?)', id, flowId, input.name.trim(), input.color, (stages.at(-1)?.position ?? -1) + 1);
        recordChange(ctx, 'stage', id, 'created', { data: { flowId } });
        return requireStage(ctx, id);
      });
    },

    updateStage(ctx, id, input) {
      check(isObject(input), 'Invalid lane.');
      const stage = requireStage(ctx, id);
      const sibling = (value) => value === null || (value !== id && activeStages(stage.flowId).some((item) => item.id === value));
      const columns = {};
      if ('name' in input) { checkName(input.name, 100, 'Lanes need a name (up to 100 characters).'); columns.name = input.name.trim(); }
      if ('color' in input) { check(laneColors.includes(input.color), 'Choose a lane color.'); columns.color = input.color; }
      if ('instructions' in input) { check(isText(input.instructions, 20000), 'Review instructions can be up to 20,000 characters.'); columns.instructions = input.instructions; }
      rejectCommands(input);
      if ('exitCriteria' in input) { checkCriteria(input.exitCriteria); columns.exit_criteria = JSON.stringify(input.exitCriteria); }
      if ('approveTo' in input) { check(sibling(input.approveTo), 'Approving must lead to another lane in this project.'); columns.approve_to = input.approveTo; }
      if ('sendBackTo' in input) { check(sibling(input.sendBackTo), 'Sending back must lead to another lane in this project.'); columns.send_back_to = input.sendBackTo; }
      if ('automations' in input) {
        check(Array.isArray(input.automations) && input.automations.length <= 50 && input.automations.every(isObject) && JSON.stringify(input.automations).length <= 50000, 'Invalid automations.');
        columns.automations = JSON.stringify(input.automations);
      }
      if ('position' in input) check(Number.isInteger(input.position) && input.position >= 0, 'Invalid lane position.');
      return transaction(() => {
        const keys = Object.keys(columns);
        if (keys.length) run(`UPDATE stages SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`, ...Object.values(columns), id);
        if ('position' in input) {
          const others = activeStages(stage.flowId).filter((item) => item.id !== id);
          others.splice(Math.min(input.position, others.length), 0, stage);
          renumberStages(stage.flowId, others);
        }
        recordChange(ctx, 'stage', id, 'updated', { data: { flowId: stage.flowId } });
        return requireStage(ctx, id);
      });
    },

    deleteStage(ctx, id) {
      const stage = requireStage(ctx, id);
      transaction(() => {
        deleteCards(ctx, all('SELECT * FROM cards WHERE stage_id = ? AND deleted_at IS NULL', id), 'lane deleted');
        run('UPDATE stages SET deleted_at = ? WHERE id = ?', now(), id);
        renumberStages(stage.flowId, activeStages(stage.flowId));
        recordChange(ctx, 'stage', id, 'deleted', { data: { flowId: stage.flowId } });
      });
    },

    listCards(ctx, projectId) {
      requireProject(ctx, projectId, { allowArchived: true });
      return all('SELECT c.* FROM cards c JOIN stages s ON s.id = c.stage_id WHERE c.project_id = ? AND c.deleted_at IS NULL ORDER BY s.position, c.position', projectId).map((row) => withLastMove(cardFrom(row)));
    },

    getCard(ctx, id) {
      const card = requireCard(ctx, id, { allowArchived: true });
      return { card, events: all('SELECT * FROM activity_log WHERE workspace_id = ? AND entity = \'card\' AND entity_id = ? AND card_event_id IS NOT NULL ORDER BY card_event_id', ctx.workspaceId, id).map(activityEventFrom) };
    },

    savedCardStates(ctx, id) {
      retainedCard(ctx, id);
      return all('SELECT * FROM saved_card_states WHERE workspace_id = ? AND card_id = ? ORDER BY id', ctx.workspaceId, id).map(savedStateFrom);
    },

    endEditingSession(ctx, id, input) {
      check(isObject(input) && typeof input.editingSessionId === 'string' && idPattern.test(input.editingSessionId), 'An editing session ID is required.');
      retainedCard(ctx, id);
      transaction(() => run(`UPDATE saved_card_states SET closed_at = ? WHERE workspace_id = ? AND card_id = ?
        AND actor = ? AND editing_session_id = ? AND closed_at IS NULL`, now(), ctx.workspaceId, id, ctx.actor, input.editingSessionId));
    },

    createCard(ctx, projectId, input) {
      check(isObject(input), 'Invalid card.');
      const project = requireProject(ctx, projectId);
      checkId(input.id);
      const template = input.template ?? defaultTemplate;
      check(Object.hasOwn(templates, template), 'Unknown card template.');
      const stage = requireStage(ctx, input.stageId);
      check(stage.flowId === project.flow_id, 'Choose a lane in this project.');
      const content = cardContent(template, input, { title: '', fields: emptyFields(template), images: [], imageRoles: emptyImageRoles(template) });
      return transaction(() => {
        const id = input.id ?? randomUUID();
        const at = now();
        run('INSERT INTO cards (id, project_id, stage_id, position, template, title, fields, images, image_roles, entered_stage_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, projectId, stage.id, positionFor(stage.id, null), template, content.title, JSON.stringify(content.fields), JSON.stringify(content.images), JSON.stringify(content.imageRoles), at, at, at);
        insertEvent(ctx.workspaceId, { id, projectId }, 'created', ctx.actor, { to: stage.id, at });
        applyEntrySet(ctx, requireCard(ctx, id), stage, at);
        recordSavedState(ctx, id, 'created', at);
        return requireCard(ctx, id);
      });
    },

    // Content edits are checked against the card's revision so an automatic
    // step or another tab cannot silently overwrite them.
    updateCard(ctx, id, input) {
      check(isObject(input), 'Invalid card.');
      check(input.editingSessionId === undefined || (typeof input.editingSessionId === 'string' && idPattern.test(input.editingSessionId)), 'Invalid editing session ID.');
      const card = requireCard(ctx, id);
      const fieldSave = input.changes !== undefined;
      let conflicts = [];
      if (input.changes !== undefined) {
        check(isObject(input.changes) && isObject(input.baseVersions), 'Changed fields need their base versions.');
        // Validate gallery membership and roles together; a role may name an
        // image being added in this same save.
        const requested = { fields: {} };
        for (const [key, value] of Object.entries(input.changes)) {
          if (['title', 'images', 'imageRoles'].includes(key)) requested[key] = value; else requested.fields[key] = value;
        }
        cardContent(card.template, requested, card, false);
        const patch = {}; const fields = {};
        for (const [key, value] of Object.entries(input.changes)) {
          check(Object.hasOwn(card.fieldVersions, key) && Number.isInteger(input.baseVersions[key]), 'Unknown field or missing field version.');
          if (key === 'imageRoles') check(Number.isInteger(input.baseVersions.images), 'Image role edits need the gallery base version.');
          if (input.baseVersions[key] !== card.fieldVersions[key] || key === 'imageRoles' && input.baseVersions.images !== card.fieldVersions.images) { conflicts.push(key); continue; }
          if (['title', 'images', 'imageRoles'].includes(key)) patch[key] = value; else fields[key] = value;
        }
        if (conflicts.some((key) => ['images', 'imageRoles'].includes(key))) {
          // Gallery membership and roles cannot be partially combined with a
          // newer gallery; retain that pair while still saving matching text.
          for (const key of ['images', 'imageRoles']) if (Object.hasOwn(input.changes, key)) {
            delete patch[key]; if (!conflicts.includes(key)) conflicts.push(key);
          }
        }
        if (!Object.keys(patch).length && !Object.keys(fields).length) return { ...card, conflicts };
        input = { ...patch, fields, revision: card.revision, editingSessionId: input.editingSessionId };
      }
      check(Number.isInteger(input.revision), 'Card updates need the revision they were based on.');
      if (input.revision !== card.revision) fail(409, 'This card changed in another tab. Copy any unsaved text, then reload to get the latest version.');
      const content = cardContent(card.template, input, card);
      return transaction(() => {
        const at = now();
        run('UPDATE cards SET title = ?, fields = ?, images = ?, image_roles = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
          content.title, JSON.stringify(content.fields), JSON.stringify(content.images), JSON.stringify(content.imageRoles), at, id);
        const before = new Set(card.images.map((image) => image.id));
        const after = new Set(content.images.map((image) => image.id));
        const added = [...after].filter((imageId) => !before.has(imageId));
        const removed = [...before].filter((imageId) => !after.has(imageId));
        const roles = Object.keys(content.imageRoles).filter((role) => content.imageRoles[role] !== card.imageRoles[role]);
        const imagesChanged = JSON.stringify(content.images) !== JSON.stringify(card.images) || roles.length > 0;
        if (imagesChanged) {
          insertEvent(ctx.workspaceId, card, 'images_changed', ctx.actor, { data: { added, removed, roles }, at });
        } else recordChange(ctx, 'card', id, 'updated', { projectId: card.projectId, data: { revision: card.revision + 1 }, at });
        recordSavedState(ctx, id, imagesChanged ? 'images_changed'
          : ctx.actor.startsWith('user:') ? 'editing_session' : 'fields_changed', at, input.editingSessionId ?? null);
        return { ...requireCard(ctx, id), ...(fieldSave ? { conflicts } : {}) };
      });
    },

    // Flows are advisory: any move is allowed. Approve and send back are
    // shortcuts to the stage's configured (or neighbouring) lane, and moving
    // forward records any exit criteria the card did not meet.
    transitionCard(ctx, id, input) {
      check(isObject(input), 'Invalid move.');
      const card = requireCard(ctx, id);
      const stages = activeStages(requireProject(ctx, card.projectId).flow_id);
      const index = stages.findIndex((stage) => stage.id === card.stageId);
      const current = stages[index];
      const note = input.note ?? '';
      check(isText(note, 20000), 'Notes can be up to 20,000 characters.');
      check(input.beforeCardId === undefined || input.beforeCardId === null || typeof input.beforeCardId === 'string', 'Invalid card position.');
      let target;
      if (input.action === 'approve') {
        target = stages.find((stage) => stage.id === current.approveTo) ?? stages[index + 1];
        check(target, 'This card is already in the last lane.');
      } else if (input.action === 'send_back') {
        target = stages.find((stage) => stage.id === current.sendBackTo) ?? stages[index - 1];
        check(target, 'This card is already in the first lane.');
      } else if (input.action === 'move') {
        target = stages.find((stage) => stage.id === input.toStageId);
        check(target, 'Choose a lane in this project.');
      } else fail(400, 'Unknown move. Use approve, send_back, or move.');
      return transaction(() => {
        const at = now();
        const changedStage = target.id !== current.id;
        const oldOrder = orderedCards(current.id);
        const oldIndex = oldOrder.findIndex((row) => row.id === id);
        const placement = { index: oldIndex, beforeCardId: oldOrder[oldIndex + 1]?.id ?? null, afterCardId: oldOrder[oldIndex - 1]?.id ?? null };
        const nextOrder = orderedCards(target.id, id);
        const nextIndex = nextOrder.findIndex((row) => row.id === input.beforeCardId);
        if (!changedStage && (nextIndex < 0 ? nextOrder.length : nextIndex) === oldIndex) {
          return { card, event: null, fieldUpdate: null, laneRunId: null };
        }
        run('UPDATE cards SET stage_id = ?, position = ?, updated_at = ?, entered_stage_at = ? WHERE id = ?',
          target.id, positionFor(target.id, input.beforeCardId, id), at, changedStage ? at : card.enteredStageAt, id);
        let event = null;
        if (changedStage || input.action !== 'move') {
          const unmet = target.position > current.position ? unmetCriteria(current, card) : [];
          const type = { approve: 'approved', send_back: 'sent_back', move: 'moved' }[input.action];
          event = insertEvent(ctx.workspaceId, card, type, ctx.actor, { from: current.id, to: target.id, note, data: unmet.length ? { unmet } : {}, at });
        } else recordChange(ctx, 'card', id, 'reordered', { projectId: card.projectId, at });
        const fieldUpdate = changedStage ? applyEntrySet(ctx, card, target, at) : null;
        // Keep the complete move boundary separate from the lightweight event feed.
        // Reordering also gets a snapshot, without adding ordinary reorder history.
        const { lastMove: previousMove, ...before } = card;
        const { lastMove: pendingMove, ...after } = requireCard(ctx, id);
        const { lastInsertRowid: moveId } = run('INSERT INTO card_moves (card_id, event_id, before_card, after_card, placement, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          id, event?.id ?? null, JSON.stringify(before), JSON.stringify(after), JSON.stringify(placement), at);
        let laneRunId = null;
        if (changedStage) {
          cancelLaneRuns(ctx, id, (row) => row.stage_id === target.id, `The card moved to ${target.name} before this run started.`);
          laneRunId = requestLaneRun(ctx, card, target, 'enter', Number(moveId));
        }
        recordSavedState(ctx, id, changedStage ? 'moved' : 'reordered', at);
        return { card: requireCard(ctx, id), event, fieldUpdate, laneRunId };
      });
    },

    // Undo reverses this move's content delta, preserving subsequent unrelated
    // edits. Returning to a lane must not run that lane's entry commands again.
    undoMove(ctx, id, input) {
      check(isObject(input) && Number.isInteger(input.moveId) && Number.isInteger(input.revision), 'Undo needs a move ID and card revision.');
      const card = requireCard(ctx, id);
      const move = get('SELECT * FROM card_moves WHERE card_id = ? ORDER BY id DESC LIMIT 1', id);
      if (!move || move.undone_at || move.id !== input.moveId) fail(409, 'This is no longer the card’s last move. Reload to see its current position.');
      if (input.fieldVersions === undefined && card.revision !== input.revision) fail(409, 'This card changed in another tab. Reload before undoing its move.');
      if (input.placementVersion !== undefined && input.placementVersion !== card.placementVersion) fail(409, 'The card placement changed. Reload before undoing.');
      const before = JSON.parse(move.before_card);
      const after = JSON.parse(move.after_card);
      const source = activeStages(requireProject(ctx, card.projectId).flow_id).find((stage) => stage.id === before.stageId);
      if (!source) fail(409, 'Cannot undo: the original lane has been deleted.');
      if (card.stageId !== after.stageId) fail(409, 'The card has moved again. Reload before undoing.');
      const previous = { ...before.fields, title: before.title };
      const applied = { ...after.fields, title: after.title };
      const current = { ...card.fields, title: card.title };
      const keys = Object.keys(previous).filter((key) => previous[key] !== applied[key]);
      for (const key of keys) {
        if ((input.fieldVersions && (input.fieldVersions[key] !== card.fieldVersions[key] || after.fieldVersions?.[key] !== undefined && after.fieldVersions[key] !== card.fieldVersions[key]))
          || protection.leased(id, key) || current[key] !== applied[key]) fail(409, `Cannot undo: ${key} was edited after this move. Your edits have been kept.`);
      }
      return transaction(() => {
        const at = now();
        const values = Object.fromEntries(keys.map((key) => [key, previous[key]]));
        const fields = { ...card.fields, ...Object.fromEntries(keys.filter((key) => key !== 'title').map((key) => [key, previous[key]])) };
        const revision = card.revision + Number(keys.length > 0);
        const beforeCardId = undoAnchor(source.id, id, JSON.parse(move.placement));
        run('UPDATE cards SET stage_id = ?, position = ?, title = ?, fields = ?, revision = ?, entered_stage_at = ?, updated_at = ? WHERE id = ?',
          source.id, positionFor(source.id, beforeCardId, id), values.title ?? card.title, JSON.stringify(fields), revision, before.enteredStageAt, at, id);
        const event = insertEvent(ctx.workspaceId, card, 'move_undone', ctx.actor, {
          from: card.stageId, to: source.id, data: { moveId: move.id, originalEventId: move.event_id, fields: keys }, at,
        });
        run('UPDATE card_moves SET undone_at = ?, undo_event_id = ? WHERE id = ?', at, event.id, move.id);
        cancelLaneRuns(ctx, id, (row) => row.stage_id === source.id && row.move_id !== move.id, 'The move was undone before this run started.');
        recordSavedState(ctx, id, 'move_undone', at);
        return { card: requireCard(ctx, id), event, beforeCardId,
          fieldUpdate: keys.length ? { beforeRevision: card.revision, revision, values } : null };
      });
    },

    deleteCard(ctx, id) {
      requireCard(ctx, id);
      transaction(() => deleteCards(ctx, [get('SELECT * FROM cards WHERE id = ?', id)], 'card deleted'));
    },

    // A change feed for other tabs and, later, automatic steps.
    activity(ctx, { since = 0, limit = 500, cardId = null } = {}) {
      if (cardId !== null) retainedCard(ctx, cardId);
      return all(`SELECT * FROM activity_log WHERE workspace_id = ? AND id > ?
        AND (? IS NULL OR (entity = 'card' AND entity_id = ?)) ORDER BY id LIMIT ?`, ctx.workspaceId, since, cardId, cardId, limit)
        .map((row) => ({ ...changeFrom(row), cardEventId: row.card_event_id,
          fromStageId: row.from_stage_id, toStageId: row.to_stage_id, note: row.note,
          context: row.context === null ? null : JSON.parse(row.context) }));
    },

    // Playbook files live on disk; their activity is still logged so other
    // tabs and the board learn about saves.
    recordPlaybookChange(ctx, flowId, documentPath, type) {
      requireFlow(ctx, flowId);
      transaction(() => recordChange(ctx, 'flow', flowId, type, { projectId: get('SELECT id FROM projects WHERE flow_id = ?', flowId)?.id ?? null, data: { path: documentPath } }));
    },
    // The card must accept changes: it exists and its project is not archived.
    editableCard: (ctx, id) => requireCard(ctx, id),
    editableFlow: (ctx, id) => requireFlow(ctx, id),
    recordNotesChange(ctx, cardId) {
      const card = requireCard(ctx, cardId);
      transaction(() => recordChange(ctx, 'card', cardId, 'notes_saved', { projectId: card.projectId }));
    },
    laneRuns: {
      // Reordering keeps this identity. A move away and back, including undo,
      // changes it even when both moves share the same clock timestamp.
      entry(cardId) {
        const move = get("SELECT id, undo_event_id FROM card_moves WHERE card_id = ? AND json_extract(before_card, '$.stageId') != json_extract(after_card, '$.stageId') ORDER BY id DESC LIMIT 1", cardId);
        return move ? `${move.id}:${move.undo_event_id ?? ''}` : 'initial';
      },
      get: (id) => laneRunFrom(get('SELECT * FROM lane_runs WHERE id = ?', id)),
      bySubmission: (submissionId) => laneRunFrom(get('SELECT * FROM lane_runs WHERE submission_id = ?', submissionId)),
      pending: (ctx) => all("SELECT * FROM lane_runs WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at", ctx.workspaceId).map(laneRunFrom),
      forCard(ctx, cardId) {
        retainedCard(ctx, cardId);
        return all('SELECT * FROM lane_runs WHERE card_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20', cardId).map(laneRunFrom);
      },
      // Everything a lane run prompt needs about where the card is.
      context(ctx, id) {
        const runRow = get('SELECT * FROM lane_runs WHERE id = ? AND workspace_id = ?', id, ctx.workspaceId) || fail(404, 'This lane run does not exist.');
        const cardRow = get('SELECT * FROM cards WHERE id = ?', runRow.card_id);
        const project = get('SELECT * FROM projects WHERE id = ?', cardRow.project_id);
        const stage = stageFrom(get('SELECT * FROM stages WHERE id = ?', runRow.stage_id));
        return { run: laneRunFrom(runRow), card: cardFrom(cardRow), deleted: Boolean(cardRow.deleted_at || project.deleted_at), archived: Boolean(project.archived_at),
          stage, stageDeleted: Boolean(get('SELECT deleted_at FROM stages WHERE id = ?', stage.id).deleted_at), project: { id: project.id, name: project.name, flowId: project.flow_id }, stages: activeStages(project.flow_id) };
      },
      place(ctx, cardId) {
        const card = requireCard(ctx, cardId);
        const project = requireProject(ctx, card.projectId);
        return { card, stage: requireStage(ctx, card.stageId), project: { id: project.id, name: project.name, flowId: project.flow_id }, stages: activeStages(project.flow_id) };
      },
      // Run playbook: the card's current lane, on request.
      request(ctx, cardId) {
        const card = requireCard(ctx, cardId);
        const stage = requireStage(ctx, card.stageId);
        const found = playbooks.settings(stage.flowId, stage.id, card.template);
        if (!found) fail(409, `${stage.name} has no lane playbook yet. Open its playbook to write one.`);
        if (found.settings.errors.length) fail(409, `Fix the playbook first: ${found.settings.errors.join(' ')}`);
        if (!found.settings.instructions) fail(409, 'This lane playbook has no instructions to run.');
        if (found.settings.run === 'off') fail(409, 'This lane playbook is turned off. Change run: off to manual or on-enter.');
        return transaction(() => {
          // New explicit work replaces runs held after a restore, with their submissions.
          cancelLaneRuns(ctx, cardId, (row) => row.status !== 'held', 'Replaced by a new run of the playbook.');
          const open = get("SELECT id FROM lane_runs WHERE card_id = ? AND stage_id = ? AND status = 'pending'", cardId, stage.id);
          return laneRunFrom(get('SELECT * FROM lane_runs WHERE id = ?', open?.id ?? requestLaneRun(ctx, card, stage, 'manual')));
        });
      },
      update(ctx, id, { status, reason = '', submissionId = null, result = null }) {
        return transaction(() => {
          const row = get('SELECT * FROM lane_runs WHERE id = ?', id);
          if (!row) return null;
          // A cancelled run stays cancelled, whatever its preparation reports later.
          if (row.status === 'cancelled') return laneRunFrom(row);
          run('UPDATE lane_runs SET status = ?, reason = ?, submission_id = COALESCE(?, submission_id), result = COALESCE(?, result), updated_at = ? WHERE id = ?',
            status, reason, submissionId, result === null ? null : JSON.stringify(result), now(), id);
          if (status !== row.status || reason !== row.reason || result) {
            recordChange({ ...ctx, actor: `automation:${row.stage_id}` }, 'card', row.card_id, `lane_run_${status}`,
              { projectId: get('SELECT project_id FROM cards WHERE id = ?', row.card_id).project_id, data: { laneRunId: id, reason, submissionId, ...(result ? { result } : {}) } });
          }
          return laneRunFrom(get('SELECT * FROM lane_runs WHERE id = ?', id));
        });
      },
    },

    events(ctx, { since = 0, limit = 500 } = {}) {
      return all('SELECT * FROM activity_log WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT ?', ctx.workspaceId, since, limit).map(changeFrom);
    },
  };
  try {
    const restored = meta('restore_recovery');
    if (restored) transaction(() => {
      const ctx = { workspaceId: owner.workspaceId, actor: 'system:restore' };
      const { held } = chats.holdRestored(ctx);
      recordChange(ctx, 'workspace', owner.workspaceId, 'restored', { data: { ...JSON.parse(restored), held } });
      run("DELETE FROM meta WHERE key = 'restore_recovery'");
    });
    const metadata = createRetainedMetadata({ all, get, run, transaction, now });
    api.retained = await createRetainedStorage({ dataDir, checkpoint: retainedCheckpoint, metadata });
    api.library = createLibrary({ retained: api.retained, metadata, drafts: createDraftStore({ all, get, run, transaction, now }), project: requireProject,
      record: (ctx, type, id, projectId, data, entity = 'asset') => transaction(() => recordChange(ctx, entity, id, type, { projectId, data })) });
  } catch (error) { db.close(); throw error; }
  return api;
}
