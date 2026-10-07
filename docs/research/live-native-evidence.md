# Live native chat and image capability evidence

Evidence for [Establish live native chat and image capability evidence](https://github.com/michaelahoff/content-kanban/issues/13), gathered 2026-10-07 within the bounded usage test agreed on the ticket. This is diagnostic evidence from a disposable client, not production integration. It proves mechanics on this developer's installed, authenticated runtimes; it does not establish provider terms for a distributed product.

## Environment

| Item | Value |
| --- | --- |
| Codex | `codex-cli 0.160.1`, `codex app-server` over stdio JSON-RPC, `experimentalApi: true` |
| Codex account | ChatGPT `plus` plan (`account/read`); `modelProvider/capabilities/read` reports `imageGeneration: true` |
| Codex models used | `gpt-6-luna` (low effort); `gpt-5.6-luna` for the model-change case |
| Claude | Claude Code `2.1.291` (`/usr/bin/claude`) via `@anthropic-ai/claude-agent-sdk` `0.3.292` with `pathToClaudeCodeExecutable` |
| Claude account | `accountInfo()`: `Claude Pro`, `apiProvider: firstParty`; `apiKeySource: none` (subscription OAuth) |
| Claude models used | `sonnet` → `claude-sonnet-5-5`; `haiku` → `claude-haiku-4-5-20251001` for the model-change case |
| Claude capabilities (init) | `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `interrupt_send_now_v1`, `msg_lifecycle_v1`, … |
| Node | v22.17.1 |
| Usage | ≈29 small text turns + 2 Codex image operations. Codex 5-hour window 2% → 7%. Claude five-hour utilization 0.17, seven-day 0.08 at the end (no pre-test baseline captured; other account use may be included). |

Scripts: [`live-native-evidence/scripts`](live-native-evidence/scripts). Sanitized per-block results: [`live-native-evidence/summaries`](live-native-evidence/summaries). Raw protocol logs remain outside the repository because they contain the developer's global harness instructions and account identifiers.

## Demonstrated

### Codex chat (block A)

- **Per-card identity and isolation.** Two `thread/start` threads ran concurrently in one app-server. Each native rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl`) holds only its own messages. Card A recalled its codeword after a follow-up. Card B's model answered `NONE` although its rollout contains its seed immediately before the question: a model recall miss at low effort, not cross-talk.
- **Client submission IDs are retained.** `clientUserMessageId` returns as `userMessage.clientId` in `thread/read`.
- **Model change persists in the thread.** `turn/start {model: gpt-5.6-luna}` changed `thread.model`, and the next turn without a model stayed on `gpt-5.6-luna`, confirming earlier research. `thread/resume {model}` sets it again.
- **Stop during streaming.** `turn/interrupt` → `turn/completed` with status `interrupted`. The streamed partial text produced **no completed `agentMessage` item and no assistant entry in the native rollout**; only a `<turn_aborted>` developer note is recorded. Frameboard must persist its own partial transcript if it shows partial output.
- **Approval wait, then Stop.** With `sandbox: read-only`, `approvalPolicy: on-request`, a write attempt produced `item/commandExecution/requestApproval` carrying thread/turn/item IDs, `reason`, `command`, `cwd`, and `availableDecisions: [accept, acceptWithExecpolicyAmendment, cancel]`. Interrupting while unanswered completed the turn as `interrupted` and emitted `serverRequest/resolved`; a late `decline` after that was harmless. No file was written.
- **Restart and exact resume.** After SIGKILL of the app-server, a new process `thread/resume`d the exact thread ID with all four turns and recalled the context.
- **Crash before acknowledgment.** Writing `turn/start` then SIGKILL immediately left **no turn** in the thread (timing-dependent; one observation).
- **Crash after acknowledgment.** SIGKILL after the `turn/start` response and first delta left the turn persisted as `interrupted`, with only the `userMessage` item. Nothing resumed or replayed it automatically; the thread became `idle` on resume. Ambiguous delivery is therefore detectable by turn ID/`clientId` after restart, and a retry must be an explicit new submission.

### Codex native images (block B)

- **Generation.** One `gpt-6-luna` turn produced an `imageGeneration` item (`status: completed`, `revisedPrompt`, `transparentBackground: false`, `savedPath` under `~/.codex/generated_images/<threadId>/<itemId>.png`). The base64 `result` bytes matched the saved file (SHA-256 `e41a6e3d…10bf`, 1254×1254 PNG).
- **Explicit reference edit.** A follow-up turn attached that exact imported file as `localImage` and asked for a colour change. A second `imageGeneration` item (`de407a0e…10db`) preserved composition and changed only the colour ([v1](live-native-evidence/artifacts/codex-v1-generated-thumb.png), [v2](live-native-evidence/artifacts/codex-v2-edited-thumb.png)). Both retained distinct native item identities.
- **After restart.** `thread/read` returned both items with `result` bytes (hashes unchanged) and the saved files still existed. The user message records the reference as a `localImage` **path**, not a content hash: if Frameboard moves or rewrites that file, native history no longer identifies the bytes.

### Claude Code via Agent SDK (block C)

