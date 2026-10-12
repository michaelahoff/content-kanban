# Card templates and the playbook settings form

Design brief for the template system and the visual lane playbook settings. This file is the shared contract between the modules; it is updated as the work lands. Where the code differs from the first design, this note says what the code does. The playbook settings form has its own note: [playbook-settings-form.md](playbook-settings-form.md).

## Goals

1. Every lane playbook setting (the frontmatter between `---` lines) can be edited with visual controls: a run-mode switch, provider and model pickers, a fresh-context toggle, multi-selects for `context:` and `may_edit:`, a list of "set this field to this text" rows for `set:`, skill and Library pickers. Raw Markdown stays available and the file on disk stays the source of truth.
2. The controls are driven by the card's template, not by hardcoded field names, so user-created templates with arbitrary fields work everywhere a template is read: the card editor, search, card chats, lane playbooks, lane runs and results.
3. Existing data migrates: the one built-in template (`youtube-video`) becomes a database row, every existing card and project keeps working, and nothing is lost if a template later changes.

## Template definitions

`public/card-template.js` is the shared, pure module. A definition is:

```js
{ id, name, title: { label, max }, fields: [field...], imageRoles: [{ key, label }...] }
// field: { key, label, control: 'text' | 'textarea' | 'url', max, placeholder?, placement?: 'header',
//          copy?: true, countWords?: true, editor?: false, youtube?: true, videoLabel? }
```

- A field's `key` is its identity: a letter, then up to 59 letters or digits (`fieldKeyPattern`). Card values are stored by key, so a key never changes once a card holds a value for it. Labels, controls and limits can change.
- `editor: false` hides a field from the card editor, search, chat context, `may_edit`, `context:` and lane results. It can still be set by `set:` (the shared `prompt` field is the example).
- `imageRoles` are the roles besides the display image. The display image is always role `cover`, which playbooks call `display`.
- `validateTemplate(input, { locked })` returns `{ template, errors }` with defaults filled and unknown keys dropped. `locked` keys (fields that live cards hold a non-empty value for) cannot be removed. The server and the editor both use it.
- What `validateTemplate` enforces:
  - Field keys are unique and not reserved: `title`, `images`, `imageRoles`, `placement`, `id`, `template`, `notes`, `move`, `outputs`, `fields`, `cover`, `display`, and the names whose editor element ids would collide (`lane`, `chat`, `dialog`, `playbook`, `image`, `total`). A key is checked squashed (lower case, letters and digits only). Role keys are lowercase letters and digits (up to 30); `cover` and `display` are reserved.
  - Names must read apart in playbook settings, which match fields and roles loosely by key or label: every field's and role's squashed key and label, the title's label, `title`, `display` and `cover` must all name one identity. Two fields with one label, a label equal to another field's key, or a role named like a field are refused: `The field “Second” reads the same as the field “Second” in playbook settings. Use a distinct name.` Owners are identities (keys), so a field whose own label squashes to its key is fine.
  - Limits: 50 fields, 10 image roles, 100 templates per workspace, 100,000 characters of JSON per definition. Field labels and the name are up to 100 characters, role labels up to 50. A field's maximum length is 1 to 1,000,000 characters; it defaults to 500 for text, 4,096 for URL and 200,000 for text area. A title maximum that is not a whole number from 1 to 10,000 is refused; an absent one is 500.
  - Flags: `copy`, `countWords`, `youtube` and `editor` are true or false. `placement` is `header` or absent. Only a `url` field can have `youtube`.
- Field lists each feature reads:
  - `emptyFields`, `emptyImageRoles`, `normalizeCard(template, card)`.
  - `setFields` (title and all fields), `editorFields`, `contextFields` (title and editor fields).
  - `imageRoles(template)` (template roles, then `cover` as Display), `roleLabel`.
  - `fieldKey(fields, name)` and `roleKey(template, name)`: loose match by key or label, ignoring case, spaces and punctuation.
