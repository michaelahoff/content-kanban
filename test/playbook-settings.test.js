import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, playbookSettings, withSetting, withSettings, withBody, withAssets } from '../public/playbook-format.js';
import { youtubeVideoTemplate } from '../public/card-template.js';

const settingsOf = (text) => playbookSettings(parseDocument(text), youtubeVideoTemplate);
const doc = (front) => `---\n${front}\n---\n# Draft\n\nBody\n`;
// A form edit, checked the way the form relies on it: the value reads back
// exactly and nothing else in the document changed.
function roundTrip(text, key, value) {
  const before = parseDocument(text);
  const patched = withSetting(text, key, value);
  const after = parseDocument(patched);
  assert.deepEqual(after.errors, [], patched);
  assert.equal(after.body, before.body);
  assert.deepEqual(after.data[key], value, patched);
  const { [key]: _before, ...others } = before.data; const { [key]: _after, ...othersAfter } = after.data;
  assert.deepEqual(othersAfter, others);
  return patched;
}

test('form edits write text values that read back exactly: one line, several lines, separators, special characters and empty text', () => {
  const text = doc('lane: drafting\nmodel: old');
  assert.equal(roundTrip(text, 'model', 'gpt-5'), doc('lane: drafting\nmodel: gpt-5'));
  assert.equal(roundTrip(text, 'model', 'first\nsecond'), doc('lane: drafting\nmodel: |-\n  first\n  second'), 'several lines are block text');
  assert.equal(roundTrip(text, 'model', 'first\nsecond\n'), doc('lane: drafting\nmodel: |\n  first\n  second'), 'a final newline keeps the | chomp');
  roundTrip(text, 'model', 'Hello\n\n');
  roundTrip(text, 'model', '  indented first line\nsecond');
  assert.equal(roundTrip(text, 'model', 'note: keep'), doc('lane: drafting\nmodel: "note: keep"'), 'a colon separator is quoted');
  assert.equal(roundTrip(text, 'model', '[not a list]'), doc('lane: drafting\nmodel: "[not a list]"'));
  assert.equal(roundTrip(text, 'model', '# not a comment'), doc('lane: drafting\nmodel: "# not a comment"'));
  roundTrip(text, 'model', 'say "hi" #now');
  roundTrip(text, 'model', "it's fine");
  assert.equal(roundTrip(text, 'model', ''), doc('lane: drafting\nmodel: ""'));
  roundTrip(doc('lane: drafting\nmodel: |-\n  first\n  second'), 'model', 'one line again');
});

test('form edits write lists, including empty ones and items with commas or quotes', () => {
  const text = doc('lane: drafting\ncontext: [title, intro]');
  assert.equal(roundTrip(text, 'context', ['title', 'script']), doc('lane: drafting\ncontext: [title, script]'));
  assert.equal(roundTrip(text, 'context', []), doc('lane: drafting\ncontext: []'));
  roundTrip(text, 'context', ['Title, with comma', "it's", 'say "hi"', 'a #b', '', '[x]']);
  assert.equal(roundTrip(doc('lane: drafting\nmay_edit:\n  - intro\n  - script'), 'may_edit', ['title']), doc('lane: drafting\nmay_edit: [title]'), 'a block list is written inline');
});

test('form edits write maps with block text for several lines, and remove a setting cleanly', () => {
  const text = doc('lane: drafting\nset:\n  title: Old\nrun: manual');
  assert.equal(roundTrip(text, 'set', { title: 'New', intro: 'Hook:\nthe idea\n' }), doc('lane: drafting\nset:\n  title: New\n  intro: |\n    Hook:\n    the idea\nrun: manual'));
  roundTrip(text, 'set', { title: 'Episode #3, part 2', script: '' });
  roundTrip(doc('lane: drafting\nset:\n  intro: |+\n    Hello\n\n\nrun: manual'), 'set', { title: 'X', intro: 'Hello\n\n' });
  assert.equal(roundTrip(text, 'set', undefined), doc('lane: drafting\nrun: manual'), 'removing takes the whole block');
  assert.equal(withSetting(text, 'set', {}), doc('lane: drafting\nrun: manual'), 'an empty map removes the setting');
  assert.equal(withSetting(text, 'skills', undefined), text, 'removing an absent setting changes nothing');
  assert.equal(roundTrip(doc('model: |-\n  a\n  b'), 'model', undefined), '---\n---\n# Draft\n\nBody\n', 'the settings block may end up empty');
});

