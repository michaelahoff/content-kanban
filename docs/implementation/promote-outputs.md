# Promoting saved outputs to the project Library

Implements [#65](https://github.com/michaelahoff/content-kanban/issues/65) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 18–19 and 23–26, on top of [saved documents](saved-outputs.md) and the [Library](project-library.md). Same-card reuse without promotion is [#64](https://github.com/michaelahoff/content-kanban/issues/64).

## Records

Nothing new is stored outside existing tables. `store.library.promoteOutput()` reads the saved output's retained version verified and publishes those bytes through `retained.publish()` as a Library version with provenance `{ method: 'promote', cardId, savedOutputId, outputVersionId, requestedFilename, collision, folderId?, written: true }`:

- **Create new** makes a new `document` asset with its own identity and payload. Its bytes match the output's, but nothing aliases: the asset and the output each hold a separate retained version.
- **Replace** publishes a new version of the file holding the name. Every older version stays.

The asset (when its first version was promoted) and each promoted version carry `promotedFrom: { cardId, outputId, versionId }`. Each saved output lists its `promotions` (`assetId`, `versionId`, `filename`, `removed`, `outcome`, `promotedAt`), read from committed versions only, so a failed promotion is never listed.

## Who can promote

Only `POST /api/cards/:cardId/chat/saved-outputs/:outputId/promote` promotes, with `{ folderId, filename, collision?, assetId?, operation }`. Any other field, such as a hash or path, is refused: Frameboard reads the bytes itself. Saving an output (user or lane result) never touches the Library. A lane result `outputs` entry that asks for more (for example `library` or `replace`) is saved with the card chat only, and the result reports the ignored keys. The lane prompt says only the user can save to the project Library and suggests the agent say so in its notes.

Promotion selects nothing, changes no card, adopts no image and assigns no role.

## Placement and collisions

Promotion uses the Library's shared `placement()` rules, as uploads do. A taken name answers `409` with `conflict: { filename, suggested, assetId }` and publishes nothing; `collision: 'create'` takes the suffixed name; `collision: 'replace'` with the holder's `assetId` adds a version. The folder must be a live folder of the card's project. Repeating an `operation` reports a committed promotion again without new bytes; an operation started for another output is refused.

## Guards and failure

- An archived project refuses promotion (and the retained commit rechecks archive). Maintenance refuses it at the HTTP boundary, as every change.
- Only a `saved` output can be promoted. Promotion reads its bytes verified: a damaged or missing output version is refused, publishes nothing, and a Replace leaves the current version current.
- The saved output's status, version and bytes are never changed by promotion, its failure, or anything that later happens to the asset.

## Lifetimes

The asset and the output are independent. Deleting the source card, removing the asset or archiving the project leaves the other readable. Another card selects the promoted asset by its own identity and Send captures its version like any Library file.

## Browser

Each saved output beside its attempt offers **Save to project library…** with a folder and filename (default: the output's filename). A taken name asks Create new / Replace / Cancel (`chooseCollision()`, shared with the Library). Each distinct choice uses one operation, so a resubmitted lost response publishes once. Promotions show beside the output ("Saved to Library as …", "Replaced …", "(since removed)").

## Backup

Promoted versions are committed retained versions, so complete export and restore carry them, each with its own payload, and the provenance travels in the verified database.

## Acceptance evidence

`node --disable-warning=ExperimentalWarning --test test/promote-outputs.test.js`:

- A saved reply becomes a new Library document in a chosen folder with its own identity and version, exact bytes and `promotedFrom`; the output is unchanged and lists the promotion.
- A taken name publishes nothing until the user chooses; Create new takes `Hook guide (1).md`; Replace adds v2 and keeps v1; Replace naming the wrong file is refused.
- Promotion leaves composer selections, card images and the card revision unchanged. After the source card is deleted, another card selects and sends the promoted asset. Removing the asset and archiving leave the output and every asset version readable.
- A repeated operation publishes once; reusing it for another output, or sending a hash, is refused. Damaged output bytes refuse a Replace and keep the current version, claiming no promotion. Archive and maintenance refuse promotion.
- A lane result asking for Library placement saves the output only, reports the ignored keys, and the Library stays empty until the user promotes it.
- Export and restore keep the promoted asset, its versions, the outputs and their provenance, each with its own payload.

`npm run test:browser` saves a lane document to the Library, then saves it again over the same name, sees Create new (default), Replace and Cancel, and replaces it with v2.
