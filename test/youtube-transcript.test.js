import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { fetchYoutubeTranscript, transcriptFromJson3 } from '../youtube-transcript.js';
import { validateTemplate, transcriptField } from '../public/card-template.js';
import { ControlledCodex } from './support/controlled-codex.js';

const captionEvents = (...captions) => captions.map((text, index) => ({ tStartMs: 1000 * (index + 1), dDurationMs: 900, segs: [{ utf8: text }] }));
const json3 = (...captions) => JSON.stringify({ wireMagic: 'pb3', events: [{ tStartMs: 0, dDurationMs: 9000 }, ...captionEvents(...captions)] });

test('turns json3 captions into clean running prose', () => {
  // A rolling window shows each line twice (once as the second line, once as the first),
  // and a lone newline segment only marks a break.
  const rolling = { events: [
    { tStartMs: 0, dDurationMs: 60000, id: 1, wpWinPosId: 1 },
    { tStartMs: 500, dDurationMs: 2000, segs: [{ utf8: 'Hear' }, { utf8: ' that?', tOffsetMs: 160 }] },
    { tStartMs: 2000, dDurationMs: 500, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 2010, dDurationMs: 3000, segs: [{ utf8: "that's  nothing at all" }, { utf8: '\n' }, { utf8: 'which is   what I​ have' }] },
    { tStartMs: 4000, dDurationMs: 3000, segs: [{ utf8: 'which is what I have\nfor you all.' }] },
    { tStartMs: 6000, dDurationMs: 1000, segs: [{ utf8: 'for you all.' }] },
  ] };
  assert.equal(transcriptFromJson3(rolling), "Hear that? that's nothing at all which is what I have for you all.");
  assert.equal(transcriptFromJson3(JSON.stringify(rolling)), transcriptFromJson3(rolling), 'a JSON string reads the same');
  // Real repeats that are not neighbors stay.
  assert.equal(transcriptFromJson3({ events: captionEvents('No.', 'Yes.', 'No.') }), 'No. Yes. No.');
  for (const empty of [{}, { events: [] }, { events: [{ tStartMs: 0 }, { segs: [{ utf8: '\n' }] }] }, null]) assert.equal(transcriptFromJson3(empty), '');
});

test('starts a paragraph at a pause after a sentence, and only then', () => {
  const at = (tStartMs, utf8) => ({ tStartMs, dDurationMs: 1000, segs: [{ utf8 }] });
  assert.equal(transcriptFromJson3({ events: [at(0, 'First part.'), at(1500, 'Still going.'), at(9000, 'A new thought.')] }), 'First part. Still going.\n\nA new thought.');
  assert.equal(transcriptFromJson3({ events: [at(0, 'and then we'), at(9000, 'kept going')] }), 'and then we kept going', 'a pause mid-sentence does not break');
  // Without pauses a long paragraph still breaks at a sentence end.
  const sentence = 'This sentence is about fifty characters long, give or take.';
  const events = Array.from({ length: 30 }, (_, index) => at(index * 1100, sentence));
  const text = transcriptFromJson3({ events: events.map((event, index) => ({ ...event, segs: [{ utf8: `${sentence} ${index}.` }] })) });
  const paragraphs = text.split('\n\n');
  assert.ok(paragraphs.length > 1);
  assert.ok(paragraphs.every((paragraph) => paragraph.length < 800), paragraphs.map((paragraph) => paragraph.length).join());
});