- `youtubeVideoTemplate` is the built-in seed and `builtinTemplates` indexes it.

Every shared function that used to take a template ID now takes the definition object: `playbookSettings(document, template)`, `describeSettings(settings, template)`, `composeLanePrompt({ ..., template })`, `parseLaneResult(text, template)`, `mapTemplate(projectName, lanes, template)`, `contextFields(template)`, `defaultSelections(template)`, `selectedContext(card, template, selections, versions, outputs)`.

## Storage

Schema migration (`store-templates.js` `templatesMigration`):

```sql
CREATE TABLE card_templates (id TEXT PRIMARY KEY, workspace_id, name, definition TEXT /* JSON {title, fields, imageRoles} */,
  revision INTEGER, builtin INTEGER, position INTEGER, created_at, updated_at, deleted_at);
ALTER TABLE projects ADD COLUMN template_id TEXT;  -- the template for new cards in the project
```

`store.templates.seed(workspaceId)` runs every time the store opens, inside a transaction. It inserts the built-in `youtube-video` row if no row has that ID (a deleted row is left deleted), and gives every project without a template the built-in one. `cards.template` already named `youtube-video`, so existing cards need no change.

Card values stay in `cards.fields` (JSON by key) and `card_field_versions` (one row per card and key, kept by triggers). When a template gains a field, `update` adds the key with an empty value to every card of that template, deleted cards included, and inserts a version row at 1. A gained image role starts as `null` on those cards, filled in on read: a card save that touches no role writes the stored roles back unchanged, so the gallery version (`card_field_versions.imageRoles`) moves only when a role is edited. So edits and conflict checks work from the first save. When a field is removed its stored values stay (hidden); re-adding the key shows them again. Reads go through `normalizeCard`, so every template key and role is present on a card the app returns.

A key is locked while a live card holds a non-empty value for it. `update` refuses to remove a locked key (`400`), so renaming one is refused too. Empty values and deleted cards do not lock. The editor is stricter: it locks every key of a template that has cards.

`store.templates`: `list(ctx)` (live templates with `cardCount` and `projectCount`), `get(id)` (including deleted, cached), `require(id)`, `requireLive(ctx, id)`, `forCard(card)`, `defaultId(ctx)` (the built-in while it exists, else the first), `create`, `update` (revision-checked), `remove` (refused while live cards or a project default use it, or it is the last one; soft delete), `lockedKeys(id)`, and `seed(workspaceId)`.

The built-in template has no extra protection. `remove` allows it when it is unused and not the last template, and seeding does not bring a deleted row back.

## API

