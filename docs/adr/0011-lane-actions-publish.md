# A lane can do Frameboard's own work instead of running an agent: lane actions

Agents run inside the retained-data boundary (ADR 0004): any public HTTP(S) host, no SSH, no private addresses, nothing on this computer but their card workspace. Publishing a finished post to a VPS, or any other step that needs a key or a host the sandbox cannot reach, cannot be a lane run. It can be a **lane action**: a playbook that tells Frameboard what to do when a card enters the lane, with no agent in the loop.

```
action: publish
run: on-enter
publish:
  to: blog                 # a site folder under data/sites, or user@host:/var/www/blog
  url: https://blog.example.com/posts   # where the site is served; optional
  field: publishedUrl      # the card field that receives the post's address; optional
advance: auto
routes:
  published: Published
```

- `action:` names the action; `publish` is the first and only one. An action lane needs no instructions in its body; `run:`, `set:`, `routes:` and `advance:` mean what they always mean, and **Run playbook** runs the action again.
- A lane action is a lane run: the same `lane_runs` row, requested on entry or by Run playbook, cancelled if the card leaves first, shown on the card with its result. The lane runner performs it directly instead of queueing a card chat submission, so no provider, model or context is involved.
- **Publish** takes the card's saved outputs (each filename's newest saved version), writes them to the target with the card's title as the post's slug, puts the resulting address in `publish.field` (if it names one), appends hand-off notes, and follows the lane's first route when `advance: auto`. A local target (`to: blog`) is served by Frameboard at `/sites/blog/<slug>/` as sandboxed pages. A remote target (`user@host:/path`) is staged locally and sent with `rsync`, whose exact command and outcome the run records; without a key on this computer that step fails visibly and nothing is pretended.
- Published pages are copies. Replacing an output and publishing again replaces the page; nothing is published that the user has not reviewed in the lanes before.

## Why an action in the playbook, not a button or a script

The user describes a flow as nodes that each say what happens there. "Publish" is such a node. Keeping it a playbook keeps it visible on the graph, exportable with the flow, and reachable by `advance: auto` from a review node, so a post can go from approved to live without a click. A button would hide the step; a script would hide it from the flow.

## Considered options

- **Let the agent publish** (SSH key in the workspace, open the boundary). Rejected: the boundary exists so that a run cannot act on this computer or the network beyond public HTTP.
- **A generic `command:` action** running any shell command on entry. Rejected for now: it is the boundary's opposite, run by Frameboard itself. Named actions with explicit settings stay reviewable.
- **Publish as a card chat provider.** Rejected: nothing to converse with.

## Consequences

- `knownKeys` gains `action` and `publish`; `playbookSettings` returns them and `hasWork` says whether a lane has an agent run or an action.
- `publish.js` is the only module that writes sites; `server.js` serves them.
- Backups do not include `data/sites`: it is derived from saved outputs and can be published again.
