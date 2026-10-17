# Thumbnails as SVG, rendered to PNG

A thumbnail is seen at about 320×180 pixels on a phone, beside a dozen others, for under a second. It wins on one focal point, a few huge words and contrast, not on detail.

## Rules

- 1280×720 PNG.
- 2–4 words, at most two lines. No text under 90 px; aim for 140–180 px.
- One focal subject (an object, a screen, the creator from Brand assets) and at most one supporting shape: an arrow, a circle, a cross-out.
- Three colors plus black and white. Text contrast is light on dark or dark on light, never mid on mid; a dark stroke under every word.
- Text in the left 60% of the frame, subject on the right. Keep the bottom-right 220×90 clear: YouTube's duration badge covers it.
- The text adds to the title and never repeats it.
- Passes the squint test: at 320×180 you can still read every word and name the subject.

## Find a bold font

```sh
fc-list : family style | grep -iE 'black|heavy|extrabold|bold' | grep -viE 'mono|serif|italic|oblique|narrow|condensed|nerd' | sort | head
```

Put the family name (for example `Roboto`, `DejaVu Sans`, `Liberation Sans`) in `font-family`, with `font-weight="900"`; fontconfig picks the heaviest face it has.

## SVG template

Width per line ≈ 0.62 × font size × characters, for bold capitals. Keep it under about 700 px, or shrink the font.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B1020"/>
      <stop offset="1" stop-color="#3A0D5C"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.76" cy="0.46" r="0.5">
      <stop offset="0" stop-color="#FF7A1A" stop-opacity="0.65"/>
      <stop offset="1" stop-color="#FF7A1A" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#bg)"/>
  <rect width="1280" height="720" fill="url(#glow)"/>

  <!-- SUBJECT: one bold, simple object in the right 40% (here a terminal window). -->
  <g transform="translate(820 170) rotate(-4)">
    <rect width="400" height="300" rx="30" fill="#0F172A" stroke="#FFFFFF" stroke-width="10"/>
    <circle cx="44" cy="40" r="12" fill="#FF5F56"/>
    <circle cx="82" cy="40" r="12" fill="#FFBD2E"/>
    <circle cx="120" cy="40" r="12" fill="#27C93F"/>
    <text x="40" y="170" font-family="DejaVu Sans Mono, monospace" font-weight="700" font-size="96" fill="#27C93F">&gt;_</text>
  </g>

  <!-- SHAPE: an arrow from the words to the subject. -->
  <path d="M 560 570 C 640 610, 730 570, 790 490" fill="none" stroke="#FFD400" stroke-width="22" stroke-linecap="round"/>
  <polygon points="762,478 828,456 810,522" fill="#FFD400"/>

  <!-- TEXT: a shadow copy, then the stroked copy (paint-order puts the stroke under the fill). -->
  <g font-family="Roboto, DejaVu Sans, sans-serif" font-weight="900" font-size="156" letter-spacing="-3">
    <text x="72" y="270" fill="#000000" fill-opacity="0.55" transform="translate(8 10)">IT RUNS</text>
    <text x="72" y="430" fill="#000000" fill-opacity="0.55" transform="translate(8 10)">MY WEEK</text>
    <text x="72" y="270" fill="#FFFFFF" stroke="#000000" stroke-width="14" stroke-linejoin="round" paint-order="stroke">IT RUNS</text>
    <text x="72" y="430" fill="#FFD400" stroke="#000000" stroke-width="14" stroke-linejoin="round" paint-order="stroke">MY WEEK</text>
  </g>
</svg>
```

Escape `&` as `&amp;` and `<` as `&lt;` in text. To place a Brand assets image, copy it next to the SVG first (`cp references/<file> renders/brand.jpg`) and use `<image href="brand.jpg" x="820" y="120" width="400" height="480" preserveAspectRatio="xMidYMid slice"/>`. rsvg-convert silently drops images outside the SVG's folder, such as `../references/…`.

## Render and check

```sh
mkdir -p renders
rsvg-convert -w 1280 -h 720 renders/thumb-a.svg -o renders/thumb-a.png
python3 -c "from PIL import Image; im = Image.open('renders/thumb-a.png'); print(im.size); im.resize((320, 180)).save('renders/check-a.png')"
```

Look at both PNGs. At 320×180 every word must read and the subject must be obvious. If not: fewer words, bigger text, more contrast, less detail. `inkscape renders/thumb-a.svg -w 1280 -h 720 -o renders/thumb-a.png` also renders.

## Pillow fallback

When SVG text will not behave, draw it with Pillow:

```python
import subprocess
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
TOP, BOTTOM = (11, 16, 32), (58, 13, 92)
LINES = [("IT RUNS", (255, 255, 255)), ("MY WEEK", (255, 212, 0))]
OUT = "renders/thumb-b.png"

def bold_font():
    # The heaviest upright sans installed, preferring common display families.
    rows = subprocess.run(["fc-list", "--format", "%{file}|%{family[0]}|%{style[0]}\n"],
                          capture_output=True, text=True).stdout.splitlines()
    skip = ("Mono", "Serif", "Narrow", "Condensed", "Italic", "Oblique", "Nerd", "Code")
    weights = ("Black", "Heavy", "ExtraBold", "Bold")
    families = ("Inter", "Montserrat", "Roboto", "Noto Sans", "Open Sans", "Lato", "DejaVu Sans", "Liberation Sans", "Nimbus Sans")
    best = None
    for row in rows:
        path, family, style = (row.split("|") + ["", ""])[:3]
        if any(word in row for word in skip) or not any(w in style for w in weights):
            continue
        rank = (next(i for i, w in enumerate(weights) if w in style),
                next((i for i, f in enumerate(families) if family == f), len(families)))
        if best is None or rank < best[0]:
            best = (rank, path)
    return best[1]

img = Image.new("RGB", (W, H))
draw = ImageDraw.Draw(img)
for y in range(H):  # vertical gradient
    t = y / (H - 1)
    draw.line([(0, y), (W, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
draw.rounded_rectangle([830, 170, 1230, 470], radius=30, fill=(15, 23, 42), outline="white", width=10)  # subject

path, size = bold_font(), 170
while True:  # shrink until every line fits the left 60%
    font = ImageFont.truetype(path, size)
    widest = max(draw.textbbox((0, 0), text, font=font, stroke_width=12)[2] for text, _ in LINES)
    if widest <= 0.6 * W - 72 or size <= 90:
        break
    size -= 4
y = 140
for text, color in LINES:
    draw.text((80, y + 10), text, font=font, fill=(0, 0, 0))  # shadow
    draw.text((72, y), text, font=font, fill=color, stroke_width=12, stroke_fill=(0, 0, 0))
    y += int(size * 1.05)
img.save(OUT)
print(OUT, img.size, path, size)
```

Save it as `renders/thumb-b.py` and run `python3 renders/thumb-b.py` from the workspace root. To add a Brand assets photo, `Image.open("references/<file>")`, resize it, and `img.paste()` it before drawing the text.
