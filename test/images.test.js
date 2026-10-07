import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fixture, waitFor } from './support/chat-fixture.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function nativeFile(f, send, name, bytes) {
  const directory = path.join(f.dataDir, 'generated_images', send.threadId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), bytes);
  return path.join(directory, name);
}
// Store files are read-only; a test damages one deliberately.
const tamper = async (file, bytes) => { await chmod(file, 0o644); await writeFile(file, bytes); };
const imported = (f, cardId, count = 1) => waitFor(async () => {
  const outputs = (await f.chat(cardId)).outputs;
  return outputs.filter((o) => o.importStatus === 'imported').length >= count && outputs;
});

test('a completed native image is imported once with verified bytes and provenance, without gallery adoption', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id, 'Draw a red square')); const send = await waitFor(() => f.codex.sends[0]);
  const savedPath = await nativeFile(f, send, 'call-1.png', png);
  const item = f.codex.image(send, { result: png.toString('base64'), savedPath, revisedPrompt: 'A red square, flat' });
  f.codex.emit(send.threadId, { type: 'item-completed', turnId: send.turnId, item });
  const [output] = await imported(f, card.id);
  const chat = await f.chat(card.id);
  assert.equal(chat.outputs.length, 1);
  assert.equal(output.hash, sha(png));
  assert.equal(output.provider, 'codex'); assert.equal(output.creationMethod, 'native-image-generation');
  assert.equal(output.toolPrompt, 'A red square, flat'); assert.equal(output.conversationModel, 'test-model');
  assert.equal(output.imageModel, null);
  assert.equal(output.native.itemId, item.id); assert.equal(output.native.turnId, send.turnId); assert.equal(output.native.savedPath, savedPath);
  assert.equal(output.submissionId, chat.submissions[0].id);
  assert.ok(!JSON.stringify(chat.items).includes(png.toString('base64')), 'Transcript rows do not retain base64 image payloads.');
  const served = await f.raw(`/images/${output.imageId}`);
  assert.equal(served.status, 200); assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
  const saved = (await f.ok('GET', `/api/cards/${card.id}`)).card;
  assert.deepEqual(saved.images, []); assert.equal(saved.imageRoles.cover, null);
});

