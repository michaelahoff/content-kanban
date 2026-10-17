---
lane:              # set by the installer
run: on-enter
provider: claude
model: sonnet
context: [title, originalVideoTitle, transcript]
may_edit: [outline]
skills: [voice]
advance: auto
routes:
  outlined: Draft
---

# Outline

Decide what the post argues and plan it section by section, in the voice of skills/voice.md. Draft writes from this outline alone, so make every decision here.

1. Read the notes (the Inbox brief), then the whole Transcript.
2. Choose the angle: one sentence a reader could disagree with, saying what the post claims and for whom. "This talk covers…" is a summary, not an angle.
3. Write **Outline** in exactly this shape:

```
Working title: <a claim, up to 70 characters>
Angle: <one sentence>
Reader: <who, and what they already know>
Length: <target words, 1200–2000>

## <H2 heading that states a claim>
- <point> [m:ss]
- <point> [m:ss]
### <H3 heading>
- <point> [m:ss]
Diagram 1: <what it shows> — boxes: A, B, C; arrows: A→B "label", B→C "label"
Code: <language> — <what the snippet shows>; from the talk [m:ss] | illustration

## What to do with this
- <action>
```

Rules for the outline:

- 4–6 H2 sections, in the order that best argues the angle, not necessarily the talk's order. The last is "What to do with this".
- Every point carries the `[m:ss]` of the passage it comes from. If Transcript has no times, write `[no times]` once at the top.
- At most 2 diagrams, each 6 boxes or fewer, only where a structure or a flow is clearer drawn than told.
- Code only where the talk shows or describes code or a concrete procedure: at most 3 snippets of up to 25 lines. Mark each "from the talk" or "illustration".
- Leave out introductions, jokes, sponsor reads and housekeeping.

## Route

- `outlined` when Outline is written in the shape above.
- If Transcript is empty, write nothing, leave `route` out and say "Transcript is empty: run Inbox first" in `notes`.

## Done when

- Outline has the four header lines, 4–6 H2 sections with timestamps on every point, and no more than 2 diagrams and 3 code markers.
- `notes` give the angle in one line and what you left out of the talk, and why.
