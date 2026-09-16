---
name: air-x-style
description: Use before touching any markup or CSS in Air X (static/diag.html, static/styles.css) or adding a screen or control. Metro, 2026: black, flat, typographic, square corners, one mango accent, every size in rem. Covers tokens, type scale, spacing, control anatomy, the hash-picked screen pattern, and what is off-limits.
---

# Air X style

Windows Phone 7 Metro, brought to 2026. Flat and typographic: black ground,
white type, one mango accent, square corners, no decoration. Every rule below
already lives in `static/styles.css`; extend it, do not fork it.

## Tokens (`:root` in styles.css)

| Token                    | Value               | Use                                                                                          |
| ------------------------ | ------------------- | -------------------------------------------------------------------------------------------- |
| `--bg`                   | `#000000`           | page ground                                                                                  |
| `--ink`                  | `#ffffff`           | text, outline buttons, radio ring when checked                                               |
| `--surface`              | `#141414`           | input fills, item cards                                                                      |
| `--surface-2`            | `#1a1a1a`           | camera preview, progress track                                                               |
| `--hairline`             | `#2a2a2a`           | 1px dividers (`<hr>`), card and preview edges                                                |
| `--border`               | `#4d4d4d`           | 2px input borders at rest, unchecked radio ring, switch track off                            |
| `--muted`                | `#9a9a9a`           | secondary text, estimates, elapsed time                                                      |
| `--label`                | `#c2c2c2`           | field labels, lede, item meta                                                                |
| `--accent`               | `#ffa31a`           | mango: tiles, primary button, links, expander summaries, radio dot, switch on, progress fill |
| `--accent-press`         | `#d98400`           | pressed tile and primary button                                                              |
| `--b1` / `--b2` / `--b3` | 1 / 2 / 3 px in rem | hairline / input and radio / button and file chooser                                         |
| `--gap`                  | `1.5rem`            | page margin (WP7's 24px) and rhythm between sections                                         |
| `--touch`                | `3rem`              | minimum control height                                                                       |

One accent. Never introduce a second hue, a gradient, a shadow, a blur, or a
border radius. Only the QR canvas is white.

## Type

Open Sans, self-hosted variable file at `static/fonts/open-sans.woff2` (weights
300 to 800, OFL). Fallback stack: `"Segoe UI", "Segoe WP", system-ui`. Root is
16px; everything else is rem.

| Role                                             | Size                                      | Weight               | Case                                           |
| ------------------------------------------------ | ----------------------------------------- | -------------------- | ---------------------------------------------- |
| App title (`.app`)                               | 0.9375rem                                 | 600, tracking 0.16em | UPPERCASE                                      |
| Page title (`h1`)                                | 4rem, line-height 0.95, tracking -0.025em | 300                  | lowercase, one word: `send`, `sending`, `sent` |
| Group heading (`h2`), progress count             | 1.5rem                                    | 300                  | lowercase                                      |
| Controls: button text                            | 1.25rem                                   | 600                  | Sentence case                                  |
| Inputs, radio and switch labels, lede, item text | 1.125rem                                  | 400 (lede 300)       | Sentence case                                  |
| Body, links, muted lines                         | 1rem                                      | 400                  | Sentence case                                  |
| Field labels, item meta                          | 0.875rem                                  | 400                  | Sentence case                                  |

Lowercase is for the big light words: page titles, tiles, group headings,
expander summaries. Anything a person reads as an instruction or a value is
sentence case with real capitals (`QR code`, `Start over`,
`Scan QR with
camera`).

## Spacing

Scale: 0.25 / 0.5 / 0.75 / 1 / 1.5 / 2 rem. Page padding is `--gap` on the sides
and top, 2rem at the bottom. Sections inside a screen sit `--gap` apart; fields
inside a `.stack` sit 1rem apart; label to control is 0.5rem; two-up `.row` and
`.tiles` gutters are 0.75rem (WP7's 12px). Column max width 36rem.

## Controls (anatomy, all in styles.css)

- **Text, number, select, textarea**: `--surface` fill, `--b2` `--border`
  border, white 1.125rem text, 0.625rem 0.75rem padding, `--touch` tall. Focus
  swaps the border to `--accent`; no outline ring. Selects hide the native arrow
  and paint a chevron data URI in `--label`.
- **File input**: bare, with `::file-selector-button` styled as an outline
  button (`--b3` white border, 600 weight).
- **Buttons**: full width, 3.25rem tall, `--b3` white border on transparent,
  1.25rem 600. `:active` inverts to white on black. `.primary` is mango fill
  with black text, pressed `--accent-press`. One primary per screen, and it is
  the same element that turns into Stop while a transfer runs (drop `.primary`
  and change the label; never add a second button).
- **Radios** (`.choices`): `appearance: none`, 1.625rem ring with `--b2` border;
  checked gets a white ring and a mango dot from a radial gradient. The label
  row is 2.75rem tall; the checked row's text is `--ink`, the rest `--label`.
- **Switch** (`.switch`): the WP7 slab. Label left, state word (`On`/`Off` from
  CSS `content`) and a 4.5rem by 0.75rem track right; the thumb is a 1.5rem by
  1.75rem white block that overhangs the track. On = mango track, thumb right.
  Use for a boolean that changes behaviour; use radios for a choice of three.
- **Expander** (`details > summary`): mango text with a rotated-border chevron,
  2.75rem tall. `.advanced` holds tuning inputs and is closed by default. `.log`
  is muted and hidden on the home screen.
- **Tiles** (`.tile`): square via `aspect-ratio`, mango fill, black stroke icon
  2.5rem top-left, 1.25rem label bottom-left. Icons are inline SVG, stroke 1.5
  on a 24 grid, square caps. Never emoji or glyph fonts.
- **Progress**: a `.bar` track 0.375rem tall on `--surface-2` with a mango `<i>`
  whose width JS sets, then a `.progress` row: `.count` (1.5rem light) left,
  muted timing right. One line each; the log holds the detail.
- **Hairlines**: `<hr>` between groups on a form screen. Cards (`.items li`,
  `.preview`) get a `--b1` `--hairline` edge on `--surface` or `--surface-2`.

## Screens

The page is one document with one `<section class="screen">` per step, ids
`screen-<name>`, picked by `location.hash` (`SCREENS` in `src/diag.ts`).
Changing screens aborts whatever the old one was running. Every screen after
home opens with the strip (`.strip`: app title left, `Start over` link to
`#home` right) and an `h1`. A step that runs a transfer keeps its form in a
`*-form` div and its live view in a `*-run` div; the button below both flips
label and `.primary`, and the title moves through present participle and past
tense (`send`, `sending`, `sent`).

To add a screen: a section with the strip and `h1`, an entry in `SCREENS`, and a
tile or link to `#<name>`. Ids must be unique across the whole document; a
button never shares an id with its section.

## Off-limits

Rounded corners, gradients, shadows, blur, emoji, icon fonts, external CSS or
font hosts, px values in CSS (rem only; the root is the single px), a second
accent, counters that duplicate the log, and any button that is not the screen's
one action or a camera flip.
