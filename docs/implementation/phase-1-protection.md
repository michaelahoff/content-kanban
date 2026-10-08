# Phase 1.4 protected card tools and native requests

Implementation ticket: [#22](https://github.com/michaelahoff/content-kanban/issues/22). Acceptance authority: [completed product specification](https://github.com/michaelahoff/content-kanban/issues/12#issuecomment-6041712115), [card acceptance](https://github.com/michaelahoff/content-kanban/issues/7#issuecomment-6024596534), and [durable boundaries](https://github.com/michaelahoff/content-kanban/issues/11#issuecomment-6041085002).

## Card authority and drafts

All five card tools are frozen into the effective Codex configuration. Routing selects the originating native turn and delivery attempt; callers cannot supply a card or attempt identity. Mutations recheck the attempt inside the board transaction. Tool-call receipts suppress duplicate effects and retain provenance. `read_card` returns current values, field/placement versions, and the project's lanes.

The composer explicitly records which requested text fields may be edited directly. The submitted prompt includes that authority and labeled field versions. `edit_fields` applies only authorized fields with matching versions and no dirty lease. Conflicted fields and suggestions become durable proposals. `propose_changes` always proposes; `propose_move` requires explicit acceptance. Native permissions never grant card-field, gallery, image-role, or lane authority.

The browser sends changed fields with their base versions. Matching fields save while conflicting drafts retain their original values and versions. Saves also preserve drafts begun while a request is in flight: an unsubmitted field cannot acknowledge a newer, unseen saved version. Gallery membership and role dependencies are validated after conflict partitioning. Agent and other-tab changes refresh only fields without local drafts.

Each tab holds sequenced, in-memory draft leases, renewed every 1.5 seconds and expiring after five seconds. Release by one tab does not release another tab's lease. Structured acceptance previews show current and proposed values, allow selection by field, and recheck the reviewed versions and dirty leases atomically. A stale proposal needs a new preview. Selected reply text supports Replace/Append with an exact result preview and source/destination rechecks, including retained interrupted replies. Move acceptance rechecks placement and card-field versions; move undo also uses placement and affected field versions.

`register_image` validates a bounded regular image inside the originating workspace, checks magic bytes, copies it into the retained image store, and records its hash, provider, rendering method, source path, and originating tool call. Registration does not add gallery membership or assign a role. Native image generation, complete image-version relationships, adoption, and import/serve integrity remain the separate #23 milestone.

## Native requests and grants

Command/file approvals, additional-permission requests, and user questions remain durable and card scoped. Allow once and Deny produce individual native responses. Exact-operation conversation allowances compare the command, working directory, action kind, environment, network context, and additional permissions; file allowances require actual changes from the native item. A permissions allowance matches its exact requested profile. Unsupported operation scopes cannot silently become scoped grants.

Frameboard stores its own conversation grants. Responses never use native `acceptForSession`, execpolicy amendments, persistent network rules, or session-scoped permission profiles. Full native access approves remaining requests individually and applies Codex `dangerFullAccess` / `never` starting with the next response. Ordinary turns explicitly select `workspaceWrite` / `on-request` with no network. Warm resume retains previously overridden permissions, so the adapter restores ordinary settings with the thread-scoped settings API and verifies the result before another dispatch. Full is reapplied only when the current Frameboard conversation still has that grant. Active Full revocation requires acknowledged interruption; fresh context starts with empty grants.

The UI discloses workspace writes and sandboxed commands that run automatically, possible outside reads, and Full's reach into anything the user's account can access. Card acceptance remains separate. There is no OS isolation claim. Configuration changes cannot expand grants or rewrite frozen submissions.

Stop, deletion, and fresh-context cancellation invalidate pending requests and fence late card-tool mutations. Partial text and completed registered artifacts remain readable. Native invalidation and proposal rejection advance the activity feed; direct agent edits and tool/proposal events carry automation attribution, while acceptance carries user attribution.

## Verification

Tests use public HTTP endpoints, existing browser/client boundaries, and the controlled Codex adapter, confirmed before adding tests. Coverage includes mixed conflicts, multi-tab leases and expiry, stale proposal/text previews, gallery-role conflicts, edits during in-flight saves, exact grants across restart, permission expansion rejection, native invalidation, Full versus ordinary turns, registration boundaries, partial retention, and late mutation fencing. Existing save, Set graph, gallery/role, and move-undo regressions remain covered.

The installed-native checks use Codex 0.160.1 and a temporary native home with the credential-free loopback Responses fixture. The new Full-to-ordinary gate executes a command outside the card workspace under Full, then proves that the ordinary follow-up cannot write there. It exercises real app-server permissions without account credentials or subscription-backed inference. Separate account/model/image release evidence remains required by the parent phase.

No typechecker is configured in this dependency-free JavaScript repository. Changed JavaScript passes syntax checks, and the staged diff passes whitespace checks. Final suite counts are recorded below.

Final checks on 2026-10-07: `npm test` — 87 passed, 7 opt-in native checks skipped, 0 failures; `npm run test:native` — all 7 passed; `npm run test:browser` — all checks passed. Collaborative browser smoke checks independently exercised exact-operation approval, automatic approval of the repeated operation, proposal preview/acceptance and editor refresh, and answering a retained native question.

## Standards

The independent review identified two documented violations: missing rejection/invalidation activity events and inconsistent actor attribution for autonomous edits. Both were fixed and the re-review found no consequential documented breaches. One nonblocking duplicated-field-assignment judgment remains; its distinct conflict paths were kept within their existing module.

## Spec

The independent review identified three requirements implemented incorrectly: unseen versions acknowledged during a save, stale gallery relationships blocking matching text, and Full without the specified native mode. Each received a regression and a fix. Re-review found no unresolved objections or scope creep and independently reran the native sandbox transition gate.

Remaining findings: Standards 1 nonblocking duplication judgment; Spec 0. No unresolved hard standards violation or incorrect requirement remains.