test('uploads and chat versions share the hashed store; serving and references refuse damaged bytes', async (t) => {
  const f = await fixture(t);
  const upload = await (await f.raw('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  const card = await f.card({ images: [{ id: upload.id, name: 'Upload' }], imageRoles: { original: upload.id } });
  assert.equal(upload.hash, sha(png));
  assert.equal((await f.raw(`/images/${upload.id}`)).status, 200);
  await tamper(path.join(f.dataDir, 'images', upload.id), Buffer.concat([png, Buffer.from('tampered')]));
  const served = await f.raw(`/images/${upload.id}`);
  assert.equal(served.status, 409); assert.match((await served.json()).error, /damaged/);
  await f.compose(card.id);
  const preview = await f.call('POST', `/api/cards/${card.id}/chat/preview`, {});
  assert.equal(preview.status, 409); assert.match(preview.body.error, /damaged/);
});

test('multiple outputs adopt independently and idempotently without filling Display; roles change separately', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id, 'Three variations')); const send = await waitFor(() => f.codex.sends[0]);
  for (let i = 0; i < 3; i++) f.codex.image(send, { result: png.toString('base64') });
  f.codex.finish(send);
  const outputs = await imported(f, card.id, 3);
  assert.equal(new Set(outputs.map((o) => o.imageId)).size, 3);
  const second = outputs[1];
  await f.ok('PUT', `/api/cards/${card.id}/draft-lease`, { owner: 'tab', fields: ['images'] });
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/outputs/${second.id}/adopt`, {})).status, 409);
  await f.ok('PUT', `/api/cards/${card.id}/draft-lease`, { owner: 'tab', fields: [] });
  const adopted = await f.ok('POST', `/api/cards/${card.id}/chat/outputs/${second.id}/adopt`, {});
  assert.equal(adopted.adopted, true);
  assert.deepEqual(adopted.card.images.map((i) => i.id), [second.imageId]);
  assert.deepEqual(adopted.card.imageRoles, { cover: null, original: null, inspiration: null });
  const again = await f.ok('POST', `/api/cards/${card.id}/chat/outputs/${second.id}/adopt`, {});
  assert.equal(again.adopted, false); assert.equal(again.card.images.length, 1);
  const states = (await f.ok('GET', `/api/cards/${card.id}/states`)).states;
  assert.equal(states.filter((s) => s.source === 'image_adopted').length, 1);
  const chat = await f.chat(card.id);
  assert.deepEqual(chat.outputs.map((o) => o.inGallery), [false, true, false]);
  const roles = await f.ok('PATCH', `/api/cards/${card.id}`, { changes: { imageRoles: { cover: second.imageId, original: null, inspiration: second.imageId } }, baseVersions: adopted.card.fieldVersions });
  assert.equal(roles.imageRoles.cover, second.imageId);
  assert.equal((await f.chat(card.id)).outputs.length, 3);
});

test('editing an exact chat version keeps other attachments and links the edited output to its source', async (t) => {
  const f = await fixture(t);
  const upload = await (await f.raw('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  const card = await f.card({ images: [{ id: upload.id, name: 'Gallery reference' }] });
  await f.queue(card.id, await f.compose(card.id, 'Generate A')); const first = await waitFor(() => f.codex.sends[0]);
  f.codex.image(first, { result: png.toString('base64') }); f.codex.finish(first);
  const [a] = await imported(f, card.id);
  const { composer } = await f.chat(card.id);
  const edit = await f.ok('PUT', `/api/cards/${card.id}/chat/composer`, { ...composer, prompt: 'Make A blue', model: 'test-model',
    selections: { ...composer.selections, images: [upload.id, a.imageId] } });
  const submission = await f.queue(card.id, edit);
  const source = submission.context.images.find((image) => image.id === a.imageId);
  assert.equal(source.source, 'chat-output'); assert.equal(source.outputId, a.id); assert.equal(source.hash, a.hash);
  assert.ok(submission.context.images.some((image) => image.id === upload.id && image.source === 'gallery'));
  const second = await waitFor(() => f.codex.sends[1]);
  const paths = second.input.filter((input) => input.type === 'localImage').map((input) => input.path);
  assert.ok(paths.includes(path.join(f.dataDir, 'workspaces', card.id, 'references', `${a.hash}.png`)));
  assert.match(second.input[0].text, new RegExp(`references/${a.hash}\\.png`));
  f.codex.image(second, { result: png.toString('base64'), revisedPrompt: 'Blue edit of A' }); f.codex.finish(second);
  const outputs = await imported(f, card.id, 2);
  const b = outputs.find((o) => o.id !== a.id);
  assert.ok(b.references.some((reference) => reference.outputId === a.id && reference.hash === a.hash));
  assert.notEqual(b.imageId, a.imageId);
  assert.equal(outputs.find((o) => o.id === a.id).imageId, a.imageId);
});

const settled = (f, cardId, count) => waitFor(async () => {
  const outputs = (await f.chat(cardId)).outputs;
  return outputs.length >= count && outputs.every((o) => o.importStatus !== 'pending') && outputs;
});

test('failed saving retries the same output from native state without regeneration', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  const directory = path.join(f.dataDir, 'generated_images', send.threadId);
  f.codex.image(send, { result: '', savedPath: path.join(directory, 'later.png') });
  f.codex.finish(send);
  const [failed] = await settled(f, card.id, 1);
  assert.equal(failed.importStatus, 'failed'); assert.equal(failed.generationStatus, 'completed'); assert.match(failed.error, /missing/);
  await nativeFile(f, send, 'later.png', png);
  const retried = await f.ok('POST', `/api/cards/${card.id}/chat/outputs/${failed.id}/retry-save`, {});
  assert.equal(retried.id, failed.id); assert.equal(retried.importStatus, 'imported'); assert.equal(retried.hash, sha(png));
  assert.equal(f.codex.sends.length, 1);
  const repeated = await f.ok('POST', `/api/cards/${card.id}/chat/outputs/${failed.id}/retry-save`, {});
  assert.equal(repeated.imageId, retried.imageId);
  assert.equal((await f.chat(card.id)).outputs.length, 1);
});

test('damaged, invalid, oversize, linked and escaping native outputs are refused; failed generation needs a new request', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  const differs = await nativeFile(f, send, 'differs.png', Buffer.concat([png, Buffer.from('changed')]));
  const outside = path.join(f.dataDir, 'outside.png'); await writeFile(outside, png);
  const linked = path.join(path.dirname(differs), 'linked.png'); await symlink(outside, linked);
  const cases = [
    [{ result: png.toString('base64'), savedPath: differs }, /damaged/],
    [{ result: Buffer.from('not an image').toString('base64') }, /not a supported image/],
    [{ result: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64') }, /20 MB/],
    [{ result: '', savedPath: linked }, /symbolic/],
    [{ result: '', savedPath: outside }, /outside/],
  ];
  // Returned bytes stay authoritative when a reported path cannot be checked.
  const unverifiable = f.codex.image(send, { result: png.toString('base64'), savedPath: outside }).id;
  const ids = cases.map(([item]) => f.codex.image(send, item).id);
  f.codex.image(send, { status: 'failed', failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: 1790000000 } });
  f.codex.finish(send);
  const outputs = await settled(f, card.id, cases.length + 2);
  assert.equal(outputs.find((o) => o.nativeId === unverifiable).hash, sha(png));
  cases.forEach(([, error], index) => {
    const output = outputs.find((o) => o.nativeId === ids[index]);
    assert.equal(output.importStatus, 'failed'); assert.match(output.error, error); assert.equal(output.imageId, null);
  });
  const limited = outputs.find((o) => o.generationStatus === 'failed');
  assert.equal(limited.importStatus, 'not-applicable'); assert.equal(limited.native.failure.resetsAt, 1790000000);
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/outputs/${limited.id}/retry-save`, {})).status, 409);
  assert.equal(f.codex.sends.length, 1);
});

