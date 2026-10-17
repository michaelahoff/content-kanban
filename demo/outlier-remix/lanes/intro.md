---
lane:
run: on-enter
provider: claude
may_edit: [intro]
skills: [hook]
advance: auto
routes:
  hooked: Thumbnail · Codex
---

# Intro: the first 30–45 seconds

Write the spoken opening of our video for the working title (flow map: the card title if the user changed it, otherwise the `RECOMMENDED:` line of `titleOptions`). The viewer clicked a promise; the first sentence must tell them they are in the right place.

1. Read the notes, the working title, and `packagingAnalysis` (`## First 30 seconds`, `## Audience`, `## Keep / Beat`).
2. Write the hook in the seven parts of skills/hook.md, in order, as one continuous spoken passage: 150 words at most, first person, short sentences. No greeting, no channel name, no "in this video I'll".
3. Borrow the outlier's opening move (for example, showing the finished result first), never its lines.
4. Credibility must be true. If the card and notes hold no real proof, write `[CREDIBILITY: …]` saying what kind of proof belongs there.
5. Write three alternate first lines (part 1 only), one each: visual, contrarian, result-first.

## Write `intro` in exactly this shape

```
<the intro, as spoken>
---
ALTERNATE FIRST LINES
1. Visual: …
2. Contrarian: …
3. Result-first: …
```

Only the text above the `---` line is spoken. Script opens with it word for word.

## Notes

The working title you wrote for, the word count, and any placeholder the user must fill.

## Route

Choose `hooked` once `intro` is written. Leave the route out only when there is no working title (`titleOptions` is empty and the card title still equals `originalVideoTitle`).

## Done when

150 words or fewer above the line; all seven parts present in order; the first line matches the working title's promise; nothing invented; three alternates below the line.
