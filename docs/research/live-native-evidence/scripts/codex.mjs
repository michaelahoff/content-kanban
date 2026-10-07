// Disposable Codex app-server client for Frameboard live evidence (ticket 13).
// Spawns the installed `codex app-server`, speaks newline-delimited JSON-RPC,
// and appends every inbound/outbound message to a raw JSONL log.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

export function startCodex({ log, cwd = "/tmp/fb-live-evidence/work", onServerRequest } = {}) {
  const child = spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  const record = (dir, msg) =>
    appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), dir, msg }) + "\n");

  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { record("raw", line); return; }
    record("in", msg);
    if (msg.id !== undefined && msg.method === undefined) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : p.resolve(msg.result); }
    } else if (msg.id !== undefined && msg.method) {
      Promise.resolve(onServerRequest ? onServerRequest(msg) : { decision: "decline" })
        .then((result) => { if (result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result }); });
    } else {
      for (const fn of listeners) fn(msg);
    }
  });
  createInterface({ input: child.stderr }).on("line", (line) => record("stderr", line));

  function send(msg) { record("out", msg); child.stdin.write(JSON.stringify(msg) + "\n"); }
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ jsonrpc: "2.0", id, method, params }); });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function waitFor(pred, ms = 180000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("timeout waiting for notification")); }, ms);
      const off = on((m) => { if (pred(m)) { clearTimeout(timer); off(); resolve(m); } });
    });
  }
  async function init() {
    const r = await request("initialize", { clientInfo: { name: "frameboard-evidence", title: "Frameboard live evidence", version: "0.0.1" }, capabilities: { experimentalApi: true } });
    notify("initialized");
    return r;
  }
  function kill(signal = "SIGKILL") { child.kill(signal); return new Promise((r) => child.once("exit", r)); }
  return { child, request, notify, on, waitFor, init, kill, send };
}

// Run one turn to completion, collecting item/turn events for this thread.
export async function runTurn(codex, params, { onEvent, timeoutMs = 240000 } = {}) {
  const events = [];
  const off = codex.on((m) => { if (m.params?.threadId === params.threadId) { events.push(m); onEvent?.(m); } });
  const started = await codex.request("turn/start", params);
  const turnId = started.turn?.id;
  const done = await codex.waitFor((m) => m.method === "turn/completed" && m.params?.threadId === params.threadId && m.params?.turn?.id === turnId, timeoutMs);
  off();
  const text = events.filter((e) => e.method === "item/completed" && e.params.item?.type === "agentMessage").map((e) => e.params.item.text).join("\n");
  return { turnId, started, completed: done.params, events, text };
}
