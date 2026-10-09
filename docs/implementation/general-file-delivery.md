# General-file delivery through native tool references

Implements [#58](https://github.com/michaelahoff/content-kanban/issues/58) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 15–16, 20 and 22–23 for manual card chat prompts. It builds on [Library selection](library-selection.md) (#56), which already planned text, raster images and Codex workspace copies.

## Routes

Every selected Library file has exactly one route, or Send refuses it by name:

- **Text** (UTF-8, no NUL bytes, at most 8 MB): full labeled text inline, both providers.
- **Raster image** (PNG/JPEG/GIF/WebP): the native image route, both providers.
- **Any other file**, including PDFs, archives, fonts, audio, video, text too large to inline and text that is not valid UTF-8: a **workspace copy** for Codex, read only through its shell tool. Claude has no route.

`submission-inputs.js` `fileFormat()` recognizes common PDF, archive, audio, video and font signatures from a file's first bytes, never its filename. A recognized format stays a file even when it happens to read as text, so a PDF is never inlined as raw text. The format only shapes descriptions and refusals: it claims nothing about whether a model or tool can interpret the file, and no route depends on it.

Text that is not valid UTF-8 is never decoded with replacement characters or a guessed encoding. Codex receives its exact bytes as a copy; Claude refuses it.

## Capability planning against the installed harness

Codex reads a copy only with its shell tool, which the effective configuration can turn off. On the installed Codex 0.160.1, `features.shell_tool = false` removes the `exec_command` tool from the model request (checked against the loopback Responses peer), and `config/read` reports the effective value. Codex discovery now returns `tools: { shell }` from it.

- **Preview and Send.** `planInputs()` takes `fileTools`. Send passes the discovery it just made, so a Codex setup without the shell tool refuses each tool-only file (`capability`) while text and images remain sendable. A preview uses the saved catalog; a catalog saved before this field existed is treated as having the tool, and Send decides.
- **Delivery.** The shell tool can be turned off after queueing. Immediately before sending, `chat-service.js` `assertRoutes()` checks the worker's final discovery: if any frozen copy has no route, the attempt fails naming each such file. Its delivery record marks those files `failed` and the others `not-sent`, all with the reason. Nothing is sent, and the frozen submission is unchanged, so Retry delivers it once the tool is back.
- **Claude** stays tool-disabled. It refuses every file, naming the route that is missing: PDF delivery is not enabled ([#66](https://github.com/michaelahoff/content-kanban/issues/66) gates it), and card chats take no audio or video input. One refused file stops the whole union, including card images; nothing is sent as a bare path.

No route sends Codex `audio`, `localAudio`, document or video input. The researched model catalog is text and image only. Frameboard installs no converter or transcriber, calls no paid API, and does not redesign Claude with tools.

## Copies and preservation

Copies are named by version (`references/library/<versionId>.<ext>`), never by label. `retained-storage.js` `materialize()` streams each copy from the verified original into private staging, checks its hash and size, makes it read-only and renames it over whatever is at the path. The result is a regular file with one link. It is rebuilt before every delivery attempt, so an agent's edit, deletion or symlink in its place never survives into the next delivery. The originals sit outside the writable workspace boundary ([native retained-data protection](native-retained-protection.md)), so no supported mode can change them through the copy or directly.

The agent's message labels each copy with filename, asset/version IDs, SHA-256, size and recognized format. It says Frameboard has not extracted, rendered or transcribed the file and that derivatives belong elsewhere in the workspace.

## Descriptions

`public/library-format.js` `deliveryDescription()` names a route the same way in **What will be sent** and in each attempt's delivery: `full text inline`, `native image`, or `<format> · workspace copy for Codex tools`. Attempt delivery entries now record a copy's format. When a preview includes a copy, it explains that Codex reads copies only with its shell tool, that Frameboard does not extract, render, transcribe or convert them, and that "sent" does not mean read or understood. The Codex and Claude provider descriptions in Settings state the same limits.

## Acceptance evidence

- `node --disable-warning=ExperimentalWarning --test test/submission-inputs.test.js`: format signatures; Codex without the shell tool refuses a file but keeps text and images; Claude names the unproven PDF, audio and video routes while Codex gets copies, never modality inputs.
- `node --disable-warning=ExperimentalWarning --test test/codex-adapter.test.js`: discovery reports the shell tool from `config/read`.
- `node --disable-warning=ExperimentalWarning --test test/chat-library.test.js`:
  - Send refuses a tool-only file by name when Codex has no shell tool.
  - An attempt that lost the shell tool after queueing fails, naming the file, and Retry delivers once the tool is back.
  - A copy that was tampered with, replaced by a symlink or deleted is rebuilt exactly as an independent read-only file before each delivery, and the original still verifies.
  - Latin-1 text is never decoded: Codex reads the exact copy and Claude refuses it.
  - Claude names the PDF route that is not enabled.
- `node --disable-warning=ExperimentalWarning --test test/library.test.js`: delivery descriptions.
- `npm run test:native` (installed Codex 0.160.1, credential-free loopback peer, retained-data protection on). A protected HTTP Send of a real tar archive is read by Codex's own `exec_command`, which extracts a member and returns it to the model peer. The same command tries to overwrite the retained original and its copy: the original is untouched, and the next Send's `sha256sum` sees the rebuilt exact copy. After `features.shell_tool = false`, Send refuses the archive by name. This proves tool usability, not account access or a model's comprehension of any format.
- `npm run test:library-large`: a 2 GiB opaque file through HTTP upload, download, a Send whose delivery materializes a verified exact workspace copy, export and restore. On 2026-10-08 it passed with a peak RSS of 170 MiB.
- `npm run test:browser`: the composer previews a text file and an opaque file by route, with the shell-tool note, and history shows each attempt's route.

Kept deliberately:
- Copies are rewritten in full before each attempt instead of trusting an existing one. That costs one streamed copy per attempt and avoids hashing an agent-writable file before replacing it.
- The shell-tool check covers the one tool a copy needs. Inherited configurations that remove tools some other way are not modeled; the native attempt then fails visibly in the transcript.
- Format recognition covers common signatures only. An unrecognized file is still delivered as a copy, described without a format.
