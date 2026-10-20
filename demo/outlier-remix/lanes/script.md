---
lane:
run: on-enter
provider: claude
model: opus
context: [title, originalVideoTitle, channelStats, transcript, packagingAnalysis, titleOptions, intro]
may_edit: [script]
skills: [retention]
advance: auto
routes:
  scripted: Review
---

# Script: the full spoken script

Write our video start to finish, as the creator will say it, with the structure and pacing in skills/retention.md.

## Inputs

- **The working title** (flow map rule) and its promise. Deliver exactly what it promises, early and in full.
- **`intro`**: the text above its `---` line is the opening, word for word. If the user edited it, their version wins.
- **`packagingAnalysis`** `## Structure` and `## Keep / Beat`: what the outlier covered and where we go further.
- **`transcript`**: for facts and gaps only. Never reuse its sentences, examples, jokes or section order; no run of 8+ words from it.

## Length

Match the outlier's duration from `channelStats`, within 15%, at 150 spoken words a minute (15:00 is about 2,250 words). Unknown duration: 8–10 minutes, 1,200–1,500 words. Longer than 20 minutes: cap at 3,000 words.

## Write it

1. Draft in `drafts/script.md` and count with `wc -w drafts/script.md`. Fix the length before you return.
2. Shape: intro, a one-line roadmap, chapters, ending, as the skill lays out. Every chapter opens a loop and pays it off; re-hook every 60–90 seconds; one soft CTA right after the first big payoff and none in the first two minutes.
3. Chapter markers as `## [mm:ss] Chapter title`, timed from the words before them at 150 a minute. Cues on their own lines, `[B-ROLL: …]` and `[ON SCREEN: …]`, at least one every 20 seconds of speech.
4. Proof only from the card and notes. Elsewhere write `[PROOF: …]` or `[DEMO: …]` saying what the creator should show.
5. End by pointing to one next video with a reason to click it. No "thanks for watching".

## Return

`fields.script`: the full script. Notes: word count and estimated length; the chapter list with timestamps, ready for the description; every placeholder the user must fill.

## Route

Choose `scripted` once `script` is written. Leave the route out only when `intro` is empty, and say so.

## Done when

The intro opens the script verbatim; the length is within target; every chapter has a loop and a payoff; chapter markers and cues are present; nothing is reused from the transcript; every placeholder is listed in the notes.
