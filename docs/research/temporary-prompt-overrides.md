# Temporary prompt overrides and retained conversations

Researched 2026-10-06 for [Verify temporary prompt overrides and context forks](https://github.com/michaelahoff/content-kanban/issues/15). This is a prerequisite investigation, not a product decision or implementation. The target example is an Opus card chat, one Sol thumbnail prompt, then continuation of the **original Opus session**.

## Finding

That experience is technically plausible by retaining the primary session and running the override separately. Codex and Claude each support native history forks inside their own runtime. Their documented resume/fork interfaces do not establish an interoperable Opus-to-Sol native session. For the cross-provider case, use a new side session supplied with an explicit, portable context snapshot, then resume the retained primary session by its original identity. This is an architectural inference from the provider contracts and T3's explicit same-provider fork policy. It is not evidence that native reasoning or provider state can be cloned across providers. [Codex contract][codex], [Claude sessions][claude-sessions], [T3 policy][policy]

Keeping one visible card chat does not require replacing its primary native conversation. The app can display an override run and its outputs within that card chat while preserving separate provider-native identities. T3 likewise separates app relationships from their native or portable resolution. [T3 lineage design][lineage]

## Verified capabilities

- **Codex model change:** `turn/start` accepts `model` on an existing thread. The override becomes the default for subsequent turns; it does not automatically expire. A single-prompt setting therefore needs an explicit primary-model selection on subsequent turns, or a separate fork. `thread/fork` creates a new native thread with copied stored history and supports an inclusive stable-turn boundary. [Official app-server documentation][codex]
- **Claude model change:** `query()` accepts a model; streaming queries expose `setModel()`. That setter changes the running session's selection, rather than providing an automatic one-turn reset. Restore the saved primary selection explicitly if changing the primary session. `resume` with `forkSession: true` creates a separate session and leaves the original unchanged. [SDK reference][claude-sdk], [sessions][claude-sessions]
- **Resume:** use explicit native identities, not “continue the latest session.” Both providers expose targeted resume. Claude persists conversation state separately from filesystem state; retaining a session is not a filesystem snapshot. [Claude sessions][claude-sessions], [Codex][codex]
- **T3 precedent:** its pinned source permits native fork only when the provider matches, native identity is strong, the source run qualifies, and the adapter supports the requested boundary. Otherwise it selects portable context. Its Codex adapter calls native `thread/fork`; its Claude adapter calls the SDK's native fork function. [Policy][policy], [Codex adapter][codex-adapter], [Claude adapter][claude-adapter]

An Opus primary session can remain idle and untouched during a Sol side run. Its next prompt resumes that original identity. **It will not automatically know the Sol result just because the app renders that result nearby.** Send an explicit result handoff when that knowledge is required; this preserves the original session while adding new information. This is a product inference from independent native sessions, consistent with T3's explicit merge-back transfers. [T3 lineage design][lineage]

## Product alternatives to decide

These are supported design options, not already implemented behavior:

1. **Change the model within the primary native session.** Suitable when both models belong to the same compatible runtime and should share its conversation. Restore the primary model afterward. The temporary response becomes part of primary history. It provides no isolation of the tangent. [Codex][codex], [Claude SDK][claude-sdk]
2. **Use a native side fork.** Suitable for compatible models in the same provider runtime. The fork receives native history; the original stays available. Return selected results explicitly. Choose this when preserving the primary conversation matters more than including the whole tangent in it. [Claude sessions][claude-sessions], [T3 adapters][codex-adapter]
3. **Use a portable side session.** Suitable for Opus → Sol → original Opus. Freeze an app-owned snapshot, run Sol separately, retain its transcript/artifacts, and return to the same Opus identity. T3's cross-provider path supports the general pattern, but its source is not a guarantee for this board or these installed accounts. [T3 policy][policy], [handoff preparation][handoff]

For a portable side session, the user can choose:

- Selected card fields and selected image versions only.
- Those card inputs plus selected visible conversation messages.
- Those card inputs plus a reviewed, editable transfer summary.

These are alternatives within the existing explicit-context product model. None promises hidden reasoning, native tool state, credentials, or the provider's entire working context. Preserve a record of the exact snapshot sent. Freeze selected card inputs when queued; independently decide whether chat context is also frozen then or is taken from a stable completed boundary when the run starts. That timing affects whether earlier queued replies can be included and remains a product decision.

For returning output, show the side run in the card chat regardless of whether it is passed to Opus. Options are no automatic transfer, selected output/artifacts on the next Opus prompt, or an explicit reviewed result summary. Identify Sol as the source and include adopted/current card state separately. Do not pretend Sol's answer was Opus's native response. T3 treats merge-back as targeted additional context rather than replacing the source thread. [Lineage design][lineage]

## Boundaries the design must retain

**Context limits:** full visible history may exceed the target model's input window. T3's inspected portable handoff defaults to a 16,000-token budget, selects history, and records omitted items. That is an application policy, not a model window. Expose omissions or ask for a smaller snapshot; do not silently promise complete history. [Budget][budget], [handoff preparation][handoff]

**Images and files:** pass actual selected assets in a format the target runtime can consume, rather than relying on a provider-specific attachment ID or a transcript mention. Codex documents image input and native generation; thumbnail generation still requires the image tool to be available for the selected installation/account. The text model choice alone does not prove that capability. Store actual generated outputs and provenance; adoption remains a separate user action. [Codex image documentation][images], [existing board image research][existing-research]

**Tools and edit authority:** context transfer is not permission transfer. The side run needs explicit tool configuration and originating-card authorization. “Allow direct text edits” can default on without granting unrestricted shell, filesystem, connector, lane-move, or image-adoption authority. A textual prompt restriction does not enforce a workspace boundary. Claude's `allowedTools` pre-approves matching tools; it does not remove every unlisted tool, and auto-approved calls can bypass `canUseTool`. Enforce card IDs and edit rights in app tools; use runtime restrictions/hooks where needed for file access. [Claude permissions][permissions]

**Serialization and cancellation:** keep primary and override prompts in the card's submission order and identify which native session each turn targets. A graph can wait for the override and acceptance before continuing. Cancel unstarted side prompts in the app queue; request interruption of the specific active turn when required. Cancellation is not a rollback of edits, images, cost, or conversation knowledge. In Claude, the SDK's `interrupt()` does not itself send the optional control-protocol `cancel_queued` flag, so it must not be treated as app-queue cancellation. [SDK interruption contract][claude-sdk]

**Recovery:** retain the primary identity, side identity, source boundary, captured model selection, permissions, snapshot, delivery status, and result references. Failure must not lose or replace the primary session. Unknown delivery remains an explicit reconciliation/retry decision, consistent with the existing persistent-chat research. [Existing research][existing-research]

## Evidence and remaining live checks

Read-only inspection found Codex **0.160.1** and Claude Code **2.1.291**. Generated the installed Codex schema with `codex app-server generate-json-schema`; it confirms the model's subsequent-turn behavior and fork fields. Inspected current official documentation and the T3 checkout pinned to `dff412c3411f34b3150983f00686a98b600526e3`. No provider inference, native session mutation, image generation, or credentials inspection was performed.

Documentation/source establishes the interface and feasible architecture; it does not verify runtime/account success. Before promising this feature, live evidence must show:

1. Retaining an Opus identity, running an isolated Sol prompt with chosen text/images, then resuming the same Opus identity with and without an explicit result handoff.
2. Same-provider model override restoration and fork behavior across interruption and process restart.
3. Actual thumbnail generation/import, permissions, artifact access, and originating-card scope.
4. Oversized snapshots, unavailable models, cancellation, and uncertain-delivery recovery without replacing the original session.

The main unresolved product choice is **which context the side run receives and which results return to the primary session**. No native cross-provider cloning assumption is needed to make that choice.

[codex]: https://learn.chatgpt.com/docs/app-server
[claude-sessions]: https://code.claude.com/docs/en/agent-sdk/sessions
[claude-sdk]: https://code.claude.com/docs/en/agent-sdk/typescript
[permissions]: https://code.claude.com/docs/en/agent-sdk/permissions
[images]: https://learn.chatgpt.com/docs/image-generation
[policy]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/CommandPolicy.ts#L364-L389
[lineage]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/docs/orchestration-v2/thread-lineage-and-context-transfer.md
[codex-adapter]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L6837-L6861
[claude-adapter]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L730-L754
[budget]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/ContextHandoffBudget.ts#L14-L19
[handoff]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/ContextHandoffService.ts#L448-L484
[existing-research]: https://github.com/michaelahoff/content-kanban/blob/45fb1ff/docs/research/t3-code-card-chats.md
