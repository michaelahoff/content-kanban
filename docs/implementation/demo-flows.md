# Demo flows: three end-to-end graph flows and what they needed

Three flows were built to find the limits of lane playbooks, graph routes and the agent sandbox, and what was added to make them work. Each lives under `demo/<flow>/` as a manifest plus Markdown documents, and `scripts/demo-flows.mjs` installs them into a running Frameboard over its HTTP API. The decisions they forced are [ADR 0010](../adr/0010-lane-runs-create-cards.md) (lane runs create cards) and [ADR 0011](../adr/0011-lane-actions-publish.md) (lane actions; publish).

## The flows

1. **Video to blog** (`demo/video-to-blog`): a YouTube link → transcript → outline → post with diagrams and code → review loop → publish to a site. Shows the transcript field, HTML previews and the publish action.
2. **Local business sites** (`demo/business-sites`): a list of businesses in a town → one card per business → research, owners, socials → a design brief in the owner's taste → an HTML mockup previewable in the app. Shows created cards and concurrent runs.
3. **Outlier remix** (`demo/outlier-remix`): a screenshot of an outlier video (big views, small channel) → packaging analysis → titles → intro → thumbnails from Codex (native image generation) and from Claude (SVG rendered with rsvg-convert) → a retention-built script. Shows provider-specific nodes and image outputs.

## Manifest format (`demo/<flow>/flow.json`)

```json
{
  "project": "Video to blog",
  "flow": { "name": "Main", "kind": "graph" },
  "templates": [ { "id": "blog-post", "name": "Blog post", "title": { "label": "Post title", "max": 500 }, "fields": [ … ], "imageRoles": [ … ] } ],
  "template": "blog-post",
  "map": "MAP.md",
  "skills": ["skills/voice.md"],
  "nodes": [
    { "name": "Inbox", "color": "lavender", "x": 0, "y": 40, "playbook": "lanes/inbox.md" },
    { "name": "Outline", "color": "blue", "x": 380, "y": 40, "playbook": "lanes/outline.md" }
  ],
  "cards": [
    { "node": "Inbox", "title": "…", "fields": { "originalVideoUrl": "https://…" }, "images": [ { "file": "assets/screenshot.png", "roles": ["original"] } ] }
  ]
}
```

- `templates` are full card template definitions (`public/card-template.js`); the installer creates each unless a template with that `id` exists. `template` is the flow's template for new cards.
- `nodes` are created in order; the first is the start node. A node may name the `template` of the cards it holds (for a lane that receives created cards of another template); `--check` reads its playbook against that template instead of the flow's, and the installer writes it into the playbook as its `template:` setting. Each `playbook` file is a lane playbook whose `lane:` line the installer sets to the created lane's ID. `routes:` and `creates.lane` name lanes **by name** so the files read naturally; the installer leaves them as names, which `resolveRoutes` and `resolveCreates` accept.
- `skills` and `map` are written as they are. `cards` are created after the nodes, each in its named node, with field values and gallery images uploaded from `assets/` (roles: `original`, `inspiration`, or any role key of the template; the first image is the display image).
- A card may also carry `"youtube": "<url field key>"`. The installer sends that field's value to `POST /api/youtube` with `transcript: true`, then fills the card: the title (if the manifest gives none), the template's `originalVideoTitle` field (if it has one and the card gives no value), the template's `transcript: true` field (the caption text, trimmed and cut to the field's limit; a video without captions only prints a note), and the video's thumbnail as the display image and the `original` image. Image `roles` take the template's role keys or labels, and `cover` (or `display`) picks the display image; the first image is the display image unless one lists `cover`.

### Running

```
node scripts/demo-flows.mjs [--base http://127.0.0.1:3000] [--only <flow-dir-name>] [--replace] [--check] [demo]
```

- `demo` is the folder holding the flow folders (default: `demo/` in the repository); every sub-folder with a `flow.json` is a flow, and `--only` (repeatable, or comma-separated) picks some by folder name. `--base` is the running Frameboard.
- Each flow is checked first (below); a flow with problems is reported and not installed, and the others still install. The exit code is 1 if any flow had a problem or failed, with the server's message, and 0 otherwise.
- The installer prints one line per step, in this order: templates (created unless one with that `id` exists), the project (`kind` from `flow.kind`, `template` as its card template; the flow is renamed when `flow.name` differs), the manifest's nodes in order with their colors and positions, then the project's starter nodes and their leftover playbooks are removed, then `MAP.md`, the skills and each node's playbook (written as `lanes/<file name>.md`, replacing the empty playbook a graph node starts with, with its `lane:` line set to the created node's ID and `routes:` and `creates:` left as names), then the cards (images uploaded from `assets/`, then created in their node). Last it reads the flow back and reports any playbook error or route that leads nowhere.
- A project with the same name is left alone and reported as skipped. `--replace` deletes it first (unarchiving it if needed), so its cards and chats go too; the playbook folder stays on disk, as for any deleted flow. Templates are never replaced or deleted.
- `--check` needs no server. For each flow it verifies that: `flow.json` is valid; every template passes `validateTemplate` and has a unique `id`, and `template` names one of them or the built-in `youtube-video`; each node has a unique name, a lane color and numeric `x` and `y`; every file named in `map`, `skills`, a node's `playbook` and a card image exists inside the flow folder; every playbook parses with `playbookSettings` against the flow's template (settings errors are problems, unknown settings are warnings) and accepts the installer's `lane:` patch; every `routes:` target and every `creates.lane` names a node, and `creates.template` names a manifest template or `youtube-video`; every `skills:` entry has a file in `skills`; and every card names an existing node and template, only sets fields of that template (within their limits), gives images with supported file types and known roles, and names a `youtube` field that is a url field holding a value. It prints one line per flow plus a list of problems, and exits 1 when there are any.

## What was missing, and what was done

(Filled in as each flow is run live: see the sections below.)
