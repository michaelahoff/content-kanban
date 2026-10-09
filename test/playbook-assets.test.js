import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackup, restoreBackup } from '../backup.js';
import { createApp } from '../server.js';
import { ControlledCodex } from './support/controlled-codex.js';
import { randomUUID } from 'node:crypto';
import { fixture, waitFor } from './support/chat-fixture.js';
import { setPlaybook } from './support/playbooks.js';
import { parseDocument, playbookSettings, withAssets } from '../public/playbook-format.js';

const settingsOf = (text) => playbookSettings(parseDocument(text), 'youtube-video');

test('assets: inline and block lists name the same ordered mixed Library sources', () => {
  const inline = settingsOf('---\nlane: drafting\nassets: [asset:script-1, folder:thumbs-2, "asset:guide-3"]\n---\nWrite.');
  const block = settingsOf('---\nlane: drafting\nassets:\n  - asset:script-1 # The script\n  - folder:thumbs-2\n\n  - \'asset:guide-3\'\n---\nWrite.');
  const expected = [{ kind: 'asset', id: 'script-1' }, { kind: 'folder', id: 'thumbs-2' }, { kind: 'asset', id: 'guide-3' }];
  assert.deepEqual(inline.assets, expected);
  assert.deepEqual(block.assets, expected);
  assert.deepEqual([inline.errors, inline.warnings, block.errors, block.warnings], [[], [], [], []]);
  for (const empty of ['', 'assets: []\n', 'assets:\n']) assert.deepEqual(settingsOf(`---\nlane: drafting\n${empty}---\nWrite.`).assets, [], 'omitted or empty adds no Library inputs');
});

test('assets: tokens that are not asset:<id> or folder:<id> stay visible as errors that block the run', () => {
  const settings = settingsOf('---\nlane: drafting\nassets: [asset:script-1, script.md, path:refs/logo.png, folder:, asset:script-1]\n---\nWrite.');
  assert.deepEqual(settings.assets, [{ kind: 'asset', id: 'script-1' }]);
  assert.deepEqual(settings.errors, [
    'assets: “script.md” is not asset:<id> or folder:<id>. Choose Library files with Add Library files.',
    'assets: “path:refs/logo.png” is not asset:<id> or folder:<id>. Choose Library files with Add Library files.',
    'assets: “folder:” is not asset:<id> or folder:<id>. Choose Library files with Add Library files.']);
  assert.deepEqual(settings.warnings, ['assets: asset:script-1 is listed more than once; it is sent once.']);
  assert.deepEqual(settingsOf('---\nlane: drafting\nassets:\n  script: asset:script-1\n---\nWrite.').errors, ['assets must be a list, such as [asset:<id>, folder:<id>].']);
});

const script = { kind: 'asset', id: 'script-1' }; const thumbs = { kind: 'folder', id: 'thumbs-2' }; const guide = { kind: 'asset', id: 'guide-3' };

test('picker edits rewrite only the assets: setting, keeping every other byte of the playbook', () => {
  const head = '---\nlane: drafting   # Drafting lane\nrun: manual\n# Settings below are reviewed weekly\nset:\n  intro: |\n    assets: [asset:not-a-setting]\n';
  const tail = 'may_edit: [intro]\n---\n# Draft\n\nUse skills/voice.md and asset:prose-only.\n';
  assert.equal(withAssets(`${head}assets: [asset:script-1] # References\n${tail}`, [script, thumbs]),
    `${head}assets: [asset:script-1, folder:thumbs-2] # References\n${tail}`);
  assert.equal(withAssets(`${head}assets: [asset:script-1]\n${tail}`, []), `${head}assets: []\n${tail}`);
  assert.equal(withAssets(`${head}${tail}`, [guide]), `${head}may_edit: [intro]\nassets: [asset:guide-3]\n---\n# Draft\n\nUse skills/voice.md and asset:prose-only.\n`, 'a missing setting is added at the end of the settings');
});

