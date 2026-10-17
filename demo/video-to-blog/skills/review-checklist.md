# Review checklist

Six checks, in this order. Each says how to check and what a failure weighs. **Blocking** means the post must go back to Draft; **minor** means note it and let it pass. Work in `review/` in the card workspace; first write the Post field to `review/post.md` exactly as it is.

## 1. Faithful to the talk — blocking

- Every claim attributed to the speaker is in Transcript. Write Transcript to `review/transcript.txt` and search it (`grep -n -i 'key phrase' review/transcript.txt`). For three timestamp links picked at random, check that the link's `t=` seconds fall within 30 seconds of the `[m:ss]` paragraph holding the passage.
- Every number, name, product and quotation appears in Transcript. A quotation matches word for word, apart from dropped fillers and an obvious mishearing fixed.
- Nothing contradicts the talk, and nothing overstates it ("always", "proves") where the speaker hedged.
- The post's own additions (illustrative code, opinions, outside facts) are labelled as such, and an outside fact links to its source.

## 2. Structure — blocking if the angle is lost

- The first paragraph states the angle written in Outline.
- The H2s follow Outline's order; a merged or cut section is explained in the notes. Headings read as claims.
- It ends with "What to do with this": 3–5 actions a reader can take.
- At most 2 diagrams, 3 code blocks and 3 callouts.

## 3. Code — blocking if it does not parse or misleads

- Every fenced block has a language tag. Copy each into `review/snippet-N.<ext>` and check it parses: `python3 -I -c "import ast, sys; ast.parse(open(sys.argv[1]).read())" review/snippet-1.py`, `node --check review/snippet-2.js`, `bash -n review/snippet-3.sh`, `python3 -m json.tool review/snippet-4.json`. Pseudocode must be fenced as `text` and called pseudocode.
- The sentence before each block says what it shows and whether it is from the talk or an illustration.
- A call to a real library matches that library's documented API (check its docs with WebFetch when unsure). An invented function presented as real is blocking.

## 4. Length — blocking outside 1,100–2,200 words

- `wc -w review/post.md`. 1,200–2,000 is the target; between that and the blocking range is minor.

## 5. Voice — minor, unless it hides meaning

- Against `skills/voice.md`: `grep -n -i -w -E 'we|our|us|unlock|supercharge|seamless|harness|leverage|delve|game-changer|revolutionary|landscape' review/post.md` should find nothing outside quotations; paragraphs of at most four sentences; terms defined once and used consistently; no exclamation marks.

## 6. Web page — blocking

- `post/index.html` exists. Run the three checks in "Check before you deliver" in `skills/html-post.md` (no network requests, diagrams render, headings match), and look at every `review/figure-N.png`.
- The page says what Post says: same sections in the same order, same code. A section missing from the page, or a diagram that is wrong or unreadable, is blocking.
- Every figure has a `<title>`, a `<desc>` and a `<figcaption>`.

## Writing the notes

One numbered item per problem, blocking items first, at most 12 items. Each names the place (the heading), the problem, and the fix, in one or two sentences:

```
Pass 1 — revise
1. [blocking] "Keep it simple" — "agents cut costs by 40%" is not in the talk. Cut the number or quote 6:10 directly.
2. [blocking] Figure 2 — the arrow from Tools points into empty space (review/figure-2.png). Point it at Environment.
3. [minor] Opening — "In this post" opener; start with the claim.
```

Do not rewrite the post yourself and do not list outputs.
