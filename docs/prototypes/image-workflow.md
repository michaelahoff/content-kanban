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

## Agreed image workflow

1. **Accepted:** offer a provider choice for a single prompt in either direction: Codex primary → Claude prompt, or Claude primary → Codex prompt. Run the override separately, preserve the original primary conversation, show results in the same card chat, and label the actual source provider/session and creation method. The next ordinary Send uses the primary conversation. Claude can create visuals through available code/rendering/browser tools, including screenshots; no native diffusion image-model capability is assumed. Tools, native sessions and artifact import remain validation prerequisites. See the accompanying Claude artifact research report. Shared snapshot/fork/result-handoff mechanics remain with the existing execution decision; this demo does not claim native cross-provider state transfer.
2. **Accepted:** select exact references from the gallery, earlier chat results, or new uploads. Default card-context roles follow the existing prompt-context decision. Edit adds the exact selected source version to current context/reference selections and leaves other selected references visible and removable. Repeated selection of the same version does not attach duplicate bytes. Every output gets its own identity; reference relationships are distinct from the main edit-source relationship.
3. **Accepted:** offer only Add to gallery in chat. It preserves all roles, even an empty Display. Users select or change Original, Inspiration, and Display afterward in the card editor. There is no combined adoption/role action.
4. **Accepted:** retain all generated versions for the lifetime of retained card/chat history; removing an adopted image from the gallery does not erase its chat version. Exact retention/backup/reclamation mechanics belong to the durable-boundaries decision.
5. **Accepted:** retry saving after generation/import failure without requesting a new generation. Usage limits, request failure, interrupted work, and missing files preserve inspectable history and require deliberate follow-through. Missing output files show unavailable state without automatic prompt replay/regeneration.
6. Protect newer gallery/role changes during acceptance. The demo uses a coarse simulated conflict flag; it does not settle merge granularity, revision coordination, or unsaved-editor implementation.

**Accepted:** ordinary chat requests use the selected agent's available tools, Edit adds its exact source to current selections, multiple outputs are independently adopted, provider overrides work in both directions without replacing primary context, gallery adoption is separate from role selection, versions survive gallery removal/restart/restoration, and saving retry is separate from explicit generation retry. The final shared-understanding confirmation precedes posting the resolution. No production integration or live provider proof is implied.

Requests preserve the submitted prompt, exact reference versions and labels, selected producing provider/conversation model, source conversation/turn/output identities, creation method, timestamps and artifact import status. Preserve provider-reported image model/native-tool prompt when available; keep unknown or not-applicable metadata explicit. A provider capability or filename is not proof of account entitlement, success, or safe import. Do not treat any file the agent reads as a newly created output.

## Guided walkthroughs

- **Generate → adopt:** Generate with selected references; finish; adopt only into the gallery; simulate reopening. Existing Original, Inspiration, and Display remain unchanged.
- **Edit → choose roles:** Generate a source; Edit selects it; generate a new version; add that version to the gallery, then explicitly set Display in the editor. The source remains in chat; other roles are preserved.
- **Codex → Claude prompt:** Choose Claude only for this prompt; import the simulated rendered image; adopt it independently. Codex remains primary. The native provider is Claude and the creation method is rendering.
- **Claude → Codex prompt:** Choose Codex only for this prompt; import a simulated native image output. Claude remains primary. Ordinary subsequent sends use Claude.
- **Multiple outputs:** Return three images; adopt only the second; explicitly choose its Display role in the editor. All three remain in chat with distinct identities.
- **Stop with output:** Receive an image before its reply ends; Stop; adopt the completed image. Stop does not erase completed files.
- **Failure → retry save:** Generation finishes but saving fails; retry saving the same output; encounter a usage limit on another request; deliberately retry; Stop. Completed images remain.
- **Conflict → restoration:** Newer edits prevent adoption; review current card and accept explicitly; restore the earlier card; simulate a missing result file and recover its same bytes. Generated image history persists throughout.

Free-play controls allow variations outside those walkthroughs. Each action renders the relevant state. Simulation controls are visibly separated from proposed product controls.

## Verification performed

Driven in the T3 collaborative browser, without production tests: all eight guided walkthroughs; selected-role resolution, deduplication and frozen references; desktop and narrow layout; missing-file state; request/import separation; both override directions with primary provider preservation; independent adoption of multiple outputs; Stop after a completed image; gallery role choices after adoption. Check console output and layout after refinements. There is no test suite or database behind this artifact.

## Decision boundaries

This ticket settles user behavior and acceptance scenarios. **Define asynchronous prompt execution in lane graphs** owns the shared prompt-override context/fork/handoff/permission rules as well as scheduling/queue/graph continuation; **Define activity timeline and card restoration behavior** owns restoration interactions; **Choose durable chat, artifact, and recovery boundaries** owns storage/reconciliation, native identities and artifact retention mechanics; **Establish live native chat and image capability evidence** supplies real account/runtime proof. Recommendations here must not imply those decisions or proofs are complete.
