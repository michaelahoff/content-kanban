# Frameboard

Frameboard is a content planning board. This glossary records the shared language for its content conversations and history.

## Language

**Card chat**:
A persistent conversation history associated with a single content card. Each card has one card chat, which receives manual and lane graph prompts and retains earlier conversations when fresh context is started.

**Fresh context**:
A new primary agent conversation within a card chat, started by changing its primary provider or explicitly discarding the current working context. Earlier conversations remain in the card chat's history.

**Previous conversation**:
The retained messages and generated versions from a card chat conversation that ended when fresh context was started.

**Transfer summary**:
A summary of a card chat's current conversation, reviewed and optionally edited by the user before being carried into fresh context.

**Graph prompt**:
Instructions defined in a lane command graph for submission to a card chat.

**Lane graph run**:
One execution of a lane's command graph, triggered by creating a card in that lane or moving a card into it. Returning to the lane starts another run.

**Temporary prompt override**:
A single manual or graph prompt using a chosen provider or model while retaining the card chat's primary conversation. Its results remain visible in the card chat.

**Result handoff**:
The result and artifact references from a temporary prompt override supplied as additional context to the primary conversation, with their source identified.

**Submitted card context**:
The card content and image versions captured for a particular chat submission. It remains the record of what was sent even when the card changes afterward.

**Card proposal**:
A suggested change to a card that awaits the user's acceptance.

**Image adoption**:
The user's acceptance of an image from a card chat into its card's gallery, distinct from choosing that image's Original, Inspiration, or Display role.

**Image version**:
A particular retained image used as a reference or produced in a card chat. An edited result is a new version that preserves its relationship to the source image.

**Card workspace**:
The working files associated with a particular card's agent work.

**Activity timeline**:
A chronological history of activity in the content workspace.

**Card restoration**:
Returning a card to an earlier state while preserving the history of intervening activity.
