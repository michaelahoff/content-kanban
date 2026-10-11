# Playbook settings form

Implementation note for the form that edits a lane playbook's settings in the playbook editor. The design and its reasons are in [card-templates.md](card-templates.md) and [ADR 0005](../adr/0005-card-templates-in-the-database.md). The file format is in [ADR 0003](../adr/0003-lane-playbooks-on-disk.md).

Each statement here was checked against the shipped code in `public/playbook-editor.js`, `public/playbook-form.js`, `public/playbook-format.js`, `public/card-template.js`, `playbooks.js`, `store.js` and `lane-runner.js`, against the Node tests, and against the form section of the browser check.

## Purpose

A lane playbook starts with a settings block: lines between `---` that say when it runs, which provider and model it uses, what the agent may see and change, and what it sets. The keys are YAML-like text. The field names they accept depend on the project's card template. The form shows these settings as controls, so the user picks run modes, fields, image roles and skills from lists instead of typing their names.

The form keeps no settings of its own. The Markdown file is the source of truth, as ADR 0003 requires, so any other editor or agent can still change it.

## Modes

- **Form** is the default. Choosing **Markdown** is remembered in this browser (`localStorage` key `frameboard-playbook-mode`), so every playbook opens in that mode until the choice changes. The controls sit above the instructions (the Markdown body) in the same editor.
- **Markdown** shows the whole file in one textarea (`#playbook-text`).
- The project map and skills have no form. They show Markdown only, with no mode switch.
- A draft whose settings cannot be read shows its parse errors in a `.playbook-problems` block above the Markdown text, in place of the controls, even in Form mode. The form returns once the text parses, when the textarea is left. For example: `Line 3: Close the [list].`
- Switching modes does not change the draft. Both modes edit the same text. The switch is labelled **Form** and **Markdown**.

## Draft and saving

- Each playbook has one draft in the browser, kept until Save. Closing with unsaved changes asks first. If the browser shuts the dialog past that prompt (repeated Escape does this in Chromium), the dialog comes back with the prompt, and reopening Playbooks for the same project shows the drafts again, flagging any whose file changed on disk meanwhile. Drafts are not app data and are not exported.
- A control change calls `withSetting(draft, key, value)`, through `applySettingsChange` in `public/playbook-form.js`. The result becomes the draft, and the Markdown mode shows the same text. The form does not call `withSettings`.
- An edit to the Instructions calls `withBody(draft, body)`.
- Save writes the whole draft, instructions and settings together, with the hash the editor loaded (`PUT /api/flows/:id/playbooks` with `{path, text, baseHash}`). If the file changed on disk, the save is refused and the draft is kept beside the newer copy. See [playbook-asset-selection.md](playbook-asset-selection.md).
- The Library picker writes `assets:` with `withAssets`, not `withSetting`. See [playbook-asset-selection.md](playbook-asset-selection.md).
- Settings errors never refuse a save. The server refuses only two things about `lane:`: a value that is not a lane in the project (`400`), and a lane another playbook already claims (`409`). The second is shown as a toast and the draft stays; it is not a disk conflict, so the footer keeps reading *Unsaved changes*.
- After a save, a file whose `lane:` names an existing lane is shown under that lane.

## Controls

Each control writes one key. A control whose choice is the default removes its key. Run is the exception: it always writes its key, `run: on-enter` included. Clearing every box in May edit or Context writes an empty list (`may_edit: []`, `context: []`). Clearing every skill, or every set row, removes the key.

