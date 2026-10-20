# Local business sites — flow map

A list of independent businesses in one town becomes one card per business. Each business is researched from public sources, profiled from its public social accounts, given a design brief in its owner's own taste, and ends as a homepage mockup that previews inside Frameboard. The result is a pitch-ready concept to show the owner, not a live site: accurate about the business, honest about what is invented.

## Nodes and their routes

Cards start in Intake. Every node after Intake moves the card on by itself when its work is done.

- **Intake** — a Business list card, run by hand. Creates one Business site card per business in Research. No routes: the list card stays here as the record of what was created.
- **Research** — confirms the official website, then gathers what they do, hours, prices, review themes, the owner as publicly stated and the current visual identity, each fact with its source. Routes: researched → Socials.
- **Socials** — the business's public profiles: followers, posting cadence, what they photograph and how they write. Routes: profiled → Brief.
- **Brief** — a design brief for a new site in the owner's taste. Routes: briefed → Mockup.
- **Mockup** — builds the homepage as one self-contained `site/index.html`. Routes: built → Review.
- **Review** — the user previews the mockup. No agent runs. Routes: approved → Done, rework → Brief.
- **Done** — finished. No agent runs.

Each business card runs on its own, so several agents work at the same time, one per card. Work only on your card; you cannot see or change the others.

## Card templates and fields

**Business list** (Intake only): title (List), `location`, `businesses` (one per line, optionally with a website), `listNotes` (what Intake created or skipped).

**Business site** (every other node):

- title (Business) — the business name, as the business writes it.
- `location` — "Town, State". Header field.
- `website` — the confirmed official website. Set by Research.
- `owner` — "Name — role" as publicly stated; several separated by "; ". Set by Research.
- `research` — sourced Markdown facts. Set by Research.
- `socials` — profiles, cadence, tone and aesthetic. Set by Socials.
- `designBrief` — the brief. Set by Brief.
- `mockupNotes` — what the mockup shows, its placeholders, what a real build needs. Set by Mockup.
- `mockupUrl` — filled by the user only if they host the mockup somewhere.
- Images: **Logo** and **Reference** photos the user adds. They are ground truth for the current identity; every run receives them.

## Rules for every lane

- Read the hand-off notes first. Review feedback arrives there.
- Public business information only, always cited. Lanes that research follow the research-ethics skill.
- Facts flow forward from Research. Later lanes add no unsourced facts; a detail invented for the concept is labeled a placeholder.
- Edit only the fields your lane may edit; keep earlier work unless your playbook says to replace it.
- Write files only in the card workspace; only files listed under "outputs" are saved.
- Leave notes the next lane can act on: what you did, what is uncertain, what to watch.
