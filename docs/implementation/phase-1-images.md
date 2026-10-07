# Phase 1.5: native image outputs, exact-version editing and gallery adoption

Implementation ticket: [#23](https://github.com/michaelahoff/content-kanban/issues/23). Contracts: [assembled specification](https://github.com/michaelahoff/content-kanban/issues/12#issuecomment-6041712115), [image workflow](https://github.com/michaelahoff/content-kanban/issues/9#issuecomment-6027240938), [durable boundaries](https://github.com/michaelahoff/content-kanban/issues/11#issuecomment-6041085002), [native image contracts](https://github.com/michaelahoff/content-kanban/issues/3#issuecomment-6023782264) and ADR 0001.

Phase 1 remains unreleased. The bounded **real-account** Codex generation and exact-source edit through Frameboard (specification cases 6–7) have **not** run; see [Live account gate](#live-account-gate).

## Hashed image store

`image-files.js` is the only path by which bytes enter `data/images/`: gallery uploads, YouTube thumbnails, native `imageGeneration` results and `register_image` renders. Each write validates the PNG/JPEG/WebP/GIF/AVIF magic bytes and the 20 MB limit, then writes a new read-only file. Schema migration 9 adds `image_versions`, which records each version's SHA-256, size, format and origin. Serving `/images/<id>`, preparing references and saving outputs verify that hash. Mismatched bytes are refused as damaged (HTTP 409) rather than served or sent. Images from before this migration have no recorded hash. They are still served, and their hash is frozen when they are first referenced. No earlier integrity is invented.

## Chat image outputs

`chat_outputs` holds one row per produced image, unique by delivery attempt plus native item ID or `tool:<callId>`. Repeated native events, recovered history and repeated tool calls return the existing output. Each output keeps the following provenance:

- Provider and creation method: `native-image-generation`, or `code-rendered` for registered files.
- Conversation model. The image model is `null` because Codex does not report it.
- Submission and configuration IDs, and the harness version.
- The tool prompt, from the native `revisedPrompt`. The submitted prompt stays on its immutable submission.
- The exact frozen references (ID, hash, labels and source). Chat-version references carry their `outputId`, which is the edit relationship.
- Native thread, turn and item IDs, `savedPath`, status, transparency and failure. Registered renders keep the call ID and source path instead.

Generation and saving are separate states:

- **Completed generation:** the worker imports it asynchronously. The returned base64 is authoritative. A reported `savedPath` is read only if it lies lexically and after link resolution under `<codexHome>/generated_images/` and is a regular, singly linked file (not a symlink). A saved file that is read must match the returned bytes, otherwise the output is treated as damaged. If the notification omitted media, a readable saved file supplies the bytes alone. If returned bytes exist and the reported path cannot be read, the path neither supplies nor rejects those bytes.
  - Missing, damaged, invalid, oversize, linked or escaping bytes record a failed save with an explanation, and nothing is fabricated.
  - **Retry saving** reuses the same output identity. It re-reads that item from native history with read-only `thread/turns/list`, or reads the reported saved file. It never resumes, starts a turn or regenerates.
- **Failed generation** (for example `usageLimitExceeded` with its reset time): saving is not applicable. Only a deliberate new request or the existing explicit submission retry can try again.
- **Restart during a save:** the save is marked failed and stays retryable. Restart reconciliation imports the image items of a matched accepted turn exactly once.

Transcript rows no longer keep the base64 image payload; they record whether a result was returned. Stop, terminal states, gallery removal, fresh context and card deletion leave outputs and their bytes intact. That includes an image completing while interruption is pending, or arriving late after the turn ended. Deleted cards keep readable outputs but reject adoption.

A retained output whose stored file later disappears shows **Image file unavailable**. It keeps its history, provenance and hash, offers no Edit or adoption, and is never regenerated. Failure details follow the installed 0.160.1 schema's `ImageGenerationFailure` (`usageLimitExceeded`, `limitId`, `resetsAt`). Live usage-limit behaviour has not been observed.

## Registered renders

`register_image` resolves a path inside the originating card workspace. It must be a regular, singly linked, non-symlink file whose resolved parents stay inside that workspace, and it is rechecked after reading. Files in `references/` are inputs and cannot be registered. The file is copied and hashed at registration, in the card-tool transaction, as a `code-rendered` output. A path that is only read or mentioned is never an output.

## Exact-version editing

Composer references can name gallery images or this card's saved chat versions, which need not be adopted. **Edit** on an output adds that exact version to the current selections, opens **What will be sent** and keeps every other selection visible and removable.

At queue time, each frozen reference records `source: gallery | chat-output` and its hash. A read-only copy is placed at `references/<hash>.<ext>` in the card workspace, and that path is named in the submitted text so the harness can reference it explicitly. Outputs from that submission link back to the referenced source version; the source version is never overwritten. Attachment and instruction do not prove that the model chose the intended reference. That remains part of the live gate.

## Gallery adoption

**Add to gallery** (`POST /api/cards/:id/chat/outputs/:outputId/adopt`) acts on one saved output and appends that exact version to the card's gallery.

- It never assigns Display, Original or Inspiration, even when Display is empty. Roles are chosen afterward in the editor.
- Repeating it returns `adopted: false` and adds no duplicate.
- It always appends to the current saved gallery, so newer saved changes survive. An unsaved gallery draft lease from any tab makes it refuse (409) until that draft is saved or discarded.
- Each adoption records an `image_adopted` activity entry and its own saved card state.

## Capability disclosure

The composer says that image outputs Codex returns or registers stay in the chat, that native generation through Frameboard has not yet passed live account validation, and that adoption never sets roles. Claude is not offered. A native image tool unavailable on an account or route is reported as an honest failure, with no fallback. Update the disclosure only after the live gate passes.

## Evidence on 2026-10-07

Environment: Node.js 22.17.1, Codex CLI 0.160.1, Chromium (Arch Linux).

- `npm test`: **97 passed, 7 opt-in native checks skipped, 0 failed**. `test/images.test.js` drives the public HTTP API through the controlled native boundary and covers:
  - Verified import and provenance, with no base64 in transcripts and no adoption.
  - The shared hashed store, damaged upload serving and reference refusal.
  - Three outputs with independent, idempotent, role-free adoption that respects draft leases and records a separate saved state.
  - An exact chat-version edit that retains another attachment and links B to A.
  - Save-only retry from native state, with no new send.
  - Damaged, invalid, oversize, symlinked and escaping outputs, plus a usage-limited generation failure.
  - Stop after completion, gallery removal, fresh context, deletion and restart retention.
  - Single import on restart reconciliation.
  - Registered renders: invalid, oversize and reference-copy refusals, and adoption.
  - An image completing while Stop is pending or after the turn ended, and a later missing stored file shown as unavailable without regeneration.
- `npm run test:native`: **7 passed** (the existing credential-free installed gates). A probe confirmed that Codex 0.160.1 neither turns a loopback hosted `image_generation_call` into an `imageGeneration` item nor offers its image tool to the loopback provider. Native generation therefore cannot be exercised credential-free, and no fixture claims it.
- `npm run test:browser`: all existing checks passed in 9 of 11 runs of this change. Two runs aborted after the compact-board reload check with the browser protocol error "Inspected target navigated or closed". Eight later alternating runs of this change and of the unchanged revision all passed. The cause was not isolated, and this change does not alter that flow.
- A collaborative browser smoke check on a temporary data directory with injected native events confirmed:
  - Saved outputs show their provenance.
  - A failed save shows **Retry saving**.
  - **Add to gallery** added one gallery image with Display empty and showed "In gallery".
  - **Edit** checked that exact chat version in **What will be sent**, with its hash in the exact preview.

## Live account gate

The specification requires a bounded real Codex generation and exact-source edit through Frameboard, with the model, configuration, native version and app revision recorded. That has not run, for two reasons:

- The developer's actual Codex home discovers plugins, so Frameboard correctly reports that effective configuration as unavailable and blocks dispatch.
- Seeding a disposable home with copied ChatGPT credentials would read credential files, and token refresh could invalidate the original login.

Running the gate needs an explicit developer choice: either sign in to a dedicated isolated Codex home, or remove or disable the unsupported plugin setup. Until then, Phase 1 daily-use acceptance for native generation remains open.
