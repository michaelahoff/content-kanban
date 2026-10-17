# Mockup HTML

Rules for a homepage mockup that previews inside Frameboard. The preview is a sandboxed frame with no network: it allows inline CSS and inline scripts and nothing else that loads, so the page must be one self-contained file.

## Hard rules

- One file, `site/index.html`, under 150 KB (aim for 30–90 KB).
- No external requests: no `<link rel="stylesheet">`, no `<script src>`, no `<img>`, `<source>` or `<video>` from the network, no `@import`, no `url(http…)`, no web fonts, no `fetch`.
- Imagery is CSS gradients, shapes and inline SVG. A small SVG may be a `data:` URI. No photos, no base64 bitmaps, no hotlinked images from the business's site.
- One `<style>` block in the head; at most one small inline `<script>` (a menu toggle, tabs for the feature demo). The page must read fully with it off.
- The sandbox has no storage and no form submission: no `localStorage` or cookies, no `<form action>`; feature controls are `<button type="button">`.
- Nav and calls to action are in-page anchors (`#visit`). The real website, phone (`tel:`) and email may be links, but the preview may not follow them.

## Skeleton

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Business — short promise</title>
<meta name="description" content="One sentence from the brief's positioning.">
<style>
:root {
  /* Palette: Design brief */
  --bg: #F6F1E7; --surface: #FFFFFF; --ink: #1F2A24; --muted: #5B635D; --primary: #A4462B; --accent: #E2B04A;
  /* Type: would be "Fraunces" (display) and "Inter" (text); system stacks stand in */
  --display: ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --text: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --space: clamp(1rem, 3vw, 2rem); --radius: 14px;
}
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 1rem/1.6 var(--text); }
h1, h2, h3 { font-family: var(--display); line-height: 1.1; }
h1 { font-size: clamp(2.2rem, 6vw, 4.5rem); }
.wrap { width: min(72rem, 100% - 2 * var(--space)); margin-inline: auto; }
.grid { display: grid; gap: var(--space); grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr)); }
a:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.button { display: inline-flex; align-items: center; min-height: 44px; padding: 0 1.25rem; border-radius: 999px; }
@media (max-width: 720px) { /* stack the header, simplify the nav */ }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="wrap">
  <a class="brand" href="#top">
    <svg id="logo-mark" viewBox="0 0 64 64" width="44" height="44" role="img" aria-labelledby="logo-title"><title id="logo-title">Business logo</title><!-- mark --></svg>
    <span>Business</span>
  </a>
  <nav aria-label="Main"><a href="#offer">…</a></nav>
</header>
<main id="main">
  <section class="hero" id="top"><h1>Brief's headline</h1>…</section>
  <section id="offer">…</section>   <!-- 3 or 4 sections from the brief -->
</main>
<footer class="wrap">Address · hours · phone · website. <small>Concept homepage — not the official site of Business.</small></footer>
</body>
</html>
```

## Fonts

Use only system stacks, chosen to resemble the brief's faces, and name the intended face in a CSS comment and in Mockup notes. Serif display: `ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`. Geometric sans: `"Avenir Next", Avenir, "Century Gothic", system-ui, sans-serif`. Humanist sans: `"Gill Sans", "Trebuchet MS", "Segoe UI", system-ui, sans-serif`. Mono: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`.

## Craft

- Palette only through the custom properties; no stray hex values in the rules.
- Phone first: one column by default, fluid type with `clamp()`, auto-fit grids, no fixed widths over 100%, nothing that scrolls sideways at 360px.
- Accessibility: one `h1`, headings in order, landmarks, `aria-hidden="true"` on decorative SVG, a title on meaningful SVG, 4.5:1 text contrast, visible focus, 44px targets.
- Copy: the business's real name, town and offer; facts from Research only. No lorem ipsum. No invented testimonials attributed to people; paraphrase review themes, or mark a sample "(placeholder)".
- The logo mark is a concept drawn from the brief, simple enough to read at 32px.

## Checks (run all, fix every failure, paste the output into Mockup notes)

```sh
python3 - <<'PY'
import re, pathlib
p = pathlib.Path('site/index.html'); s = p.read_text()
print('bytes', p.stat().st_size, 'ok' if p.stat().st_size < 150_000 else 'TOO BIG')
ext = re.findall(r'''<link\b[^>]*rel=["']?stylesheet|<script\b[^>]*\bsrc=|<(?:img|source|video|audio|iframe)\b[^>]*\bsrc=["']?(?:https?:)?//|@import|url\(\s*["']?(?:https?:)?//|\bfetch\(|XMLHttpRequest|localStorage''', s, re.I)
print('external or blocked', ext or 'none')
for name, ok in [('viewport', re.search(r'<meta[^>]+name=["\']viewport', s)), ('lang', re.search(r'<html[^>]+lang=', s)),
                 ('one h1', len(re.findall(r'<h1\b', s)) == 1), ('logo-mark', 'id="logo-mark"' in s), ('concept line', 'Concept homepage' in s)]:
    print(name, 'ok' if ok else 'MISSING')
m = re.search(r'<svg[^>]*id="logo-mark".*?</svg>', s, re.S)
if m:
    svg = m.group(0) if 'xmlns=' in m.group(0) else m.group(0).replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"', 1)
    pathlib.Path('checks').mkdir(exist_ok=True); pathlib.Path('checks/logo.svg').write_text(svg)
PY
rsvg-convert -w 256 checks/logo.svg -o checks/logo.png && echo 'logo renders'
```

Look at `checks/logo.png` (read the image) to judge the mark. There is no browser to screenshot the page, so re-read the CSS for the 360px and 1280px layouts before you finish. Do not list `checks/` under outputs.
