# Fresh context and reviewed summary — throwaway prototype

Decision ticket: [Design fresh context and reviewed summary transfer](https://github.com/michaelahoff/content-kanban/issues/14).

Open `public/fresh-context.prototype.html` directly in a browser. One self-contained file; no server, packages, native provider calls, persistence, or production functionality. The model uses simulated events and two cards to expose per-card isolation. The artifact is deliberately outside the main branch.

## Question

What sequence lets the user deliberately leave an outgoing native conversation, inspect a source-bound transfer summary, and start a fresh primary conversation without accidental requests, stale transfer, lost history, or interruption of unrelated cards?

## Confirmed in the live discussion

- Put Start fresh context in the primary-provider menu. Choosing another primary provider opens the same flow. Temporary per-prompt overrides are separate composer controls.
- Send an approved summary with the first ordinary prompt, not through a summary-only destination turn. Starting fresh context itself makes no destination request.
- Block a stale summary until it is regenerated or explicitly discarded. Starting without a summary remains possible.

## Proposed behavior awaiting human decisions

- Summary source: completed visible current-conversation text, including graph and temporary-override entries; exact source checkpoint and artifact references; no earlier conversations, hidden state, raw tool logs, credentials, grants or image bytes. Surface size omissions.
- Active and queued old work: finish, or explicitly stop/cancel; wait for confirmed interruption before switching. No silent retargeting or cancellation on other cards.
- A pending transfer belongs to the first manual primary-provider prompt. Hold new lane-graph execution and temporary overrides until that prompt or removal of the transfer.
- Dedicated summary operation without card mutation or native action tools where supported; restrictions must be explicit when unavailable.

Some follow-through decisions (pending-summary editing, late source events, graph holds, limits, retry provenance and restart behavior) will be refined after these answers. This document is evidence of exploration, not a resolution.

## Walkthroughs

- Reviewed transfer: generate with Codex, inspect/edit, approve Claude fresh context, submit the first prompt once.
- Newer source: a recovered completed message makes a reviewed draft stale; transfer blocks until refresh or discard.
- Active and queued work: interruption must be acknowledged; old queued work is explicitly cancelled and late output cannot revive it.
- Summary failure: retry, cancel, or write manually; generation failure does not trap the user.
- Missing native state: retained app text remains available for manual transfer, with no fabricated native resume or prompt replay.
- Temporary override: use Claude for one prompt while preserving Codex as the primary conversation.

The native-state, failure, completion and cancellation controls are simulation controls. The static artifact/image references do not imply file transfer or image generation. Per-card drafts and source inspection are in-memory only. App restart/storage rules remain [Choose durable chat, artifact, and recovery boundaries](https://github.com/michaelahoff/content-kanban/issues/11).

## Validation so far

Desktop (728px) and narrow (375px) previews initialize with no console errors. At narrow width the summary-review state retains the outgoing primary identity, an unsent draft and two source messages; no destination submission exists and the other card remains running. Additional walkthrough inspection follows the pending decisions.
