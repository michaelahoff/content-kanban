// Fetches a YouTube video's captions as plain text through the installed
// yt-dlp, for the transcript field of a card template (card-template.js
// `transcript: true`). Frameboard never transcribes audio: a video without
// captions has no transcript. Nothing here touches the store.
//
// STUB: the real implementation replaces this file (see ADR 0011 and
// docs/implementation/demo-flows.md). The contract is fixed:
//   fetchYoutubeTranscript(videoId, { timeoutMs }) → { text, language, kind: 'manual' | 'auto' }
// and failures throw an Error with a `status` (404 no captions, 502
// unreachable, 501 yt-dlp missing) and a user-facing message.
export async function fetchYoutubeTranscript(videoId, { timeoutMs = 90000 } = {}) {
  void videoId; void timeoutMs;
  throw Object.assign(new Error('Transcript fetching is not available yet.'), { status: 501 });
}
