# Card chats run the installed harnesses without version gates or a Claude lockdown

Amends [ADR 0002](0002-opt-in-inherited-codex-setup.md) and [ADR 0004](0004-native-retained-data-boundary.md). The developer is the only user and runs these tools directly; gates that demanded revalidation of each installed version, and a Claude that could not act, kept card chats from working.

- **No Codex version gate.** Any installed Codex version can submit. The isolated mode's per-item holds and the frozen-configuration checks are unchanged; a harness upgrade still holds work queued under the old one.
- **Claude runs inside the retained-data boundary like Codex** instead of being held whenever protection is on. Each launch gets a fresh copy of Claude Code's `~/.claude.json` beside its home, so its global config and MCP servers load. A bound file cannot be replaced atomically, and an in-place rewrite interrupted by a stop truncated it in testing, so the real file is never written from inside the boundary; changes Claude makes to it are discarded.
- **Claude uses its full native setup and tools**: CLAUDE.md, skills, plugins, hooks and MCP servers, with `--permission-mode bypassPermissions`. Nobody in a card chat can answer a permission prompt; the boundary is the protection, as for Codex Full access.
- **Claude PDFs always go as native documents.** Recorded checks only supply the page limit shown in the warning. Other Library files reach Claude as workspace copies for its tools, as for Codex.
- **The network broker reaches any public HTTP(S) host** on ports 80 and 443. Local and private addresses, including Frameboard's own API, stay unreachable.

## Considered Options

- **Keep Claude tool-disabled and only lift the hold.** Rejected: the developer uses the tools; a chat that can only suggest text is not the setup they run outside Frameboard.
- **Route Claude permission prompts to a Frameboard approval UI, as Codex escalations are.** Deferred. It needs a permission-prompt bridge and UI; until then any prompt would be denied unanswered, so tools would silently fail.
- **Widen the broker only to Anthropic endpoints.** Rejected: MCP servers and fetch tools need their own hosts. The private-address refusal, not the host list, is what keeps Frameboard's own API unreachable.

## Consequences

- Card chats can reach whatever public services the native setups and their tools can. Retained data stays read-only and card acceptance rules are unchanged.
- Claude tool calls are not individually approved.
- Home is still masked inside the boundary, so tools installed only under home (for example `~/.local/bin`) and SSH are unavailable to both providers.
- Claude still has no Frameboard card tools; it edits card fields through lane results.
- Prompts held before this change keep their frozen reasons. Cancel and resend them.
