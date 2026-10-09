# YouTube theme: Frameboard's visual system

Frameboard is a production board for one YouTube creator. Its first job is
thumbnail creation: every card is a video in progress, and the person using it
needs to judge whether a thumbnail and title will work where viewers see them.

So the interface takes YouTube's colors, type and shape language in both of
YouTube's themes, light and dark, without copying YouTube's layout. It stays a
kanban: projects in a sidebar, lanes of cards, a card editor that slides in.

## Principles

1. **Thumbnails are judged on the real background.** The board background is
   YouTube's own: `#ffffff` in light, `#0f0f0f` in dark. The theme switch in
   the sidebar flips the whole app instantly, including while a card is open,
   so the same thumbnails can be compared in both.
2. **A card is a thumbnail and a title.** Cards show the display image (16:9,
   8px radius) and the title in YouTube's title style: Roboto 500, 16px/22px,
   clamped to two lines, as a viewer would see it. Only agent activity
   (working, input needed, done) also appears on the card. Everything else
   (intro, word count, images, edit time) lives in the card editor.
3. **YouTube's vibe, not its layout.** Pill buttons on a gray fill, a filled
   primary button in the text color, 8px chips, circular icon buttons, 12px
   rounded panels, the accent on focused field edges, the brand mark and the
   drop indicator. No feed grid, no fake views or avatars.
4. **One accent, used for marks and the primary action, never decoration.**
   See the Accent section: it is swappable, and red is only one of the options.
5. **Numbers mean order.** Lanes are numbered because they are pipeline stages
   in sequence.
6. **No template chrome.** No all-caps or letter-spaced labels, no eyebrows,
   no monospace for small labels, no decorative gradients or hover lift. No
   heavy condensed display type: the creator rejected it as a video-game look.
7. **Tools appear when wanted.** On devices that hover, lane tools stay hidden
   until the lane is hovered or focused, then overlay the end of the heading.
   Touch devices always show them.

## Themes

`public/theme.js` runs before the stylesheets apply and sets
`<html data-theme="light|dark">`. It uses the saved choice
(`localStorage['frameboard-theme']`), or the system preference until a choice
is made. `setTheme()` in `public/ui.js` switches and saves it.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--bg` | `#ffffff` | `#0f0f0f` | Page, sidebar, board, cards |
| `--surface` | `#ffffff` | `#212121` | Dialogs, the card panel, popovers |
| `--well` | `#f9f9f9` | `#181818` | Quiet inset areas: side navs, inspectors, settings panels |
| `--raised` | `#f2f2f2` | `#272727` | Buttons, chips, hover fills |
| `--raised-hover` | `#e5e5e5` | `#3f3f3f` | Hover on raised fills |
| `--border` | `#e5e5e5` | `#303030` | Hairlines, card outlines |
| `--border-strong` | `#cccccc` | `#4d4d4d` | Dashed drop zones |
| `--field` / `--field-border` | `#ffffff` / `#cccccc` | `#121212` / `#3d3d3d` | Inputs and text areas |
| `--text` | `#0f0f0f` | `#f1f1f1` | Text and primary buttons |
| `--muted` | `#606060` | `#aaaaaa` | Secondary text |
| `--faint` | `#6b6b6b` | `#909090` | Placeholders and tertiary text |
| `--on-text` | `#ffffff` | `#0f0f0f` | Text on a `--text` fill |
| `--accent` | per accent, see below | per accent | Primary button, brand mark, tab underline, marks, drop indicator |
| `--accent-text` | per accent | per accent | Links, focused field edges (`--mark`, `--brand-red`, `--blue` alias these) |
| `--green` | `#0b7a3b` | `#2ba640` | Saved, done |
| `--amber` | `#8a5b00` | `#f1b929` | Unsaved, waiting on input |
| `--danger` | `#cc0000` | `#ff6e66` | Errors, destructive actions |

Each status color has `-wash` (background) and `-line` (border) variants.
Every text color meets WCAG AA (4.5:1) on `--bg`, `--surface`, `--well` and
`--raised` in its theme.

Lane colors are small dots whose values read on both backgrounds.

## Accent

YouTube's neutrals alone read as a YouTube clone, so one saturated accent sits
on top of them, the way vidIQ and 1of10 do (both keep YouTube's grays and use a
single blue for their own actions; red stays YouTube's). The accent is a
swappable token set on `<html data-accent>`, chosen with the dots under the
theme switch and saved as `localStorage['frameboard-accent']`.

| Accent | Light fill / text | Dark fill / text | Note |
| --- | --- | --- | --- |
| `blue` (default) | `#2260f3` / `#2260f3` | `#4d8dff` / `#4d8dff` | 1of10's royal blue; vidIQ is close |
| `cyan` | `#00a3fd` with dark text / `#0071b8` | `#38b6ff` / `#38b6ff` | vidIQ's brand cyan; too light for white text, so fills take ink |
| `red` | `#cc0000` / `#cc0000` | `#ff6a62` / `#ff6a62` | YouTube's own; reads most like YouTube |
| `mint` | `#00a86b` with dark text / `#0b7a3b` | `#34c76a` / `#34c76a` | the "performing well" green both tools use for scores |

Tokens: `--accent` (fills, borders, marks), `--on-accent` (text on an accent
fill), `--accent-text` (the accent as text on a surface; always AA), and
`--accent-wash`. The older `--mark`, `--blue` and `--brand-red` names alias
these so every stylesheet follows the choice.

Where it goes, and nowhere else: the primary button, the brand mark, the active
tab underline, links, focused field edges, the drop indicator and drop targets,
and the display-image selection. Status colors (green, amber, danger, and
`--info` for "working") stay semantic and never change with the accent.

## Type

Roboto (variable, self-hosted) for everything. Monospace only where the
content is code or a Markdown file being edited.

- Project title: 32px, weight 700.
- Lane names: 16px, weight 700. Card titles: 16px/22px, weight 500, two lines.
- Card editor title: 20px/28px, weight 700, like a watch-page title.
- Body 14px, metadata 12px in `--muted`, nothing under 11px.

## Controls

Checkboxes and radios use `--blue` as their accent. Toasts are inverted
(`--text` fill with `--on-text` text), so they read as YouTube's notifications
do: dark on the light theme, light on the dark one.

## Shapes

Pill buttons (18px radius), 8px chips, circular icon buttons, 16px cards with
an 8px image window, 12px panels and dialogs, 8px inputs, 12px text areas,
4px overlay badges in YouTube's black-on-thumbnail style.

## Motion

Only motion that answers an action: the card panel sliding in, the toast, the
drop indicator. `prefers-reduced-motion` turns all of it off.
