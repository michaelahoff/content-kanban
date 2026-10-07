import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, waitFor } from './support/chat-fixture.js';

test('field saves retain conflicting drafts while unrelated matching fields apply', async (t) => {
  const f = await fixture(t); const card = await f.card({ title: 'Original', fields: { intro: 'Original intro' } });
  await f.ok('PATCH', `/api/cards/${card.id}`, { revision: card.revision, title: 'Other tab' });
  const saved = await f.ok('PATCH', `/api/cards/${card.id}`, { changes: { title: 'My draft', intro: 'Independent intro' }, baseVersions: card.fieldVersions });
  assert.equal(saved.title, 'Other tab');
  assert.equal(saved.fields.intro, 'Independent intro');
  assert.deepEqual(saved.conflicts, ['title']);
  assert.equal(saved.fieldVersions.intro, 2);
});

test('full access is a native turn mode, preserves card acceptance, and requires interruption before revocation', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const first = await waitFor(() => f.codex.sends[0]);
  const approval = f.codex.request(first); const pending = (await f.chat(card.id)).requests.find((r) => r.status === 'pending');
  await f.ok('POST', `/api/cards/${card.id}/chat/answer`, { requestId: pending.id, response: { decision: 'accept', scope: 'full' } });
  assert.deepEqual(approval.results, [{ decision: 'accept' }]);
  f.codex.finish(first);
  await f.queue(card.id, await f.compose(card.id)); const second = await waitFor(() => f.codex.sends[1]);
  assert.equal(second.fullAccess, true);
  await f.codex.tool(second, 'edit_fields', { fields: { title: 'Unrequested title' }, baseVersions: card.fieldVersions });
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.title, '');
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/revoke-grants`, {})).status, 409);
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  await f.ok('POST', `/api/cards/${card.id}/chat/revoke-grants`, {});
  await f.queue(card.id, await f.compose(card.id)); const third = await waitFor(() => f.codex.sends[2]);
  assert.equal(third.fullAccess, false);
});

test('stale gallery roles do not block saving a matching text field', async (t) => {
  const f = await fixture(t); const imageId = '00000001-0000-4000-8000-000000000000.png';
  const card = await f.card({ images: [{ id: imageId, name: 'Reference' }] });
  await f.ok('PATCH', `/api/cards/${card.id}`, { revision: card.revision, images: [] });
  const saved = await f.ok('PATCH', `/api/cards/${card.id}`, { changes: { intro: 'Matching text', imageRoles: { ...card.imageRoles, original: imageId } }, baseVersions: card.fieldVersions });
  assert.equal(saved.fields.intro, 'Matching text'); assert.deepEqual(saved.conflicts, ['imageRoles']);
  assert.equal(saved.imageRoles.original, null);
});

test('multiple draft leases protect a field independently, expire, and do not block matching unrelated fields', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id, 'Edit title and intro', 'test-model', { authority: { fields: ['title', 'intro'] } }));
  const send = await waitFor(() => f.codex.sends[0]);
  await f.ok('PUT', `/api/cards/${card.id}/draft-lease`, { owner: 'tab-a', fields: ['intro'] });
  await f.ok('PUT', `/api/cards/${card.id}/draft-lease`, { owner: 'tab-b', fields: ['intro'] });
  await f.ok('PUT', `/api/cards/${card.id}/draft-lease`, { owner: 'tab-a', fields: [] });
  await f.codex.tool(send, 'edit_fields', { fields: { title: 'Matching title', intro: 'Dirty intro' }, baseVersions: card.fieldVersions });
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, '');
  await new Promise((resolve) => setTimeout(resolve, 5100));
  const current = (await f.ok('GET', `/api/cards/${card.id}`)).card;
  await f.codex.tool(send, 'edit_fields', { fields: { intro: 'After lease expiry' }, baseVersions: current.fieldVersions });
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, 'After lease expiry');
});

test('lane moves require acceptance and recheck placement and every affected saved or dirty field', async (t) => {
  const f = await fixture(t); const card = await f.card();
  const workspace = await f.ok('GET', '/api/workspace'); const lanes = workspace.flows[0].stages;
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  await f.codex.tool(send, 'propose_move', { toStageId: lanes[1].id });
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.stageId, lanes[0].id);
  const p = (await f.chat(card.id)).proposals[0];
  const preview = await f.ok('POST', `/api/cards/${card.id}/chat/proposals/${p.id}/preview`, {});
  await f.ok('POST', `/api/cards/${card.id}/transitions`, { action: 'move', toStageId: lanes[2].id });
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/proposals/${p.id}/accept`, preview)).status, 409);
  const next = await f.ok('POST', `/api/cards/${card.id}/chat/proposals/${p.id}/preview`, {});
  await f.ok('PUT', `/api/cards/${card.id}/draft-lease`, { owner: 'tab', fields: ['intro'] });
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/proposals/${p.id}/accept`, next)).status, 409);
  await f.ok('PUT', `/api/cards/${card.id}/draft-lease`, { owner: 'tab', fields: [] });
  const accepted = await f.ok('POST', `/api/cards/${card.id}/chat/proposals/${p.id}/accept`, next);
  assert.equal(accepted.card.stageId, lanes[1].id);
  assert.equal(accepted.card.placementVersion, 3);
});

test('permission grants cannot expand on a changed request or configuration and native invalidations reject answers', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  const request = f.codex.request(send, 'item/permissions/requestApproval', { permissions: { fileSystem: { read: ['/tmp/chosen'] } } });
  const pending = (await f.chat(card.id)).requests.find((r) => r.status === 'pending');
  await f.ok('POST', `/api/cards/${card.id}/chat/answer`, { requestId: pending.id, response: { decision: 'accept', scope: 'conversation' } });
  assert.deepEqual(request.results, [{ permissions: { fileSystem: { read: ['/tmp/chosen'] } }, scope: 'turn' }]);
  const expanded = f.codex.request(send, 'item/permissions/requestApproval', { permissions: { fileSystem: { write: ['/tmp/chosen'] } } });
  assert.deepEqual(expanded.results, []);
  const open = (await f.chat(card.id)).requests.find((r) => r.status === 'pending');
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/answer`, { requestId: open.id, response: { permissions: { network: { enabled: true } }, scope: 'session' } })).status, 400);
  f.codex.emit(send.threadId, { type: 'request-invalidated', turnId: send.turnId, requestId: expanded.requestId });
  assert.equal((await f.chat(card.id)).requests.find((r) => r.id === open.id).status, 'invalidated');
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/answer`, { requestId: open.id, response: { decision: 'accept' } })).status, 409);
  await f.ok('PUT', '/api/providers/codex', { revision: 0, selection: { instructions: 'Updated configuration', selected: [] } });
  assert.equal((await f.chat(card.id)).conversations[0].grants.length, 1);
  await f.ok('POST', `/api/cards/${card.id}/chat/revoke-grants`, {});
  assert.deepEqual((await f.chat(card.id)).conversations[0].grants, []);
  const denied = f.codex.request(send); const last = (await f.chat(card.id)).requests.find((r) => r.status === 'pending');
  await f.ok('POST', `/api/cards/${card.id}/chat/answer`, { requestId: last.id, response: { decision: 'decline' } });
  assert.deepEqual(denied.results, [{ decision: 'decline' }]);
});

test('registered rendered images are originating-workspace outputs, never automatic gallery or role changes', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  const workspace = path.join(f.dataDir, 'workspaces', card.id); await mkdir(workspace, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(workspace, 'rendered.png'), png);
  await writeFile(path.join(f.dataDir, 'outside.png'), png);
  await symlink(path.join(f.dataDir, 'outside.png'), path.join(workspace, 'escape.png'));
  assert.equal((await f.codex.tool(send, 'register_image', { path: '../outside.png' })).success, false);
  assert.equal((await f.codex.tool(send, 'register_image', { path: 'escape.png' })).success, false);
  const registered = await f.codex.tool(send, 'register_image', { path: 'rendered.png', name: 'Rendered output' }, 'render-call');
  assert.equal(registered.success, true);
  assert.deepEqual(await f.codex.tool(send, 'register_image', { path: 'rendered.png', name: 'Rendered output' }, 'render-call'), registered);
  const saved = (await f.ok('GET', `/api/cards/${card.id}`)).card;
  assert.deepEqual(saved.images, []); assert.equal(saved.imageRoles.cover, null);
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  const output = (await f.chat(card.id)).items.find((i) => i.kind === 'registeredImage');
  assert.equal(output.data.provider, 'codex'); assert.equal(output.data.creationMethod, 'code-rendered');
  assert.equal((await f.codex.tool(send, 'register_image', { path: 'rendered.png' })).success, false);
  assert.ok(!(await f.ok('GET', '/api/chat-activity')).entries.some((e) => e.cardId === card.id && e.state === 'done'));
});

test('stale proposals and selected reply text require a new preview and recheck its destination', async (t) => {
  const f = await fixture(t); const card = await f.card({ title: 'Before' });
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  await f.codex.tool(send, 'propose_changes', { fields: { title: 'Proposed title' }, baseVersions: card.fieldVersions });
  const proposal = (await f.chat(card.id)).proposals[0];
  const newer = await f.ok('PATCH', `/api/cards/${card.id}`, { revision: card.revision, title: 'Newer title' });
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/proposals/${proposal.id}/accept`, { fields: ['title'], baseVersions: newer.fieldVersions })).status, 409);
  const review = await f.ok('POST', `/api/cards/${card.id}/chat/proposals/${proposal.id}/preview`, {});
  assert.equal(review.before.title, 'Newer title');
  await f.ok('POST', `/api/cards/${card.id}/chat/proposals/${proposal.id}/accept`, { fields: ['title'], baseVersions: review.baseVersions, reviewId: review.reviewId });
  f.codex.finish(send, 'interrupted', 'Retained partial choice');
  const item = (await f.chat(card.id)).items.find((i) => i.kind === 'agentMessage');
  const selection = { field: 'title', text: 'partial choice', mode: 'replace', itemSequence: item.sequence };
  const preview = await f.ok('POST', `/api/cards/${card.id}/chat/text-preview`, selection);
  const current = (await f.ok('GET', `/api/cards/${card.id}`)).card;
  await f.ok('PATCH', `/api/cards/${card.id}`, { revision: current.revision, title: 'Typed after preview' });
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/accept-text`, { ...selection, ...preview })).status, 409);
  const refreshed = await f.ok('POST', `/api/cards/${card.id}/chat/text-preview`, selection);
  await f.ok('POST', `/api/cards/${card.id}/chat/accept-text`, { ...selection, ...refreshed });
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.title, 'partial choice');
});

test('scoped approvals answer per operation, survive restart, and reset on fresh context', async (t) => {
  const f = await fixture(t); const card = await f.card();
  await f.queue(card.id, await f.compose(card.id)); const send = await waitFor(() => f.codex.sends[0]);
  const first = f.codex.request(send); const request = (await f.chat(card.id)).requests[0];
  await f.ok('POST', `/api/cards/${card.id}/chat/answer`, { requestId: request.id, response: { decision: 'accept', scope: 'conversation' } });
  assert.deepEqual(first.results, [{ decision: 'accept' }]);
  const repeated = f.codex.request(send);
  assert.deepEqual(repeated.results, [{ decision: 'accept' }]);
  assert.equal((await f.chat(card.id)).conversations[0].grants.length, 1);
  f.codex.finish(send); await f.restart();
  await f.queue(card.id, await f.compose(card.id)); const second = await waitFor(() => f.codex.sends[1]);
  assert.deepEqual(f.codex.request(second).results, [{ decision: 'accept' }]);
  const input = f.codex.request(second, 'item/tool/requestUserInput', { questions: [{ id: 'choice', question: 'Choose text' }] });
  const pending = (await f.chat(card.id)).requests.find((r) => r.status === 'pending');
  await f.ok('POST', `/api/cards/${card.id}/chat/answer`, { requestId: pending.id, response: { answers: { choice: { answers: ['Chosen'] } } } });
  assert.deepEqual(input.results, [{ answers: { choice: { answers: ['Chosen'] } } }]);
  f.codex.finish(second);
  await f.ok('POST', `/api/cards/${card.id}/chat/fresh`, { cancelQueued: true });
  await f.queue(card.id, await f.compose(card.id)); const third = await waitFor(() => f.codex.sends[2]);
  const fresh = f.codex.request(third); assert.deepEqual(fresh.results, []);
  const last = (await f.chat(card.id)).requests.find((r) => r.status === 'pending');
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/answer`, { requestId: last.id, response: { decision: 'acceptForSession' } })).status, 400);
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/answer`, { requestId: last.id, response: { decision: 'accept' } })).status, 409);
});

test('native card tools apply only requested matching fields and retain suggestions and dirty conflicts', async (t) => {
  const f = await fixture(t); const card = await f.card({ title: 'Original', fields: { intro: 'Saved intro' } });
  await f.queue(card.id, await f.compose(card.id, 'Rewrite title and intro', 'test-model', { authority: { fields: ['title', 'intro'] } }));
  const send = await waitFor(() => f.codex.sends[0]);
  assert.ok(f.codex.threads.get(send.threadId).config.dynamicTools.some((tool) => tool.name === 'edit_fields'));
  await f.ok('PUT', `/api/cards/${card.id}/draft-lease`, { owner: 'second-tab', fields: ['intro'] });
  const result = await f.codex.tool(send, 'edit_fields', { fields: { title: 'Agent title', intro: 'Agent intro', script: 'Suggestion' }, baseVersions: card.fieldVersions });
  assert.equal(result.success, true);
  const saved = (await f.ok('GET', `/api/cards/${card.id}`)).card;
  assert.equal(saved.title, 'Agent title'); assert.equal(saved.fields.intro, 'Saved intro'); assert.equal(saved.fields.script, '');
  const proposal = (await f.chat(card.id)).proposals[0];
  assert.deepEqual(proposal.payload.fields, { intro: 'Agent intro', script: 'Suggestion' });
  assert.equal((await f.call('POST', `/api/cards/${card.id}/chat/proposals/${proposal.id}/accept`, { fields: ['intro'], baseVersions: saved.fieldVersions })).status, 409);
  await f.ok('PUT', `/api/cards/${card.id}/draft-lease`, { owner: 'second-tab', fields: [] });
  await f.ok('POST', `/api/cards/${card.id}/chat/proposals/${proposal.id}/accept`, { fields: ['intro'], baseVersions: saved.fieldVersions });
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.fields.intro, 'Agent intro');
  assert.equal((await f.chat(card.id)).proposals[0].status, 'pending');
  const other = await f.card();
  assert.equal((await f.codex.tool(send, 'edit_fields', { cardId: other.id, fields: { title: 'Wrong card' }, baseVersions: other.fieldVersions })).success, false);
  await f.ok('POST', `/api/cards/${card.id}/chat/stop`, {});
  assert.equal((await f.codex.tool(send, 'edit_fields', { fields: { title: 'Late mutation' }, baseVersions: saved.fieldVersions })).success, false);
  assert.equal((await f.ok('GET', `/api/cards/${card.id}`)).card.title, 'Agent title');
});
