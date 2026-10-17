# HTML post

How to turn the post's Markdown into `post/index.html`: one self-contained page that reads well in Frameboard's preview (a sandboxed frame with no network), on the published site, on a phone and in dark mode.

## Rules

- One file. Inline `<style>` only; no `<script>`, no external stylesheet, font, image or iframe. The page must make no network request: diagrams are inline SVG, and there are no other images.
- Links (`<a href>`) to the video and to sources are fine; they are not requests. Use absolute `https://` links; no relative links, because nothing else is saved beside the page.
- The same words as the Markdown in Post, in the same order: same headings, paragraphs, lists, code and callouts. Only the diagrams are extra.
- Escape `<`, `>` and `&` in code and text as `&lt;`, `&gt;`, `&amp;` (also `&amp;` inside `href` query strings).
- Markdown to HTML: `#` → the one `<h1>` in the header, `##` → `<h2>`, `###` → `<h3>`; a fenced block with tag `python` → `<pre><code class="language-python">`; `> **Note:** …` → `<aside class="callout"><p><strong>Note:</strong> …</p></aside>`; a figure line `*Figure 1. …*` → the `<figure>` below.

## Skeleton

Copy it exactly and fill in the CAPITALS; keep the `<style>` block as it is.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>POST TITLE</title>
<meta name="description" content="ONE-SENTENCE SUMMARY">
<style>
  :root { --bg: #ffffff; --text: #1f2328; --muted: #59636e; --rule: #d1d9e0; --accent: #0b5cad;
    --code-bg: #f6f8fa; --panel: #eef3f8; --callout: #fff8e5; --callout-rule: #d4a72c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d1117; --text: #e6edf3; --muted: #9198a1; --rule: #3d444d; --accent: #6cb6ff;
      --code-bg: #161b22; --panel: #1c2733; --callout: #2b2410; --callout-rule: #bb8009; }
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); color: var(--text); }
  body { margin: 0 auto; max-width: 72ch; padding: 2.5rem 1.25rem 4rem;
    font: 1.0625rem/1.65 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  h1 { font-size: 2.1rem; line-height: 1.2; margin: 0 0 .5rem; }
  h2 { font-size: 1.45rem; line-height: 1.3; margin: 2.5rem 0 .75rem; }
  h3 { font-size: 1.15rem; line-height: 1.35; margin: 1.75rem 0 .5rem; }
  p, ul, ol, blockquote { margin: 0 0 1rem; }
  a { color: var(--accent); }
  .byline { color: var(--muted); font-size: .95rem; margin-bottom: 2rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: .9em; }
  :not(pre) > code { background: var(--code-bg); padding: .1em .35em; border-radius: 4px; }
  pre { background: var(--code-bg); border: 1px solid var(--rule); border-radius: 8px; padding: 1rem; overflow-x: auto; margin: 0 0 1.25rem; line-height: 1.5; }
  pre code { font-size: .875rem; white-space: pre; }
  .callout { background: var(--callout); border-left: 4px solid var(--callout-rule); border-radius: 4px; padding: .75rem 1rem; margin: 0 0 1.25rem; }
  .callout > :last-child { margin-bottom: 0; }
  blockquote { padding-left: 1rem; border-left: 3px solid var(--rule); color: var(--muted); }
  figure { margin: 2rem 0; }
  figure svg { display: block; width: 100%; height: auto; color: var(--text); }
  .diagram .box { fill: var(--panel); }
  figcaption { color: var(--muted); font-size: .9rem; margin-top: .5rem; text-align: center; }
  footer { color: var(--muted); font-size: .9rem; border-top: 1px solid var(--rule); margin-top: 3rem; padding-top: 1rem; }
</style>
</head>
<body>
<article>
  <header>
    <h1>POST TITLE</h1>
    <p class="byline">From <a href="VIDEO URL">VIDEO TITLE</a> by SPEAKER (CHANNEL) · N min read</p>
  </header>
  <!-- the post, section by section -->
</article>
<footer>
  <p>Source: <a href="VIDEO URL">VIDEO TITLE</a>, SPEAKER, CHANNEL. Quotes come from the video's captions; times link to the moment in the video.</p>
</footer>
</body>
</html>
```

N min read is the word count divided by 230, rounded up.

## Drawing a diagram

A diagram is a few labelled boxes joined by arrows; nothing more. Draw it by hand in a 640-unit-wide `viewBox`, up to 6 boxes, labels of 2–3 words. Give every `id` the figure's prefix (`fig1-`, `fig2-`) so two diagrams never share one. Colors come from `currentColor`, so the drawing follows light and dark mode; the attributes also make it render correctly outside the page.

```html
<figure>
  <svg class="diagram" viewBox="0 0 640 200" role="img" aria-labelledby="fig1-title fig1-desc" font-family="system-ui, sans-serif" font-size="15">
    <title id="fig1-title">The agent loop</title>
    <desc id="fig1-desc">The model sends a tool call to the environment; the environment sends feedback back to the model.</desc>
    <defs>
      <marker id="fig1-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
        <path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
      </marker>
    </defs>
    <rect class="box" x="40" y="60" width="180" height="80" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="130" y="105" text-anchor="middle" fill="currentColor">Model</text>
    <rect class="box" x="420" y="60" width="180" height="80" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="510" y="105" text-anchor="middle" fill="currentColor">Environment</text>
    <line x1="220" y1="85" x2="418" y2="85" stroke="currentColor" stroke-width="1.5" marker-end="url(#fig1-arrow)"/>
    <text x="320" y="75" text-anchor="middle" font-size="13" fill="currentColor">tool call</text>
    <line x1="420" y1="115" x2="222" y2="115" stroke="currentColor" stroke-width="1.5" marker-end="url(#fig1-arrow)"/>
    <text x="320" y="135" text-anchor="middle" font-size="13" fill="currentColor">feedback</text>
  </svg>
  <figcaption>Figure 1. The loop every agent runs: act through a tool, read the result, decide again.</figcaption>
</figure>
```

- A box's label sits at its center: `x` = box x + width/2, `y` = box y + height/2 + 5. A second line is `<tspan x="…" dy="18">`.
- An arrow ends 2 units before the box it points at, so the head touches the edge. A bend is a `<path d="M… L… L…" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#fig1-arrow)"/>`.
- Arrow labels sit 10 units above or 20 below the line, `font-size="13"`. Keep 20 units between any text and a line it does not label.
- Every figure has its `<title>`, `<desc>` and a `<figcaption>` that says what to notice. No HTML entities inside SVG other than `&amp;`, `&lt;` and `&gt;`.

## Check before you deliver

Run these in the card workspace; each must pass.

```sh
mkdir -p review
# 1. No network requests (prints nothing).
grep -nE '<(script|img|link|iframe|source|video|audio)\b[^>]*\b(src|href)=|@import|url\((https?:)?//' post/index.html
# 2. Every diagram renders: writes review/figure-N.svg and .png.
python3 -I - post/index.html <<'PY'
import re, sys
html = open(sys.argv[1], encoding="utf-8").read()
for i, svg in enumerate(re.findall(r"<svg\b.*?</svg>", html, re.S), 1):
    if "xmlns=" not in svg.split(">", 1)[0]:
        svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)
    open(f"review/figure-{i}.svg", "w", encoding="utf-8").write(svg)
PY
for f in review/figure-*.svg; do rsvg-convert --background-color=white -o "${f%.svg}.png" "$f" || echo "BROKEN $f"; done
# 3. Headings match the Markdown, in order.
grep -oE '<h[1-3][^>]*>[^<]+' post/index.html | sed 's/<[^>]*>//'
grep -E '^#{1,3} ' post/post.md
```

Then open each `review/figure-N.png` and look at it: every label inside its box, every arrow pointing the right way, nothing clipped at the edges. There is no browser here, so this is the only way to see a diagram before a reader does.
