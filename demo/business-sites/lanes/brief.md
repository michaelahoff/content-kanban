---
lane: ""
run: on-enter
provider: claude
model: opus
conversation: fresh
may_edit: [designBrief]
skills: [design-brief]
advance: auto
routes:
  briefed: Mockup
---

# Brief

Write the design brief for a new website for this business: the site its owner would pick, in their taste, built on what Research and Socials show rather than on a generic small-business template. Follow the headings and quality bar in the design-brief skill exactly.

Evidence, strongest first: Logo and Reference photos on the card, Socials (the owner's own choices), Research (facts and the current identity), hand-off notes.

1. Read Socials' "Across channels" and Research's "Visual identity". Decide whether the new site evolves the current identity (the default) or departs from it, and give the reason in one line.
2. Choose 3 brand adjectives. Each needs evidence: a named platform, a kind of post, a detail of the shop or site.
3. Build the palette from colors they already use (Research's hex values when present). Compute the contrast of every text and background pair with python3 and state the ratios; body text needs 4.5:1.
4. Choose type by Google Fonts names, each with a system fallback stack. The mockup loads no fonts.
5. Plan the site around one primary action (order, book, visit, call, reserve). Propose a web-app feature only when it serves that action for this business, and scope its first version small.
6. Write the homepage hero word for word: headline, subhead, primary and secondary call to action. Mockup builds from it.

Facts in the brief (hours, address, prices, services, names) come only from Research. Mark anything invented for the concept "(placeholder)".

## On rework

A card back from Review carries the user's feedback in the hand-off notes. Change what it asks and keep the rest. Start the brief with `## Revision`, listing what changed. Feedback about the mockup's execution only (a layout bug, section order) leaves the brief as it is: add the fixes under Revision for Mockup and choose the route.

## Done when

- Every heading of the skill is present and specific to this business; 900–1,600 words.
- Each adjective has evidence, each color has a role, hex and ratio, and the hero is written out.

Then choose `briefed`. If Research is empty or says the business could not be confirmed, write nothing, explain in notes and leave route out.
