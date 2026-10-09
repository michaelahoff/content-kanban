# Restoring versions and project copies

Implements [#55](https://github.com/michaelahoff/content-kanban/issues/55) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance case 5, on top of [uploads and inspection](project-library.md), [written documents](project-library.md#written-documents) and [folders](library-folders.md).

## Restoring an older version

`store.library.restoreVersion(ctx, projectId, assetId, { versionId, baseVersionId, operationId })` reads the older version verified through retained storage and publishes those bytes as a new version of the same asset. Nothing is revived or rewritten: every version in between stays, and queued submissions, Retry and downloads keep the exact version IDs they captured. The new version's provenance is `{ method: 'restore', restoredFromVersionId, baseVersionId }`, and listings show it as `restoredFrom`.

- **Explicit about what it replaces.** `baseVersionId` must name the current version the user saw. Otherwise the `409` carries `conflict.currentVersion`, as a stale document save does. Publication's own commit check also refuses a version saved while the bytes stream.
- Restoring the current version is refused. Restoring content the current version already has publishes nothing (`unchanged`), as an unchanged document save does.
- The version must belong to that asset and project. A removed file or an archived project refuses restoration (maintenance refuses it at the HTTP boundary). Removed files keep every version readable, but nothing is restored into them.
- **Failure leaves the current version current.** A damaged older version is refused as unavailable and never substituted. An interrupted publication commits nothing. A retry of the same operation repeats it, and a retry of a committed one reports that version without publishing again.
- A restored version saved from the editor stays `written`, so it previews and edits as text (see below).

A document draft begun from the previous current version meets the existing newer-version conflict when saved, so a restoration is never silently overwritten.

## Copying into another project

`store.library.copyAsset(ctx, projectId, assetId, { targetProjectId, folderId, filename, collision?, operationId })` creates a new asset in the destination project (or, without special cases, in the same project) through `retained.copy`. It holds independent verified bytes of the source's current version only, starting at v1. The copy's own identity and payload file never alias the source, even though their hashes match. Provenance records `copiedFromVersionId`, `sourceProjectId` and `sourceAssetId`, and the asset carries `copiedFrom`. Its kind follows the source: a copied document is a document.

- **Destination and name.** The folder must be a live folder of the destination project, or `null` for its root. The filename is validated as a label. A copy follows the shared `placement` rules: a taken name in the destination folder answers `409` with `conflict.suggested`, and `collision: 'create'` takes the suffixed name. A copy never becomes a version of a destination file, so `collision: 'replace'` is refused and the conflict carries no `assetId`. The user can choose Create new, another name, or Cancel.
- **Both projects** must exist in the workspace and be active. The source must be a live Library file of the named project.
- **Independent lifetime.** Removing, damaging or replacing the source, or archiving its project, never affects the copy: its bytes are its own and its listing, selection and downloads need nothing from the source.
- **Failure.** An interrupted copy commits nothing in the destination and leaves the name free. A retry of the same operation copies the version the operation began with, even if the source has a newer version since, and verifies those bytes again. A damaged source is refused until exactly repaired. A committed copy is reported again on retry, even if its source was removed since.

`asset_restored` (source project) and `asset_copied` (destination project) activity entries refresh other tabs.

## HTTP and browser

`POST /api/projects/:id/library/assets/:assetId/restore` takes `{ versionId, baseVersionId, operation }`, and `POST .../copy` takes `{ targetProjectId, folderId, filename, collision?, operation }`. Any other field, such as a hash or path, is refused: Frameboard reads and verifies the bytes itself.

In the file inspector (`public/library.js`), each older available version offers **Restore** with a confirmation that names the version it saves ("Saves v4 with the content of v1"). Restored versions read "restored from vN". **Copy to project…** picks an active project, one of its folders and a filename. A taken name asks the collision question without Replace. The inspector of a copy says which project it was copied from. Each confirmation uses one operation ID, so resubmitting after a failure never saves twice.

## Backup

Nothing new is stored outside existing tables: restorations and copies are retained versions with provenance, so complete export/restore already carries them. The manifest inventories the copy under its own object, project and payload path.

## Acceptance evidence

- `node --disable-warning=ExperimentalWarning --test test/library.test.js`:
  - Restoration adds a new current version and keeps every intervening version and its bytes. Resolution captures the new version, and a retry publishes nothing more.
  - Stale base, already-current, unchanged content, foreign version or project, removed file and archived project are each refused.
  - A failed or interrupted restoration, or one from damaged bytes, keeps the current version; after repair, the retry publishes once.
  - A restored written version stays written.
  - A project copy holds only the current content under a new identity, folder and name. Its retry repeats it. Source damage, removal, archive and a restart leave the copy readable and resolvable.
  - Destination collisions offer Create new and never Replace; another name works; equal bytes never merge with a held file.
  - Foreign folders, unknown projects, wrong source projects, unsafe names, either project archived and removed sources are each refused.
  - An interrupted copy leaves nothing in the destination, and its retry copies the version it began with, verified, after the source was replaced and repaired.
  - A copied document stays a written document.
  - Over HTTP: restore conflicts and refusals, copy collisions, refused hash/path/version claims, downloads scoped to each project, and archive and maintenance refusals.
  - Export and restore keep a restored history and an archived, removed source beside its independent copy, with separate payloads, identities, relationships and bytes.
- `npm run test:browser`: Restore of v1 saves v3 marked "restored from v1" and previews v1's text. Copy to project places the file in a chosen folder of another project. A second copy asks Create new or Cancel and saves `Hook guide (1).md`.
