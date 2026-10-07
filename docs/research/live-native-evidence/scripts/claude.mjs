// Disposable Claude Agent SDK wrapper for Frameboard live evidence (ticket 13).
// Streaming-input mode so interrupt/setModel/permission callbacks are available.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync } from "node:fs";

export const CLAUDE_BIN = "/usr/bin/claude";
export const WORK = "/tmp/fb-live-evidence/work";

export function openSession({ log, label, options = {} }) {
  const inbox = [];
  let wake = null;
  let closed = false;
  async function* input() {
    while (!closed) {
      if (inbox.length) { yield inbox.shift(); continue; }
      await new Promise((r) => (wake = r));
      wake = null;
    }
  }
  const q = query({
    prompt: input(),
    options: { pathToClaudeCodeExecutable: CLAUDE_BIN, cwd: WORK, model: "sonnet", settingSources: [], includePartialMessages: true, ...options },
  });
  const messages = [];
  const listeners = new Set();
  const record = (m) => appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), label, msg: m }) + "\n");
  const pump = (async () => {
    try { for await (const m of q) { messages.push(m); record(m); for (const fn of listeners) fn(m); } }
    catch (e) { record({ type: "pump_error", error: String(e) }); for (const fn of listeners) fn({ type: "pump_error", error: String(e) }); }
  })();
  function send(text, uuid) {
    const m = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, ...(uuid ? { uuid } : {}) };
    record({ type: "client_send", uuid, text: typeof text === "string" ? text : "[blocks]" });
    inbox.push(m); wake?.();
  }
  function waitFor(pred, ms = 240000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(fn); reject(new Error("timeout")); }, ms);
      const fn = (m) => { if (pred(m)) { clearTimeout(timer); listeners.delete(fn); resolve(m); } };
      listeners.add(fn);
    });
  }
  async function turn(text, uuid, ms) {
    const start = messages.length;
    const done = waitFor((m) => m.type === "result" || m.type === "pump_error", ms);
    send(text, uuid);
    const result = await done;
    const slice = messages.slice(start);
    const assistantText = slice.filter((m) => m.type === "assistant").flatMap((m) => m.message.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
    const models = [...new Set(slice.filter((m) => m.type === "assistant").map((m) => m.message.model))];
    return { result, text: assistantText, models, slice };
  }
  async function close() { closed = true; wake?.(); q.close?.(); await Promise.race([pump, new Promise((r) => setTimeout(r, 5000))]); }
  return { q, messages, send, turn, waitFor, close, on: (fn) => (listeners.add(fn), () => listeners.delete(fn)) };
}

export const summarizeResult = (r) => r && ({ subtype: r.subtype, is_error: r.is_error, session_id: r.session_id, num_turns: r.num_turns, duration_ms: r.duration_ms, total_cost_usd: r.total_cost_usd, stop_reason: r.stop_reason, terminal_reason: r.terminal_reason, errors: r.errors });
