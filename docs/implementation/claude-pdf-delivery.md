# Claude PDF delivery behind a live evidence gate

Implements [#66](https://github.com/michaelahoff/content-kanban/issues/66) against the approved [project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), acceptance cases 15–16, for manual card chat prompts. It builds on [General-file delivery](general-file-delivery.md) (#58), which left Claude with no PDF route.

## Outcome

The route is built, and the live gate passed for Claude Code 2.1.291 on a Claude Pro account for every model it offers. It is still **unavailable in the shipped app**: Frameboard always runs with retained-data protection, and Claude has no configuration proven inside it ([ADR 0004](../adr/0004-native-retained-data-boundary.md)). The evidence was gathered outside protection, so it never matches a protected setup, and Send refuses a selected PDF for Claude with that reason. Claude submissions are held by protection anyway. The route becomes usable only when Claude gets a protected configuration and the gate passes inside it.

## The gate

`claude-pdf-gate.js` `claudePdfRoute()` decides one Claude model's route from `claude-pdf-evidence.json`. A record enables exactly one setup: Claude Code version, resolved model, account kind (`apiProvider`, `subscriptionType`) and retained-data protection state. Anything else is unavailable, with a reason naming what was checked. There is no fallback: no direct paid API or Files API call, no converter, no bare path.

Claude discovery now reports `harness.version` (from `claude --version`, which is skipped inside protection so no native process runs unconfined), `harness.account` (only `apiProvider` and `subscriptionType`, never the email or organization) and, for each model, `pdf: { available, pages, checked }` or `pdf: { available: false, reason }`.

- **Preview and Send.** `planInputs()` sends a PDF to Claude as `method: 'document'` only when the chosen model's discovered route is available, and otherwise refuses it by name (`capability`) with the gate's reason. The whole union stops on one refusal; text or images are never sent without the PDF. Only a file recognized as PDF by its bytes takes this route. A PDF that is entirely valid UTF-8 still goes as text, as decided in #58; real PDFs carry a binary marker line.
- **Delivery.** `chat-service.js` `assertRoutes()` rechecks the worker's final discovery for the frozen model. If the route has gone (a new Claude Code version, another account, protection turned on), the attempt fails before sending, marking the PDF `failed` and every other input `not-sent`. The frozen submission is unchanged, so Retry sends it once the checked setup is back.

## Translation, limits and native errors

`claude-adapter.js` translates a `localDocument` input explicitly: it reads the verified workspace copy, which is rebuilt from the retained original before each attempt, checks its PDF signature and sends the exact bytes as one `{ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } }` block. The message labels the PDF with filename, IDs, hash and size, and says it is attached as a document. It gives no path.

Known limits: each PDF counts base64 encoded toward Claude's 32 MB request limit with the images and text, and the request is blocked above it. Page counts and PDF tokens cannot be estimated without parsing the file, which Frameboard does not do. So every preview with a PDF warns about this and names the model's documented page limit (600 pages, or 100 for the 200K-context Haiku 4.5). The native attempt decides.

Native rejection is the case that matters. The live probes showed that Claude Code 2.1.291 does not report an unprocessable, damaged or over-limit PDF as an error result. It emits a synthetic `is_api_error_message` assistant message ("a document in the conversation could not be processed and was removed"), removes the document and lets the model answer without it, with `is_error: false`. That is a silent subset delivery. The adapter detects the message, interrupts the turn and reports it as `failed`, and the worker records the PDF `failed` with the reason (`input-rejected`), while the other inputs stay `sent`. Any reply text that streamed before the interrupt stays visible in history. It does not count as a completed reply.

## Provenance

The retained original never changes: the document block is built from an independent copy verified against the frozen version. The frozen `context.library` entry records the intended representation (`method: 'document'`, `format: 'pdf'`) with its hash, size and labels. Each attempt's `delivery` records the actual outcome: `sent`, `not-sent`, `failed` with the route reason, or `failed` because Claude removed it. **What will be sent** and history describe the route as `PDF · native Claude document`. Sent means delivered to the harness, not read.

A Claude session opened by this process that has never had a turn now lists no turns instead of reporting its history missing. Without that, Retry after a pre-send failure in a new conversation was held as "Claude session history is unavailable".

## Live gate evidence

`npm run test:claude-pdf` (`scripts/claude-pdf-gate.mjs`) runs the installed Claude Code through Frameboard's own adapter, with tools disabled and protection off, on the signed-in account. For each model with a documented page limit, it:

1. sends a two-page PDF whose random codes exist only as rendered page text, and requires the reply to give both codes in order;
2. sends a PDF the API cannot process, and requires the turn to fail through the native rejection handling above.

`-- --record` writes one record per passing model. On 2026-10-09, Claude Code 2.1.291 on a Claude Pro (`firstParty`) account passed both checks for all eleven offered models: Sonnet 5.5, Opus 5.5, Fable 5.1, Haiku 4.5, Sonnet 5, Opus 5, Fable 5, Opus 4.8, Opus 4.7, Opus 4.6 and Sonnet 4.6. One earlier run failed to select Opus 4.6 ("Couldn't confirm model") and passed on rerun; a failed model is reported and not recorded. Records claim delivery and comprehension of a simple text PDF only, not of scanned, image-only or complex documents.

## Acceptance evidence

- `node --disable-warning=ExperimentalWarning --test test/claude-pdf-gate.test.js`: only an exact version/model/account match enables the route, with its page limit; unprotected evidence never enables a protected setup.
- `node --disable-warning=ExperimentalWarning --test test/submission-inputs.test.js`: an enabled route plans a document and warns about uncounted pages; a disabled one refuses with the gate's reason; an encoded PDF counts toward the 32 MB request; the route carries no other format; Codex still gets a copy.
- `node --disable-warning=ExperimentalWarning --test test/claude-adapter.test.js`: discovery reports version, account kind (no identity) and per-model routes; a PDF becomes a document block of its exact bytes, and bytes that are not a PDF are refused; a synthetic document rejection fails the turn; a session with no turn yet lists none.
- `node --disable-warning=ExperimentalWarning --test test/chat-library.test.js` (stream-json fixture): Claude receives a selected PDF as a native document with frozen representation and delivery; a PDF Claude removes fails the attempt and is recorded as failed; a route lost before delivery fails the attempt naming the PDF, sends nothing, and Retry delivers the frozen PDF once it is back; without evidence Send refuses the PDF for the whole union.
- `npm run test:claude-pdf`: the live gate above.
- `npm run test:browser`: unchanged composer and history flows still pass.
