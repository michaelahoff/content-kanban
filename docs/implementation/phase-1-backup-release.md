# Phase 1.7: backup/restore and cumulative release evidence

Ticket: [#25](https://github.com/michaelahoff/content-kanban/issues/25). Acceptance authority: [specification cases 1–12 and native gates](https://github.com/michaelahoff/content-kanban/issues/12#issuecomment-6041712115), [durable backup contract](https://github.com/michaelahoff/content-kanban/issues/11#issuecomment-6041085002), ADRs 0001 and 0002.

## Backup and restore

[Complete workspace export](workspace-export.md) (#50) replaces this section's export format with manifest version 2: retained versions, streaming, in-app maintenance and abandoned-staging recovery. Restore still accepts format 1 bundles. The native selection and history-only labelling below are unchanged.

Stop Frameboard, then run:

```sh
npm run backup -- --data-dir data --output backups
npm run restore -- --backup backups/frameboard-<timestamp>-<suffix> --data-dir restored-data
```

Both commands accept `--codex-home`; its default is `CODEX_HOME` or `~/.codex`. `DATA_DIR` supplies the default app directory. Restore requires a new or empty app directory; move the old directory aside while the app is stopped rather than overwrite it. Start with `DATA_DIR=restored-data npm start` to inspect the restored history.

The timestamped folder contains a standalone `frameboard.db` written with `VACUUM INTO`, all `images/` and card `workspaces/`, and `manifest.json` with revision, schema, timestamp, file sizes, SHA-256 hashes and file modes. Empty workspace directories survive. Image integrity is checked against stored versions and frozen references, including images retained only by earlier saved states or move snapshots. Legacy images without earlier hashes receive a backup hash; this does not invent earlier integrity. Missing/damaged images, links and special files abort backup and remove the incomplete folder. Restore checks every manifest hash, database integrity, recorded image membership and allowed native paths before publishing the app directory from a sibling staging directory.

A separate sibling `.frameboard-lock.sqlite` holds an OS-backed SQLite exclusive lock for the app's lifetime and each backup/restore command. App writes, imports and native shutdown finish before releasing it. A hard process death releases the lock automatically; the small persistent lock database is not app history and is excluded from backups. A second app cannot use the same data directory. Backup also requires the app stopped to freeze workspace/image files alongside the database.

Native selection includes only bound current/previous/deleted-card Codex conversations: verified matching rollouts under `sessions/` or `archived_sessions/`, and validated image files under `generated_images/<threadId>/`. Missing rollouts are listed in `nativeMissing`. Unrelated conversations, `auth.json`, `.credentials.json`, config, global rules, skills and the global native index are not copied. Exclusions concern global files; app configuration, conversation content and workspace files remain part of retained history. Claude is deferred to Phase 2.

Native files are restored with exclusive creation and existing files are reported in `nativeSkipped`. Links in destination parents are refused. Restore never merges or overwrites the native index, and never submits or replays a prompt. A filesystem failure while copying native files may leave already-created missing files in place; app data is published only after copying succeeds, and retry still never overwrites native files.

Every backup and restore is labelled **History-only backup; native resume not verified.** The Codex `state_5.sqlite` dependency has not been proved satisfied by selected-file restoration. Authentication/global index copying is not used to manufacture a resume guarantee. Retained app history remains readable; missing native history uses the existing Needs attention/empty fresh-context flow. Restoring to another directory does not rewrite an exact native workspace binding.

## Evidence identity and locations

Run on 2026-10-07 (local date), Node.js 22.17.1, Codex 0.160.1, Arch Linux, Chromium. The starting revision was `129dfa572d1eb4e010aac5bb4e5da461a5d3c4be` on `phase1/history-foundation`; final verification tests this ticket's worktree, and its committed revision is recorded on #25.

The signed-in run records the starting revision plus exact source-diff SHA-256 `e069ff00e9a59f14091eed5c64adc9b2a21300e033941dc82b8221aca9ea65e6`. It ran `scripts/phase-1-live.mjs` through public Frameboard HTTP endpoints, using the developer's existing native sign-in, `gpt-6-luna`, ordinary sandbox/approval, full Codex setup under ADR 0002, configuration `150a14d64509a3d61ea456428f42f5097e771c331d41a25e34d05d0a80372782`. Raw evidence and images are local in `test-results/phase-1-live-2026-10-07T22-43-12.214Z/evidence.json`; the app data remains at `/tmp/frameboard-phase-1-live-QYDv6O`. Later changes affect backup inspection/shutdown and acceptance tests; the generation/edit/resumed-tool path is unchanged.

Three bounded signed-in submissions generated one green square, edited that exact retained version blue, and called `read_card` after a second hard native restart. Between generation and import, completed-image/subsequent notifications were dropped at the transport boundary. A read-only native history check established persistence before SIGKILL. Restart imported exactly once with no model request. The edit froze the source output ID/hash, returned a new image with its relationship/tool prompt, and retained the source. Visual inspection confirmed the square's size, position and white background were preserved. Adoption was role-free and idempotent. A third submission resumed the exact binding and successfully called the persisted dynamic card tool. Two native images were used; no approval request occurred.

Source hash: `ef04abfd5e3ff548b636995a77a9f1fb476e94a19f1c638e3c96c50b6411d3f5`. Edit hash: `ff4c9b0e5ee3705ce4938427e111ff10b81a24a374e4fb26d7465d9660db2840`.

The real data was backed up to `test-results/phase-1-live-2026-10-07T22-43-12.214Z/backups/frameboard-2026-10-08T00-26-10.977Z-AKRkAY`, then restored with an empty native home and again with the existing signed-in home. Exactly one rollout and two generated-image files were selected. All three existing native files were skipped on the second restore. A public-HTTP inspection compared the source and restored workspace, card, saved states and complete chat: all matched, both served image hashes matched, and zero native submissions occurred (`restore-evidence.json` beside the signed-in evidence). Commands/logs: `/tmp/frameboard-25-live-backup.log`, `/tmp/frameboard-25-live-restore.log`, `/tmp/frameboard-25-live-no-overwrite.log`. No native resume guarantee is inferred from these results.

Other local logs: `/tmp/frameboard-25-native-tests.log`, `/tmp/frameboard-25-browser-tests.log`, `/tmp/frameboard-25-tests.log`. Browser artifacts include `test-results/phase-1-mobile-chat.png` and `test-results/phase-1-input-needed.png`. Artifacts are deliberately outside version control; the test sources and this case-by-case account are retained.

## Cumulative cases 1–12

1. **Workbench — pass.** `scripts/browser-test.mjs` verifies desktop and 390px Editor/Chat tabs, per-card composer/reference retention, switch/hide/reopen, idle views creating no native conversation, other-card progress and a static reduced-motion Working indicator. Existing board/mobile checks also pass.
2. **Frozen submissions — pass.** `test/chat.test.js` verifies defaults/changed selections, duplicate role deduplication, exact references, immutable saved context, repeated POST identity and intentional repeated prompts. `test/images.test.js` covers explicit uploaded/prior-output references together; browser checks retain the exact role reference.
3. **Identity/configuration — pass for supported shapes.** `test/chat.test.js` and `test/codex-configuration.test.js` cover frozen targets, fresh context, grant reset and removed/new capability holds. All nine installed-native gates in `test/codex-native.test.js` pass, including public HTTP follow-up after process/app restart, model change, persisted dynamic tools, unloaded/cold configurations and newly discovered items. The signed-in run additionally invokes `read_card` through the worker after cold resume. Unsupported isolated MCP/plugin/hook/skill shapes remain unavailable; full setup is explicit, as amended by ADR 0002.
4. **Protected changes — pass.** `test/protection.test.js` and `test/client.test.js` exercise requested direct edits/proposals, independent per-field conflicts and dirty leases, multiple tabs, unrelated matching fields, fresh acceptance previews and originating-card authority. Browser regressions retain conflicted drafts and preserve manual/lane-command writes.
5. **Requests/Stop — pass.** `test/chat.test.js`, `test/protection.test.js`, `test/recovery.test.js` and `test/images.test.js` verify scoped Allow/Deny, Stop during request/streaming waits, durable grant limits, invalidation/late fencing, partial text/completed-image retention and no Done for user Stop. The installed-native permissions gate executes a real sandbox escape and restores ordinary sandbox settings on follow-up.
6. **Native images/edit/adoption — pass.** The signed-in run above proves generation, exact-source edit/provenance, independent retention and idempotent role-free adoption. Current `test/images.test.js` also verifies multiple valid outputs with independent adoption and later roles, and retaining another selected attachment. Earlier live multiple-output evidence remains in `phase-1-images.md`.
7. **Image failures — pass.** `test/images.test.js` covers failed saving/save-only retry, missing/damaged bytes, invalid/oversize/linked/escaping rendered files, generation failure, and Stop after completion. `test/backup.test.js` rejects missing/damaged retained images and detects damaged backup files without changing existing app data.
8. **Recovery/streaming — pass.** Controlled HTTP failure/event cases in `test/recovery.test.js` and cursor/offset cases in `test/stream.test.js` establish race outcomes, lost acknowledgements, proven non-delivery, uncertainty holds, no automatic accepted-turn replay and deduplication. Installed-native HTTP SIGKILL gates retain interrupted text and resume exactly. The signed-in image gate imports a real completed native image once, without a model request. Browser delta/timer checks pass.
9. **Deletion/missing/outside history — pass.** `test/chat.test.js`, `test/recovery.test.js` and the installed missing-rollout gate retain history while preventing new/deleted-card execution and silent substitution. Outside-native turns hold the next prompt and are not imported. Existing browser draft, Set graph, undo and image-role regressions pass. Restart regression tests now stop the original app before reopening rather than run two simultaneous apps on the same database.
10. **History/backup — pass with history-only native fallback.** `test/history.test.js` re-runs migration baselines/editing-session boundaries and separate agent/move/adoption states. `test/backup.test.js` verifies lossless public-API history/image/role/workspace round trips, executable files, hash damage, secret/path/link exclusions, no overwrite, manifest membership and lock release after SIGKILL. Real signed-in files also round-trip as described above. Native restored resume, including index dependencies, remains explicitly unverified.
11. **Concurrency/limits — pass within recorded capability limits.** `test/recovery.test.js` and the installed-native HTTP gate run three cards with mixed text, pending approval and registered image work: the image card completes while the others remain active, one attempt per card, no app cap. The native concurrent image is labelled code-rendered; signed-in raster generation is the separate live proof. Controlled failures verify overload backoff only for proven non-acceptance, unavailable targets without substitution, and explicit retry/reset information after exhausted usage. The live account accepted the three bounded requests above; rejection/usage exhaustion was not provoked, so account concurrency entitlement or unlimited usage is not claimed.
12. **Activity — pass.** `test/recovery.test.js` rebuilds Input needed > Needs attention > Working > Done from durable rows. Browser checks verify the running timer, streamed text, request-specific workspace navigation/focus, completion while hidden, and another HTTP client clearing Done for all views. Stream reconnect/cursor behavior passes `test/stream.test.js`.

## Gate status and reproduction

The mandatory Codex text, follow-up/resume, generation/reference edit, protected conflicts and recovery gates have integration evidence under the recorded supported configuration. Backup uses the specified honest native-resume fallback. No Claude, overrides, reviewed transfer, Send graph nodes, full timeline or whole-card restoration are enabled; those remain Phase 2/3.

Run the cumulative deterministic suite, then installed-harness and browser checks:

```sh
npm test
npm run test:native
npm run test:browser
FRAMEBOARD_LIVE_TEST=1 node --disable-warning=ExperimentalWarning scripts/phase-1-live.mjs
```

The last command uses the signed-in account for three bounded submissions and writes a separate timestamped local evidence folder. Local loopback/native fixture results establish mechanics, not account/model entitlement. A failure of any mandatory gate holds the daily-use release; an unsupported optional shape keeps its unavailable reason rather than enabling an unverified workaround. No account exhaustion is required or deliberately induced.

Final tested source-diff SHA-256 (against `129dfa5`, JavaScript/MJS/package files): `a329bd30799076b824424835be20d33934821166328e9a08986c2b54c22531c2`.

- `npm test`: **133 passed, 9 opt-in native checks skipped, 0 failed**.
- `npm run test:native`: **9 passed, 0 failed**.
- `npm run test:browser`: **all baseline and cumulative chat checks passed**.
- Syntax checks passed for all changed runtime/command/browser files. No typecheck/lint command or TypeScript project is configured.

During expansion, one browser run hit the existing Chromium protocol flake “Inspected target navigated or closed” immediately after compact-board reload, before the new checks. It also appeared in earlier image milestone evidence. A later run stalled after the baseline; the browser protocol stopped answering evaluation commands. It was terminated, command timeouts were added, and the final rerun passed the full baseline and chat checks. The cause of that Chromium stall was not established. Test-development failures were corrected: load newly API-created cards with navigation before testing them, and compare request focus with its durable app ID rather than its native ID.

## Standards review

No documented-standard breaches. One optional possible Duplicated Code finding in restore hash validation was addressed by `verifiedBackupBytes`, preserving separate preflight/copy reads to catch intervening damage. Database backup inspection remains in `store.js`, and the lock/import-drain changes serve the consistency requirement. The reviewed fixed point is `129dfa5` against the pre-commit staged implementation.

## Spec review

No confirmed missing requirements, wrong behavior or scope creep. Independent review verified selected native files, no overwrite, history-only fallback, case-by-case evidence, real signed-in generation/edit/recovery/resumed tools and the disclosed three-card loopback/provider-limit boundary.

Review totals: Standards **0 hard violations, 1 optional heuristic addressed**; Spec **0 findings**. No unresolved blocking findings on either axis.