// A stand-in for yt-dlp. What it does follows the video id at the end of its
// command line; json3 files it writes come from fixtures beside it, and every
// command line is logged so the tests can see what was asked.
async function fakeYtDlp(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameboard-fake-ytdlp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixtures = { manual: json3('Manual captions, written by a person.'), auto: json3('automatic captions with no punctuation'), german: json3('Deutsche Untertitel von Menschen.'), spanish: json3('Subtitulos automaticos en espanol.'), translated: json3('Automatic English translation of the Spanish.') };
  for (const [name, text] of Object.entries(fixtures)) await writeFile(path.join(dir, `${name}.json3`), text);
  const script = path.join(dir, 'yt-dlp');
  await writeFile(script, `#!/bin/sh
here=$(dirname "$0")
echo "$*" >> "$here/calls.log"
prev=; out=; langs=; write_auto=no
for arg in "$@"; do
  [ "$prev" = -o ] && out=$arg
  [ "$prev" = --sub-langs ] && langs=$arg
  [ "$arg" = --write-auto-sub ] && write_auto=yes
  prev=$arg; url=$arg
done
case "$url" in
  *manualEn111) printf 'en\\n{"en": [], "de": []}\\n'; cp "$here/manual.json3" "$out.en.json3"; cp "$here/auto.json3" "$out.en-orig.json3" ;;
  *autoOnly111) printf 'en\\nNA\\n'; cp "$here/auto.json3" "$out.en-orig.json3"; cp "$here/auto.json3" "$out.en.json3" ;;
  *noCaptions1) printf 'NA\\nNA\\n' ;;
  *germanOnly1)
    if [ $write_auto = yes ]; then printf 'de\\n{"ar": [], "de": []}\\n'; else cp "$here/german.json3" "$out.$langs.json3"; fi ;;
  *spanishAut1) printf 'es\\nNA\\n'; cp "$here/spanish.json3" "$out.es-orig.json3"; cp "$here/translated.json3" "$out.en.json3" ;;
  *privateVid1) echo 'ERROR: [youtube] privateVid1: Private video. Sign in if you have been granted access.' >&2; exit 1 ;;
  *rateLimit01) printf 'en\\nNA\\n'; echo "WARNING: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests" >&2 ;;
  *slowVideo11) exec sleep 30 ;;
esac
`);
  await chmod(script, 0o755);
  const calls = async () => (existsSync(path.join(dir, 'calls.log')) ? (await readFile(path.join(dir, 'calls.log'), 'utf8')).trim().split('\n') : []);
  return { command: script, dir, calls };
}
const tempDirs = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('frameboard-captions-'));

test('prefers English manual captions and asks yt-dlp for json3 in a directory it then removes', async (t) => {
  const fake = await fakeYtDlp(t);
  const before = await tempDirs();
  const result = await fetchYoutubeTranscript('manualEn111', { command: fake.command });
  assert.deepEqual(result, { text: 'Manual captions, written by a person.', language: 'en', kind: 'manual' });
  const calls = await fake.calls();
  assert.equal(calls.length, 1, 'one spawn is enough when English exists');
  for (const flag of ['--skip-download', '--no-playlist', '--write-sub', '--write-auto-sub', '--sub-format json3', 'https://www.youtube.com/watch?v=manualEn111']) assert.ok(calls[0].includes(flag), `${flag} in ${calls[0]}`);
  assert.match(calls[0], /--sub-langs en,en-US,en-GB,en-orig,\[a-z\]\+-orig/);
  const dir = path.dirname(calls[0].match(/-o (\S+)/)[1]);
  assert.ok(!existsSync(dir), 'the temporary directory is gone');
  assert.deepEqual(await tempDirs(), before);
});

test('falls back to the automatic track, reporting its kind, and drops translations of another language', async (t) => {
  const fake = await fakeYtDlp(t);
  assert.deepEqual(await fetchYoutubeTranscript('autoOnly111', { command: fake.command }), { text: 'automatic captions with no punctuation', language: 'en', kind: 'auto' });
  // A Spanish video: its automatic "en" is a machine translation, so the Spanish original is used.
  assert.deepEqual(await fetchYoutubeTranscript('spanishAut1', { command: fake.command }), { text: 'Subtitulos automaticos en espanol.', language: 'es', kind: 'auto' });
});

test('with no English track takes the manual track in the video\'s own language with a second spawn', async (t) => {
  const fake = await fakeYtDlp(t);
  assert.deepEqual(await fetchYoutubeTranscript('germanOnly1', { command: fake.command }), { text: 'Deutsche Untertitel von Menschen.', language: 'de', kind: 'manual' });
  const calls = await fake.calls();
  assert.equal(calls.length, 2);
  assert.match(calls[1], /--write-sub --sub-langs de /);
  assert.ok(!calls[1].includes('--write-auto-sub'));
});

test('a video without captions reports that, as 404', async (t) => {
  const fake = await fakeYtDlp(t);
  const before = await tempDirs();
  await assert.rejects(fetchYoutubeTranscript('noCaptions1', { command: fake.command }), { status: 404, message: 'This video has no captions, so there is no transcript to fetch.' });
  assert.deepEqual(await tempDirs(), before, 'the temporary directory is removed on failure too');
});

test('maps yt-dlp failures to statuses and messages a user understands', async (t) => {
  const fake = await fakeYtDlp(t);
  await assert.rejects(fetchYoutubeTranscript('privateVid1', { command: fake.command }), { status: 502, message: /private, age-restricted or removed/ });
  await assert.rejects(fetchYoutubeTranscript('rateLimit01', { command: fake.command }), { status: 502, message: /internet connection/ });
  await assert.rejects(fetchYoutubeTranscript('manualEn111', { command: path.join(fake.dir, 'not-installed') }), { status: 501, message: /needs yt-dlp/ });
  await assert.rejects(fetchYoutubeTranscript('not a video id', { command: fake.command }), { status: 400 });
});

