# Library selections in lane playbooks

Implements [#59](https://github.com/michaelahoff/content-kanban/issues/59) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 7–9. It builds on [Library selection](library-selection.md) (#56) and [Folder selection](folder-selection.md) (#57), whose resolver and preflight lane runs now share. Coherent capture after pending waits ([#60](https://github.com/michaelahoff/content-kanban/issues/60)) and Retry versus Run playbook ([#61](https://github.com/michaelahoff/content-kanban/issues/61)) are later tickets.

## The setting

A lane playbook's Markdown settings own its selection. `assets:` is an ordered list of `asset:<id>` and `folder:<id>` tokens, inline (`assets: [asset:a, folder:b]`) or as a block list. Both read the same way. Omitting it, or leaving it empty, adds no Library inputs. Tokens name sources, never versions, filenames or paths: each run sends the current version of each file and the current members of each folder.

`playbook-format.js` `assetSources()` reads the setting. A token that is not `asset:<id>` or `folder:<id>` is a settings error, shown in the editor, and blocks the run. A map value is an error too. A repeated token only warns, and the source is sent once. Saving is never refused for any of these, as with every other playbook setting. The file stays the only record of the selection; there is no database index.

## Validation against the Library

`GET /api/flows/:flowId/playbooks/assets?sources=asset:a,folder:b` resolves a draft's sources in the flow's project through `store.library.resolve()`, the resolver manual Send uses. The editor calls it as the draft changes. Its problems now say why a source names nothing here:

- removed: `It was removed from the Library.`, even after a new file takes its name;
- another project's source: `It is a file in another project’s Library. Choose one from this project; nothing is matched by name.`;
- the other kind (`asset:` naming a folder, or `folder:` naming a file): `It is a folder, not a file. Select it as a folder.`;
- anything else: `It is not a file in this project’s Library.`

A playbook file copied into another project's flow keeps its IDs and shows them as foreign. Nothing is rebound by filename or path.

## Editing

The editor's inspector lists the draft's sources in order under **Library files**: each by its current path (a folder with its file count), or as **Unresolved** with its ID and reason. **Add Library files…** opens a picker of files and folders not already chosen. Chosen sources join the end of the list. Each entry has **Remove**. Order is edited in the Markdown.

Both act on the same draft as the textarea, through `withAssets(text, sources)`. It rewrites only the `assets:` setting:

- An inline list keeps its line's comment.
- A block list keeps its indentation. A kept item keeps its line and the comment lines just above it. A removed item's comments move to the end of the list, and a repeated item is written once with the comments of every copy, so no comment is lost.
- A missing setting is added as the last setting line, or as a new settings block for a file that has none.
- Line endings, other settings, quoting and the body are untouched.

It then reparses the result and refuses unless only the selection changed. A draft whose settings cannot be read (an unclosed block, a bad `assets:` value) is refused with `Fix the settings in Markdown before choosing Library files: …` and left as typed.

Save is unchanged: it writes the whole draft, instructions, settings and selection together, against the hash the editor loaded. If the file changed on disk, the save is refused and the draft is kept beside the newer saved copy. Revert shows the newer file. Saving again replaces it deliberately, using the newer hash. The hash check is not an OS-level compare-and-swap, so a writer racing the save itself can still be overwritten, as before.

## Lane runs and the saved preview

A lane run now uses the shared preflight. `chat-service.js` `preflight()` is what manual `preview()` used to be, parameterized by selections, target and prompt. `previewLane()` runs it over the lane context, every gallery photo, then the playbook's Library sources, for the lane's provider and model. `queueLane()` discovers the target first, then preflights with full verification. It refuses with `409` and every problem, then re-resolves the sources synchronously with the commit, as manual Send does. A run refused by preflight fails before any submission exists, so it has no Retry. Its reason names each source with its ID: `Not sent. old.md (asset:…): It was removed from the Library.` Fixing the playbook and choosing Run playbook starts new work. A Library change during preparation matches the lane runner's existing "changed while preparing" retry, so the run is prepared again.

The full union is planned against the target, so a Claude lane with an unsupported gallery image now fails before queueing rather than at delivery, even with no Library selection. The frozen submission records `context.library` and `context.librarySelections` exactly as a manual one does, and delivery, history and backup need no lane-specific code.

`GET /api/cards/:cardId/lane-runs/preview` adds `library`, `librarySelections`, `problems` and `warnings`. Its `error` is the problem message when sources cannot be sent. The editor's prompt preview lists the Library files with their delivery route. It always uses the saved file, and says so with an **Unsaved changes are not in this preview** note when the draft differs. If the file changed on disk and there is no draft, the editor loads the newer file and the preview says so. Text Library files appear in the previewed prompt as a placeholder; their verified text goes in when sent.

Operational documents stay separate from Library references. `MAP.md`, the playbook, named skills and notes are found only in the flow folder, and a skill and a Library file with the same name are both sent, each in its own section. A filename, path or token in the instructions selects nothing.

## Backup

Selections live in the playbook files, which workspace exports already include. Restore keeps asset and folder IDs, so a restored playbook resolves to the same sources, and an unresolved ID stays unresolved. Playbook drafts stay in the browser until Save, as before; they are not app data and are not exported.

## Acceptance evidence

- `node --disable-warning=ExperimentalWarning --test test/playbook-assets.test.js`:
  - Inline and block lists read as the same ordered mixed sources; omission and empty mean none.
  - Malformed tokens and map values are errors; duplicates warn.
  - Picker patches keep every other byte: comments, block text holding `assets:`, prose mentions, CRLF, block indentation and comment placement.
  - Unsafe drafts are refused.
  - A manual lane run sends the gallery photo first, then a selected script and folder image. A same-named skill and the Library file are both sent, and a file named only in prose is not.
  - Removed, wrong-kind and unknown sources save and stay listed in the preview by identity. A new file with a removed file's name is not substituted. The run fails with the source IDs, no submission and no delivery.
  - Another project's flow reports the same IDs as foreign.
  - Export and restore keep the playbook text and its resolution, including the unresolved ID.
- `node --disable-warning=ExperimentalWarning --test test/library.test.js`: resolver reasons for foreign and wrong-kind sources.
- `npm run test:browser`:
  - The picker writes `assets:` into the Markdown draft without touching its comment or prose.
  - A raw edit shows an unresolved source, and it saves.
  - After an external edit, a picker removal survives the conflicting save.
  - The saved preview shows the newer file, its unresolved source and the unsaved note.
  - A deliberate save replaces the file with the draft.
  - One save writes the new instructions and the selection together.
  - With no draft, a preview of a file changed elsewhere says so and loads it.

## Review

Parallel code review (Standards and Spec axes). Fixed, each with a test observed failing first:

- A repeated block-list item lost the comments above its first copy when the picker rewrote the list.
- The assets route answered `500` for a flow whose project no longer exists; it is now `404`.
- The saved preview had no marker when the file changed on disk with no draft.

Also tidied: the preflight refusal and Library revalidation shared by manual Send and lane runs are one helper (`assertSendable`). `problemMessage` moved beside `planInputs`. Both Library pickers build their choices with `libraryChoices()`. An explicit test covers an empty selection.

Kept deliberately:

- Lane runs plan the whole input union, so an unsupported Claude gallery image fails before queueing even with no Library selection. The spec's union rule applies to every lane run (section 12A and acceptance 15).
- `queueLane` re-resolves Library sources at commit, as manual Send does. #60 still owns pending-wait coherence and revalidation of operational documents, settings and cancellation.
- Playbook drafts are not exported; only saved playbooks are. Their draft lives in the browser until Save, as before this change.
- A failed source check stays shown until the draft's sources change or the editor reloads, so a persistent error cannot loop requests.
