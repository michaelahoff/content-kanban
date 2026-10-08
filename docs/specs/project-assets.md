# Project assets for card prompts

Status: consolidated specification awaiting final confirmation for [Set project asset acceptance criteria and implementation specification](https://github.com/michaelahoff/content-kanban/issues/42). Planning only. The established decisions and both synthesis refinements in section 12 are approved. This ticket stays open until the user confirms the complete specification, delivery sequence and that no in-scope decisions remain.

Baseline: `main` at `221b580e73ec21d92306c47262e7df03e125108a`, checked 2026-10-08. Changes after that baseline require an integration check before implementation. The [project asset map](https://github.com/michaelahoff/content-kanban/issues/34) ends at an implementation-ready specification, with production work following separately.

## 1. Decision sources and precedence

The following named resolutions remain the canonical decision records. This document consolidates their implementation consequences; it does not replace their history.

- [Define project asset identity, versions, and lifecycle](https://github.com/michaelahoff/content-kanban/issues/35#issuecomment-6066172012): ownership, folders, versions, collisions, removal and archive.
- [Verify native delivery of text, images, and arbitrary project files](https://github.com/michaelahoff/content-kanban/issues/36#issuecomment-6065865768): version-pinned native transport evidence and outstanding live gates.
- [Define selected asset context and prompt delivery behavior](https://github.com/michaelahoff/content-kanban/issues/37#issuecomment-6066376519): explicit selection, queue-time capture, representations, failures and manual-context lifecycle.
- [Design the project asset library and prompt picker](https://github.com/michaelahoff/content-kanban/issues/38#issuecomment-6067318202): project Library tab, compact selections and expandable inspection. This supersedes the earlier dock preference.
- [Define project asset selection for lane-triggered prompts](https://github.com/michaelahoff/content-kanban/issues/39#issuecomment-6066522283): historical reusable-source and shared-submission contract only. The later playbook decisions replace entry-frozen definitions and failed-node continuation.
- [Define derived outputs and reuse as project assets](https://github.com/michaelahoff/content-kanban/issues/40#issuecomment-6067317434): retained outputs, adoption, promotion, provenance and save failures.
- [Define project asset persistence, backup, and recovery boundaries](https://github.com/michaelahoff/content-kanban/issues/41#issuecomment-6068465393): storage, preservation, streaming, repair, archive and complete export/restore.
- [Reconcile project asset decisions with merged lane playbooks](https://github.com/michaelahoff/content-kanban/issues/44#issuecomment-6068585929): current-main integration evidence.
- [Define explicit asset selections in Markdown lane playbooks](https://github.com/michaelahoff/content-kanban/issues/45#issuecomment-6069956886): canonical on-disk selection, editing and preview.
- [Define asset capture and recovery for pending and failed lane runs](https://github.com/michaelahoff/content-kanban/issues/46#issuecomment-6069958003): current inputs while pending, frozen queued submissions, immutable Retry and deliberate whole-playbook reruns.

Keep [state tables with submissions as the durable queue](../adr/0001-state-tables-with-submission-queue.md), [opt-in inherited Codex configuration](../adr/0002-opt-in-inherited-codex-setup.md), and [on-disk playbooks behind one module](../adr/0003-lane-playbooks-on-disk.md). Operational files remain externally editable. Inherited configuration and Full native access are distinct; neither bypasses the original-preservation gate. Preserve the surviving manual prompt/card-context contract from [Define submitted prompt and card context semantics](https://github.com/michaelahoff/content-kanban/issues/5#issuecomment-6024191308): saved selected fields/images, labeled exact versions and duplicate-request handling. Later playbook decisions replace its graph-specific clauses.

## 2. Destination and exclusions

A user uploads a YouTube script, writes/pastes a Markdown guide, organizes thumbnail references in folders, and explicitly selects any of them for a card's manual prompt or lane playbook. Frameboard retains the exact originals, versions, submitted inputs and saved results; it reports unsupported delivery honestly and exports/restores the complete stored workspace.

Initial scope excludes automatic library inclusion, project defaults, live external-file/document links, agent editing of authoritative sources, permanent project deletion/history purging, a new lane automation engine, dedicated Frameboard extraction/transcription/rendering/conversion pipelines, an additional user-set context budget, scheduled/cloud backups and guaranteed exact native session resumption. Native tools may perform requested conversions on independent references when available; that is capability-dependent agent work.

## 3. Asset identity and library lifecycle

- A project asset is an uploaded file or explicitly saved Frameboard-authored document. It has a stable identity, exactly one owning project, one filename, one location at library root or in a nested asset folder, and a current retained asset version. Filenames are primary labels; there is no separate display-name/description model initially.
- Folder and asset rename/move preserve identities. Enforce folder-local name conflicts; do not combine existing identities. Different folders may contain the same filename. Labels are metadata, never trusted authoritative filesystem paths.
- Upload collisions offer **Create new**, **Replace**, **Cancel**; Create new is the default and picks an available numeric suffix before the extension. Replace creates a new version of the existing asset. Matching bytes or names never implicitly merge identities. A removed identity is never revived by uploading to its former name.
- Explicit document Save publishes a version. Editor drafts do not overwrite retained content and are excluded from selections. Failed replacement/save leaves the previous current version intact. Asset restoration creates a new current version from older retained content, preserving intervening versions.
- Cross-project copy creates an independent asset with only the current content and its own identity/lifetime. It does not copy the entire source version history. Source removal/archive cannot invalidate it.
- Asset removal hides it from future selection and retains all versions and historical uses. Folder removal applies the same rule recursively. Already queued references stay valid; explicitly remembered removed selections block new work until corrected. Existing selected empty folders are valid and add zero files.
- Project archive removes a retained project from active use and cancels/revokes its work. It preserves assets, saved outputs, card chats, workspaces and history. Unarchive restores access without resurrecting old work.

## 4. Shared selection and submission boundary

Manual prompts, lane runs and same-card saved-output reuse use one resolution, preflight, capture and dispatch contract. Selection determines what Frameboard supplies; it does not erase earlier conversation inputs or guarantee configured native tools cannot access other files.

### Reusable sources and exact capture

Manual choices remember ordered asset/folder IDs in the same card chat across ordinary messages. A new Send resolves current retained versions and live folder membership. Fresh context, including a primary-provider change, clears manual library selections. A temporary provider/model override preserves them but checks its own capabilities. Playbook choices remain independent of manual choices and fresh-context clearing.

Selected folders expand recursively, each in relative-path order. Preserve mixed source order; deduplicate overlaps by asset identity, with first occurrence fixing position and every selection source retained as provenance. Independently owned assets remain separate even when hashes or names match.

The final input union also includes existing submitted card text/images and explicitly reused saved outputs. Section 12 defines its approved cross-category ordering and exact-identity deduplication. Empty library selection adds no library assets; it never suppresses existing manual card context or lane operational documents/gallery images.

Queueing captures one coherent immutable record:

- Prompt; submitted card field values/versions; exact gallery/chat image versions and role labels.
- Ordered selected source IDs, recursive expanded membership, asset/version IDs, hashes/sizes, captured filenames/folder paths and selection provenance; exact retained reused outputs.
- Operational playbook/map/skill/notes text and hashes for lane work.
- Effective provider/model, harness configuration, conversation relationship and frozen card-edit authority.
- Intended input representations and reference labels, followed by actual delivery outcomes for each attempt. Tool availability is distinct from proof that a model read every byte.

The queue-time snapshot is authoritative, not browser preview or the current library. Subsequent rename, move, replace, remove, folder changes or definition edits cannot rewrite it. Retry is a new attempt of that same submission and target. Corrected inputs/target require new Send or Run playbook. Suppress accidental repeated requests without collapsing distinct deliberate new executions.

### Reference material and failure behavior

Label selected originals with captured filenames/paths and versions; keep their contents separate from prompt instructions. Selection alone does not grant instructional authority. A prompt/playbook may explicitly instruct following a selected reference document.

Preflight the entire union, including operational text, card context, automatic gallery images, library expansion and reused outputs. Check existence, ownership, retained-byte integrity, target capability and known aggregate representation/request/model limits. Block known oversized requests; warn when reliable estimation is unavailable and permit the native attempt. No unrequested truncation, summarizing, splitting, target switching or dropping inputs.

An unresolved source before queueing blocks manual Send or fails the pending lane request with its offending identity visible. A lane request failed before queueing has no invented submission/version to Retry. A route or integrity failure after queueing stops that delivery attempt and preserves the submission. Report every affected input and corrective options: change the saved selection/new target, supply a supported representation, or exact-byte repair. Runtime failures preserve partial/uncertain outcomes and request cancellation where possible; no exactly-once native-execution promise.

## 5. Native delivery and release gates

The native research was performed on Codex 0.160.1 and Claude Code 2.1.291 using credential-free deterministic peers, not authenticated comprehension tests. Implementations must check installed provider/model capabilities and limits rather than treating those findings as permanent universal support. Preserve original bytes independently of native image resizing/encoding.

- **Text and authored Markdown:** use full labeled saved text via the existing native text route when encoding and target limits permit. Tool-enabled Codex may instead use verified independent workspace copies when needed. Unreadable text has no implicit lossy-decoding fallback; treat its original as a general file requiring a usable tool route or another explicit representation.
- **Supported raster images:** use the adapter's native image route and retain image-version/provenance labels. Claude currently accepts PNG/JPEG/GIF/WebP; storage can retain formats outside that subset. An automatic unsupported gallery image stops the whole lane input union even if every library selection is usable.
- **PDFs:** Codex has no generic file/document RPC input; use capable enabled tools on an independent copy. Claude inline PDF forwarding has local native-harness evidence, but Frameboard needs explicit translation, native limit/error handling and a subscribed-account acceptance/comprehension gate. Keep that route unavailable until the gate passes; a bare path is insufficient.
- **Archives, fonts, video, audio, rich documents and opaque bytes:** store them with no type allowlist. Codex may receive tool-readable originals when the enabled environment can use them; availability does not assert universal extraction/rendering/hearing/format comprehension. Tool-disabled Claude has no generic local-file route, archive extraction or filesystem binary creation route. Mark unsupported input visibly and stop the full submission. Do not silently send only a filename.
- **Audio/video modalities:** Codex audio schema acceptance is not usable-audio proof; the researched catalog was text/image only and the tested WAV was omitted by the harness. Neither reviewed input boundary establishes native video input. Enable future modality routes only with evidence for the actual installed model/transport; otherwise use genuinely capable tools or a user-supplied supported derivative.

No direct paid API/Files API, new transcription service, tools-enabled Claude redesign or automatically installed converter is implied. Native registration/adoption/promotion remain separate from delivery and generation.

## 6. Markdown playbooks and lane-run lifecycle

### Canonical selection and editing

The playbook's Markdown settings own the ordered mixed list `assets: [asset:<id>, folder:<id>]`; block-list syntax is equivalent. Omission/empty means no library references. Tokens identify sources, not versions or permanent folder expansions. Validate syntax, kind, existence/removal and project ownership. Any SQLite selection index is derived. Keep file access behind `playbooks.js` and preserve `lane:` identity.

The picker and raw Markdown are two views of the same editor draft. Save commits instructions/settings/selections together with the loaded whole-file hash. Patch selection text narrowly, preserving unrelated body, comments, settings and formatting. An unsafe/invalid draft stays intact with an error. On external edit conflict preserve the draft and show the newer saved file; require explicit reload/revert or deliberate replacement using the newer hash. The hash check is not an OS-level compare-and-swap against uncontrolled external writers.

Allow saving visibly unresolved sources, preserving their IDs; execution remains blocked. Copying a playbook file retains its references, not copied assets/new IDs. Destination-project validation exposes foreign IDs and requires explicit destination selection; never rebind by similar paths.

Keep MAP.md, playbook instructions, named operational skills and notes distinct from library references. Preserve current `skills:` and recognized `skills/<name>.md` inclusion. Operational lookup never falls through to the library. A filename/path/ID mentioned in prose does not select a library asset.

### Pending, queued, retry and new execution

- Creating a card applies lane-entry `set:` without agent work. An on-enter move or deliberate Run playbook requests work. One lane run queues at most one submission; there is no graph-node engine.
- Pending is a request, not a frozen snapshot. Use current saved instructions/settings/selections, map, skills, notes, card/gallery context and effective target when ready to queue, including after fresh-context waiting. Off/manual cancels a waiting automatic request. Editing does not revive failed/cancelled requests.
- Prepare bytes and operational snapshots outside the database transaction. Revalidate document hashes, asset/folder revisions/membership, card versions, settings/configuration and cancellation authority after asynchronous preparation. A concurrent change causes repreparation or an inspectable conflict, never a stale/mixed snapshot. Insert the one coherent submission transactionally; dispatch only after commit.
- Retry uses the frozen submission/target and eligibility checks. It never rereads current files or reapplies lane-entry `set:`. Missing frozen bytes require exact-byte repair.
- Run playbook after failure creates a new whole-playbook execution with current saved inputs/target. It preserves prior failures, field effects, notes, outputs and history; it does not replay lane-entry values or promise only unfinished prose will execute. A later actual lane entry retains normal entry effects.
- Prequeue source failures have no Retry; fix selections and Run playbook. Recovered completed replies stay inspectable without replaying their result block or creating proposals/notes. Reconcile uncertain delivery before authorizing another attempt; explain possible repetition for deliberate new work.
- Preserve existing pending-request reuse and one-submission-per-run uniqueness. A distinct deliberate Run playbook after queueing creates new work. Attempt identity prevents old/stopped callbacks from changing a newer attempt.

### Departure and stronger revocation

Lane departure cancels pending/undelivered queued work; running work may finish with proposed fields and permitted notes under current rules. Returning does not restore old automatic field authority. Stop, card restoration and project archive revoke remaining authority more strongly: no late notes, card changes/proposals, new output registration, Retry resurrection or automatic result application. Preexisting saved results remain inspectable. Archive followed by unarchive never revalidates an old callback.

## 7. Saved outputs, reuse, adoption and promotion

A saved output is an explicit retained snapshot owned by the originating card chat, conversation, submission and delivery attempt. Ordinary workspace files remain mutable. Retain finished files through explicit agent registration or user Save output, and selected transcript text through **Save as document**. Preserve existing native image capture; rendered images use explicit registration and retain their actual creation method.

Section 12 defines the approved lane-compatible registration extension. Merely mentioning a path, finding a new file, or returning a filename is never registration. Do not scan/discover/adopt every changed workspace file. Tool-disabled Claude can produce/save explicit text, but cannot claim it wrote a local binary or created a general filesystem result.

Copy verified exact bytes/text into retained storage at save time. Later workspace edits do not modify the snapshot. A revision is a new saved output with a predecessor link. Record actual producing provider/attempt, creation method and known turn/tool/native identifiers. Link exact supplied versions and labels separately from specifically declared derivation sources; unknown metadata remains unknown. Do not infer derivation from similar names/bytes or assume every supplied asset was used.

Allow explicit reuse of exact retained outputs within the same card chat, including previous conversations, with common capture/capability rules. Cross-card reuse goes through user **Save to project library**. Lane reusable sources remain asset/folder IDs; promote an output before selecting it in another card's reusable playbook configuration.

Keep saving, text application, **Add to gallery**, image-role selection and library promotion separate. Text follows existing authority/field-draft conflict checks. Images require user adoption; choosing Original/Inspiration/Display is separate. Agents may suggest promotion but cannot publish or replace library originals. User promotion selects filename/folder and uses Create new / Replace / Cancel, default Create new. Replacement creates a new asset version. The promoted asset and saved output have independent lifecycles with a provenance link.

Outputs survive Stop once saved, fresh context, card restoration/deletion, source/library/gallery removal and project archive. Archived history stays readable/downloadable; new work/adoption/promotion waits for unarchive. Retain late reply/native-result history honestly, while stronger revocation prevents new registrations/effects from the old attempt.

Generation, saving and promotion have separate outcomes. Save/promotion failure never claims retention/publication succeeded. An explicit retry imports the same result only if exact bytes remain available; it never silently rereads changed content at the same path, regenerates or reruns. Registration retries need stable operation identities so one successful import is not duplicated.

## 8. Data, module and API boundaries

These are required responsibilities; exact table/route spelling is an implementation detail. Keep domain identities and streams at boundaries, and avoid public writable paths into retained stores.

### Durable records

Use SQLite state tables for project archive/revocation state; stable folders/assets with removal/location metadata; immutable asset-version identity/hash/size/state; manual ordered selections; frozen submitted asset context; output snapshots/provenance/operation outcomes; and attempt/cancellation/recovery state. Preserve existing submission, lane-run, image, card-history and activity stores. Playbook Markdown remains selection authority; any cache is derived.

Retain all committed versions, including removed/superseded ones irrespective of reference count. Output/image stores remain in the backup inventory. Store authoritative original/output bytes outside mutable card workspaces; names are metadata, and verified reads return streams. Submitted labels/versions never depend on a live path.

### Module responsibilities

- **Asset storage:** one new storage module owns streamed stage/import/document save, durable version publication, verified reads/downloads, exact-byte repair, independent materialization, retained inventory and abandoned-staging recovery. Metadata publication uses trusted store transactions. Callers cannot write directly to authority paths.
- **Selection/submission:** a shared resolver/preflight/capture seam extends `store-chat.js`, `chat-service.js` and `chat-worker.js`. It serves preview and authoritative queueing, including gallery/asset/output union provenance, representation planning, revalidation and immutable attempts.
- **Playbooks:** `playbooks.js`, `public/playbook-format.js` and `public/playbook-editor.js` own explicit setting support, narrow draft edits and hash-checked saves. `lane-runner.js` uses the same selection/capture boundary rather than a second delivery implementation.
- **Outputs:** extend the existing image/output seams in `chat-service.js`, image storage and result processing with general snapshot registration, exact-result retries, user text saves and user-only promotion. Validate origin, path ownership, bytes and live attempt authority.
- **Lifecycle:** `store.js`/`store-chat.js` and workers own durable project/attempt revocation and all effect checks, including lane notes/result/proposal paths. Native work stays outside SQLite transactions.
- **Backup:** `backup.js`, `scripts/backup.mjs` and startup coordinate maintenance, complete inventory, streaming export/verification, restore activation and worker holds. Preserve existing image storage; no wholesale image migration is a prerequisite.
- **UI/API:** `server.js` and the current board/card slide-over expose project library CRUD/import/version/history/download/repair/copy, manual selection/preview, output save/reuse/promotion and archive/restore. Retain existing playbook preview/save/Run playbook and submission Retry actions. API errors include source identity, phase and reason rather than pretending a failed source resolved empty.

Library APIs validate project ownership, stable IDs, version intent and explicit collision choices. Stream general uploads rather than using current image/JSON buffering/type gates. Mutations must reject archived/maintenance/revoked state. Manual Send accepts ordered typed source IDs and exact output IDs with existing card selections/request identity; server resolution supplies bytes and labels. Browser-provided paths/hashes never authorize a write/read or select a replacement for missing historical content.

Extend existing API seams: `PUT /api/cards/:cardId/chat/composer`, `POST .../chat/preview`, `POST .../chat/submissions`, `POST .../chat/retry` and `POST .../chat/fresh`; `GET/PUT/DELETE /api/flows/:flowId/playbooks`; `GET/POST /api/cards/:cardId/lane-runs` and `GET .../lane-runs/preview`. Library/output/archive APIs are new. Main currently exposes irreversible-delete copy over retained soft deletion, not archive/unarchive; implement recoverable archive explicitly rather than relabel that UI. Preserve legacy retained data in migrations and complete backup. The existing image provenance helper hardcodes Codex; generalize it to the actual producing provider before provider-independent registration.

## 9. Storage, integrity and enforceable preservation

No initial per-file size quota, project quota or asset type allowlist. Stream upload/hash/copy/export/restore with backpressure and bounded memory; provider request limits and gallery limits are separate. Report disk exhaustion/disconnect/write failures without truncation or success claims.

Per-file publication is atomic: private staging, streamed SHA-256/size, complete durable byte publication, then metadata/current-version commit. Select only committed versions. Batch successes persist with per-file errors/retry; failed replacement preserves the prior current version and retries do not duplicate successful siblings. Recovery distinguishes incomplete staging, published uncommitted orphans and committed unavailable versions. Cleanup only removes proven abandoned staging/temporary reproducible content; never garbage-collect committed originals/history/outputs merely because a source was removed.

Verify required originals before download/materialization/delivery. Missing or corrupt content marks that exact version unavailable; other work stays usable. Asset repair requires matching recorded hash and size from a verified backup/re-upload and preserves identity. Wrong bytes require a new version; restoration of older content also creates a new version.

Use independent copies, never hardlinks/symlinks to authority stores. Verify/rebuild tampered references from the frozen version before another delivery. Workspace edits/deletion cannot alter originals. Labels/path metadata and reference availability do not imply actual byte consumption.

Enforce prevention of authoritative asset/output/history/database/authority writes for every supported agent execution mode and escalation path. Prompt instructions, concealed paths, same-owner read-only bits and after-the-fact hashes are insufficient. Keep operational playbooks externally editable and card notes/workspaces mutable through their legitimate paths; frozen snapshots remain protected.

Hold modes/grants whose boundary is unproven, including Full native access and inherited hooks/tools/connectors with local write capability, even for turns without selected assets. Preserve opt-in inherited configuration as a distinct setting. The isolation mechanism is an implementation choice, but demonstrating a protected supported configuration is a release prerequisite; a feature that holds every usable configuration is not complete. Protection concerns supported agent actions, not an administrator modifying the host.

Archive transactionally marks the project archived, cancels pending lane requests/queued work, revokes pending permissions and attempt authority, and records ongoing cancellation intent. Request native Stop after commit. Recheck durable project/attempt generation or an equivalent persistent fence at dispatch, retry, notes appends, registration, card/result/proposal application and recovery. Unarchive/restart cannot revalidate old work. Retain actual late outcomes in history without authorizing effects.

## 10. Complete manual export and whole-workspace restore

Export every retained app store: consistent SQLite and settings; active/archived project folders/assets/all versions; authored documents; frozen submissions/labels/operational snapshots; selections; card state/history/chat/activity/cancellations; images and all saved-output payloads/provenance; card workspaces/references/notes; and `flows/MAP.md`, lane Markdown, shared skills and lane-run rows. Persisted drafts/settings count as app data; unsaved editor text is not a saved asset version. Include already collected bound native supporting files; global credentials/configuration, unrelated native conversations and external service data remain outside coverage. No required retained content may survive only as an unexported native-path pointer.

Maintenance stops new dispatch, submissions, imports, edits, saves and mutations; ongoing work finishes or is explicitly cancelled and fenced. Quiesce external writers to operational/workspace files too. If a writer cannot be stopped/excluded, do not certify consistency. Maintenance does not itself archive projects or silently cancel unrelated queued work. Cancelled work stays cancelled when maintenance ends.

Stage a self-contained export with a versioned manifest of schema/format, safe relative paths, identities/relationships, sizes and hashes. Inventory required database references as well as found files. Stream-verify copied content, database integrity and complete payload coverage before atomic publication. Missing/corrupt payloads, disk-full/interruption/cancellation fail visibly with actionable details; publish no degraded bundle, retain the last good backup and reclaim failed staging safely.

Restore the whole workspace into a new/empty destination under exclusive ownership. Validate format/schema, safe paths, traversal/link escapes, streamed hash/size verification, database integrity and required coverage in private staging before activation. No merge into/live overwrite or partial activation on failure. Preserve all identities, ownership, labels, provenance, selections and archive/cancellation state.

Before any startup worker wakes, establish a recovery hold on both unfinished submissions and pending lane runs, invalidate historical approvals and old-runtime effect authority, and reconcile retained outcomes without applying result blocks. Archived/cancelled work stays cancelled. Noncancelled unfinished work remains inspectable for explicit review; execution requires provider reconnection and new explicit work, not automatic resume. Restore verified reference copies from their captured originals when necessary. Do not promise exact native conversation resumption.

## 11. UI flows and acceptance evidence

Use the approved [Library-tab prototype](https://github.com/michaelahoff/content-kanban/blob/16905ca/public/asset-library-prototype.html) as disposable interaction evidence, not production code. Integrate the project Library tab/folder navigation/filename thumbnails with the current slide-over card and playbook editor. Keep copy concise, selections compact and details under **What will be sent**. Support upload/folder drop, Write/paste, nested folder creation, search, menus, preview/download, explicit saves, version history/restore, collision choices, move/rename/remove and independent project copy.

Preview shows live manual inputs or current saved playbook inputs, separately identifying an unsaved playbook/document draft. Show current/captured versions as appropriate, recursive membership, all provenance, native delivery methods and actionable errors. Queue history instead shows exact frozen inputs and actual attempts/outcomes. No routine additional confirmation step. Saved outputs appear beside their producing work with download, same-card selection, text save, separate adoption and user promotion actions. Prequeue failures stay inspectable even without a submission.

Required acceptance cases (feature tests to implement; none are claimed passing here):

1. Upload a YouTube script and Save a pasted Markdown guide; each gets a stable identity/version. Draft edits are excluded until explicit Save. A failed save leaves the prior version current.
2. Same-folder `logo.png` collision offers all three choices with Create new default and extension-preserving suffix. Different-folder duplicates coexist; rename/move never merges identities; equal bytes never merge separate assets.
3. Select/drag `Thumbnails/` recursively plus overlapping `logo.png`; deliver one per asset identity, retaining all selection paths and deterministic order. Existing empty folder adds zero; removed explicit folder blocks new work, even after name reuse.
4. Queue script A; replace/move/remove its source, add folder contents and restart. Queued work and Retry retain A/old labels/membership/target. New Send captures current sources; removed explicit sources remain unresolved.
5. Restore older asset content as a new current version; preserve intervening versions. Independent cross-project current-content copy survives source archive/removal.
6. Ordinary messages keep manual selections; fresh context clears them; temporary override preserves them and rechecks target capabilities; playbook selections stay independent.
7. Markdown `assets:` accepts inline/block mixed ordered IDs. Invalid/wrong-kind/foreign/removed IDs remain visible and block execution; saved unresolved selections are allowed. Playbook copy never rebinds by filename.
8. Picker edits preserve unrelated Markdown body/settings/comments/formatting. Instruction and selection edits save together; external file hash conflict retains draft. Saved preview excludes draft-only edits and shows them as unsaved.
9. Mention an unselected library filename/ID in prose: no inclusion. Named operational skill inclusion remains intact. Same-named skill/library document stay distinct. Empty library selection leaves all lane gallery images and operational documents included.
10. While fresh context is pending, edit selections/playbook/map/skills/notes/card/target; eventual queue captures current saved inputs. Off/manual cancels an automatic request. Changes during asynchronous preparation force revalidation; cancellation prevents insertion; repeat preparation queues at most once.
11. Removed explicit source before lane queue fails with identity and no submission. Correct it and Run playbook to create new work. Prior entry fields survive and are not reapplied; creation itself starts no agent.
12. After failure, edit instructions/input/target. Retry keeps the original whole submission; Run playbook captures current inputs and reruns the whole prompt. Prior notes/effects/output/history survive; no failed-node continuation claim.
13. Leave while pending/queued: cancel undelivered lane work. Leave while running: preserve allowed proposals/notes. Return: old automatic authority stays revoked. Stop/card restoration/archive prevent stronger late effects and output registration.
14. Replay the same request/preparation and old attempt callbacks: no duplicate submission or corruption of a newer attempt. A distinct deliberate postqueue Run playbook remains new work. Recovered completed replies do not replay results or qualify as failed Retry.
15. Both providers receive full supported text/raster references with exact provenance. Unsupported automatic Claude gallery image plus usable library text fails the entire union. Unsupported/missing/known oversized input never causes silent subset delivery; uncertain size gives a warning/native outcome.
16. Codex tool-readable arbitrary files use independent exact copies. Tool-disabled Claude receives actual inline contents for supported inputs, not bare-path claims. PDF/audio/new modalities require their real native gate; no paid or automatic converter fallback.
17. Explicitly save finished files/document text/images; scratch files/chat paths are not auto-discovered. Retained snapshot survives workspace changes, Stop, fresh context, card deletion/restoration, source removal and archive. Lane registration paths obey section 12 and authority checks.
18. Reuse saved output on the same card without adoption/promotion. Cross-card reuse requires user promotion; promotion does not auto-select/adopt. Separate image adoption/roles; separate Create new/Replace version choices; independent output/asset bytes.
19. Provenance separates supplied context from declared derivation and preserves unknowns. Late/revoked registration cannot publish a new saved output; recovered text remains available for a new explicit user save. Save/promotion failures never claim success, retry substitutes no changed path bytes and repeated registration does not duplicate a successful result.
20. Stream a multi-GiB video/archive plus unusual opaque bytes and authored document through import/materialization/export/restore with bounded memory and matching original hashes. Asset storage never inherits gallery type/20 MiB restrictions.
21. Disconnect/disk-full/crash before and after byte publication/metadata commit: only complete committed versions become selectable; failed replacement preserves current content; batch successes persist with per-file errors and safe retry; cleanup preserves committed unavailable content.
22. Tamper/delete originals or workspace copies: stop only uses requiring the unavailable retained version; rebuild copies from frozen originals. Wrong-byte repair fails; matching hash/size repairs the same version identity. Historical uses never silently switch to current content.
23. Attempt authoritative asset/output/database/frozen-history writes via ordinary native turns, escalation, inherited hooks/tools/connectors and supported Full-access modes, including link/path escapes. Prove prevention for every enabled mode and hold unproven combinations before any execution. Legitimate external playbook edits and mutable notes remain usable.
24. Archive queued/running/preparing work; restart/unarchive before late events. Persisted revocation prevents dispatch, notes/proposals/card effects, new registrations and Retry resurrection while retaining history. Repeat around backup restore and old-runtime callbacks.
25. Export active and archived projects including all removed/superseded originals, every saved-output store, workspaces/notes, settings, playbooks/skills/map, lane rows and frozen snapshots. Restore an empty destination and compare complete identity/hash/relationship inventory; no execution or result replay on startup.
26. External writers/mutations/dispatch/late callbacks during maintenance; interruption/disk-full/corruption/path escape/unsupported format during export/restore: fail safely without publishing an incomplete bundle, activating partial state or damaging last good backup/workspace. Historical approvals confer no restored authority.

The audit's 47 passing baseline checks establish existing main behavior only. New protection, asset, output, archive, streaming and restore evidence is required separately, including live native gates where local deterministic peers cannot prove usability.

## 12. Approved synthesis refinements

The user approved both refinements in the live review on 2026-10-08: “Use this order (recommended)” for input ordering and “Use this contract (recommended)” for lane output registration. These extend the earlier resolutions with the concrete integration contracts below. Final confirmation of the complete specification and delivery sequence remains outstanding.

### A. Order and identity across the full input union

Preserve existing card-image order first: manual role choices followed by explicit image choices; lane runs use gallery order with role labels. Then append explicit library references in mixed selection/relative-path expansion order, then explicitly reused general saved outputs in selection order. Existing exact chat image selections stay in the existing image group.

Deduplicate only the same typed retained source/version identity. If a gallery image and saved image output name the same retained image version, supply it once at first position with every role/source label. Library duplicates use asset identity; separate library assets or independently promoted/copied assets remain separate even if they originated from that image/output or share bytes. A repeated exact saved output is supplied once with all provenance. Do not deduplicate by hash or silently reinterpret promotion as aliasing.

### B. Provider-independent explicit lane output registration

Extend the existing lane result block with optional explicit `outputs`, alongside existing fields/notes/move. Entries either declare an inline document (filename, exact text, declared source IDs) or a finished workspace file (workspace-relative path, filename, declared source IDs). The trusted application binds origin to the live submission/attempt, validates the descriptor and source IDs, snapshots exact available bytes through retained storage and reports each save separately. Retried imports refer to the original registration operation/verified bytes, never a later occupant of that path.

File descriptors are usable only when that provider actually has filesystem capability and the file exists in the authorized card workspace. Reject absolute paths, traversal, symlink escapes and authoritative-store targets. Tool-disabled Claude may register an inline document; it cannot create/save a claimed local file merely by returning its path. User Save output and Save as document remain explicit alternative routes; native image capture remains its existing path. No automatic discovery or library promotion follows.

Apply live attempt/revocation checks before registration and byte publication. A lane departure may preserve an otherwise live running attempt's registration; Stop/card restoration/archive/recovery cannot regain it. Validate registration entries without weakening existing field/notes/move checks. A file-save failure is separate from agent completion and any separately valid card effect. Surface missing/unusable paths honestly and retain reply text rather than claim the output was saved.

This is an additive explicit result-protocol extension, preserving ADR 0003's single reporting path. The planning glossary now records output registration as part of the lane result; implementation must update the result protocol and guidance. No new filesystem tools for Claude or agent-managed library permissions are implied.

## 13. Smallest coherent delivery sequence

These are implementation stages for the subsequent effort, not child decision tickets to execute in this map. Each stage keeps the application runnable; do not expose queued asset delivery before its protections/recovery gates pass.

1. **Retained storage and protection foundation.** Add metadata/state migrations, private streamed asset/output publication/inventory/repair primitives, independent copies and provenance. Prove the boundary for at least one usable execution configuration and hold all unproven modes/escalations. Preserve existing images and externally editable operational files. Evidence: acceptance 20–23 plus atomic failure/ownership checks.
2. **Archive, complete export and restore fences.** Add durable revocation/effect checks for current manual/lane paths and new stores, maintenance with external-writer handling, complete streamed export/verified empty-destination restore, and startup holds before workers wake. Do this before user data is advertised as completely backed up or new work can escape cancellation. Evidence: 13–14 and 24–26 across every store.
3. **Library and shared manual submission.** Build the approved Library tab, import/write/paste/folder/version/collision/copy/removal flows; add the shared resolver/preflight/capture, preview/history and manual selections. Deliver text/images and genuinely usable tool references; keep unproven routes disabled. Evidence: 1–6, 15–16, 20–23. This is the first complete user workflow: upload script → select → Send → inspect frozen context.
4. **Playbook selection and capture.** Extend Markdown settings, narrow picker edits/hash conflicts, saved preview and pending-to-queued coherent capture through the same submission seam. Preserve all-gallery inclusion and current Retry/Run playbook semantics. Evidence: 7–16, 24–26. No graph continuation implementation.
5. **Explicit saved results and reuse.** Implement the confirmed lane registration extension, user text/file saves, retained output browsing/download/retry, same-card selection and user-only promotion with provenance. Include every store in backup before exposing saves. Evidence: 17–19, 23–26; retain native image adoption semantics.
6. **Native gates and integrated release evidence.** Run installed-harness and required subscribed-account format checks, bounded-memory large-file/failure trials, archive/restart/restore races and full workflow checks. Enable Claude PDF only on passing evidence; unsupported routes remain explicit. Update user-facing capability descriptions and current-main integration evidence. All applicable acceptance cases must pass; baseline/fake-provider tests alone cannot certify this feature.

Both synthesis refinements are approved and the specification has a durable planning-branch pointer. Completion of this planning ticket still requires the user's final confirmation of the complete specification, delivery sequence and that no in-scope decisions remain. Production implementation has not started.
