# Outlier remix — flow map

Every lane run in this flow reads this file first.

## What we make

One new long-form YouTube video per card, built on an **outlier**: a video that pulled far more views than its channel's size predicts. The measure is the ratio views ÷ subscribers; 100k+ views on a channel under 100k subscribers is the classic case. An outlier's packaging (title, thumbnail, promise, opening) has already won with strangers, so we study why and make our own, better video on the same pattern. We never copy the title, the thumbnail or the script.

The creator who owns this board records every video themselves. Write to be spoken, in first person, and leave a bracketed placeholder wherever only they can supply proof.

## Nodes and their routes

Cards start in **Drop** with a screenshot of the outlier in the gallery, its YouTube link in `originalVideoUrl`, or both.

| Node | Agent | Writes | Routes |
|---|---|---|---|
| **Drop** (Run playbook) | Claude | `originalVideoTitle`, `channelStats`, `transcript`, `packagingAnalysis` | analysed → Titles |
| **Titles** | Claude | `titleOptions` | titled → Intro |
| **Intro** | Claude | `intro` | hooked → Thumbnail · Codex |
| **Thumbnail · Codex** | Codex, fresh context | `thumbnailConcepts`, two generated images in the card chat | next → Thumbnail · Claude |
| **Thumbnail · Claude** | Claude, fresh context | appends to `thumbnailConcepts`; `renders/thumb-a.png`, `renders/thumb-b.png` | next → Script |
| **Script** | Claude | `script` | scripted → Review |
| **Review** | the user | — | approved → Done, revise → Titles |
| **Done** | the user | `publishedVideoUrl` | end |

Every agent node follows its route by itself, so one **Run playbook** on Drop carries the card to Review. A node that cannot finish leaves `route` out and the card waits there for the user.

The two thumbnail nodes switch provider and start fresh context: they remember nothing from earlier runs. The hand-off notes and the card fields are the only memory, so write notes for a reader who has seen nothing else.

## Card fields

- `title` (Working title): the title of our video. When a card comes from a YouTube link it starts as the outlier's title, so it only counts as ours once it differs from `originalVideoTitle`.
- `originalVideoUrl`: the outlier's YouTube link.
- `originalVideoTitle`: the outlier's exact title.
- `channelStats`: one line, `channel · N subscribers · N views · ratio N× · published YYYY-MM-DD · mm:ss · checked YYYY-MM-DD`; `?` for anything unverified.
- `transcript`: the outlier's captions as plain text.
- `packagingAnalysis`: Drop's breakdown under eight headings, the brief for every later node.
- `titleOptions`: first line `RECOMMENDED: <title>`, then twelve scored candidates.
- `intro`: the spoken opening, then a line `---`, then three alternate first lines.
- `thumbnailConcepts`: concepts A–C from Codex, then a `## Claude variants` section.
- `script`: the full spoken script, opening with the intro.
- `publishedVideoUrl`: our video once it is live.

Images: **Original** is the outlier's thumbnail or screenshot. **Inspiration** is anything else the user likes. **Brand assets** are the creator's face, logo and colors. Each image's `references/…` path in the card workspace is listed with the image references at the end of the prompt.

Skills: `titles` (Titles), `hook` (Intro), `thumbnail-svg` (Thumbnail · Claude), `retention` (Script).

## The working title

Later nodes build on one title: the card title if the user has changed it (it differs from `originalVideoTitle`), otherwise the `RECOMMENDED:` line of `titleOptions`.

## Rules for every node

1. Read the hand-off notes first. A note from Review that starts with `revise:` overrides this flow's defaults.
2. Borrow the pattern, never the thing. Topic, tool names and facts are free. The outlier's wording is not: no run of 4+ consecutive words from its title, no copy of its thumbnail's text and layout together, no sentence, example or section order from its script.
3. Never invent proof. Numbers, results, credentials and stories about the creator come from the card or the notes. Where they are missing, write a placeholder such as `[PROOF: your real result]`.
4. The only real person who may appear in our images is the creator, from Brand assets. No celebrities, no outlier creator, no channel logos.
5. A field value replaces the whole field. Return every part you keep, in the formats above.
6. Notes: under 120 words. Lead with the decisions the next node needs, then anything still open.
