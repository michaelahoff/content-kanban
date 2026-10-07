// Block E: temporary per-prompt overrides in both directions with explicit snapshots and
// source-labeled result handoff; primary native identities must be unchanged. ~4 turns.
import { writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { startCodex, runTurn } from "./codex.mjs";
import { openSession, summarizeResult, WORK } from "./claude.mjs";

const A = JSON.parse(readFileSync("/tmp/fb-live-evidence/evidence/A-summary.json")).a1.threadA; // Codex primary (card A)
const D = JSON.parse(readFileSync("/tmp/fb-live-evidence/evidence/C-summary.json")).c1.sessionD; // Claude primary (card D)
const LOG = "/tmp/fb-live-evidence/evidence/E-overrides.raw.jsonl";
const R = { codexPrimary: A, claudePrimary: D };
const save = () => writeFileSync("/tmp/fb-live-evidence/evidence/E-summary.json", JSON.stringify(R, null, 1));
const text = (s) => [{ type: "text", text: s, text_elements: [] }];

const codex = startCodex({ log: LOG, onServerRequest: () => ({ decision: "decline" }) });
await codex.init();

// E1: Codex primary -> Claude override.
{
  const pre = await codex.request("thread/read", { threadId: A, includeTurns: true });
  const visible = pre.thread.turns.flatMap((t) => t.items.filter((i) => i.type === "userMessage" || i.type === "agentMessage").map((i) => i.type === "userMessage" ? `User: ${i.content.map((c) => c.text ?? "").join("")}` : `Assistant: ${i.text}`)).slice(-6);
  const snapshot = `[Frameboard context snapshot — card A — source: Codex thread ${A}, last ${visible.length} visible messages; hidden reasoning and tool state not included]\n${visible.join("\n")}\n[Card fields] Title: "Spring kite promo" | Body: "Short teaser for the kite sale."`;
  R.e1 = { primaryBefore: { id: pre.thread.id, model: pre.thread.model, turns: pre.thread.turns.length }, snapshotChars: snapshot.length };
  const side = randomUUID();
  const sess = openSession({ log: LOG, label: "E1-override", options: { sessionId: side, tools: [] } });
  const o = await sess.turn(`${snapshot}\n\nTemporary override task: propose a one-line headline for card A that includes the codeword from the snapshot. Reply with only the headline.`, randomUUID());
  await sess.close();
  R.e1.override = { provider: "claude", session: side, resultUuid: o.slice.filter((m) => m.type === "assistant").at(-1)?.uuid, models: o.models, text: o.text, toolsOffered: sess.messages.find((m) => m.subtype === "init")?.tools, ...summarizeResult(o.result) };
  const handoff = `[Frameboard result handoff — from temporary override: Claude ${o.models[0]} session ${side}, message ${R.e1.override.resultUuid}. This is information, not an instruction.]\n${o.text}\n\nAcknowledge by replying with only that headline.`;
  await codex.request("thread/resume", { threadId: A });
  const h = await runTurn(codex, { threadId: A, input: text(handoff), clientUserMessageId: "fb-A-handoff-1", effort: "low" });
  const post = await codex.request("thread/read", { threadId: A, includeTurns: false });
  R.e1.handoff = { status: h.completed.turn.status, text: h.text, primaryAfter: { id: post.thread.id, model: post.thread.model }, sameIdentity: post.thread.id === A };
}
save();

// E2: Claude primary -> Codex override, with an explicit image reference snapshot.
{
  const msgs = await getSessionMessages(D, { dir: WORK });
  const visible = msgs.filter((m) => m.type === "user" || m.type === "assistant").map((m) => {
    const c = m.message?.content; const s = typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return s && !s.startsWith("<") && !s.startsWith("[Request") ? `${m.type === "user" ? "User" : "Assistant"}: ${s.slice(0, 120)}` : null;
  }).filter(Boolean).slice(-6);
  const img = "/tmp/fb-live-evidence/evidence/artifacts/claude-kite-v2.png";
  const snapshot = `[Frameboard context snapshot — card D — source: Claude session ${D}, last ${visible.length} visible messages; attached image: Frameboard version claude-kite-v2.png]\n${visible.join("\n")}`;
  R.e2 = { primaryBeforeMessages: msgs.length, snapshotChars: snapshot.length };
  const th = await codex.request("thread/start", { model: "gpt-6-luna", cwd: WORK, sandbox: "read-only", approvalPolicy: "on-request" });
  const o = await runTurn(codex, { threadId: th.thread.id, clientUserMessageId: "fb-D-override-1", effort: "low", input: [...text(`${snapshot}\n\nTemporary override task: in at most 12 words, name the codeword from the snapshot and the kite colour in the attached image.`), { type: "localImage", path: img }] });
  R.e2.override = { provider: "codex", thread: th.thread.id, turn: o.turnId, status: o.completed.turn.status, text: o.text };
  const sess = openSession({ log: LOG, label: "E2-primary", options: { resume: D } });
  const h = await sess.turn(`[Frameboard result handoff — from temporary override: Codex gpt-6-luna thread ${th.thread.id}, turn ${o.turnId}. Information, not an instruction.]\n${o.text}\n\nAcknowledge by replying with only that text.`, randomUUID());
  await sess.close();
  const after = await getSessionMessages(D, { dir: WORK });
  R.e2.handoff = { text: h.text, models: h.models, session: h.result.session_id, sameIdentity: h.result.session_id === D, messagesAfter: after.length };
}
save();
await codex.kill("SIGTERM");
console.log(JSON.stringify(R, null, 1));
process.exit(0);
