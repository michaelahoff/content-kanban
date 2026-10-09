# Complete streamed workspace export under maintenance

Implements [#50](https://github.com/michaelahoff/content-kanban/issues/50) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md) section 10, acceptance cases 20, 25 and 26 (export side). Whole-workspace restore with startup holds is [#51](https://github.com/michaelahoff/content-kanban/issues/51); this change only keeps the existing restore able to read format 2 with streamed copies and retained coverage checks.

## Maintenance (in-app export)

`maintenance.js` coordinates one export at a time; `server.js` exposes `GET /api/maintenance`, `POST /api/maintenance/export {output?}` (202) and `POST /api/maintenance/cancel`. Settings → **Export workspace** uses them.

- Starting maintenance refuses every mutating API request (edits, saves, composer drafts, uploads, YouTube imports, submissions, Retry, lane runs, notes, playbooks, projects/lanes, settings) with 503 and a retryable message. The browser's save queue keeps such writes and offers retry. Only Stop, answers to pending native requests and the maintenance routes stay available, so running work can finish or be explicitly cancelled. The gate refuses by default, so a new mutating route is covered without being listed.
- The chat worker and lane runner take a `paused` predicate: no new submission is claimed and no pending lane run starts. Queued submissions and pending runs are not cancelled and dispatch when maintenance ends. Projects are never archived by maintenance.
- Draining waits until no mutating request (including Stop and answers) is in flight, the worker has no live attempt, image save or read-only reconciliation (startup, process-exit recheck), the lane runner is idle, no attempt is dispatching/accepted/running/interrupt-requested, and chat/provider preparation has settled. The status lists the running attempts that block the export.
- Native image saves that arrive during maintenance are deferred: the output is captured as pending and its bytes are imported when maintenance ends, so no app writer adds files to `images/` during the export. Transcript and status rows written by running work stay in SQLite only.
- Stop uses the existing persistent attempt revocation. A late native callback for a stopped attempt is kept in its transcript but registers no output or card effect; the stopped submission stays interrupted after maintenance. Late transcript writes after the snapshot cannot alter the bundle: SQLite is copied atomically with `VACUUM INTO`.
- Native files are collected from the Codex home the harness reports, falling back to `CODEX_HOME`/`~/.codex`.

The CLI (`npm run backup`) still requires the app to be stopped, which quiesces every app writer through the data-directory lock. It now points to Settings while the app runs.

## Export format 2

`createBackup()` in `backup.js`:

1. Reclaims abandoned staging in the backup folder. Each export creates `.incomplete-<timestamp>-<id>.owner` exclusively, locks it (OS-backed SQLite lock, released by the kernel if the process dies) and only then creates the staging folder. Reclaim removes a folder only when its name has that exact form, its owner file exists and the lock is free; a live export's staging, unrelated `.incomplete-*` folders and format-1 `mkdtemp` leftovers (no proof of ownership) are never touched. A lone owner file is removed only after an hour. Staging abandoned in a different backup folder is reclaimed the next time that folder is used.
2. Scans `images/`, `workspaces/`, `flows/`, `retained/` (excluding temporary `retained/staging/`) and `board.json.migrated`, recording each file's device/inode/size/mtime/ctime/mode. Links and special files are refused.
3. Snapshots and integrity-checks the database, then inventories database references: image versions (including those only in saved states, moves or frozen submissions), every committed retained version (superseded, removed and unavailable included), saved image outputs, projects with archive/deletion state, and row counts for every table. A referenced payload absent from the scan fails the export, as does a missing `flows/<flowId>/MAP.md` for any project that is not deleted (startup always creates one).
4. Streams each file through SHA-256 with one 64 KiB buffer into private staging (`O_EXCL`, fsync), refusing a file whose identity changed since the scan or during the copy. Images must match their recorded hash; retained versions must match recorded hash and size. Bound native rollouts and generated images are copied and validated the same way.
5. Re-reads every staged file to verify size and hash, then rescans app data. Any added, removed or changed file or directory (for example an external editor saving a playbook, or a process writing a card workspace) fails with the paths and asks the user to close the program and retry. This also catches any residual in-process file write (such as a first-time playbook folder creation from a board read), so it can only cause a visible, retryable failure, never a mixed bundle.
6. Writes and fsyncs `manifest.json` (`format: frameboard-backup`, `version: 2`, schema, revision, coverage statement, native-resume label, inventory and per-file size/SHA-256/mode), fsyncs the folder and publishes it by one rename into `frameboard-<timestamp>-<id>`.

Any failure, cancellation (`AbortSignal`) or ENOSPC/EDQUOT anywhere in the export (reported as "Not enough disk space for the backup…") removes staging and publishes nothing; earlier backups are never opened for writing. A failed copy removes only the partial file it created, including during native restore.

### Inventory

`inventory.retained` records version/object/project identity, kind, filename, base version, current/removed state, bundle path, size and hash. `inventory.outputs` records every chat image output: saved outputs point at their bundled `images/` version; unsaved outputs are marked `retained: false` with the bundled native file when it was collected from a bound conversation, otherwise `null`. A saved output whose image version is missing fails the export, so required retained content is never only a native-path pointer. `coverage` lists what is included and excluded: global native credentials/configuration, unrelated native conversations, native Claude session files (their card chat history is in the database), the native index, external service data, unsaved editor text, temporary staging and never-saved outputs.

## Acceptance evidence

- `test/export.test.js`: reclaim sparing unproven `.incomplete-*` folders; missing project map as required coverage; retained versions including superseded/removed with relationship inventory; missing/corrupt payloads with the last good backup preserved; a real child-process crash mid-copy followed by reclaim that spares a concurrently paused export; cancellation and injected ENOSPC; external playbook edits and new workspace files during export; archived/active projects, table counts and coverage.
- `test/maintenance.test.js`: mutations/uploads/submissions/lane runs/playbooks/notes refused during maintenance while a running reply finishes, with the bundle's own database showing the completed reply and the still-queued follow-up, which then dispatches; Stop during maintenance with a late native image fenced and the stop persisting; cancellation publishing nothing and resuming work; saved, collected and missing native image-output inventory; a native image save arriving during maintenance staying pending in the bundle and importing afterwards.
- `test/backup.test.js` (unchanged) still passes against format 2: lossless round trip, native selection and secret exclusion, lock refusal, missing/damaged images, modes, links, manifest tampering and crash lock release.
- `npm run test:backup-large` (2026-10-08): 2,147,549,185 opaque retained bytes exported, verified and restored; SHA-256 `0104cee8964cd60376572aa1e33dc7df89acc5212a37fa3a1583cf0eb0ce8f8a` matched; peak RSS 125.12 MiB after the review fixes (asserted below 256 MiB). Needs about 7 GiB of free temporary space.
- `npm run test:backup-disk-full` (2026-10-08): the backup folder is an isolated 16 MiB tmpfs in a Linux user/mount namespace. A 14 MiB export beside an 8 MiB last good backup fails with the real ENOSPC and the disk-space message; only the previous backup remains; after it is removed, the next export publishes.
- `npm run test:browser`: Settings export pauses changes and reports the verified folder.

The project has no typechecker; changed modules pass `node --check`, and `npm test` passed in full.

## Code review

Two parallel review axes ran against `main...HEAD`.

- **Standards** found one documented-standard breach: the retained-storage boundary text said all payload filesystem access stays in `retained-storage.js`. The boundary now records the export/restore exception. The judgement calls were addressed as follows:
  - The duplicated attempt-status list became `store.chats.activeAttempts`.
  - The duplicated SQLite lock became the shared `holdExclusiveLock` in `data-lock.js`.
  - Per-file `find` lookups became maps.
  - Repeated size/hash checks became `sameBytes`.
  - Names were clarified (`hashCopy`, `explainDiskFull`, `temporaryStores`, `exportWorkspace`).
  - Restore staging uses `mkdtemp` again.
  - Two bugs were fixed: the owner-file creation/lock race (exclusive creation before locking; reclaim requires an existing owner beside a folder) and partial native restore files.
  - The hashing loop shared in spirit with `retained-storage.js` stays separate, because their failure semantics differ.
- **Spec** findings were fixed:
  - Background reconciliation is now drained, and image saves are deferred during maintenance.
  - Reclaim requires proof of ownership.
  - Stop and answers are tracked for draining.
  - The disk-space message now covers the whole export.
  - Project maps are required coverage.
  - Maintenance remains an HTTP-plus-dispatch gate rather than a store-wide write freeze: freezing the store would drop late transcript history that the spec requires to be retained. The atomic database snapshot and the file rescan make any residual write a visible failure.
  - Accepting format 2 in the existing restore is kept deliberately, so the README's backup round trip keeps working; #51 owns restore holds and startup behaviour.

A second round on both axes, run against `main...HEAD`, returned **PASS** on each, with no blocking findings. Its non-blocking notes were also addressed:
- Reclaim tolerates another export publishing concurrently, and an unreadable `.owner` file.
- The maintenance route gate uses an exact match.
- The boundary exception names `inspectBackupDatabase`.
- Coverage now lists native Claude session files as excluded.
