# Saved documents and inline lane outputs

Implements [#62](https://github.com/michaelahoff/content-kanban/issues/62) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 17, 19 and 23–26, and refinement 12.B. Workspace files and rendered images are [#63](https://github.com/michaelahoff/content-kanban/issues/63); same-card reuse is [#64](https://github.com/michaelahoff/content-kanban/issues/64); promotion is [#65](https://github.com/michaelahoff/content-kanban/issues/65).

## Records

`store-saved-outputs.js` owns a new `saved_outputs` table (schema version 19). A row binds:

- the card chat and delivery attempt, plus in its provenance the conversation, submission, lane run, actual provider and model, creation method (`transcript-save` or `lane-result`) and the native turn and item IDs that are known;
- `supplied`: every image and Library version the submission supplied, with its label and hash;
- `derivation`: `{ declared: false }` when nothing was declared (unknown), or `{ declared: true, sources }` with the verified sources, `[]` when the agent declared none;
- `status` (`saving`, `saved` or `failed`), its error, and the retained version holding the bytes.

The bytes are published through `retained-storage.js` as a version of kind `output`, owned by the card's project. The Library never lists that kind. The bytes are outside the card workspace, so deleting or changing the workspace, the card, its sources, fresh context, Stop and archive leave them intact.

`operation_id` is unique per workspace. Repeating a request with the same operation returns the saved output, and refuses different text; repeating a failed one retries the same retained publication, which also refuses different bytes. Image provenance (`store-images.js`) now records the submission's actual provider instead of always `codex`.

## Save as document

`POST /api/cards/:cardId/chat/saved-outputs` takes `{ operation, sequence, filename, text? }`. `sequence` names an `agentMessage` item of this card chat; `text`, when given, must appear in that reply's retained text. A reply that is still streaming cannot be saved. Filenames follow Library rules. Text is limited to the Library's 4 MB document limit.

This is a new explicit user action, so it works for a reply from a stopped, archived-then-unarchived or recovered attempt. It is refused while the project is archived (the retained commit checks archive) and during maintenance (as every mutating route is).

Highlighting reply text shows **Save as document…** beside Reply and Use text…; it previews the exact text and asks for a filename (default `reply.md`). Saved outputs appear under the attempt that produced them, with View and Download (`GET …/saved-outputs/:id/content`, verified as it streams). Failed saves show their reason. Content stays readable after archive and card deletion.

## Lane result `outputs`

`parseLaneResult()` accepts an optional `outputs` list of `{ filename, text, sources? }`, up to 20. An entry without `text` (for example a `path`), with empty text, without a filename or with malformed `sources` is reported in the result's errors and not saved. Fields, notes and move keep their own checks.

`applyLaneResult()` is now asynchronous. It applies fields, move and notes exactly as before, then saves each declared document as `lane:<attempt>:<index>`. Each declared source must name an image or Library version (or the Library asset of that version) the submission supplied; otherwise that document is not saved and its outcome says which ID was not supplied. Each document's outcome (`saved` or `failed` with its error) is in the lane run's `result.outputs`, and the summary reads, for example, `Applied Intro. Added hand-off notes. Saved script.md and outline.md. invented.md was not saved. Its source not-supplied was not supplied to this run…`. The reply text is always retained.

The chat worker ends the attempt only after those saves finish, so the attempt still holds authority while they run. Shutdown waits for them (`worker.drain()`); a crash mid-save leaves the output `failed`, marked at startup, and its text can be saved from the reply.

Tool-disabled Claude uses the same route: its lane reply's document is saved with `provider: 'claude'`, and no filesystem claim is involved.

The lane prompt's reporting section documents `outputs` and `sources`.

## Authority

Registration (`saveDocument(…, { requireLive: true })`) requires the attempt to be live (`dispatching`, `accepted` or `running`) and unrevoked. `retained.publish()` takes an `authorize` fence, run immediately before the bytes are published and again inside the commit transaction, so Stop, archive or a workspace restore that lands mid-save leaves the output `failed` with `This response was stopped, its project archived or the workspace restored before it was saved.`. Revoked and recovered attempts never reach registration: their result block is not applied.

## Backup and restore

Saved bytes are committed retained versions, so export bundles and verifies them like every other retained version. `inspectBackupDatabase()` also lists `savedOutputs` (ID, card, attempt, status, version, path, hash, size) and refuses a database whose saved output lacks its committed output version. The manifest records that inventory and restore compares it; older bundles have none. Provenance is in the verified database.

## Acceptance evidence

`node --disable-warning=ExperimentalWarning --test test/saved-outputs.test.js`:

- Save as document keeps a reply's exact text, listed beside its attempt with conversation, submission, provider, model, creation method, native turn/item and unknown derivation, and downloads exactly.
- A highlighted passage saves exactly; repeating its operation does not duplicate it; text not in the reply, an unsafe filename and an unknown reply are refused.
- Saved documents survive Stop, fresh context, deleting the card workspace, archive and card deletion and stay downloadable; a stopped reply's partial text can be saved by the user; a save while archived is refused.
- `parseLaneResult()` accepts inline documents with or without sources and reports path-only, empty, unnamed and malformed entries.
- A Codex lane run applies its field and notes, saves two documents with verified (and unknown) derivation and separate supplied context, and reports a third whose source was not supplied as not saved.
- Stop while a lane document is being saved leaves it `failed` and reported, keeps the applied field and the reply, and the user can then save that text.
- An archived lane reply and a reply recovered after restart register nothing; the recovered text can be saved explicitly.
- Tool-disabled Claude saves an inline lane document recorded as produced by Claude, with an empty declared derivation.
- Removing a supplied source from the gallery leaves a lane document and its declared derivation intact.
- A lane run still working when its card leaves the lane can save its document.
- Export and restore keep every saved output's identity, provenance, outcome and bytes, including for an archived project.

`test/restore.test.js`: a lane attempt revoked by a workspace restore saves no document from its late result.

`npm run test:browser` checks a lane document and a user's Save as document appearing beside the run with View and Download.

## Review

Parallel code review (Standards and Spec axes). Changed:

- The store is `store-saved-outputs.js` / `store.savedOutputs`, so it is not confused with image outputs (`store.images.outputs`).
- A lane document's declared sources are verified inside `saveDocument()` from the attempt's own submission, rather than by the lane runner.
- Failure reasons no longer repeat “Not saved:” after “… was not saved.”
- Repeating a saved operation with different text is refused instead of returning the earlier output.
- The Save as document dialog uses one operation per filename, so renaming after a failure is a new save rather than a conflict.
- Library and saved-output downloads share `sendRetained()`.
- README describes lane result `outputs`. Tests cover source removal, lane departure and restore revocation.

Kept deliberately:

- An undeclared or malformed output entry, and one whose declared source was not supplied, is reported in the lane result's outcome and notice and creates no saved-output record: nothing was registered.
- A commit refused by the authority fence removes the published bytes and marks the retained version failed, as every failed publication does.
- Every completed lane attempt now ends after its result is processed, including saves; a crash in that window is recovered without replaying the result, as before.
- A Codex process exit during a lane save makes the attempt uncertain first; its remaining saves then fail for lack of authority and are reported.
- There is no card restoration feature yet; restoration here is workspace restore.