test('picker edits keep a block list\'s indentation and the comments beside the items they keep', () => {
  const text = 'lane: drafting\nassets: # Library inputs\n    # Read first\n    - asset:script-1 # The script\n    - folder:thumbs-2\n    # Old guide, dropped\n    - asset:guide-3\nrun: manual';
  assert.equal(withAssets(`---\n${text}\n---\nBody`, [thumbs, script, { kind: 'asset', id: 'new-4' }]),
    '---\nlane: drafting\nassets: # Library inputs\n    - folder:thumbs-2\n    # Read first\n    - asset:script-1 # The script\n    - asset:new-4\n    # Old guide, dropped\nrun: manual\n---\nBody', 'a comment stays with the item after it; a removed item\'s comment is kept at the end');
  assert.equal(withAssets('---\r\nlane: drafting\r\nassets:\r\n  - asset:script-1\r\n---\r\nBody\r\n', [script, guide]),
    '---\r\nlane: drafting\r\nassets:\r\n  - asset:script-1\r\n  - asset:guide-3\r\n---\r\nBody\r\n', 'Windows line endings stay');
  assert.equal(withAssets('---\nlane: drafting\nassets:\n  - asset:script-1\n---\nBody', []), '---\nlane: drafting\nassets: []\n---\nBody');
  assert.equal(withAssets('---\nassets:\n  # first note\n  - asset:a\n  # second note\n  - asset:a\n  - asset:b\n---\nBody', [{ kind: 'asset', id: 'a' }]),
    '---\nassets:\n  # first note\n  - asset:a\n  # second note\n---\nBody', 'a repeated item is written once, and the comments of both copies stay');
});

test('picker edits refuse a draft they cannot change safely and leave it to raw Markdown', () => {
  for (const unsafe of ['---\nlane: drafting\nassets: [asset:script-1\nBody', '---\nlane: drafting\nassets: [script.md]\n---\nBody', '---\nlane: drafting\nassets:\n  a: asset:x\n---\nBody']) {
    assert.throws(() => withAssets(unsafe, [script]), /Fix the settings in Markdown before choosing Library files/, unsafe);
  }
  assert.equal(withAssets('# Unattached\n\nNo settings yet.', [script]), '---\nassets: [asset:script-1]\n---\n# Unattached\n\nNo settings yet.');
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
async function laneFixture(t) {
  const f = await fixture(t);
  const workspace = await f.ok('GET', '/api/workspace');
  const projectId = workspace.projects[0].id; const flowId = workspace.projects[0].flowId; const stages = workspace.flows[0].stages;
  async function upload(filename, bytes, query = {}) {
    const response = await f.raw(`/api/projects/${projectId}/library/uploads?${new URLSearchParams({ filename, operation: randomUUID(), ...query })}`, { method: 'POST', body: bytes });
    const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body));
    return body.asset;
  }
  const folder = (name) => f.ok('POST', `/api/projects/${projectId}/library/folders`, { name });
  const runs = async (cardId) => (await f.ok('GET', `/api/cards/${cardId}/lane-runs`)).runs;
  return { ...f, projectId, flowId, stages, upload, folder, runs };
}

