import test from 'node:test';
import assert from 'node:assert/strict';
import { planInputs } from '../submission-inputs.js';

const MiB = 1024 * 1024;
const script = { key: 'asset:script', label: 'script.md', kind: 'text', size: 12000 };
const logo = { key: 'asset:logo', label: 'logo.png', kind: 'image', format: 'png', size: 40000 };
const video = { key: 'asset:video', label: 'cut.mp4', kind: 'file', size: 3 * 1024 * MiB };

test('both providers receive text inline and supported rasters as native images', () => {
  for (const provider of ['codex', 'claude']) {
    const plan = planInputs(provider, [script, logo], { textBytes: 500 });
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.inputs.map((input) => input.method), ['text', 'image']);
  }
});

test('Codex reads other files from an independent copy; tool-disabled Claude refuses them by name', () => {
  assert.deepEqual(planInputs('codex', [video], { textBytes: 0 }).inputs.map((input) => input.method), ['copy']);
  const plan = planInputs('claude', [script, video], { textBytes: 0 });
  assert.equal(plan.problems.length, 1);
  assert.equal(plan.problems[0].key, 'asset:video');
  assert.match(plan.problems[0].reason, /Claude/);
});

test('an unsupported card image stops Claude even when every Library file is usable', () => {
  const avif = { key: 'image:a', label: 'Original: portrait.avif', kind: 'image', format: 'avif', size: 1000 };
  assert.deepEqual(planInputs('codex', [avif, script], { textBytes: 0 }).problems, []);
  const plan = planInputs('claude', [avif, script], { textBytes: 0 });
  assert.deepEqual(plan.problems.map((problem) => problem.key), ['image:a']);
});

test('known oversized images block; Claude has its own smaller image limit', () => {
  const big = { ...logo, size: 6 * MiB };
  assert.deepEqual(planInputs('codex', [big], { textBytes: 0 }).problems, []);
  assert.match(planInputs('claude', [big], { textBytes: 0 }).problems[0].reason, /5 MB/);
  assert.match(planInputs('codex', [{ ...logo, size: 21 * MiB }], { textBytes: 0 }).problems[0].reason, /20 MB/);
});

test('text that cannot fit any model blocks, while uncertain size only warns and permits the attempt', () => {
  const huge = { ...script, size: 9 * MiB };
  const blocked = planInputs('codex', [huge], { textBytes: 0 });
  assert.equal(blocked.problems.length, 1);
  assert.equal(blocked.problems[0].key, null, 'the whole request is too large, not one input');
  const large = { ...script, size: 1 * MiB };
  const warned = planInputs('claude', [large], { textBytes: 0 });
  assert.deepEqual(warned.problems, []);
  assert.equal(warned.warnings.length, 1);
  assert.deepEqual(planInputs('claude', [script], { textBytes: 0 }).warnings, []);
});

test('Claude refuses more images than one request accepts instead of sending a subset', () => {
  const many = Array.from({ length: 101 }, (_, index) => ({ ...logo, key: `asset:${index}` }));
  const plan = planInputs('claude', many, { textBytes: 0 });
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0].reason, /100/);
  assert.deepEqual(planInputs('codex', many, { textBytes: 0 }).problems, []);
});

test('a model that reports text-only input refuses images instead of sending text alone', () => {
  const plan = planInputs('codex', [script, logo], { textBytes: 0, model: { id: 'text-model', inputModalities: ['text'] } });
  assert.deepEqual(plan.problems.map(({ key, phase }) => ({ key, phase })), [{ key: 'asset:logo', phase: 'capability' }]);
  assert.match(plan.problems[0].reason, /text-model/);
  assert.deepEqual(planInputs('codex', [logo], { textBytes: 0, model: { id: 'vision', inputModalities: ['text', 'image'] } }).problems, []);
  assert.deepEqual(planInputs('codex', [logo], { textBytes: 0, model: { id: 'unknown' } }).problems, [], 'unknown modalities leave the decision to the provider');
});

test('Claude refuses a request whose encoded images exceed its request size even when each image fits', () => {
  const images = Array.from({ length: 7 }, (_, index) => ({ ...logo, key: `asset:${index}`, size: 4.9 * MiB }));
  const plan = planInputs('claude', images, { textBytes: 0 });
  assert.equal(plan.problems.length, 1);
  assert.equal(plan.problems[0].key, null);
  assert.match(plan.problems[0].reason, /32 MB/);
  assert.deepEqual(planInputs('claude', images.slice(0, 4), { textBytes: 0 }).problems, []);
});

test('text too large to inline names its size, not missing file tools', () => {
  const transcript = { key: 'asset:transcript', label: 'transcript.txt', kind: 'file', format: 'text', size: 9 * MiB };
  const plan = planInputs('claude', [transcript], { textBytes: 0 });
  assert.equal(plan.problems[0].phase, 'limit');
  assert.match(plan.problems[0].reason, /too much text/);
  assert.deepEqual(planInputs('codex', [transcript], { textBytes: 0 }).inputs.map((input) => input.method), ['copy']);
});
