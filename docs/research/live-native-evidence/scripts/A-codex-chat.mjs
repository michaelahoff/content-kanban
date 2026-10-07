// Block A: Codex chat mechanics. ~11 small gpt-6-luna turns at low effort.
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { startCodex, runTurn } from "./codex.mjs";

const LOG = "/tmp/fb-live-evidence/evidence/A-codex-chat.raw.jsonl";
const MODEL = "gpt-6-luna";
const ALT_MODEL = "gpt-5.6-luna";
const R = {};
const save = () => writeFileSync("/tmp/fb-live-evidence/evidence/A-summary.json", JSON.stringify(R, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) => [{ type: "text", text: s, text_elements: [] }];

let held = null; // server request we deliberately leave unanswered
function serverRequestHandler(msg) {
  R.serverRequests ??= [];
  R.serverRequests.push({ id: msg.id, method: msg.method, threadId: msg.params?.threadId, turnId: msg.params?.turnId, itemId: msg.params?.itemId, keys: Object.keys(msg.params ?? {}) });
  return new Promise((resolve) => { held = { msg, resolve }; });
}
const threadOpts = { model: MODEL, cwd: "/tmp/fb-live-evidence/work", sandbox: "read-only", approvalPolicy: "on-request", ephemeral: false };
const turnOpts = { effort: "low" };

let codex = startCodex({ log: LOG, onServerRequest: serverRequestHandler });
await codex.init();

// A1: two card threads, concurrent, isolated context.
const [ta, tb] = await Promise.all([codex.request("thread/start", threadOpts), codex.request("thread/start", threadOpts)]);
const A = ta.thread.id, B = tb.thread.id;
R.a1 = { threadA: A, threadB: B, sessionA: ta.thread.sessionId, pathA: ta.thread.path, startModel: ta.model, effort: ta.reasoningEffort, sandbox: ta.sandbox, approval: ta.approvalPolicy, cliVersion: ta.thread.cliVersion };
const t0 = Date.now();
const [s1, s2] = await Promise.all([
  runTurn(codex, { threadId: A, input: text("Card A note: the codeword is HERON. Reply with only: ok"), clientUserMessageId: "fb-A-1", ...turnOpts }),
  runTurn(codex, { threadId: B, input: text("Card B note: the codeword is OTTER. Reply with only: ok"), clientUserMessageId: "fb-B-1", ...turnOpts }),
]);
R.a1.concurrentSeedMs = Date.now() - t0;
R.a1.seed = [{ turn: s1.turnId, status: s1.completed.turn.status, text: s1.text, ms: s1.completed.turn.durationMs }, { turn: s2.turnId, status: s2.completed.turn.status, text: s2.text, ms: s2.completed.turn.durationMs }];
const [q1, q2] = await Promise.all([
  runTurn(codex, { threadId: A, input: text("What is the codeword? Reply with only the word, or NONE."), clientUserMessageId: "fb-A-2", ...turnOpts }),
  runTurn(codex, { threadId: B, input: text("What is the codeword? Reply with only the word, or NONE."), clientUserMessageId: "fb-B-2", ...turnOpts }),
]);
R.a1.recall = { A: q1.text, B: q2.text };
R.a1.eventMethods = [...new Set(s1.events.map((e) => e.method))];
save();

// A2: model change mid-conversation, then check persistence on the next turn.
const m1 = await runTurn(codex, { threadId: A, input: text("Codeword again? Only the word."), model: ALT_MODEL, clientUserMessageId: "fb-A-3", ...turnOpts });
const readAfterChange = await codex.request("thread/read", { threadId: A, includeTurns: false });
const m2 = await runTurn(codex, { threadId: A, input: text("Reply with only: ok"), clientUserMessageId: "fb-A-4", ...turnOpts });
const readAfterNext = await codex.request("thread/read", { threadId: A, includeTurns: false });
R.a2 = { overrideTurn: { status: m1.completed.turn.status, text: m1.text }, modelAfterOverride: readAfterChange.thread.model, nextTurnStatus: m2.completed.turn.status, modelOnNextTurn: readAfterNext.thread.model,
  turnStartedModels: [m1, m2].map((x) => x.events.filter((e) => /model/i.test(e.method)).map((e) => ({ method: e.method, p: e.params }))) };
save();

// A3: Stop during streaming.
{
  const events = [];
  const off = codex.on((m) => { if (m.params?.threadId === B) events.push(m); });
  const st = await codex.request("turn/start", { threadId: B, input: text("Count from 1 to 300, one number per line, no other text."), clientUserMessageId: "fb-B-3", ...turnOpts });
  const turnId = st.turn.id;
  await codex.waitFor((m) => m.method === "item/agentMessage/delta" && m.params.threadId === B, 120000);
  const tInt = Date.now();
  const ir = await codex.request("turn/interrupt", { threadId: B, turnId });
  const done = await codex.waitFor((m) => m.method === "turn/completed" && m.params.threadId === B && m.params.turn.id === turnId, 60000);
  await sleep(3000);
  off();
  const deltas = events.filter((e) => e.method === "item/agentMessage/delta").map((e) => e.params.delta).join("");
  const after = events.filter((e) => Date.parse(e.t ?? 0) > tInt);
  R.a3 = { turnId, interruptResult: ir, finalStatus: done.params.turn.status, error: done.params.turn.error, streamedChars: deltas.length, streamedTail: deltas.slice(-40),
    completedAgentItems: events.filter((e) => e.method === "item/completed" && e.params.item.type === "agentMessage").map((e) => e.params.item.text.length),
    eventsAfterCompleted: events.slice(events.findIndex((e) => e.method === "turn/completed") + 1).map((e) => e.method) };
  save();
}

// A4: permission wait, then Stop while awaiting the decision.
{
  held = null;
  const events = [];
  const off = codex.on((m) => { if (m.params?.threadId === B) events.push(m.method); });
  const st = await codex.request("turn/start", { threadId: B, input: text("Use a shell command to create a file named probe.txt containing hi in the current directory. Request approval if needed."), clientUserMessageId: "fb-B-4", ...turnOpts });
  const turnId = st.turn.id;
  const until = Date.now() + 120000;
  while (!held && Date.now() < until) {
    if (events.includes("turn/completed")) break;
    await sleep(250);
  }
  R.a4 = { turnId, approvalRequested: !!held, requestMethod: held?.msg.method, requestParamsKeys: held && Object.keys(held.msg.params), availableDecisions: held?.msg.params?.availableDecisions ?? held?.msg.params?.proposedExecpolicyAmendment ?? null };
  if (held) {
    const ir = await codex.request("turn/interrupt", { threadId: B, turnId });
    const done = await codex.waitFor((m) => m.method === "turn/completed" && m.params.threadId === B && m.params.turn.id === turnId, 60000).catch((e) => ({ params: { turn: { status: "TIMEOUT:" + e.message } } }));
    await sleep(2000);
    R.a4.interruptResult = ir;
    R.a4.finalStatus = done.params.turn.status;
    R.a4.methodsSeen = [...new Set(events)];
    R.a4.serverRequestResolvedSeen = events.includes("serverRequest/resolved");
    // Late answer to a request whose turn was interrupted: does the server accept or ignore it?
    held.resolve({ decision: "decline" });
    await sleep(1500);
  } else {
    R.a4.methodsSeen = [...new Set(events)];
  }
  R.a4.fileCreated = (() => { try { execSync("test -e /tmp/fb-live-evidence/work/probe.txt"); return true; } catch { return false; } })();
  off();
  save();
}

// A5: hard kill, restart, resume exact thread A.
await codex.kill();
codex = startCodex({ log: LOG, onServerRequest: serverRequestHandler });
await codex.init();
const resumed = await codex.request("thread/resume", { threadId: A, model: MODEL });
const r1 = await runTurn(codex, { threadId: A, input: text("After restart: what is the codeword? Only the word."), clientUserMessageId: "fb-A-5", ...turnOpts });
R.a5 = { resumedId: resumed.thread.id, sameId: resumed.thread.id === A, resumedTurnCount: resumed.thread.turns?.length, model: resumed.model, recall: r1.text, status: r1.completed.turn.status };
save();

// A6a: crash immediately after writing turn/start (before acknowledgment).
codex.send({ jsonrpc: "2.0", id: 9001, method: "turn/start", params: { threadId: A, input: text("Reply with only: crash-before-ack"), clientUserMessageId: "fb-A-6", ...turnOpts } });
await codex.kill();
codex = startCodex({ log: LOG, onServerRequest: serverRequestHandler });
await codex.init();
{
  const rd = await codex.request("thread/read", { threadId: A, includeTurns: true });
  const turns = rd.thread.turns ?? [];
  R.a6a = { turnCountAfter: turns.length, lastTurn: turns.at(-1) && { id: turns.at(-1).id, status: turns.at(-1).status, userText: JSON.stringify(turns.at(-1).items?.find((i) => i.type === "userMessage") ?? null).slice(0, 300) } };
}
save();

// A6b: crash after acknowledgment, before completion.
await codex.request("thread/resume", { threadId: A, model: MODEL });
const ack = await codex.request("turn/start", { threadId: A, input: text("Count from 1 to 200, one per line."), clientUserMessageId: "fb-A-7", ...turnOpts });
await codex.waitFor((m) => m.method === "item/agentMessage/delta" && m.params.threadId === A, 120000).catch(() => null);
await codex.kill();
codex = startCodex({ log: LOG, onServerRequest: serverRequestHandler });
await codex.init();
{
  const rd = await codex.request("thread/read", { threadId: A, includeTurns: true });
  const turns = rd.thread.turns ?? [];
  const t = turns.find((x) => x.id === ack.turn.id);
  R.a6b = { ackTurnId: ack.turn.id, found: !!t, statusAfterRestart: t?.status, error: t?.error, itemTypes: t?.items?.map((i) => i.type), turnCount: turns.length, threadStatus: rd.thread.status };
  const res = await codex.request("thread/resume", { threadId: A, model: MODEL });
  const t2 = res.thread.turns?.find((x) => x.id === ack.turn.id);
  R.a6b.statusAfterResume = t2?.status;
  R.a6b.threadStatusAfterResume = res.thread.status;
}
save();
await codex.kill("SIGTERM");
console.log(JSON.stringify(R, null, 1));
