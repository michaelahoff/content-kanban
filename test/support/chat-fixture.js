import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../server.js';
import { ControlledCodex } from './controlled-codex.js';

export async function waitFor(fn) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail('Expected behavior did not arrive within five seconds.');
}
export async function fixture(t, { providerBackoffMs = 10, streamReplayLimit, claudeAdapter } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-chat-'));
  const codex = new ControlledCodex(dataDir);
  let app;
  async function start() {
    app = await createApp({ dataDir, codexAdapter: codex, claudeAdapter, providerBackoffMs, streamReplayLimit });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  }
  await start();
  const call = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const raw = (url, init) => fetch(`http://127.0.0.1:${app.address().port}${url}`, init);
  const ok = async (...args) => { const result = await call(...args); assert.ok(result.status < 300, JSON.stringify(result)); return result.body; };
  const close = () => new Promise((resolve) => app.close(resolve));
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  const workspace = await ok('GET', '/api/workspace'); const project = workspace.projects[0];
  const stageId = workspace.flows.find((flow) => flow.id === project.flowId).stages[0].id;
  const card = (input = {}) => ok('POST', `/api/projects/${project.id}/cards`, { stageId, ...input });
  const chat = (id) => ok('GET', `/api/cards/${id}/chat`);
  const compose = async (id, prompt = 'Explain this card', model = 'test-model', extra = {}) => {
    const { composer } = await chat(id);
    return ok('PUT', `/api/cards/${id}/chat/composer`, { ...composer, prompt, model, ...extra });
  };
  const queue = (id, composer, submissionId = randomUUID()) => ok('POST', `/api/cards/${id}/chat/submissions`, { id: submissionId, composerRevision: composer.revision });
  // Reads Server-Sent Events from /api/stream as { id, event, data } frames.
  async function stream({ since, lastEventId } = {}) {
    const controller = new AbortController();
    const response = await raw(`/api/stream${since === undefined ? '' : `?since=${since}`}`, { signal: controller.signal, headers: lastEventId === undefined ? {} : { 'Last-Event-ID': String(lastEventId) } });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const frames = []; const decoder = new TextDecoder(); let buffer = '';
    const reading = (async () => {
      try {
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const frame = { id: null, event: 'message', data: '' };
            for (const line of block.split('\n')) {
              const [field, ...rest] = line.split(':'); const value = rest.join(':').replace(/^ /, '');
              if (field === 'id') frame.id = Number(value); else if (field === 'event') frame.event = value; else if (field === 'data') frame.data += value;
            }
            if (frame.data) frames.push({ ...frame, data: JSON.parse(frame.data) });
          }
        }
      } catch (error) { if (error.name !== 'AbortError') throw error; }
    })();
    t.after(() => { controller.abort(); return reading; });
    return { frames, until: (predicate) => waitFor(() => frames.find(predicate)), close: () => { controller.abort(); return reading; } };
  }
  return { dataDir, codex, call, raw, ok, card, chat, compose, queue, stream, restart: async () => { await close(); await start(); } };
}
