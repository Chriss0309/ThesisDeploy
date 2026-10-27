# ThesisDeploy design system

Inspired by Spade ("The data & AI platform for modern finance"), not a clone. Every value below lives in one file, `app/tokens.css`, and an automated test fails the build if a raw color, font, type size, or arbitrary value shows up anywhere else.

## 1. Research and what we took

Spade was studied on its public site (spade.com at 1440 px and 390 px, plus its published stylesheet). No Spade assets, fonts, or copy are used.

| Spade does | ThesisDeploy takes | ThesisDeploy deliberately doesn't take |
|---|---|---|
| Warm, natural palette: near-black green ink, sage panels, sand, clay | Warm paper neutrals and a pine-tinted near-black ink | Spade's lemongrass lime and sage hero. Our accent is cobalt, so brand color never reads as "gain" or "positive" next to P&L and status greens |
| Display grotesk (NaN SuperX), text grotesk (FT Polar), typewriter mono (FT Polar Mono) | The same three roles: display, text, mono | The fonts themselves (proprietary). We use open-license Bricolage Grotesque, Instrument Sans, and IBM Plex Mono |
| Mono uppercase eyebrows with wide tracking, `►` markers, `[BRACKETED]` tags | Mono eyebrows and `►` markers for labels, table headers, and data captions | Bracketed tags (noise in a dense product UI) |
| 45° chamfered corners on panels and images | Chamfers on filled panels and the wordmark | Chamfers on bordered cards (clip-path cuts the border) |
| Corner tick marks framing stat cards | Registration marks on featured frames (the hero data card, message cards) | Marks on every card |
| Topographic, sliced line-art illustration | The idea of an engraved, sliced line object, rebuilt as an original three.js coin with a bull emblem | Spade's illustrations or any asset (none copied) |
| Big display numbers with a mono caption | Display-font money and counts with mono captions | Marketing-style vanity stats |
| Ruler ticks down the page margins | Ruler ticks only where they measure something (the coin stacks' baseline) | Decorative page-edge rulers |
| Alternating light and dark full-bleed sections, dark footer | One inverse ink panel per page at most ("How it works") | A dark footer and full-bleed dark bands (too heavy for a working tool) |
| Mono text on buttons ("Contact sales") | Mono on badges, nav, and link-arrows | Mono buttons. Buttons stay in the text face for readability |

## 2. Principles

1. **Paper and ink.** Warm paper surfaces, near-black ink, one cobalt accent. Color is scarce, so when it appears it means something.
2. **Numbers are the interface.** Money, shares, weights, and drift use tabular figures, sit right-aligned in tables, and always show a currency code. Big numbers use the display face.
3. **Annotate like an analyst.** Small mono uppercase labels name what a number is; the number itself stays plain.
4. **Honest states.** Paper vs Live, Trading vs Read-only, and overlap are never color-only: each badge carries a word, and Live is visually louder than Paper.
5. **Calm surfaces, sharp details.** Hairline borders and near-flat elevation; chamfers and registration marks are accents, used sparingly.
6. **Motion explains.** Animation shows real behavior (one order per second, whole shares stacking) and stops for reduced-motion users.

## 3. Fonts

All three load through `next/font/google` in `app/fonts.ts` (self-hosted at build time, `display: swap`, Latin subset), which is the only file allowed to import `next/font`. They're SIL Open Font License, and all three render tabular figures (verified: `111111` and `000000` measure the same width with `tabular-nums`).

| Role | Family | Token / utility | Weights | Use |
|---|---|---|---|---|
| Display | Bricolage Grotesque (variable, `opsz` axis) | `--font-display` / `font-display` | 600 | Headlines, page and card titles, big money and counts |
| Text / UI | Instrument Sans (variable) | `--font-sans` / `font-sans` (default) | 400, 500, 600 | Body, controls, table cells |
| Mono | IBM Plex Mono | `--font-mono` / `font-mono` | 400, 500 | Eyebrows, badges, tickers, masked account numbers, order IDs, timestamps |

`font-optical-sizing: auto` lets Bricolage tighten at display sizes. IBM Plex Mono was chosen over DM Mono because it separates `0/O` and `1/l` clearly in order IDs.

## 4. Type scale

Defined as Tailwind `--text-*` tokens (Tailwind's defaults are removed, so only these exist).

| Token | Size / line-height | Tracking | Use |
|---|---|---|---|
| `text-2xs` | 11 / 16 px | — | Eyebrows, badges, data-card captions (always mono uppercase) |
| `text-xs` | 12 / 18 px | — | Helper text, notices, legends |
| `text-sm` | 14 / 22 px | — | Default UI and table text |
| `text-base` | 16 / 24 px | — | Body, inputs on mobile (prevents iOS zoom) |
| `text-lg` | 18 / 28 px | — | Lead paragraph |
| `text-xl` | 20 / 28 px | -0.01em | Card titles (display), step titles |
| `text-2xl` | 24 / 32 px | -0.015em | Account name, cash amounts |
| `text-3xl` | 32 / 38 px | -0.02em | Page titles (mobile), section statements |
| `text-4xl` | 40 / 44 px | -0.025em | Page titles (desktop) |
| `text-display` | clamp(40 px, 1.6rem + 3.2vw, 68 px) / 1.0 | -0.035em | One hero headline per page |

Label tracking: `tracking-label` (0.14em) for eyebrows, `tracking-badge` (0.06em) for badges. The `eyebrow` utility bundles mono, 2xs, medium, label tracking, and uppercase.

## 5. Color

### Primitives (only `app/tokens.css` references these)

| Ramp | Steps |
|---|---|
| Paper | 0 `#fffdf8` · 50 `#f7f4ec` · 100 `#efebe0` · 200 `#e3ded0` · 300 `#cfc9b7` |
| Ink | 400 `#8a8f86` · 500 `#6b7169` · 600 `#545a53` · 700 `#3b413c` · 800 `#222924` · 900 `#141a16` · 950 `#0c100d` |
| Cobalt | 50 `#eef1fd` · 100 `#dfe4fb` · 200 `#c3cbf6` · 300 `#9aa9f0` · 400 `#7084e6` · 500 `#4d63d6` · 600 `#3449c2` · 700 `#2a3a9e` · 800 `#213077` |
| Moss | 50 `#ecf4e4` · 200 `#c3daa9` · 500 `#4f8f2a` · 600 `#3d7a1f` · 700 `#2f5f17` |
| Ochre | 50 `#faf1d8` · 200 `#ecd592` · 500 `#c99a1e` · 700 `#7a5806` |
| Brick | 50 `#fbede8` · 200 `#efc3b4` · 500 `#cf5233` · 600 `#b33a1f` · 700 `#922e17` |

### Semantic tokens and contrast (WCAG 2.2; text needs 4.5:1, UI boundaries 3:1)

| Token (Tailwind class) | Light value | Pair checked | Ratio |
|---|---|---|---|
| `background` / `foreground` | paper-50 / ink-900 | foreground on background | 16.07 |
| `card` | paper-0 | foreground on card | 17.37 |
| `muted-foreground` | ink-600 | on background / card / muted / secondary-hover | 6.45 / 6.97 / 5.95 / 5.27 |
| `placeholder` | ink-500 | on card | 4.93 |
| `primary` / `primary-foreground` | ink-900 / paper-50 | button text | 16.07 |
| `brand` (cobalt-600), `highlight` | cobalt-600 | on background / card / hero tint | 6.64 / 7.18 / 6.13 |
| `brand-foreground` | paper-0 | on brand | 7.18 |
| `positive-subtle-foreground` on `positive-subtle` | moss-700 on moss-50 | badge | 6.72 |
| `warning-subtle-foreground` on `warning-subtle` | ochre-700 on ochre-50 | badge | 5.78 |
| `negative-subtle-foreground` on `negative-subtle` | brick-700 on brick-50 | badge, error notice | 7.00 |
| `info-subtle-foreground` on `info-subtle` | cobalt-700 on cobalt-50 | Paper badge, demo banner | 8.48 |
| `destructive` | brick-600 | on background / card | 5.39 / 5.83 |
| `input` (field border) | ink-400 | on card | 3.25 |
| `ring` (focus) | cobalt-600 | on background | 6.64 |
| `border`, `border-strong` | paper-200, paper-300 | decorative dividers only | — |
| `warning` (dot fill) | ochre-500 | always paired with a text label | 2.54 (decorative) |

**Inverse theme.** Adding `dark` to any container remaps the same semantic tokens to ink: background ink-950, card ink-900, foreground paper-50 (17.44), muted-foreground ink-400 (5.80 on ink-950, 5.34 on ink-900), highlight cobalt-300 (8.50 / 7.83). Components need no changes inside an inverse panel. A full dark mode is out of scope for v1, but the tokens support it.

**Data visualization.** Holdings use `chart-1`…`chart-5` (cobalt-800 → cobalt-300, largest first), "Other" uses `chart-other` (paper-300), and cash uses the `hatch` pattern (moss lines on moss-50) so it's distinguishable by pattern, not just hue. The pale ramp end falls below 3:1 against the track, so every bar's values are also given as text (legend plus `aria-label`). Drift uses `drift-over` (ochre) and `drift-under` (cobalt-400), with `chart-target` (ink) as the target tick.

**Rules.** Never place semantic color on text without a word next to it. Use brand only for links, focus, selection, the one highlighted phrase per headline, and Paper/info. Gains and losses use positive and negative, never brand.

## 6. Spacing and layout

- 4 px base (`--spacing: 0.25rem`). Use steps 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20.
- Card padding: 20 px (`--card-spacing: --spacing(5)`), 16 px for `size="sm"`.
- Page gutters: 16 px on mobile, 24 px from `sm`, 48 px inside the hero panel on desktop.
- Containers: `max-w-page` (76rem) for every page, `max-w-prose` (36rem) for paragraphs.
- Named grid tracks: `--grid-hero` (two equal columns), `--grid-xray` (17.5rem sidebar plus content), `--grid-steps` (three columns). Use them as `grid-cols-(--grid-xray)`.
- Breakpoints are Tailwind's defaults. Layouts collapse to one column below `lg` (1024 px), and the account list becomes a horizontal snap scroller below `lg`.

## 7. Shape, borders, elevation, motion

| Token | Value | Use |
|---|---|---|
| `rounded-xs` / `sm` / `md` / `lg` / `xl` | 2 / 4 / 6 / 8 / 12 px | Bars / badges, small buttons / buttons, inputs, tiles / cards / large panels |
| `rounded-full` | — | Preset chips, status dots |
| `--chamfer-sm` / `--chamfer` / `--chamfer-lg` | 6 / 12 / 20 px | `chamfer` utility on filled surfaces only (wordmark, hero, and inverse panels) |
| `--frame-mark-size` / `--frame-mark-weight` | 12 px / 1.5 px | `frame-marks` utility: registration marks on featured frames |
| `--slider-thumb-border` | 1.5 px | Slider thumb ring (`border-(length:--slider-thumb-border)`) |
| Borders | 1 px `border` (dividers), `border-strong` (table header rule, neutral badge), `input` (fields) | Cards use a 1 px ring in `border` |
| `shadow-xs` | 1 px hairline | Cards at rest |
| `shadow-sm` | soft 2 px | Selected account tile, message cards |
| `shadow-md` | 10–28 px soft | Floating data cards, the hero thesis card, popovers |
| `shadow-lg` | 28–64 px | Drawers and modals |
| `--duration-instant` / `fast` / `base` / `slow` | 80 / 140 / 220 / 360 ms | Press / hover and color (default transition) / panels and toasts / drawers and fades |
| `--duration-pace` | 1000 ms | The order-pacing pulse (`animate-pace`) |
| `ease-standard` / `ease-enter` / `ease-exit` | cubic-bezier(.2,0,0,1) / (0,0,.2,1) / (.4,0,1,1) | Default / entering / leaving |

Under `prefers-reduced-motion: reduce`, CSS animations and transitions collapse to near zero, and the hero coin renders a single still frame.

## 8. Numbers and currency

- **Tabular figures everywhere numbers can change or align:** `tabular-nums` on money, shares, weights, timestamps, and counters.
- **Money:** symbol, grouping, two decimals, then the ISO code: `$4,951.75 CAD`. The code is always shown, because accounts mix CAD and USD and amounts are never converted (`formatMoney`). In display size (cash tiles, totals), use `font-display`.
- **Negative money:** typographic minus before the symbol, `−$14.00 USD`, in `negative` only when it's a loss, never just because it's an outflow.
- **Percent weights:** one decimal, `21.1%` (`formatPercent`). **Drift:** signed percentage points, `+2.4 pts` / `−5.1 pts`; past ±5 pts it takes the warning tone and the "Rebalance recommended" badge.
- **Shares:** integers for orders (`BUY 6 ETN`); fractional holdings show up to four decimals (`formatUnits`).
- **Prices:** two decimals (four below $1.00).
- **Missing values:** an em dash `—`, muted, never `0` or `N/A`.
- **Tickers, masked account numbers, order IDs:** mono (`ENB.TO`, `****4821`, `st_98a…`).
- **Timestamps:** `Oct 26, 2026, 1:30 PM UTC` in prose; `00:02s` elapsed offsets in the execution log.
- **Alignment:** numeric columns are right-aligned, and headers align with their column.

## 9. Components

Status: **Built** means shipped in this PR; **Spec** means the contract for upcoming screens (Thesis Studio, pre-flight, My Theses).

### Buttons (Built: `components/ui/button.tsx`)
Text face, medium weight, `rounded-md`. Sizes: `xs` 24 px, `sm` 32, `default` 36, `lg` 44 (the primary CTA and every touch-first action; 44 px meets the touch-target guideline).

| Variant | Look | Use |
|---|---|---|
| `default` | Ink fill, paper text | One primary action per region (Sign in with SnapTrade, Open Portfolio X-Ray) |
| `brand` | Cobalt fill | Commit actions in a flow (Deploy basket, Run paper execution) |
| `outline` | Card fill, `input` border; pressed state = ink border | Secondary actions, toggles, preset chips (`rounded-full`) |
| `secondary` / `ghost` | Paper-100 fill / none | Tertiary actions, toolbars |
| `destructive` | Brick text, brick-50 hover | Disconnect, Remove, Close thesis (always behind a confirm when it places orders) |
| `link` | Cobalt text, underline on hover | Inline navigation |

Focus: 3 px `ring/30` plus `ring` border. Disabled: 50% opacity, no pointer events. Live order buttons also need the confirm modal.

### Inputs (Textarea Built; text input, select, and toggle Spec)
`rounded-md`, 1 px `input` border, card fill, `px-3 py-2.5`, `text-base` on mobile and `text-sm` from `md`. Placeholder uses `placeholder`. Focus: `ring` border plus `ring/25` glow. Invalid: `destructive` border plus helper text below in `negative-subtle-foreground`. Labels sit above as `text-sm font-medium`; helper text is `text-xs muted-foreground`. Toggles (Overlap mode, Live vs Paper) are a segmented control: two outline buttons in one rounded group, with the selected one in ink fill.

### Capital slider and weight sliders (Built: `components/ui/slider.tsx`, Base UI)
Track: 4 px `chart-track`, `rounded-full`; fill: `brand`; thumb: 18 px paper-0 circle, 1.5 px ink border, `shadow-sm`, with a 3 px `ring/30` focus ring. The value is shown above the right end in `font-display text-xl tabular-nums` (`$2,500 USD`), with min and max in `eyebrow` under the ends. Keyboard: arrows step $50 (1% for weights), Page Up/Down step $500 (5%). The weight slider sits inline in the constituent row, at 120 px on desktop and full width on mobile.

### Whole-share stepper (Built in the Basket Composer)
`[−] 12 [+]` in one 32 px `outline` group: icon buttons `icon-sm`, a mono `tabular-nums` count field 48 px wide, centered. `−` is disabled at 0; `+` is disabled when the next share costs more than the cash left under the solver's spend cap (the budget less the slippage reserve), so a basket can never go over budget. The disabled `+` stays focusable (`focusableWhenDisabled`), puts the reason in its accessible name, and shows it in a tooltip (Built: `components/ui/tooltip.tsx`; `primary` fill, `text-xs`, `rounded-md`, `shadow-md`) on hover and keyboard focus: "Needs $98.40 USD, $86.00 USD left after the slippage reserve". Changes recalculate cost and remainder immediately.

### Badges (Built: `components/ui/badge.tsx`)
20 px tall, `rounded-sm`, 1 px border, mono `text-2xs` uppercase, `tracking-badge`. An optional `dot` adds a 6 px status dot.

| Badge | Tone | Notes |
|---|---|---|
| Trading | `positive` + dot | Account can place orders |
| Read-only | `warning` + dot | Capability reason shown next to it |
| Disabled | `negative` + dot | Links to the SnapTrade Dashboard |
| Paper | `info` | Simulation; never green |
| Live | `solid` (ink) + pulsing positive dot | Deliberately louder than Paper |
| New exposure | `positive` | "You hold $0 of this" |
| Overlap adjusted | `warning` | With a sentence in the row: "You already hold $1,850 (11.2%) of CEG in Wealthsimple TFSA. Target reduced from 25% to 10%." |
| Rebalance recommended | `warning` + dot | On basket cards past ±5 pts drift |
| Margin, STOCK, ETF | `neutral` | Facts, not states |
| Counted in cash | `info` | Cash-equivalent positions |

### Cards (Built: `components/ui/card.tsx`)
Card fill, `rounded-lg`, 1 px `border` ring, `shadow-xs`; header with an optional eyebrow, a title (sans semibold, or display `text-xl` for hero cards), and a description; the footer sits on `surface-sunken` with a top border. **Basket card (Spec):** eyebrow `► Thesis`, display title, risk badge, then a capital line in `font-display tabular-nums` ("$2,380 USD deployed · $120 USD unallocated"), constituent rows, and a footer with the primary action. **Cash tile (Built):** `surface-sunken` fill, `rounded-md`, eyebrow `► Cash · CAD`, display amount, buying-power line.

### Tables (Built: positions)
Header row: `eyebrow` in `muted-foreground` with a `border-strong` rule under it. Rows: 12 px vertical padding, `border` dividers, `surface-sunken` on hover. Symbol column: mono ticker, description under it in `text-xs muted`. Numeric columns are right-aligned and `tabular-nums`; the primary value column is medium weight. **Mobile:** hide secondary columns (Type, Price) and move their badges under the symbol, so the key numbers fit without horizontal scroll. Wide tables scroll inside the card from `sm` up (`min-w-(--table-min)`).

### Navigation (Built: `components/site-chrome.tsx`, page shell)
A 64 px header with a bottom `border`: the wordmark (chamfered ink "TD" tile plus "ThesisDeploy" in display semibold) on the left, and mono `eyebrow` links on the right. Active link: foreground color plus a 2 px cobalt underline (`aria-current="page"`). Every page has a page header: eyebrow (`► 01 · Read from SnapTrade`), display title, and a muted description. **Account selector:** tiles with name, net value (tabular), institution plus mono masked number, and badges; selected = ink border plus `shadow-sm`; a vertical list from `lg` and a horizontal snap scroller below. **Banners:** the full-width demo banner uses `info-subtle`.

### Drawers and modals (Spec: pre-flight, execution, telemetry)
Scrim: `overlay` (ink-950 at 45%). Modal: card fill, `rounded-xl`, `shadow-lg`, max-width 40rem, 24 px padding, with the title in display `text-2xl`. Drawer: slides from the right on desktop (28rem) and from the bottom on mobile (90 vh, `rounded-t-xl`) over `duration-slow ease-enter`. **Pre-flight modal:** the order list as a mono table (`BUY 4 VST @ MKT`, est. cost right-aligned), the Live vs Paper segmented control, then the primary action whose label names the mode ("Submit 4 live orders" in brand, or "Run paper simulation" in default). Live is disabled with an inline reason when the market is closed, the connection is read-only, or cash is short. Focus is trapped, Esc closes (except while orders are submitting), and focus returns to the trigger.

### Toasts (Spec)
Bottom-right on desktop, bottom-center on mobile, above safe-area insets. Card fill, `rounded-md`, `shadow-md`, with a 3 px left rule in the tone color (positive, warning, negative, info), a `text-sm` message, and an optional action. Auto-dismiss after 5 s (errors persist until dismissed), with `role="status"` (`alert` for errors). Use them for background results only ("Refreshed from SnapTrade"); anything that needs a decision stays inline.

### Execution progress stepper (Spec; the hero animation previews it)
A vertical log, one row per step, mono `text-xs`: elapsed offset `[00:02s]` (muted, tabular), the label (`Submitting leg 2/4 · BUY 6 ETN @ MKT`), then a status badge on the right: Validating (warning + pulsing dot), Pacing (neutral, `animate-pace`, "1 req/sec"), Submitted (positive, with the order ID in mono), Failed (negative, with the brokerage reason on a second line and a "Retry failed leg" outline button). A thin progress bar at the top uses `brand` fill over `chart-track`. The queue never hides a failed leg: it continues, and the summary reads "3 of 4 legs submitted · 1 failed". Rows animate in with `duration-base`; there's no spinner for steps that are paced, not loading. The current row has `aria-current="step"`, and the log is `aria-live="polite"`.

### Concentration and drift bars (Concentration Built; drift Spec)
**Concentration:** a 16 px bar, `rounded-xs`, segments separated by 1 px gaps on `chart-track`, ordered largest holding first, then Other, then hatched cash. The legend uses 10 px squares, a mono label, and a tabular percent, followed by a summary sentence ("Largest position: ENB.TO at 21.1%…"). The bar has an `aria-label` listing every segment. **Drift (dual bar), per constituent:** a 6 px track; current weight as a `brand` fill; target weight as a 2 px ink tick extending 4 px above and below; the gap between them shaded `drift-over` or `drift-under` at 60%. The signed drift (`+2.4 pts`) is right-aligned and tabular, and past ±5 pts it turns warning and the card shows "Rebalance recommended". On mobile the bar spans the full row width under the ticker.

### Data cards and the hero illustration (Built: `components/landing/`)
Floating mono data cards (`frame-marks` on `surface-tint`, or a card with `shadow-md`) carry the live "leg" log and the whole-share counter, echoing Spade's annotated hero without its content. **The hero coin** is an original three.js scene. An engraved coin (lathe profile with a raised rim and reeded edge) carries an original extruded bull-head emblem in cobalt. Its surfaces are drawn as world-space slice lines that thicken on the shaded side, an engraving take on contour line-art. Below it, four stacks of whole-share coins drop in one order leg per second onto a ruled baseline, synced with the data cards. Colors are read from `--illustration-*` tokens at runtime. three.js loads lazily after hydration (about 140 KB gzipped, a separate chunk) and pauses offscreen and in hidden tabs. Pixel ratio is capped at 2. Reduced motion gets one still frame. Without WebGL, the data cards still render.

## 10. Implementation and enforcement

- `app/tokens.css`: primitives, semantic (shadcn-compatible) variables, the inverse theme, and the Tailwind `@theme`. It resets Tailwind's default colors, fonts, type sizes, radii, shadows, and easings (`--color-*: initial` and so on), so a stray `bg-sky-50` or `text-[11px]` generates nothing.
- `app/fonts.ts`: the only `next/font` loader. `app/globals.css` holds imports, base styles, and the token-only utilities `eyebrow`, `chamfer`, `frame-marks`, and `hatch`.
- `lib/design/token-usage.test.ts` (runs in `npm test` and CI) scans `app/`, `components/`, and `lib/`, and fails on hex, color functions, `0xRRGGBB` literals, Tailwind palette classes, `font-family` / `fontFamily` / `@font-face`, `next/font` outside `app/fonts.ts`, inline font sizes, arbitrary values (`text-[11px]`, `min-w-[640px]`), and arbitrary properties with raw values. Token references (`grid-cols-(--grid-xray)`, `[--chamfer:var(--chamfer-sm)]`) and variants (`data-[size=sm]:`) are allowed. On the pre-restyle code it reports 105 violations.
- **Adding a value:** add a primitive and a semantic token in `app/tokens.css`, map it in `@theme inline` if it needs a utility, document it here, then use the class.
