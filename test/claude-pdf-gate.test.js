import test from 'node:test';
import assert from 'node:assert/strict';
import { claudePdfRoute } from '../claude-pdf-gate.js';

const record = { harness: '2.1.291', model: 'claude-sonnet-5-5', pages: 600, checked: '2026-10-09' };

test('every Claude model has a PDF route, with the recorded page limit when one exists', () => {
  assert.deepEqual(claudePdfRoute('claude-sonnet-5-5', [record]), { available: true, pages: 600 });
  assert.deepEqual(claudePdfRoute('claude-new-model', [record]), { available: true, pages: 100 });
  assert.deepEqual(claudePdfRoute('claude-sonnet-5-5', []), { available: true, pages: 100 });
});