test('Stop after completion retains the image; gallery removal, fresh context, deletion and restart keep chat versions', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  f.codex.image(send, { result: png.toString('base64') });
  const [output] = await imported(f, card.id);
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  await waitFor(async () => (await f.chat(card.id)).submissions[0].status === 'interrupted');
  const { card: adopted } = await f.ok('POST', `/api/cards/${card.id}/chat/outputs/${output.id}/adopt`, {});
  await f.ok('PATCH', `/api/cards/${card.id}`, { changes: { images: [] }, baseVersions: adopted.fieldVersions });
  assert.equal((await f.chat(card.id)).outputs[0].inGallery, false);
  await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  await f.ok('DELETE', `/api/cards/${card.id}`);
  await f.restart();
  const retained = (await f.chat(card.id)).outputs;
  assert.equal(retained.length, 1); assert.equal(retained[0].imageId, output.imageId); assert.equal(retained[0].importStatus, 'imported');
  assert.equal((await f.raw(`/images/${output.imageId}`)).status, 200);
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/outputs/${output.id}/adopt`, {})).status, 404);
});

test('restart reconciliation imports an accepted turn’s native image once without resending', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  const item = f.codex.image(send, { id: 'native-image-1', result: png.toString('base64') }, { notify: false });
  f.codex.threads.get(send.threadId).turns[0].status = 'completed';
  await f.restart();
  const [output] = await imported(f, card.id);
  assert.equal(output.nativeId, 'native-image-1'); assert.equal(output.native.turnId, send.turnId);
  f.codex.emit(send.threadId, { type: 'item-completed', turnId: send.turnId, item });
  await f.restart();
  assert.equal((await imported(f, card.id)).length, 1);
  assert.equal(f.codex.sends.length, 1);
});

test('registered rendered files become adoptable code-rendered versions; invalid, oversize and reference copies are refused', async (t) => {
  const f = await fixture(t);
  const upload = await (await f.raw('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  const card = await f.card({ images: [{ id: upload.id, name: 'Source' }], imageRoles: { original: upload.id } });
  await f.queue(card.id, await f.compose(card.id, 'Render a variant')); const send = await waitFor(() => f.codex.sends[0]);
  const workspace = path.join(f.dataDir, 'workspaces', card.id);
  await writeFile(path.join(workspace, 'text.png'), 'not an image');
  await writeFile(path.join(workspace, 'huge.png'), Buffer.concat([png, Buffer.alloc(20 * 1024 * 1024)]));
  await writeFile(path.join(workspace, 'render.png'), png);
  assert.match((await f.codex.tool(send, 'register_image', { path: 'text.png' })).contentItems[0].text, /not a supported image/);
  assert.match((await f.codex.tool(send, 'register_image', { path: 'huge.png' })).contentItems[0].text, /20 MB/);
  assert.match((await f.codex.tool(send, 'register_image', { path: `references/${sha(png)}.png` })).contentItems[0].text, /reference/i);
  assert.equal((await f.codex.tool(send, 'register_image', { path: 'render.png', name: 'Variant' }, 'call-1')).success, true);
  const [output] = (await f.chat(card.id)).outputs;
  assert.equal((await f.chat(card.id)).outputs.length, 1);
  assert.equal(output.creationMethod, 'code-rendered'); assert.equal(output.importStatus, 'imported'); assert.equal(output.name, 'Variant');
  assert.equal(output.native.callId, 'call-1'); assert.equal(output.hash, sha(png));
  assert.ok(output.references.some((reference) => reference.id === upload.id));
  const adopted = await f.ok('POST', `/api/cards/${card.id}/chat/outputs/${output.id}/adopt`, {});
  assert.deepEqual(adopted.card.images.map((i) => i.id), [upload.id, output.imageId]);
  assert.equal(adopted.card.imageRoles.original, upload.id);
});

test('an image completing while Stop is pending or after the turn ends is retained; a missing file is shown unavailable without regeneration', async (t) => {
  const f = await fixture(t); const card = await f.card(); f.codex.autoInterrupt = false;
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  f.codex.image(send, { result: png.toString('base64') });
  f.codex.finish(send, 'interrupted', 'Stopped');
  f.codex.image(send, { result: png.toString('base64') });
  const outputs = await imported(f, card.id, 2);
  assert.equal((await f.chat(card.id)).submissions[0].status, 'interrupted');
  assert.ok(outputs.every((o) => o.available));
  await rm(path.join(f.dataDir, 'images', outputs[0].imageId));
  const after = (await f.chat(card.id)).outputs;
  assert.equal(after[0].available, false); assert.equal(after[0].importStatus, 'imported'); assert.equal(after[0].hash, outputs[0].hash);
  assert.equal((await f.raw(`/images/${outputs[0].imageId}`)).status, 404);
  assert.equal(f.codex.sends.length, 1);
});