- **Lane**: for a playbook opened from its lane, a read-only line with the lane's name and ID. A file that names no lane, whose lane was deleted, or whose lane another file already claims (the first file by name is the lane's playbook) is listed under *Not attached to a lane* with the reason, and gets a lane picker, which writes `lane:`. The picker lists the lanes that have no playbook yet. *Not attached* removes `lane:`.
- **Run**: the chips **On entry**, **Manual** and **Off**, which write `run: on-enter`, `run: manual` or `run: off`. Without `run:` a playbook is on entry. Only on-entry playbooks run when a card arrives.
- **Provider**: a select with *Card chat's provider*, *Codex* and *Claude*. Writes `provider: codex` or `provider: claude`. *Card chat's provider* removes the key.
- **Model**: a text box of up to 200 characters, with the models of the enabled providers as suggestions. The suggestions narrow to the chosen provider. Writes `model:` after a 150 ms pause in typing, or at once on blur, Ctrl+S or a click, like a set value. An empty box removes it.
- **Conversation**: a checkbox, *Start fresh context for each run*. Checked writes `conversation: fresh`. Unchecked removes the key, which means continue.
- **Context**: a checkbox, *Send every card field and image role*. Checked removes `context:`. Unchecked shows a checklist of the title, the editor's fields and the template's image roles, with Display last. The checklist writes the ticked keys in template order. Image roles are written by their word, and Display as `display`. Unchecking the box writes the selection that is sent now, so nothing changes until a box is changed. Without `context:`, the title, every editor field and every template role are selected, but not Display. Every card photo is attached either way.
- **May edit**: a checklist of the title and the editor's fields. Hidden fields are not offered. Writes `may_edit:` in template order.
- **Set on entry**: one row per entry. Each row has a field select, a value box and a Remove button. The select offers the title and every field, hidden ones included; a field that another row uses is disabled. The value box is limited to the field's maximum length, and an empty value shows as *(cleared)* in the inspector. *Add field* adds a row for the first field without one, and is disabled when every field has a row. Several lines are written as block text. Typed values are written after a 150 ms pause, or at once on blur, Ctrl+S or a click.
- **Skills**: a checkbox for each skill file in the folder, saved or not yet saved, and for each name the playbook lists but the folder lacks, marked *missing*. A skill named as `skills/<name>.md` in the instructions is included without `skills:`. It shows checked and disabled, with the note *mentioned in the instructions*. A name box adds a skill when you press Enter or Add, and empties once the skill is added; text typed there survives the form's other re-renders. Names use letters, numbers, `-` and `_`. Writes `skills: [names]`.
- **Library files**: the Library picker, which writes `assets:` through `withAssets`, as described above.
- **Unknown settings**: a key the form does not know is listed under *Unknown settings*, with a Remove button that deletes it from the file. The inspector shows it as a warning: `Unknown setting “x” is ignored.`

## Errors

There are two kinds, both shown in the editor.

- **Unreadable settings** come from `parseDocument`: an unclosed list, a missing closing `---`, a line that is not `name: value`, or unexpected indentation. The editor shows them above the Markdown text in a `.playbook-problems` block headed *The settings could not be read*, and offers no controls. A form change that `withSetting` refuses (status `400`) leaves the draft as it was. A toast shows the message, `Fix the settings in Markdown before changing settings with the form: …`. The Node tests cover the refusal.
- **Settings problems** come from `playbookSettings`, for example `may_edit: “headline” is not an editable card field.`, `set: “headline” is not a card field.`, or `run must be on-enter, manual, off.` They appear in two places: a `.playbook-problems` block headed *Fix before this lane can run*, at the top of the form above the controls, and the same block in the inspector beside the summary. The nav beside the playbook reads **Has errors** (`describeSettings`). Unknown settings are warnings, not errors.

Settings errors have these effects on runs:

- A card that enters a lane whose playbook is on entry is recorded as a failed lane run. Its reason names the playbook and the errors.
- The card still moves, but the `set:` values are not applied.
- **Run playbook** is refused with `409`, `Fix the playbook first:` followed by the errors.

