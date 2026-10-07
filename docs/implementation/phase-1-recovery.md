# Phase 1.6: restart reconciliation, browser streaming and activity indicators

Implementation ticket: [#24](https://github.com/michaelahoff/content-kanban/issues/24). Contracts: [assembled specification](https://github.com/michaelahoff/content-kanban/issues/12#issuecomment-6041712115) cases 8–9 and 11–12, [durable boundaries](https://github.com/michaelahoff/content-kanban/issues/11#issuecomment-6041085002) and ADR 0001.

Phase 1 remains unreleased until the cumulative gate in #25.

## Delivery reconciliation

Each attempt is committed as `dispatching` before transport, and its ID is the Codex `clientUserMessageId`. The conversation binding is committed before `turn/start`. Reconciliation reads native history read-only, with `thread/turns/list` full items paged newest first, and matches the attempt's client ID. It never resumes a thread or starts a turn.

Reconciliation has **proof of non-delivery** only when the app-server that could have received `turn/start` has exited: at app startup, or immediately after an observed process exit. In that case:

| Native evidence | Result |
| --- | --- |
| No binding recorded | `not-delivered`; the submission is requeued at the head of its card's queue |
| A complete history without the attempt, and Codex never acknowledged it | `not-delivered`; requeued with the same thread |
| A missing thread whose conversation never had a turn (no rollout is persisted before a first turn) | `not-delivered`; the binding is cleared and the next attempt starts a new thread |
| A matched completed, failed or interrupted turn | Its items and images are imported once; the matching terminal state is recorded |
| A matched turn without a result | `interrupted` (cause `restart`). Frameboard's partial text stays authoritative |
| A missing thread for a conversation with earlier turns | `interrupted`; the conversation becomes native-unavailable |
| An acknowledged attempt absent from history | `interrupted`, with a "Missing from native history" notice |

A requeued attempt is a new delivery attempt linked to the old one; the submission and its frozen inputs are unchanged. A Stop or deletion requested before delivery is honored rather than requeued.

Matched recovery persists the exact native turn ID, including when its acknowledgement was lost. Earlier delivered work therefore cannot be mistaken for an empty conversation if native history subsequently disappears. Stop and cancellation intent survive an uncertain interruption response, process exit and late completed output; retained output never changes that submission to Done.

Without proof (a `turn/start` timeout while Codex is still running), a missing or unfinished match stays **uncertain**. It blocks later work on that card, shows Needs attention, and is never resent. The transcript offers:

- **Check native history** (`POST /api/cards/:id/chat/reconcile`): the same read-only reconciliation.
- **Mark interrupted** (`POST /api/cards/:id/chat/resolve`): the user's explicit decision. It unblocks the queue and permits a deliberate linked **Retry**, which may send the prompt twice.

Pending native requests are invalidated at startup. Uncertainty no longer marks a conversation native-unavailable; only missing native history does.

## Duplicates and late events

- Transcript items are upserted by (attempt, native item ID). A repeated or out-of-order event never replaces a completed item with partial content, and an unchanged item adds no activity entry.
- Image outputs remain unique by (attempt, native item or tool call).
- A repeated native request reuses its row. Once answered or invalidated, it is declined and never pending again.
- Late events keep their transcript output and images. Existing state checks stop them changing cards, completing a later attempt or authorizing stale requests.

## Outside continuation

Before each follow-up `turn/start`, the worker reads native turns newest first, back to the latest turn Frameboard knows. A turn that is neither a recorded turn ID nor carries one of this conversation's attempt client IDs was continued outside Frameboard, for example by a CLI resume. Those turns are recorded on the conversation but never shown or imported. The prompt is held with a notice and Needs attention. The user can choose **Continue in this conversation** (`POST /api/cards/:id/chat/continue`), which acknowledges those turns, or start empty fresh context.

## Provider limits

- **Proven pre-accept transient rejection.** This means the app-server's JSON-RPC `-32001` "Server overloaded; retry later.", or a Codex exit, timeout or busy thread before `turn/start` was written. The attempt becomes `not-delivered` and the submission `waiting`, shown as Working · waiting for provider. It retries automatically with exponential backoff (2 s base, capped at 5 minutes). After six consecutive waits it fails and needs an explicit retry.
- **Rejection after acceptance.** Codex reports provider errors, including `usageLimitExceeded`, `rateLimitExceeded` and `serverOverloaded`, as a failed turn after the user message is in native history. These fail with an explanation (for usage limits, "Usage limit reached. Retry explicitly after it resets." plus Codex's message) and are never retried automatically.
- **Unavailable targets.** An unavailable model fails at dispatch without substitution.

## Browser streaming

`GET /api/stream` sends Server-Sent Events.

- **`activity`.** Each durable activity entry, with its log ID as the event ID. `Last-Event-ID` or `?since=` replays exactly the entries after that cursor.
- **`resync`.** Sent when more than 500 entries were missed, or the cursor is newer than this database. The client then reloads its snapshots.
- **`delta`.** Not durable: `{ cardId, attemptId, itemId, offset, text }`. The client ignores duplicates, appends only the new suffix of an overlap, and reloads the snapshot after a gap.

A chat snapshot first flushes text already streamed, so the next delta's offset continues where the snapshot ends. `GET /api/chat-activity` returns its `cursor`. The browser replaced its 800 ms polling with this stream.

## Indicators

Indicators are derived from durable rows only, so a restart rebuilds them. Priority, highest first:

1. **Input needed:** a pending native request. The entry names the request, and navigation opens the card's chat at that request.
2. **Needs attention:** a held or uncertain submission, native-unavailable context, or a latest settled submission that failed or was interrupted by something other than the user's Stop, a cancellation or the user's resolution.
3. **Working:** an active attempt with its server start time for the timer, or queued or waiting work.
4. **Done:** a completion since the durable last-viewed marker. A user Stop never sets Done.

Viewing a chat from any tab clears Done. The first view after a completion records one `chat_viewed` activity entry, so every other tab's stream updates; repeated views record nothing. The timer ticks every second without re-rendering the board, and the reduced-motion Working indication stays static.

Showing a hidden chat, switching to its Chat tab and crossing the responsive layout breakpoint refresh the viewed marker without polling. Provider timers consider only unblocked queue heads; a waiting submission behind held work does not cause repeated overdue wake-ups. App shutdown stops the worker before closing Codex and waits for native process exit before its close callback.

Schema migration 10 adds attempt `cause`, submission `hold`, `retry_at` and `waits`, and conversation `outside_turns`.

## Evidence on 2026-10-07

Environment: Node.js 22.17.1, Codex CLI 0.160.1, Chromium (Arch Linux).

- **`npm test`: 124 passed, 9 opt-in native checks skipped, 0 failed.** These use controlled native-event and failure injection through the public HTTP API, plus the durable store's queue deadline interface.
  - `test/recovery.test.js` covers:
    - A crash before binding, after binding before `turn/start`, after Codex recorded the turn before acknowledgement, and during streaming.
    - A `turn/start` timeout that stays held through reconciliation without proof, then is resolved and deliberately retried.
    - A Codex exit with and without a recorded turn.
    - Overload backoff, wait exhaustion, exhausted usage with reset text, and an unavailable model.
    - Outside continuation and missing native history.
    - Duplicate and out-of-order items and requests.
    - Indicators rebuilt after restart, in priority order, with Done cleared from another tab exactly once.
    - The Working timer source and Input needed request navigation.
    - Three cards with mixed text, approval and image work, each with one attempt.
    - A Stop before delivery honored after a crash.
    - Stop during a pre-accept rejection, process exit or outside-history lookup; lost interruption responses retain Stop through later completed native output.
    - A recovered first turn with a lost acknowledgement followed by missing history retains its original binding and needs attention.
    - Provider retry deadlines disappear while earlier held work blocks them, and return when it is cancelled.
  - `test/stream.test.js` covers `Last-Event-ID` replay without duplicates followed by live delivery, resync for clients that are too far behind or hold a foreign cursor, and delta offsets with snapshot continuity.
  - The earlier test of a turn cut off by restart now expects `interrupted` with cause `restart`, as the reconciliation table above requires.
- **`npm run test:native`: 9 passed.** The restart gate uses the installed app-server with the credential-free loopback Responses peer. The peer streams partial text and then stalls. The gate SIGKILLs Codex, closes the app and restarts it. Reconciliation then:
  - matched the attempt in real native history;
  - recorded `interrupted` (cause `restart`) and retained the partial text;
  - made no model request and resent nothing.

  A follow-up then resumed the exact binding.

  A separate installed-native HTTP gate runs three distinct card threads: a pending command approval, stalled partial text, and a registered rendered-image output. The image card completes while the other two remain active. Stop settles the text card, and Allow once settles the approval card. Each has exactly one delivery attempt. The image is labelled `code-rendered`; live native raster recovery is proved below.
- **`npm run test:browser`:** all existing checks passed.
- **Collaborative browser smoke check** (temporary data directory, controlled native events):
  - A streamed reply appeared word by word through `delta` events without duplication, and the board's Working timer ticked.
  - Done cleared at once while the chat was visible.
  - A request created from another client appeared as Input needed over the stream. Its activity entry opened that card and focused **Allow once**.
  - A completion while the chat was closed showed Done, which cleared when another client posted `viewed`.
  - A completion while the selected chat was hidden showed Done. Revealing the chat cleared its durable marker immediately, without another provider event.

## Signed-in native image recovery gate

The bounded run on 2026-10-07 used Codex CLI 0.160.1, `gpt-6-luna`, the developer's existing ChatGPT sign-in, full Codex setup per ADR 0002, ordinary sandbox/approval settings, and a temporary Frameboard data directory. It made two submissions: one native image generation and one text-only follow-up. No approval request occurred.

The first submission generated one green square image. The test boundary dropped its completed-image notification and subsequent notifications before Frameboard stored any output. After a read-only native-history check confirmed that the real writer had persisted the completed item, the app-server was SIGKILLed and Frameboard restarted. Recovery imported that image, marked the unfinished turn interrupted, and sent no prompt. Its served bytes matched native SHA-256 `5e7214bf…59f02`. A second restart retained exactly one output and made no submission. The text follow-up then resumed the exact recorded binding and completed.

Raw evidence and bytes remain outside the repository in `/tmp/issue24-live-recovery-evidence.json` and its temporary data directory. This demonstrates real native image recovery rather than a loopback image simulation.

### Not yet established

- **Live provider-limit behavior.** It was not provoked, and the account was not deliberately exhausted. `-32001` handling follows Codex's documented backpressure response and is exercised with controlled failures only.
- **A `turn/start` timeout while Codex keeps running.** The adapter keeps that thread fenced as busy until a late response, a process exit or an app restart. After **Mark interrupted**, later work on that card waits for the provider, and after six tries it fails for an explicit retry.

## Standards review

No remaining blocking findings or documented standards breaches. The review compared the change against `f5b8f13`, checked the repository's plain Node conventions, glossary and ADR 0001, and verified the fixes for Stop races, blocked retry deadlines and native shutdown.

## Spec review

No remaining spec findings. The review verified recovered native identity, Stop/cancellation through uncertainty, Stop during outside-history lookup, visibility-driven Done clearing, real-image recovery and the three-card installed-native gate. Live provider-limit behavior remains disclosed above and is covered by controlled failures.

Final review totals: Standards 0; Spec 0.
