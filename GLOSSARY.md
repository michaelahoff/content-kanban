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
A Markdown file that says what happens when a card enters a lane: values to set at once, and instructions for an agent with the fields it may edit and the Library files it sends. One per lane, identified by the lane's ID in its settings.
_Avoid_: Lane command, command graph, graph prompt

**Project map**:
The Markdown file that describes a project and its lanes. Every lane run reads it first.

**Skill**:
A shared Markdown file of know-how, such as a voice guide, that lane playbooks include by name.

**Lane run**:
One execution of a lane playbook's instructions for one card, triggered by moving the card into an `on-enter` lane or by Run playbook. Returning to the lane starts another run. Creating a card does not start one. A pending run is a request: it sends what is saved when it queues, not what was saved when it was requested.
_Avoid_: Lane graph run

**Lane result**:
The block at the end of a lane run's reply that lists field changes, hand-off notes, an optional proposed move and any finished documents to keep as saved outputs. Fields the playbook may edit apply; everything else becomes a card proposal.

**Hand-off notes**:
A card's `notes.md`, read by every lane run and added to by each one, so work carries across lanes and providers.

**Temporary prompt override**:
A single manual prompt or lane run using a chosen provider or model while retaining the card chat's primary conversation. Its results remain visible in the card chat.

**Result handoff**:
The result and artifact references from a temporary prompt override supplied as additional context to the primary conversation, with their source identified.

**Submission**:
A prompt sent to a card chat, frozen together with its submitted card context, target provider and model, and its authority to edit the card. Manual prompts and lane runs are both submissions.
_Avoid_: Message, job

**Delivery attempt**:
One try at delivering a submission to a native agent. Retrying a failed submission creates a new delivery attempt linked to the earlier one, not a new submission.
_Avoid_: Run, retry

**Submitted card context**:
The card content, image versions and selected Library file versions captured for a particular chat submission. It remains the record of what was sent even when the card changes afterward.

**Card proposal**:
A suggested change to a card that awaits the user's acceptance.

**Image adoption**:
The user's acceptance of an image from a card chat into its card's gallery, distinct from choosing that image's Original, Inspiration, or Display role.

**Image version**:
A particular retained image used as a reference or produced in a card chat. An edited result is a new version that preserves its relationship to the source image.

**Image output**:
An image version produced in a card chat, either by native image generation or by an explicitly registered rendered file, kept with its producing provider, creation method and references. Generation and saving it into Frameboard are tracked separately; neither adopts it.
_Avoid_: Artifact, attachment

**Saved output**:
An exact retained snapshot of something a card chat produced, kept only by an explicit save: reply text saved with Save as document, or a document a lane result declares with its exact text. It records its card chat, conversation, submission, delivery attempt, actual provider and creation method, and keeps the context that was supplied apart from any derivation the agent declared; what is not known stays unknown. Saving is separate from producing it and from any card effect. A stopped, archived or restored attempt cannot save one, though the user can still save its retained text. Saved outputs outlive the card workspace, the card, fresh context and archive. Only the user can publish one in the Project Library, as a separate project asset linked to it by provenance; an agent may only suggest it.
_Avoid_: Artifact, attachment, export

**Project Library**:
A project's collection of project assets, shown in its Library tab beside the board. Selecting assets for prompts is separate from keeping them in the Library.

**Library selection**:
The ordered project assets and asset folders a user explicitly chose for a card chat's manual prompts, or that a lane playbook's `assets:` setting names for its lane runs. It names sources, not versions: each Send captures their current versions and each folder's current files, once per asset with every source that selected it. A manual selection persists across ordinary messages and is cleared by fresh context; a playbook's changes only when its file does. Selected files are reference material; choosing one does not tell the agent to follow it.

**Workspace copy**:
An independent read-only copy of a frozen asset version in a card workspace, the route for files a target cannot take as text or an image. It is rebuilt from the retained original before each delivery, so edits to it never reach the original. It is usable only by a target with a tool that can read it (Codex with its shell tool); delivering one claims nothing about whether the format was interpreted. A Claude PDF route sends a copy's verified bytes as a native document instead.
_Avoid_: Attachment, file upload

