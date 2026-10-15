# A flow can be a graph whose routes live in its lane playbooks

A board orders lanes left to right, and the only way a lane run sends a card on is a proposed move that waits for the user. Flows that branch or loop (draft → review → revise → draft) could not be drawn or run that way. A flow can now be shown as a **graph**: each lane is a node placed on a canvas, joined to other nodes by named **routes**, and a node's agent can choose a route that the card then follows by itself.

- `flows.kind` is `board` or `graph`, chosen when a flow (or a project's first flow) is created. `stages.graph_x` and `stages.graph_y` hold a node's place on the canvas. A graph flow is still a flow of lanes: cards, moves, undo, lane runs, Library and templates work as before.
- A node's routes and how they are followed are settings in its lane playbook, next to everything else that describes the node:

  ```
  advance: auto        # or review, the default
  routes:
    approved: <lane ID>
    revise: <lane ID>
  ```

  A route names a lane of the same flow by ID (the graph editor writes IDs) or by name. A route to the node itself, or to a lane that no longer exists, leads nowhere and is shown as a problem rather than drawn.
- A lane run lists its node's routes in the prompt, and the agent picks one with `"route": "<name>"` in its result block. The route is resolved against the routes of the playbook text the run froze. With `advance: auto` the card moves at once, as the agent's move with the route recorded on the event, and the next node's playbook starts. Otherwise the route becomes a move proposal, carrying the route so that accepting it records it too. It is also only a proposal when the card left the node during the run, when the node's playbook no longer says `advance: auto` (a flow turned into a board stops a run already in flight), when the card has unsaved edits, or when it has made 12 automatic route moves in a row since the user last moved it. This amends ADR 0003's "moves always wait for the user" for nodes that choose `advance: auto`.
- The user follows a route from the card editor; that move records the route too and restarts the count.
- Every node of a graph has a playbook, created with `run: off` when the node is added, so its routes have a file to live in. Deleting a node removes the routes that led to it from the other playbooks.
- A board becomes a graph in a single line: each lane routes to the next with a route named `next`, unless its playbook already has routes, and nodes are placed left to right. A graph becomes a board in route order from its first lane (breadth first, then unreached nodes left to right) and loses its routes, its advance settings and its layout. That direction is destructive and the app says so before converting. Neither conversion starts if a lane playbook's settings cannot be read.
- The start node is the first lane, as before: new cards and cards dropped on the flow in the sidebar go there.

## Why routes are playbook settings, not database rows

The user wants nodes described by Markdown documents, the way lanes are (ADR 0003). A route is part of what a node does: the playbook's instructions say when to choose `approved` and when `revise`, so the names and the instructions belong in the same file, where an agent or a text editor sees both. It also keeps a flow self-contained for export (ADR 0006): the routes travel with the playbooks. The graph editor writes routes with `withSetting`, which changes only that setting. It sends the hash of the playbook it showed, so routes changed in another tab, in the playbook editor or on disk are not overwritten, and a route that already leads nowhere is kept unless the user changes it.

Places on the canvas are layout, not behaviour, so they stay in the database with the lane.

## Considered options

- **A `flow_edges` table.** Simpler transactions, but the routes would be invisible to the files that describe each node, and editing a node would mean two places.
- **Conditions on edges evaluated by Frameboard** (field filled, word count). Rejected for now: the agent already reads the card and the instructions, and choosing a named route is what it does well. A rule-based route can come later as another setting.
- **Automatic routes by default.** Rejected: flows stay advisory and review-gated (the Frameboard direction). `advance: auto` is an explicit choice per node, and a loop pauses for review after 12 automatic moves.
- **Self-routes meaning "run again".** Left out: a node that repeats is drawn as a loop through a review node, which keeps every repetition visible.

## Consequences

- `playbookSettings` gains `advance` and `routes`; `describeSettings` mentions them; `knownKeys` includes them.
- Undo last move undoes one move. A chain of automatic moves is undone one move at a time.
- A route the agent names that the node does not have changes nothing and is reported in the run's summary.
- Export of a flow must remap lane IDs in `routes:` as it already must for `lane:`.
