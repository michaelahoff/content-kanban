import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, waitFor } from './support/chat-fixture.js';
import { assetPreview, previewPolicy, previewType } from '../public/library-format.js';

const page = '<!doctype html><html><head><style>body { font: 16px sans-serif; }</style></head><body><h1>Mockup</h1><script>document.title = "ran";</script></body></html>';

// A finished card chat reply, saved as documents the way the Save as document dialog does.
async function savedDocuments(t, reply) {
  const f = await fixture(t); const card = await f.card({ title: 'Landing page' });
  const submission = await f.queue(card.id, await f.compose(card.id));
  const send = await waitFor(() => f.codex.sends.find((entry) => entry.clientUserMessageId && !entry.done));
  send.done = true;
  f.codex.finish(send, 'completed', reply);
  const chat = await waitFor(async () => { const value = await f.chat(card.id); return value.submissions.find((s) => s.id === submission.id).status === 'completed' && value; });
  const item = chat.items.find((entry) => entry.kind === 'agentMessage' && entry.text === reply);
  const save = async (filename) => {
    const saved = await f.call('POST', `/api/cards/${card.id}/chat/saved-outputs`, { operation: randomUUID(), sequence: item.sequence, filename });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    return saved.body;
  };
  const content = (output, query = '') => f.raw(`/api/cards/${card.id}/chat/saved-outputs/${output.id}/content${query}`);
  return { f, card, save, content };
}

test('a saved .html document previews inline as a sandboxed page, and downloads as an attachment otherwise', async (t) => {
  const { save, content } = await savedDocuments(t, page);
  const mockup = await save('mockup.html');
  assert.equal(mockup.status, 'saved');

  const inline = await content(mockup, '?inline=1');
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(inline.headers.get('content-disposition'), /^inline;/);
  const policy = inline.headers.get('content-security-policy');
  assert.equal(policy, previewPolicy('html'));
  assert.match(policy, /sandbox allow-scripts/);
  assert.match(policy, /frame-ancestors 'self'/);
  assert.doesNotMatch(policy, /allow-same-origin/, 'The page must not share this app’s origin');
  assert.match(policy, /connect-src 'none'/, 'The page cannot reach this app’s API');
  assert.equal(await inline.text(), page, 'The page is served exactly as saved');

  const download = await content(mockup);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="mockup\.html"/);
  assert.equal(download.headers.get('content-security-policy'), previewPolicy(null));
  assert.equal(await download.text(), page);
});

test('a saved .md document still previews as plain text, never as a page', async (t) => {
  const { save, content } = await savedDocuments(t, page);
  const notes = await save('notes.md');
  const inline = await content(notes, '?inline=1');
  assert.equal(inline.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(inline.headers.get('content-security-policy'), previewPolicy('text'));
  assert.doesNotMatch(inline.headers.get('content-security-policy'), /allow-scripts/);
  assert.equal(await inline.text(), page);
});

test('preview policies: HTML runs its own scripts in a sandbox, images and text run nothing', () => {
  const html = previewPolicy('html');
  assert.match(html, /^default-src 'none';/);
  assert.match(html, /script-src 'unsafe-inline'/);
  assert.match(html, /sandbox allow-scripts$/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.equal(previewPolicy('image'), "default-src 'none'; frame-ancestors 'self'; sandbox");
  assert.equal(previewPolicy(null), "default-src 'none'; sandbox");
  assert.equal(previewPolicy('text'), "default-src 'none'; sandbox");
  for (const policy of [previewPolicy('image'), previewPolicy(null)]) assert.doesNotMatch(policy, /allow-scripts|unsafe-inline/);
});

test('only .html and .htm names are pages; a document written in the editor is text unless named for a page', () => {
  assert.deepEqual(previewType('mockup.html'), { kind: 'html', type: 'text/html; charset=utf-8' });
  assert.equal(previewType('mockup.HTM').kind, 'html');
  assert.equal(previewType('logo.svg').kind, 'image');
  assert.equal(previewType('script.md').kind, 'text');
  assert.equal(previewType('page.html.txt').kind, 'text');
  assert.equal(previewType('archive.zip'), null);
  assert.equal(assetPreview('mockup.html', { written: true }).kind, 'html');
  assert.equal(assetPreview('script.md', { written: true }).kind, 'text');
  assert.equal(assetPreview('notes', { written: true }).kind, 'text');
});
