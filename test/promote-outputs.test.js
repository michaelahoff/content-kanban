import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';
import { parseLaneResult } from '../public/playbook-format.js';
import { createBackup, restoreBackup } from '../backup.js';
import { createApp } from '../server.js';
import { ControlledCodex } from './support/controlled-codex.js';

const reply = '# Hook guide\n\nOpen on the question, not the answer.';
async function promotionFixture(t, options) {
  const f = await fixture(t, options);
  const projectId = (await f.ok('GET', '/api/workspace')).projects[0].id;
  const library = `/api/projects/${projectId}/library`;
  // A completed reply on a card, saved explicitly as a document.
  async function savedOutput(card, text = reply, filename = 'hooks.md') {
    await f.queue(card.id, await f.compose(card.id));
    const send = await waitFor(() => f.codex.sends.find((entry) => entry.clientUserMessageId && !entry.done));
    send.done = true;
    f.codex.finish(send, 'completed', text);
    const item = await waitFor(async () => (await f.chat(card.id)).items.find((entry) => entry.kind === 'agentMessage' && entry.text === text && entry.completed !== false));
    return f.ok('POST', `/api/cards/${card.id}/chat/saved-outputs`, { operation: randomUUID(), sequence: item.sequence, filename });
  }
  const promote = (cardId, outputId, body) => f.call('POST', `/api/cards/${cardId}/chat/saved-outputs/${outputId}/promote`, { operation: randomUUID(), folderId: null, ...body });
  const versionText = async (versionId) => (await f.raw(`${library}/versions/${versionId}/content`)).text();
  return { ...f, projectId, library, savedOutput, promote, versionText };
}

test('Save to project library publishes a saved output as a new Library document with its own identity, bytes and a provenance link', async (t) => {
  const f = await promotionFixture(t);
  const card = await f.card({ title: 'Source card' });
  const output = await f.savedOutput(card);
  const folder = await f.ok('POST', `${f.library}/folders`, { name: 'Guides' });

  const promoted = await f.promote(card.id, output.id, { folderId: folder.id, filename: 'Hook guide.md' });
  assert.equal(promoted.status, 201, JSON.stringify(promoted.body));
  const { asset, version } = promoted.body;
  assert.equal(promoted.body.outcome, 'created');
  assert.equal(asset.filename, 'Hook guide.md');
  assert.equal(asset.folderId, folder.id);
  assert.equal(asset.kind, 'document', 'A promoted document stays a written document');
  assert.notEqual(asset.id, output.id);
  assert.notEqual(version.id, output.versionId, 'The asset holds its own retained version, never the output’s');
  assert.equal(version.hash, output.hash);
  assert.deepEqual(asset.promotedFrom, { cardId: card.id, outputId: output.id, versionId: output.versionId });
  assert.equal(await f.versionText(version.id), reply);

  const listed = (await f.ok('GET', f.library)).assets;
  assert.deepEqual(listed.map((entry) => [entry.id, entry.filename]), [[asset.id, 'Hook guide.md']]);
  // The saved output is unchanged, and records where it was promoted to.
  const [after] = (await f.chat(card.id)).savedOutputs;
  assert.equal(after.status, 'saved');
  assert.equal(after.versionId, output.versionId);
  assert.deepEqual(after.promotions.map(({ assetId, versionId, outcome }) => ({ assetId, versionId, outcome })), [{ assetId: asset.id, versionId: version.id, outcome: 'created' }]);
});

