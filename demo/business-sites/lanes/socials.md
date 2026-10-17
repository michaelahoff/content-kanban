---
lane: ""
run: on-enter
provider: claude
model: sonnet
context: [title, location, website, owner, research]
may_edit: [socials]
skills: [research-ethics]
advance: auto
routes:
  profiled: Brief
---

# Socials

Find where this business shows itself in public and what that reveals about its owner's taste. Brief reads this to design a site the owner would recognize as theirs.

1. Start from the links on the official website (header and footer icons, the schema `sameAs` list; `curl` the page if WebFetch drops them), then search "<business> <town>" for each platform.
2. Check Instagram, Facebook, TikTok, YouTube, LinkedIn, X, Pinterest, the Google Business listing and Yelp. Also check the owner's public professional profiles about this business, such as a LinkedIn page naming it or a work account the business links to.
3. A profile counts only when it is linked from the official site, or matches the name and town plus the address, phone or website. Otherwise leave it out and say why in notes.
4. Many platforms hide posts from logged-out visitors. Use what is visible: the profile page, search snippets, embeds on the business's site. Never log in or guess a handle.

Write Socials in Markdown, starting with `## Profiles`, one block per confirmed profile:

```
### Instagram — @handle
- URL: https://…
- Followers: 2,140 (seen 2026-10-17), or "not visible"
- Cadence: about 3 posts a week; latest 2026-10-12, or "not visible"
- Tone and aesthetic:
  1. What they photograph: product, people, place, process
  2. Colors and light: dominant palette, filters, setting
  3. Captions: voice, length, emoji and hashtag habits, recurring formats
- Seen via: profile page, search snippet or site embed
```

Then three sections:

- `## Owner's professional profiles` — or "None found".
- `## Across channels` — 3 to 5 sentences: the consistent look and voice, the content that performs, what the owner seems proudest of. Brief reads this first.
- `## Checked, not found` — every platform from step 2 with no confirmed profile.

Keep Socials under 15,000 characters.

## Done when

- Every platform in step 2 is profiled or listed under Checked, not found.
- Each profile shows how it was confirmed, and Across channels is written.

Then choose `profiled`. A business with no social presence still gets Socials, built from what the website alone shows, and goes on to Brief.