test('a comment on the key line survives, after a one-line value or after the key of a block', () => {
  assert.equal(roundTrip(doc('run: manual # Start on request\nlane: x'), 'run', 'off'), doc('run: off # Start on request\nlane: x'));
  assert.equal(roundTrip(doc('model: "a #b" # Keep'), 'model', 'c'), doc('model: c # Keep'), 'a hash inside quoted text is not a comment');
  assert.equal(roundTrip(doc('set: # Fields to set\n  title: Old'), 'set', { title: 'New' }), doc('set: # Fields to set\n  title: New'));
  assert.equal(roundTrip(doc('model: old # Model'), 'model', 'a\nb'), doc('model: |- # Model\n  a\n  b'));
  assert.equal(roundTrip(doc('context: [title] # Sent'), 'context', ['intro']), doc('context: [intro] # Sent'));
  assert.equal(roundTrip(doc('run:# tight'), 'run', 'off'), doc('run: off # tight'));
});

test('comments, blank lines and the order of other settings survive byte for byte', () => {
  const head = 'lane: drafting   # Drafting lane\nrun: manual\n# Settings below are reviewed weekly\n\nset:\n  intro: |\n    assets: [asset:not-a-setting]\n\n  # nested note\n  title: Hi\n\n# about may_edit\n';
  const tail = 'may_edit: [intro]';
  assert.equal(roundTrip(doc(`${head}${tail}`), 'run', 'off'), doc(`${head.replace('run: manual', 'run: off')}${tail}`));
  assert.equal(roundTrip(doc(`${head}${tail}`), 'set', { title: 'Bye' }), doc(`${head.replace(/set:[\s\S]*?title: Hi/, 'set:\n  title: Bye')}${tail}`), 'the trailing blank line and the comment before may_edit stay in place');
  assert.equal(roundTrip(doc(`${head}${tail}`), 'set', undefined), doc(`${head.replace(/set:[\s\S]*?title: Hi\n/, '')}${tail}`));
  assert.equal(roundTrip(doc(`${head}${tail}`), 'may_edit', ['title']), doc(`${head}may_edit: [title]`));
});

test('earlier copies of a repeated setting collapse into the last one, which is the one that counts', () => {
  assert.equal(roundTrip(doc('run: off\n# second thoughts\nrun: manual\nlane: x'), 'run', 'on-enter'), doc('# second thoughts\nrun: on-enter\nlane: x'));
  assert.equal(roundTrip(doc('set:\n  title: A\nlane: x\nset:\n  title: B'), 'set', { title: 'C' }), doc('lane: x\nset:\n  title: C'));
  assert.equal(roundTrip(doc('model: a\nmodel: b\nlane: x'), 'model', undefined), doc('lane: x'));
});

test('an absent setting is added before the closing ---, and a document without settings gains a block', () => {
  assert.equal(roundTrip(doc('lane: drafting\nrun: manual'), 'model', 'gpt-5'), doc('lane: drafting\nrun: manual\nmodel: gpt-5'));
  assert.equal(roundTrip(doc('lane: drafting\n# trailing note'), 'context', ['title']), doc('lane: drafting\n# trailing note\ncontext: [title]'));
  assert.equal(roundTrip('---\n---\nBody', 'run', 'off'), '---\nrun: off\n---\nBody', 'an empty settings block');
  assert.equal(roundTrip('# Unattached\n\nNo settings yet.', 'run', 'off'), '---\nrun: off\n---\n# Unattached\n\nNo settings yet.');
  assert.equal(roundTrip('', 'set', { title: 'T' }), '---\nset:\n  title: T\n---\n');
  const rule = '---\nA paragraph.\n---\nAnother paragraph.';
  assert.equal(roundTrip(rule, 'lane', 'x'), `---\nlane: x\n---\n${rule}`, 'a leading horizontal rule is body');
  assert.equal(withSetting('# Unattached', 'run', undefined), '# Unattached');
});

test('Windows line endings stay throughout', () => {
  assert.equal(roundTrip('---\r\nlane: x\r\nrun: manual # Note\r\n---\r\nBody\r\n', 'run', 'off'), '---\r\nlane: x\r\nrun: off # Note\r\n---\r\nBody\r\n');
  assert.equal(roundTrip('---\r\nlane: x\r\n---\r\nBody\r\n', 'set', { title: 'A', intro: 'b\nc' }), '---\r\nlane: x\r\nset:\r\n  title: A\r\n  intro: |-\r\n    b\r\n    c\r\n---\r\nBody\r\n');
  assert.equal(roundTrip('---\r\nlane: x\r\nset:\r\n  title: A\r\n---\r\nBody\r\n', 'set', undefined), '---\r\nlane: x\r\n---\r\nBody\r\n');
  assert.equal(roundTrip('# Title\r\n\r\nBody\r\n', 'run', 'off'), '---\r\nrun: off\r\n---\r\n# Title\r\n\r\nBody\r\n');
  assert.equal(withBody('---\r\nlane: x\r\n---\r\nOld\r\n', 'New'), '---\r\nlane: x\r\n---\r\nNew');
});

