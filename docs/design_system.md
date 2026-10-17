# ShopPilot AI — Design system

> Theme: **Ledger** — warm paper, ink, one navy accent, a serif for display type.
>
> The implementation is `app/shop/styles.css` §1 (tokens). This document explains *why* the tokens
> are what they are, so a future change can be made deliberately rather than by taste.

---

## 1. Why this theme

ShopPilot is a store, not a dashboard, and the first version of it looked like a dashboard: indigo
gradients, glassmorphic chrome, glow shadows, and a purple "AI" pill. That vocabulary is everywhere
in 2026 and it says *"this is a demo built to show off an LLM"* — the opposite of the impression a
shop needs to make. Worse, a saturated gradient hero competes with the product photography, which is
the one thing on the page that should carry colour.

**Ledger** inverts those priorities:

| Decision | Reasoning |
|---|---|
| Warm off-white canvas (`#faf9f7`) instead of blue-tinted grey | Product photography is shot on white. On a cool grey the cards look tinted; on warm paper they read as merchandise on a shelf. |
| One accent (navy `#17458f`), used only for identity and selection | An accent that appears everywhere stops meaning anything. Links, focus rings, the agent avatar and the active nav tab are the *only* things that are navy. |
| Primary buttons are **ink**, not a colour | "Add to cart" in navy or green fights the product photos for attention. Near-black recedes and lets the merchandise be the colour on the page. |
| Hairlines, not shadows | Structure is drawn with 1px warm borders plus space. One elevation step per surface; no glow, no gradient mesh, no backdrop blur. |
| A system serif for display type | Page titles and the first-run hero are set in `ui-serif` at weight 400. Costs nothing to load (already on the device) and is the single clearest signal that this is a shop and not a SaaS console. |
| Semantic tokens only | Every component rule uses `var(--color-*)`. Fixed palette steps were replaced wherever they appeared, because a fixed `--gray-50` stays near-white in dark mode while the text around it turns near-white too. |

---

## 2. Colour

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--color-bg` / `--color-canvas` | `#faf9f7` | `#121110` | page background |
| `--color-surface-1` | `#ffffff` | `#1a1917` | cards, panes, top bar, bubbles |
| `--color-surface-2` | `#f4f2ee` | `#232120` | inset tiles, skeleton, hover fill |
| `--color-surface-3` | `#e9e5df` | `#2c2a28` | pressed / tertiary fill |
| `--color-border` | `#e7e2db` | `#2e2b28` | every hairline |
| `--color-border-strong` | `#d6d0c7` | `#423e3a` | input borders, section rules |
| `--color-text` | `#14120f` | `#f2efe9` | body and headings |
| `--color-text-muted` | `#7a746c` | `#a8a29a` | secondary copy |
| `--color-text-subtle` | `#a8a29a` | `#7a746c` | metadata, placeholders |
| `--color-primary` | `#14120f` (ink) | `#f2efe9` (paper) | primary buttons — flips with the theme |
| `--color-on-primary` | `#ffffff` | `#14120f` | label on a primary button |
| `--color-accent` | `#17458f` (navy) | `#8bb0e3` | links, focus, agent identity, active tab |
| `--color-success` | `#157347` | `#6ecf9f` | paid, in stock, capture verified |
| `--color-warning` | `#a15c07` | `#e0b072` | low stock, payment pending, over budget |
| `--color-danger` | `#b42318` | `#f09c94` | failed, expired, forged capture |
| PayPal | `linear-gradient(#0070ba → #003087)` | same | **only** on the PayPal button itself |

The PayPal gradient is the one gradient that survives. It is there because it is PayPal's own
identity on the one control that hands the shopper to PayPal — not decoration.

**Contrast:** body text on surface-1 measures 13.9:1 in dark and 15.8:1 in light. Every badge and
pill is built with `color-mix` against its own surface, so tinted states scale with the theme rather
than being hand-picked twice.

---

## 3. Type

| Role | Family | Size / line-height | Weight | Notes |
|---|---|---|---|---|
| Display (hero) | `--font-display` (system serif) | 44 / 1.06 | 400 | `max-width: 20ch`; the accent line is italic navy |
| Page title (h1) | `--font-display` | 30–32 / 38 | 400 | Catalogue, Orders, Merchant |
| Section (h2) | sans | 19 / 25 | 660 | pane headers |
| Body | sans | 15 / 23 | 400 | chat text is 14.5 / 23 |
| Small | sans | 12.5 / 18 | 400 | `.note` |
| Eyebrow | sans | 11 / — | 680, `0.07em` tracking, uppercase | `ACCOUNT`, `CATALOGUE` |
| Money | sans, tabular-nums | 22 / 1.15 | 720 | never in the serif — figures should look printed, not typeset |