- **App-chosen identity.** `sessionId: <uuid>` created sessions with that exact ID; every later `resume: <id>` (each in a fresh CLI process) reported the same `session_id`. Native transcripts live under `~/.claude/projects/-tmp-fb-live-evidence-work/<id>.jsonl` (encoded cwd).
- **Two-card isolation and concurrency.** Two concurrent sessions each recalled only their own codeword after restart.
- **Model change.** `setModel("haiku")` switched the live session (recorded as a `/model` local command in the transcript) and persisted for the remainder of that process. A later `resume` with `model: "sonnet"` used Sonnet. The process option, not the transcript, decides the model, so Frameboard must store the chat's chosen model and pass it on every resume.
- **Permission event, then Stop.** With `permissionMode: "default"` and `settingSources: []`, a Bash write invoked `canUseTool` with the tool name, input, `toolUseID` and two suggestions (`addRules:localSettings`, `addDirectories:session`). `interrupt()` while it was unanswered returned receipt `{still_queued: []}`, aborted the callback's signal, and ended with result `error_during_execution` / `terminal_reason: aborted_tools`. No file was written. The next turn's model remembered the denial.
- **Enforced removal vs instruction.** `disallowedTools` removed Bash/Write/Edit from the offered tools entirely; the model reported it could not write. A tool allowlist (`tools: [...]`) likewise restricted the offered set **and removed MCP connectors** (`mcp_servers: []`). Read-only tools (Read) did not route through `canUseTool`.
- **Stop during streaming.** `interrupt()` → receipt `{still_queued: []}`, result `terminal_reason: aborted_streaming`. Unlike Codex, the partial assistant text **is** persisted (flagged `aborted`), followed by a `[Request interrupted by user]` user entry and a **synthetic** assistant entry (`model: <synthetic>`, "No response requested.") in native history.
- **AbortController is not an immediate kill.** Aborting the SDK's `abortController` after the first delta did not stop the in-flight turn: it completed (`end_turn`, full output persisted) about 2s later before the stream closed. A true mid-stream process crash for Claude was **not** reproduced; see untested limits.

### Claude tool-rendered visuals (block D)

- With `tools: ["Bash","Read","Write"]` and an app `canUseTool` that allowed Bash only inside a scratch visuals directory, Claude wrote and ran a PIL script producing `kite-v1.png` (256×256), then read it back (an image `tool_result`). A second turn edited by explicit path + SHA-256 to `kite-v2.png`; v1 remained byte-identical.
- **Provenance available for import:** session ID, assistant message UUID, `tool_use` ID and command that produced the file, plus a directory diff giving file path and hash. Creation method is **code-rendered (Python PIL)**, not native raster generation. Reading an image back is an image `tool_result`, not a produced artifact; import must be keyed on files the turn created, not on image reads.
- The script files themselves were also created; an importer must select image outputs deliberately.

### Temporary overrides (block E)

- **Codex primary → Claude override.** A Frameboard snapshot (last six visible messages of the Codex thread + card fields, labelled as excluding hidden state) went to a new Claude session with `tools: []`. Its result was returned to the original Codex thread as a source-labelled handoff turn. The Codex thread ID and model (`gpt-6-luna`) were unchanged. The receiving model declined to repeat the handed-back headline because it treated the "codeword" as secret: handoff content is advisory input that the primary model may reinterpret, so Frameboard must keep the override's result as its own record rather than relying on the primary's echo.
- **Claude primary → Codex override.** A snapshot of the Claude session's visible messages **plus an explicit image reference** (`claude-kite-v2.png` as `localImage`) went to a new Codex thread. It correctly reported the codeword and the image colour. The handoff resumed the exact Claude session ID; Sonnet acknowledged it.
- Overrides ran as separate native sessions with their own tool configuration; no grants transferred.

## Material findings for the specification

1. **Harness configuration leaks into card chats by default.** Codex app-server threads receive the developer's global skills instructions, multi-agent role instructions and MCP servers from `~/.codex`. Claude sessions with `settingSources: []` still connect the account's **claude.ai connectors**, here including vidIQ tools that publish Instagram reels and update YouTube videos. An explicit Claude `tools` allowlist removed them; an equivalent Codex isolation control was **not tested**.
2. **Partial output persistence differs by harness.** Codex drops interrupted partial assistant text from native history; Claude keeps it (`aborted`) and adds synthetic entries.
3. **Model selection persistence differs.** Codex persists a turn-level model change in the thread; Claude's is per process and resets to the resume option.
4. **Image reference identity is path-based natively.** Frameboard must keep immutable copies and hashes of reference versions.
5. **Uncertain delivery is reconcilable on Codex** via turn status and `clientId` after restart; nothing auto-replays.

## Unavailable or not demonstrated

- **Claude native photo/illustration generation:** not demonstrated and not claimed. Only code-rendered visuals were produced. vidIQ's thumbnail tools are a separate third-party service and were not called (out of scope).
- **Claude hard crash mid-stream:** not reproduced (the SDK abort let the turn finish). Claude's equivalent of Codex's "after acknowledgment" crash state is untested.
- **Codex harness-configuration isolation** (disabling inherited skills/MCP per thread): untested.
- **Claude `cancel_queued` interrupts and queued-message receipts with non-empty queues:** capability advertised, not exercised (single submission at a time).
- **Usage-limit/quota exhaustion, unsupported-model errors, missing native state** (deleted rollout/transcript): not tested by agreement or budget.
- **Oversized context snapshots:** not tested; the snapshots used were under 500 characters.
- **Concurrency beyond two cards:** not measured.
- **Late events after cancellation of a graph run with result handoff:** not exercised as a combined scenario; the individual pieces (interrupt, late approval answer, handoff) were.
- **Backup/restore of native state without credentials:** native files were located (Codex rollouts and generated images; Claude project transcripts) but not copied to a separate home and resumed.
- **Provider terms for distributing a subscription-backed product:** not addressed by any test.
