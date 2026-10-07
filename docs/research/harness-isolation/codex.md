# Codex harness isolation: installed 0.160.1 evidence

**Decision boundary:** Keep Codex transfer summaries unavailable in the current shared app-server design. A separate summary thread can exclude local shell/filesystem/image tools without changing the primary thread, but this installed app-server does not expose a complete zero-tool ceiling through its RPC interface. Its restricted summary still receives executable native tools. Selected native skill guidance was not demonstrated either. A prompt saying “do not use tools” would not repair these failures.

## Scope and method

Tested the installed `/usr/bin/codex`, reporting `codex-cli 0.160.1`, on 2026-10-07. Generated its **experimental** JSON schema; the earlier non-experimental evidence omitted important environment and dynamic-tool fields. Consulted matching first-party versioned source and current [official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The [probe](codex/probe.mjs) starts one installed app-server with the default native home and creates primary and summary threads in it. Inference is a **credential-free loopback mock Responses peer**, configured as a custom provider with `requires_openai_auth=false`, no environment key, no bearer token, and no authentication headers. The fixture captures actual model-facing tool registration and injects deterministic benign calls. This is live installed-harness enforcement evidence, **not** subscription-backed inference, a useful real summary, or a model-access test. No model obedience is used as a security assertion. This investigation used zero subscription-backed inference turns.

[Sanitized final results](codex/results.json) retain only fixture sentinels, tool names, event types, configuration key names, counts, and disposable thread identities. Request bodies, headers, account information, global configuration values, skill names/paths, stderr, and full native histories are not persisted. Earlier malformed fixture attempts were corrected before retaining this final capture; the notes in the result identify those corrections. Source/schema downloads and scratch fixtures live outside the Git worktree. No global configuration was changed; no credentials were read, copied, or exported.

## Observed boundaries

### Positive control and the actual tool surface

For `gpt-6-luna`, this installed harness uses Responses Lite. Tool definitions appear in `input` items of type **`additional_tools`**, rather than a top-level `tools` array. Looking only at top-level `tools` incorrectly reports an empty set. Code Mode also exposes a nested tool catalog in the declaration supplied to `functions.exec`.

The primary thread was started with selected developer guidance and one benign dynamic tool, `fb_selected_tool`. Its actual nested catalog includes `apply_patch`, `exec_command`, `view_image`, `write_stdin`, and the selected dynamic tool. The fixture calls the advertised **custom** `exec` tool with `text(await tools.exec_command({cmd:'cat fixture.txt'}))`. Native execution returns the benign file sentinel, and the event stream includes `commandExecution`. This establishes a working tool-registration and execution positive control.

The summary was started in the **same process**, with a different thread identity, `ephemeral:true`, `dynamicTools:[]`, `environments:[]`, `selectedCapabilityRoots:[]`, selected developer guidance, and explicit optional-capability exclusions. Its nested catalog excludes `exec_command`, `apply_patch`, `view_image`, `write_stdin`, and `fb_selected_tool`. Injecting the same custom `exec` call yields a tool output indicating that the nested shell function is unavailable; no `commandExecution` event occurs and the file sentinel is not returned. The model's response is irrelevant to this assertion.

However, the summary still exposes these model-facing tools:

- `functions.exec`, `functions.wait`, and `functions.request_user_input_async`;
- `collaboration.followup_task`, `interrupt_agent`, `list_agents`, `send_message`, `spawn_agent`, and `wait_agent`;
- nested `create_goal`, `get_goal`, `update_goal`, and `clock__curr_time`.

Thus local-environment exclusion works, but the required **zero native tools** boundary fails. The fixture deliberately did not execute collaboration or goal mutations. Their presence is enough to fail the tool-exclusion contract; their broader permissions or cross-thread reach remain untested.

Matching [tool construction source](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/tools/spec_plan.rs) gates shell, apply-patch, and image viewing on available environments. It also builds utilities and model-driven tool surfaces independently. Disabling optional feature flags is not equivalent to a complete capability ceiling.

### A stronger internal ceiling exists, but RPC does not expose it

The versioned [Rust `ToolPolicy`](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/ext/extension-api/src/tool_policy.rs) has `allowed_tools: Some([])`, expressly meaning no tools. It is captured at startup and must be supplied again on resume through the extension API. The generated installed `thread/start`, `thread/resume`, and `turn/start` RPC schemas have no corresponding `allowedTools`/`toolPolicy` parameter. A custom embedding of the Rust extension API would be a different integration decision; it is not an existing Frameboard app-server control.

`selectedCapabilityRoots` selects roots of an execution environment. Its schema does not promise default-deny suppression of user/system configuration, model tools, installed plugins, or hooks. Passing an empty list did not suppress the remaining native tools above. Unknown config keys or invented RPC properties must not be accepted as an enforcement mechanism.

### Primary identity/history remain separate

Full `thread/read(includeTurns:true)` snapshots of the primary immediately before and after the summary and its injected failed shell call are byte-for-byte equal. The primary identity and single retained turn remain unchanged. The summary has a distinct identity. This proves separation for the observed metadata/history and fixture execution; it does not inspect or prove every hidden persisted grant, crash/reconnect scenario, or provider-internal resource.

### Configuration edits and warm resume

`thread/resume` of the already-loaded primary was sent replacement developer instructions and a config override disabling shell. It returned the same thread identity, and the next model request still contained the original selected instruction, excluded the replacement sentinel, and advertised the original nested shell/dynamic tool catalog. Native source [explicitly records running-thread resume overrides as ignored](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server/src/request_processors/thread_processor.rs).

A warm resume must not be used to apply Frameboard harness-configuration changes. Freeze the selected configuration with a submission, keep an active thread's configuration stable, and require a verified boundary before accepting work under an edited selection. A newly started thread is the observed boundary at which `config`, instructions, environments, and dynamic tools were supplied. Cold resume with changed config, unload/reload, restart behavior, replacement of persisted dynamic tools, and preservation of sticky selections across crash/recovery were **not tested**. Until those exact cases are verified, use fresh context for a change rather than claiming an in-place update worked.

## Optional selection: supported controls versus proof

The matching [0.160.1 configuration schema](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/config.schema.json) identifies these native control families. A schema-supported knob is not automatically a verified isolation guarantee.

- **Instructions:** `developerInstructions` is observed in actual inference requests. `project_doc_max_bytes=0` excluded the scratch `AGENTS.md` sentinel. This is exclusion of discovered optional project instruction text, not removal of required native base/system instructions. Global/project/cloud configuration layers can still contribute defaults or managed requirements.
- **Skills:** `skills.config` supports path/name enablement entries, `skills.bundled.enabled` controls bundled skills, `cloud.skills.enabled` controls cloud skills, and `features.skip_host_skill_discovery` controls host discovery. The probe discovered 55 skill entries without persisting their names or paths, then configured an enumerated exclusion set. The requested scratch skill's guidance did **not** reach the summary request, even with explicit `type:'skill'` input. Selected native skill retention is therefore **unverified**. Disabling instruction catalogs is not proof that skill files cannot be read through other capabilities; dynamic additions can also invalidate an enumeration-based exclusion set.
- **Dynamic tools:** `thread/start.dynamicTools` inclusion/exclusion is observed in the actual nested catalog. Supplying `[]` to a new summary excluded the primary fixture dynamic tool. Editing or revoking this set on a loaded primary was not tested, and resume does not expose a dynamic-tools replacement field in the installed schema.
- **Local native tools:** `environments:[]` on summary startup demonstrably removes shell/apply-patch/view-image/write-stdin registration. `read-only` plus approval policy is insufficient for zero-tools: the positive-control primary can still read a benign file. Permission to execute an action and selection of a capability are separate boundaries.
- **MCP:** `mcp_servers.<name>.enabled` and server tool allow/exclusion fields exist. The probe's effective ordinary MCP config contains zero servers, so its disable loop is **not exercised evidence**. Installed-plugin MCP selection, unknown-server fail-closed behavior, server-side grants, and refreshing a live server set remain unverified.
- **Connectors/apps/plugins:** native `apps._default.enabled`, per-app/per-tool settings, plugin enablement, and feature flags exist. Apps and plugins were disabled at **process startup** for this fixture. No authenticated connector or real plugin was exercised, so exact connector/plugin isolation and per-thread narrowing on the production shared process remain unverified. A capability list must not inherit permissions from an account connection.
- **Hooks:** hook feature flags and per-handler state exist, and `notify=[]` excludes the legacy notification command. The fixture disables hooks/plugins/apps at **process startup** and does not register or execute a hook. It does not prove selective command-hook exclusion, inherited user/project/plugin/managed hooks, per-thread hook changes, or trustworthy hook discovery. Tool approvals do not themselves block lifecycle hooks. Read the versioned [hook discovery](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/hooks/src/engine/discovery.rs) and [legacy notify](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/hooks/src/legacy_notify.rs) sources before treating a hook inventory as complete.

Process-start exclusions in this fixture are not a prescription to toggle the production shared app-server's settings around a summary. Such a toggle could affect unrelated cards; it also would not remove the mandatory tools observed here. Only thread-start exclusions and environment removal were tested concurrently with the retained primary.

## Stop, late events, and remaining limits

Both summary turns completed normally. Active summary interruption, delayed events after cancellation, disconnects, and reconnect/recovery were not injected. The protocol carries thread/turn identities, which gives Frameboard routing information, but this is not proof that its nonexistent adapter drops late events or fences side effects. The application must freeze a source checkpoint, correlate summary events to their own delivery attempt, and reject late results after stopping; no native test here establishes that application behavior.

No images, account login, external MCP calls, publishing, destructive tools, or real collaboration mutations were used. No subscription-backed summary was generated. The concrete result is a verified partial environment restriction plus a verified failure of complete native-tool exclusion, with skill/hook/MCP/connector gaps explicitly left unavailable. That is sufficient to reject the current summary shape without implementing a substitute harness.
