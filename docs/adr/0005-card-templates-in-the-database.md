# Card templates are database rows; playbook settings are edited through controls over the Markdown

> Since [ADR 0006](0006-projects-hold-several-flows.md), each flow, not each project, names the template its new cards use.

Cards used to follow one template hard-coded in `public/card-template.js`. Lane playbook settings were validated against it, and the only way to change a setting was to type YAML into the playbook's frontmatter. Both are replaced:

- **Card templates** are rows in `card_templates`, one per template, with a JSON definition (`title`, `fields`, `imageRoles`). The built-in `youtube-video` template is seeded into every workspace, and the user can create, edit and delete templates. A project names the template its new cards use; a card keeps the template it was created with.
- **Playbook settings** get a form in the playbook editor: a control per frontmatter key, with the field and image-role choices read from the project's template. The form edits the same Markdown draft the raw editor shows, one key at a time, and the file on disk stays the source of truth.

## Why rows with a JSON definition, not a table per field

Card values already live in `cards.fields` as JSON keyed by field key, with one `card_field_versions` row per card and key kept by triggers. That is the relation between a card and its template's fields. Normalizing further (a `card_template_fields` table and a `card_values` table) would mean rewriting every card read and write, every snapshot (`card_moves`, `saved_card_states`, frozen submissions) and the version triggers, for no capability the JSON definition lacks. The definition is small, read as a whole, and changes rarely; it is cached per store.

Field keys are the identity of a field. A template edit can change a field's label, control or limits, but never its key, because every card value, field version, snapshot and playbook setting names the key. Removing a field hides it; its stored values stay and reappear if the key is added again. Adding a field writes an empty value and a version row into every card of the template at once, so the edit and conflict checks that follow behave exactly as for an original field.

## Why the form patches the Markdown instead of replacing it

ADR 0003 keeps playbooks on disk so the user can edit them with any tool, including other agents, with comments and their own ordering. A form that serialized the whole settings block would destroy that on every click. Instead each control change goes through `withSetting(text, key, value)`, which rewrites only that key's lines and refuses if the result would change anything else, following the pattern `withAssets` set for the Library picker. A draft whose settings cannot be parsed offers only the raw editor, with the errors shown.

## Considered options

- **Keep one static template and only add the form.** Rejected: the form's field pickers would still be hard-coded, and the user asked for templates with arbitrary fields.
- **Templates as files in the flow folder.** Rejected: a template is shared across projects and read on every card read; it has no reason to be edited by hand or by agents.
- **A fully normalized value store.** Deferred, for the reasons above.

## Consequences

- Every function that used to take a template ID takes the definition object. The browser gets definitions with the workspace; the server reads them through `store.templates`.
- Hidden fields (`editor: false`) are the mechanism for values an agent should not see in context but a lane may set, as the shared prompt was before.
- Image roles are per template. The display image (`cover`, "display" in playbooks) is universal.
- The browser's YouTube lookup and Trifecta copy exist only for templates that have the fields they use.
- A template cannot be deleted while live cards or a project default use it, and the last template cannot be deleted.
