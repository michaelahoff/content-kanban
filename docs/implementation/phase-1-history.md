# Phase 1.1 history foundation — implementation evidence

Implementation ticket: [#19](https://github.com/michaelahoff/content-kanban/issues/19). Parent tracker: [#18](https://github.com/michaelahoff/content-kanban/issues/18). Acceptance authority: [completed specification](https://github.com/michaelahoff/content-kanban/issues/12#issuecomment-6041712115), especially Phase 1 case 10 and ADR 0001.

This milestone implements recording and read boundaries while keeping the existing board usable. It does not implement the Phase 1 native-agent release or Phase 3 timeline/restoration controls. The resolution comment on #19 records the exact tested commit.

## Implementation

- Schema version 5 migrates available feed/history facts into `activity_log`. Feed IDs and card-history IDs remain distinct and stable. Only unique exact matches are coalesced; unmatched or ambiguous facts survive without invented labels. New writes use only this canonical log. Existing recording tables remain retained migration input.
- Existing move records are preserved and their event references point to the canonical log's card-history IDs. Existing/deleted/imported cards receive exactly one history-begins saved state, atomically with schema/import work. Earlier complete card states are not reconstructed.
- Every new card mutation saves a complete state in its own transaction. Creation and movement include initial Set effects in their saved state. Gallery/role changes, image name/order changes, bulk prompt replacement, reorder, undo and deletion have separate states.
- Browser editing sessions use distinct IDs. Matching consecutive manual text saves replace the group's latest saved state; activity itself remains append-only. Two minutes idle, explicit close/switch, another editor/actor or a non-text mutation splits the group. Non-browser clients without an ID get separate states.
- Retained saved states are accessible through `GET /api/cards/:id/states`; the store provides workspace-scoped activity metadata and recording-time labels. There are no new restoration controls. The existing card-history/feed response shapes and local-access checks remain in place.

## Verification on 2026-10-07

Environment: Node.js 22.17.1; Chromium 153.0.8010.52 (Arch Linux). Provider/model/configuration: not applicable; this milestone starts no native harness and makes no model requests.

`npm test`: **52 passed, 0 failed**. This includes seven history integration cases and two new client lifecycle cases:

- Populated SQLite migration preserves feed cursors, actors, notes, timestamps, unmatched facts, deleted cards and existing move undo. Reopening adds no duplicate baseline. Ambiguous historical matches preserve every fact.
- Legacy JSON import records the actual imported baseline once.
- Manual grouping, exact idle boundary, close, another tab/actor, non-text mutations and restart retention.
- Complete snapshots across creation/Set, text, gallery/roles/image names, move/Set, reorder, undo, bulk prompt and card/lane/project deletion.
- A forced saved-state insertion failure rolls back the card, activity and move rows and emits no listener notification. Conflicting/invalid writes leave history untouched.
- Workspace-scoped retained reads, stable historical labels, no new writes to old recording tables and a clean foreign-key check.
- Client close flushes unsent drafts; typing during an in-flight save remains saved without reopening the earlier closed group.

The existing `npm run test:browser` suite passed all checks: text/URL saves, uploads/clipboard/Trifecta, gallery roles, movement/reload/undo, native drag/reorder/reduced motion, compact preferences, command graphs, lane/project operations, mobile layout, template metadata and multi-tab conflict resolution. The successful run used an external diagnostic wrapper imposing a ten-second deadline on browser protocol commands (`NODE_OPTIONS=--import=/tmp/frameboard-cdp-deadline.mjs timeout -k 3s 90s npm run test:browser`); it did not bypass checks or alter app execution. The suite now waits for the persisted editing-session close before its compact-board reload check.

T3 collaborative browser smoke check at `http://localhost:3107` used an isolated temporary database. Two text saves produced one editing-session state; closing flushed and closed it. Reopening, editing and Escape produced a distinct closed state and preserved the earlier state. SQLite inspection confirmed schema version 5 and no foreign-key violations.

`git diff --check` and JavaScript syntax checks passed. Screenshots from the full existing browser suite were written to ignored `test-results/`.

## Remaining Phase 1 work

- #20: Codex adapter and effective configuration isolation/native validation.
- #21: selected-card chat workbench, frozen manual context/submissions and persistent text.
- #22: per-field conflict protection, dirty leases, proposals and scoped native requests/grants.
- #23: required real native generation, exact-version image editing, retained outputs and independent adoption.
- #24: crash/restart reconciliation, SSE/reconnect, multi-card scheduling and durable indicators.
- #25: backup/restore and cumulative specification cases 1–12/native release gates.

Phase 1 remains open. Native image generation/editing and restart recovery remain mandatory before daily use; a text-only implementation does not satisfy the release boundary.
