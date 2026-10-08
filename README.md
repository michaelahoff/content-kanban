# Frameboard

A local, image-first kanban board with a black interface. No account, database setup, dependencies, or build step. Requires Node.js 22.13 or newer.

## Run

```sh
npm start
```

Open **http://localhost:3000**. Keep the server running while you use the app. Stop it with `Ctrl+C`; your saved work will be there when you start it again.

To choose another port:

```sh
PORT=3001 npm start
```

## Use

- **Projects:** create projects in the sidebar. Use the menu beside a project's heading to rename or delete it.
- **Lanes:** add lanes, then use each lane's menu to rename it, change its color or position, or delete it. Deleting a lane also deletes its cards after confirmation.
- **Lane colors:** choose from 12 colors, including teal, cyan, orange, red, purple, and lime.
- **Original URL:** paste a YouTube link into **Original URL** at the top of a card, then choose **Get title & thumbnail**. The video's title fills **Original video title** and becomes the card title (if the card doesn't have one yet), and its thumbnail is saved to the card as the **Original** image (and the display image, if the card has none). Fetching again replaces that thumbnail instead of adding a copy. Works with `youtube.com/watch`, `youtu.be`, Shorts, and live links.
- **Cards:** add a card, give it a title, and write in the **Title Options**, **Intro**, **Script**, and **Prompt** fields in the large editor. Changes save automatically.
- **Prompts:** write a prompt for an individual card, or choose **Set prompt** above the board to replace the prompt on every card in the current project. The modal warns how many cards will be updated.
- **Lane commands:** choose the graph icon in a lane’s heading, or **Edit commands** in its settings. The graph starts with **Card enters lane**. Add **Set field** nodes, choose card fields and values in the side panel, and save. The **+** beside **Fields to set** adds another field/value pair to the same node; the **×** beside a row removes it. A node can set several fields together. Rows apply from top to bottom, so the last value wins if the same field appears more than once. New nodes connect after the selected node. Use the output and input circles to make connections; select a connecting line to remove it. Drag node headers to arrange them, or focus a header and use arrow keys. **Arrange** lays out connected commands, and zoom controls help with larger graphs. Deleting a command reconnects its neighbours.
- **Running commands:** connections determine execution order. Commands run when a card is created in the lane (including by pasting images) or moves into it; reordering within the same lane does not run them. Saving a graph leaves cards already in the lane alone. An empty Set field value clears that field. Other fields stay intact, and you can edit the card afterward. Loops, disconnected commands, unknown fields and oversized values are rejected. Removing all commands leaves only the entry trigger and disables the lane’s actions. Existing lane prompt settings become a connected Set field node.
- **Video links:** add a **Published video URL** below Script. The **Original video title** sits at the bottom of the writing panel. Each full HTTP or HTTPS URL has an **Open video** link that opens the webpage in a new tab. These fields save automatically; unfinished URLs are kept as drafts.
- **Last edited:** each card shows its last edit in your local date and time on the board and in the editor. Text edits, image changes, and moving or reordering a card update it; opening a card does not. Older cards show “Last edit not recorded” until their next edit.
- **Images:** paste screenshots or copied image data directly into an open card, drop multiple files, or browse for files. Paste into a focused lane to create a new card. Copying an image address pastes text rather than the image itself.
- **Image flags:** the first upload becomes the card's display image. Choose one image each as **Original** and **Inspiration**; those flags are separate from **Display**. Click an image to see it at a larger size. Removing a flagged image clears that flag; removing the display image selects the next remaining image.
- **Copying:** use **Copy intro** and **Copy script** beside their fields. **Trifecta copy** creates a single PNG containing the prompt first, all titles, the labeled original and inspiration images, and the intro. Paste it into a chat that accepts image attachments to send everything together. The clipboard also contains plain text and formatted HTML; the receiving page decides which formats to use. The PNG includes the written content so an image-only paste still carries everything. The two images are combined, fitted without cropping, and animations become still images. If copying fails or the card is too long to fit, an error is shown instead of silently copying incomplete content.
- **Moving cards:** drag from anywhere on a card, including its image, to move it between lanes or reorder it. An insertion line opens a gap where the card will land: hover over the upper or lower half of a card to place it before or after, or below the cards to append it. Every lane extends to the bottom of the longest lane, so the space below its cards is also a drop target. The lane selector at the top of the editor also moves a card and works with a keyboard or touch screen.
- **Undo last move:** use the button above the board to undo the most recent available move, or the button in a card’s editor for that card. It restores the previous lane and position and reverses fields changed by lane commands, without rerunning commands in the original lane. Later unrelated edits and images stay intact. If a field that needs restoring has since been edited, undo reports a conflict and leaves the card untouched. Undo survives reloads and server restarts. Each card can undo its latest move once; moves made before this feature was added have no undo snapshot.
- **Compact board:** choose **Collapse cards** beside search to show just card titles, then **Expand cards** to restore images and details. Cards still open and drag in the collapsed view. The browser remembers this display preference.
- **Search:** finds cards by title, Original URL, Title Options, Intro, Script, original video title, or published video URL in the current project.

