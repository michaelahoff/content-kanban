# Video to blog — flow map

Every lane run in this flow reads this file first.

## What we make

One blog post from one YouTube talk or tutorial. The reader is a working developer who will not watch the video and wants its argument, its evidence and its code in about ten minutes. Each card ends as 1,200–2,000 words in Markdown (the **Post** field) and the same post as one self-contained web page, `post/index.html`, which Frameboard publishes to the `blog` site. The voice is in `skills/voice.md`.

## Nodes and their routes

Cards start in Inbox. Every node follows the route its agent chooses at once (`advance: auto`), so a card runs from Inbox to Published without a click unless a node leaves its route out.

- **Inbox** (runs when you choose **Run playbook**) — makes sure Transcript holds the captions with `[m:ss]` times, and writes a brief of the video into the notes. Routes: ready → Outline.
- **Outline** — the post's angle and an H2/H3 outline with timestamps; marks up to 2 diagrams and the code snippets. Routes: outlined → Draft.
- **Draft** — writes Post and `post/index.html`, and saves `index.html` as the card's output. When Review sends the card back, applies Review notes. Routes: drafted → Review.
- **Review** — an editor in a fresh session checks the post against the transcript and writes Review notes. Routes: approved → Publish, revise → Draft. At most two revise passes; the third review approves.
- **Publish** — Frameboard's own action, no agent: copies the card's saved outputs to the `blog` site and fills Published URL. Routes: published → Published.
- **Published** — the end of the flow. Nothing runs.

## Card fields

- **Post title** (`title`): the headline. The published page's address is made from it. Draft proposes one; you accept it.
- **Original URL** (`originalVideoUrl`): the YouTube link. You set it.
- **Original video title** (`originalVideoTitle`): the video's title on YouTube.
- **Transcript** (`transcript`): the captions as plain text, one paragraph per 30 seconds, each starting with its `[m:ss]` time. The only source for what the speaker said.
- **Outline** (`outline`): working title, angle, reader, length, then the H2/H3 outline with timestamps, diagram and code markers.
- **Post** (`post`): the full post in Markdown. `post/index.html` says the same thing.
- **Review notes** (`reviewNotes`): Review's numbered notes, rewritten on every pass.
- **Published URL** (`publishedUrl`): the live address, filled by Publish.
- Image **Original**: the video's thumbnail, for reference only.

## Files in the card workspace

- `captions/` — captions downloaded by Inbox.
- `post/post.md` — the Markdown, the same text as Post.
- `post/index.html` — the web page: the only output of this flow.
- `review/` — Review's scratch files (code snippets, rendered diagrams).

## Rules for every lane

- Read the hand-off notes first: they hold the brief, decisions and earlier review passes.
- Keep earlier work unless your playbook says to replace it. Return only the fields your lane changes; only Inbox returns `transcript`.
- You cannot watch the video. Claims about the talk come from Transcript only; never describe a slide or on-screen code the captions do not mention. A fact from elsewhere gets a link to its source in the post.
- Only Draft lists `outputs`, and only `post/index.html`: Publish copies every saved output of the card to the site.
- The page makes no network requests: inline CSS, inline SVG, no external scripts, fonts or images.
