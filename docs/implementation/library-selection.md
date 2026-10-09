# Library selection for manual prompts

Implements [#56](https://github.com/michaelahoff/content-kanban/issues/56) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 4, 6, 15 and 16 for manual card chat prompts. Playbook selections are a later ticket. Folders ([#53](https://github.com/michaelahoff/content-kanban/issues/53), [Library folders](library-folders.md)) added the `folder` source kind. [General-file delivery](general-file-delivery.md) (#58) adds format recognition, the Codex shell-tool check and the copy evidence. [Folder selection](folder-selection.md) (#57) completes folder provenance, revalidation and drag-and-drop.

## Selection

The composer's `selections.library` is an ordered list of typed source IDs (`{ kind: 'asset' | 'folder', id }`, at most 200, duplicates collapsed). It is validated for shape only: a removed or foreign source may stay selected, and Send refuses it by name until it is corrected. Ordinary messages keep the selection. Fresh context clears it (bumping the composer revision). A primary-provider change clears the earlier choices but keeps any made in the same save. A model change keeps them; every Send rechecks the chosen model's capabilities. Frameboard has no temporary provider override yet, so there is nothing else to preserve.

## Resolution, preflight and capture

`chat-service.js` `preview()` is the one boundary for both **What will be sent** and authoritative queueing:

1. `store.library.resolve()` maps selections to each asset's current committed version, one entry per asset identity in first-selected position with every selection that named it (`sources`). Unresolvable sources become `resolve` problems naming the source ID; nothing resolves as empty.
2. `store.library.inspect()` classifies each version, checking that the card's project owns it: a PNG/JPEG/GIF/WebP raster is an image, UTF-8 without NUL bytes up to 8 MB is text, anything else is a file (format `text` when a larger file starts as text). Send reads every byte through retained storage, verifying the full SHA-256 and size. A preview reads files up to 8 MB the same way, but only samples the first bytes of larger ones and trusts their last verification, so typing with a multi-GiB file selected never re-hashes it. A missing or damaged original is an `integrity` problem.
3. `submission-inputs.js` `planInputs()` plans the whole union, card images first, then Library files, against the target. Send uses the model list it just discovered; a preview uses the saved catalog. A model that reports `inputModalities` without `image` refuses image inputs (`capability`); Codex discovery now keeps that field. Text goes inline; supported rasters use the native image route; other files go to Codex as independent workspace copies for its tools. Tool-disabled Claude refuses files and non-raster card images (`capability`), so an unsupported gallery image stops the whole submission even when every Library file is usable. Known limits (`limit`): 20 MB per image, Claude's 5 MB per image, 100 images and 32 MB per request (images counted base64 encoded), and text no model can hold (more than 8 MB, at most eight bytes per token against the largest one-million-token window). Text above a typical estimate for the smallest windows in use only warns; the provider decides.
4. Preview returns `problems` and `context.warnings`; Send throws `409` with the same `problems`. Send discovers the model first, so a file replaced while discovery runs is simply captured at its new version. It then re-resolves the selection synchronously with the commit, so a file replaced or removed while preflight was reading it is refused rather than sent stale.

The frozen `context.library` records each owning project, asset/version ID, version number, captured filename, SHA-256, size, kind, format, delivery method, selection sources and, for copies and images, the workspace path `references/library/<versionId>.<ext>`. Labels never become paths. Text bytes are not copied into the database; the retained version is immutable.

## Delivery and history

Before each attempt the worker calls `service.deliveryInputs()`: the card's image references as before, then Library inputs through `store.library.text()` (read verified) and `store.library.materialize()` (independent verified copies rebuilt from the frozen versions), both checking project ownership. The text message lists Library files after the card context, each labeled with filename, IDs, hash and size and fenced by version ID, under a statement that they are reference material, not instructions. A missing or damaged original fails that attempt with the file named; exact-byte repair followed by Retry resends the same frozen version. Retry never rereads the current version; a new Send captures the current one.

`chat_attempts.delivery` (schema migration 17) records each card image and Library input's outcome for that attempt. It is written as `sending` just before the turn starts and becomes `sent` once the harness accepts it; a crash in between leaves `sending`, shown as not confirmed. Otherwise inputs are `not-sent`, `uncertain` or `failed` with the reason: an attempt held or stopped after its inputs were prepared records them as not sent, a missing card image records every input as not sent with its reason (the submission is held as before), and any error preparing a Library input, including disk errors, fails the attempt with that file named. Sent means delivered to the harness, not proof the model read every byte. History shows the frozen files under **Submitted context** and the delivery outcome under each attempt.

## Backup

Composer selections and frozen submissions live in the database and are exported with it. `inspectBackupDatabase()` now also requires every frozen Library reference to name a retained committed version with the recorded hash and size, so export and restore refuse a bundle that would leave history pointing at missing bytes.

## Acceptance evidence

- `node --disable-warning=ExperimentalWarning --test test/submission-inputs.test.js`: representation, model-modality and limit rules for both providers, including Claude's request size and oversized text.
- `node --disable-warning=ExperimentalWarning --test test/chat-library.test.js`: full labeled text and exact frozen version to Codex; raster as native image and opaque file as an exact independent copy; Retry after Replace and restart keeps the frozen version while a new Send captures the current one, with per-attempt delivery; unresolved and damaged sources refused by identity, empty selection keeps card context; post-queue damage fails visibly, exact repair and Retry deliver; fresh context and provider change clear, model change keeps; Replace during preparation is captured current, never stale; Retry after rename and removal keeps the frozen label and bytes while a new Send refuses the removed source; delivery records card images and Library inputs as `sending` until accepted, and as not sent when stopped after preparation or when a card image is missing; a text-only model refuses images; a saved written document is sent as its saved version, never its unsaved draft; Send verifies every byte of a large file a preview only sampled; Claude receives inline text and image blocks through the native fixture and refuses a PDF or an AVIF card image for the whole union; export/restore keeps selections and frozen records and refuses a dangling frozen reference.
- `npm run test:browser`: select a Library script in the composer, see it in the exact preview, Send, and see its delivery under the attempt.

## Review

Parallel code review (Standards and Spec axes). Fixed, each new behavior with a test observed failing first:
- Library reads, classification and copies went straight to retained storage; they now go through `library.js`, which checks project ownership.
- Previews re-hashed whole large files.
- Model input modalities and Claude's request size were not checked.
- Oversized text sent to Claude got the wrong reason.
- Delivery outcomes covered only Library files. They now include card images, record `sending` before the turn, are never overwritten once accepted, and are recorded for any preparation error.
- Previews showed Library files before card context, although they are sent after it.

Duplicated guards, keys, limits and parses were consolidated, and Library loading in the composer now shows its errors. The archive fence was kept when discovery moved ahead of preflight. Kept deliberately:
- Repeating the same selection collapses to one source; a file reached through a folder and directly keeps both as provenance (#53).
- A provider change keeps only choices made in the same save; the browser clears them anyway.
- The commit-time re-resolve guards the preflight's own reads, a window HTTP tests cannot pause deterministically.
- A shutdown between the harness accepting a turn and recording it leaves `sending`, shown as not confirmed, rather than a guess.

A verification round on the fixes found two remaining gaps: attempts stopped or held after preparing inputs, and missing card images, recorded no delivery outcome. Both now record one, with tests observed failing first. `sourceKey` moved into Library vocabulary (`public/library-format.js`), and a duplicated comment and a repeated context read were removed.

Live native gates for Claude remain closed by retained-data protection (`assertProtection`); the Claude evidence uses the deterministic stream-json fixture with protection disabled.