test('a taken name asks for Create new or Replace: Create new takes a suffixed name, Replace publishes a new version of that file', async (t) => {
  const f = await promotionFixture(t);
  const card = await f.card();
  const first = await f.savedOutput(card, reply, 'hooks.md');
  const held = (await f.promote(card.id, first.id, { filename: 'Hook guide.md' })).body.asset;

  const second = await f.savedOutput(card, '# Hook guide v2\n\nAsk, then answer.', 'hooks-2.md');
  const operation = randomUUID();
  const asked = await f.promote(card.id, second.id, { operation, filename: 'Hook guide.md' });
  assert.equal(asked.status, 409, 'A taken name is never overwritten without a choice');
  assert.deepEqual({ ...asked.body.conflict }, { filename: 'Hook guide.md', suggested: 'Hook guide (1).md', assetId: held.id });
  assert.equal((await f.ok('GET', f.library)).assets.length, 1, 'Nothing was published');

  const created = await f.promote(card.id, second.id, { operation, filename: 'Hook guide.md', collision: 'create' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.outcome, 'created');
  assert.equal(created.body.asset.filename, 'Hook guide (1).md');
  assert.notEqual(created.body.asset.id, held.id);

  const replaced = await f.promote(card.id, second.id, { filename: 'Hook guide.md', collision: 'replace', assetId: held.id });
  assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
  assert.equal(replaced.body.outcome, 'replaced');
  assert.equal(replaced.body.asset.id, held.id, 'Replace keeps the asset identity');
  assert.equal(replaced.body.version.number, 2);
  const history = await f.ok('GET', `${f.library}/assets/${held.id}`);
  assert.deepEqual(history.versions.map((version) => [version.number, version.promotedFrom.outputId]), [[2, second.id], [1, first.id]], 'Older versions are kept');
  assert.equal(await f.versionText(history.versions[1].id), reply);
  assert.equal(await f.versionText(replaced.body.version.id), '# Hook guide v2\n\nAsk, then answer.');
  assert.deepEqual((await f.chat(card.id)).savedOutputs.find((output) => output.id === second.id).promotions.map((entry) => entry.outcome), ['created', 'replaced']);

  // Replace must name the file that holds the name.
  const wrong = await f.promote(card.id, second.id, { filename: 'Hook guide.md', collision: 'replace', assetId: created.body.asset.id });
  assert.equal(wrong.status, 409);
  assert.equal((await f.ok('GET', `${f.library}/assets/${created.body.asset.id}`)).versions.length, 1);
});

test('a promoted asset is selected on another card by its own identity, and neither it nor the output depends on the other’s card, removal or archive', async (t) => {
  const f = await promotionFixture(t);
  const source = await f.card({ title: 'Source' });
  const output = await f.savedOutput(source);
  const before = await f.ok('GET', `/api/cards/${source.id}`);
  const { asset, version } = (await f.promote(source.id, output.id, { filename: 'Hook guide.md' })).body;

  // Promotion neither selects the asset anywhere nor changes the card.
  assert.deepEqual((await f.chat(source.id)).composer.selections.library, []);
  const after = await f.ok('GET', `/api/cards/${source.id}`);
  assert.deepEqual(after.card.images, before.card.images);
  assert.equal(after.card.revision, before.card.revision, 'Nothing is adopted or given a role');

  // Deleting the source card leaves the asset selectable on another card.
  await f.ok('DELETE', `/api/cards/${source.id}`);
  const other = await f.card({ title: 'Other' });
  const { composer } = await f.chat(other.id);
  const selected = await f.compose(other.id, 'Use the hook guide', 'test-model', { selections: { ...composer.selections, library: [{ kind: 'asset', id: asset.id }] } });
  const submission = await f.queue(other.id, selected);
  assert.deepEqual(submission.context.library.map(({ assetId, versionId, filename }) => ({ assetId, versionId, filename })), [{ assetId: asset.id, versionId: version.id, filename: 'Hook guide.md' }]);
  const send = await waitFor(() => f.codex.sends.find((entry) => entry.clientUserMessageId && !entry.done));
  assert.match(JSON.stringify(send.input), /Open on the question, not the answer\./, 'The promoted text is delivered from the asset');

  // Removing the asset and archiving the project leave the output whole, and the asset's versions readable.
  await f.ok('DELETE', `${f.library}/assets/${asset.id}`);
  await f.ok('POST', `/api/projects/${f.projectId}/archive`, {});
  assert.equal(await (await f.raw(`/api/cards/${source.id}/chat/saved-outputs/${output.id}/content`)).text(), reply);
  assert.equal(await f.versionText(version.id), reply);
  const [kept] = (await f.chat(source.id)).savedOutputs;
  assert.equal(kept.versionId, output.versionId);
  assert.deepEqual(kept.promotions.map(({ assetId, removed }) => ({ assetId, removed })), [{ assetId: asset.id, removed: true }]);
});

test('promotion is refused while archived or in maintenance, and a failed promotion publishes nothing and keeps the current version', async (t) => {
  const f = await promotionFixture(t);
  const card = await f.card();
  const output = await f.savedOutput(card);
  const held = (await f.promote(card.id, output.id, { filename: 'Hook guide.md' })).body;

  // A retry of a committed operation reports it again; reusing it for another output is refused.
  const operation = randomUUID();
  const once = await f.promote(card.id, output.id, { operation, filename: 'Copy.md' });
  const again = await f.promote(card.id, output.id, { operation, filename: 'Copy.md' });
  assert.equal(again.status, 201);
  assert.equal(again.body.asset.id, once.body.asset.id);
  assert.equal((await f.ok('GET', f.library)).assets.length, 2, 'A repeated request publishes once');
  const other = await f.savedOutput(card, 'Other text', 'other.md');
  assert.equal((await f.promote(card.id, other.id, { operation, filename: 'Copy.md' })).status, 409);
  assert.equal((await f.promote(card.id, output.id, { filename: 'x.md', hash: 'abc' })).status, 400, 'Frameboard reads the bytes itself');

  // Damaged output bytes are never published, and Replace leaves the current version current.
  const payload = path.join(f.dataDir, 'retained', 'versions', other.versionId);
  await chmod(payload, 0o600); await writeFile(payload, 'tampered!!');
  const damaged = await f.promote(card.id, other.id, { filename: 'Hook guide.md', collision: 'replace', assetId: held.asset.id });
  assert.equal(damaged.status, 409);
  assert.match(damaged.body.error, /unavailable|changed/);
  const asset = await f.ok('GET', `${f.library}/assets/${held.asset.id}`);
  assert.deepEqual(asset.versions.map((version) => version.id), [held.version.id]);
  assert.equal(await f.versionText(held.version.id), reply);
  assert.deepEqual((await f.chat(card.id)).savedOutputs.find((entry) => entry.id === other.id).promotions, [], 'No publication is claimed');

  await f.ok('POST', `/api/projects/${f.projectId}/archive`, {});
  const archived = await f.promote(card.id, output.id, { filename: 'Late.md' });
  assert.equal(archived.status, 409);
  assert.match(archived.body.error, /archived/i);
  await f.ok('POST', `/api/projects/${f.projectId}/unarchive`, {});

  const backups = await mkdtemp(path.join(tmpdir(), 'frameboard-promote-maintenance-'));
  t.after(() => rm(backups, { recursive: true, force: true }));
  await f.ok('POST', '/api/maintenance/export', { output: backups });
  const paused = await f.promote(card.id, output.id, { filename: 'Paused.md' });
  assert.equal(paused.status, 503);
  await waitFor(async () => !(await f.ok('GET', '/api/maintenance')).active);
  assert.deepEqual((await f.ok('GET', f.library)).assets.map((entry) => entry.filename), ['Copy.md', 'Hook guide.md']);
});

const block = (value) => `Done.\n\n\`\`\`frameboard-result\n${JSON.stringify(value, null, 2)}\n\`\`\``;

test('an agent’s registered output is never promoted: a requested Library placement is reported as ignored and only the user can save it to the Library', async (t) => {
  const asked = { outputs: [{ filename: 'hook.md', text: '# Hook', library: 'Guides/Hook guide.md', replace: true }] };
  const parsed = parseLaneResult(block(asked), 'youtube-video');
  assert.deepEqual(parsed.outputs, [{ filename: 'hook.md', text: '# Hook', sources: null }]);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0], /Ignored “library”, “replace” in “hook\.md”.*only the user can save it to the project Library/);

  const f = await promotionFixture(t);
  const workspace = await f.ok('GET', '/api/workspace');
  await setPlaybook(f.ok, workspace.projects[0].flowId, workspace.flows[0].stages[0], { run: 'manual', model: 'test-model' }, 'Write a hook guide. Suggest saving it to the Library.');
  const card = await f.card();
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  assert.match(JSON.stringify(send.input), /only the user can save it to the project Library/i, 'The lane prompt says agents may only suggest promotion');
  f.codex.finish(send, 'completed', block({ notes: 'Suggest saving hook.md to the Library.', ...asked }));
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.savedOutputs[0]?.status === 'saved' && value; });
  assert.deepEqual(chat.savedOutputs[0].promotions, []);
  assert.deepEqual((await f.ok('GET', f.library)).assets, [], 'Registration never publishes a Library file');

  // The user can then promote it explicitly.
  const promoted = await f.promote(card.id, chat.savedOutputs[0].id, { filename: 'Hook guide.md' });
  assert.equal(promoted.status, 201, JSON.stringify(promoted.body));
  assert.equal(await f.versionText(promoted.body.version.id), '# Hook');
});

