// Fetches a YouTube video's captions as plain text through the installed
// yt-dlp, for the transcript field of a card template (card-template.js
// `transcript: true`). Frameboard never transcribes audio: a video without
// captions has no transcript. Nothing here touches the store.
//
// The choices come from the user's own yt-icahn research: a manual caption
// track is a person's work, so it beats YouTube's automatic one; English
// beats other languages; and the json3 caption format, unlike VTT, carries
// each line once, which makes it easy to turn into running prose. Automatic
// tracks still repeat lines in rolling windows, so the parser collapses them.
//
// yt-dlp names the tracks it writes after their language: track.en.json3 is
// English, and track.en-orig.json3 is the automatic track in the video's
// original language. YouTube also offers every automatic track machine
// translated into the other languages, so on a Spanish video an automatic
// "en" is a translation, not what was said; it is dropped in favor of the
// original. One spawn asks for English of either kind plus the original-
// language automatic track and prints which manual tracks exist, which is
// how the kind of each file is known. Only a video with no usable English
// track and a manual track in another language needs a second spawn.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const english = ['en', 'en-US', 'en-GB', 'en-orig'];
const failure = (status, message) => Object.assign(new Error(message), { status });
const tooSlow = () => failure(504, 'Fetching the transcript took too long. Try again in a moment.');
const noCaptions = () => failure(404, 'This video has no captions, so there is no transcript to fetch.');

// The captions as running prose: one line per caption line with duplicates
// that follow each other collapsed, joined into paragraphs at long pauses
// and, failing that, at sentence ends once a paragraph runs long.
export function transcriptFromJson3(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const lines = [];
  for (const event of Array.isArray(data?.events) ? data.events : []) {
    if (!Array.isArray(event?.segs)) continue;
    const start = Number(event.tStartMs) || 0;
    const end = start + (Number(event.dDurationMs) || 0);
    // A caption can hold several lines (and a lone "\n" segment only marks a break).
    for (const text of event.segs.map((seg) => seg?.utf8 ?? '').join('').split('\n')) {
      const line = text.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
      if (!line) continue;
      if (lines.at(-1)?.text === line) { lines.at(-1).end = Math.max(lines.at(-1).end, end); continue; }
      lines.push({ text: line, start, end });
    }
  }
  const sentenceEnd = /[.!?…]["'”’)\]]*$/;
  const paragraphs = [];
  let paragraph = '';
  let previousEnd = 0;
  for (const line of lines) {
    const long = paragraph.length >= 700 && sentenceEnd.test(paragraph);
    const pause = line.start - previousEnd >= 2500 && sentenceEnd.test(paragraph);
    if (paragraph && (long || pause || paragraph.length >= 1200)) { paragraphs.push(paragraph); paragraph = ''; }
    paragraph = paragraph ? `${paragraph} ${line.text}` : line.text;
    previousEnd = line.end;
  }
  if (paragraph) paragraphs.push(paragraph);
  return paragraphs.join('\n\n');
}

// Runs yt-dlp to completion, killing it if it outlives the time left.
function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { return reject(missing(error)); }
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { if (stdout.length < 8e6) stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(missing(error)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(tooSlow());
      else resolve({ code, stdout, stderr });
    });
  });
}
const missing = (error) => ['ENOENT', 'EACCES'].includes(error.code)
  ? failure(501, 'Fetching transcripts needs yt-dlp, which could not be run. Install yt-dlp and try again.')
  : failure(502, 'Could not start yt-dlp to fetch the transcript.');

// What yt-dlp's complaint means to a user.
function unreachable(stderr) {
  return /private video|video unavailable|been removed|members-only|sign in to confirm|age-restricted|not available/i.test(stderr)
    ? failure(502, "YouTube won't give out this video's captions. It may be private, age-restricted or removed.")
    : failure(502, 'Could not fetch the transcript from YouTube. Check your internet connection and try again.');
}

const tracksIn = async (dir) => (await readdir(dir)).flatMap((name) => { const match = name.match(/^track\.(.+)\.json3$/); return match ? [{ name, language: match[1] }] : []; });
// Manual track languages: the keys of the printed `subtitles`, or nothing when yt-dlp prints NA.
function manualLanguages(printed) {
  try { const subtitles = JSON.parse(printed); return new Set(subtitles && typeof subtitles === 'object' ? Object.keys(subtitles) : []); }
  catch { return new Set(); }
}

export async function fetchYoutubeTranscript(videoId, { timeoutMs = 90000, command = 'yt-dlp' } = {}) {
  if (!/^[\w-]{11}$/.test(videoId ?? '')) throw failure(400, 'That is not a YouTube video ID.');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'frameboard-captions-'));
  const deadline = Date.now() + timeoutMs;
  const timeLeft = () => { if (Date.now() >= deadline) throw tooSlow(); return deadline - Date.now(); };
  const ytdlp = (extra) => run(command, ['--skip-download', '--no-playlist', '--quiet', '--no-simulate', '--ignore-errors', '--sub-format', 'json3', '-o', path.join(dir, 'track'), ...extra, `https://www.youtube.com/watch?v=${videoId}`], timeLeft());
  try {
    const first = await ytdlp(['--write-sub', '--write-auto-sub', '--sub-langs', [...english, '[a-z]+-orig'].join(','), '--print', '%(language)s', '--print', '%(subtitles)j']);
    const [spoken = '', printed = ''] = first.stdout.split('\n');
    const manual = manualLanguages(printed);
    // --ignore-errors keeps one refused track from costing the others, so a
    // refusal shows only as a warning, which tells it apart from "no captions".
    const refused = (result) => result.code !== 0 || /Unable to download video subtitles/.test(result.stderr);
    let failed = refused(first) ? first : null;
    // The video's own language: its original automatic track, else what yt-dlp printed.
    const spokenIn = (found) => found.find((track) => track.language.endsWith('-orig'))?.language.replace(/-orig$/, '') || (spoken === 'NA' ? '' : spoken);
    // When that is not English, an automatic English track is a machine translation, not what was said.
    const usable = async () => {
      const found = await tracksIn(dir);
      const foreign = spokenIn(found) && !/^en(-|$)/i.test(spokenIn(found));
      return found.filter((track) => !(foreign && english.includes(track.language) && !manual.has(track.language)));
    };
    let tracks = await usable();
    // No English: take the manual track in the video's own language, else the first one.
    if (manual.size && !tracks.some((track) => english.includes(track.language))) {
      const language = [spokenIn(tracks), ...tracks.map((track) => track.language)].find((candidate) => manual.has(candidate)) ?? [...manual][0];
      const second = await ytdlp(['--write-sub', '--sub-langs', language]);
      if (refused(second)) failed ??= second;
      tracks = await usable();
    }
    // English first, then a person's captions before a machine's.
    const rank = (track) => (english.includes(track.language) ? 0 : 2) + (manual.has(track.language) ? 0 : 1);
    tracks.sort((a, b) => rank(a) - rank(b) || english.indexOf(a.language) - english.indexOf(b.language));
    if (!tracks.length) throw failed ? unreachable(failed.stderr) : noCaptions();
    let unreadable = false;
    for (const track of tracks) {
      try {
        const text = transcriptFromJson3(await readFile(path.join(dir, track.name), 'utf8'));
        if (text) return { text, language: track.language.replace(/-orig$/, ''), kind: manual.has(track.language) ? 'manual' : 'auto' };
      } catch { unreadable = true; }
    }
    throw unreadable ? failure(502, 'YouTube sent captions that Frameboard could not read.') : noCaptions();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
