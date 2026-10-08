import test from 'node:test';
import assert from 'node:assert/strict';

// ui.js captures the optional form dialog when its helpers load.
globalThis.document = { querySelector: () => null };
const { attemptMarkup, progressState } = await import('../public/chat-transcript.js');
delete globalThis.document;

const item = (sequence, kind, text = '', data = {}) => ({ sequence, attemptId: 'attempt', kind, text, data, completed: true });

test('provider placeholders collapse between visible replies without hiding notices or image outputs', () => {
  const entries = [
    item(1, 'agentMessage', 'I will check the reference.'),
    item(2, 'commandExecution', '', { command: 'identify image.png', aggregatedOutput: '1280x720' }),
    item(3, 'reasoning', '', { summary: ['Preserve the original headline.'] }),
    item(4, 'imageView'),
    item(5, 'agentMessage'),
    item(6, 'notice', 'Native history is unavailable.'),
    item(7, 'imageGeneration'),
    item(8, 'agentMessage', 'Here is the edited thumbnail.'),
  ];
  const html = attemptMarkup(entries, 'attempt', () => '<figure>Generated thumbnail</figure>');
  assert.equal((html.match(/class="chat-work-details"/g) ?? []).length, 1);
  assert.match(html, /Activity · 3 steps/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b|Use selected reply|data-action=/);
  assert.equal((html.match(/class="chat-reply-text"/g) ?? []).length, 2);
  const ordered = ['I will check', 'Activity · 3 steps', 'Native history', 'Generated thumbnail', 'Here is the edited'];
  for (let n = 1; n < ordered.length; n++) assert.ok(html.indexOf(ordered[n - 1]) < html.indexOf(ordered[n]));
  assert.match(html, /identify image.png\n1280x720/);
  assert.match(html, /Preserve the original headline/);
});

test('activity remains expandable on either side of a reply and escapes provider text', () => {
  const html = attemptMarkup([
    item(1, 'mcpToolCall', '<script>alert(1)</script>'),
    item(2, 'agentMessage', 'A <useful> reply'),
    item(3, 'commandExecution', '', { command: '<unsafe>' }),
  ], 'attempt', () => '');
  assert.equal((html.match(/class="chat-work-details"/g) ?? []).length, 2);
  assert.match(html, /data-detail-key="work:attempt:1"/);
  assert.match(html, /data-detail-key="work:attempt:3"/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /A &lt;useful&gt; reply/);
  assert.doesNotMatch(html, /<script>|<unsafe>/);
});

test('unfinished text is marked partial once its delivery attempt stops', () => {
  const entries = [{ ...item(1, 'agentMessage', 'An unfinished reply'), completed: false }];
  assert.match(attemptMarkup(entries, 'attempt', () => '', true), /Writing…/);
  const stopped = attemptMarkup(entries, 'attempt', () => '', false);
  assert.match(stopped, /Partial reply/);
  assert.doesNotMatch(stopped, /Writing…/);
});

test('progress describes active work and pauses while input is required', () => {
  const snapshot = { attempts: [{ id: 'attempt', status: 'running', startedAt: '2026-10-07T12:00:00Z' }],
    items: [{ ...item(1, 'imageGeneration'), completed: false }], submissions: [], requests: [] };
  assert.deepEqual(progressState(snapshot), { label: 'Creating an image…', moving: true, startedAt: snapshot.attempts[0].startedAt });
  snapshot.requests.push({ attemptId: 'attempt', status: 'pending' });
  assert.deepEqual(progressState(snapshot), { label: 'Waiting for your input', moving: false });
  snapshot.requests[0].status = 'answered';
  snapshot.items = [{ ...item(2, 'agentMessage', 'Partial reply'), completed: false }];
  assert.equal(progressState(snapshot).label, 'Writing a reply…');
  snapshot.attempts[0].status = 'interrupt-requested';
  assert.equal(progressState(snapshot).label, 'Stopping…');
  snapshot.attempts[0].status = 'completed';
  assert.equal(progressState(snapshot), null);
  snapshot.submissions.push({ status: 'waiting' });
  assert.equal(progressState(snapshot).label, 'Waiting for the provider…');
});