Supports PNG, JPEG, WebP, GIF, and AVIF, up to 20 MB per image and 200 images per card. Uploaded originals are preserved. The board preview crops to fit; the editor and image preview show the full image. Text boxes store plain text.

## Your data

The server listens only on this computer (`127.0.0.1`). Board editing works offline. **Get title & thumbnail** contacts YouTube and saves its thumbnail in `data/images/`. Explicit Codex discovery and chat Send use the installed native harness; inference uses its existing authentication and online access. Projects, lanes, cards, chat/composer state and history live in `data/frameboard.db`; original images live in `data/images/`; card workspaces live in `data/workspaces/<cardId>/`. The browser remembers display preferences and per-card workbench view state.

**Stop the server, then run `npm run backup -- --output backups`.** This creates a timestamped backup with a consistent SQLite snapshot, hash-validated images, card workspaces, a manifest and only this board's relevant native conversation files. To restore, stop the server and run `npm run restore -- --backup backups/<folder> --data-dir restored-data`, then `DATA_DIR=restored-data npm start`. Restore needs a new or empty app directory and never overwrites existing native files. Both commands support `--data-dir` and `--codex-home`. Backups are **history-only; native resume not verified**: global credentials/configuration and Codex's native index are excluded, and missing native history is never replayed. See [backup details and cumulative evidence](docs/implementation/phase-1-backup-release.md).

Set `DATA_DIR` to use a different storage location. On the first start with an older `board.json`, the server transfers its board to SQLite in one transaction and keeps the original file as `board.json.migrated`. One app or backup/restore command may use a data directory at a time; the separate sibling lock database releases its OS lock after a crash.

Deleting a card hides it from the board while retaining its saved data and history. Removing an image removes its association with the card. Uploaded and chat-produced images are immutable, hash-recorded versions in `data/images/`; deleting cards or removing gallery images does not reclaim image storage, so chat history keeps its image versions. Damaged image bytes are refused rather than shown or sent.

Saves use SQLite transactions and check each card's content revision. If another tab saved the same card, your draft stays in memory and other cards can still save. Choose **Review** to open the conflicted card, copy anything you want to keep, then choose **Use saved version** and confirm to discard that card's unsaved changes. You can paste your copied edits into the saved version afterward. Temporary save failures show a retry button. Wait for **All changes saved** before closing the app.

## Development and checks

```sh
npm run dev       # Restart the server when source files change; reload the browser for UI changes
npm test          # Persistence, uploads, validation, concurrent saves, and local access boundaries
npm run test:browser  # End-to-end browser checks; requires Chromium or CHROME_PATH
```

The app uses Node's standard library and plain HTML, CSS, and JavaScript. Browser checks create a temporary workspace and leave your real board untouched.

SQL lives in `store.js` and its `store-chat.js` component. `openStore` keeps persistence behind one public boundary; changing database engines may also require changes to asynchronous calls, transactions, and deployment.

Command graphs have a version, typed nodes, node positions, and explicit edges. `public/flow-graph.js` validates graphs and evaluates Set field commands independently of the canvas. Independent branches run in saved node order after their incoming commands complete. The server applies the resulting fields in the same transaction as the move, records the executed node IDs, and increments the content revision once if values changed. The editor preserves newer typing while acknowledging only the fields the flow changed. Set field is the only command type today. LLM/API commands will need execution handlers, credentials and asynchronous run tracking before they can be enabled.

`GET /api/cards/:id` returns the card and its existing history response. `GET /api/events?since=<cursor>` returns the workspace change feed, including content edits, image flags, moves, reordering, and project/lane changes. Both now read the single append-only `activity_log`; the old `card_events` and `workspace_changes` tables remain as migration input and receive no new writes. Each notification identifies its entity and actor; clients refetch that entity or the workspace. Use `eventCursor` from `GET /api/workspace` before loading cards, then consume feed pages in ID order until empty. Feed IDs are independent of card history IDs. Migration preserves old feed IDs and history IDs; unambiguous paired records become one activity entry, and unmatched facts are retained separately. Old entries have no invented historical labels; new entries capture labels when recorded. `GET /api/stream` serves the same entries as Server-Sent Events. Each entry's ID is its event ID, so a reconnect with `Last-Event-ID` (or `?since=<cursor>`) replays exactly what was missed; a `resync` event asks a client that is too far behind to reload snapshots. Card chats also receive non-durable `delta` events carrying the item's character offset. The board uses the stream for card chat activity and the selected chat; it still reports card save conflicts rather than merging other tabs' board changes live.

Moves save their before/after card snapshots and neighbouring card IDs in `card_moves`, in the same transaction as lane commands. `POST /api/cards/:id/undo-move` accepts `{moveId, revision}`; it checks the latest move and content revision, restores only that move’s field changes, and appends a `move_undone` history event. Snapshots stay in storage after undo as groundwork for a future timeline.