test('a lane run sends the playbook\'s selected Library sources after the gallery; prose mentions and same-named skills stay separate', async (t) => {
  const f = await laneFixture(t);
  const voice = await f.upload('voice.md', Buffer.from('Library voice: speak plainly.'));
  const unselected = await f.upload('unselected.md', Buffer.from('UNSELECTED TEXT'));
  const thumbs = await f.folder('Thumbnails');
  const logo = await f.upload('logo.png', png, { folder: thumbs.id });
  await f.ok('PUT', `/api/flows/${f.flowId}/playbooks`, { path: 'skills/voice.md', text: '# Skill voice: be warm.', baseHash: null });
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model', skills: ['voice'], assets: [`asset:${voice.id}`, `folder:${thumbs.id}`] },
    `Use skills/voice.md. Do not read unselected.md, asset:${unselected.id} or Thumbnails/other.png.`);
  const image = { id: '00000001-0000-4000-8000-000000000000.png', name: 'portrait.png' };
  await writeFile(path.join(f.dataDir, 'images', image.id), png);
  const card = await f.card({ images: [image] });

  const preview = await f.ok('GET', `/api/cards/${card.id}/lane-runs/preview`);
  assert.deepEqual(preview.problems, []);
  assert.deepEqual(preview.library.map((file) => [file.assetId, file.libraryPath]), [[voice.id, 'voice.md'], [logo.id, 'Thumbnails/logo.png']]);
  assert.deepEqual(preview.librarySelections, [{ kind: 'asset', id: voice.id, path: 'voice.md' }, { kind: 'folder', id: thumbs.id, path: 'Thumbnails/' }]);

  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  const submission = (await f.chat(card.id)).submissions[0];
  assert.deepEqual(submission.context.images.map((entry) => entry.id), [image.id], 'every gallery photo still goes first');
  assert.deepEqual(submission.context.library.map((file) => [file.assetId, file.method]), [[voice.id, 'text'], [logo.id, 'image']]);
  const sent = send.input.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
  assert.ok(sent.includes('# Skill voice: be warm.') && sent.includes('Library voice: speak plainly.'), 'the skill and the same-named Library file are both sent, separately');
  assert.ok(!sent.includes('UNSELECTED TEXT'), 'a file mentioned only in prose is not selected');
  assert.equal(send.input.filter((entry) => entry.type === 'localImage').length, 2, 'the gallery photo and the selected folder\'s image');
});

test('unresolved sources save visibly, block the lane run by identity without a submission, and a copied playbook keeps foreign IDs', async (t) => {
  const f = await laneFixture(t);
  const kept = await f.upload('script.md', Buffer.from('Script'));
  const removed = await f.upload('old.md', Buffer.from('Old'));
  await f.ok('DELETE', `/api/projects/${f.projectId}/library/assets/${removed.id}`);
  const thumbs = await f.folder('Thumbnails');
  const tokens = [`asset:${kept.id}`, `asset:${removed.id}`, `asset:${thumbs.id}`, 'asset:never-existed'];
  const saved = await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model', assets: tokens }, 'Write.');
  assert.match(saved.text, new RegExp(`assets: \\[${tokens.join(', ')}\\]`), 'unresolved IDs are saved as written');
  await f.upload('old.md', Buffer.from('A new file under the old name'));
  const card = await f.card();
  const preview = await f.ok('GET', `/api/cards/${card.id}/lane-runs/preview`);
  assert.deepEqual(preview.problems.map((problem) => [problem.key, problem.reason]), [
    [`asset:${removed.id}`, 'It was removed from the Library.'],
    [`asset:${thumbs.id}`, 'It is a folder, not a file. Select it as a folder.'],
    ['asset:never-existed', 'It is not a file in this project’s Library.']]);
  assert.deepEqual(preview.library.map((file) => file.assetId), [kept.id], 'a new file with the removed one\'s name is never substituted');
  assert.match(preview.error, /^Not sent\./);

  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const failed = await waitFor(async () => (await f.runs(card.id)).find((run) => run.status === 'failed'));
  assert.ok(failed.reason.includes(`old.md (asset:${removed.id}): It was removed`), failed.reason);
  assert.equal(failed.submissionId ?? null, null);
  assert.deepEqual((await f.chat(card.id)).submissions, [], 'nothing is queued, so there is nothing to Retry');
  assert.equal(f.codex.sends.length, 0);

  // The same file in another project's playbook folder keeps its references.
  const other = await f.ok('POST', '/api/projects', { name: 'Other' });
  const workspace = await f.ok('GET', '/api/workspace');
  const otherFlow = workspace.flows.find((flow) => flow.id === workspace.projects.find((entry) => entry.id === (other.project ?? other).id).flowId);
  const check = await f.ok('GET', `/api/flows/${otherFlow.id}/playbooks/assets?${new URLSearchParams({ sources: tokens.join(',') })}`);
  assert.equal(check.problems[0].key, `asset:${kept.id}`);
  assert.equal(check.problems[0].reason, 'It is a file in another project’s Library. Choose one from this project; nothing is matched by name.');
  const here = await f.ok('GET', `/api/flows/${f.flowId}/playbooks/assets?${new URLSearchParams({ sources: tokens.join(',') })}`);
  assert.deepEqual(here.selections, [{ kind: 'asset', id: kept.id, path: 'script.md' }]);
  assert.equal(here.problems.length, 3);
  assert.equal((await f.call('GET', `/api/flows/not-a-flow/playbooks/assets?sources=asset:${kept.id}`)).status, 404);
  await f.ok('DELETE', `/api/projects/${(other.project ?? other).id}`);
  assert.equal((await f.call('GET', `/api/flows/${otherFlow.id}/playbooks/assets?sources=asset:${kept.id}`)).status, 404, 'a flow whose project is gone');
});

