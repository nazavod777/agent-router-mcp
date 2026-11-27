# DESIGN.md — Settings Web UI ("Technical Ledger")

Source of truth for the look of `src/settings-ui/app.html`, the localhost settings page served by
`agrmcp settings`. Every value below is a token in the page's `:root` / theme blocks; a rule
you cannot read back out of the stylesheet is not a rule.

## Direction

- **Product:** a local operator console for editing the orchestrator catalog — models, harnesses, presets, limits.
- **Character:** calm, exact, utilitarian. It reports state and enables edits; it never sells.
- **World:** a technical ledger — warm stone paper in light mode, warm graphite ink in dark mode.
- **Moments:** dense operational tables, and the preset role matrix with its inspector drawer.
- **Signature:** 2.25rem editorial serif page titles, tabular monospace for technical metadata, 1px hairline rules instead of cards.

### Directions considered

| Direction | Type voice | Color | Verdict |
|---|---|---|---|
| Terminal Matrix | all-mono, neon accent | near-black + cyan/green glow | Rejected: the default AI "dev tool" cliché; mono as costume, halos as affordance. |
| **Technical Ledger** | serif display + humanist sans + tabular mono | warm neutrals + one emerald accent + 2 status hues | **Chosen**: reads like a well-kept register; hierarchy comes from type and rules, not boxes. |

## Tokens

### Type scale (100% token-based; no literal `font-size` outside `:root`)

| Token | Value | Use |
|---|---|---|
| `--text-xs` | 0.75rem | IDs, metadata, table headers, badges, hints |
| `--text-sm` | 0.875rem | body, table cells, controls |
| `--text-base` | 1rem | brand name, mobile inputs (prevents iOS zoom) |
| `--text-lg` | 1.25rem | limits section titles, dialog and empty-state titles |
| `--text-xl` | 1.625rem | drawer title, preset detail title, metric values, mobile page title |
| `--text-display` | 2.25rem | `.page-title` — leads every page |

Line heights: `--leading-tight` 1.15, `--leading-snug` 1.35, `--leading-body` 1.5. Never use the `font:` shorthand.

### Weight budget — exactly three

`400` dominant (body, cells, inputs, mono IDs, hints, descriptions) · `500` labels, headers, controls, nav ·
`600` display and section headings only. Count of `400` must exceed count of `600`.

### Faces (offline, zero CDN — the CSP forbids remote fonts)

| Token | Stack |
|---|---|
| `--font-display` | "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, ui-serif, serif |
| `--font-sans` | "IBM Plex Sans", "Inter", "Segoe UI", ui-sans-serif, sans-serif — never `system-ui` first |
| `--font-mono` | "JetBrains Mono", "SF Mono", "Cascadia Mono", Menlo, Consolas, ui-monospace, monospace |

No `@font-face` is shipped on purpose: the CSP forbids remote fonts, so a generic lint rule asking for a web font is an accepted miss.

### Spacing, radius, depth, motion

- **Spacing (4px base):** `--space-1..7` = 4 / 8 / 12 / 16 / 24 / 32 / 48. Inter-group gap ≥ 2× intra-group gap.
- **Touch target:** `--touch-target` 44px, applied under `@media (pointer: coarse)` as `min-height` / `min-width` (see Hard rules).
- **Radius:** `--radius-sm` 4px (controls, badges), `--radius-lg` 10px (dialog, toasts, save bar, empty state),
  `--radius-full` 999px (switch, dots). Flat ledger surfaces use `0`. Never `50%`.
- **Shadows:** `--shadow-1` (raised nav item, switch thumb), `--shadow-2` (save bar, toasts), `--shadow-3`
  (drawer, dialog, mobile rail). Each is two offset+blur layers. No zero-offset halos; focus is
  `outline: 2px solid var(--accent); outline-offset: 2px`, never a `box-shadow` ring.
- **Motion:** `--dur-fast` .15s feedback, `--dur-mid` .24s drawer/rail/entrance, `--ease` cubic-bezier(.2,.7,.2,1).
  Explicit property lists only (never `transition: all`); `prefers-reduced-motion` collapses all of it.

### Palette

Neutrals stay under 14% HSL saturation; at most three saturated hue families exist in the whole sheet.

| Role | Light (stone paper) | Dark (graphite ink) |
|---|---|---|
| `--bg` / `--surface` | `#f5f4f2` / `#ffffff` | `#121210` / `#181816` |
| `--surface-2` / `--surface-3` | `#edece8` / `#e2e0da` | `#21201d` / `#2c2b27` |
| `--border` / `--border-strong` | `#d4d0c7` / `#8f8a80` | `#3b3934` / `#6e6a62` |
| `--text` / `--text-2` / `--muted` | `#1d1c19` / `#4a4741` / `#6b675f` | `#ecebe7` / `#b9b6ae` / `#8c8980` |
| Emerald ~155°: `--accent` / `--accent-hover` | `#166547` / `#114f37` | `#44b582` / `#58c996` |
| `--accent-soft` / `--ok-ink` | rgba(22,101,71,.10) / `#12543b` | rgba(68,181,130,.14) / `#72d6a6` |
| Ochre ~35°: `--warn` / `--warn-soft` | `#8c5008` / rgba(140,80,8,.11) | `#e0a042` / rgba(224,160,66,.14) |
| Crimson ~358°: `--danger` / `--danger-soft` | `#a82428` / rgba(168,36,40,.10) | `#ec6d71` / rgba(236,109,113,.14) |

