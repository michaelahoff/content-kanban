---
lane:
run: on-enter
provider: codex
model: gpt-6.1-sol
conversation: fresh
context: [title, originalVideoTitle, packagingAnalysis, titleOptions, original, brand]
may_edit: [thumbnailConcepts]
advance: auto
routes:
  next: Thumbnail · Claude
---

# Thumbnail · Codex: three concepts, two images

You start in fresh context: the flow map, the notes and the fields sent here are all you know. Design for the working title: the card title if it differs from `originalVideoTitle`, otherwise the `RECOMMENDED:` line of `titleOptions`.

## 1. Concepts

Study the Original image and `packagingAnalysis` → `## Thumbnail`. Write three concepts that keep what made the outlier's thumbnail work (layout logic, contrast, the question it plants) and each beat it on one thing: a clearer focal point, fewer words, sharper contrast or a more specific object. Replace `thumbnailConcepts` with:

```
## Concept A: <short name>
- Composition: <where subject, text and shape sit>
- Subject: <the one face or object the eye lands on>
- Text: "<4 words at most>" (adds to the title, never repeats it)
- Palette: <3 hex colors>; <what contrasts with what>
- Versus the outlier: keeps <…>; beats it by <…>
```

…then Concept B and Concept C in the same shape.

## 2. Images

Generate the two strongest concepts with your image generation (the imagegen skill), one image each: 16:9 landscape, 1280×720, or the closest landscape size your tool offers with everything important inside a centred 16:9 frame.

- Write each prompt from the concept. Do not pass the Original as an image to edit: borrow its composition in words, never its pixels, text, people or logos.
- People: only the creator, from a Brand assets image, which you may pass as a reference. Otherwise use objects, screens, hands or an illustrated figure; no real person's likeness.
- The text must be the concept's exact words, spelled correctly, huge and high-contrast. If it comes out garbled, regenerate once.
- Keep the bottom-right corner clear: YouTube's duration badge covers it.

Generated images appear in the card chat by themselves; do not list them under `outputs`.

## Notes

Which two concepts you generated and their exact text; that the images are in the card chat for the user to compare and add to the gallery; which concept is left for Thumbnail · Claude.

## Route

Choose `next` once the concepts are written, even if image generation failed (say why in notes).

## Done when

Three concepts in the shape above; two images generated or the failure explained; route `next`.
