# Claude gets Frameboard card tools as an SDK-hosted MCP server

Follows [ADR 0007](0007-drop-version-gates-and-claude-lockdown.md) and amends [ADR 0003](0003-lane-playbooks-on-disk.md). After ADR 0007, Claude card chats had native tools but none of Frameboard's, so a manual Claude chat could not edit, propose or register images as a Codex chat can. Claude card chats now get the same card tools as Codex (`read_card`, `edit_fields`, `propose_changes`, `propose_move`, `register_image`), frozen with the configuration and routed to the same `store.protection.tool` authority checks.

- The adapter declares an SDK-hosted MCP server named `frameboard` in Claude Code's `initialize` request (`sdkMcpServers`). Claude Code sends each MCP message to the adapter as an `mcp_message` control request on the existing stream-json stdio, and the adapter answers with the server's JSON-RPC reply. Claude sees the tools as `mcp__frameboard__<name>`.
- A tool call is handled only for the session's current turn, by the subscriber that owns it, exactly as Codex `item/tool/call` requests are. Claude's tool-use ID is the call ID, so a repeated call reuses its receipt.
- The composer's "Allow requested text edits" applies to Claude too.

## Considered Options

- **A separate MCP server process (local HTTP, or a stdio child of Claude Code).** Rejected: the boundary refuses local sockets, which is what keeps Frameboard's API out of reach, and a child process would need its own route back to the store.
- **Lane results only.** Rejected: manual card chats could not edit, propose or register images, unlike Codex.

## Consequences

- ADR 0003's reason that "Claude chats run without native tools" no longer holds. Lane runs still report through their result block, which keeps playbooks provider-independent.

- Changing the Claude tool list changes its configuration ID, so queued Claude work is held and existing conversations need fresh context, as for any guidance change.
