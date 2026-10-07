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

The server listens only on this computer (`127.0.0.1`). The only time the app goes online is when you choose **Get title & thumbnail**: the server then asks YouTube for that video's title and thumbnail and saves the thumbnail in `data/images/`. Everything else works offline. Projects, lanes, cards, and history live in the SQLite database `data/frameboard.db`; original images live in `data/images/`. The browser stores the last selected project and whether cards are collapsed.

**Stop the server and back up the whole `data/` directory.** To restore a backup, stop the server, replace `data/` with your backup, and restart. Set `DATA_DIR` to use a different storage location. On the first start with an older `board.json`, the server transfers its board to SQLite in one transaction and keeps the original file as `board.json.migrated`.

Deleting a card hides it from the board while retaining its saved data and history. Removing an image removes its association with the card. Original uploaded files remain in `data/images/`, so deleting cards does not reclaim image storage. This also keeps in-progress uploads and backups from losing files.

Saves use SQLite transactions and check each card's content revision. If another tab saved the same card, your draft stays in memory and other cards can still save. Choose **Review** to open the conflicted card, copy anything you want to keep, then choose **Use saved version** and confirm to discard that card's unsaved changes. You can paste your copied edits into the saved version afterward. Temporary save failures show a retry button. Wait for **All changes saved** before closing the app.

## Development and checks

```sh
npm run dev       # Restart the server when source files change; reload the browser for UI changes
npm test          # Persistence, uploads, validation, concurrent saves, and local access boundaries
npm run test:browser  # End-to-end browser checks; requires Chromium or CHROME_PATH
```

The app uses Node's standard library and plain HTML, CSS, and JavaScript. Browser checks create a temporary workspace and leave your real board untouched.

SQL lives in `store.js`. This keeps persistence behind one boundary; changing database engines may also require changes to asynchronous calls, transactions, and deployment.

Command graphs have a version, typed nodes, node positions, and explicit edges. `public/flow-graph.js` validates graphs and evaluates Set field commands independently of the canvas. Independent branches run in saved node order after their incoming commands complete. The server applies the resulting fields in the same transaction as the move, records the executed node IDs, and increments the content revision once if values changed. The editor preserves newer typing while acknowledging only the fields the flow changed. Set field is the only command type today. LLM/API commands will need execution handlers, credentials and asynchronous run tracking before they can be enabled.

`GET /api/cards/:id` returns the card and its existing history response. `GET /api/events?since=<cursor>` returns the workspace change feed, including content edits, image flags, moves, reordering, and project/lane changes. Both now read the single append-only `activity_log`; the old `card_events` and `workspace_changes` tables remain as migration input and receive no new writes. Each notification identifies its entity and actor; clients refetch that entity or the workspace. Use `eventCursor` from `GET /api/workspace` before loading cards, then consume feed pages in ID order until empty. Feed IDs are independent of card history IDs. Migration preserves old feed IDs and history IDs; unambiguous paired records become one activity entry, and unmatched facts are retained separately. Old entries have no invented historical labels; new entries capture labels when recorded. The current UI reports save conflicts; it does not yet poll this feed for live updates.

Moves save their before/after card snapshots and neighbouring card IDs in `card_moves`, in the same transaction as lane commands. `POST /api/cards/:id/undo-move` accepts `{moveId, revision}`; it checks the latest move and content revision, restores only that move’s field changes, and appends a `move_undone` history event. Snapshots stay in storage after undo as groundwork for a future timeline.


## Phase 1 implementation

[Phase 1 implementation tracker](https://github.com/michaelahoff/content-kanban/issues/18) contains the ordered tickets and dependencies from the [completed specification](https://github.com/michaelahoff/content-kanban/issues/12#issuecomment-6041712115). The first milestone records durable activity and saved card states. Codex chat, native image generation/reference editing, permissions, restart reconciliation, indicators and verified backups remain subsequent requirements; the Phase 1 daily-use release requires all of them.

Schema version 5 copies the available historical facts into the activity log and creates one **history-begins** saved card state for each existing card, including deleted cards. It preserves move-undo snapshots and does not reconstruct unknown earlier card states. Legacy JSON imports get a baseline at their imported state.

New card changes save a complete state (fields, placement, gallery and roles) in the same transaction as the change and its activity. Consecutive manual text saves in one editor group into an **editing session**, keeping its latest saved state. A gap of two minutes, editor closure/switch, another editor/actor or a non-text change ends the group. Moves and their initial Set effects form one saved state; creation, images/roles, bulk prompt replacement, undo and deletion have their own states. Failed writes do not leave activity or checkpoints behind.

`GET /api/cards/:id/states` provides retained saved states, including for deleted cards, as groundwork for later timeline/restoration controls. `PATCH /api/cards/:id` optionally accepts an `editingSessionId` to group manual text saves; the browser generates a separate ID for each editor session. Clients without an ID get separate saved states. `POST /api/cards/:id/editing-session/end` accepts `{editingSessionId}` and closes only that session, including after card deletion. The store's workspace-scoped `activity` read returns recording-time labels and the full activity metadata; the existing event feed response remains compatible.

Full history browsing and card restoration controls are scheduled for Phase 3. Existing Undo last move remains available.
