# Saved workspace files and rendered images

Implements [#63](https://github.com/michaelahoff/content-kanban/issues/63) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 17–20 and 23–26, and refinement 12.B. It extends [saved outputs](saved-outputs.md) (#62) from documents to finished files. Same-card reuse is [#64](https://github.com/michaelahoff/content-kanban/issues/64); promotion is [#65](https://github.com/michaelahoff/content-kanban/issues/65).

## Records

No schema change. A file output is a `saved_outputs` row whose provenance adds:

- `kind`: `file`, or `image` when its first bytes are a PNG, JPEG, GIF, WebP or AVIF image. Documents are `document`. How an image was made is not known beyond who named it, so it is not labelled rendered; it is never `native-image-generation`. Native image capture (`chat_outputs`) and its Add to gallery and image roles are unchanged, and a saved file is neither an image output nor a gallery image.
- `file`: `{ path, format, namedBy }`: the workspace-relative path it was saved from, the recognized image format (or `null`), and `agent` or `user`. Frameboard cannot tell which response wrote a file; `namedBy: 'user'` records that the user credited the chosen response.

`creationMethod` is `lane-result` (an agent's registration) or `workspace-save` (Save output). The bytes are a retained `output` version, exactly as for documents, so they outlive the workspace, the card, Stop, fresh context and archive.

## Opening a named file

`workspace-files.js` opens one file by its workspace-relative path. It never lists or scans the workspace. It refuses:

- absolute paths, `..`, `.`, empty components, backslashes and NUL;
- anything under `references/` (reference copies are supplied inputs);
- a link anywhere along the path (each parent is checked with `lstat`, the file is opened `O_NOFOLLOW`, and after opening the parent's real path is rechecked and the descriptor's device and inode must match the file now at that path, so a directory swapped for a link around the open is caught);
- a file with other hard links (it could be an authoritative store's file), a directory or another non-regular file;
- a missing path (`… does not exist in the card workspace.`).

Bytes stream lazily from the opened descriptor in 64 KiB chunks into `retained.publish()`, so memory stays bounded and no size limit applies. A file whose size, mtime or ctime changes while it is read fails with nothing saved.

## Filesystem capability

`saveFile()` requires the producing response to have been able to write files: a Codex submission whose frozen configuration ran in the `workspace-write` sandbox. A Claude response ran with its tools off, so naming a path, even one that exists, is refused with `Claude ran with its tools turned off, so it cannot have written …`, from a lane result and from Save output alike. Claude's inline documents still save.

## Lane result `outputs`

An entry is either `{ filename, text, sources? }` (unchanged) or `{ path, filename?, sources? }`; `filename` defaults to the path's last part. Giving both `text` and `path`, or a blank path, is reported in the result's errors. A path entry is saved by `saveFile()` as `lane:<attempt>:<index>`, under the same live-authority fence and declared-source verification as documents. A path that cannot be opened, or a response without file capability, registers nothing; its outcome and the run summary say why (`missing.png was not saved. missing.png does not exist in the card workspace.`). Field, notes and move effects and the reply text are unaffected.

The lane prompt's reporting section documents `path` and says that listing is the only way a file is saved.

## Save output

`POST /api/cards/:cardId/chat/saved-outputs` with `{ operation, attempt, path, filename? }` saves a file a response wrote (a body with `sequence` remains Save as document). The response must be finished; a running one is refused (`Wait for this response to finish …`). Derivation stays unknown. Repeating the operation returns the saved output. Archived projects refuse it before anything is registered.

Each finished response that could write files shows **Save output…**, which asks for the path and an optional filename. Saved files show their kind and source path with View and Download (`inline=1` uses the Library's preview types).

## Save-only retry

`POST /api/cards/:cardId/chat/saved-outputs/:id/retry` retries a failed file save, through the same row and retained operation:

- It binds to the hash and size that retained storage pinned when the bytes were first verified. A path now holding other bytes, of any size, fails with `… has changed since it was first saved, so its original bytes are gone.` and stays failed. If no bytes were ever verified, retry is refused (`… never verified …`); save the file again instead.
- Nothing is regenerated or rerun. Retrying a saved output returns it; one success is never duplicated.
- An agent's registration is retried only by that agent while its attempt is live. Once the attempt has ended, been stopped, archived, restored over or recovered after a restart, a user retry is refused (`The lane run that named … no longer has authority to save it. Use Save output …`), so no late or revoked registration publishes. The user saves the file with Save output instead. Retry is offered for the user's own saves; archive refuses it.
- Documents are not retried this way; they are saved from the reply.

A save interrupted by a restart is marked failed: a document says to save it from the reply, the user's file save says to retry, and a lane registration says to use Save output.

## Backup and restore

File outputs are committed retained versions in the same `saved_outputs` store, so export bundles, verifies and inventories them as #62 does (`manifest.inventory.savedOutputs`), and restore compares the inventory. Each file output's inventory entry adds `source: { kind, path, creationMethod }`; documents add nothing, so #62 bundles still restore.

## Acceptance evidence

`node --disable-warning=ExperimentalWarning --test test/saved-files.test.js`:

- A Codex lane run saves the PNG and opaque file it declares, with exact bytes, `rendered-image`/`file` kinds, provider, declared and unknown derivation; an undeclared scratch file is not saved; a later workspace edit leaves the snapshot unchanged.
- Absolute, traversal, symlink, link-through-directory, hard-linked, reference-copy, missing and directory paths are each reported with their reason and register nothing, while the field effect, the reply and a valid file save stand.
- Tool-disabled Claude's lane result saves its document but not a path, even one present in the workspace, and the user cannot save a file as Claude's output.
- Save output keeps a named file once, refuses a running response, missing and escaping paths, and previews an image inline.
- A failed save refuses a changed path occupant (different size, and same size with different bytes), then saves the original bytes into the same output once they are back; a save that failed before verification is not retryable.
- Stop during a lane file save leaves it failed and unretryable, with the field effect kept; a lane file save that failed for another reason is not retryable once the run ends; in both cases the user can save the file with Save output.
- A 24 MiB file streams in, survives workspace deletion, archive and card deletion, is refused while archived, is listed with its source in the backup inventory, and restores from a verified backup with identical provenance and hash.

`test/saved-outputs.test.js` covers the parser's path entries. `npm run test:browser` saves a workspace file with Save output….

## Review

Parallel code review (Standards and Spec axes). Changed:

- A lane run's failed file registration is no longer retryable by the user after the run's attempt ends; previously a save interrupted by a restart could be retried and published, regaining authority the spec says recovery cannot regain.
- Opening a file also checks the opened descriptor's device and inode against the path, closing a directory-swap race between the parent checks and the open.
- `rendered-image` became `image`, since rendering is not known; `file.namedBy` records whether the agent or the user credited the response.
- The backup inventory lists each file output's source.
- The user action is **Save output**, as the spec names it, with `creationMethod: 'workspace-save'`; the retry route is `…/retry-save`, like image outputs'; Save output is offered only for responses whose frozen configuration could write files.
- Repeating an operation that is still saving is refused, as for documents; user saves share one failure-reporting helper; restart messages are set per kind explicitly.

Kept deliberately:

- Paths under `references/` are refused: they are copies of supplied inputs, never outputs.
- Inline View uses the Library's preview types, so a saved image or PDF previews as itself rather than as text.
- A saved image has no Add to gallery here. Adoption and same-card reuse are #64; promotion is #65.
- `register_image` (`chat-service.js`) keeps its own path checks; it is the existing native-image-output route and is unchanged.
- The store derives the workspace path the same way the chat service does, rather than taking a dependency on the service, which is created after it.
