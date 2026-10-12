# A project holds several flows, each self-contained

Each project had exactly one flow: `projects.flow_id` pointed at it, and the project chose the card template for new cards. Now that every lane can run its own playbook and agent, one project naturally wants several kinds of flow, such as a long-form pipeline beside a Shorts pipeline. So a project now holds one or more flows:

- `flows` gains `project_id`, `position`, `template_id` and `deleted_at`. A flow is a board of lanes (`stages`) with the card template for its new cards. Cards still store only `project_id` and `stage_id`; a card's flow is its lane's flow.
- A card can move to a lane of any live flow in its project. It is an ordinary move: `set:` values apply in the move transaction, an `on-enter` playbook requests a lane run, undo reverses it, and the event records `fromFlowId` and `toFlowId`. Approve and send back stay within the card's current flow. A move to another flow records unmet exit criteria the way a forward move does.
- Each flow keeps its own `MAP.md`, `lanes/` and `skills/` in `data/flows/<flowId>/`, as before (ADR 0003). The project map becomes the **flow map**. A lane run's prompt names the project and the flow.
- The Library stays per project and is shared by every flow in it.
- Deleting a flow deletes its cards, as deleting a lane does, and leaves its folder on disk. A project keeps at least one flow.

## Why the template, map and skills belong to the flow

The user plans to export a single flow, not a whole-project backup, as a package that someone else can drop into their own Frameboard and get a working flow. That package has to carry everything the flow needs: its lanes, playbooks, skills, flow map and the card template its playbooks are written against. Keeping all of those on the flow now means export later copies one flow's rows and folder, without picking pieces out of the project.

## Considered options

- **A template per project, shared by its flows.** Rejected: flows of different kinds want different fields, and a flow could not be exported without its template.
- **Project-level skills shared by every flow.** Rejected for the same reason: exporting a flow would have to find and copy the skills it uses. Know-how meant for every flow can go in the project Library, which playbooks already reference.
- **Moving cards between flows by copying them.** Rejected: a copy loses the card chat, history and undo. A move keeps the card's identity.
- **Dropping `projects.flow_id` and `projects.template_id`.** SQLite cannot drop a column that is part of a foreign key, and rebuilding `projects` is risky for no gain. They keep the flow and template each project started with and are no longer read. `GET /api/workspace` still gives each project a `flowId`, but it now means the project's first live flow.

## Consequences

- The first flow of a new project is named "Main". Flows migrated from before this change keep their names, which were their projects' names.
- Template deletion is refused while a live flow uses the template for new cards. The template list reports `flowCount` instead of `projectCount`.
- Backups check that every live flow of a live project has its map.
- A future flow export will need to remap lane IDs (the `lane:` setting) and Library references (`assets:`) on import, since both name IDs from the original workspace.
