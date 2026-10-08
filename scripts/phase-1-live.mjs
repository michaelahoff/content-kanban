// Explicit opt-in: three bounded submissions use the existing Codex sign-in.
// Keep evidence and images locally; no credentials/configuration are copied.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server.js';
import { createCodexAdapter } from '../codex-adapter.js';
import { sha256 } from '../image-files.js';

if (process.env.FRAMEBOARD_LIVE_TEST !== '1') throw new Error('Set FRAMEBOARD_LIVE_TEST=1 to run the signed-in, three-submission image/recovery gate.');
const model = 'gpt-6-luna';
const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-phase-1-live-'));
const evidenceDir = path.resolve('test-results', `phase-1-live-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
let app; let adapter = createCodexAdapter(); let sends = 0; let suppressed = false; let imageSeen;
const seenImage = new Promise((resolve) => { imageSeen = resolve; });
const evidence = { startedAt: new Date().toISOString(), appRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  worktreeDiffHash: sha256(execFileSync('git', ['diff', 'HEAD', '--', '*.js', '*.mjs', 'package.json'])), node: process.version, model, dataDir, evidenceDir,
  configurationMode: 'full Codex setup, ordinary sandbox/approval; ADR 0002', nativeResume: 'not verified', status: 'running' };

async function start(dropImages = false) {
  const boundary = { ...adapter, startTurn: (input) => { sends++; return adapter.startTurn(input); },
    subscribe: (id, handlers) => adapter.subscribe(id, { ...handlers, onEvent: (event) => {
      if (dropImages && event.type === 'item-completed' && event.item.type === 'imageGeneration' && event.item.status === 'completed') {
        suppressed = true;
        imageSeen({ threadId: id, turnId: event.turnId, itemId: event.item.id, hash: sha256(Buffer.from(event.item.result, 'base64')) });
      }
      if (!dropImages || !suppressed) handlers.onEvent?.(event);
    } }),
  };
  app = await createApp({ dataDir, codexAdapter: boundary });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
}
const close = () => new Promise((resolve) => app.close(resolve));
async function call(method, url, body) {
  const response = await fetch(`http://127.0.0.1:${app.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
}
async function until(fn, ms = 90000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error('Bounded signed-in gate timed out.');
}
try {
  await start(true); console.log(`Live gate evidence: ${evidenceDir}`);
  const settings = await call('GET', '/api/providers/codex');
  await call('PUT', '/api/providers/codex', { revision: settings.revision, selection: { inherited: true, selected: [],
    instructions: 'Bounded Frameboard acceptance: use only native image generation/editing when requested, and the Frameboard read_card tool for the final text check. Do not use connectors, external services or shell commands. Generate one image per image request, with no extra variations.' } });
  const workspace = await call('GET', '/api/workspace'); const project = workspace.projects[0];
  const stageId = workspace.flows.find((flow) => flow.id === project.flowId).stages[0].id;
  const card = await call('POST', `/api/projects/${project.id}/cards`, { stageId, title: 'Phase 1 live acceptance' });
  const chat = () => call('GET', `/api/cards/${card.id}/chat`);
  async function submit(prompt, images = []) {
    const composer = (await chat()).composer;
    const saved = await call('PUT', `/api/cards/${card.id}/chat/composer`, { ...composer, prompt, model,
      selections: { ...composer.selections, images } });
    return call('POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: saved.revision });
  }
  function completed(submission) {
    return until(async () => {
      const value = await chat(); const row = value.submissions.find((entry) => entry.id === submission.id);
      assert.ok(!['held', 'failed', 'uncertain'].includes(row.status), JSON.stringify(row));
      assert.equal(value.requests.filter((entry) => entry.status === 'pending').length, 0, 'Unexpected native approval/input: gate needs an explicit decision.');
      return row.status === 'completed' && value.outputs.every((entry) => entry.importStatus !== 'pending') && value;
    }, 360000);
  }
  const first = await submit('Generate exactly ONE native image: a solid green square centered on a plain white background. Make one image-generation call only, no variations or shell commands. Then reply "image saved".');
  const native = await Promise.race([seenImage, new Promise((_, reject) => setTimeout(() => reject(new Error('No native image in six minutes.')), 360000).unref())]);
  console.log('Native generation complete; crash/reconciliation check.');
  await until(async () => (await adapter.listTurns({ threadId: native.threadId })).data.some((turn) => turn.id === native.turnId && turn.items.some((item) => item.id === native.itemId && item.status === 'completed')));
  const before = await chat(); assert.equal(before.outputs.length, 0);
  const binding = before.conversations[0].binding;
  evidence.harness = first.configuration.harness; evidence.configurationId = first.configuration.id;
  await adapter.close({ signal: 'SIGKILL' }); await close(); adapter = createCodexAdapter(); await start();
  const recovered = await until(async () => { const value = await chat(); return value.outputs.some((entry) => entry.native.itemId === native.itemId && entry.importStatus === 'imported') && value; });
  assert.equal(sends, 1, 'Recovery must make no model request.');
  const source = recovered.outputs.find((entry) => entry.native.itemId === native.itemId);
  assert.equal(source.hash, native.hash);
  const editedSubmission = await submit('Edit only the attached exact image version: change the green square to solid blue. Preserve its dimensions, shape, position and white background. Use one native image edit call only, no variations or shell commands.', [source.imageId]);
  const edited = await completed(editedSubmission);
  const edits = edited.outputs.filter((entry) => entry.submissionId === editedSubmission.id);
  assert.ok(edits.length > 0 && edits.every((entry) => entry.importStatus === 'imported'));
  assert.ok(edits.every((entry) => entry.references.some((reference) => reference.outputId === source.id && reference.hash === source.hash)));
  const adoption = await call('POST', `/api/cards/${card.id}/chat/outputs/${edits[0].id}/adopt`, {});
  assert.deepEqual(adoption.card.imageRoles, { cover: null, original: null, inspiration: null });
  assert.equal((await call('POST', `/api/cards/${card.id}/chat/outputs/${edits[0].id}/adopt`, {})).adopted, false);
  console.log('Exact-reference edit and idempotent role-free adoption complete; cold-resume card-tool check.');
  await adapter.close({ signal: 'SIGKILL' }); await close(); adapter = createCodexAdapter(); await start();
  const follow = await submit('Use the Frameboard read_card tool once to read this card. Do not use any other tools and do not generate images. Then reply exactly "phase one resume confirmed".');
  const done = await completed(follow);
  assert.deepEqual(done.conversations[0].binding, binding);
  assert.ok(done.items.some((item) => item.attemptId === done.attempts.find((attempt) => attempt.submissionId === follow.id).id && item.data?.type === 'dynamicToolCall' && item.data.success));
  assert.equal(sends, 3);
  const outputs = [];
  for (const output of done.outputs) {
    const bytes = Buffer.from(await (await fetch(`http://127.0.0.1:${app.address().port}/images/${output.imageId}`)).arrayBuffer());
    assert.equal(sha256(bytes), output.hash);
    const filename = path.join(evidenceDir, output.imageId); await writeFile(filename, bytes, { mode: 0o600 });
    outputs.push({ id: output.id, imageId: output.imageId, hash: output.hash, filename, creationMethod: output.creationMethod, references: output.references, toolPrompt: output.toolPrompt });
  }
  Object.assign(evidence, { status: 'passed', finishedAt: new Date().toISOString(), cardId: card.id, binding, sends,
    recoveredState: recovered.submissions.find((entry) => entry.id === first.id).status, recoveredCause: recovered.attempts[0].cause,
    outputs, submissionIds: [first.id, editedSubmission.id, follow.id], toolOnColdResume: true });
  console.log(`PASS signed-in generation, crash recovery, exact edit, adoption and cold-resume tool: ${done.outputs.length} images, ${sends} submissions.`);
} catch (error) { evidence.status = 'failed'; evidence.error = error.message; throw error; }
finally {
  if (app?.listening) await close();
  await writeFile(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
}
