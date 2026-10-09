# Coherent lane run capture

Implements [#60](https://github.com/michaelahoff/content-kanban/issues/60) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 9–11, 13–15 and 24–26. It builds on [Library selections in lane playbooks](playbook-asset-selection.md) (#59), whose shared preflight lane runs already use. Retry versus Run playbook after failure is [#61](https://github.com/michaelahoff/content-kanban/issues/61).

## Pending is a request

A pending lane run holds no snapshot. When it is ready to queue, `lane-runner.js` reads what is saved then: the playbook's instructions, settings and `assets:`, `MAP.md`, named skills, the card's notes, the card and gallery, and the effective provider and model. A run waiting for an idle card chat before fresh context reads them when the chat frees up, not when it was requested.

Creating a card applies lane-entry `set:` values and starts nothing. An on-enter move or Run playbook requests work.

While a run waits for the card chat, saving its playbook as `run: off`, or as `run: manual` for an on-enter run, cancels it at once. Other edits are read when the chat frees up. Editing never revives a failed or cancelled run.

## Preparing, then committing

Preparation is asynchronous: provider discovery and reading every input's bytes happen outside any database transaction. `chat-service.js` `queueLane()` now takes a `confirm()` callback, called synchronously after those checks and immediately before the commit. The lane runner's `confirm()`:

- closes the run if it is no longer pending in the card's lane (moved, deleted, archived, cancelled);
- prepares again from saved files and compares the playbook, map, skill and notes hashes, the provider and model, and the composed prompt.

`queueLane()` still checks provider settings revision and Library membership, and `store.chats.queueLane()` still checks the card revision, the conversation and that the run is pending, inserting the submission and linking the run in one commit. Dispatch starts from the commit hook.

Any of these refusing with "changed while preparing" makes the runner prepare the run again from what is saved now. A run that changes during three preparations in a row fails, naming what changed, for example `The hand-off notes changed while preparing the lane run. It changed during 3 preparations in a row, so nothing was queued. Run playbook when it is settled.` It has no submission and no Retry.

A playbook turned off during preparation cancels the run with no submission. Archive, departure and restore holds keep cancelling pending runs as before.

## Identity

The submission ID stays `lane-<run id>`, so repeated preparation of one run queues at most once. Run playbook while a run is pending returns that run. Run playbook after it queued is a new run with its own submission.

## Unchanged

- The full input union is still preflighted: a Claude lane with an unsupported gallery photo fails before queueing, naming `image:<id>`, even when its Library text is usable.
- Prequeue failures keep naming each source by identity, with no submission to Retry.
- No new records or tables. Lane runs, submissions and activity entries are already inside the archive, export, restore and recovery fences.

## Acceptance evidence

`node --disable-warning=ExperimentalWarning --test test/lane-capture.test.js`:

- A playbook, map, skill and notes saved during preparation are what is sent; one submission records their hashes.
- A run waiting for fresh context sends the instructions, selection, map, skill, notes, card title, gallery and model saved when the chat frees up.
- `run: manual` and `run: off` cancel a waiting on-enter run while the chat is still busy; turning it back on does not revive it.
- Notes rewritten during every preparation fail the run after three, naming the notes, with nothing queued; Run playbook then starts new work.
- A playbook turned off during preparation cancels the run with no submission.
- Run playbook during preparation reuses the pending run; after queueing it is distinct work with its own submission.
- A card chat model chosen during preparation becomes the target when the playbook names none.
- A Claude lane run with an unsupported gallery photo and usable Library text fails by image identity with no submission.

Existing evidence still applies: departure and undo (`test/playbooks.test.js`), archive during preparation (`test/archive.test.js`), unresolved sources (`test/playbook-assets.test.js`) and restore holds (`test/restore.test.js`).
