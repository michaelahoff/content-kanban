# Retained data during native execution

Implementation ticket: [Protect retained data across supported native execution modes](https://github.com/michaelahoff/content-kanban/issues/48). Acceptance authority: the [approved project-assets specification](https://github.com/michaelahoff/content-kanban/blob/f7149d373a8c8284cdd6b046049d6d54a3c35c57/docs/specs/project-assets.md), case 23. This extends the original-preservation gate to all prompts, including those without selected assets.

## Enforcement and authority

The application configures both native adapters before discovery or dispatch. The entire native process tree runs in unprivileged bubblewrap user, mount, PID, network, IPC and UTS namespaces. The host filesystem is a locked read-only bind mount; only independent card workspaces, native conversation state and private temporary directories are writable. Native state must be disjoint from retained storage. Home directories, runtime sockets and temporary host directories are masked, then the application, native state and retained data are bound explicitly. The process receives native sign-in and a small environment allowlist rather than application secrets. Device files are private; capabilities are dropped and no_new_privs forbids privilege gain.

The guard uses Landlock ABI 10+ for network and signal scoping, plus seccomp to prevent pathname UNIX sockets, datagram socketpair reconnection, compatibility syscall escapes and io_uring bypasses. Connection-oriented stream and sequenced-packet socketpairs stay available; Codex uses the latter for MCP stdio. Filesystem Landlock would prevent the nested mounts used by ordinary Codex workspace-write commands. The locked mount boundary permits those inner sandboxes without granting writes to retained storage; the native gate also attempts a nested writable rebind/remount and a `/proc/1/root` escape.

The only network bridge is an inherited pipe to a trusted application broker. It accepts HTTPS connections to `api.openai.com`, `chatgpt.com` and `auth.openai.com`, rejects private/reserved IPv4 destinations, and pins each socket to its resolved address. It exposes no generic host socket, application HTTP authority, private service or proxy environment. IPv6 and other destinations are unproven. Credential-free native tests explicitly inject only their specific model-peer port; production never enables that exception. The bridge confines connectivity; it does not promise account entitlement or every native modality.

Workspace/native-state hard links are rejected before launching and before dispatch; reference copies remain independent. Symlinks resolve under the mount boundary. Protected originals, saved outputs, image bytes, database/WAL, frozen submission history and authority metadata remain on read-only mounts. Mutable notes/workspaces stay writable, while external editors and the trusted application can still edit operational playbooks and publish retained versions.

## Capability holds and permissions

The proven combination is Linux x64, bubblewrap, C compiler/ABI 10 headers, an enabled Landlock ABI 10+ kernel, and Codex 0.160.1. Required controls are never downgraded for missing dependencies or an older/unproven OS. Refresh after correcting an installation or directory problem; a failed boundary setup is retried rather than cached. A harness installed under a masked home or temporary directory, such as an npm global under nvm, launches by its resolved real path. A failed enforced launch probe or external hard link gives an actionable hold; provider Settings preserves discovery errors and existing model catalogs.

The immutable effective configuration records protection status. The worker rediscovers actual configuration after reference preparation and checks protection before dispatch; the adapter checks again at turn/start. Settings and attempt history expose holds. Permission requests explain that Full relaxes Codex's own sandbox/approval policy while preserving the outer retained-data boundary, broker limits and independent card acceptance rules. Once/conversation approvals cannot remove that boundary.

Inherited native configuration remains the explicit opt-in from ADR 0002, with Codex-owned instruction/skill inventory and unchanged mode-switch/fresh-context behavior. It is distinct from Full native access. Inherited MCP servers, plugin processes and hooks are descendants of the harness, so they run inside the same boundary instead of being held. As ADR 0002 records, newly discovered native items still do not hold inherited work. Remote connectors executed by OpenAI can still act outside Frameboard. There is no silent isolated-mode fallback. See [ADR 0004](../adr/0004-native-retained-data-boundary.md). Claude remains held until its installed-native protected usability is verified, even though its tool-disabled transport is retained.

## Evidence

TDD used the native process boundary and public card-chat HTTP endpoints. The first process test failed because the boundary was absent; the asset-free HTTP test initially dispatched despite an unsupported boundary, then passed with an explained hold before native thread opening.

Installed Codex gates complete ordinary, explicitly approved escalation and Full turns against a credential-free Responses peer, verify actual command execution and mutable notes, and independently compare retained asset/output/database/frozen-history bytes after attempted writes, deletions and symlink/hard-link escapes. A quiet inherited configuration also completes without changing its native options. A trusted inherited hook and a stdio MCP server both execute inside the boundary and their attempted writes leave retained bytes unchanged. Integration tests cover inherited action changes during preparation, host HTTP/UNIX/proxy escapes, nested remounts and externally planted hard links. Existing HTTP restart, partial recovery, concurrency and exact native binding tests continue to run through the protected adapter.

Run `npm test`, `npm run test:native` and `npm run test:browser`. Native checks require the supported Linux prerequisites. The injected model peer proves installed protocol/tool usability and enforcement without paid inference; it does not claim subscription-backed model/image entitlement.

A signed-in ChatGPT probe through the protected adapter, with apps, plugins and hooks disabled in a temporary Codex home, passed configuration and reached OpenAI through the broker. The account's usage limit, not the boundary, stopped that turn.

## Known limits

- Native state is writable. A command approved for escalation or Full access can change native configuration that unconfined Codex reads outside Frameboard.
- One writable bind covers all card workspaces, so an agent can change another card's notes and reference copies. Retained data is unaffected.
- Reads are not confined. Agents can read retained data and send it to the verified endpoints.
- Full-access commands reach only the verified OpenAI endpoints. Remote MCP servers on other hosts are unavailable.
