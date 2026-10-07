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
export async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-chat-'));
  const codex = new ControlledCodex(dataDir);
  let app;
  async function start() {
    app = await createApp({ dataDir, codexAdapter: codex });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  }
  await start();
  const call = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
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
  return { dataDir, codex, call, ok, card, chat, compose, queue, restart: async () => { await close(); await start(); } };
}