test('a draft whose settings cannot be read, or a change that would touch anything else, is refused with status 400', () => {
  const broken = '---\nlane: drafting\nassets: [asset:script-1\n---\nBody';
  assert.throws(() => withSetting(broken, 'run', 'off'), (error) => error.status === 400 && /^Fix the settings in Markdown before changing settings with the form: Line 3: Close the \[list\]\./.test(error.message));
  assert.throws(() => withSetting('---\nlane: x\nBody', 'run', 'off'), (error) => error.status === 400 && /Close the settings block/.test(error.message));
  assert.throws(() => withSetting(doc('lane: x'), 'bad key', 'x'), (error) => error.status === 400);
  assert.throws(() => withSetting(doc('lane: x'), '-run', 'x'), (error) => error.status === 400);
  for (const value of [5, null, ['a', 1], { a: 2 }, { a: ['x'] }]) assert.throws(() => withSetting(doc('lane: x'), 'run', value), (error) => error.status === 400, JSON.stringify(value));
  assert.throws(() => withSetting(doc('lane: x'), 'set', { 'a: b': 'x' }), (error) => error.status === 400 && /the set setting could not be changed on its own/.test(error.message), 'a nested name the parser cannot read back');
  assert.throws(() => withSettings(doc('lane: x'), { run: 'off', model: 7 }), (error) => error.status === 400);
  assert.equal(settingsOf(broken).errors[0], 'Line 3: Close the [list].', 'the broken draft is left for raw Markdown');
});

test('withSettings applies several changes in order, each kept to its own setting', () => {
  const text = doc('lane: drafting # Lane\nrun: manual\nset:\n  title: Old\nmay_edit: [intro]');
  assert.equal(withSettings(text, { run: 'off', model: 'gpt-5', set: undefined, may_edit: ['title', 'intro'], context: ['title'] }),
    doc('lane: drafting # Lane\nrun: off\nmay_edit: [title, intro]\nmodel: gpt-5\ncontext: [title]'));
  assert.equal(withSettings(text, {}), text);
  assert.equal(withSettings(text, { model: 'a', model_: 'b' }), withSetting(withSetting(text, 'model', 'a'), 'model_', 'b'));
});

test('withBody replaces the instructions and keeps the settings bytes, with or without settings', () => {
  const front = '---\nlane: drafting   # Lane\n\nset:\n  title: Hi # keep\n---';
  for (const body of ['# New\n\nInstructions.\n', 'Starts right away', '', '\n\nLeading blank lines\n']) {
    assert.equal(withBody(`${front}\nOld body\n`, body), `${front}\n${body}`);
    assert.equal(parseDocument(withBody(`${front}\nOld body\n`, body)).body, body);
    assert.equal(withBody('# No settings\n\nOld.', body), body);
    assert.equal(parseDocument(withBody('# No settings\n\nOld.', body)).body, body);
  }
  assert.equal(withBody(`${front}`, 'Body'), `${front}\nBody`, 'a closing --- at the very end gains its newline');
  assert.deepEqual(parseDocument(withBody(`${front}\nOld\n`, 'New')).data, { lane: 'drafting', set: { title: 'Hi' } });
  assert.equal(withBody('---\nA paragraph.\n---\nAnother.', 'New'), 'New', 'a leading horizontal rule is body');
});

test('withAssets still edits only the assets: setting', () => {
  assert.equal(withAssets(doc('lane: drafting\nassets: [asset:a] # Refs'), [{ kind: 'asset', id: 'a' }, { kind: 'folder', id: 'b' }]), doc('lane: drafting\nassets: [asset:a, folder:b] # Refs'));
});

