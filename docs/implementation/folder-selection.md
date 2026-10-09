# Folder selection with deterministic input provenance

Implements [#57](https://github.com/michaelahoff/content-kanban/issues/57) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 3–4 and 15 for manual card chat prompts. It builds on [Library folders](library-folders.md) (#53), whose resolver already expands folders, and [Library selection](library-selection.md) (#56), which freezes the result at Send.

## Selection and order

The composer remembers ordered, mixed `asset` and `folder` sources. Each Send resolves them through `store.library.resolve()`: a folder expands recursively over its live files in relative-path order, sources keep their selection order, and a file reached more than once is delivered once at its first position. Deduplication is by asset identity only, so files with the same name or the same bytes stay separate inputs. That includes a Library upload of a gallery image's bytes. Card images still come first, each image version once with every role and attachment label, then Library files.

Each entry's `sources` records every selection that reached it. A folder source now also captures the folder's path at that moment (`{ kind: 'folder', id, folderPath: 'Thumbnails/', relativePath: 'refs/logo.png' }`), so history can still show the path after the folder is renamed, moved or removed. `public/library-format.js` `selectionPaths()` names each one (`selected directly`, `in selected folder Thumbnails/ as refs/logo.png`). **What will be sent** and **Submitted context** list them under each file. Submissions frozen before this change, which lack `folderPath`, show `in a selected folder`.

An existing empty folder adds no files. A removed explicit folder or file stays selected and blocks Send by identity, even after a new folder takes its name. Send reports every unresolved, damaged and unsupported member together and queues nothing, so no subset is delivered.

## Revalidation around preparation

Send discovers the target, then reads and verifies every selected byte, then commits. Its final resolution, taken synchronously with the commit, used to compare only version IDs, so a file renamed or moved while bytes were being read could be frozen under its old path and provenance. It now compares the whole captured membership (asset, version, path and every source) and refuses with `409` if anything changed, so nothing stale or mixed is queued. Changes made during discovery are simply captured at their new state, since resolution starts after it.

The preview resolves live on every request. Queueing freezes membership, versions and labels; later renames, moves, additions, removals and restarts never rewrite the queued submission or its Retry.

## Drag and drop

In **Add Library files**, each file and folder can be checked or dragged. Dragging lifts the picker (it becomes non-modal, faded and click-through), so the whole composer accepts the drop. A dropped source joins the end of the ordered selection like a checked one, and the picker closes. If the drag ends anywhere else, the picker returns as it was. The Library tab itself is not a drag source, because the card panel closes when the pointer goes down outside it.

## Backup

Composer selections and frozen submissions, including expanded folder membership and its provenance, live in the database. They export and restore with it, and every frozen version is checked against retained bytes, as before.

## Acceptance evidence

- `node --disable-warning=ExperimentalWarning --test test/chat-library.test.js`:
  - A folder member renamed, then moved, while Send reads it is refused, and nothing is queued. This runs at the chat-service seam over the real store, with the Library's preflight read making the change.
  - Card images come first, once with both labels. Then come a directly selected file and its folders, delivered once each with all provenance, and same-name, same-bytes assets as separate inputs.
  - The preview follows live membership while the queued submission stays frozen.
  - Removed, damaged and Claude-unsupported members are all reported at once and nothing is queued.
  - Export and restore keep the folder selections and the frozen expanded membership with folder paths.
  - The existing folder test now checks captured folder paths.
- `node --disable-warning=ExperimentalWarning --test test/library.test.js`: selection path wording, including legacy sources, and resolver provenance.
- `npm run test:browser`: dragging a folder from the picker onto the composer appends it. The file it shares with a direct selection is previewed once, with both selection paths.
