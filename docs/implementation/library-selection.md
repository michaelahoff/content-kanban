# Library selection for manual prompts

Implements [#56](https://github.com/michaelahoff/content-kanban/issues/56) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 4, 6, 15 and 16 for manual card chat prompts. Folders ([#53](https://github.com/michaelahoff/content-kanban/issues/53)) and playbook selections are later tickets, so the only selectable source kind is `asset`.

## Selection

The composer's `selections.library` is an ordered list of typed source IDs (`{ kind: 'asset', id }`, at most 200, duplicates collapsed). It is validated for shape only: a removed or foreign source may stay selected, and Send refuses it by name until it is corrected. Ordinary messages keep the selection. Fresh context clears it (bumping the composer revision). A primary-provider change clears the earlier choices but keeps any made in the same save. A model change keeps them; every Send rechecks the chosen target's capabilities. Frameboard has no temporary provider override yet, so there is nothing else to preserve.

## Resolution, preflight and capture

`chat-service.js` `preview()` is the one boundary for both **What will be sent** and authoritative queueing:

1. `store.library.resolve()` maps selections to each asset's current committed version, one entry per asset identity in first-selected position with every selection that named it (`sources`). Unresolvable sources become `resolve` problems naming the source ID; nothing resolves as empty.
2. Each version is read through retained storage, which verifies its full SHA-256 and size. A missing or damaged original is an `integrity` problem. The same read classifies it: a PNG/JPEG/GIF/WebP raster is an image, UTF-8 without NUL bytes up to 8 MB is text, anything else is a file.
3. `submission-inputs.js` `planInputs()` plans the whole union, card images first, then Library files, against the target. Text goes inline; supported rasters use the native image route; other files go to Codex as independent workspace copies for its tools. Tool-disabled Claude refuses files and non-raster card images (`capability`), so an unsupported gallery image stops the whole submission even when every Library file is usable. Known limits (`limit`): 20 MB per image, Claude's 5 MB per image and 100 images per request, and text no model can hold (more than 8 MB, at most eight bytes per token against the largest one-million-token window). Text above a typical estimate for the smallest windows in use only warns; the provider decides.
4. Preview returns `problems` and `context.warnings`; Send throws `409` with the same `problems`. After the asynchronous discovery, Send re-resolves the selection synchronously with the commit, so a file replaced or removed during preparation is refused rather than sent stale.

The frozen `context.library` records each asset/version ID, version number, captured filename, SHA-256, size, kind, format, delivery method, selection sources and, for copies and images, the workspace path `references/library/<versionId>.<ext>`. Labels never become paths. Text bytes are not copied into the database; the retained version is immutable.

## Delivery and history

Before each attempt the worker calls `service.libraryInputs()`: inline text is read verified from retained storage; images and files are materialized as independent verified copies, rebuilt from the frozen versions. The text message lists Library files after the card context, each labeled with filename, IDs, hash and size and fenced by version ID, under a statement that they are reference material, not instructions. A missing or damaged original fails that attempt with the file named; exact-byte repair followed by Retry resends the same frozen version. Retry never rereads the current version; a new Send captures the current one.

`chat_attempts.delivery` (schema migration 16) records each Library input's outcome for that attempt: `sent`, `not-sent`, `uncertain` or `failed` with its reason. Sent means delivered to the harness, not proof the model read every byte. History shows the frozen files under **Submitted context** and the delivery outcome under each attempt.

## Backup

Composer selections and frozen submissions live in the database and are exported with it. `inspectBackupDatabase()` now also requires every frozen Library reference to name a retained committed version with the recorded hash and size, so export and restore refuse a bundle that would leave history pointing at missing bytes.

## Acceptance evidence

- `node --disable-warning=ExperimentalWarning --test test/submission-inputs.test.js`: representation and limit rules for both providers.
- `node --disable-warning=ExperimentalWarning --test test/chat-library.test.js`: full labeled text and exact frozen version to Codex; raster as native image and opaque file as an exact independent copy; Retry after Replace and restart keeps the frozen version while a new Send captures the current one, with per-attempt delivery; unresolved and damaged sources refused by identity, empty selection keeps card context; post-queue damage fails visibly, exact repair and Retry deliver; fresh context and provider change clear, model change keeps; Replace during preparation is revalidated; Claude receives inline text and image blocks through the native fixture and refuses a PDF or an AVIF card image for the whole union; export/restore keeps selections and frozen records and refuses a dangling frozen reference.
- `npm run test:browser`: select a Library script in the composer, see it in the exact preview, Send, and see its delivery under the attempt.

Live native gates for Claude remain closed by retained-data protection (`assertProtection`); the Claude evidence uses the deterministic stream-json fixture with protection disabled.
