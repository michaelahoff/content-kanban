import test from 'node:test';
import assert from 'node:assert/strict';
import { planInputs } from '../submission-inputs.js';
import { fileFormat } from '../public/library-format.js';

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

test('a Codex setup without its shell tool has no route for a file and refuses it by name, keeping text and images usable', () => {
  const plan = planInputs('codex', [script, logo, video], { textBytes: 0, shellTool: false });
  assert.deepEqual(plan.problems.map(({ key, phase }) => ({ key, phase })), [{ key: 'asset:video', phase: 'capability' }]);
  assert.match(plan.problems[0].reason, /shell tool/);
  assert.deepEqual(planInputs('codex', [script, logo], { textBytes: 0, shellTool: false }).problems, []);
});

test('PDFs, audio, video, archives and fonts are recognized by their signatures, never by filename', () => {
  const at = (offset, text, size = 64) => { const bytes = Buffer.alloc(size); bytes.write(text, offset, 'latin1'); return bytes; };
  assert.equal(fileFormat(Buffer.from('%PDF-1.7\n')), 'pdf');
  assert.equal(fileFormat(at(0, 'RIFF\0\0\0\0WAVE')), 'wav');
  assert.equal(fileFormat(at(0, 'ID3')), 'mp3');
  assert.equal(fileFormat(at(4, 'ftypisom')), 'mp4');
  assert.equal(fileFormat(at(4, 'ftypM4A ')), 'm4a');
  assert.equal(fileFormat(at(4, 'ftypqt  ')), 'mov');
  assert.equal(fileFormat(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0])), 'matroska');
  assert.equal(fileFormat(Buffer.from('PK\x03\x04', 'latin1')), 'zip');
  assert.equal(fileFormat(Buffer.from([0x1f, 0x8b, 8, 0])), 'gzip');
  assert.equal(fileFormat(Buffer.from('wOF2\x00\x01', 'latin1')), 'woff2');
  assert.equal(fileFormat(Buffer.from([0, 1, 0, 0, 0, 12])), 'ttf');
  assert.equal(fileFormat(Buffer.from([0, 1, 2, 3, 255])), null);
  assert.equal(fileFormat(at(8, 'WAVE')), null, 'WAVE needs its RIFF container');
  assert.equal(fileFormat(at(4, 'ftypheic')), 'heif', 'an ISO still image is not video');
  assert.equal(fileFormat(at(4, 'ftypzzzz')), null);
  assert.equal(fileFormat(at(257, 'ustar', 512)), 'tar');
});

test('Claude names the unproven PDF, audio and video routes; Codex gets a tool copy, never a modality input', () => {
  const pdf = { key: 'asset:brief', label: 'brief.pdf', kind: 'file', format: 'pdf', size: 1000 };
  const audio = { key: 'asset:vo', label: 'vo.wav', kind: 'file', format: 'wav', size: 1000 };
  const film = { ...video, format: 'mp4' };
  const plan = planInputs('claude', [pdf, audio, film], { textBytes: 0 });
  assert.deepEqual(plan.problems.map(({ key, phase }) => ({ key, phase })), [pdf, audio, film].map(({ key }) => ({ key, phase: 'capability' })));
  assert.match(plan.problems[0].reason, /PDF/);
  assert.match(plan.problems[1].reason, /audio/);
  assert.match(plan.problems[2].reason, /video/);
  assert.deepEqual(planInputs('codex', [pdf, audio, film], { textBytes: 0 }).inputs.map((input) => input.method), ['copy', 'copy', 'copy']);
});