test('kills yt-dlp when it takes too long', async (t) => {
  const fake = await fakeYtDlp(t);
  const before = await tempDirs();
  const started = Date.now();
  await assert.rejects(fetchYoutubeTranscript('slowVideo11', { command: fake.command, timeoutMs: 300 }), { status: 504, message: /took too long/ });
  assert.ok(Date.now() - started < 5000, 'it did not wait for the 30 second sleep');
  assert.deepEqual(await tempDirs(), before);
});

// The lookup route with a stand-in YouTube and a stand-in transcript fetch.
async function lookup(t, transcript) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameboard-transcript-'));
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16]);
  const fakeYoutube = async (url) => (url.startsWith('https://www.youtube.com/oembed') ? new Response(JSON.stringify({ title: 'A talk worth reading' })) : new Response(jpeg));
  const app = await createApp({ dataDir, fetch: fakeYoutube, transcript, codexAdapter: new ControlledCodex(dataDir) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  return async (body) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/youtube`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://youtu.be/62NJbICVWkQ', ...body }) });
    return { status: response.status, body: await response.json() };
  };
}

test('POST /api/youtube returns the transcript only when asked, and a transcript problem never fails the lookup', async (t) => {
  const asked = [];
  const post = await lookup(t, async (videoId) => { asked.push(videoId); return { text: 'hello world', language: 'en', kind: 'auto' }; });
  const withTranscript = await post({ transcript: true });
  assert.equal(withTranscript.status, 201);
  assert.equal(withTranscript.body.title, 'A talk worth reading');
  assert.match(withTranscript.body.image.id, /^[a-f0-9-]{36}\.jpg$/);
  assert.deepEqual(withTranscript.body.transcript, { text: 'hello world', language: 'en', kind: 'auto' });
  assert.ok(!('transcriptError' in withTranscript.body));
  assert.deepEqual(asked, ['62NJbICVWkQ']);

  for (const body of [{}, { transcript: false }, { transcript: 'yes' }]) {
    const plain = await post(body);
    assert.equal(plain.status, 201);
    assert.ok(!('transcript' in plain.body) && !('transcriptError' in plain.body), JSON.stringify(plain.body));
  }
  assert.equal(asked.length, 1, 'the transcript was not fetched without transcript: true');
});

test('POST /api/youtube reports a failed transcript beside the title and thumbnail', async (t) => {
  const message = 'This video has no captions, so there is no transcript to fetch.';
  const post = await lookup(t, async () => { throw Object.assign(new Error(message), { status: 404 }); });
  const result = await post({ transcript: true });
  assert.equal(result.status, 201);
  assert.equal(result.body.title, 'A talk worth reading');
  assert.ok(result.body.image.id);
  assert.equal(result.body.transcriptError, message);
  assert.ok(!('transcript' in result.body));
});

test('a template may have one transcript text area and nothing else may take the flag', () => {
  const check = (fields) => validateTemplate({ name: 'Talk notes', fields });
  const script = { key: 'script', label: 'Script', control: 'textarea', max: 20000, transcript: true };
  const accepted = check([{ key: 'link', label: 'Link', control: 'url', youtube: true }, script, { key: 'outline', label: 'Outline', control: 'textarea' }]);
  assert.deepEqual(accepted.errors, []);
  assert.equal(accepted.template.fields.find((field) => field.key === 'script').transcript, true);
  assert.equal(transcriptField(accepted.template).key, 'script');
  assert.ok(!('transcript' in accepted.template.fields.find((field) => field.key === 'outline')));
  assert.equal(transcriptField(validateTemplate({ name: 'Plain', fields: [{ key: 'script', label: 'Script', control: 'textarea' }] }).template), null);

  assert.match(check([{ key: 'headline', label: 'Headline', control: 'text', transcript: true }]).errors.join(' '), /only a text area can receive a YouTube transcript/);
  assert.match(check([{ key: 'link', label: 'Link', control: 'url', transcript: true }]).errors.join(' '), /only a text area/);
  assert.match(check([script, { key: 'copyOfScript', label: 'Copy of script', control: 'textarea', transcript: true }]).errors.join(' '), /only one field can receive the YouTube transcript/);
  assert.match(check([{ ...script, transcript: 'yes' }]).errors.join(' '), /transcript must be true or false/);
});