test('a lane playbook edited with the form still resolves against the card template', () => {
  const text = doc('lane: drafting\nrun: manual # On request\nmay_edit: [intro]');
  const set = settingsOf(withSetting(text, 'set', { title: 'Episode #3, part 2', Intro: 'Hook:\nthe idea\n', prompt: 'Shared' }));
  assert.deepEqual(set.errors, []);
  assert.deepEqual(set.set, { title: 'Episode #3, part 2', intro: 'Hook:\nthe idea\n', prompt: 'Shared' });
  const mayEdit = settingsOf(withSetting(text, 'may_edit', ['Title Options', 'script', 'title']));
  assert.deepEqual(mayEdit.errors, []);
  assert.deepEqual(mayEdit.mayEdit, ['titleOptions', 'script', 'title']);
  const context = settingsOf(withSetting(text, 'context', ['title', 'intro', 'display', 'inspiration']));
  assert.deepEqual(context.errors, []);
  assert.deepEqual(context.selections, { fields: ['title', 'intro'], roles: ['cover', 'inspiration'] });
  assert.equal(context.run, 'manual');
  assert.deepEqual(settingsOf(withSetting(text, 'context', [])).selections, { fields: [], roles: [] });
  assert.deepEqual(settingsOf(withSettings(text, { run: 'off', provider: 'claude', conversation: 'fresh', skills: ['voice'] })).errors, []);
});

test('block text whose last line starts with # stays content when settings after it change', () => {
  const text = doc('lane: drafting');
  const value = { intro: 'Watch now\n#shorts #youtube' };
  const withSet = roundTrip(text, 'set', value);
  assert.equal(withSet, doc('lane: drafting\nset:\n  intro: |-\n    Watch now\n    #shorts #youtube'));
  const withRun = roundTrip(withSet, 'run', 'manual');
  assert.equal(withRun, doc('lane: drafting\nset:\n  intro: |-\n    Watch now\n    #shorts #youtube\nrun: manual'));
  assert.deepEqual(parseDocument(withRun).data.set, value, 'The first value is intact');
  const both = roundTrip(withRun, 'set', { ...value, title: 'Short' });
  assert.equal(both, doc('lane: drafting\nset:\n  intro: |-\n    Watch now\n    #shorts #youtube\n  title: Short\nrun: manual'));
});

test('a one-line value with a tab or no-break space before # is quoted so it is not read as a comment', () => {
  const text = doc('lane: drafting');
  for (const value of ['A\t# not a comment', 'A # not a comment']) {
    assert.equal(roundTrip(text, 'model', value), doc(`lane: drafting\nmodel: ${JSON.stringify(value)}`), JSON.stringify(value));
    assert.equal(roundTrip(text, 'set', { title: value }), doc(`lane: drafting\nset:\n  title: ${JSON.stringify(value)}`), JSON.stringify(value));
  }
});

test('withBody refuses a draft whose settings block is not closed instead of dropping the block', () => {
  assert.throws(() => withBody('---\nlane: x\nBody', 'New'), (error) => error.status === 400 && error.message.startsWith('Fix the settings in Markdown') && /Close the settings block/.test(error.message));
  assert.throws(() => withBody('---\r\nlane: x\r\nBody', 'New'), (error) => error.status === 400 && error.message.startsWith('Fix the settings in Markdown'));
});

test('a settings block that mixes LF and lone CR line endings is refused; an all-CRLF block stays patchable', () => {
  const mixed = '---\r\nlane: x\rrun: manual\r\n---\r\nBody\r\n';
  assert.deepEqual(parseDocument(mixed).data, { lane: 'x', run: 'manual' }, 'The parser reads it, so the refusal is about patching');
  assert.throws(() => withSetting(mixed, 'run', 'off'), (error) => error.status === 400 && /line endings/.test(error.message));
  assert.throws(() => withSetting(mixed, 'model', 'gpt-5'), (error) => error.status === 400 && /line endings/.test(error.message), 'adding a key is refused too');
  assert.throws(() => withSettings(mixed, { run: 'off' }), (error) => error.status === 400 && /line endings/.test(error.message));
  assert.equal(roundTrip('---\r\nlane: x\r\nrun: manual\r\n---\r\nBody\r\n', 'run', 'off'), '---\r\nlane: x\r\nrun: off\r\n---\r\nBody\r\n');
  assert.equal(roundTrip('---\r\nlane: x\r\nrun: manual\r\n---\r\nBody\r\n', 'model', 'gpt-5'), '---\r\nlane: x\r\nrun: manual\r\nmodel: gpt-5\r\n---\r\nBody\r\n');
});

test('a top-level comment and blank line after a map setting stay in place when the map is replaced or removed', () => {
  const text = doc('set:\n  title: Old\n\n# About may_edit\nmay_edit: [intro]');
  assert.equal(roundTrip(text, 'set', { title: 'New', intro: 'Hook' }), doc('set:\n  title: New\n  intro: Hook\n\n# About may_edit\nmay_edit: [intro]'));
  assert.equal(roundTrip(text, 'set', undefined), doc('\n# About may_edit\nmay_edit: [intro]'));
});
