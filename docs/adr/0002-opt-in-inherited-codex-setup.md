# Card chats may opt in to the user's full Codex setup, without isolation

Amends the configuration policy in [#16](https://github.com/michaelahoff/content-kanban/issues/16#issuecomment-6041007114) and [#17](https://github.com/michaelahoff/content-kanban/issues/17#issuecomment-6041470327). Those decisions made every card chat use an isolated Frameboard harness configuration. Any discovered MCP server, plugin/connector or hook whose per-thread exclusion Codex 0.160.1 cannot prove blocked all work. On a normal developer machine (for example one with the `codex_apps` connector server and installed plugins), that blocked every Codex card chat. The same machine's other Codex clients, such as T3 Code, simply run the full native setup.

The Frameboard harness configuration now has an explicit, saved **full Codex setup (not isolated)** mode, off by default:

- Codex loads its own global and project instructions, skills, MCP servers, plugins/connectors and hooks, as it does outside Frameboard. Frameboard adds its card instructions and card tools, and disables nothing.
- The settings page says that connectors can act outside Frameboard and that nothing is isolated for a card.
- The ordinary sandbox/approval baseline, Frameboard's own conversation grants and card acceptance rules are unchanged. Native permission, card mutation authority and image adoption stay separate.
- The frozen snapshot records the mode and the inventory reported at queue time. Newly discovered native items do not hold inherited work, because Codex owns that inventory.
- Changing the mode holds queued work until it is explicitly cancelled or resubmitted. An existing conversation needs the explained empty fresh context, as for any native-option change.

The isolated mode, its gates and its "unavailable" reasons remain the default and are unchanged.

## Considered Options

- **Keep isolation mandatory.** Rejected by the developer. It made Phase 1 unusable, including the required real-account image check, on the developer's actual setup.
- **Disable connectors/plugins in the global Codex configuration.** Rejected because it changes the developer's Codex use outside Frameboard.
- **A separate signed-in Codex home for Frameboard.** Rejected as unnecessary login friction; other clients use the existing sign-in directly.

## Consequences

- In this mode, card chats can reach anything the native setup can, including outward-facing connectors. This is a disclosed choice, not an isolation claim.
- Generated transfer summaries keep their own stricter restriction rules; this mode does not relax them.
