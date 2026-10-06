# Card-selected chat interaction prototype

THROWAWAY — approved interaction direction, not production feature implementation.

Question: How can the selected card’s editor and persistent chat stay usable together while the user works on the board?

Run `npm start` on this prototype branch and open `http://localhost:3000/?prototype=card-chat&variant=C` (or the server’s reported port). The normal board remains at `/`. Alternatively, open `public/card-chat.prototype.html` directly as a self-contained artifact.

## Settled interaction contract

- Choose C: board, open card editor, and separate adjacent chat on a wide screen.
- Clicking a card opens its editor directly, with its single persistent card chat visible by default.
- Hiding chat returns to the existing floating editor modal; showing chat restores the adjacent arrangement. Reuse the real editor’s contents and editing behavior in production; this prototype approximates them.
- Remember hidden chat across cards and app restarts until the user explicitly reopens it.
- Selecting another card switches editor and chat together. It does not interrupt work on the previous card.
- Keep each card’s unsent prompt, reference attachment choices, and view position associated with that card when switching views/cards. Durable recovery is another decision.
- On narrow screens, use Editor / Chat tabs, initially Editor, preserving each view’s state when switching.
- Closing a card returns to the board; background replies continue. Stop is the explicit interruption control.
- Card indicators: blue pulsing glow and elapsed time for Working, green for Done, question mark for Input needed. Pair color with text/symbols; reduced-motion users receive a static working indication.
- Expose background work and pending input both on cards and through a workspace activity control. Activity entries identify their originating card.
- Keep prompt submission, Stop, card-specific approval/input requests, reference/image controls, and selected-output review accessible in the chat surface.
- Agent editing is desired; exact authority, manual acceptance, stale revisions and image adoption are separate decisions.
- Allow chat resizing within the available space without making the editor unusable. Prototype pixel dimensions are illustrative.

## Scenarios to try

1. Initial sample cards demonstrate Working with a timer, Input needed and Done.
2. Type a draft or attach the sample reference, switch cards, and return: the draft/reference stays with its card.
3. Start a simulated reply, switch cards, then Finish other cards: the original card becomes Done with a new-reply marker.
4. Hide chat, close the editor, open another card, then reload: chat stays hidden. Show chat clears that preference.
5. Close a working card and open Activity: its work remains visible and its entry returns to the originating card.
6. Use Editor / Chat tabs in a narrow viewport.
7. Simulate completion and review selected output; the destination card and field are explicit.
8. Resize chat, simulate an image, or Stop a reply. The artifact explores control placement rather than native provider contracts.

## Artifact boundaries

Replies, approvals, images and card mutations are simulated in memory and reset on reload. Only chat visibility is saved, under the isolated `frameboard-prototype-chat-hidden` browser key when storage is available. No provider calls, real files, or backend writes occur. The prototype retains the original A/B alternatives via its bottom switcher and URL parameter as design evidence; C is the selected direction.

## Follow-through in existing decision tickets

- **Define manual acceptance and agent tool authority**: agent edits, input/approval rules and adoption permissions.
- **Choose durable chat, artifact, and recovery boundaries**: indicator aggregation across runs, finished/unread retention, failures and interruption, and reliable timing/state reconstruction across app restarts.
- **Design image generation, editing, and version adoption**: actual image interactions and version roles.

Ticket: https://github.com/michaelahoff/content-kanban/issues/4
