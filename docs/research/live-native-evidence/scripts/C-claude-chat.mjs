// Block C: Claude Code via Agent SDK. ~9 small sonnet turns (one haiku for model change).
import { writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getSessionMessages, getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { openSession, summarizeResult, WORK } from "./claude.mjs";

const LOG = "/tmp/fb-live-evidence/evidence/C-claude-chat.raw.jsonl";
const R = {};
const save = () => writeFileSync("/tmp/fb-live-evidence/evidence/C-summary.json", JSON.stringify(R, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => (s ? String(s).replace(/[^@\s]+@[^@\s]+/g, "<email>") : s);

// C1: two card sessions with app-chosen session IDs, concurrent seeds.
const D = randomUUID(), E = randomUUID();
R.c1 = { sessionD: D, sessionE: E };
{
  const sd = openSession({ log: LOG, label: "D1", options: { sessionId: D } });
  const se = openSession({ log: LOG, label: "E1", options: { sessionId: E } });
  const init = await sd.waitFor((m) => m.type === "system" && m.subtype === "init").catch(() => null);
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    sd.turn("Card D note: the codeword is MAPLE. Reply with only: ok", randomUUID()),
    se.turn("Card E note: the codeword is CEDAR. Reply with only: ok", randomUUID()),
  ]);
  R.c1.concurrentMs = Date.now() - t0;
  R.c1.seed = [{ text: a.text, models: a.models, ...summarizeResult(a.result) }, { text: b.text, models: b.models, ...summarizeResult(b.result) }];
  const initMsg = sd.messages.find((m) => m.type === "system" && m.subtype === "init");
  R.c1.init = initMsg && { session_id: initMsg.session_id, claude_code_version: initMsg.claude_code_version, model: initMsg.model, permissionMode: initMsg.permissionMode, apiKeySource: initMsg.apiKeySource, tools: initMsg.tools, capabilities: initMsg.capabilities, mcp_servers: initMsg.mcp_servers };
  try { const acct = await sd.q.accountInfo(); R.c1.account = { ...acct, email: redact(acct.email), organization: acct.organization ? "<org>" : undefined }; } catch (e) { R.c1.account = String(e); }
  try { R.c1.supportedModels = (await sd.q.supportedModels()).map((m) => m.value ?? m.id ?? m); } catch (e) { R.c1.supportedModels = String(e); }
  await sd.close(); await se.close();
}
save();

// C2: fresh processes, resume exact sessions, recall (isolation + restart/resume).
{
  const sd = openSession({ log: LOG, label: "D2", options: { resume: D } });
  const se = openSession({ log: LOG, label: "E2", options: { resume: E } });
  const [a, b] = await Promise.all([
    sd.turn("What is the codeword? Reply with only the word, or NONE.", randomUUID()),
    se.turn("What is the codeword? Reply with only the word, or NONE.", randomUUID()),
  ]);
  R.c2 = { D: { text: a.text, session_id: a.result.session_id, same: a.result.session_id === D }, E: { text: b.text, session_id: b.result.session_id, same: b.result.session_id === E } };
  await se.close();

  // C3: model change within the same conversation (setModel), then a follow-up.
  await sd.q.setModel("haiku");
  const c = await sd.turn("Codeword again? Only the word.", randomUUID());
  const d = await sd.turn("Reply with only: ok", randomUUID());
  R.c3 = { afterSetModel: { text: c.text, models: c.models, session: c.result.session_id }, nextTurn: { text: d.text, models: d.models } };
  await sd.close();
  const sd2 = openSession({ log: LOG, label: "D3", options: { resume: D } });
  const e = await sd2.turn("Reply with only: ok", randomUUID());
  R.c3.afterResumeWithSonnetOption = { models: e.models, session: e.result.session_id };
  await sd2.close();
}
save();

// C4: permission request held, then Stop while awaiting.
{
  let pending = null;
  const sess = openSession({ log: LOG, label: "E3", options: { resume: E, permissionMode: "default",
    canUseTool: (toolName, input, opts) => new Promise((resolve) => {
      pending = { toolName, input, suggestions: opts.suggestions, toolUseID: opts.toolUseID, resolve, signal: opts.signal };
      opts.signal.addEventListener("abort", () => { pending.aborted = true; });
    }) } });
  const resultP = sess.waitFor((m) => m.type === "result", 180000);
  sess.send("Use the Bash tool to run: printf hi > probe-claude.txt", randomUUID());
  const until = Date.now() + 120000;
  while (!pending && Date.now() < until) await sleep(250);
  R.c4 = { permissionRequested: !!pending, toolName: pending?.toolName, input: pending?.input, suggestionsCount: pending?.suggestions?.length ?? 0, suggestionTypes: pending?.suggestions?.map((s) => s.type + ":" + (s.destination ?? "")) };
  if (pending) {
    const receipt = await sess.q.interrupt();
    const res = await resultP.catch((e) => ({ error: String(e) }));
    await sleep(1500);
    R.c4.interruptReceipt = receipt ?? null;
    R.c4.signalAborted = !!pending.aborted || pending.signal.aborted;
    R.c4.result = summarizeResult(res);
    // Late answer after Stop.
    try { pending.resolve({ behavior: "deny", message: "late" }); R.c4.lateAnswer = "accepted-by-callback"; } catch (e) { R.c4.lateAnswer = String(e); }
  }
  R.c4.fileCreated = existsSync(`${WORK}/probe-claude.txt`);
  await sess.close();
}
save();

// C5: enforced restriction (tools removed) vs instruction.
{
  const sess = openSession({ log: LOG, label: "E4", options: { resume: E, permissionMode: "default", disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit"], canUseTool: async (t) => { R.c5_canUseToolCalled = t; return { behavior: "deny", message: "no" }; } } });
  const t = await sess.turn("Create a file named probe-claude2.txt containing hi, using any tool you have. If you cannot, say CANNOT.", randomUUID());
  const init = sess.messages.find((m) => m.type === "system" && m.subtype === "init");
  const toolUses = t.slice.filter((m) => m.type === "assistant").flatMap((m) => m.message.content.filter((b) => b.type === "tool_use").map((b) => b.name));
  R.c5 = { text: t.text.slice(0, 300), toolsOffered: init?.tools?.filter((x) => /Bash|Write|Edit/.test(x)), toolUses, denials: t.result.permission_denials, fileCreated: existsSync(`${WORK}/probe-claude2.txt`) };
  await sess.close();
}
save();

// C6: Stop during streaming.
{
  const sess = openSession({ log: LOG, label: "D4", options: { resume: D } });
  const resultP = sess.waitFor((m) => m.type === "result", 180000);
  const uuid = randomUUID();
  sess.send("Count from 1 to 300, one number per line, no other text.", uuid);
  await sess.waitFor((m) => m.type === "stream_event" && m.event?.type === "content_block_delta", 120000);
  const receipt = await sess.q.interrupt();
  const res = await resultP;
  await sleep(1500);
  const deltas = sess.messages.filter((m) => m.type === "stream_event" && m.event?.delta?.type === "text_delta").map((m) => m.event.delta.text).join("");
  const assistants = sess.messages.filter((m) => m.type === "assistant");
  R.c6 = { sentUuid: uuid, receipt: receipt ?? null, result: summarizeResult(res), streamedChars: deltas.length, assistantMsgs: assistants.map((m) => ({ aborted: m.aborted ?? m.message?.aborted, stop: m.message.stop_reason, chars: m.message.content.map((b) => b.text?.length ?? 0) })), messagesAfterResult: sess.messages.slice(sess.messages.indexOf(res) + 1).map((m) => m.type + ":" + (m.subtype ?? "")) };
  await sess.close();
}
save();

// C7: hard-kill mid-turn, then inspect native transcript and resume.
{
  const ac = new AbortController();
  const sess = openSession({ log: LOG, label: "D5", options: { resume: D, abortController: ac } });
  const uuid = randomUUID();
  sess.send("Count from 1 to 200, one number per line.", uuid);
  await sess.waitFor((m) => m.type === "stream_event" && m.event?.type === "content_block_delta", 120000).catch(() => null);
  ac.abort();
  await sleep(2000);
  const msgs = await getSessionMessages(D, { dir: WORK }).catch((e) => String(e));
  const info = await getSessionInfo(D, { dir: WORK }).catch((e) => String(e));
  R.c7 = { killedUuid: uuid, transcriptMessages: Array.isArray(msgs) ? msgs.length : msgs, lastEntries: Array.isArray(msgs) ? msgs.slice(-3).map((m) => ({ type: m.type, uuid: m.uuid, text: JSON.stringify(m.message?.content ?? "").slice(0, 120) })) : null, killedUuidPersisted: Array.isArray(msgs) ? msgs.some((m) => m.uuid === uuid) : null, info: typeof info === "object" ? { ...info, firstPrompt: undefined } : info };
  const s2 = openSession({ log: LOG, label: "D6", options: { resume: D } });
  const t = await s2.turn("Reply with only the codeword.", randomUUID());
  R.c7.afterKillResume = { text: t.text, session: t.result.session_id, same: t.result.session_id === D };
  await s2.close();
}
save();
console.log(JSON.stringify(R, null, 1));
process.exit(0);
