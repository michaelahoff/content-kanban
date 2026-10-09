// Explicit opt-in (#67): two bounded submissions on the existing Codex sign-in.
// Through Frameboard's public HTTP API and the protected native boundary, a
// card chat sends three Library files: a written document (full text inline),
// a PNG (native image) and a gzip file (a workspace copy only Codex's shell
// tool can read). The reply must report a code from the document, the image's
// two colors and a code that exists only inside the gzip file. A lane run
// whose playbook selects the same files must then report them in its result
// block, as hand-off notes and a saved document. Evidence stays local in
// test-results/; no credentials or configuration are copied.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { crc32, deflateSync, gzipSync } from 'node:zlib';
import { createApp } from '../server.js';
import { sha256 } from '../image-files.js';
import { setPlaybook } from '../test/support/playbooks.js';

if (process.env.FRAMEBOARD_LIVE_TEST !== '1') throw new Error('Set FRAMEBOARD_LIVE_TEST=1 to run the signed-in project-assets delivery gate (two submissions).');
const model = process.env.FRAMEBOARD_LIVE_MODEL || 'gpt-6-luna';
const colors = { red: [255, 0, 0], green: [0, 200, 0], blue: [0, 0, 255], yellow: [255, 230, 0] };

// A 384×192 RGB PNG: the left half one color, the right half another.
function twoColorPng(left, right) {
  const width = 384; const height = 192;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) Buffer.from(colors[x < width / 2 ? left : right]).copy(rows, y * (width * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const code = () => randomBytes(3).toString('hex').toUpperCase();
const documentCode = code(); const gzipCode = code();
const names = Object.keys(colors); const left = names[randomInt(names.length)];
const right = names.filter((name) => name !== left)[randomInt(names.length - 1)];
const evidenceDir = path.resolve('test-results', `project-assets-live-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const evidence = { startedAt: new Date().toISOString(), appRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  worktreeDiffHash: sha256(execFileSync('git', ['diff', 'HEAD', '--', '*.js', '*.mjs', 'package.json'])), node: process.version, model, status: 'running' };

let dataDir; let app; let base;
async function call(method, url, body, raw) {
  const response = await fetch(`${base}${url}`, { method, ...(raw ? { body: raw } : { headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }) });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
}
async function until(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 500)); }
  throw new Error('The bounded signed-in gate timed out.');
}
try {
  dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-assets-live-'));
  app = await createApp({ dataDir });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.address().port}`;
  const { projects: [project], flows } = await call('GET', '/api/workspace');
  const library = `/api/projects/${project.id}/library`;
  const upload = async (filename, bytes) => (await call('POST', `${library}/uploads?${new URLSearchParams({ filename, operation: randomUUID() })}`, undefined, bytes)).asset;
  const draft = await call('POST', `${library}/drafts`, { filename: 'Brief.md', text: `# Episode brief\n\nThe brief code is ${documentCode}.` });
  const brief = (await call('POST', `${library}/drafts/${draft.id}/save`, { revision: draft.revision, operation: randomUUID() })).asset;
  const image = await upload('Thumbnail.png', twoColorPng(left, right));
  const gzipped = await upload('notes.txt.gz', gzipSync(Buffer.from(`Notes code: ${gzipCode}\n`)));
  const stageId = flows.find((flow) => flow.id === project.flowId).stages[0].id;
  const prompt = 'Reply with exactly one line in this form and nothing else: BRIEF=<the brief code in Brief.md>; LEFT=<color of the left half of Thumbnail.png>; RIGHT=<color of its right half>; NOTES=<the code inside notes.txt.gz>. Colors are one word each: red, green, blue or yellow. Read notes.txt.gz by decompressing its workspace copy with one shell command such as zcat; do not modify any file.';
  // Sends the three files from a new card and waits until the submission settles.
  async function send(title) {
    const card = await call('POST', `/api/projects/${project.id}/cards`, { stageId, title });
    const { composer } = await call('GET', `/api/cards/${card.id}/chat`);
    const saved = await call('PUT', `/api/cards/${card.id}/chat/composer`, { ...composer, model, prompt,
      selections: { ...composer.selections, library: [brief, image, gzipped].map(({ id }) => ({ kind: 'asset', id })) } });
    const preview = await call('POST', `/api/cards/${card.id}/chat/preview`, {});
    assert.deepEqual(preview.problems, [], JSON.stringify(preview.problems));
    const submission = await call('POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: saved.revision });
    assert.deepEqual(submission.context.library.map((file) => file.method), ['text', 'image', 'copy']);
    console.log(`${title}: sent ${submission.context.library.map((file) => `${file.filename} (${file.method})`).join(', ')} to ${model}.`);
    const chat = await until(async () => {
      const value = await call('GET', `/api/cards/${card.id}/chat`);
      const row = value.submissions.find((entry) => entry.id === submission.id);
      assert.ok(row, `Submission ${submission.id} is missing from the card chat.`);
      assert.ok(!['failed', 'uncertain', 'cancelled'].includes(row.status), JSON.stringify({ row, attempts: value.attempts }));
      assert.equal(value.requests.filter((entry) => entry.status === 'pending').length, 0, 'Unexpected native approval request: the gate needs no escalation.');
      return ['completed', 'held'].includes(row.status) && value;
    }, 360000);
    return { chat, submission: chat.submissions.find((entry) => entry.id === submission.id) };
  }

  // The default isolated selection runs only where every inherited native
  // item's isolation is proven. Otherwise it is held before execution, and
  // the gate continues with the explicit full-setup opt-in (ADR 0002), as the
  // Phase 1 live gate does, inside the same retained-data boundary.
  let { chat, submission } = await send('Isolated setup');
  if (submission.status === 'held') {
    assert.equal(submission.hold, 'configuration', submission.reason);
    assert.equal(chat.attempts.find((entry) => entry.submissionId === submission.id).turnId, null, 'a held submission never starts a native turn');
    evidence.isolatedSetup = { status: 'held', reason: submission.reason };
    console.log(`Isolated setup held before execution: ${submission.reason}`);
    const settings = await call('GET', '/api/providers/codex');
    await call('PUT', '/api/providers/codex', { revision: settings.revision, selection: { inherited: true, selected: [],
      instructions: 'Bounded Frameboard acceptance: use only one read-only shell command when a file must be decompressed. Do not use connectors, plugins, external services, image generation or Frameboard card tools.' } });
    ({ chat, submission } = await send('Full native setup'));
    evidence.configurationMode = 'full Codex setup, ordinary sandbox/approval; ADR 0002';
  } else evidence.configurationMode = 'isolated selection';
  assert.equal(submission.status, 'completed', submission.reason);
  const attempt = chat.attempts.find((entry) => entry.submissionId === submission.id);
  const reply = chat.items.filter((item) => item.attemptId === attempt.id && item.kind === 'agentMessage').map((item) => item.text).join('\n');
  const tools = chat.items.filter((item) => item.attemptId === attempt.id && item.kind !== 'agentMessage' && item.kind !== 'userMessage')
    .map((item) => ({ kind: item.kind, type: item.data?.type ?? null, command: item.data?.command ?? null }));
  const expected = { BRIEF: documentCode, LEFT: left, RIGHT: right, NOTES: gzipCode };
    Object.assign(evidence, { harness: submission.configuration?.harness, protection: submission.configuration?.protection,
    configurationId: submission.configuration?.id, delivery: attempt.delivery, inputs: submission.context.library.map(({ filename, method, format, hash, size }) => ({ filename, method, format, hash, size })),
    expected, reply, tools });
  const matches = (text) => Object.entries(expected).every(([key, value]) => new RegExp(`${key}=${value}\\b`, 'i').test(text));
  assert.ok(matches(reply), `The card chat reply does not report every value: ${reply}`);
  console.log(`Card chat passed: the written document, both image colors and the gzip code (${tools.length} tool item${tools.length === 1 ? '' : 's'}).`);

  // The same files through a lane playbook's assets: selection and result block.
  const stage = flows.find((flow) => flow.id === project.flowId).stages[0];
  await setPlaybook(call, project.flowId, stage, { run: 'manual', provider: 'codex', model, assets: [brief, image, gzipped].map(({ id }) => `asset:${id}`) },
    `${prompt.replace('Reply with exactly one line in this form and nothing else:', 'Find these values:')}\n\nIn your result block, put that one line in notes, and save the same line as one outputs document named values.md. Change no fields.`);
  const laneCard = await call('POST', `/api/projects/${project.id}/cards`, { stageId, title: 'Lane run' });
  await call('POST', `/api/cards/${laneCard.id}/lane-runs`, {});
  console.log('Lane run requested; waiting for its result.');
  const run = await until(async () => {
    const [latest] = (await call('GET', `/api/cards/${laneCard.id}/lane-runs`)).runs;
    assert.ok(!['failed', 'cancelled', 'held'].includes(latest?.status), JSON.stringify(latest));
    return latest?.status === 'completed' && latest;
  }, 360000);
  const laneChat = await call('GET', `/api/cards/${laneCard.id}/chat`);
  const laneSubmission = laneChat.submissions.find((entry) => entry.id === run.submissionId);
  assert.deepEqual(laneSubmission.context.library.map((file) => file.method), ['text', 'image', 'copy']);
  const notes = (await call('GET', `/api/cards/${laneCard.id}/notes`)).text;
  const laneAttempt = laneChat.attempts.find((entry) => entry.submissionId === laneSubmission.id);
  evidence.laneRun = { runId: run.id, status: run.status, reason: run.reason, result: run.result, delivery: laneAttempt.delivery, notes,
    reply: laneChat.items.filter((item) => item.attemptId === laneAttempt.id && item.kind === 'agentMessage').map((item) => item.text).join('\n') };
  const output = laneChat.savedOutputs.find((entry) => entry.filename === 'values.md' && entry.status === 'saved');
  assert.ok(output, `No saved values.md: ${run.reason}`);
  assert.equal(output.creationMethod, 'lane-result');
  const saved = await (await fetch(`${base}/api/cards/${laneCard.id}/chat/saved-outputs/${output.id}/content`)).text();
  evidence.laneRun.savedOutput = { id: output.id, versionId: output.versionId, hash: output.hash, text: saved };
  assert.ok(matches(notes), `The hand-off notes do not report every value: ${notes}`);
  assert.ok(matches(saved), `values.md does not report every value: ${saved}`);
  evidence.status = 'passed';
  console.log('PASS signed-in Codex read all three files in a card chat and in a lane run, which saved them as notes and a lane-result document.');
} catch (error) { evidence.status = 'failed'; evidence.error = error.message; throw error; }
finally {
  evidence.finishedAt = new Date().toISOString();
  if (app?.listening) await new Promise((resolve) => app.close(resolve));
  await writeFile(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(`Evidence: ${path.join(evidenceDir, 'evidence.json')}`);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}