Light neutrals were nudged from the brief (`#f6f5f2`→`#f5f4f2`, `#eeece7`→`#edece8`, `#e3e0d9`→`#e2e0da`)
because the originals measured 15–18% saturation and would count as a fourth hue family.

Measured contrast (WCAG): every text token ≥ 4.5:1 on `--bg`, `--surface`, `--surface-2`. `--muted` drops to
4.26 (light) / 4.05 (dark) on `--surface-3` — never put muted text on `--surface-3`; use `--text-2`.
Soft-tinted badges: ≥ 4.88:1. `--border-strong` (input boundaries) is ≥ 3.12:1 on `--bg` and `--surface` but
only 2.91:1 on light `--surface-2` — keep inputs off `--surface-2`.
No blue, teal-mint, purple, or indigo — "info" states render neutral.

## App shell DOM contract (Pass 2 renders into these)

| Selector | Element / role | Notes |
|---|---|---|
| `.skip-link` | `a[href="#main"]` | first focusable element; `inert` (with `aria-hidden`, `tabindex="-1"`) while the drawer, the confirm dialog or the mobile rail is open |
| `.svg-sprite` | hidden inline `<svg>` | symbols: `i-brand i-models i-harnesses i-presets i-sliders i-search i-plus i-refresh i-reset i-sun i-moon i-copy i-check i-close i-alert i-shield i-chevron-right i-trash i-edit i-menu` (20×20, stroke 1.5, `currentColor`) |
| `.app-shell#app-shell` | grid: 240px rail + fluid workspace | receives `inert` while the drawer or confirm dialog is open |
| `.mobile-bar#mobile-bar` | `<header>`, shown ≤ 960px | `#rail-toggle` (`aria-controls="rail"`, `aria-expanded`), `#mobile-title` |
| `.rail#rail` | `<aside aria-label>` | sticky ≥ 961px; off-canvas `.rail.open` ≤ 960px |
| `.rail-nav#tabs` | `<nav>` | `<a aria-current="page">` with `.icon` + label + `.nav-count`; legacy `.tab` buttons still styled |
| `.rail-facets#rail-facets` | harness facet list | `#facet-list` holds `button.facet[aria-pressed]` with `.facet-name`, `.facet-count` |
| `.rail-footer` | status + global actions | `#readiness` (`.readiness.ok/.warn/.bad`, `.readiness-meter > i.ok/.warn/.bad`), `#counter`, `#path-pill > #path-text`, `#lang-toggle`, `#theme-toggle`, `#reset-all` |
| `.workspace#main` | `<main tabindex="-1">` | per page: `.page-head > .page-title, .page-sub, .page-actions` |
| `.filter-bar` | sticky under the bar | `.search-box > .icon + .input + .kbd` (`/`), `.seg-control > button[aria-pressed]`, `.filter-meta` |
| `.data-table-wrap > .data-table` | hairline table | rows `tr.is-modified / .is-custom / .is-disabled`; cells `.cell-primary > .cell-name + .cell-id`, `.cell-num`, `.cell-actions`; add `.stack` + `td[data-label]` for the ≤ 720px stacked layout |
| `.summary-strip > .metric` | Harnesses metrics | `.metric-label`, `.metric-value`, state `.ok/.warn/.bad` |
| `.split-presets` | master-detail | `.preset-list > .preset-item[aria-current]`, `.preset-detail` with a role `.data-table` |
| `.limits-layout` | toc + sections | `.limits-toc a`, `section.limits-section#limits-<group id>`, `.setting-row` (`.is-modified`), `.sticky-save-bar` |
| `.scrim#scrim`, `.drawer#drawer` | outside `.app-shell` | `.drawer-head > .drawer-title#drawer-title`, `.drawer-body`, `.drawer-foot`; open with `.open`; `tabindex="-1"` so focus parks on the panel (no outline) when the focused control disables itself |
| `dialog#confirm` | native modal | `.dialog-body`, `.dialog-actions` |
| `.toasts#toasts` | `role="status"` | `.toast.ok / .error / .info` with leading `.icon` |
| `.empty-state` | empty / no-match | `.icon`, `.empty-title`, `.empty-text`, `.empty-actions` |

Status language: `.status-pill.ok/.warn/.danger/.muted` (quiet dot + text), `.badge` variants
`.accent/.warn/.danger/.mono/.outline`. `THEME_COLORS` in the script must match `--bg` of each theme.

## Hard rules

- No inline `style="…"` attributes (the CSP has no `'unsafe-inline'` for styles anyway).
- `html, body { overflow-x: clip }`; `min-width: 0` on fluid grid/flex children.
- Touch targets ≥ 44px under `pointer: coarse` (`--touch-target`): buttons, icon buttons, rail links and facets, the EN/RU toggle, custom selects and their options, switches, segmented filters, suggestion buttons and chip remove buttons.
- Verify with `npm test -- tests/integration/settings-ui.test.ts` (token, inline-style and CSP invariants) after every style change.
