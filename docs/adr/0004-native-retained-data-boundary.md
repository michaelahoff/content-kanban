# Native execution runs inside a retained-data process boundary

Amends [ADR 0002](0002-opt-in-inherited-codex-setup.md). Implements [Protect retained data across supported native execution modes](https://github.com/michaelahoff/content-kanban/issues/48) under the approved project-assets specification, acceptance case 23.

Every native harness process tree runs inside one boundary that Frameboard owns, whatever the native permission mode: unprivileged bubblewrap namespaces with a locked read-only host, plus Landlock and seccomp network/IPC controls. Retained data stays read-only, and only card workspaces and native state are writable. Network access goes only through a parent broker to verified public OpenAI HTTPS endpoints. Details and evidence are in [the execution boundary](../implementation/native-retained-protection.md).

- Inherited setup stays the explicit opt-in from ADR 0002 and still does not hold on newly discovered native items. Its local hooks, MCP servers and plugin processes are descendants of the harness, so they run inside the same boundary rather than being held.
- Full native access relaxes only Codex's own sandbox and approvals. It never removes the outer boundary.
- Unproven OS, kernel, harness or provider combinations hold before dispatch, including turns without selected assets. There is no unconfined fallback.

## Considered Options

- **Hold inherited MCP servers, plugins and hooks.** Rejected. It recreates the blocked-by-default machine that ADR 0002 fixed, and the boundary already confines those processes. A native gate proves an inherited hook and MCP server execute without changing retained bytes.
- **Rely on Codex's own sandbox.** Rejected. Approved escalation and Full access remove it.
- **Allow all public network destinations.** Deferred. Local services must stay unreachable, because Frameboard's own HTTP API holds card authority. Wider egress for Full-access commands is a separate product decision.

## Consequences

- This narrows ADR 0002's "card chats can reach anything the native setup can". Local integrations cannot reach private services or non-OpenAI hosts. Remote connectors that OpenAI executes can still act outside Frameboard.
- Native state, such as `CODEX_HOME`, is writable to the confined tree. A command approved for escalation or Full access can change configuration that the user's unconfined Codex reads outside Frameboard. That is outside Frameboard's execution boundary and remains a follow-up.
- Claude stays held until its protected installed-native usability is verified. The broker does not reach Anthropic endpoints.
