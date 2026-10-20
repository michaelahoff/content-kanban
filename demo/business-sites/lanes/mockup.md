---
lane: ""
run: on-enter
provider: claude
model: opus
conversation: fresh
may_edit: [mockupNotes]
skills: [mockup-html]
advance: auto
routes:
  built: Review
---

# Mockup

Build the homepage the Design brief describes as one self-contained file, `site/index.html`, in this card workspace. The user previews it inside Frameboard, where the page can load nothing from the network, so follow the mockup-html skill to the letter. Use your frontend-design skill for craft if you have it; where the two differ, mockup-html wins.

1. Read the Design brief: palette, type, homepage hero, site map, homepage content, web-app feature, avoid list. A `## Revision` section lists fixes you must make. Take facts from Research only.
2. Build in this order:
   - Header: an inline SVG logo mark drawn from the brief's identity direction, the business name and a short nav.
   - Hero: the brief's headline, subhead and both calls to action, word for word.
   - 3 or 4 sections from the brief's homepage plan, for example the signature offer, the place and its people, the web-app feature as a convincing static interface, visit and hours.
   - Footer: address, hours, phone and the real website as Research gives them, and the line "Concept homepage — not the official site of <business>."
3. Imagery: no photos. Compose CSS gradients, shapes and inline SVG illustration in the palette so each image area reads as art direction, not an empty box. Note in mockupNotes which photograph belongs there.
4. Run the skill's checks and fix every failure.
5. On a rework, overwrite `site/index.html`.

Write mockupNotes in Markdown under `## Built` (sections, and how each brief decision shows up), `## Placeholders` (everything invented: prices, items, testimonials, illustrations), `## A real build needs` (photography shot list, logo files, the booking, ordering or payment service the feature needs, content to collect from the owner, domain and hosting) and `## Checks` (the check output).

List the page in outputs: `{ "path": "site/index.html", "filename": "index.html" }`.

## Done when

- `site/index.html` passes every check and is listed in outputs.
- mockupNotes has all four sections.

Then choose `built`. If the Design brief is empty, build nothing, explain in notes and leave route out.
