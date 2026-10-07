# Fresh context and reviewed summary — throwaway prototype

Decision ticket: [Design fresh context and reviewed summary transfer](https://github.com/michaelahoff/content-kanban/issues/14).

Open `public/fresh-context.prototype.html` directly in a browser. One self-contained file; no server, packages, native provider calls, persistence, or production functionality. The model uses simulated events and two cards to expose per-card isolation. It opens at an approved pending-summary state with a newly triggered graph held; Reset demo or any other walkthrough returns to a known initial state. The artifact is deliberately outside the main branch.

## Question

What sequence lets the user deliberately leave an outgoing native conversation, inspect a source-bound transfer summary, and start a fresh primary conversation without accidental requests, stale transfer, lost history, or interruption of unrelated cards?

## Confirmed in the live discussion

- Put Start fresh context in the primary-provider menu. Choosing another primary provider opens the same flow. Temporary per-prompt overrides are separate composer controls.
- Send an approved summary with the first ordinary prompt, not through a summary-only destination turn. Starting fresh context itself makes no destination request.
- Block a stale summary until it is regenerated or explicitly discarded. Starting without a summary remains possible.

## Additional choices confirmed in the live discussion

- Summary source: completed visible current-conversation text, including graph and temporary-override entries; exact source checkpoint and artifact references; no earlier conversations, hidden state, raw tool logs, credentials, grants or image bytes. Surface size omissions.
- Active and queued old work: finish, or explicitly stop/cancel; wait for confirmed interruption before switching. No silent retargeting or cancellation on other cards.
- A pending transfer belongs to the first manual primary-provider prompt. Hold new lane-graph execution and temporary overrides until that prompt or removal of the transfer. The hold persists through failed or uncertain first delivery until that submission is resolved or a transfer is explicitly discarded where safe.
- Dedicated summary operation without card mutation or native action tools where supported; restrictions must be explicit when unavailable.

## Final edges confirmed in the live discussion

- Use a separate, restricted summary-only session with the outgoing provider/model and exact visible-text snapshot. Preserve the original native primary conversation; unsupported restrictions fall back to manual/no summary. Disclose source-size limits rather than silently truncate.
- Keep a pending summary editable/inspectable after selecting fresh context. Recovered newer source messages invalidate it even after switching; refresh/review or discard before Send. Restored drafts do not auto-send.
- Hold new graph execution/overrides through failed or uncertain first transfer delivery. Keep the exact first submission; retry only explicitly, reconcile uncertain outcomes, and never consume/deliver the summary twice by accident.

The human selected these recommendations. The canonical answer and acceptance scenarios live in the decision ticket’s resolution comment; this artifact preserves the interaction exploration.

## Walkthroughs

- Pending summary plus graph: edit/reapprove a pending transfer; new graph work stays held until the first manual primary submission is resolved.
- Late source after switch: a recovered old-source message makes the pending summary stale; refreshed manual review is required.
- Uncertain first Send: retain the identified submission; no automatic resend or graph release; explicitly reconcile.
- Reviewed transfer: generate with Codex, inspect/edit, approve Claude fresh context, submit the first prompt once.
- Newer source: a recovered completed message makes a reviewed draft stale; transfer blocks until refresh or discard.
- Active and queued work: interruption must be acknowledged; old queued work is explicitly cancelled and late output cannot revive it.
- Summary failure: retry, cancel, or write manually; generation failure does not trap the user.
- Missing native, usable text: safely summarize retained source without the missing native primary identity.
- Restriction / size limit: generation is explicitly unavailable rather than inheriting broad tools or silently dropping source text; manual/no-summary remains possible.
- Missing native state: retained app text remains available for manual transfer, with no fabricated native resume or prompt replay.
- Temporary override: use Claude for one prompt while preserving Codex as the primary conversation.

The native-state, failure, completion and cancellation controls are simulation controls. The static artifact/image references do not imply file transfer or image generation. Per-card drafts and source inspection are in-memory only. App restart/storage rules remain [Choose durable chat, artifact, and recovery boundaries](https://github.com/michaelahoff/content-kanban/issues/11).

## Inspection

Desktop (728px) and narrow (375px) previews initialize with no console errors. At narrow width the summary-review state retains the outgoing primary identity, an unsent draft and two source messages; no destination submission exists and the other card remains running.

The refined eleven simulated walkthroughs initialize without console errors. The pending-summary graph scenario releases one held graph only after the first manual turn completes; uncertain first delivery blocks a second send until reconciliation. Every scenario preserves the other card’s running state. These checks do not establish native support or persistence guarantees.

Product decisions are settled through ten explicit human answers. Native summary-session restrictions, configuration inheritance and recovery/storage mechanics still require the map’s existing capability/configuration and durable-boundary work; the prototype proves none of those integrations.
