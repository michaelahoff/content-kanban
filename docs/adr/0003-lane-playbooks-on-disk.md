# Lane playbooks are Markdown files on disk, behind one module

Lane command graphs could only set field values. They are replaced by **lane playbooks**: one Markdown file per lane, plus a project map and shared skills, following the "folder system" approach to agents. Any capable agent becomes the right agent for a lane by reading the right files, and work carries between lanes and providers through files rather than provider memory.

- Each flow keeps its documents in `data/flows/<flowId>/`: `MAP.md`, `lanes/*.md` and `skills/*.md`. A card's hand-off notes are `notes.md` in its card workspace. Backups include the folder.
- A playbook's settings block holds `set:` values, applied in the move transaction exactly as Set field commands were, and settings for an agent run: trigger, provider, model, context, conversation and `may_edit` authority. The Markdown body is the agent's instructions.
- A lane run freezes the playbook, map, skills and notes it used into its card chat submission, with their hashes. History never depends on the current files.
- Every lane run attaches all photos in the card gallery, including photos with no image role. `context:` limits text fields; it never removes photos. Original, inspiration and display roles label references without duplicating their images.
- Agents report through a result block in their reply rather than native tools, so Codex and Claude behave identically. Results go through the existing card tool authority checks: only `may_edit` fields apply, everything else becomes a proposal, and moves always wait for the user. Flows stay advisory.

## Why disk, not the database

The user can open, edit and version the files with any tool, including other agents, which is the point of the folder approach. The database would be simpler for a future hosted, multi-user product, so these rules keep a later move cheap:

1. `playbooks.js` is the only module that reads or writes the folder. Moving to a database means rewriting it.
2. Lanes are identified by the `lane:` ID in a playbook's settings, never by file name. Renaming a lane cannot break the link.
3. Every save names the hash it was based on and is refused if the file changed, so the app never overwrites an edit made elsewhere. This maps directly onto a revision number.
4. Documents refer to each other by relative path (`skills/voice.md`).

## Considered options

- **Keep the graph and add an agent node.** Rejected: the graph's structure added nothing an ordered prose playbook cannot say, and editing prompts in canvas side panels is worse than editing a document.
- **Store playbooks in SQLite.** Deferred until hosting, for the reasons above.
- **Native card tools for results.** Rejected for lane runs: Claude chats run without native tools, and one reporting path keeps playbooks provider-independent.

## Consequences

- Creating a card applies `set:` values but never starts an agent; an empty new card has nothing to work on. **Run playbook** starts one deliberately.
- Retired graphs migrate once on startup into `run: off` playbooks with the same `set:` values.
- A result that arrives after the card left the lane is applied only as proposals.
- Lane run results are applied while the reply's attempt is live. A reply recovered after an app restart keeps its text but its result block is not applied; run the playbook again.
