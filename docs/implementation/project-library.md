# Project Library: upload and inspect files

Implements [#52](https://github.com/michaelahoff/content-kanban/issues/52) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 1–2 and 20–22 for uploaded files. Folders, move/rename/removal ([#53](https://github.com/michaelahoff/content-kanban/issues/53)), written documents ([#54](https://github.com/michaelahoff/content-kanban/issues/54)), restoring older versions and project copies ([#55](https://github.com/michaelahoff/content-kanban/issues/55)) and prompt selection ([#56](https://github.com/michaelahoff/content-kanban/issues/56)) are later tickets. Every file currently lives at the Library root, so name collisions are root-local.

## Boundary

`store.library` (`library.js`) is the only Library domain module. It publishes and reads bytes through `store.retained` ([retained storage](retained-storage.md)) and reads listing metadata through the private `store-retained.js` queries; callers never see payload paths. Library files are retained objects of kind `asset` (and, later, `document`) with one owning project.

- `list(ctx, projectId)` returns live files with their current version (number, size, SHA-256, availability). `asset(ctx, projectId, assetId)` adds every committed version, newest first.
- `upload(ctx, projectId, { filename, operationId, collision?, assetId? }, source, { signal })` validates the label with `libraryFilename`. A taken name is refused with a `conflict` (`assetId`, `filename`, `suggested`) unless the caller chose `create` (an available `name (n).ext`, via `availableFilename`) or `replace` naming the asset that holds the name. An in-progress first upload also holds its name. Replace publishes a new version of that identity; nothing merges by name or bytes.
- A repeated `operationId` repeats that operation's original choice and name: a saved one is reported without reading new bytes, a failed one restarts with the same bytes (the recorded digest must match once complete). A retry whose chosen suffix has since been taken is refused rather than duplicating a name.
- `read`, `verify` and `repair` take a version ID scoped to the project. Reads verify the full SHA-256 and size first; a mismatch marks only that version unavailable. Repair accepts only the recorded hash and size and keeps the version identity and the current version.
- Uploads and repairs require an active project. Retained commit also refuses an archived project, so an archive landing mid-upload saves nothing. Maintenance refuses both at the HTTP boundary. Reads, listings and downloads work for archived projects.

Successful uploads, replacements and repairs append `asset` activity (`asset_uploaded`, `asset_replaced`, `asset_repaired`) so other tabs refresh an open Library.

## HTTP and browser

Routes are listed in the README. Upload metadata travels only in the query string (`filename`, `operation`, `collision`, `asset`); any other parameter, such as a hash, path or version ID, is refused because the server computes them. The body is streamed straight into retained storage with backpressure; a client disconnect aborts the publication, and a refused request closes the connection instead of reading the remaining body. Downloads stream verified bytes with `Content-Disposition` (RFC 5987 filename) and a sandboxing CSP. `?inline=1` uses an image or `text/plain` type only for the extensions `previewType` allows; HTML, SVG and everything else always download as `application/octet-stream`.

`public/library.js` renders the Library tab. Uploads use `XMLHttpRequest` with the `File` as the body, so the browser streams large files and reports progress. Files upload one at a time with per-file Waiting/Uploading/Saved/Cancelled/Failed rows; failures from disconnects or server errors offer Retry with the same operation and collision choice. Collisions are checked against the freshly loaded listing before sending, and a race reported by the server's `409` asks the same Create new (default) / Replace / Cancel question. The inspector previews images or the first 64 KB of text, lists versions with size, date and SHA-256, downloads any available version, rechecks bytes and offers Repair for unavailable versions.

## Backup

Library payloads were already required coverage of format-2 exports and restores. The manifest's retained inventory now also records each version's asset `label` (the current filename), so a restore compares Library labels as well as identities, relationships, sizes and hashes. Backups exported before this change, which lack labels, still restore.

## Acceptance evidence

- `node --disable-warning=ExperimentalWarning --test test/library.test.js`: filename/suffix/preview rules; stable identities after restart; conflict without a choice stores nothing; Create new suffixes; Replace versions with history; equal bytes stay separate; replace must name the holder; failed replacement/creation/batch siblings, retry after restart without duplicates, retry refused after its suffix was taken; damaged versions unavailable without substitution, wrong-byte repair refused, exact repair keeps identity; project ownership; archive (including mid-upload) and maintenance refusals; HTTP streaming, query-only metadata, refused hash/path claims, exact downloads, safe inline types, disconnect then retry; export/restore of every Library identity, label, version and byte; legacy unlabeled manifests restore and tampered labels fail.
- `npm run test:browser`: the Library tab uploads a batch, shows image thumbnails, offers Create new by default with the suffixed name, Replace to v2 and Cancel, previews text, downloads exact bytes and lists versions.
- `npm run test:library-large`: on 2026-10-08, 2,147,549,185 opaque bytes streamed through HTTP upload, HTTP download, export, restore and download from the restored app, matching SHA-256 `0104cee8964cd60376572aa1e33dc7df89acc5212a37fa3a1583cf0eb0ce8f8a`, with a 151.6 MiB peak RSS (asserted below 256 MiB).
- Crash, disk-full and interrupted-publication behavior is the retained-storage evidence (`test/retained-storage.test.js`, `npm run test:retained-disk-full`); the Library publishes through that same path.
