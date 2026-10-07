// Block B: native Codex image generation and explicit-reference edit. 2 image ops (+1 retry max).
import { writeFileSync, mkdirSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { startCodex, runTurn } from "./codex.mjs";

const LOG = "/tmp/fb-live-evidence/evidence/B-codex-images.raw.jsonl";
const ART = "/tmp/fb-live-evidence/evidence/artifacts";
mkdirSync(ART, { recursive: true });
const MODEL = process.env.MODEL ?? "gpt-6-luna";
const R = { model: MODEL };
const save = () => writeFileSync("/tmp/fb-live-evidence/evidence/B-summary.json", JSON.stringify(R, null, 1));
const text = (s) => [{ type: "text", text: s, text_elements: [] }];
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function imageItems(events) {
  return events.filter((e) => e.method === "item/completed" && e.params.item.type === "imageGeneration").map((e) => e.params.item);
}
function describe(item, label) {
  const out = { label, id: item.id, status: item.status, savedPath: item.savedPath, revisedPrompt: item.revisedPrompt, transparentBackground: item.transparentBackground, failure: item.failure, resultChars: item.result?.length ?? 0 };
  let bytes = null;
  if (item.savedPath && existsSync(item.savedPath)) bytes = readFileSync(item.savedPath);
  else if (item.result) { try { bytes = Buffer.from(item.result, "base64"); out.fromResultBytes = true; } catch {} }
  if (bytes) {
    const dest = `${ART}/${label}.png`;
    writeFileSync(dest, bytes);
    out.copiedTo = dest;
    out.bytes = bytes.length;
    out.sha256 = sha(bytes);
    out.file = execSync(`file -b ${JSON.stringify(dest)}`).toString().trim();
    if (item.result) out.resultMatchesSavedFile = sha(Buffer.from(item.result, "base64")) === out.sha256;
  }
  return out;
}

let codex = startCodex({ log: LOG, onServerRequest: () => ({ decision: "decline" }) });
await codex.init();
const th = await codex.request("thread/start", { model: MODEL, cwd: "/tmp/fb-live-evidence/work", sandbox: "read-only", approvalPolicy: "on-request" });
const C = th.thread.id;
R.thread = C;

// B1: generate.
const g = await runTurn(codex, { threadId: C, clientUserMessageId: "fb-C-1", effort: "low",
  input: text("Use your image generation tool to create one small flat illustration: a red paper kite on a plain cream background. No text in the image. Then reply with one short sentence.") }, { timeoutMs: 400000 });
R.generate = { turnId: g.turnId, status: g.completed.turn.status, error: g.completed.turn.error, text: g.text, itemTypes: g.events.filter((e) => e.method === "item/completed").map((e) => e.params.item.type), images: imageItems(g.events).map((it, i) => describe(it, `v1-generated-${i}`)) };
save();
const v1 = R.generate.images.find((x) => x.copiedTo);
if (!v1) { console.log(JSON.stringify(R, null, 1)); await codex.kill("SIGTERM"); process.exit(0); }

// B2: edit using the exact generated version as an explicit reference.
const e = await runTurn(codex, { threadId: C, clientUserMessageId: "fb-C-2", effort: "low",
  input: [...text("Edit the attached reference image (Frameboard version v1): make the kite blue and keep the composition and background the same. Use your image generation tool. Reply with one short sentence."), { type: "localImage", path: v1.copiedTo }] }, { timeoutMs: 400000 });
R.edit = { turnId: e.turnId, status: e.completed.turn.status, error: e.completed.turn.error, text: e.text, referenceSha256: v1.sha256, itemTypes: e.events.filter((x) => x.method === "item/completed").map((x) => x.params.item.type), images: imageItems(e.events).map((it, i) => describe(it, `v2-edited-${i}`)) };
save();

// B3: restart, then read native thread state for both versions.
await codex.kill();
codex = startCodex({ log: LOG });
await codex.init();
const rd = await codex.request("thread/read", { threadId: C, includeTurns: true });
const items = (rd.thread.turns ?? []).flatMap((t) => (t.items ?? []).map((i) => ({ turn: t.id, ...i })));
R.afterRestart = {
  turns: rd.thread.turns?.map((t) => ({ id: t.id, status: t.status })),
  imageItems: items.filter((i) => i.type === "imageGeneration").map((i) => ({ turn: i.turn, id: i.id, status: i.status, savedPath: i.savedPath, savedPathExists: !!i.savedPath && existsSync(i.savedPath), resultChars: i.result?.length ?? 0, resultSha256: i.result ? sha(Buffer.from(i.result, "base64")) : null })),
  userImageInputs: items.filter((i) => i.type === "userMessage").flatMap((i) => i.content.filter((c) => c.type !== "text").map((c) => ({ turn: i.turn, ...c }))),
};
try { R.rateLimitsAfter = (await codex.request("account/rateLimits/read")).rateLimits; } catch (err) { R.rateLimitsAfter = String(err); }
save();
await codex.kill("SIGTERM");
console.log(JSON.stringify(R, null, 1));