test('a complete backup restores a promoted asset and its saved output with separate identities, payloads and their provenance link', async (t) => {
  const f = await promotionFixture(t);
  const card = await f.card();
  const output = await f.savedOutput(card);
  const created = (await f.promote(card.id, output.id, { filename: 'Hook guide.md' })).body;
  const second = await f.savedOutput(card, 'Second take', 'second.md');
  await f.promote(card.id, second.id, { filename: 'Hook guide.md', collision: 'replace', assetId: created.asset.id });
  const asset = await f.ok('GET', `${f.library}/assets/${created.asset.id}`);
  const outputs = (await f.chat(card.id)).savedOutputs;
  await f.ok('DELETE', `/api/cards/${card.id}`);
  await f.ok('POST', `/api/projects/${f.projectId}/archive`, {});
  await f.close();

  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-promote-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { backupDir } = await createBackup({ dataDir: f.dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'native') });
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  const payloads = new Set(manifest.files.map((file) => file.path));
  for (const id of [output.versionId, second.versionId, ...asset.versions.map((version) => version.id)]) assert.ok(payloads.has(`retained/versions/${id}`), `${id} has its own payload`);

  const dataDir = path.join(root, 'restored');
  await restoreBackup({ backupDir, dataDir, codexHome: path.join(root, 'native') });
  const app = await createApp({ dataDir, codexAdapter: new ControlledCodex(path.join(root, 'native')) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const get = async (url) => (await fetch(`${base}${url}`)).json();
  assert.deepEqual(await get(`${f.library}/assets/${asset.id}`), asset, 'Identity, versions and promotion provenance are unchanged');
  assert.deepEqual((await get(`/api/cards/${card.id}/chat`)).savedOutputs, outputs);
  assert.equal(await (await fetch(`${base}${f.library}/versions/${asset.versions[1].id}/content`)).text(), reply);
  assert.equal(await (await fetch(`${base}${f.library}/versions/${asset.versions[0].id}/content`)).text(), 'Second take');
  assert.equal(await (await fetch(`${base}/api/cards/${card.id}/chat/saved-outputs/${output.id}/content`)).text(), reply);
});
