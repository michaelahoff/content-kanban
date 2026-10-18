# The project chat and the flow builder

Design: [ADR 0012](../adr/0012-project-chat-builds-flows-through-tools.md). This note records how the pieces fit and how to check them.

## Pieces

- `flow-builder-tools.js`: the tool specifications (JSON Schema) and `builderInstructions`, the guidance the agent receives as its developer instructions. Pure; imported by `codex-configuration.js` for the `builder` role.
- `flow-builder.js`: `createFlowBuilder({ store }).call(ctx, projectId, tool, input)` implements each tool over the store; `composePlaybook` turns a playbook spec into a document and reads it back the way a lane run will; `layerGraph` is the layered layout behind `layoutGraph` (planned lanes), `layoutStages` (a flow's lanes) and the `layout_flow` tool; `store.stagePlacement` says whether the user or the builder last moved a node; `projectSummary` is the text at the top of every message.
- `store-project-chats.js`: the tables and `store.projectChats` (snapshot, queue, start, finish, items, tool-call receipts, fresh, interruptAll).
- `project-chat.js`: the worker. `send` queues a turn and returns; `run` discovers the provider, freezes or reuses the conversation's configuration (`compileConfiguration(..., 'builder')` with the tools as dynamic tools), opens the native thread, subscribes, starts the turn, and writes streamed items. Tool calls route to the builder with actor `automation:project-chat:<turnId>` and are deduplicated by call ID. `stop` interrupts; `fresh` starts a conversation; a restart interrupts unfinished turns.
- `public/project-chat.js` and `public/project-chat.css`: the Chat tab. It streams deltas (`onDelta` from `chat.js`), refreshes on `project-chat` activity, and reloads the project's structure (`reloadProject` in `state.js`) when a writing tool ran or a turn ended, so the sidebar and board follow the builder live. The tab shows a dot while a turn runs.

## API

- `GET /api/projects/:id/chat` → `{ projectId, archived, provider, model, conversations, turns, items, busy }`.
- `PUT /api/projects/:id/chat` `{ provider?, model? }` saves the chat's choice.
- `POST /api/projects/:id/chat/turns` `{ id, prompt, provider?, model? }` → `201` with the queued turn. One turn at a time per project (`409` otherwise); without a model the provider's default is used; switching providers after the conversation has been used needs fresh context.
- `POST /api/projects/:id/chat/stop`, `POST /api/projects/:id/chat/fresh`.
- Activity entries have entity `project-chat` and types `turn_queued`, `turn_running`, `transcript_updated`, `tool_called`, `turn_completed`, `turn_failed`, `turn_interrupted`, `turn_stopping`, `fresh_context`, `settings_saved`. Deltas on `/api/stream` carry `projectId`, `turnId`, `itemId`, `offset`, `text`.

## Checks

- `test/flow-builder.test.js`: every tool against a store, including the all-or-nothing checks of `create_flow`, name-to-ID resolution, deleting with `moveCardsTo`, template rules, the layout (longest path, loops, branches, placement of an added node, `layout_flow` refusing nodes the user placed) and the archived refusal.
- `test/project-chat.test.js`: the role configuration; a turn through the Codex fixture with tool calls, receipts, refusals, streaming, activity, Stop, fresh context, provider switching, default and unavailable models, restart, archive; and the Claude fixture receiving the tools over the SDK-hosted MCP server.
- `scripts/browser-test.mjs` (step "project chat"): the Chat tab sends, streams, shows the builder's changes on the board while the turn runs, stops, starts fresh context and keeps its history across a reload.
- A live check on 2026-10-17 with Claude (sonnet) through the installed Claude Code: see the transcript summary in the pull request. The builder read the project, created a template and rebuilt the starter flow as a graph in one `create_flow` call, then summarized the result.
