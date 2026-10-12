// Card templates live in the database: one row per template with its JSON
// definition, revision-checked saves, and the project default for new cards.
// Cards keep their values by field key in cards.fields, so a template change
// touches cards only to add the keys it gained (and their field versions).
// Exposed through openStore() as store.templates.
import { youtubeVideoTemplate, validateTemplate, templateSlug, templateIdPattern, contextFields, imageRoles } from './public/card-template.js';

// The table and the project column, separately, so a schema repair can add
// whichever one a database lacks.
export const templatesTable = `
  CREATE TABLE card_templates (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, definition TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, builtin INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);`;
export const projectTemplateColumn = `
  -- The template new cards in a project use. NULL means the workspace default.
  ALTER TABLE projects ADD COLUMN template_id TEXT;`;
export const templatesMigration = `${templatesTable}${projectTemplateColumn}
`;

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const check = (value, message) => { if (!value) fail(400, message); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createTemplateStore({ all, get, run, transaction, recordChange, now }) {
  // Definitions rarely change and are read on every card read.
  const cache = new Map();
  const definitionFrom = (row) => ({ id: row.id, ...JSON.parse(row.definition), name: row.name, workspaceId: row.workspace_id, revision: row.revision, builtin: Boolean(row.builtin),
    position: row.position, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at });
  const read = (id) => {
    if (!cache.has(id)) {
      const row = get('SELECT * FROM card_templates WHERE id = ?', id);
      cache.set(id, row ? definitionFrom(row) : null);
    }
    return cache.get(id);
  };
  const live = (workspaceId) => all('SELECT * FROM card_templates WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY position, rowid', workspaceId).map(definitionFrom);
  const stored = ({ title, fields, imageRoles }) => JSON.stringify({ title, fields, imageRoles });
  const api = {
    // Every workspace has the built-in template, and every project a default.
    // Runs after migrations and on first start, inside the opening transaction.
    seed(workspaceId) {
      const at = now();
      const { title, fields, imageRoles } = youtubeVideoTemplate;
      run(`INSERT OR IGNORE INTO card_templates (id, workspace_id, name, definition, revision, builtin, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 1, 0, ?, ?)`, youtubeVideoTemplate.id, workspaceId, youtubeVideoTemplate.name, stored({ title, fields, imageRoles }), at, at);
      run('UPDATE projects SET template_id = ? WHERE workspace_id = ? AND template_id IS NULL', youtubeVideoTemplate.id, workspaceId);
      cache.clear();
    },
    // Live templates, with how many cards and projects use each.
    list(ctx) {
      return live(ctx.workspaceId).map((template) => ({ ...template,
        cardCount: get('SELECT COUNT(*) AS count FROM cards c JOIN projects p ON p.id = c.project_id WHERE c.template = ? AND c.deleted_at IS NULL AND p.deleted_at IS NULL', template.id).count,
        projectCount: get('SELECT COUNT(*) AS count FROM projects WHERE template_id = ? AND deleted_at IS NULL', template.id).count }));
    },
    // The template for new cards: the built-in one while it exists, else the first.
    defaultId(ctx) {
      const templates = live(ctx.workspaceId);
      return (templates.find((template) => template.id === youtubeVideoTemplate.id) ?? templates[0])?.id ?? null;
    },
    // By ID, including deleted templates: cards and history still name them.
    get: (id) => (typeof id === 'string' ? read(id) : null),
    require(id) {
      return api.get(id) ?? fail(404, 'This card template does not exist.');
    },
    requireLive(ctx, id) {
      const template = api.get(id);
      if (!template || template.deletedAt || template.workspaceId !== ctx.workspaceId) fail(404, 'This card template does not exist.');
      return template;
    },
    forCard: (card) => api.require(card.template),
    create(ctx, input) {
      check(isObject(input), 'Invalid card template.');
      const { template, errors } = validateTemplate(input);
      if (errors.length) fail(400, errors.join(' '));
      return transaction(() => {
        check(live(ctx.workspaceId).length < 100, 'A workspace can hold up to 100 card templates.');
        const base = typeof input.id === 'string' && templateIdPattern.test(input.id) ? input.id : templateSlug(template.name);
        let id = base;
        for (let index = 2; get('SELECT 1 FROM card_templates WHERE id = ?', id); index++) id = `${base}-${index}`;
        const at = now();
        const position = (get('SELECT MAX(position) AS position FROM card_templates WHERE workspace_id = ?', ctx.workspaceId).position ?? -1) + 1;
        run('INSERT INTO card_templates (id, workspace_id, name, definition, revision, builtin, position, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)',
          id, ctx.workspaceId, template.name, stored(template), position, at, at);
        cache.delete(id);
        recordChange(ctx, 'template', id, 'created', { data: { revision: 1 } });
        return api.list(ctx).find((entry) => entry.id === id);
      });
    },
    // Saves a new revision. Fields that cards use keep their keys: the editor
    // locks them, and a removed field's values stay stored and hidden. New
    // fields are added to every card of the template with an empty value and
    // a field version, so edits and conflict checks work from the first save.
    update(ctx, id, input) {
      check(isObject(input) && Number.isInteger(input.revision), 'Template updates need the revision they were based on.');
      const current = api.requireLive(ctx, id);
      return transaction(() => {
        const keys = current.fields.map((field) => field.key);
        const { template, errors } = validateTemplate(input, { locked: api.lockedKeys(id).filter((key) => keys.includes(key)) });
        if (errors.length) fail(400, errors.join(' '));
        const row = get('SELECT * FROM card_templates WHERE id = ?', id);
        if (row.revision !== input.revision) fail(409, 'This template changed in another tab. Reload before saving.');
        const at = now();
        run('UPDATE card_templates SET name = ?, definition = ?, revision = revision + 1, updated_at = ? WHERE id = ?', template.name, stored(template), at, id);
        const before = new Set(current.fields.map((field) => field.key));
        const added = template.fields.map((field) => field.key).filter((key) => !before.has(key));
        for (const key of added) {
          run(`UPDATE cards SET fields = json_set(fields, ?, '') WHERE template = ? AND json_type(fields, ?) IS NULL`, `$.${key}`, id, `$.${key}`);
          run('INSERT OR IGNORE INTO card_field_versions (card_id, field, version) SELECT id, ?, 1 FROM cards WHERE template = ?', key, id);
        }
        // New image roles need no backfill: reads fill them in (normalizeCard),
        // and rewriting image_roles here would bump every card's gallery version.
        // Saved card chat composers drop fields, roles and edit authority the
        // template no longer offers, so their next save and Send still work.
        const fields = contextFields(template).map((field) => field.key); const roles = imageRoles(template).map((role) => role.key);
        for (const chat of all('SELECT ch.card_id, ch.composer FROM card_chats ch JOIN cards c ON c.id = ch.card_id WHERE c.template = ?', id)) {
          const composer = JSON.parse(chat.composer);
          const keep = (list, allowed) => (Array.isArray(list) ? list.filter((entry) => allowed.includes(entry)) : list);
          const next = { ...composer, selections: { ...composer.selections, fields: keep(composer.selections?.fields, fields), roles: keep(composer.selections?.roles, roles) },
            authority: { ...composer.authority, fields: keep(composer.authority?.fields, fields) } };
          if (JSON.stringify(next) !== JSON.stringify(composer)) run('UPDATE card_chats SET composer = ? WHERE card_id = ?', JSON.stringify(next), chat.card_id);
        }
        cache.delete(id);
        recordChange(ctx, 'template', id, 'updated', { data: { revision: row.revision + 1, addedFields: added } });
        return api.list(ctx).find((entry) => entry.id === id);
      });
    },
    // A template in use by cards or as a project default stays; the last one too.
    remove(ctx, id) {
      api.requireLive(ctx, id);
      return transaction(() => {
        const cards = get('SELECT COUNT(*) AS count FROM cards c JOIN projects p ON p.id = c.project_id WHERE c.template = ? AND c.deleted_at IS NULL AND p.deleted_at IS NULL', id).count;
        if (cards) fail(409, `${cards} ${cards === 1 ? 'card uses' : 'cards use'} this template. Delete those cards, or keep the template.`);
        const projects = all('SELECT name FROM projects WHERE template_id = ? AND deleted_at IS NULL', id);
        if (projects.length) fail(409, `${projects.map((project) => `“${project.name}”`).join(', ')} ${projects.length === 1 ? 'uses' : 'use'} this template for new cards. Choose another template in Project settings first.`);
        if (live(ctx.workspaceId).length <= 1) fail(409, 'A workspace needs at least one card template.');
        run('UPDATE card_templates SET deleted_at = ? WHERE id = ?', now(), id);
        cache.delete(id);
        recordChange(ctx, 'template', id, 'deleted', {});
      });
    },
    // Keys that live cards of this template hold a value for: these cannot be removed.
    lockedKeys(id) {
      return all(`SELECT DISTINCT f.key FROM cards c, json_each(c.fields) f WHERE c.template = ? AND c.deleted_at IS NULL AND f.value != ''`, id).map((row) => row.key);
    },
  };
  return api;
}
