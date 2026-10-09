# Verified workspace restore without resuming old work

Implements [#51](https://github.com/michaelahoff/content-kanban/issues/51) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md) section 10, acceptance cases 14, 20 and 24–26 (restore side). [Workspace export](workspace-export.md) (#50) produces the bundle.

## Restore

`restoreBackup()` in `backup.js`, run by `npm run restore` while the CLI holds the destination's data-directory lock:

1. Validates the manifest: format `frameboard-backup` version 1 or 2, unique safe relative paths (no absolute paths, `..`, backslashes or NULs) inside the app stores or `native/codex/`, hex SHA-256, sizes and modes. A destination inside the backup folder, or the reverse, is refused.
2. Refuses a destination that exists and is not an empty directory. Nothing is ever merged into or overwritten in a live workspace.
3. Reclaims abandoned staging beside the destination and claims new staging with the export's ownership proof: an exclusively created, OS-locked `.incomplete-<timestamp>-<id>.owner` file. Staging left by a crash is removed by the next restore or export there; anything without that proof is left alone.
4. Copies every app file into staging in one streamed pass with a 64 KiB buffer, hashing as it writes, refusing links, special files, linked directories and any size/hash mismatch. Native files are hashed before copying and again while copied.
5. Inspects the **staged** database: SQLite integrity and foreign keys, a schema no newer than this version supports, the manifest's relationship inventory (projects with archive state, table counts, retained versions, image versions and outputs) and required coverage (every referenced image version and every committed retained version, with matching hash and size). Bound native files are checked against the database's bound threads and hashed.
6. Writes the restore marker into the staged database's `meta` table (replacing one carried by a restored workspace that was exported before it was opened), fsyncs the staged directories, and copies bound native files: each is verified in a dot-named temporary file and linked into place exclusively, so existing native files are never replaced and a crash leaves no truncated native file. It then activates by one `rename` into the destination. A rename onto a directory that gained content meanwhile fails, so a concurrent writer's data is neither merged nor replaced. The overlap check against the backup folder resolves the real path of the destination's nearest existing ancestor before anything is created. Native placement needs hard links in the Codex home (unsupported filesystems such as exFAT fail the restore visibly); a crash between linking and cleanup can leave a complete dot-named temporary copy there, which nothing reads.

Any failure, interruption or disk exhaustion (reported as "Not enough disk space to restore the backup. Nothing was activated…") removes staging and any native file this restore created; the destination is not activated. The result reports `nativeResume: 'not verified'` and the recovery behaviour below.

## Recovery hold

`openStore()` finds the marker after migrations and, in one transaction before returning (so before the server creates its chat worker and lane runner), calls `store.chats.holdRestored()`, records one `restored` workspace activity entry and removes the marker:

- Attempts left active or uncertain by the old runtime become `interrupted` with cause `restored` and are revoked (`restored`), so a late native event, tool call, image save, note or result from them can have no effect. Startup reconciliation therefore has nothing to resend, requeue or import. Settled attempts keep their outcome; explicitly saving an image they already returned stays possible.
- Pending native requests are invalidated and conversation grants cleared: historical approvals confer no authority.
- Unfinished submissions in active projects are `held` (`hold: restored`) and need attention, with an explanation that the old workspace may already have delivered them, so new work could repeat their effects; they block their card's queue until cancelled. Unfinished work in archived projects or on deleted cards stays cancelled.
- Every earlier non-completed submission is revoked, so Retry is refused ("restored from a backup … Send a new prompt or Run playbook instead") and the button is hidden.
- Pending and queued lane runs become `held`; none starts and no result block is applied, so no proposal or note is created and a recovered reply is never turned into a failed Retry candidate. Run playbook replaces a held run (cancelling its submission), and moving or deleting the card closes it. Lane runs of closed cards are cancelled.
- Bound conversations become native-unavailable. Their history stays readable, but Frameboard does not promise exact native resumption: the binding names the old workspace path and the native index is not backed up. New work continues in fresh context.

Execution needs new explicit work: a Send or Run playbook discovers the provider on this machine (credentials are never restored), and before each turn the worker verifies and rebuilds reference copies in the card workspace from the authoritative image versions.

## Acceptance evidence

- `test/restore.test.js`:
  - Running work with an approval grant and pending request, a queued follow-up, a lane run waiting for its chat, a failed Retry candidate and archived work mid-interruption are restored beside a different native harness. Nothing dispatches across two restarts; work is held, attempts revoked, approvals and grants lapse, Retry is refused, archived work stays cancelled, and indicators explain the hold. New work in fresh context and Run playbook then run, and stay settled after another restart.
  - Active and archived projects, superseded/removed/archived retained versions, notes and workspaces round-trip: every bundled file hash, the table-count, project, retained-version and image inventories match the manifest (only `meta` gains the marker), and retained versions stream back exactly.
  - A newer-schema database, a damaged database, an inventory that no longer matches its database, a linked bundle directory, a destination reached through a link into the backup and an unsupported manifest are refused with nothing created. A restored workspace exported before it was opened restores again with one recovery hold.
  - Real child-process crashes during copying and before activation leave no destination; injected ENOSPC explains itself; a writer adding a file to the empty destination during restore keeps its file and nothing is merged; the next restore reclaims abandoned staging and succeeds.
  - Restored beside the same native harness with the old turn still running, its late tool call, image and result block change nothing, and new work repairs a tampered reference copy.
- `test/backup.test.js`: the CLI round trips now expect only the `restored` activity entry and native-unavailable bindings; damaged bytes are refused for an empty destination and existing data is refused separately.
- `npm run test:backup-disk-full` (2026-10-08): additionally restores into an isolated 16 MiB tmpfs holding 8 MiB of existing data. The real ENOSPC activates nothing and leaves the existing file intact; after space is freed the restore succeeds with a matching hash.
- `npm run test:backup-large` (2026-10-08): 2,147,549,185 bytes exported and restored with the single-pass restore; SHA-256 `0104cee8964cd60376572aa1e33dc7df89acc5212a37fa3a1583cf0eb0ce8f8a` matched; peak RSS 124.85 MiB.

The project has no typechecker; changed modules pass `node --check`.

## Code review

Two parallel axes ran against `origin/main...HEAD`.

- **Standards:** the export record's `mkdtemp` decision is now marked superseded; evidence dates corrected; duplicated status lists became `unfinishedSubmissions`/`unsettledAttempts`; `openStore` uses `supportedSchemaVersion`; database inspection failures are reported without matching error text. Bugs fixed: a marker carried by an unopened restored workspace made the next restore fail, and a linked destination could bypass the backup-folder overlap check. The lane-run `held` status deliberately mirrors the submission hold it accompanies.
- **Round 2:** Standards found that the overlap check ran after the destination's parent was created, so a refused restore could create folders inside the backup; it now resolves the nearest existing ancestor first (regression test added). Also: a clearer damaged-database message (a fixed restore prefix, still without matching error text), `supportedSchemaVersion` used throughout `openStore`, and the hard-link limitation documented. Spec passed; its note that a held submission's reason should warn about possible repetition was adopted.
- **Spec:** fixed: the manifest inventory is now checked before activation, outputs are in the round-trip evidence, interrupted native copies can no longer leave a truncated file, settled attempts are no longer revoked, and the activity entry counts only held submissions. Kept deliberately:
  - Unsettled attempts are not reconciled from native history. The native index is not backed up and every binding names the old workspace, so a read would be unreliable on another machine; the outcome retained in Frameboard is what stays inspectable, and nothing is marked failed or offered for Retry.
  - Retry is refused for every earlier non-completed submission: acceptance case 24 requires restore to prevent Retry resurrection, and execution needs new explicit work.
  - Bound conversations become native-unavailable. Otherwise the first follow-up fails the exact-binding check and leaves an uncertain delivery holding the card.
  - Reclaim in the destination's parent removes only staging proven abandoned by its free owner lock, as export does in a shared backup folder.