test('export and restore keep a playbook\'s selections as written, resolving to the same Library sources', async (t) => {
  const f = await laneFixture(t);
  const thumbs = await f.folder('Thumbnails');
  const logo = await f.upload('logo.png', png, { folder: thumbs.id });
  const saved = await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model', assets: [`folder:${thumbs.id}`, 'asset:gone'] }, 'Write.');
  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-playbook-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { backupDir } = await createBackup({ dataDir: f.dataDir, output: path.join(root, 'backups'), codexHome: path.join(root, 'old-native') });
  const dataDir = path.join(root, 'restored');
  await restoreBackup({ backupDir, dataDir, codexHome: path.join(root, 'native') });
  const app = await createApp({ dataDir, codexAdapter: new ControlledCodex(path.join(root, 'native')), providerBackoffMs: 10 });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const get = async (url) => { const response = await fetch(`http://127.0.0.1:${app.address().port}${url}`); assert.ok(response.ok); return response.json(); };
  assert.equal(await readFile(path.join(dataDir, 'flows', f.flowId, saved.path), 'utf8'), saved.text);
  const check = await get(`/api/flows/${f.flowId}/playbooks/assets?${new URLSearchParams({ sources: `folder:${thumbs.id},asset:gone` })}`);
  assert.deepEqual(check.selections, [{ kind: 'folder', id: thumbs.id, path: 'Thumbnails/' }]);
  assert.deepEqual(check.files.map((file) => file.assetId), [logo.id]);
  assert.deepEqual(check.problems.map((problem) => problem.key), ['asset:gone'], 'the unresolved ID is still unresolved, not dropped');
});

test('an empty selection adds no Library inputs and keeps every gallery photo, the map and named skills', async (t) => {
  const f = await laneFixture(t);
  await f.upload('voice.md', Buffer.from('LIBRARY VOICE'));
  await f.ok('PUT', `/api/flows/${f.flowId}/playbooks`, { path: 'skills/voice.md', text: '# Skill voice: be warm.', baseHash: null });
  await setPlaybook(f.ok, f.flowId, f.stages[0], { run: 'manual', model: 'test-model', assets: [] }, 'Use skills/voice.md and voice.md.');
  const images = ['00000001-0000-4000-8000-000000000000.png', '00000002-0000-4000-8000-000000000000.png'].map((id, index) => ({ id, name: `photo-${index}.png` }));
  for (const image of images) await writeFile(path.join(f.dataDir, 'images', image.id), png);
  const card = await f.card({ images });
  await f.ok('POST', `/api/cards/${card.id}/lane-runs`, {});
  const send = await waitFor(() => f.codex.sends[0]);
  const submission = (await f.chat(card.id)).submissions[0];
  assert.deepEqual(submission.context.images.map((image) => image.id), images.map((image) => image.id));
  assert.deepEqual(submission.context.library, []);
  const sent = send.input.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
  assert.ok(sent.includes('## Project map (MAP.md)') && sent.includes('# Skill voice: be warm.'));
  assert.ok(!sent.includes('LIBRARY VOICE'));
});