**Claude PDF route**:
Sending a selected PDF's exact bytes to Claude as a native document rather than a path. It exists only for a setup (Claude Code version, model, account kind and retained-data protection state) with a recorded passing live PDF check, and Claude may still remove a PDF it cannot process, which stops the attempt.
_Avoid_: PDF support, PDF attachment

**Project asset**:
An uploaded file or explicitly saved document with a stable identity owned by exactly one project. Its filename is a label, not a path; matching names or bytes never merge two assets. Uploading over a taken name requires choosing Create new, Replace or Cancel.
_Avoid_: Attachment, upload

**Asset folder**:
A nested folder in a Project Library with its own stable identity. A name is unique among a folder's live files and subfolders, and different folders may hold the same filename. Renaming or moving a folder or asset keeps its identity and every version.
_Avoid_: Directory, path

**Asset removal**:
Hiding a project asset, or a folder and everything in it, from future selection while keeping every version, historical use and queued reference. A remembered selection of a removed source stays unresolved, even when a new source takes its old name; it is never revived or substituted.
_Avoid_: Deletion

**Asset version**:
One immutable retained content of a project asset. Replace adds a new current version and keeps the older ones. Restoring an older version adds a new current version with its content; it never revives the older version itself. A version whose bytes are missing or damaged is unavailable until repaired with its exact original bytes; it is never silently replaced by other content.

**Project copy**:
A new project asset in another project, made from an asset's current version. It has its own identity, bytes and history, starting at one version, and keeps a link to the version it came from. The source's removal, damage or archive never affects it.
_Avoid_: Linked copy, shared asset

**Document draft**:
The text a user is writing or pasting in the Library's document editor, kept as app data while they type. Only an explicit Save publishes it as an asset version; until then it is never selected, delivered or downloaded as the asset's content. Drafts are included in workspace exports.
_Avoid_: Autosave version, unsaved version

**Card workspace**:
The working files associated with a particular card's agent work.

**Maintenance**:
The pause while a workspace export runs. New changes and dispatch are refused, running work finishes or is explicitly stopped, and queued work waits. Maintenance never cancels queued work or archives projects.

**Workspace export**:
A complete, verified backup folder of every retained app store, published atomically or not at all.
_Avoid_: Snapshot, dump

**Retained data**:
The authoritative bytes Frameboard keeps: original assets, saved outputs, frozen submission history, and the database and authority metadata. Native agents can read retained data but never write it. It is distinct from an image's Original role, and from card workspaces and hand-off notes, which agents may change.
_Avoid_: protected files, app storage

**Retained-data protection hold**:
A hold placed on a submission before any native execution because Frameboard cannot prove that retained data is outside the agent's write authority for the current OS, harness and configuration. It explains what to install or change, and applies even when no assets are selected.

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

**Archived project**:
A project taken out of active use. Archiving cancels its queued and pending work, stops running work and revokes its attempts. Its cards, card chats, history, workspaces and saved outputs stay readable but accept no changes until it is unarchived. Unarchiving restores access, not cancelled work.
_Avoid_: Deleted project

**Revoked attempt**:
A delivery attempt that Stop, project archive or a workspace restore has permanently stripped of authority. Its late native events stay in history, but it can never again change the card, add notes, create proposals or save outputs. A submission revoked by archive or restore also cannot be retried.

**Recovery hold**:
The state a restored workspace starts in, installed once before any worker wakes. Unfinished submissions and pending lane runs are held for review instead of resuming; the old runtime's attempts, approvals and grants confer no authority; bound conversations are not resumed. Archived and cancelled work stays cancelled. Running anything again takes new explicit work.
_Avoid_: Resume, replay

**Card restoration**:
Returning a whole card to an earlier saved card state while preserving intervening activity, conversation history, and image versions.