No webfonts are loaded. `Inter` is used when the device has it and falls back to the OS UI face,
which is the same decision as the photography: no runtime dependency that can fail during judging.

---

## 4. Space, radius, elevation

- **Spacing scale**: 4 · 8 · 10 · 12 · 14 · 18 · 22 · 26 · 34 · 44. Components use the middle of the
  scale; page padding is 24px, pane padding 22px, card padding 14px.
- **Radii**: `6 / 8 / 12 / 16 / 20`. Product tiles are 12px, cards 14px, the drawer 16px. Nothing is
  a pill except badges, quick replies and stock chips — those are pills because they are labels, not
  containers.
- **Elevation**: `shadow-xs` (rest) → `shadow-sm` (hover) → `shadow-md` (drawer, modal) →
  `shadow-lg` (nothing currently). Warm-tinted (`rgba(20,18,15,…)`), never pure black, never a
  coloured halo.
- **Focus**: a 2px offset ring in accent navy via `:focus-visible` on every interactive element.
  Focus is never removed, only restyled.

---

## 5. Components

### Cards
```
[ 1:1 photograph on white tile        ]
[ Title                     5 in stock]
[ Brand · Merchant                   ]
[ ★★★★★ 4.8 (142)                    ]
[ $399.00   $449.00  −11%            ]
[ why-it-fits (agent) | description  ]
[ chips: RAM 16 GB · Storage 512 GB  ]
[ Add to cart            (ink, full) ]
[ Details                           ]
```
- The photo tile is **1:1** and holds the fallback gradient underneath, so a missing file degrades to
  the old art rather than a broken-image icon.
- The footer is a 2-column grid: primary action spans both columns, secondaries sit beneath. Three
  buttons in one row clipped the third at ~230px card widths.
- In dark mode the photo tile keeps a light backdrop (brightness 0.9 on the image) so merchandise
  still reads as merchandise instead of a lightbox punched into the page.

### Buttons
| Variant | Fill | Border | Use |
|---|---|---|---|
| `--primary` | ink | none | one per surface: Add to cart, Send, Sign in |
| `--secondary` | surface-1 | border-strong | Details, Cancel |
| `--ghost` | transparent | none | Compare, New search, nav links |
| `--danger` | danger 12% | danger 24% | Remove, force-failure demo controls |
| `--paypal` | PayPal gradient | none | the single PayPal handoff |

### Chat
- Agent bubbles are `surface-1` with a hairline; the user's bubble is ink with paper text. The
  asymmetry is the hierarchy — the shopper's words are the loudest thing in the log.
- Agent avatar is a 30px navy disc with "SP". No glow ring.
- Tool activity renders as a quiet one-line row (`search_products · 2 ms · 1 result`), not a card.
- The composer is a single field on `surface-2`; quick replies are outline pills that fill on hover.

### Status language
Every state is a pill with a `color-mix` fill of its own semantic colour: `Paid`, `Expired`,
`payment: Captured`, `simcap-…`, `split · 2 sellers`. Money-related states are always paired with the
*mechanism* (which capture, how many sellers), because the product's claim is verifiability.

---

## 6. Motion

| Interaction | Duration / easing |
|---|---|
| Hover (colour, border) | 140–160 ms, `cubic-bezier(0.22, 1, 0.36, 1)` |
| Card lift | 200 ms, translateY(−3px) |
| Message entry | 320 ms `fade-up` |
| Hero entry | 520 ms `fade-up` |
| Photo zoom on card hover | 420 ms, scale 1.045 |

Nothing animates on a loop except the single hero status dot and the skeleton breathe. All motion
respects `prefers-reduced-motion` via the global rule in §2.

---

## 7. Rules for changing this

1. **Never hard-code a palette step in a component.** Use a `--color-*` semantic token; a fixed
   `--gray-*` will not flip with the theme. This is the bug that made dark mode unreadable once.
2. **One accent.** If a new element needs to look "important", use weight, size or space first. Reach
   for `--color-accent` only when it is identity or selection.
3. **No new gradients**, except provider-branded controls (PayPal).
4. **Serif is for display only.** Anything under 20px is sans, including money.
5. **Every state needs a word, not just a colour.** Badges carry text; colour-blind users must be
   able to read the state without the hue.
