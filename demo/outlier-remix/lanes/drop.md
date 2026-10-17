---
lane:
run: manual
provider: claude
model: opus
may_edit: [originalVideoTitle, channelStats, packagingAnalysis, transcript]
advance: auto
routes:
  analysed: Titles
---

# Drop: read the outlier

Turn the outlier into the brief every later node works from. You can see the attached images and run `yt-dlp`, `curl` and `python3` in the card workspace.

## 1. Pin down the video

- From a screenshot, read the title, channel, views, age and duration shown.
- With a link: `yt-dlp --skip-download --print "%(channel)s|%(channel_follower_count)s|%(view_count)s|%(duration_string)s|%(upload_date)s|%(title)s" "<originalVideoUrl>"`
- No link: `yt-dlp "ytsearch5:<title> <channel>" --flat-playlist --print "%(id)s|%(title)s|%(channel)s|%(view_count)s"`. If one result clearly matches, return its `https://www.youtube.com/watch?v=<id>` as `originalVideoUrl` (a proposal) and use it.
- Fill `originalVideoTitle` if empty. Rewrite `channelStats` in the flow map's format; ratio = views ÷ subscribers, one decimal.

## 2. Captions

If `transcript` is empty and you have a link:

```sh
yt-dlp --skip-download --write-sub --write-auto-sub --sub-lang en --sub-format json3 -o ./captions/t "<originalVideoUrl>"
python3 -c "
import json, sys
for e in json.load(open(sys.argv[1])).get('events', []):
    text = ''.join(s.get('utf8', '') for s in e.get('segs', [])).replace('\n', ' ').strip()
    if text: print('[%d:%02d] %s' % (e['tStartMs'] // 60000, e['tStartMs'] // 1000 % 60, text))
" captions/t.en.json3 > captions/timed.txt
```

Put the text without timestamps in `transcript`; use `captions/timed.txt` for the opening and structure.

## 3. Write `packagingAnalysis` under these eight headings

1. `## Verdict`: ratio, strength (10×+ strong, 3–10× moderate, under 3× weak), and one sentence on why this packaging won.
2. `## Title formula`: the title, its skeleton with slots (`Turn [tool] Into Your [identity] ([N] [parts])`), what each slot does.
3. `## Thumbnail`: layout, focal face or object, exact text, colors and contrast, the question it plants, how it splits the job with the title.
4. `## Promise and gap`: what is promised; what the viewer must click to learn.
5. `## Audience`: who, their level, what they stand to gain or lose.
6. `## First 30 seconds`: the opening beat by beat ("inferred" without captions).
7. `## Structure`: sections with rough timestamps.
8. `## Keep / Beat`: three things to borrow, three ways to be more specific, newer, clearer or more credible, and what would count as copying.

## Route

- `analysed` once the analysis is written.
- Leave `route` out, saying why in notes, when there is no image and no link, when a screenshot shows several videos and you cannot tell which, or when the ratio is under 3× (write the Verdict, then stop).
- A failed `yt-dlp` or missing captions never stops the card: analyse the image and title, and mark those facts unverified.

## Done when

`channelStats` is complete or marks gaps with `?`; all eight headings have concrete answers; `transcript` is filled or notes say why not; notes name the title skeleton and the one thing our video must beat.
