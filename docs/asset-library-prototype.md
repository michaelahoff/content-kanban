# Disposable asset library / prompt picker prototype

Question: where should the project library live, and how should creators organize,
edit and select its files while composing a card prompt? This is the primary-source
prototype for issue #38, using the settled #35 lifecycle and #37 selection contracts.
It is not production implementation. No design has been accepted yet.

Run `npm run prototype:assets`, then open
`http://localhost:3038/asset-library-prototype.html?variant=A`.
Alternatively, download `public/asset-library-prototype.html` and open it directly;
it is completely self-contained. All mutations and submissions stay in memory.

Use the bottom arrows, or left/right arrow keys outside a field, to compare:

- A: project Library tab, folder tree and thumbnail grid beside a card composer.
- B: board and card chat; Choose assets opens a folder picker from that composer.
- C: persistent library dock below the board/chat, with compact filename rows.

Try selecting Thumbnails and dragging it into the composer. Its References subfolder
is included. Selecting logo.png separately supplies it once, showing both sources.
Add a document, move/rename a source, Send, edit/save it, and inspect the frozen
submission. Restore an old script version and inspect the new current version.
Copy current content to another mock project. Use the edge-case buttons to inspect
folder-local upload conflicts, removed selections, empty folders, missing retained
bytes, and oversized text. A temporary provider override retains selections;
changing the primary target or starting fresh context clears them.

Browser checks verified recursive expansion and selection order, overlapping-folder
deduplication, draft exclusion and explicit saves, frozen queued versions after edits,
the default suffixed collision choice, empty and removed selections, folder drop,
temporary override delivery errors, returning to the primary target, and fresh-context
clearing. All three layouts were inspected. The standalone page also rendered at
728 px and 360 px without console exceptions. These are prototype interaction checks,
not native provider acceptance checks.

Uploads, external folder uploads/drop, write/paste, explicit saves, version history,
rename/move/removal and current-content copies work in this page only. The ZIP seed
is a clearly labeled downloadable fixture, not a real source archive. PNG seeds are
generated thumbnail sketches. Downloads of user-uploaded originals use their actual
bytes. Provider capabilities and the 120 KB text limit are demo fixtures, not native
adapter verification. Send freezes a snapshot without running an agent; failure and
retry controls simulate delivery-attempt history.

This work stays on `prototype/issue-38-asset-library`, outside main. Issue #38 remains
open until live user feedback settles the design. Any eventual implementation must
be written as production code, not promoted from this disposable file.
