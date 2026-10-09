# Project assets: integrated workflows and release gates

Verifies [#67](https://github.com/michaelahoff/content-kanban/issues/67) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 1–26 and delivery stage 6. Every run below was made on 2026-10-09 against `main` at `b33db53`. This change adds tests, evidence scripts and documentation only. No runtime module changed, so the evidence applies to `main` as merged.

## Outcome

One protected execution configuration is usable, and every unproven one is held before execution.

| Route or configuration | Status | Evidence |
| --- | --- | --- |
| Codex 0.160.1 on Linux x64 with bubblewrap and Landlock ABI 10+, inside the retained-data boundary: ordinary turns, approved escalation and Full native access | **Enabled** | `npm run test:native` (15/15); signed-in live gate below |
| Inherited Codex setup (ADR 0002): hooks and MCP servers run inside the boundary | **Enabled, explicit opt-in** | `test:native`; the live gate ran in this mode |
| Isolated Codex selection on a machine whose inherited MCP servers or plugins have unproven isolation | **Held before execution** | The live gate's first submission was held with no native turn; `codex-configuration.test.js` |
| Full text and authored Markdown, both providers | Codex enabled; Claude held | Live gate (Codex); `chat-library.test.js` (Claude transport, protection off) |
| Supported raster images (PNG, JPEG, GIF, WebP) | Codex enabled; Claude held | Live gate (Codex); `chat-library.test.js` |
| Any other file (archives, PDFs, fonts, audio, video, opaque bytes, non-UTF-8 text) as a workspace copy for Codex's shell tool | **Enabled for Codex with its shell tool** | Live gate (gzip read with `zcat`); `test:native` (tar archive); a setup with `features.shell_tool = false` refuses the file by name |
| Every Claude model and setup | **Held**: no protected Claude configuration is proven ([ADR 0004](../adr/0004-native-retained-data-boundary.md)) | `release-workflows.test.js`: a Claude Send and a Claude lane run are held and no turn starts |
| Claude PDF route | **Unavailable**: the passing live evidence was gathered outside protection | [Claude PDF delivery](claude-pdf-delivery.md); `claude-pdf-gate.test.js` |
| Native audio or video input, any provider | **No route** | `submission-inputs.test.js`; general-file delivery |

Nothing is converted, extracted, transcribed or rendered by Frameboard. No paid API, Files API or automatic converter is used. Exact native resume after a restore is not claimed, and no lane engine beyond one submission per run is introduced.

## Integration against current main and the ADRs

The specification's baseline was `221b580`; the 20 commits since then implement its stages:

- #47 retained storage;
- #48 protection;
- #49 archive;
- #50 export;
- #51 restore;
- #52–#58 Library, documents, folders, version restore, copies, selection, folder provenance and general files;
- #59–#61 playbook selections, coherent capture, Retry versus Run playbook;
- #62–#65 saved documents, files, reuse and promotion;
- #66 the Claude PDF gate.

Each ticket's notes in this folder record its own decisions. Rechecked here:

- **ADR 0001.** Submissions remain the durable queue. Lane runs queue at most one submission. Recovery reads row states and replays nothing.
- **ADR 0002.** The isolated selection stays the default. The inherited setup stays an explicit saved choice, distinct from Full native access. The live gate needed it because this machine's `codex_apps` server and remote plugins have unproven per-thread isolation, the situation ADR 0002 describes.
- **ADR 0003.** Playbooks stay Markdown on disk behind `playbooks.js`. `assets:` is the selection's only record. The result block is the single reporting path, now carrying `outputs`.
- **ADR 0004.** Every native process tree runs inside the boundary, and Claude stays held.

Approved decisions remain as specified. Three clauses have nothing to verify because the feature they qualify does not exist:

- The temporary provider/model override in case 6. A model change keeps selections and rechecks capability; that is tested.
- Card restoration in cases 13 and 17. Stop, archive and workspace restore are the stronger revocations, and they are tested.
- A Library folder tree sidebar. Breadcrumbs and folder tiles carry navigation instead ([Library folders](library-folders.md)).

Excluded scope stays excluded: automatic inclusion, project defaults, live external links, agent editing of sources, permanent purging, scheduled or cloud backups, Frameboard conversion pipelines, and a context budget.

## Runs on 2026-10-09

The environment was Arch Linux x64, Node.js 22.17.1, Codex CLI 0.160.1, Claude Code 2.1.291, bubblewrap and Chromium.

- `npm test`: **380 passed, 15 opt-in native checks skipped, 0 failed**. The baseline on `main` before this change was 377 passed.
- `npm run test:native`: **15 passed, 0 failed**. Codex `gpt-6-luna` resolved to `gpt-5.6-luna` on the credential-free loopback peer, with 12 requests.
- `npm run test:browser`: **all checks passed**.
- `npm run test:retained-large`: 2,147,549,185 bytes passed import, materialization, independent copy, repair, restart and verified read. SHA-256 `62897f37…0780` matched. Peak RSS was **128.2 MiB**.
- `npm run test:library-large`: a 2,147,549,185-byte **Matroska video**, recognized by its bytes, went through every step together with an authored document and a 512-byte file of every byte value (NULs and invalid UTF-8, no recognized format). The steps were HTTP upload and download, a Codex Send that delivered the document inline and both files as exact workspace copies, export, restore, a restored download, and fresh-context rebuilds of both deleted copies. SHA-256 `65da027c…48c4` matched. Peak RSS was **179.6 MiB**, below the asserted 256 MiB.
- `npm run test:backup-large`: 2,147,549,185 bytes passed export, staged verification and restore. SHA-256 `0104cee8…8f8a` matched. Peak RSS was **129.3 MiB**.
- `npm run test:retained-disk-full`: a real ENOSPC on an isolated 16 MiB tmpfs kept the prior version current and reclaimed staging. The retry then committed.
- `npm run test:backup-disk-full`: a real ENOSPC during export kept the previous backup and published nothing. A real ENOSPC during restore activated nothing and kept the existing data. Both retries succeeded with matching hashes.
- `FRAMEBOARD_LIVE_TEST=1 node --disable-warning=ExperimentalWarning scripts/project-assets-live.mjs`: **passed**. Details follow.

### Signed-in Codex gate

`scripts/project-assets-live.mjs` is new and opt-in. It sends one bounded submission over Frameboard's public HTTP API with the installed Codex and the existing sign-in. Protection is on, as shipped. A card chat selects three Library files:

- a saved written document holding a random code (full text inline);
- a 384×192 PNG whose halves have two random colors (native image);
- a gzip file whose random code exists only once decompressed (a workspace copy).

The reply must report all four values.

The first submission used the default isolated selection. It was **held before any native turn**, because `codex_apps`, `openai-templates`, `work-pets`, `plugin-management` and `sites` have unproven isolation. The gate then saved the explicit full-setup choice (ADR 0002) with bounded instructions and sent from a new card. `gpt-6-luna` answered `BRIEF=A5406B; LEFT=blue; RIGHT=green; ARCHIVE=04AA9C`, which matched. Its single shell command was `zcat references/library/<versionId>.gz`; the transcript also shows an `imageView` item. The attempt's delivery recorded all three inputs `sent`, under protection policy `linux-retained-v1`, configuration `2aa944ad…efb7`. The evidence is kept locally in `test-results/project-assets-live-2026-10-09T15-46-14.594Z/evidence.json`.

Two earlier runs are reported as they happened:

1. The first version of the script treated the configuration hold as a failure. That hold is the expected behavior, and the script now records it.
2. The next run used a 64×32 image. The reply had both codes and the left color right, but named the right half yellow instead of green. The PNG was checked and is correct. The probe image was enlarged to 384×192 with saturated colors, and the following run passed.

These results show that the files were delivered and read for these three simple inputs on this account. They do not certify comprehension of complex or unusual formats.

The Claude PDF gate (`npm run test:claude-pdf`) passed the same day for all eleven offered models ([Claude PDF delivery](claude-pdf-delivery.md)). It was not rerun, because no Claude route is enabled while Claude is held. Subscribed Claude text and image checks are likewise not release gates until a protected Claude configuration exists.

## Integrated workflow tests

`test/release-workflows.test.js` follows whole user workflows through the public HTTP API with the controlled Codex peer:

1. **From Library to promotion.** An uploaded script in a folder and a written guide are sent by a manual prompt. A lane playbook selecting only the guide sends only the guide. The lane result saves an outline whose declared derivation is the guide's version. That outline is reused on the same card after the Library files, then promoted and selected on another card by its own identity. Fresh context clears the manual choices, while the playbook keeps its own.
2. **Export and restore of everything.** Two projects take part: an active one with a replaced script, a removed file, a written guide, a playbook selection, a saved and promoted reply and unfinished work, and an archived one with its own file and saved reply. They are exported from Settings under maintenance while one reply finishes and another waits queued. The bundle is restored into an empty directory. Everything a user can inspect over HTTP matches the pre-export state: projects and archive state, every Library identity, version and byte (removed and superseded ones included), cards, frozen submissions, saved outputs with provenance and bytes, and playbook text with its resolution. Nothing runs again: the queued follow-up is held and the archived project refuses new work. New explicit work in fresh context then sends the restored current versions.
3. **Claude stays held.** With the production Claude adapter and protection on, a Claude Send and a Claude lane run with Library files are both held, with the protection reason. No Claude turn reaches the harness. With protection turned off, the same test fails, so the hold is what it measures.

All three passed when first run. The features already existed, so passing tests are evidence, not new behavior. The third closes a gap: every earlier Claude test turned protection off.

## Acceptance cases

Unless noted, a test file below runs under `npm test`. "Browser" means `npm run test:browser`.

1. **Pass.** `library.test.js` covers uploads, stable identities, written documents, drafts excluded until Save, and a failed save keeping the prior version and the draft. Browser covers Write document and Save. `release-workflows.test.js` covers both kinds sent and exported.
2. **Pass.** `library.test.js` covers Create new (default) with an extension-preserving suffix, Replace, and Cancel. It also covers folder-local collisions, rename and move keeping identities, and equal bytes never merging. Browser checks the collision dialog.
3. **Pass.** `chat-library.test.js` covers recursive folders in path order, overlaps once with both provenances, an empty folder adding zero, and a removed folder blocking Send after its name is reused. Browser checks dragging a folder from the picker.
4. **Pass.** `chat-library.test.js` covers Retry after replace, move, removal, added members and a restart, which keeps the frozen versions, labels and membership. A new Send captures current sources and refuses removed ones. `lane-retry.test.js` covers the same for lanes.
5. **Pass.** `library.test.js` covers version restore as a new current version, and independent project copies surviving source removal, damage and archive.
6. **Pass, except the temporary override, which does not exist.** `chat-library.test.js` and `output-reuse.test.js` cover selections kept across messages and cleared by fresh context and provider change. A model change keeps them and rechecks the target. `release-workflows.test.js` shows playbook selections independent of manual ones.
7. **Pass.** `playbook-assets.test.js` covers inline and block lists, invalid, wrong-kind, foreign and removed IDs that stay visible and block, unresolved saves, and copies never rebinding.
8. **Pass.** `playbook-assets.test.js` shows picker edits preserving every other byte. Browser covers the hash conflict keeping the draft, joint saves, and the saved preview marking unsaved edits.
9. **Pass.** `playbook-assets.test.js` covers prose mentions selecting nothing, a same-named skill and Library file both sent separately, and an empty selection keeping gallery photos, the map and skills.
10. **Pass.** `lane-capture.test.js` covers inputs saved while pending, `run: off`/`manual` cancelling, revalidation during preparation, cancellation preventing insertion, and repeated preparation queueing once.
11. **Pass.** `playbook-assets.test.js` covers a removed source failing by identity with no submission. `lane-retry.test.js` covers correcting it and Run playbook. `playbooks.test.js` shows creation applying `set:` without an agent.
12. **Pass.** `lane-retry.test.js` covers Retry resending the whole frozen submission and Run playbook rerunning from current inputs. Prior effects survive and nothing claims node continuation.
13. **Pass, except card restoration, which does not exist.** `playbooks.test.js` covers departure cancelling undelivered runs, running work becoming proposals, and returning not restoring authority. Stop, archive and restore revoke late effects and registrations: `playbooks.test.js`, `archive.test.js`, `saved-outputs.test.js` and `saved-files.test.js`.
14. **Pass.** `chat.test.js` covers repeated request identity. `lane-capture.test.js` covers repeated preparation and distinct post-queue runs. `playbooks.test.js` and `archive.test.js` cover stale attempt callbacks. `lane-retry.test.js` and `restore.test.js` cover recovered replies that neither replay nor qualify for Retry.
15. **Pass for Codex, live and deterministic. Claude's transport passes deterministically and Claude is held.** `chat-library.test.js` covers full text and images for both providers, and one unsupported Claude gallery image failing the whole union. `submission-inputs.test.js` covers known limits blocking and uncertain sizes warning. `lane-capture.test.js` covers the lane union.
16. **Pass.** `test:native` and the live gate cover Codex reading exact independent copies with its tool. `chat-library.test.js` covers Claude getting inline content and never bare paths. PDF, audio and video stay gated. No converter exists.
17. **Pass, except card restoration.** `saved-outputs.test.js` and `saved-files.test.js` cover explicit saves only, no discovery, and snapshots surviving workspace edits, Stop, fresh context, card deletion, source removal and archive. Lane registration paths are checked there too.
18. **Pass.** `output-reuse.test.js` and `promote-outputs.test.js` cover same-card reuse without adoption, cross-card reuse only after promotion, promotion selecting nothing, and separate bytes. Image adoption and roles stay separate (`images.test.js`).
19. **Pass.** `saved-outputs.test.js`, `saved-files.test.js` and `promote-outputs.test.js` cover supplied context separate from declared derivation, and late or revoked registration publishing nothing. Recovered text stays saveable, failures never claim success, and retries never read a changed path or duplicate.
20. **Pass.** `test:library-large`, `test:retained-large` and `test:backup-large` are above. Asset storage has no type allowlist or 20 MiB limit.
21. **Pass.** `retained-storage.test.js` covers crashes at every publication boundary and ENOSPC injection. `test:retained-disk-full` and `test:backup-disk-full` use real ENOSPC. `library.test.js` covers batch siblings and retries.
22. **Pass.** `retained-storage.test.js`, `library.test.js`, `chat-library.test.js` and `lane-retry.test.js` cover damaged originals stopping only their uses, copies rebuilt from frozen originals, wrong-byte repair refused, exact repair, and no silent switch to current content.
23. **Pass for every enabled mode. Claude is held.** `test:native` covers ordinary, escalation, Full, inherited hooks and MCP, and links and path escapes. `native-boundary.test.js` covers sockets and the proxy. Playbooks and notes stay editable. `release-workflows.test.js` shows the Claude hold.
24. **Pass.** `archive.test.js` covers archive during preparation, queueing and running, restart and unarchive, and Retry not being revived. `restore.test.js` covers backup restore and old-runtime callbacks.
25. **Pass.** `restore.test.js` compares the complete inventory. `release-workflows.test.js` covers active and archived projects across every store in one bundle, with no execution or replay on startup.
26. **Pass.** `maintenance.test.js` and `export.test.js` cover writers, mutations, dispatch and late callbacks during maintenance, and interruption, ENOSPC and corruption during export. `restore.test.js` covers interrupted, disk-full, damaged, linked, newer and unsupported bundles, and historical approvals lapsing.

## Issue criteria

- **Integration rechecked.** See the integration section above.
- **26 cases mapped and workflows verified.** See the case list and the workflow tests.
- **Installed-native and subscribed-account checks.** `test:native` and the signed-in Codex gate. Claude remains held; its PDF route evidence is current but outside protection.
- **Bounded-memory, failure, repair and changed-reference trials.** The large and disk-full runs above, `retained-storage.test.js`, `lane-retry.test.js` and `chat-library.test.js`.
- **Races, revalidation, duplicates, stale callbacks, maintenance writers and backup rejection.** Cases 10, 14, 24 and 26.
- **A usable protected configuration, with unproven modes held.** Codex as above. The isolated-selection hold and the Claude hold are shown before execution.
- **Guidance published.** The README's **Project assets: what works today** section.

## Reproduce

```sh
npm test
npm run test:native
npm run test:browser
npm run test:retained-large && npm run test:library-large && npm run test:backup-large   # about 11 GiB free temporary space
npm run test:retained-disk-full && npm run test:backup-disk-full                         # Linux unprivileged user namespaces
FRAMEBOARD_LIVE_TEST=1 node --disable-warning=ExperimentalWarning scripts/project-assets-live.mjs  # one or two signed-in Codex submissions
```

A run of the live gate saves the full-setup choice in its own temporary data directory only, never in the user's app data. Evidence and logs stay local under `test-results/`, which is not committed.
