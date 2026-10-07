# Claude harness configuration and restricted summary evidence

Resolves the Claude investigation for [Verify harness configuration isolation and restricted summaries](https://github.com/michaelahoff/content-kanban/issues/17), under [Decide inherited harness configuration for card chats](https://github.com/michaelahoff/content-kanban/issues/16#issuecomment-6041007114). Observed 2026-10-07, `/usr/bin/claude` **2.1.291**, `@anthropic-ai/claude-agent-sdk` **0.3.292**, `model: 'sonnet'`. Planning evidence; no Frameboard adapter, queue worker, global configuration changes, credential inspection, real connector actions, or production changes were made.

## Result and gate

A separate native Claude summary succeeded with an empty offered tool list, no MCP servers or connectors, no SDK hook callbacks, and selected developer/skill guidance supplied as ordinary system-prompt text. The original primary session ID and visible transcript were unaffected by that summary. This establishes the local restricted configuration mechanism; it does **not** establish that launching a process is safe under unknown administrator policy.

**Restricted native summaries are unavailable when command-running managed hooks may apply and their absence cannot be established before process launch.** Non-managed `disableAllHooks` does not disable managed hooks. The read-only hook listing is available only after launch; our positive-control SessionStart command already executed before its listing was read. Checking `policyHookCount: 0` afterward is useful environment evidence, never a sufficient preventative gate. No managed-policy configuration was altered or simulated. [Official hook hierarchy and lifecycle](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks); installed `sdk.d.ts`, `SDKControlGetHooksListingResponse.policy`.

## Exact supported controls and observed limits

**Instructions and inherited context.** Set `settingSources: []`; inject selected developer instructions using `systemPrompt: { type: 'custom', prompt: selectedText, snapshot: false }`, or use the documented preset with `append`. The scratch project's unselected CLAUDE.md and project hook were not loaded: the observed memory-file index was empty and project-hook sentinel absent. Instructions conveyed in system prompt are guidance, not permission enforcement. Managed policy and global `~/.claude.json` are independent inputs; this option is not a general process/account isolation boundary. `settings.autoMemoryEnabled: false` excludes auto-memory. [Filesystem-feature and setting-source documentation](https://code.claude.com/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control).

**Skills.** A local plugin supplied two benign skill files. `plugins: [{type: 'local', path}]`, `skills: ['frameboard-selected:selected-guide']`, and `tools: ['Skill', 'Read']` exposed only the selected skill in the model context's skill frontmatter. The selected Skill invocation injected its full guidance. A model-emitted invocation of the unselected skill returned a native error: `Skill frameboard-selected:unselected-guide is not in this session's skills allowlist`, with `is_error: true`. This is tool-result evidence, not the model's assertion of restraint. [Skill-filter result](claude/results/skill-filter.json).

The broad command/init index still listed both plugin skills and some bundled names. It is not the model's effective skill allowlist. More significantly, official docs explicitly permit user `/<name>` dispatch even when the SDK skill list omits that skill; we did not spend another model turn testing slash dispatch. Files also remain reachable through enabled Read/Bash. Therefore a name filter alone does **not** prove complete selected-only skill semantics across every input path. Stage only selected skill assets without unrelated executable plugin components, or block a configuration whose selection cannot be enforced. A separate no-model-turn staged-plugin check retained only the selected plugin command and skill frontmatter and contained no unselected marker; this verifies the staging index, not every invocation path. [Staged selection evidence](claude/results/selected-only-staging.json). Skill-file scripts and frontmatter hooks need separate capability treatment. [Official skills behavior and commands](https://code.claude.com/docs/en/agent-sdk/skills#commands-in-agent-sdk-sessions); installed 0.3.292 `Options.skills` documentation.

**Native tools, MCP and account connectors.** `tools` selects the native base tool list; `tools: []` removes the native tools. MCP servers are a separate input: ordinary primary init offered exactly `Read`, `Skill`, and `mcp__selected__echo` from an explicitly supplied in-process mock server. Select MCP through `mcpServers` and use `strictMcpConfig: true` to exclude other definitions. `settings.disableClaudeAiConnectors: true` excludes account cloud connectors. Independent no-model-turn observations found two inherited account connector servers with empty settings sources alone, zero under strict MCP alone, and zero under the disable-connectors setting alone; names and URLs are deliberately omitted. No real connector was called. Selectively retaining an individual account connector was **not verified**; disable-all support does not imply an account-connector selection UI can promise arbitrary subsets. [Connector-suppression evidence](claude/results/connector-suppression.json); [official inherited-input exclusions](https://code.claude.com/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control).

**Hooks.** Select SDK callback hooks through `options.hooks`, and explicit command hooks through `options.settings.hooks`, keeping filesystem sources excluded. The scratch selected command-hook positive control executed; `disableAllHooks: true` marked it disabled and prevented its marker. Both typed stream-json `get_settings` and `get_hooks_listing` were accepted by this installed CLI without a model turn. The sanitized effective controls are retained in [hook evidence](claude/results/control-hooks.json). These controls exist in the installed SDK protocol types but have no public `Query.getHooksListing()` helper; a production transport must not assume that helper exists.

`disableAllHooks` also does **not** suppress the host's SDK `UserPromptSubmit` callback: after a between-turn flag-settings update, our callback count advanced from two to three. Summary sessions must omit SDK callback hooks explicitly. Passing `hooks: {}` on the summary accomplishes that without changing primary callbacks. Arbitrary callback code could run commands; a deny-all `canUseTool` callback cannot prevent such execution. [Between-turn evidence](claude/results/between-turn-update.json); [official SDK permission sequencing](https://code.claude.com/docs/en/agent-sdk/permissions).

To prevent unrelated account-synced customizations in these tests we also set `settings.syncClaudeAiSkills: false`, `syncClaudeAiPlugins: false`, and `disableBundledSkills: true`. Installed 0.3.292 `Settings` types describe invocation-local sync suppression without deleting global assets. Init continued listing bundled command names; summary tool availability was nevertheless empty. We do not claim the entire mandatory provider context vanished.

## Combined summary configuration and separation

The successful full-guidance summary used this supported shape:

```js
{
  pathToClaudeCodeExecutable: '/usr/bin/claude',
  model: 'sonnet', settingSources: [],
  tools: [], skills: [], plugins: [], agents: undefined,
  strictMcpConfig: true, mcpServers: {}, hooks: {},
  permissionMode: 'default',
  settings: {
    disableClaudeAiConnectors: true,
    disableAllHooks: true,
    syncClaudeAiSkills: false, syncClaudeAiPlugins: false,
    autoMemoryEnabled: false, disableBundledSkills: true
  },
  systemPrompt: {type: 'custom', prompt: selectedInstructionsAndSkillText, snapshot: false}
  // Fresh query(), no resume/continue and no primary grants.
}
```

This retained the selected skill's **full markdown body as nonexecuting text**, while disabling native Skill invocation. A transparent subprocess trace recorded only marker booleans from the actual initialize request: selected developer marker true, complete selected skill body true, unselected marker false, `skills: []`, and no callback hook events. Summary init reported `tools: []`, `mcp_servers: []`; independent MCP status was empty. This covers native shell/filesystem/web/image, Frameboard actions (none registered), connectors and MCP by their absence from the offered surface. It does not rely on obedience. [Full-guidance summary request and output](claude/results/summary-full-guidance.json).

The frozen source was wrapped as data in a `Frozen source: ...` message, not sent verbatim as a native command prompt. A production adapter must retain that framing so a source message beginning `/skill-name` is summarized as source text rather than dispatched. Command names in the native init catalog do not establish that raw slash prompts are safely disabled by `skills: []`; none were dispatched in these summary runs.

The first separate summary left the primary visible transcript at four messages with the same SHA-256 before and after; primary permission mode remained `default`, and its selected callback count remained one. The later full-guidance summary again preserved the then-current primary transcript hash. These are SDK-visible-history checks, not an exhaustive audit of every hidden native storage field or Frameboard grant row. [Primary/summary evidence](claude/results/primary-summary.json).

Interrupted summary events all used the separate summary session ID, ending with native `error_during_execution`; the primary transcript did not contain its cancellation test request. This comparison used the primary after its explicit resume, not the earlier four-message checkpoint. We did not record a separate immediate pre/post cancellation hash or conduct an extended late-event stress test. App delivery-attempt/session fencing is still required; a single successful interrupt is not proof of every cancellation race. [Cancellation evidence](claude/results/cancel-locality.json).

## Between turns, resume and override

For a live ordinary conversation, `setMcpServers({})` removed the selected SDK server, and fresh MCP status/context observations were empty before the next prompt. Installed types warn this method does not remove settings or plugin-owned servers; use explicit isolated origins rather than treating it as a universal reset. No public `setTools`/`setSkills` API was established. `applyFlagSettings` shallow-merges flag-tier settings, and its success must not be confused with verified removal of SDK hooks. Active-turn mutation semantics were not tested: these changes were deliberately made after terminal turn results.

After closing the primary process, a new query with `resume: primaryId`, native tools/skills/plugins/MCP empty, and updated selected system-prompt options returned the **same session ID**, empty effective action surface, and retained earlier visible history. This verifies the narrower restart shape; it does not establish all grant-recovery behavior. [Resume evidence](claude/results/resume.json).

System-prompt snapshots require special handling: default recorded prompts can ignore a different append/custom prompt on resume until compaction. `snapshot: false` is the documented opt-out, used throughout these experiments. This can lose prompt-cache/earlier thinking continuity; it is not authority to silently discard or transplant context. The changed resume instruction was requested, but this run did not trace its initialize bytes separately or prove its model-side precedence. Block unsupported changes or use the agreed fresh-context flow. [Official prompt recording behavior](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#system-prompt-recording); installed 0.3.292 `Options.systemPrompt`.

A temporary override query used an independent destination configuration (`tools: ['Read']`, no Skill/MCP/hooks, different custom prompt) and a new session ID, leaving the primary visible transcript hash unchanged. Its observed offered tools contained only Read. This demonstrates the provider-side separation mechanism, not an implemented Frameboard override router or result handoff. [Override evidence](claude/results/destination-override.json).

Queue snapshots, removed-capability holds, automatic dispatch prevention, durable grant invalidation and retry policy are app-owned decisions. None were implemented or live-verified by this provider probe.

## Reproduction and scope

Scripts are disposable evidence helpers under [claude/scripts](claude/scripts). They use `/tmp/fb-config-claude` for benign project/skill/hook sentinels and raw private observations; do not run them concurrently or reuse sentinel files without a clean scratch directory. Output artifacts resolve relative to the scripts. They never log account values, authorization headers or credentials to committed results. Raw settings, stderr and native transcripts stay outside the repo.

For a new scratch client, install the exact SDK separately: `npm install --prefix /tmp/frameboard-claude-sdk --save-exact @anthropic-ai/claude-agent-sdk@0.3.292`, then export `FRAMEBOARD_CLAUDE_SDK_MODULE=/tmp/frameboard-claude-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`. By default scripts use the prior `/tmp/fb-live-evidence/client` install. Supply the already installed `/usr/bin/claude` 2.1.291 and existing authorized authentication; these helpers do not create or change login state.

Prepare the results directory, then run `probe.mjs init`, `live.mjs`, `control.mjs`, `extra.mjs`, `guidance.mjs`, `staging.mjs` in order. The probe creates its scratch directory tree. Eight top-level small text submissions were used, with no model fallback, no images, one full-guidance instrumentation retest, and no repeated failed model cases. Source material was first-party documentation and installed pinned SDK types, not secondary accounts. [Pinned SDK package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.292). Preserve the managed-policy startup gate and slash-dispatch limitations when interpreting or repeating these tests.
