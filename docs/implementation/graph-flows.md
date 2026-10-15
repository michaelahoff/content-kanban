# Graph flows

How the graph view and routes are built. The decision is [ADR 0009](../adr/0009-graph-flows-with-routes-in-playbooks.md).

## Data

- `flows.kind`: `board` (default) or `graph`. `stages.graph_x`, `stages.graph_y`: a node's place, in canvas pixels, `null` on boards. Added by `graphFlowsMigration` in `store.js`.
- Routes and advance are lane playbook settings, parsed by `playbookSettings` (`public/playbook-format.js`) into `settings.routes` (`[{ name, target }]`) and `settings.advance`. `resolveRoutes(routes, lanes, ownId)` resolves targets by lane ID, then name; `laneId` is `null` for a route that leads nowhere.
- `withPlaybooks` adds `playbook.routes` (`[{ name, target, laneId }]`) and `playbook.advance` to each stage the browser reads.
- `playbooks.updateSettings(flowId, stage, changes)` is the one write the graph editor makes: `withSettings` on the lane's playbook, or a new `nodeTemplate` file (`run: off`) when the lane has none. Writes are hash-checked as all playbook writes are.

## Store operations (`store.js`)

- `createFlow` / `createProject` take `kind`. A graph starts from `graphStarter` (Ideas → Draft → Review, approved → Done, revise → Draft), whose node playbooks are written after the flow's row commits, and whose flow map lists nodes and routes (`mapTemplate(..., routes)`).
- `createStage` takes `x`, `y`; in a graph it also writes the node's playbook. `updateStage` takes `x`, `y`.
- `setRoutes(ctx, stageId, { routes, advance, baseHash })` validates names (`routeName`), duplicates, self-routes and lanes outside the flow (an unchanged route that already leads nowhere may stay), then writes the settings if the playbook still has `baseHash` (`409` otherwise; the browser reloads the routes).
- `deleteStage` removes routes that led to the deleted lane from the flow's other playbooks.
- `convertFlow(ctx, id, { kind })` checks every lane playbook parses, then rewrites routes (board → graph adds `next` routes; graph → board removes `routes` and `advance`), then sets the kind, order and places in one transaction and records a flow `updated` event with `data.kind`.
- `transitionCard` takes `route` and records it on the move event. `laneRuns.automaticMoves(cardId)` counts the agent's route moves since the card was created or the user last moved it.

## Lane runs (`lane-runner.js`)

- `prepare` resolves the playbook's routes against the flow's lanes and passes them to `composeLanePrompt`, which adds a "Routes out of this lane" section and asks for `"route"` in the result block instead of `"move"`.
- `applyLaneResult` calls `followRoute` for a result's `route`. It re-reads routes and advance from the playbook text frozen in the submission, resolves the route against the run's flow, and either moves the card with an `automation:<attemptId>` actor (advance `auto`, card still in the node with the same entry, no unsaved edits, fewer than `maxAutomaticMoves` in a row) or proposes the move, with its route, through the `lane-result-route` tool call. Moving on by itself also needs the node's current playbook to say `advance: auto`. The run's summary says which.
- The next node's `on-enter` run is requested by `transitionCard` inside that same transaction, and queues behind the finishing attempt in the card chat.

## Browser

- `public/graph.js` renders a graph flow into `#board` (`renderBoard` hands over when `flow.kind === 'graph'`). Nodes are `[data-lane]` sections with a `.lane-cards` list, so app.js's card drag, drop, paste and file-drop handling work on them unchanged. The page's CSP refuses `style` attributes, so node and label places are set through the CSSOM after rendering.
- Routes are SVG paths: forward routes are one curve between a node's port and the next node's heading; a route back, or to a node not to the right, runs under both nodes on its own level. Labels are buttons that open the route form.
- Pointer gestures (and Alt + arrow keys on a focused node, which also pans into view when focused): drag on the canvas pans, a node's heading moves it (snapped to a 20px grid and saved with `moveNode`), its port draws a route (`setRoutes`). Scroll pans; Ctrl/⌘ + scroll zooms around the pointer. Pan and zoom are kept per flow in `localStorage` (`frameboard-graph-views`); a flow opened for the first time is fitted without going below 70%.
- `public/card-playbook.js` shows **Follow a route** buttons for a card in a graph node. `public/playbook-form.js` shows Advance and Routes rows for graph flows (or any playbook that has those settings).
- `public/graph.css` holds the canvas, node, route and form styles for both themes.

## Tests

- `test/graph.test.js`: settings parsing, prompt and result, starter graph, route editing and validation, node deletion, both conversions, automatic and reviewed routes, the loop pause, restart, and the schema upgrade.
- `scripts/browser-test.mjs`: "graph flows" step — creating a graph flow, drawing and editing a route, dragging a node, following a route from the card, and converting to a board.
