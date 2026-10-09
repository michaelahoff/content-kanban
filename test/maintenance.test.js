import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, waitFor } from './support/chat-fixture.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');

async function maintenanceFixture(t, options) {
  const f = await fixture(t, options);
  const output = await mkdtemp(path.join(tmpdir(), 'frameboard-maintenance-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const status = () => f.ok('GET', '/api/maintenance');
  const finished = () => waitFor(async () => { const value = await status(); return !value.active && value.last && value.last; });
  // Reads the published bundle's own database, as of its snapshot.
  const bundled = (backupDir, sql, ...params) => {
    const db = new DatabaseSync(path.join(backupDir, 'frameboard.db'), { readOnly: true });
    try { return db.prepare(sql).all(...params).map((row) => ({ ...row })); } finally { db.close(); }
  };
  return { ...f, output, status, finished, bundled };
}

test('maintenance blocks mutations and new dispatch, lets running work finish, exports, then resumes queued work', async (t) => {
  const f = await maintenanceFixture(t);
  const card = await f.card({ title: 'Running card' });
  const running = await f.queue(card.id, await f.compose(card.id));
  const send = await waitFor(() => f.codex.sends[0]);
  const followUp = await f.queue(card.id, await f.compose(card.id, 'Queued follow-up'));

  const started = await f.call('POST', '/api/maintenance/export', { output: f.output });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.phase, 'draining');
  assert.deepEqual(started.body.running.map((entry) => entry.cardId), [card.id]);
  assert.equal((await f.call('POST', '/api/maintenance/export', { output: f.output })).status, 409);

  const { composer } = await f.chat(card.id);
  const notes = await f.ok('GET', `/api/cards/${card.id}/notes`);
  const workspace = await f.ok('GET', '/api/workspace');
  for (const [method, url, body] of [
    ['PATCH', `/api/cards/${card.id}`, { revision: card.revision, title: 'Changed' }],
    ['POST', `/api/cards/${card.id}/chat/submissions`, { id: randomUUID(), composerRevision: composer.revision }],
    ['PUT', `/api/cards/${card.id}/chat/composer`, { ...composer, prompt: 'Edited draft' }],
    ['PUT', `/api/cards/${card.id}/notes`, { text: 'Edited notes', baseHash: notes.hash }],
    ['PUT', `/api/flows/${workspace.flows[0].id}/playbooks`, { path: 'skills/voice.md', text: 'Voice', baseHash: null }],
    ['POST', `/api/cards/${card.id}/lane-runs`, {}],
    ['POST', `/api/projects`, { name: 'New project' }],
  ]) {
    const response = await f.call(method, url, body);
    assert.equal(response.status, 503, `${method} ${url}: ${JSON.stringify(response.body)}`);
    assert.match(response.body.error, /backup/i);
  }
  const upload = await f.raw('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(upload.status, 503);
  assert.equal((await f.status()).phase, 'draining');

  f.codex.finish(send);
  const result = await f.finished();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(path.dirname(result.backupDir), f.output);
  // The bundle's snapshot holds the finished reply and the still-queued follow-up.
  assert.deepEqual(f.bundled(result.backupDir, 'SELECT id, status FROM chat_submissions ORDER BY sequence'),
    [{ id: running.id, status: 'completed' }, { id: followUp.id, status: 'queued' }]);
  assert.equal(f.bundled(result.backupDir, 'SELECT title FROM cards WHERE id = ?', card.id)[0].title, 'Running card');
  const manifest = JSON.parse(await readFile(path.join(result.backupDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 2);

  // Maintenance ended: queued work dispatches and edits save again.
  await waitFor(() => f.codex.sends.length === 2);
  assert.equal(f.codex.sends[1].clientUserMessageId !== send.clientUserMessageId, true);
  await f.ok('PATCH', `/api/cards/${card.id}`, { revision: card.revision, title: 'Changed' });
  assert.deepEqual((await readdir(f.output)).filter((name) => !name.startsWith('.')), [path.basename(result.backupDir)]);
});

test('Stop explicitly cancels running work during maintenance; late native callbacks stay fenced and the stop survives', async (t) => {
  let late = null;
  const f = await maintenanceFixture(t, { backupCheckpoint: async (boundary) => { if (boundary === 'scanned') await late?.(); } });
  const card = await f.card({ title: 'Stopped card' });
  const submission = await f.queue(card.id, await f.compose(card.id));
  const send = await waitFor(() => f.codex.sends[0]);
  f.codex.autoInterrupt = false;
  await f.ok('POST', '/api/maintenance/export', { output: f.output });
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  await waitFor(() => f.codex.interrupts.length === 1);
  assert.equal((await f.status()).phase, 'draining');
  late = () => { f.codex.image(send, { result: png.toString('base64') }); };
  f.codex.finish(send, 'interrupted');

  const result = await f.finished();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const chat = await f.chat(card.id);
  assert.equal(chat.submissions.find((entry) => entry.id === submission.id).status, 'interrupted');
  // The late outcome is retained in history without becoming a saved output.
  assert.ok(chat.items.some((item) => item.kind === 'imageGeneration'));
  assert.deepEqual(chat.outputs, []);
  assert.deepEqual(f.bundled(result.backupDir, 'SELECT status FROM chat_submissions WHERE id = ?', submission.id), [{ status: 'interrupted' }]);
  assert.deepEqual(f.bundled(result.backupDir, "SELECT id FROM chat_outputs WHERE import_status = 'imported'"), []);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.codex.sends.length, 1);
});

test('cancelling maintenance publishes nothing, keeps running and queued work, and accepts edits again', async (t) => {
  const f = await maintenanceFixture(t);
  const card = await f.card({ title: 'Card' });
  await f.queue(card.id, await f.compose(card.id));
  const send = await waitFor(() => f.codex.sends[0]);
  const followUp = await f.queue(card.id, await f.compose(card.id, 'Queued follow-up'));
  await f.ok('POST', '/api/maintenance/export', { output: f.output });
  await f.ok('POST', '/api/maintenance/cancel', {});
  const result = await f.finished();
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(await readdir(f.output).catch(() => []), []);
  await f.ok('PATCH', `/api/cards/${card.id}`, { revision: card.revision, title: 'Edited' });
  f.codex.finish(send);
  await waitFor(() => f.codex.sends.length === 2);
  assert.equal((await f.chat(card.id)).submissions.find((entry) => entry.id === followUp.id).status, 'running');
});

test('saved image outputs are bundled; unsaved outputs are inventoried with their collected native file or none', async (t) => {
  const f = await maintenanceFixture(t);
  const native = path.join(f.output, '..', `native-${randomUUID()}`); f.codex.home = native;
  t.after(() => rm(native, { recursive: true, force: true }));
  const card = await f.card({ title: 'Images' });
  await f.queue(card.id, await f.compose(card.id));
  const send = await waitFor(() => f.codex.sends[0]);
  const generated = path.join(native, 'generated_images', send.threadId);
  f.codex.image(send, { id: 'saved', result: png.toString('base64') });
  f.codex.image(send, { id: 'collected', savedPath: path.join(generated, 'collected.png') });
  f.codex.image(send, { id: 'lost', savedPath: path.join(generated, 'lost.png') });
  f.codex.finish(send);
  await waitFor(async () => (await f.chat(card.id)).outputs.filter((output) => output.importStatus !== 'pending').length === 3);
  // The native file appeared after saving failed; it is collected, not adopted.
  await mkdir(generated, { recursive: true }); await writeFile(path.join(generated, 'collected.png'), png);
  const rollout = `sessions/2026/10/08/rollout-2026-10-08T00-00-00-${send.threadId}.jsonl`;
  await mkdir(path.dirname(path.join(native, rollout)), { recursive: true });
  await writeFile(path.join(native, rollout), JSON.stringify({ type: 'session_meta', payload: { id: send.threadId } }) + '\n');

  await f.ok('POST', '/api/maintenance/export', { output: f.output });
  const result = await f.finished();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const manifest = JSON.parse(await readFile(path.join(result.backupDir, 'manifest.json'), 'utf8'));
  const outputs = Object.fromEntries((await f.chat(card.id)).outputs.map((output) => [output.nativeId, output]));
  const inventory = Object.fromEntries(manifest.inventory.outputs.map((entry) => [entry.outputId, entry]));
  assert.deepEqual(inventory[outputs.saved.id], { outputId: outputs.saved.id, cardId: card.id, attemptId: outputs.saved.attemptId,
    importStatus: 'imported', retained: true, path: `images/${outputs.saved.imageId}`, nativePath: null });
  assert.deepEqual(await readFile(path.join(result.backupDir, 'images', outputs.saved.imageId)), png);
  assert.equal(inventory[outputs.collected.id].retained, false);
  assert.equal(inventory[outputs.collected.id].nativePath, `native/codex/generated_images/${send.threadId}/collected.png`);
  assert.deepEqual(await readFile(path.join(result.backupDir, inventory[outputs.collected.id].nativePath)), png);
  assert.equal(inventory[outputs.lost.id].retained, false);
  assert.equal(inventory[outputs.lost.id].nativePath, null);
  assert.ok(manifest.files.some((entry) => entry.path === `native/codex/${rollout}`));
});
