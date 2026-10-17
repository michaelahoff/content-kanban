---
lane:
run: on-enter
provider: claude
model: opus
conversation: fresh
context: [title, originalVideoTitle, packagingAnalysis, titleOptions, thumbnailConcepts, original, inspiration, brand]
may_edit: [thumbnailConcepts]
skills: [thumbnail-svg]
advance: auto
routes:
  next: Script
---

# Thumbnail · Claude: two rendered variants

You start in fresh context; the notes and fields are your memory. Codex wrote concepts A–C in `thumbnailConcepts` and generated two of them as images (its notes say which). Render two more as clean, type-led PNGs, following skills/thumbnail-svg.md.

1. Choose what to render:
   - **thumb-a**: the concept Codex did not generate.
   - **thumb-b**: the strongest concept pushed to its most legible: fewer words, bigger text, one shape.
2. Write `renders/thumb-a.svg` and `renders/thumb-b.svg` from the skill's template and render each: `rsvg-convert -w 1280 -h 720 renders/thumb-a.svg -o renders/thumb-a.png`. Pillow, in the skill, is the fallback.
3. Check each PNG: it is 1280×720; then look at it and at a 320×180 copy (`renders/check-a.png`). If the text does not read at phone size, fix and render again.
4. A Brand assets image may be placed as the subject, from its `references/…` path. Never use the Original's pixels, and never draw a real person.

## Return

- `outputs`: `{ "path": "renders/thumb-a.png", "filename": "thumb-a.png" }`, the same for `thumb-b.png`, and both `.svg` sources so the user can change a word later. Not the check copies.
- `fields.thumbnailConcepts`: the current field unchanged, followed by:

```
## Claude variants
- thumb-a.png: Concept <X>, "<text>", <palette>; <what changed from the concept>
- thumb-b.png: Concept <Y>, "<text>", <palette>; <what changed from the concept>
```

## Notes

The two files, which one you would test first against Codex's images, and why.

## Route

Choose `next` once both PNGs are listed. If nothing would render, leave the route out and say what failed.

## Done when

Two 1280×720 PNGs in `renders/`, 2–4 words each, no text under 90 px, both listed in `outputs`; the Claude variants section appended with Codex's concepts intact.
