---
lane:
run: on-enter
provider: claude
may_edit: [titleOptions]
skills: [titles]
advance: auto
routes:
  titled: Intro
---

# Titles: twelve candidates, one pick

Write the titles for our video from `packagingAnalysis` (the outlier's formula and what to beat), following skills/titles.md.

1. Read the notes. If Review sent the card back, apply its `revise:` feedback first and keep any title the user named as a keeper.
2. Write 12 candidates covering all seven patterns in the skill, at least two of them Mirror: the outlier's skeleton with our own slots.
3. Check every candidate against the hard rules. Count characters with a tool (`python3 -c 'print(len("…"))'`), never by eye: 60 at most, key words in the first 40. No claim the video cannot back. No run of 4+ consecutive words from `originalVideoTitle`.
4. Score each 1–5 on Curiosity (C), Clarity (L), Specificity (S) and Thumbnail fit (T). The top 3 are the highest totals; the recommended one is the highest, ties going to Clarity.

## Write `titleOptions` in exactly this shape

```
RECOMMENDED: <title>

TOP 3
1. <title> | <pattern> | 18/20 (C5 L4 S5 T4) | <why, 12 words at most>
2. …
3. …

OTHERS
4. <title> | <pattern> | 15/20 (C4 L4 S4 T3)
…
12. …
```

Keep `RECOMMENDED:` as the first line with exactly one title: Intro, both thumbnail nodes and Script read it.

## Notes

The recommended title, its character count, and the picture it implies for the thumbnail (the thumbnail should add to the title, not repeat it). Suggest the user make it the working title (the card title) if they agree; do not return `title` in `fields`.

## Route

Choose `titled` once `titleOptions` is written. Leave the route out only when `packagingAnalysis` is empty, and say so in the notes.

## Done when

`RECOMMENDED:` plus 12 numbered lines; every title 60 characters or fewer; all seven patterns present; every line scored; no copied wording.
