# Lane Retry versus Run playbook

Implements [#61](https://github.com/michaelahoff/content-kanban/issues/61) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 4, 11–14 and 24–26. It builds on [Coherent lane run capture](lane-capture.md) (#60).

## Two ways on after a failure

- **Retry** is a new delivery attempt of the same frozen submission. It resends the original prompt, playbook, map, skills and notes snapshots, Library labels, versions and folder membership, target, configuration and authority. It never rereads current files and never reapplies lane-entry `set:` values. It stays one lane run with one submission.
- **Run playbook** is new whole work: a new lane run and submission built from what is saved now. It reruns the whole prompt. It does not continue where the failed run stopped, and it does not apply `set:` values. Earlier failures, field changes, notes, outputs and history stay as they are.

A run that failed before queueing has no submission, so it has no Retry. Fix the problem, then Run playbook.

## Retry eligibility

`store-chat.js` `retryRefusal()` is the single rule. Retry is refused when:

- the work was archived or restored from a backup;
- the submission is not failed or interrupted, is not in the current available conversation, or the card has an active attempt;
- another submission in the conversation has uncertain delivery (new).

The last rule closes a gap. A retried submission keeps its place in the card's queue, so an older failed submission would have been sent ahead of a later uncertain delivery without it being reconciled. A new Send or Run playbook already queues behind it.

The same rule is reported, not re-derived:

- Chat snapshot submissions carry `retryable`. The card chat shows **Retry original submission** only when it is true. A lane submission adds: "Retry resends this lane run exactly as it was sent. To use the current playbook and inputs, choose Run playbook on the card."
- Lane runs carry `retryable`, and `possiblyDelivered` when the agent may have received the submission: its delivery is uncertain, or the user marked an uncertain delivery interrupted.

## Explaining the choice

`public/card-playbook.js` `runGuidance(run)` adds one line under **Last run** in the card's playbook panel:

| Last run | Guidance |
| --- | --- |
| Failed before queueing | Nothing was sent, so there is nothing to retry. Fix the problem, then Run playbook to start new work. |
| Failed, Retry accepted | Retry in the card chat resends this run exactly as it was sent. Run playbook starts a new run with the current playbook, inputs and notes. Earlier notes and card changes stay either way. |
| Failed, no Retry (restored, archived) | Run playbook starts a new run with the current playbook, inputs and notes. |
| Delivery uncertain | The agent may have received this run. Check delivery in the card chat before anything else is sent there; running the playbook again may repeat its work. |
| Reply recovered after a restart | The reply is kept in the card chat, but its result was not applied. Run playbook to start new work. |

When the agent may already have received the failed run, the guidance adds that either choice may repeat its work. Completed, cancelled, pending and held runs show no guidance; a held run's reason already says to Run playbook.

## Unchanged and already enforced

- Departure cancels pending and undelivered lane work. A run that is already running may finish with proposals and permitted notes. Lane authority is tied to the lane entry frozen with the submission, so Retry after the card left and returned applies no fields directly; they become proposals.
- Stop revokes the stopped attempt. Its late events cannot fail, complete or apply a result to the attempt that Retry creates.
- Archive and backup restore revoke the submission, so it has no Retry. Unarchive does not restore it.
- Missing or damaged frozen Library bytes fail the attempt by name. Only exact-byte repair of that version makes Retry deliver; the current version is never substituted.
- A completed reply recovered after a restart keeps its text, applies no result, and is not a failed submission to Retry.

The spec also lists card restoration as a stronger revocation. Frameboard has no card restoration action yet, so there is nothing to wire.

## Acceptance evidence

`node --disable-warning=ExperimentalWarning --test test/lane-retry.test.js`:

- Retry of an older failed lane run is refused while a later delivery in the conversation is uncertain, and history and the lane run report no Retry. After **Mark interrupted**, Retry resends the frozen prompt.
- A run that failed before queueing, and a reply recovered after a restart, report no Retry, and Retry of the recovered reply is refused.
- After a queued failure, with the instructions, model, Library selection, map, skill, notes and an entry field all changed, Retry resends the identical text to the frozen model as a linked attempt of the same submission and run, without reapplying `set:`. Run playbook then sends the current instructions, map, skill, notes, Library file, model and earlier result, without reapplying `set:`. Its failure leaves earlier fields, notes and history intact.
- Retry after leaving and returning to the lane sends the frozen run; its field becomes a proposal, and its notes are kept.
- A lane run with uncertain delivery reports `possiblyDelivered` and no Retry. Run playbook queues new work that is not sent until the delivery is reconciled, and then sends the whole prompt.
- Retry of a lane run whose frozen Library version lost its bytes fails naming the file and sends nothing, even after a newer version exists. Wrong bytes cannot repair it; exact bytes can, and Retry then sends the frozen content.

`node --disable-warning=ExperimentalWarning --test test/restore.test.js`: a failed lane run keeps Retry across a restart but has none in a restored workspace, where Run playbook starts new work.

`npm run test:browser`: a failed lane run shows the Retry versus Run playbook guidance and one Retry button with its lane hint. Retry resends the frozen run, and the guidance and button disappear once it completes. The guidance wording is also checked for a prequeue failure, a recovered reply, uncertain delivery and possible repetition.

Existing evidence still applies: Stop and late callbacks (`test/playbooks.test.js`), archive (`test/archive.test.js`), unresolved sources before queueing (`test/playbook-assets.test.js`) and coherent capture (`test/lane-capture.test.js`).
