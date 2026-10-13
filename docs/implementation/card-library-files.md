# Card Library files

A card can name Project Library files and folders of its own, and every lane run for the card sends them along with its playbook's Library files. It builds on [Library selections in lane playbooks](playbook-asset-selection.md) (#59), whose resolver, preflight and capture lane runs already share with manual Send.

## The selection

`cards.library` (schema migration 23) holds an ordered list of typed source IDs (`{ kind: 'asset' | 'folder', id }`, at most 200), the same shape as a composer selection. Validation checks shape only: a repeated source is kept once, and a removed, foreign or unknown source may stay listed. A lane run refuses it by name until it is removed.

The list is card content, saved like the gallery. `library` joins `title`, `images` and `imageRoles` as a top-level key of a field save, with its own `card_field_versions` row, which the migration's triggers seed and bump. A save based on an older list is a `library` conflict, never an overwrite. A tab's draft lease can hold it, like any other card key, so unsaved changes keep agent edits away. Saved card states record it with the rest of the card. `library` is now a reserved template field key. A template saved earlier with a field keyed `library` is not migrated; no known workspace has one.

## Lane runs

`lane-runner.js` `laneAssets()` sends the playbook's `assets:` first, then the card's list. A source both name is sent once, in the playbook's place. The run's preview, queueing and commit-time re-resolve all use that union, so lane runs need no other new code for capture, delivery, history and backup. An unresolved card source fails the run before any submission exists, naming the source with its ID, as an unresolved playbook source does.

The card read when preparation starts can be older than the card at the commit. The union is therefore one of the run's prepared parts, which `confirm()` compares with the saved card's at the commit. If they differ, the run is prepared again under the existing "changed while preparing" retry, so a card edited during preparation is captured as saved at the commit.

Manual card chat prompts are unchanged. They send only the composer's own selection.

## Editing

The card editor lists **Library files** under the images: each source by its current Library path (a folder with its file count), or **Unavailable** with its ID when the Library no longer lists it. **Add Library files…** opens the same picker as the composer and the playbook editor, without the sources already chosen; chosen sources join the end of the list. Each entry has **Remove**. Changes go through the card's ordinary autosave. The listing refreshes when Library files or folders change in any tab. Archived projects hide the controls.

The playbook editor's summary and Library files help now say that the card's own files follow the playbook's.

## Review

Parallel code review (Standards and Spec axes). Fixed: the draft lease refused `library`, leaving a tab's other unsaved fields unleased while a card's Library files were unsaved (test observed failing first). Tidied: the card content keys are shared from `card-template.js`; the commit-time check is a prepared part, so it shares the "changed while preparing" message; `uniqueSources()` and `libraryPickerFields()` replace repeated code. Kept deliberately: a listed file whose current version is unavailable shows its path, as in the composer, and a run names the problem; the playbook editor's copy mentions the card's files.

## Acceptance evidence

- `node --disable-warning=ExperimentalWarning --test test/playbook-assets.test.js`:
  - A card's list saves and returns with the card. A repeated source collapses, and an unknown one stays listed. A draft lease can hold it.
  - The list has its own field version, and a stale save conflicts. Malformed lists are refused.
  - A lane run previews and sends the playbook's file, then the card's file and folder. A source both name is sent once.
  - A card source removed from the Library fails the run by identity, with nothing sent. Removing it from the card lets runs go again.
- `node --disable-warning=ExperimentalWarning --test test/lane-capture.test.js`: a card list changed while a run is being prepared is captured as saved at the commit. The test fails without the card's files among the prepared parts.
- `npm run test:browser`: adding a folder and a file from the card editor's picker lists them by path and saves them with the card. Remove saves too.