## Phase 1 implementation

[Phase 1 implementation tracker](https://github.com/michaelahoff/content-kanban/issues/18) contains the ordered tickets and dependencies from the [completed specification](https://github.com/michaelahoff/content-kanban/issues/12#issuecomment-6041712115). Codex chat, protected card tools/permissions, native image generation/reference editing, restart reconciliation, activity indicators and history-only backup/restore are implemented. The [cumulative cases 1–12 and native gates](docs/implementation/phase-1-backup-release.md) record the daily-use evidence and its supported configuration limits. Native backup resume is explicitly unverified; Claude, overrides, reviewed transfer and Send graphs/full timeline/restoration remain later phases.

Schema version 5 copies the available historical facts into the activity log and creates one **history-begins** saved card state for each existing card, including deleted cards. It preserves move-undo snapshots and does not reconstruct unknown earlier card states. Legacy JSON imports get a baseline at their imported state.

New card changes save a complete state (fields, placement, gallery and roles) in the same transaction as the change and its activity. Consecutive manual text saves in one editor group into an **editing session**, keeping its latest saved state. A gap of two minutes, editor closure/switch, another editor/actor or a non-text change ends the group. Moves and their initial Set effects form one saved state; creation, images/roles, bulk prompt replacement, undo and deletion have their own states. Failed writes do not leave activity or checkpoints behind.

`GET /api/cards/:id/states` provides retained saved states, including for deleted cards, as groundwork for later timeline/restoration controls. `PATCH /api/cards/:id` optionally accepts an `editingSessionId` to group manual text saves; the browser generates a separate ID for each editor session. Clients without an ID get separate saved states. `POST /api/cards/:id/editing-session/end` accepts `{editingSessionId}` and closes only that session, including after card deletion. The store's workspace-scoped `activity` read returns recording-time labels and the full activity metadata; the existing event feed response remains compatible.

Full history browsing and card restoration controls are scheduled for Phase 3. Existing Undo last move remains available.

### Codex adapter foundation (Phase 1.2)

Open **Codex settings** from the board to save provider guidance and explicitly discover the installed harness. Optional discoveries start unchecked. Opening settings does not start Codex. Unsupported MCP/plugin/hook and native skill selections display their isolation limits. Or choose **Use my full Codex setup (not isolated)** to run card chats with your global instructions, skills, MCP servers, plugins/connectors and hooks, as Codex does elsewhere. Connectors can then act outside Frameboard; sandbox, approvals and card acceptance still apply. See [ADR 0002](docs/adr/0002-opt-in-inherited-codex-setup.md).

`npm run test:native` runs opt-in, credential-free installed Codex protocol/persistence/configuration gates against a local fixture. It does not verify model entitlement. See [implementation evidence and supported boundaries](docs/implementation/phase-1-codex.md).

### Manual workbench and durable queue (Phase 1.3)

Opening a card shows its editor beside **Card chat** on wide screens; narrow screens use **Editor / Chat** tabs. **Hide chat** restores the modal editor and is remembered. Switching, hiding and closing preserve per-card composer/references and keep background work running. Opening a view starts no native conversation.

Choose **Discover**, select an available model, and compose a prompt. Expand **What will be sent** to select labeled saved fields and exact image references; Original/Inspiration start selected, Display is opt-in, duplicate roles attach one image, and legacy Prompt stays out. **Send** freezes those inputs/configuration and atomically clears composer text. Different cards can run independently; follow-ups on one card wait their turn. Earlier submissions expose their original inputs.

**Stop** preserves partial output and invalidates requests. **Start fresh context** retains previous history, resets grants and explicitly cancels queued old work; it waits for acknowledged interruption and starts no native turn until Send. Changed configuration holds queued work until cancel/resubmit, and changed native configuration needs deliberate fresh context. Ambiguous delivery stays held and is never automatically resent.

See [the workbench implementation and evidence](docs/implementation/phase-1-workbench.md) for its original milestone boundary, and [the cumulative release evidence](docs/implementation/phase-1-backup-release.md) for the later card-tool, image, recovery/streaming and backup checks.

### Native images and gallery adoption (Phase 1.5)

Ask for images in a card chat prompt. Codex native image outputs and images Codex registers from its card workspace stay in the chat with their provider, method, tool prompt and exact references. **Add to gallery** adds one version to the card without choosing Display, Original or Inspiration; choose roles afterward in the editor. Adding the same version again does nothing. **Edit** attaches that exact version to the next prompt while keeping your other references. If an image was generated but could not be saved, **Retry saving** imports the same output without asking Codex to generate again. A failed generation or usage limit needs a deliberate new request.

A bounded real-account generation and exact-source edit through Frameboard passed with Codex 0.160.1 and `gpt-6-luna`. See [the image implementation and evidence](docs/implementation/phase-1-images.md).
