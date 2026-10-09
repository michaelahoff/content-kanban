import test from 'node:test';
import assert from 'node:assert/strict';
import { claudePdfRoute } from '../claude-pdf-gate.js';

const pro = { apiProvider: 'firstParty', subscriptionType: 'Claude Pro' };
const record = { harness: '2.1.291', model: 'claude-haiku-4-5', account: pro, retainedDataProtection: false, pages: 100, checked: '2026-10-08' };
const setup = { harness: '2.1.291', model: 'claude-haiku-4-5', account: pro, retainedDataProtection: false };

test('a recorded passing check for the exact harness version, model and account enables Claude PDF delivery with its page limit', () => {
  assert.deepEqual(claudePdfRoute(setup, [record]), { available: true, pages: 100, checked: '2026-10-08' });
});

test('any other harness version, model or account has no route, and says what was checked', () => {
  for (const changed of [{ harness: '2.1.292' }, { harness: null }, { model: 'claude-sonnet-5-5' }, { account: { ...pro, subscriptionType: 'Claude Max' } }, { account: { ...pro, apiProvider: 'bedrock' } }, { account: null }]) {
    const route = claudePdfRoute({ ...setup, ...changed }, [record]);
    assert.equal(route.available, false, JSON.stringify(changed));
    assert.match(route.reason, /No passing PDF check is recorded/);
  }
  assert.match(claudePdfRoute({ ...setup, harness: '2.1.292' }, [record]).reason, /Claude Code 2\.1\.292/);
  assert.equal(claudePdfRoute(setup, []).available, false);
});

test('evidence gathered outside retained-data protection never enables a protected Claude', () => {
  const route = claudePdfRoute({ ...setup, retainedDataProtection: true }, [record]);
  assert.equal(route.available, false);
  assert.match(route.reason, /retained-data protection/);
});
