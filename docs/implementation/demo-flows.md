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
- `nodes` are created in order; the first is the start node. Each `playbook` file is a lane playbook whose `lane:` line the installer sets to the created lane's ID. `routes:` and `creates.lane` name lanes **by name** so the files read naturally; the installer leaves them as names, which `resolveRoutes` and `resolveCreates` accept.
- `skills` and `map` are written as they are. `cards` are created after the nodes, each in its named node, with field values and gallery images uploaded from `assets/` (roles: `original`, `inspiration`, or any role key of the template; the first image is the display image).
- Running `node scripts/demo-flows.mjs --base http://127.0.0.1:3000 [--only video-to-blog]` installs the flows; a project with the same name is left alone unless `--replace` is given, which deletes it first. `--check` parses every playbook against its template and reports settings errors without touching a server.

## What was missing, and what was done

(Filled in as each flow is run live: see the sections below.)
