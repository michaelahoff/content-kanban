# Design brief

How to write the brief that Mockup builds from and the owner could read. Its job: decide what this business's site should feel like and do, with reasons a skeptical owner would accept.

## Quality bar

- **Specific.** Swap test: if another business's name could replace this one and the brief still read true, it is too generic. Name their products, their street, their regulars' reasons for coming.
- **Evidenced.** Every taste claim points at something: "Instagram is mostly flat-lays on the worn wood counter, shot in morning window light."
- **The owner's taste, not yours.** Evolve what they already show; depart only with a stated reason.
- **One primary action.** Every page earns its place by moving a visitor toward it.
- **Phone first.** Most visitors arrive from a map listing or a link in a bio, on a phone, wanting hours, location and the one thing they came for.
- **Maintainable.** The owner updates hours, menus and events themselves. Propose no blog or feature they would have to feed weekly unless they already post that often.
- **Honest.** Facts from Research only; anything invented is marked "(placeholder)".

## Structure (use these headings, in this order)

```
# <Business> — design brief
## Revision                (only after a rework: what changed, and fixes for Mockup)
## Summary                 (3 sentences: who they are, what the site must do, how it should feel)
## Positioning             (one sentence; what sets them apart in this town, with evidence)
## Audience                (2–3 groups: who, why they visit the site, what they need first)
## Brand personality       (3 adjectives; each with evidence and what it means for the design)
## Identity: evolve or depart  (one line of decision plus the reason)
## Palette                 (table: role | hex | use | contrast)
## Typography              (display and text faces, scale, fallback stacks)
## Site map                (pages, one line each)
## Pages                   (### per page: purpose, content blocks in order, key action)
## Homepage hero           (headline, subhead, primary CTA, secondary CTA, image direction)
## Web-app feature         (what, why it fits, first version, what it needs; or "None, because …")
## Copy angles             (3 angles, each with a sample headline; name the one the homepage uses)
## Imagery direction       (what to photograph, light, framing; how the mockup stands in)
## Avoid                   (5–8 concrete don'ts for this business)
## Facts to verify         (anything not confirmed in Research)
```

## Palette

Five or six colors with roles: background, surface, text, muted text, primary (the action color), accent. Derive them from the business's own colors. State each text and background pair's contrast ratio; body text needs 4.5:1, large text and controls 3:1. Compute rather than estimate:

```sh
python3 -c "
def l(h):
    c=[int(h[i:i+2],16)/255 for i in (1,3,5)]
    c=[x/12.92 if x<=0.03928 else ((x+0.055)/1.055)**2.4 for x in c]
    return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
def r(a,b):
    a,b=sorted([l(a),l(b)],reverse=True); return round((a+0.05)/(b+0.05),2)
print(r('#1F2A24','#F6F1E7'))"
```

## Typography

Name faces as on Google Fonts (for example Fraunces, Inter, Work Sans, DM Serif Display), at most two families, with weights and a size scale. Give each a system fallback stack; the mockup uses only the stack and notes what it would be.

## Web-app feature

Fit it to the primary action: custom-cake or pre-orders for a bakery, booking for a salon or barber, rentals or service drop-off for an outfitter, holds, preorders or event RSVPs for a bookshop, a loyalty card for a café with regulars. Describe the first version in 3–5 bullets, the service it could run on, and what the owner must do weekly to keep it alive.
