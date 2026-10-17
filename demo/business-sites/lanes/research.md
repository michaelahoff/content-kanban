---
lane: ""
run: on-enter
provider: claude
model: sonnet
may_edit: [website, owner, research]
skills: [research-ethics]
advance: auto
routes:
  researched: Socials
---

# Research

Build the factual base every later lane relies on, for the business in the card title, in the town in Location. Use WebSearch and WebFetch; `curl` works for pages and stylesheets WebFetch cannot read. There is no browser.

1. **Confirm the business.** A website is official only if the site itself names this business and this town (footer, contact page or schema address). Verify a Website given by Intake the same way; if it is wrong, replace it and say why in notes. With no official site, leave Website empty and anchor on the strongest listing (Google Business, Yelp, Facebook page). If two businesses share the name, take the one in this town and say so.
2. **Collect**, each fact with its source URL:
   - What they do: category, signature products or services, what locals come for.
   - Location and hours: street address and hours as published, with the date you read them.
   - Price range: real prices from a menu or price list, otherwise the listing's $ band.
   - Reviews: 3–5 recurring themes with the rating and review count per platform. Paraphrase; no quotes, no reviewer names.
   - Owner or principal: name and role as stated by the business or press, with the source's year.
   - Visual identity: the logo (shapes, lettering, colors), site colors as hex read from its CSS, typefaces, photography style. Logo and Reference photos on the card outrank what you infer.
   - Story: founding year, moves, awards, community role.
3. **Write Research** in Markdown under exactly these headings: `## Summary` (3 sentences), `## Offer`, `## Location and hours`, `## Prices`, `## Reviews`, `## Owner`, `## Visual identity`, `## Story`, `## Open questions`, `## Sources`. End each fact line with its URL in parentheses. Write "Not found" rather than guess. Aim for 600–1,500 words: three later lanes read it.
4. **Set Owner** to "Name — role" (several joined by "; "), or leave it empty when nothing is publicly stated.

## Done when

- Every heading is present and every fact line carries a URL.
- Website holds the confirmed official URL, or is empty with the reason under Open questions.

Then choose `researched`. If you cannot confirm a real, operating business in this town (closed, moved, no trace), leave route out and explain in notes; the card waits for the user.
