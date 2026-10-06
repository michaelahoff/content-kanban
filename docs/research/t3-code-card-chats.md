# Persistent card chats using the T3 Code approach

Researched 2026-10-06 against the official `pingdotgg/t3code` repository, pinned to [`dff412c3411f34b3150983f00686a98b600526e3`](https://github.com/pingdotgg/t3code/tree/dff412c3411f34b3150983f00686a98b600526e3). Source was inspected in a temporary checkout; no T3 dependencies or application code were added.

## Finding

Yes: the board can provide independent, persistent conversations backed by the same installed Codex/Claude runtimes that T3 Code controls. Reusing the integration pattern is more suitable than embedding the entire T3 application. That is an architectural recommendation, not a claim that T3 publishes a supported embeddable chat widget.

Both providers are implemented now. The current README lists them, and `builtInProviderAdapterDrivers.ts` registers both `CodexAdapterV2Driver` and `ClaudeAdapterV2Driver`. Claude support should not be described as future work based on older articles. [README][readme], [registered adapters][drivers]

## What T3 actually does

**Codex:** its server spawns the installed `codex` executable with `app-server`. The adapter calls `thread/start` for a new conversation, stores the returned native thread identity, calls `thread/resume` for an existing conversation, and sends each prompt using `turn/start`. It consumes notifications such as `item/agentMessage/delta` for live output. The transport encodes newline-delimited JSON over the child process's standard input/output; it handles protocol replies, notifications, and provider requests rather than scraping a terminal. [Launch arguments][codex-launch], [Codex adapter: spawn][codex-spawn], [start/resume][codex-threads], [turn start][codex-turn], [stream deltas][codex-delta], [stdio protocol][codex-protocol]

**Claude:** its adapter imports the official `@anthropic-ai/claude-agent-sdk` and calls `query()` with an asynchronous queue of user messages. Query options use `{sessionId: nativeThreadId}` for a new conversation and `{resume: nativeThreadId}` for an existing one. `includePartialMessages: true` enables streamed output. It passes tool permissions, the selected model, provider environment, optional Claude executable path, and MCP configuration through the SDK. This is a programmatic SDK integration, not a Claude browser UI embedded in T3. [SDK query runner][claude-query], [session identity/options][claude-options]

**Browser boundary:** the browser does not own provider credentials or launch agent executables. T3's backend owns those processes, files, and credentials. Its frontend uses authenticated RPC, including command dispatch and thread subscriptions. Protocol commands include `thread.create` and `message.dispatch`; message dispatch supports starting, queuing, or steering work. [Architecture][architecture], [RPC dispatch/subscriptions][rpc], [thread creation][thread-create], [message dispatch][message-dispatch]

**Persistence:** T3 distinguishes application threads from provider-native conversations and live provider sessions. Durable events, persisted projections, command receipts, and side-effect outbox entries commit together; subscribers receive updates after commit. The effect worker then performs provider/file operations outside the transaction. This is useful precedent for making lane-triggered prompts recoverable without holding a SQLite write transaction open during model execution. [Architecture: durable intent][durability], [provider session bindings][bindings], [outbox schema][outbox]

## Authentication and reuse

T3's documented local-provider path uses the user's installed, authenticated CLIs: `codex login` or `claude auth login`. Claude uses Claude Code's configuration; separate accounts use separate config directories and local conversation state. Codex can reuse an existing CLI login and also offers its own managed ChatGPT connection. These are provider credentials; T3's browser/environment login and scoped RPC authorization are a separate concern. [Provider setup][readme], [Claude account configuration][claude-auth], [Codex account configuration][codex-auth], [environment authentication][environment-auth]

The repository is MIT licensed: copying or modifying its code requires retaining its copyright and permission notice with copied/substantial portions. That license applies to T3's code, not to provider subscriptions or separately licensed dependencies. [License][license]

The inspected web app is a full React application, and its web, contracts, client-runtime, and Codex transport packages are marked private. The inspected architecture exposes an internal, independently versioned client/server RPC contract, not a documented drop-in Kanban chat component. Therefore a dedicated board chat UI over a small provider adapter is the recommended implementation. Connecting to a separately running T3 backend is technically another option, but couples the board to T3's internal contracts, environment authentication, thread/project model, and upgrades. [Web package][web-package], [contracts package][contracts-package], [client runtime package][runtime-package], [Codex transport package][transport-package], [architecture][architecture]

## Official provider references

Use the official provider integration contracts when implementing rather than treating the T3 implementation as a stable SDK: [Codex app-server](https://learn.chatgpt.com/docs/app-server) and [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions). Persist the explicit provider conversation ID for each board chat; do not use a global “continue most recent conversation” operation. Preserve the provider's local session storage as well as the board's display history.

For current Claude subscription billing guidance, consult [Anthropic's Agent SDK plan notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). The announced June 15 change is currently paused; SDK, print-mode, and third-party usage continue to draw from subscription usage. This is time-sensitive and must be rechecked before productizing the integration.

[readme]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/README.md
[drivers]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/builtInProviderAdapterDrivers.ts#L31-L44
[codex-launch]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/provider/codexLaunchArgs.ts#L12-L15
[codex-spawn]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1457-L1509
[codex-threads]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L6038-L6123
[codex-turn]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L5823-L5861
[codex-delta]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L3862-L3885
[codex-protocol]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/packages/effect-codex-app-server/src/protocol.ts#L98-L127
[claude-query]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L600-L655
[claude-options]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L843-L910
[architecture]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/docs/internals/overview.md
[rpc]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/packages/contracts/src/rpc.ts#L1498-L1586
[thread-create]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/packages/contracts/src/orchestrationV2.ts#L2608-L2633
[message-dispatch]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/packages/contracts/src/orchestrationV2.ts#L2834-L2878
[durability]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/docs/internals/overview.md#durable-intent-and-side-effects
[bindings]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/persistence/Migrations/OrchestrationV2/ProviderSessionBindings.ts
[outbox]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/persistence/Migrations/OrchestrationV2/Foundation.ts#L113-L137
[claude-auth]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/docs/user/providers-claude.md
[codex-auth]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/docs/user/providers-codex.md
[environment-auth]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/docs/internals/environment-auth.md
[license]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/LICENSE
[web-package]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/web/package.json
[contracts-package]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/packages/contracts/package.json
[runtime-package]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/packages/client-runtime/package.json
[transport-package]: https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/packages/effect-codex-app-server/package.json


## Proposed Frameboard integration

These are design recommendations based on this application's current source, not functionality implemented by this research.

### User experience

- Give each card a Chat tab, initially with one primary conversation. Model the relationship as one card to many conversations so users can later keep separate chats for writing, research, or alternatives.
- Choose a provider for a conversation and keep its provider-native thread/session ID. Sending a follow-up resumes that exact conversation; never resume the globally most recent conversation.
- A Run prompt button sends the card's current Prompt plus explicitly selected card context. Show the exact context included. Keep the prompt and context snapshot with the run, so subsequent editing does not change what was sent.
- Stream text and show running, awaiting approval/input, completed, interrupted, and failed states. Provide Stop and preserve partial replies.
- Replies remain messages. Apply to Intro/Script uses the card's existing revision-checked save mechanism and preserves newer local drafts.
- Provider-native histories are distinct. Switching providers starts a new native session; carrying selected old messages over is an explicit context transfer, not a native resume.

### Where it fits in this repo

- `public/flow-graph.js` currently validates only entry/Set field nodes and evaluates commands synchronously. `store.js` applies their effects inside a SQLite transaction. A model call must not run inside that transaction.
- Add a provider boundary that creates/resumes conversations, sends turns, streams normalized events, interrupts work, and handles approval/input requests. Keep provider processes and credentials on the Node server.
- Add durable `card_chats`, `chat_messages`/items, and `chat_runs` storage behind `store.js`. Store provider, native session ID, card relationship, turn IDs, exact submitted prompt/context, status, and app-visible transcript.
- Existing `onCardEvent` callbacks run after commit. They can wake a worker, but are not a durable queue and do not recover missed work after a crash. Create pending run/job records in the same transaction as a triggering move, then let a worker consume them after commit. Recover pending jobs at startup.
- The Node server can launch `codex app-server` and forward its events to browsers over SSE or WebSocket. Browser tabs subscribe to application-owned chat IDs. Browsers do not launch or receive direct access to the CLI.
- Serialize turns within each conversation. Idle saved chats need no active inference. Start with low global concurrency and explicit handling of account limits and provider failures.
- Keep transcript/item IDs and submission IDs to avoid displaying duplicated streamed messages. Treat uncertain provider delivery after a crash as a reconciliation problem; a local outbox alone cannot guarantee an exactly-once external model turn.

### Incremental implementation

1. Manual Codex chat on a card: persist a native thread ID and local transcript, send its prompt/context, stream replies, follow up, stop, resume after restart, and apply a reply to a field safely.
2. Add Claude behind the same provider boundary using the official Agent SDK and explicit session IDs.
3. Add a Send prompt graph node: current/new named chat, configured prompt/context, optional reviewed output destination. Entry-triggered jobs retain the originating move/event and graph node IDs.
4. Expand the time machine to show prompt runs and accepted field changes alongside card movement.

For graph execution, the example would be `Card enters lane → Set fields → Send prompt to this card's chat`. The queued prompt captures values after preceding Set nodes. Initially make the async node terminal; supporting Set nodes after it requires a persisted workflow continuation, not pretending the existing synchronous evaluator can await a model call.

### Undo and durable history

Undo can cancel a queued run that has not started, and can request interruption of an active provider turn. A submitted prompt and any reply remain in the conversation; moving a card back does not reverse provider usage or remove the model's knowledge of that prompt. Record that the triggering move was undone instead of deleting the run. Accepted AI field changes need their own before/after record and conflict checks; the present Undo last move covers synchronous lane-command changes.

### Local versus hosted use

The current localhost Node app is a natural place to run already installed CLIs. Read-only checks found `codex-cli 0.160.0` and a `claude` executable on this machine; authentication and a real model turn were not tested.

A hosted website cannot directly spawn a visitor's local CLI. A hosted product needs a local companion/desktop connection, or server-side provider runtimes with per-user authentication and isolation. Keep a local-first integration separate from a shared hosted-service design.

A SQLite chat ID and displayed transcript alone are not sufficient to guarantee provider-native resume on a different machine: provider session files/state must also survive, or the application must deliberately start a new session with reconstructed context. Include this in backup/recovery design.

### Official documentation checked

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): documented product integration, stdio JSON-RPC, thread start/resume/fork, turns, streaming, interruptions, approvals, and authentication. Its current documentation labels app-server experimental; pin/test the CLI protocol rather than claiming a production stability guarantee.
- [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions): explicit session IDs for concurrent independent conversations, resume/fork, automatic local transcript persistence, and cross-host persistence requirements.
- [Claude subscription usage notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): the June 15 billing change is explicitly paused; the notice currently says Agent SDK, `claude -p`, and third-party app usage still draw from subscription usage limits. This is not a promise of unlimited use or a shared hosted entitlement.

## Image generation follow-up (2026-10-06)

Image creation is not inherently tied to the desktop UI. Official OpenAI documentation describes built-in generation and editing in Codex CLI and IDE sessions, using GPT Image 2 and counting against Codex usage limits. These are image-tool capabilities, not a guarantee that every chat model or authentication route exposes them. [Official image generation documentation](https://learn.chatgpt.com/docs/image-generation)

Read-only inspection of the installed Codex 0.160.0 protocol, generated with `codex app-server generate-json-schema`, confirmed an `imageGeneration` thread item with `id`, `status`, `result`, `savedPath`, `revisedPrompt`, `transparentBackground`, and `failure`. The last field can report image usage limits. Protocol support establishes that a custom client can receive image-generation outcomes; no inference request was made, so account-specific access and the complete generation/editing round trip remain untested.

The pinned T3 generated protocol contains the same item, but its inspected Codex adapter has no explicit `imageGeneration` handler. Its completed-item dispatch skips remaining items that are not agent messages. Do not assume a text-chat adapter already imports or renders native generated images; our adapter must explicitly preserve image events and safely import outputs into the card gallery. This finding does not establish that all image workflows fail in T3: generated files or message links may be surfaced through other paths. [Generated item](https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/packages/effect-codex-app-server/src/_generated/schema.gen.ts#L41299-L41309), [completed-item dispatch](https://github.com/pingdotgg/t3code/blob/dff412c3411f34b3150983f00686a98b600526e3/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L4595-L4606)

Claude can inspect images and create code-based visuals, but does not natively generate photos or illustrations. A Claude conversation therefore needs an external image-generation tool/service for those outputs. [Anthropic's explanation](https://support.claude.com/en/articles/9002504-can-claude-produce-images)

OpenAI's Image/Responses APIs offer an independent server-side path for generation and editing, including conversational revisions, with API authentication/billing. This can also be exposed as a tool to Claude. It does not require the desktop app. [Image API guide](https://developers.openai.com/api/docs/guides/image-generation)

Do not confuse native Codex CLI tools with the separate Sign in with ChatGPT token-sharing Responses configuration. The latter explicitly lists the hosted image-generation tool as unsupported in its current preview. A successful text-chat connection on that route does not prove image generation is available. [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

Because images are a core product requirement, the first integration milestone should prove: generate through app-server, display/save the actual output on its card, edit using a reference image in the same conversation, retain both versions, and reopen after restart. Keep chat provider and image provider separate in the data model. Prefer native Codex image generation where available, with an explicit API-backed image tool for Claude or unavailable native configurations. Preserve provider/model, prompt, reference images, output identity, and source turn alongside every generated version.