- `GET /api/workspace` returns `templates` (the live list with counts) and each project's `templateId`.
- `GET /api/templates` returns `{ templates }`.
- `POST /api/templates` with `{name, title, fields, imageRoles}` returns `201` with the template. Its ID comes from the name (`blog-post`), then `blog-post-2` and so on.
- `PATCH /api/templates/:id` with `{revision, name, title, fields, imageRoles}` returns the template with its new revision. A stale revision is `409`; a missing revision is `400`.
- `DELETE /api/templates/:id` returns `{ ok: true }`. It is `409` while live cards or projects use the template: the message counts the cards and names the projects.
- Unknown or deleted templates are `404`. An invalid definition is `400`, with every problem in one message.
- `POST /api/projects` and `PATCH /api/projects/:id` accept `templateId` (unknown is `404`).
- `POST /api/projects/:id/cards` accepts `template` (defaults to the project's template). Unknown or deleted is `400` (`Unknown card template.`).
- Activity entries with entity `template` (`created`, `updated`, `deleted`) tell other tabs to reload templates. An `updated` entry lists the fields it added.
- A body without a `fields` list answers `400` (`Fields must be a list.`); more than 50 fields answers with the limit. A title labelled like the display image (`Display`, `Cover`) is refused like any other name collision.

## Browser

`public/state.js` keeps `state.templates` from the workspace payload and reloads it after template changes. `templateOf(card)`, `projectTemplate(project)`, `templateById(id)`, `applyTemplates(list)`, `loadTemplates()`, `createTemplate`, `updateTemplate`, `deleteTemplate`, `setProjectTemplate(project, id)`, `createProject(name, templateId?)`. `createCard` uses the project's template. `searchText` reads the template's editor fields. A card whose template is not in the list reads as a template with no fields. When a template drops a field, `applyTemplates` removes that key from the browser's copy of every card of the template, drafts included, and retries a write the queue was holding for it, so a stale draft never wedges the queue; the stored value stays on the server. After a template save, delete or a project retemplated in another tab the board header is redrawn, so Set prompt appears or disappears without a reload. The YouTube lookup clips the fetched title to the `originalVideoTitle` field's and the card title's maximum.

UI modules read fields and roles from `templateOf(card)`:

- The card editor renders `editorFields` (header placement first, `url` controls with their links, `copy` and `countWords` tools) and one role button per template role.
- The chat composer lists `contextFields` and `imageRoles`. A saved composer may name a field or role the template has since hidden or removed: the server drops such names when the composer is saved (never a `400`), `selectedContext` leaves them out of a Send, and a template update rewrites every saved composer of that template at once (fields, roles and edit authority; the composer revision does not change), so a template edit never locks a card chat.
- Set prompt is offered only when the project's template has a `prompt` field, and it updates only cards whose template has one. The dialog's limit is the smallest `prompt` maximum among the affected cards' templates, `setProjectPrompt` in `state.js` refuses a longer prompt before any card changes, and `POST /api/projects/:id/prompt` answers `400` naming the template when the prompt exceeds a card's limit, changing nothing.
- Trifecta copy is offered when the template has a `titleOptions`, `intro` or `prompt` field. It reads those keys, `originalVideoTitle`, and the `original` and `inspiration` roles by name, and packs a missing one as empty. Making it read the template is open.
- The YouTube lookup runs for each `url` field marked `youtube: true`; the button carries the field's key (`data-field`), so a template with two flagged fields looks up the clicked one. It fills the `original` role and the `originalVideoTitle` field only when the template has them.
- The template editor (`public/template-editor.js`, `openTemplates()`, opened from Project settings → Manage templates…) edits one template at a time: name, title label and maximum, fields (add, remove, move up or down), image roles and the field options. The draft is kept until Save (Ctrl+S). Duplicate copies the selected template. Delete asks first. Restore built-in fields (built-in only) puts back the seeded fields. A save refused as stale reloads the list; the draft is kept and flagged, so Revert loads the newer version and Save replaces it. Save checks the draft against the keys that cards use before sending, and Remove is disabled on such fields; an unchanged template is not re-saved. Edits typed while a save is pending are kept as the unsaved draft on top of the saved copy, with the keys the save made permanent locked. A draft left unsaved by a forced close of the dialog is shown again on reopening.
- Project settings (`public/board.js`, `editProject`) choose the project's template with **Card template for new cards**. A new project starts with the first template in the list selected.

## Playbook settings form

`public/playbook-editor.js` shows a lane playbook, or an unattached playbook file, in two modes. **Form** is the default; choosing **Markdown** is remembered in the browser (`frameboard-playbook-mode`). **Form** shows the settings as controls above the Markdown instructions (the body). **Markdown** shows the whole file in one textarea. The project map and skills have no form. A draft whose settings cannot be read shows its parse errors above the Markdown text, in place of the controls, and the inspector lists them. The draft text is the single source for both modes: each control change patches the draft with `withSetting(text, key, value)` and the body textarea with `withBody(text, body)` (both in `public/playbook-format.js`), so comments, key order and other settings on disk survive edits made with the controls.

Controls, all template-driven: lane (read-only, or a lane picker for an unattached file), `run` (On entry / Manual / Off, always written), `provider` (Card chat's / Codex / Claude), `model` (text with the enabled providers' models as suggestions), `conversation` (a fresh-context checkbox), `context` ("Send every card field and image role" checkbox, else checkboxes for the title, `contextFields` and the image roles, Display included), `may_edit` (checkboxes for `contextFields`), `set` (rows of field picker, value and Remove, plus Add field), `skills` (checkboxes for the folder's skills plus a name entry; skills mentioned in the instructions are shown as included), `assets` (the existing Library picker). Unknown settings are listed with a Remove button, and the inspector shows them as warnings.

`withSetting(text, key, value)`: `value` is a string, a list of strings, a map of string values, or `undefined` to remove the key. It changes only that key's lines in the frontmatter (adding the key, or a frontmatter block, when absent), keeps a trailing comment on the key line, and refuses (throws, status 400) when the draft's settings cannot be read or the result would change anything else. `withBody(text, body)` replaces everything after the closing `---` (or the whole text when there is no frontmatter).

### Patching rules

`withSetting`, `withSettings` and `withBody` are the only writers of the draft's settings, apart from `withAssets` for `assets:`. These rules hold, and `test/playbook-settings.test.js` checks them:

- Only the named key's lines change. Other settings, their order, comments, blank lines and the body keep their bytes, except line endings in a block that mixes CRLF and LF (see below). A comment on the key line stays on that line, after a one-line value or after the key of a block.
- A key's lines run from its key line to its last indented line. Comments and blank lines after that line stay where they are.
- A repeated key collapses into its last copy, which is the copy a reader sees.
- An absent key is added before the closing `---`. A draft with no settings gains a block at its top. A leading `---` rule followed by prose is body, not settings.
- One-line text, and list items, that contain a quote mark are written as JSON text, for example `"say \"hi\" #now"`. Other one-line text is plain, or quoted where the YAML subset needs it.
- Several lines are block text (`|`, `|-` or `|+`) when they read back exactly. Otherwise they are written as JSON text.
- A `|+` block takes the blank lines after it. Replacing its value replaces those blank lines too, and the new value writes its own trailing blank lines.
- An empty map removes the key, as `undefined` does. An empty list writes `key: []`.
- A settings block with a lone CR (a CR not followed by LF) is refused (`400`, "the settings block mixes line endings"). A block that mixes CRLF with LF is accepted, and every settings line is then written with the ending of the opening `---` line. A block with one ending keeps it.
- A `set:`, `may_edit:` or `context:` entry that names a field the template no longer has is left as written. The playbook reports it as an error until it is changed, and such a playbook does not run. The removed field's stored card values stay (see Storage).
- A change that would touch anything else, or a draft whose settings cannot be read, is refused with `400`. The message begins `Fix the settings in Markdown before changing settings with the form:`.
- `withBody` replaces everything after the closing `---`, or the whole text when there are no settings. A settings block with no closing `---` is refused (`400`).

## Considered options

- **Keep one static template and only add the form.** Rejected: the form's field pickers would still be hard-coded, and the user asked for templates with arbitrary fields.
- **Templates as files in the flow folder.** Rejected: a template is shared across projects and read on every card read; it has no reason to be edited by hand or by agents.
- **A fully normalized value store.** Deferred, for the reasons above.

## Consequences

- Every function that used to take a template ID takes the definition object. The browser gets definitions with the workspace; the server reads them through `store.templates`.
- Hidden fields (`editor: false`) are the mechanism for values an agent should not see in context but a lane may set, as the shared prompt was before.
- Image roles are per template. The display image (`cover`, "display" in playbooks) is universal.
- The YouTube lookup follows the template's `youtube` field. Trifecta copy still names the `titleOptions`, `intro`, `prompt` and `originalVideoTitle` keys and the `original` and `inspiration` roles, and Set prompt names `prompt`; each is offered only when the template has what it names.
- A template cannot be deleted while live cards or a project default use it, and the last template cannot be deleted.
