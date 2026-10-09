// Maintenance pauses every app writer so an export sees one consistent state.
// New mutations and dispatch are refused at once; running work finishes or is
// explicitly stopped (its revocation fences late effects); then the export runs.
// Queued work is never cancelled by maintenance and resumes when it ends.
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const maintenanceMessage = 'Frameboard is exporting a backup. Changes are paused until it finishes; your edits are kept and can be retried.';

export function createMaintenance({ store, ctx, worker, lanes, settle, exportWorkspace, dataDir, codexHome, pollMs = 25 }) {
  let current = null; let last = null; let writers = 0;
  const defaultOutput = path.join(path.dirname(dataDir), 'backups');
  const running = () => store.chats.activeAttempts(ctx);
  const quiet = () => !writers && worker.idle() && lanes.idle() && !running().length;
  const status = () => ({ active: Boolean(current), phase: current?.phase ?? 'idle', output: current?.output ?? null, defaultOutput,
    startedAt: current?.startedAt ?? null, running: current ? running() : [], last });

  async function run(job) {
    try {
      // Drain: in-flight requests, preparation, reconciliation and running work.
      for (;;) {
        job.controller.signal.throwIfAborted();
        if (quiet()) { await settle(); if (quiet()) break; }
        await sleep(pollMs, null, { signal: job.controller.signal });
      }
      job.phase = 'exporting';
      const result = await exportWorkspace({ dataDir, output: job.output, codexHome: await codexHome(), signal: job.controller.signal });
      last = { status: 'completed', backupDir: result.backupDir, label: result.label, finishedAt: new Date().toISOString() };
    } catch (error) {
      last = job.controller.signal.aborted
        ? { status: 'cancelled', error: 'Export cancelled. Nothing was published.', finishedAt: new Date().toISOString() }
        : { status: 'failed', error: error.message, finishedAt: new Date().toISOString() };
    } finally {
      current = null;
      worker.wake(); lanes.wake();
    }
  }

  return {
    get active() { return Boolean(current); },
    status,
    // Counts an app write in progress; maintenance waits for it to finish.
    track() { writers++; let done = false; return () => { if (!done) { done = true; writers--; } }; },
    start(input = {}) {
      if (current) fail(409, 'An export is already in progress.');
      const output = input?.output || defaultOutput;
      if (typeof output !== 'string' || !path.isAbsolute(output)) fail(400, 'Choose an absolute backup folder.');
      current = { phase: 'draining', output, startedAt: new Date().toISOString(), controller: new AbortController() };
      current.done = run(current);
      return status();
    },
    cancel() { current?.controller.abort(); return status(); },
    async close() { const job = current; job?.controller.abort(); await job?.done; },
  };
}
