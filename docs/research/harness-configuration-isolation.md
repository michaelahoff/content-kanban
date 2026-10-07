# Harness configuration isolation and restricted summaries

Evidence for [Verify harness configuration isolation and restricted summaries](https://github.com/michaelahoff/content-kanban/issues/17), gathered against the installed native harnesses on 2026-10-07. This is bounded prerequisite investigation for the product specification, not production feature implementation.

The policy is settled in [Decide inherited harness configuration for card chats](https://github.com/michaelahoff/content-kanban/issues/16#issuecomment-6041007114). Earlier ordinary-chat evidence is in [Establish live native chat and image capability evidence](https://github.com/michaelahoff/content-kanban/issues/13#issuecomment-6040301068); ordinary tool use and temporary overrides do not establish restricted-summary enforcement.

## Evidence and scope

- [Codex evidence](harness-isolation/codex.md): installed app-server controls, configuration isolation, separate summary restrictions and native-session effects.
- [Claude evidence](harness-isolation/claude.md): installed CLI/SDK controls, selected guidance, tool and hook restrictions, and separate summary/session effects.

The disposable probes use benign markers and scratch files. No production integration, account login change, credential export, publishing operation, destructive test or image generation is part of this investigation. Native text conversations can persist in the normal provider session stores. Evidence differentiates enforced tool/configuration boundaries from a model's willingness to obey a prompt.

Codex used a credential-free inference fixture and zero subscription-backed turns. Claude used eight small native text submissions with Sonnet, plus inspections that did not submit a model turn. Both providers' result files were reviewed against their claims; JSON parsing, probe-script syntax, local artifact links and evidence assertions were checked before publication.

Support is specific to the configuration shape and installed version tested. A selectable instruction, skill or tool is distinct from an operation grant. Non-executing skill guidance may be retained without enabling its scripts; an executable skill does not acquire action authority in a summary session.

## Result boundary

**Codex:** The installed app-server still exposes tools under the attempted zero-tool summary configuration. The interception fixture uses a credential-free loopback model provider to inspect the installed harness's actual requests and tool dispatcher; it is not subscription-backed inference. Empty top-level `tools` is not an empty capability surface: this model path also uses `additional_tools`. Treat native restricted summaries as unavailable under the tested configuration, and block ordinary selection shapes whose complete exclusions cannot be verified. Warm resume does not establish that changed developer instructions have taken effect.

**Claude:** The bounded local run demonstrates a separate tool-free summary with selected guidance, no connectors or supplied SDK hook callbacks, unchanged primary transcript, and native rejection of an unselected skill in an ordinary chat. That skill filter alone does not establish selected-only availability: the documented explicit slash-command path can bypass it. Ordinary selection must isolate the available skill assets or block that selection shape. Summary guidance is supplied explicitly, with native skills/plugins disabled. Settings hook suppression and SDK callback omission are distinct controls. Managed startup hooks remain a launch-time boundary: a hook listing obtained after initialization cannot prove that no hook has already executed. Do not enable restricted summaries where managed policy cannot be reliably established before launch. Successful local evidence does not authorize running the same shape under unknown managed policy.

The provider files contain the exact tested controls, positive controls, installed versions and unresolved support limits. These results narrow availability; they do not reopen the settled transfer interaction or authorize unrestricted summaries.

## Frameboard-owned behavior is not a native capability

[Choose durable chat, artifact, and recovery boundaries](https://github.com/michaelahoff/content-kanban/issues/11#issuecomment-6041085002) owns the durable submission and delivery-attempt model. The current production `server.js`, `store.js` and lane graph code contain no native chat adapter or submission queue. This evidence therefore does not claim a live Frameboard queue, configuration hold, fresh-context workflow or late-event mutation guard.

The implementation must preserve these already agreed requirements:

1. Freeze the provider/model and exact effective configuration with each queued submission. Optional discovered items begin unchecked. Discovery is not selection.
2. Apply configuration changes between turns. An active attempt keeps its recorded configuration; explicit Stop remains available.
3. Removing a capability holds queued submissions that still enable it. The frozen prompt, context and configuration stay intact. Only explicit cancellation or resubmission authorizes a replacement; a worker must not silently dispatch the earlier configuration.
4. Verify the resumed native session against the recorded effective configuration before dispatch. When the selected boundary cannot be enforced on an existing session, require the already agreed fresh-context flow; do not silently erase or replace its identity.
5. Use the destination provider's selected configuration for a temporary override. Side sessions have their own native bindings and do not copy the primary conversation's broad grants.
6. Generate a transfer summary in a separate outgoing-provider/model session using only the frozen visible-text source, selected instruction/skill guidance and summarization instructions. Disable every tool, connector and command-running hook; model obedience and denied tool permissions are insufficient evidence of a tool-free configuration.
7. Keep summary cancellation and late events attached to that side-session delivery attempt. They cannot mutate or advance the primary conversation, card or graph. Persisted transcript/artifact observations do not authorize card changes.
8. Block unsupported ordinary configurations with a named reason. If the complete summary restriction is unsupported or unverifiable, native summary generation is unavailable; preserve manual summary and no-summary choices without provider, configuration or API fallback.

These are release acceptance obligations, not additional decisions resolved by a scratch client. Native-session observations in the two evidence files establish only the adapter prerequisites they explicitly test.

## Handoff

Use the exact supported and unavailable shapes in the provider evidence when setting acceptance criteria and phases. Retain the live-evidence gates already recorded by the durable-boundaries decision, including backup restore/resume, dynamic tool persistence, missing native state, hard crash behavior and broader concurrency. Do not infer those properties from configuration-isolation tests.
