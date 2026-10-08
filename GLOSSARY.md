# Frameboard

Frameboard is a content planning board. This glossary records the shared language for its content conversations and history.

## Language

**Card chat**:
A persistent conversation history associated with a single content card. Each card has one card chat, which receives manual prompts and lane runs and retains earlier conversations when fresh context is started.

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

**Lane playbook**:
A Markdown file that says what happens when a card enters a lane: values to set at once, and instructions for an agent with the fields it may edit. One per lane, identified by the lane's ID in its settings.
_Avoid_: Lane command, command graph, graph prompt

**Project map**:
The Markdown file that describes a project and its lanes. Every lane run reads it first.

**Skill**:
A shared Markdown file of know-how, such as a voice guide, that lane playbooks include by name.

**Lane run**:
One execution of a lane playbook's instructions for one card, triggered by moving the card into an `on-enter` lane or by Run playbook. A pending run has not yet captured its submitted inputs, and each run has at most one submission. Returning to the lane starts another run. Creating a card does not start one.
_Avoid_: Lane graph run

**Lane result**:
The block at the end of a lane run's reply that lists field changes, hand-off notes, an optional proposed move and explicitly declared outputs to retain as saved snapshots. Field changes outside the playbook's authority and moves require user review; retaining an output does not adopt it into the card or promote it to the project library.

**Hand-off notes**:
A card's `notes.md`, read by every lane run and added to by each one, so work carries across lanes and providers.

**Temporary prompt override**:
A single manual prompt or lane run using a chosen provider or model while retaining the card chat's primary conversation. Its results remain visible in the card chat.

**Result handoff**:
The result and artifact references from a temporary prompt override supplied as additional context to the primary conversation, with their source identified.

**Submission**:
A prompt sent to a card chat, frozen together with its submitted card context, submitted asset context, target provider and model, and its authority to edit the card. Manual prompts and lane runs are both submissions.
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
The instructions, skills, tools, connectors, and hooks selected for a provider across Frameboard's card chats. It is either an isolated selection or, by explicit choice, the provider's full native setup without isolation. Selecting a capability is distinct from granting permission for its actions or authority to change a card.

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

**Playbook asset selection**:
An ordered choice of project assets and asset folders saved for one lane playbook, independent of manual card-chat selections. It identifies reusable sources rather than the asset versions captured for a particular submission.

**Submitted asset context**:
The explicitly selected project asset versions captured as labeled reference material for a particular submission, including the assets expanded from selected folders. It remains the record of those inputs even when the library changes afterward.

**Saved output**:
A finished file or document retained as a snapshot in its originating card chat, with its source conversation and submission identified. Retaining it does not adopt it into the card or make it a project asset.

**Library promotion**:
The user's saving of a result into the project library as a new project asset or a new version of an existing asset, distinct from retaining it in card chat or adopting it into a card.

**Project asset**:
A reusable file or Frameboard-authored document owned by one project and located in one asset folder or at the library root, with an identity that persists across changes to its content. Reusing it in another project requires a separate copy.

**Asset version**:
A particular retained state of a project asset's content. Explicitly saving document changes or replacing uploaded content creates a new version of the same asset.

**Asset folder**:
A named container of project assets and nested asset folders within a project's library. It organizes related reference material that can be selected together for a prompt.

**Asset removal**:
Removing a project asset from future library selection while retaining its versions for queued submissions, history, and derived work.

**Asset restoration**:
Making a retained asset version's content current again by creating a new version of the same project asset, preserving intervening versions.

**Project archive**:
A retained, recoverable project removed from active use, with its assets, conversations, and history preserved and its pending and ongoing work cancelled.

**Unavailable asset version**:
A retained asset version whose original content is missing or damaged. Its identity and historical uses remain intact while submissions requiring that content are blocked.

**Asset repair**:
Recovering an unavailable asset version's exact original content without changing its identity or historical uses. Different content is a replacement version, not a repair.

**Frameboard backup**:
A complete, user-exportable snapshot of Frameboard's stored data, including active and archived projects and their retained content and history.

**Backup restoration**:
Recovering the saved Frameboard workspace from a verified Frameboard backup. It preserves archives and cancellations and does not automatically restart agent work.
