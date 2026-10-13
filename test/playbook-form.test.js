import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, playbookSettings } from '../public/playbook-format.js';
import { youtubeVideoTemplate } from '../public/card-template.js';

// ui.js captures the optional form dialog when its helpers load.
globalThis.document = { querySelector: () => null };
const { renderSettingsForm, applySettingsChange } = await import('../public/playbook-form.js');
delete globalThis.document;

const doc = (front) => `---\n${front}\n---\nBody\n`;
const catalog = [{ provider: 'codex', id: 'gpt-a', displayName: 'GPT A' }, { provider: 'claude', id: 'opus', displayName: 'Opus' }];
// The editor's context for a lane playbook, or for a file not attached to a lane.
function context(text, { kind = 'lane', models = catalog, hints = false } = {}) {
  const document = parseDocument(text);
  return { text, template: youtubeVideoTemplate, document, settings: playbookSettings(document, youtubeVideoTemplate), kind,
    lanes: [{ id: 'lane-1', name: 'Ideas', taken: kind === 'lane' }], skillNames: [], models, libraryMarkup: '', hints };
}
const optionTag = (html, value) => html.match(new RegExp(`<option value="${value}"[^>]*>[^<]*</option>`))?.[0] ?? null;

test('a lane playbook has no lane row; a file not attached to a lane keeps the lane picker', () => {
  const lane = renderSettingsForm(context(doc('lane: lane-1\nrun: manual')));
  assert.ok(!lane.includes('playbook-label-lane') && !lane.includes('playbook-field-lane'));
  assert.ok(lane.indexOf('playbook-label-run') < lane.indexOf('playbook-label-agent'), 'Run is the first row');
  const file = renderSettingsForm(context(doc('run: manual'), { kind: 'file' }));
  assert.ok(file.includes('id="playbook-field-lane"'));
  assert.match(file, /<option value="lane-1"[^>]*>Ideas<\/option>/);
});

test('the model select lists the catalog grouped by provider until a provider is chosen', () => {
  const html = renderSettingsForm(context(doc('run: manual')));
  assert.ok(html.includes('<select id="playbook-field-model"'));
  assert.ok(html.includes('<optgroup label="Codex">') && html.includes('<optgroup label="Claude">'));
  assert.match(optionTag(html, 'gpt-a'), />GPT A</);
  assert.match(optionTag(html, 'opus'), />Opus</);
  assert.match(optionTag(html, ''), /selected/, 'With no model: the card chat’s model is chosen');
  const claude = renderSettingsForm(context(doc('provider: claude\nmodel: opus')));
  assert.ok(!claude.includes('<optgroup'), 'A chosen provider lists its models without groups');
  assert.equal(optionTag(claude, 'gpt-a'), null);
  assert.match(optionTag(claude, 'opus'), /selected/);
});

test('a model the catalog lacks stays selected and reads unavailable; before the catalog loads it is shown as written', () => {
  const html = renderSettingsForm(context(doc('model: made-up')));
  assert.match(optionTag(html, 'made-up'), /selected/);
  assert.match(optionTag(html, 'made-up'), /disabled/);
  assert.match(optionTag(html, 'made-up'), />made-up \(unavailable\)</);
  const loading = renderSettingsForm(context(doc('model: made-up'), { models: null }));
  assert.match(optionTag(loading, 'made-up'), /selected/);
  assert.doesNotMatch(optionTag(loading, 'made-up'), /disabled|unavailable/);
});

test('choosing a model writes its provider too when none is set, and only the model otherwise', () => {
  const both = applySettingsChange(context(doc('run: manual')), 'form-model', { value: 'opus' });
  assert.match(both, /^provider: claude$/m);
  assert.match(both, /^model: opus$/m);
  assert.match(both, /^run: manual$/m);
  const kept = applySettingsChange(context(doc('run: manual\nprovider: codex')), 'form-model', { value: 'gpt-a' });
  assert.equal(kept.match(/^provider: /gm).length, 1);
  assert.match(kept, /^provider: codex$/m);
  assert.match(kept, /^model: gpt-a$/m);
  const cleared = applySettingsChange(context(doc('provider: codex\nmodel: gpt-a')), 'form-model', { value: '' });
  assert.doesNotMatch(cleared, /^model:/m);
  assert.match(cleared, /^provider: codex$/m, 'Clearing the model keeps the provider');
});

test('the help text is marked for the sheet only while hints are on, and choice chips carry a real checkbox', () => {
  assert.ok(!renderSettingsForm(context(doc('run: manual'))).includes('playbook-form-hints'));
  const html = renderSettingsForm(context(doc('run: manual'), { hints: true }));
  assert.ok(html.includes('class="playbook-form playbook-form-hints"'));
  assert.match(html, /<label class="playbook-check"><input type="checkbox" id="playbook-field-context-all" data-playbook-action="form-context-all"[^>]*checked[^>]*><svg class="icon /);
});
