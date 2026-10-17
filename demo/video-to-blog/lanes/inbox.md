---
lane:              # set by the installer
run: manual
provider: claude
model: sonnet
may_edit: [transcript, originalVideoTitle]
advance: auto
routes:
  ready: Outline
---

# Inbox

Get the source ready: the complete captions in **Transcript**, with times, and a brief of the video in the notes. No lane can watch the video; the captions are all they have.

## 1. Transcript

If Transcript already has `[m:ss]` markers, keep it. Otherwise (empty, or without times), fetch the captions of **Original URL** into `captions/`:

```sh
URL='the Original URL'
mkdir -p captions
yt-dlp --skip-download --write-sub --write-auto-sub --sub-lang en --sub-format json3 -o ./captions/t "$URL"
ls captions/*.json3 || yt-dlp --skip-download --write-sub --write-auto-sub --sub-lang 'en.*' --sub-format json3 -o ./captions/t "$URL"
```

Convert them to plain text, one paragraph per 30 seconds, each starting with its time:

```sh
python3 -I - "$(ls captions/*.json3 | head -1)" > captions/transcript.txt <<'PY'
import json, re, sys
paras, words, start, asr = [], [], None, False
for e in json.load(open(sys.argv[1]))["events"]:
    asr = asr or any("acAsrConf" in s for s in e.get("segs", []))
    text = re.sub(r"\[(Music|Applause|Laughter)\]|\s+", " ", "".join(s.get("utf8", "") for s in e.get("segs", []))).strip()
    if not text: continue
    t = e["tStartMs"] // 1000
    if start is None: start = t
    if t - start >= 30 and words: paras.append(f"[{start // 60}:{start % 60:02d}] " + " ".join(words)); words, start = [], t
    words.append(text)
if words: paras.append(f"[{start // 60}:{start % 60:02d}] " + " ".join(words))
print("\n\n".join(paras))
print("automatic captions" if asr else "manual captions", file=sys.stderr)
PY
```

Put the whole of `captions/transcript.txt` in `transcript`, unedited. If **Original video title** is empty, fill it from `yt-dlp --skip-download --print "%(title)s" "$URL"`.

## 2. Brief

Write 5–8 lines in `notes`:

- Video: title, speaker, channel, duration (`--print "%(channel)s | %(duration_string)s"`), URL.
- Topic: one sentence.
- Audience: who the talk is for and what it assumes they know.
- Claims: the 3 most concrete claims, each with its `[m:ss]`.
- Shown: code, tools and products the speaker names or walks through, as far as the captions say.
- Captions: manual or automatic, and words they mishear (for example "cause" for "cost").

## Route

- `ready` when Transcript holds the captions and the brief is written.
- No English captions (no `.json3` file after both commands): leave `route` out and put in `notes`: "No English captions for <URL>. Frameboard never transcribes audio: paste a transcript into Transcript and run Inbox again."

## Done when

- Transcript holds every caption line with `[m:ss]` markers.
- The notes hold the brief; the route is `ready`, or left out with the reason.
