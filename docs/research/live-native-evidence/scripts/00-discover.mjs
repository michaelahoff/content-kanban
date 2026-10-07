// Discovery only: no model turns.
import { startCodex } from "./codex.mjs";
const codex = startCodex({ log: "/tmp/fb-live-evidence/evidence/00-discover.raw.jsonl" });
const out = {};
out.initialize = await codex.init();
for (const [k, m, p] of [
  ["models", "model/list", { includeHidden: true }],
  ["providerCapabilities", "modelProvider/capabilities/read", {}],
  ["account", "account/read", {}],
  ["rateLimits", "account/rateLimits/read", null],
  ["features", "experimentalFeature/list", {}],
  ["permissionProfiles", "permissionProfile/list", {}],
]) {
  try { out[k] = await codex.request(m, p ?? undefined); } catch (e) { out[k] = { error: e.message, rpc: e.rpc }; }
}
console.log(JSON.stringify(out, null, 1));
await codex.kill("SIGTERM");
