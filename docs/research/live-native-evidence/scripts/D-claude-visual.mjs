// Block D: Claude tool-rendered visual + edited version, imported with provenance. 2 sonnet turns.
import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { openSession, summarizeResult, WORK } from "./claude.mjs";

const LOG = "/tmp/fb-live-evidence/evidence/D-claude-visual.raw.jsonl";
const ART = "/tmp/fb-live-evidence/evidence/artifacts";
const OUT = `${WORK}/visuals`;
mkdirSync(OUT, { recursive: true });
const R = {};
const save = () => writeFileSync("/tmp/fb-live-evidence/evidence/D-summary.json", JSON.stringify(R, null, 1));
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const snapshot = () => Object.fromEntries(readdirSync(OUT).map((f) => [f, statSync(`${OUT}/${f}`).mtimeMs]));

const grants = [];
const canUseTool = async (toolName, input, opts) => {
  const cmd = String(input.command ?? input.file_path ?? "");
  const inScope = toolName === "Bash" ? !/\.\.|~|\/home|\/etc/.test(cmd) : cmd.startsWith(OUT);
  grants.push({ toolName, toolUseID: opts.toolUseID, input: cmd.slice(0, 200), decision: inScope ? "allow" : "deny" });
  return inScope ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Outside the Frameboard scratch visual directory." };
};
const session = randomUUID();
const sess = openSession({ log: LOG, label: "V", options: { sessionId: session, permissionMode: "default", tools: ["Bash", "Read", "Write"], canUseTool } });

// D1: render.
let before = snapshot();
const t1 = await sess.turn(`In ${OUT}, write and run a short Python script using PIL that renders a 256x256 PNG named kite-v1.png: a flat red diamond kite on a cream background, no text. Then Read the PNG to check it, and reply with one sentence.`, randomUUID(), 300000);
const init = sess.messages.find((m) => m.type === "system" && m.subtype === "init");
R.toolsOffered = init?.tools;
R.mcpServers = init?.mcp_servers;
const newFiles = (b) => Object.entries(snapshot()).filter(([f, m]) => b[f] !== m).map(([f]) => f);
function provenance(turn, files) {
  const toolUses = turn.slice.filter((m) => m.type === "assistant").flatMap((m) => m.message.content.filter((b) => b.type === "tool_use").map((b) => ({ toolUseId: b.id, name: b.name, assistantUuid: m.uuid, input: String(b.input.command ?? b.input.file_path ?? "").slice(0, 160) })));
  const imageReads = turn.slice.filter((m) => m.type === "user").flatMap((m) => (Array.isArray(m.message.content) ? m.message.content : []).filter((b) => b.type === "tool_result" && Array.isArray(b.content) && b.content.some((c) => c.type === "image")).map((b) => b.tool_use_id));
  return { files: files.map((f) => { const p = `${OUT}/${f}`; const dest = `${ART}/claude-${f}`; copyFileSync(p, dest); return { file: f, sha256: sha(p), type: execSync(`file -b ${JSON.stringify(p)}`).toString().trim(), importedTo: dest }; }), toolUses, imageReadToolResults: imageReads };
}
R.render = { text: t1.text, models: t1.models, result: summarizeResult(t1.result), ...provenance(t1, newFiles(before)) };
save();

// D2: edit by explicit reference to the imported v1.
before = snapshot();
const t2 = await sess.turn(`Edit ${OUT}/kite-v1.png (sha256 ${R.render.files.find((f) => f.file === "kite-v1.png")?.sha256 ?? "unknown"}): make the kite blue, keep everything else, save as kite-v2.png in the same directory. Do not modify kite-v1.png. Reply with one sentence.`, randomUUID(), 300000);
R.edit = { text: t2.text, models: t2.models, result: summarizeResult(t2.result), ...provenance(t2, newFiles(before)) };
R.v1Unchanged = existsSync(`${OUT}/kite-v1.png`) && sha(`${OUT}/kite-v1.png`) === R.render.files.find((f) => f.file === "kite-v1.png")?.sha256;
R.session = session;
R.grants = grants;
save();
await sess.close();
console.log(JSON.stringify({ ...R, toolsOffered: R.toolsOffered }, null, 1));
process.exit(0);
