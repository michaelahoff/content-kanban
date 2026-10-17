---
lane:              # set by the installer
run: on-enter
provider: claude
model: sonnet
may_edit: [post]
skills: [voice, html-post]
advance: auto
routes:
  drafted: Review
---

# Draft

Write the post from **Outline**, in Markdown and as a web page. If **Review notes** has numbered items, this is a revision: skip to "Revising".

## Writing

1. Read the notes, Outline and Transcript. Follow the outline's angle and section order; if you merge or cut a point, say so in `notes`.
2. Write the Markdown to `post/post.md`:
   - `# ` the working title, then the opening paragraph that states the angle.
   - 1,200–2,000 words (`wc -w post/post.md`), headings from the outline, each section with its specifics and timestamp links (skills/voice.md).
   - Code from the outline's code markers as fenced blocks with a language tag such as `python`, each introduced by a sentence saying what it shows and whether it is from the talk or an illustration.
   - Callouts as `> **Note:** …`, at most 3.
   - Where a diagram goes, one line: `*Figure 1. <what to notice>*`.
3. Render `post/index.html` from `post/post.md` following skills/html-post.md: its skeleton, the same text, each figure line drawn as an inline SVG from the outline's diagram marker. Run its "Check before you deliver" and look at every `review/figure-N.png`; fix what fails.
4. Unless **Post title** already reads as this post's headline (cards start with the video's title), propose the outline's working title in `fields.title`. The user accepts it; the published address is made from it.

## Revising

Apply every numbered item in Review notes, blocking ones first. Change nothing the notes do not touch, except what keeps the post consistent. Rewrite both `post/post.md` and `post/index.html`, rerun the checks, and save the page again (Publish takes the newest saved `index.html`). In `notes`, list each item number as done, or not done and why.

## Result

- `fields.post`: the full text of `post/post.md`.
- `outputs`: exactly `[{ "path": "post/index.html", "filename": "index.html", "sources": [] }]`, on every pass.
- `route`: `drafted` when both files are complete and the checks pass. If Outline is empty, write nothing, leave `route` out and say "Outline is empty: move the card to Outline" in `notes`.

## Done when

- Post and `post/post.md` hold the same Markdown, 1,200–2,000 words.
- `post/index.html` passes the three checks, and every diagram looks right in its PNG.
- `index.html` is listed in `outputs`, and `notes` say what you wrote or which review items you applied.
