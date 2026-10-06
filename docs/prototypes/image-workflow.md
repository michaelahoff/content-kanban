# Image workflow interaction prototype

This is a throwaway planning artifact for **Design image generation, editing, and version adoption**. It asks whether keeping immutable image results in the card chat, then explicitly accepting gallery and role changes, fits the developer's workflow.

Open `public/image-workflow.prototype.html` directly in a browser. No installation, server, account, or build is required. For a local server, run `python3 -m http.server 4189 --directory public`, then open `http://localhost:4189/image-workflow.prototype.html`.

All state is in memory. Images are SVG illustration placeholders. Provider identities, generation, upload, usage limits, import, restart, missing-file recovery, and card restoration are simulated. This artifact does not prove native provider capability or persistence. It makes no production changes.

## Existing decisions honored

- Adjacent editor and card chat on wide screens, Editor/Chat tabs on narrow screens.
- Generated images remain in chat without automatic gallery adoption or image-role assignment.
- Original, Inspiration, and Display are independent roles; an image may hold several.
- Context role selections resolve when sent. Duplicate selected images attach once with all selected role labels; prompt and references freeze per submission.
- The selected native provider never changes silently. A separate explicitly selected Codex image request is a proposed option for a Claude-backed chat.
- Retained images survive card restoration and native conversation history is not rewound.
- Metadata identifies the actual source session/turn/output when known. Conversation model, image model, submitted request, and native image-tool prompt are distinct; unknown native metadata stays unknown.

The current uploader fills Display when empty. That behavior cannot be reused unchanged for generated-image gallery-only adoption because the earlier acceptance decision requires explicit role choices.

## Proposed behavior awaiting human decisions

1. Offer an explicit supporting Codex image run in a Claude-backed chat, while Claude remains primary. Ordinary image Send reports unavailable capability rather than rerouting automatically. Real installation, login, capability and entitlement checks remain prerequisites.
2. Select exact references from the gallery, earlier chat results, or new uploads. Default card-context roles follow the existing prompt-context decision. Edit pins the selected source version and leaves other selected references visible and removable. Every output gets its own identity; reference relationships are distinct from the main edit-source relationship.
3. Offer Add to gallery and Add and choose roles. Role checkboxes start unchecked and show the current holder. Gallery-only adoption preserves all roles, even an empty Display. Already adopted results expose Choose roles without duplicating gallery entries.
4. Retain all generated versions for the lifetime of retained card/chat history; removing an adopted image from the gallery does not erase its chat version. Exact retention/backup/reclamation mechanics belong to the durable-boundaries decision.
5. Retry saving after generation/import failure without requesting a new generation. Usage limits, request failure, interrupted work, and missing files preserve inspectable history and require deliberate follow-through. Missing output files show unavailable state without automatic prompt replay/regeneration.
6. Protect newer gallery/role changes during acceptance. The demo uses a coarse simulated conflict flag; it does not settle merge granularity, revision coordination, or unsaved-editor implementation.

These recommendations have **not** been accepted or resolved. The initial human round asks about explicit Codex image runs, exact references/immutable versions, and gallery/combined-role acceptance. Later rounds must settle retention and removal, entry points for conversational image requests, edit defaults, multiple outputs, explicit result handoff to the primary conversation, and error/reopen expectations as applicable. Live provider proof remains a separate ticket.

## Guided walkthroughs

- **Generate → adopt:** Generate with selected references; finish; adopt only into the gallery; simulate reopening. Existing Original, Inspiration, and Display remain unchanged.
- **Edit → choose roles:** Generate a source; Edit selects it; generate a new version; explicitly adopt that version with Display. The source remains in chat; other roles are preserved.
- **Claude → Codex:** Select Claude; ordinary image send explains unavailable capability; explicitly choose Codex; complete the image. Claude remains primary and the output identifies the separate Codex image session.
- **Failure → retry save:** Generation finishes but saving fails; retry saving the same output; encounter a usage limit on another request; deliberately retry; Stop. Completed images remain.
- **Conflict → restoration:** Newer edits prevent adoption; review current card and accept explicitly; restore the earlier card; simulate a missing result file and recover its same bytes. Generated image history persists throughout.

Free-play controls allow variations outside those walkthroughs. Each action renders the relevant state. Simulation controls are visibly separated from proposed product controls.

## Verification performed

Driven in the T3 collaborative browser, without production tests: all five guided walkthroughs; selected-role resolution, deduplication and frozen references; desktop and narrow layout; missing-file state; request/import separation; primary provider preservation. Check console output and layout after refinements. There is no test suite or database behind this artifact.

## Decision boundaries

This ticket settles user behavior and acceptance scenarios. **Define asynchronous prompt execution in lane graphs** owns scheduling/queue/graph continuation; **Define activity timeline and card restoration behavior** owns restoration interactions; **Choose durable chat, artifact, and recovery boundaries** owns storage/reconciliation, native identities and artifact retention mechanics; **Establish live native chat and image capability evidence** supplies real account/runtime proof. Recommendations here must not imply those decisions or proofs are complete.
