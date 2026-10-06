# Card-selected chat interaction prototype

THROWAWAY — awaiting human reaction, with no approved interaction contract yet.

Question: How can a selected card’s persistent chat stay accessible while the user works on the board and edits the card?

Run `npm start` on this prototype branch and open `http://localhost:3000/?prototype=card-chat&variant=A` (or the server’s reported port). The normal board remains at `/`. Alternatively, open `public/card-chat.prototype.html` directly; it is a self-contained artifact.

## Layout alternatives

- A: Resizable dock; board uses the remaining width, card editing opens separately beside chat.
- B: Overlay drawer; preserves lane widths but covers part of the board.
- C: Compact board, central card writing, separate chat pane.

Use the bottom arrows or Left/Right keys outside text inputs. Layout selection updates the `variant` URL parameter.

## Scenarios to try

1. Type an unsent prompt, attach the sample reference, select another card, then return: prompt and reference stay with their card.
2. Start a simulated reply, switch cards, and press Finish other cards: the original card shows New reply without changing the selected conversation.
3. Simulate Approval needed: the request names its card. Switch away and return; the card badge keeps it visible.
4. Simulate Finish reply, then Review for this card: the review explicitly names the destination and field.
5. Open Edit card; the chat stays outside the editing surface. Collapse/reopen chat; inspect each variant.
6. Drag the pane edge or focus its separator and use Left/Right to resize. On a narrow viewport the chat becomes a full-width surface with Back to board.
7. Simulate connection loss, stop, an image result, or no selection. These illustrate control placement, not provider/recovery semantics.

## Limits

The board is an example populated with three content cards, using the existing app’s palette and card/editor vocabulary. All modifications, drafts, attachments and replies exist only in memory and reset on reload. No provider/model calls, real files, backend writes, or actual images are used. Image capability, approval authority, output acceptance, execution queues, and recovery rules remain other decision tickets. The compact workbench is a candidate interaction, not authorization to replace the existing editor.

## Pending decisions

- Choose a layout or combination.
- Decide whether card click selects chat and Edit opens the editor, replacing today’s click-to-edit behavior.
- Set the desired behavior when selecting another card, collapsing chat, or switching projects while work is running.
- Set initial visibility, width bounds/preferences, editor coexistence, responsive behavior, and activity indicators.

Ticket: https://github.com/michaelahoff/content-kanban/issues/4
