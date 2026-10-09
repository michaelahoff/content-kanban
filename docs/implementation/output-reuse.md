# Reusing saved outputs in the same card chat

Implements [#64](https://github.com/michaelahoff/content-kanban/issues/64) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 15–19, 25–26 and refinement 12.A. It builds on [Saved documents and inline lane outputs](saved-outputs.md) (#62). Workspace files and rendered images are [#63](https://github.com/michaelahoff/content-kanban/issues/63); promotion to the Library is [#65](https://github.com/michaelahoff/content-kanban/issues/65).

## Selection

The composer's `selections.savedOutputs` is an ordered list of saved output IDs (at most 200, duplicates collapsed), validated for shape only. Like Library choices, it is kept across ordinary messages and cleared by fresh context and by a primary-provider change (choices made in the same save are kept). Clearing the choice never affects the output: an output saved in an earlier conversation can be chosen again in the new one.

**Use in prompt** beside a saved output in the transcript adds or removes it. Chosen outputs are listed under **What will be sent** as **Saved outputs**, each with Remove; an ID the snapshot no longer knows shows as unavailable until removed. The preview and submitted context show each reused output's creation method, provider, origin submission and conversation, version and hash. `POST …/chat/fresh` now returns the same view as `GET …/chat`, with saved and image outputs, so earlier outputs stay listed to reuse right after fresh context.

## Resolution, preflight and capture

`chat-service.js` `preflight()` is still the one boundary for previews, manual Send and lane runs. After the card images and Library files it calls `store.savedOutputs.resolve(cardId, ids)`:

- an output of this card chat with status `saved` resolves to its exact retained version, filename, hash and size, and where it was saved (conversation, submission, attempt, provider, creation method);
- an unknown ID, another card's output (*Save it to the project Library to reuse it on other cards*) or one that was not saved becomes a `resolve` problem keyed `output:<id>`.

Each resolved output is inspected through `store.savedOutputs.delivery`, the same classification, verified reads and independent copies as Library files (`library.js` `deliverableVersions()`), restricted to retained `output` versions of the card's project. Missing or damaged bytes are an `integrity` problem that says to remove it or save its reply again; nothing else is sent in their place. `planInputs()` then plans the whole union, card images, Library files, reused outputs, against the target, so capability and aggregate limits apply to all of it: an unsupported Claude gallery image still stops a submission whose reused text is usable.

The frozen `context.savedOutputs` records each output's ID, version, project, filename, hash, size, kind, format, method, provenance and, for copies and images, the workspace path `references/outputs/<versionId>.<ext>`. The bytes are the immutable retained version, never copied into the database.

## Order and identity

1. Card images: role choices, then explicit image choices. A chat image output reused with **Edit** stays in this group. One image version is one input with every label that chose it: an adopted chat output chosen explicitly is labeled both `Attachment` and `Chat version`, alongside any role, and keeps its `outputId`.
2. Library files, in selection and relative-path order, deduplicated by asset identity.
3. Reused saved outputs, in selection order, deduplicated by output identity.

Nothing is deduplicated by hash or name: the same bytes uploaded to the Library are a separate input from a gallery image or a saved output.

## Delivery

`deliveryInputs()` sends reused outputs after Library files: text inline through the verified text route, other kinds as independent workspace copies rebuilt before each delivery. The message lists them after Library files under *Reused saved outputs from this card chat*, each labeled with filename, output, version, hash, size and its origin submission and conversation, fenced by version ID, as reference material rather than instructions. `assertRoutes()` covers their copy and PDF routes. Each attempt's `delivery` records an entry per reused output with its `outputId`. Retry resends the frozen version whatever the composer now selects.

A saved output produced from a reply that reused another records it in `supplied` (`kind: 'output'`), separately from any declared derivation.

## Lanes and other cards

Playbook `assets:` remain `asset:<id>` and `folder:<id>` sources; `output:<id>` is a playbook error, and a saved output ID written as `asset:` is unresolved. Cross-card reuse goes through the user's Save to project library (#65).

## Backup and restore

Composer choices and frozen submissions are in the database. `inspectBackupDatabase()` now also requires every frozen reused output to name a retained committed version with its recorded hash and size, so export and restore refuse a bundle whose history would point at missing bytes.

## Acceptance evidence

`node --disable-warning=ExperimentalWarning --test test/output-reuse.test.js`:

- A saved document from a previous conversation of the same card is sent to Codex as its exact full text and version, after the prompt and labeled as reference material, with per-attempt delivery; the card's gallery and the Library are unchanged; a revision saved from that reply lists it as supplied, with derivation unknown.
- Another card's output and an unknown ID block preview and Send by identity and queue nothing; ordinary messages keep the choice; fresh context and a provider change clear it.
- An adopted chat image output that is also the Original is sent once labeled `Original, Attachment, Chat version`; the same bytes in the Library stay a separate input; a repeated output is one choice; delivery order is card image, Library file, reused output.
- Retry after the choice changes and a restart resends the frozen output; damaged saved bytes block a new Send as an `integrity` problem.
- Tool-disabled Claude receives a Codex-saved output's actual text in fresh context; an unsupported gallery image stops the whole union.
- Export and restore keep the choice and the frozen reused output; a frozen reference to a missing output version fails export.
- A lane playbook cannot select a saved output.

`npm run test:browser`: **Use in prompt** on a saved document lists it in the composer and preview, Send delivers it, and the attempt records `full text inline · sent`.

## Review

Parallel code review (Standards and Spec axes). Fixed:

- `POST …/chat/fresh` returned the bare chat snapshot, so earlier saved outputs, and their **Use in prompt**, disappeared from the transcript until the next refresh (observed failing first). Both routes now share one chat view.
- The selection, frozen field and delivery reads were named `outputs` and `store.library.outputs`, colliding with image outputs and placing saved outputs under the Library. They are `selections.savedOutputs`, `context.savedOutputs` and `store.savedOutputs.delivery`; `library.js` exports `deliverableVersions()`, which takes its kind's noun.
- The saved output prompt entry duplicated the Library one and had dropped its "has not checked that this format can be interpreted" statement; both now share `referenceEntry()`.
- Damaged saved bytes now say how to proceed. Previews and history show where a reused output was saved.
- The glossary's submitted card context includes reused saved outputs.

Kept deliberately:

- Fresh context and a primary-provider change clear reuse choices, like Library choices: manual reference choices belong to the conversation they were made in. The outputs themselves stay selectable.
- Send does not re-resolve saved outputs at commit, as it does Library files: a saved output version never changes, and the composer revision check refuses a changed choice.
- A gallery image and a saved output are deduplicated when they are the same image version, which today means a chat image output (`selections.images`). When #63 adds saved image files, a saved output whose bytes are an independent retained version stays a separate input, as the specification requires; one naming a gallery image version must join the image group.
- That promoted assets stay separate is not yet tested; promotion is #65. Nothing compares hashes or names.
