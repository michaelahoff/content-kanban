# Frameboard

A local, image-first kanban board with a black interface. No account, database setup, dependencies, or build step. Requires Node.js 22 or newer.

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
- **Video links:** add a **Published video URL** below Script. The **Original video title** sits at the bottom of the writing panel. Each full HTTP or HTTPS URL has an **Open video** link that opens the webpage in a new tab. These fields save automatically; unfinished URLs are kept as drafts.
- **Last edited:** each card shows its last edit in your local date and time on the board and in the editor. Text edits, image changes, and moving or reordering a card update it; opening a card does not. Older cards show “Last edit not recorded” until their next edit.
- **Images:** paste screenshots or copied image data directly into an open card, drop multiple files, or browse for files. Paste into a focused lane to create a new card. Copying an image address pastes text rather than the image itself.
- **Image flags:** the first upload becomes the card's display image. Choose one image each as **Original** and **Inspiration**; those flags are separate from **Display**. Click an image to see it at a larger size. Removing a flagged image clears that flag; removing the display image selects the next remaining image.
- **Copying:** use **Copy intro** and **Copy script** beside their fields. **Trifecta copy** creates a single PNG containing the prompt first, all titles, the labeled original and inspiration images, and the intro. Paste it into a chat that accepts image attachments to send everything together. The clipboard also contains plain text and formatted HTML; the receiving page decides which formats to use. The PNG includes the written content so an image-only paste still carries everything. The two images are combined, fitted without cropping, and animations become still images. If copying fails or the card is too long to fit, an error is shown instead of silently copying incomplete content.
- **Moving cards:** drag cards between lanes or drop them above another card to reorder. The lane selector at the top of the editor also moves a card and works with a keyboard or touch screen.
- **Search:** finds cards by title, Original URL, Title Options, Intro, Script, original video title, or published video URL in the current project.

Supports PNG, JPEG, WebP, GIF, and AVIF, up to 20 MB per image and 200 images per card. Uploaded originals are preserved. The board preview crops to fit; the editor and image preview show the full image. Text boxes store plain text.

## Your data

The server listens only on this computer (`127.0.0.1`). The only time the app goes online is when you choose **Get title & thumbnail**: the server then asks YouTube for that video's title and thumbnail and saves the thumbnail in `data/images/`. Everything else works offline. All project and card text lives in `data/board.json`; original images live in `data/images/`. The browser only stores the last selected project.

**Back up the whole `data/` directory.** To restore a backup, stop the server, replace `data/` with your backup, and restart. Set `DATA_DIR` to use a different storage location.

Removing a card or image removes it from the board. Original uploaded files remain in `data/images/`, so deleting cards does not reclaim image storage. This also keeps in-progress uploads and backups from losing files.

Saves use an atomic file replacement. A second tab cannot silently overwrite a newer saved board; if a conflict appears, copy any unsaved text before reloading that tab. If a save fails, the page keeps the edits in memory and shows a retry button. Wait for **All changes saved** before closing the app.

## Development and checks

```sh
npm run dev       # Restart the server when source files change; reload the browser for UI changes
npm test          # Persistence, uploads, validation, concurrent saves, and local access boundaries
npm run test:browser  # End-to-end browser checks; requires Chromium or CHROME_PATH
```

The app uses Node's standard library and plain HTML, CSS, and JavaScript. Browser checks create a temporary workspace and leave your real board untouched.
