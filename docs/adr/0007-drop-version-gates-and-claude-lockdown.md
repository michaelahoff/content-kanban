# Card chats run the installed harnesses without version gates or a Claude lockdown

Amends [ADR 0002](0002-opt-in-inherited-codex-setup.md) and [ADR 0004](0004-native-retained-data-boundary.md). The developer is the only user and runs these tools directly; gates that demanded revalidation of each installed version, and a Claude that could not act, kept card chats from working.

- **No Codex version gate.** Any installed Codex version can submit. The isolated mode's per-item holds and the frozen-configuration checks are unchanged; a harness upgrade still holds work queued under the old one.
- **Claude runs inside the retained-data boundary like Codex** instead of being held whenever protection is on. Claude Code's `~/.claude.json` is bound beside its home, so its global config and MCP servers load.
- **Claude uses its full native setup and tools**: CLAUDE.md, skills, plugins, hooks and MCP servers, with `--permission-mode bypassPermissions`. Nobody in a card chat can answer a permission prompt; the boundary is the protection, as for Codex Full access.
- **Claude PDFs always go as native documents.** Recorded checks only supply the page limit shown in the warning. Other Library files reach Claude as workspace copies for its tools, as for Codex.
- **The network broker reaches any public HTTP(S) host** on ports 80 and 443. Local and private addresses, including Frameboard's own API, stay unreachable.

## Consequences

- Card chats can reach whatever public services the native setups and their tools can. Retained data stays read-only and card acceptance rules are unchanged.
- Claude tool calls are not individually approved.
