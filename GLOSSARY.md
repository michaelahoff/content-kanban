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

**Pending transfer summary**:
A reviewed transfer summary waiting to accompany the first manual prompt to the primary provider in fresh context. It has not yet been sent to the destination conversation.

**Summary source checkpoint**:
The boundary in a retained conversation identifying the messages on which a transfer summary was based. A summary is stale when newer source messages exist beyond that boundary.

**Graph prompt**:
Instructions defined in a lane command graph for submission to a card chat.

**Lane graph run**:
One execution of a lane's command graph, triggered by creating a card in that lane or moving a card into it. Returning to the lane starts another run.

**Temporary prompt override**:
A single manual or graph prompt using a chosen provider or model while retaining the card chat's primary conversation. Its results remain visible in the card chat.

**Result handoff**:
The result and artifact references from a temporary prompt override supplied as additional context to the primary conversation, with their source identified.

**Submission**:
A prompt sent to a card chat, frozen together with its submitted card context, target provider and model, and its authority to edit the card. Manual and graph prompts are both submissions.
_Avoid_: Message, job

**Delivery attempt**:
One try at delivering a submission to a native agent. Retrying a failed submission creates a new delivery attempt linked to the earlier one, not a new submission.
_Avoid_: Run, retry

**Submitted card context**:
The card content and image versions captured for a particular chat submission. It remains the record of what was sent even when the card changes afterward.

**Card proposal**:
A suggested change to a card that awaits the user's acceptance.

**Image adoption**:
The user's acceptance of an image from a card chat into its card's gallery, distinct from choosing that image's Original, Inspiration, or Display role.

**Image version**:
A particular retained image used as a reference or produced in a card chat. An edited result is a new version that preserves its relationship to the source image.

**Image output**:
An image version produced in a card chat, either by native image generation or by an explicitly registered rendered file, kept with its producing provider, creation method and references. Generation and saving it into Frameboard are tracked separately; neither adopts it.
_Avoid_: Artifact, attachment

**Card workspace**:
The working files associated with a particular card's agent work.

**Frameboard harness configuration**:
The instructions, skills, tools, connectors, and hooks selected for a provider across Frameboard's card chats. Selecting a capability is distinct from granting permission for its actions or authority to change a card.

**Summary session**:
A separate conversation with the outgoing provider that summarizes a frozen source from a card chat. It retains selected instructions and skills while excluding action capabilities and leaving the primary conversation unchanged.

**Activity timeline**:
A chronological history of card changes and agent activity in the content workspace, also viewable for an individual card.

**Saved card state**:
A card's saved field values, lane and position, gallery membership, and image roles at a particular point in its history.

**Editing session**:
A run of consecutive manual saves to one card that forms a single saved card state. Other changes, such as agent edits, lane moves, image adoption or restoration, always form their own saved card states.
_Avoid_: Autosave, revision

**Card restoration**:
Returning a whole card to an earlier saved card state while preserving intervening activity, conversation history, and image versions.