When a template drops a field that a playbook names, the playbook shows an error until the name is changed. The form does not rewrite that setting on its own (see the patching rules in [card-templates.md](card-templates.md#patching-rules)).

## Patching

`withSetting`, `withSettings` and `withBody` keep the bytes outside the changed key, and refuse a change that would touch anything else. The full rules are in [card-templates.md](card-templates.md#patching-rules). In short:

- Only the changed key's lines change. Comments, other settings, their order and the body stay as written.
- A draft whose settings cannot be read is refused with status `400`, and so is a change that would alter anything else.
- A settings block with a lone CR (a CR not followed by LF) is refused with status `400`. A block that mixes CRLF with LF is accepted, and then every settings line is written with the ending of the opening `---` line. This is the one case where other settings change bytes.

## Browser check

`npm run test:browser` runs `scripts/browser-test.mjs` against a temporary workspace. Its playbook settings form section runs after *PASS lane creation, editing, reordering, deletion* and works on the last lane. It checks:

1. Create playbook opens in Markdown, the remembered choice, and `lane: <id>` appears in `#playbook-text`. Form then shows `[data-playbook-action="mode"][data-mode="form"]` pressed, `#playbook-body` present, `#playbook-text` absent, `#playbook-run-on-enter` pressed, and the instructions in `#playbook-body`. An earlier check opens Form first and chooses Markdown, which the later checks inherit.
2. Run: clicking `#playbook-run-manual` makes the summary read *Runs when you choose*, and the footer reads *Unsaved changes · Ctrl+S saves*.
3. May edit: ticking `input[data-playbook-action="form-may-edit"][data-key="intro"]` makes the summary read *may edit Intro*. Markdown then shows `may_edit: [intro]`.
4. Set: *Add field* picks `title` in `#playbook-set-field-0`. Two typed lines in `#playbook-set-value-0` wait for the summary to read *sets Card title*. Markdown shows a `set:` block with the two lines.
5. Context: `#playbook-field-context-all` checked hides `#playbook-context-field-0`. Unchecking it shows the checklist with the first field and the first role ticked. Markdown shows `context: [title, originalVideoUrl, titleOptions, intro, script, publishedVideoUrl, originalVideoTitle, original, inspiration]`, with no Display.
6. Save: the footer reads *Saved*, and the API summary reads *Runs when you choose · Card chat provider · may edit Intro · sets Card title*. Reopening shows Form, with the run, may-edit, context and set values restored. The snapshot is `lane-playbook-form`.
7. Cleanup: the check switches to Markdown and deletes the playbook (`[data-playbook-action="delete"]`, then `#small-form [type="submit"]`), so later checks find lanes without playbooks.

The Library picker check covers the conflict path. Its refused save keeps the draft, and the form saves through the same editor function.

The browser check does not open the provider, model, conversation, lane and skills controls, the unknown-settings row, the unreadable-settings view, or a custom template's labels in the pickers. The Node tests cover the patching rules and refusals, and `test/templates.test.js` covers a custom template's playbook.

Element contract, as the check selects them:

| Part | Element | Action |
|---|---|---|
| Mode chips | `.playbook-modes` holds `button.chip[data-playbook-action="mode"][data-mode="form"]` and `[data-mode="markdown"]`, with `aria-pressed` | switches the view |
| Instructions | `#playbook-body` (textarea, labelled *Instructions*) | `withBody` |
| Markdown text | `#playbook-text` (textarea) | the whole file |
| Run | `#playbook-run-on-enter`, `#playbook-run-manual`, `#playbook-run-off` (chips) | `form-run`, `data-value` |
| Lane picker | `#playbook-field-lane` (select) | `form-lane`, unattached files only |
| Provider | `#playbook-field-provider` (select) | `form-provider` |
| Model | `#playbook-field-model`, suggestions in `#playbook-models` | `form-model` |
| Conversation | `#playbook-field-conversation` (checkbox) | `form-conversation` |
| Send everything | `#playbook-field-context-all` (checkbox) | `form-context-all` |
| Context checklist | `#playbook-context-field-N`, `#playbook-context-role-N` | `form-context`, `data-group`, `data-key` |
| May edit | `#playbook-may-edit-N` | `form-may-edit`, `data-key` |
| Set rows | `#playbook-set-field-N` (select), `#playbook-set-value-N` (textarea) | `form-set-field`, `form-set-value`, `data-row` |
| Set add and remove | `form-set-add` (button); `form-set-remove` (button) | `data-row` on remove |
| Skills | `#playbook-skill-N` (checkboxes), `#playbook-skill-name` (box), its Add button | `form-skill` (`data-name`), `form-skill-add` |
| Library files | `add-assets` (button); `remove-asset` (buttons) | `data-key` on remove |
| Unknown settings | Remove button | `form-unknown-remove`, `data-key` |
| Problems | `.playbook-problems` | above the controls (settings errors), above the Markdown text (unreadable), and in the inspector |
| Summary | `.playbook-inspector h3` | |
| Footer | `#playbook-status`; `[data-playbook-action="save"]`, `close`, `delete` | |
| Entry points | `[data-action="edit-playbook"][data-id]` on a lane; `[data-playbook-action="create-lane"]` in the empty state | |

Selects and checkboxes write when their value is committed. The set value and model boxes write after a pause in typing, as described above; typed text keeps its control in place, and the rest of the form refreshes once the keyboard leaves it, so a click that caused the blur still lands where it was aimed. Every textarea is rendered with a spare leading newline, which the HTML parser drops, so a body or value that starts with a blank line keeps it.

## Node tests that exist

These run with `npm test`:

- `test/playbook-settings.test.js` covers text, list and map round trips, comments, order, repeated and absent keys, CRLF, refusals, `withBody`, `withAssets`, and resolution against a card template.
- `test/templates.test.js` covers a custom template's playbook (it sets, sends, applies and proposes fields), playbook summaries and errors by project template, and the project map's fields.
