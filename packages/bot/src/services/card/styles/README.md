# Card styles

The CSS that `CardRenderer` injects into the Puppeteer page. It used to be a single
1100-line template string; it is now one module per concern, composed by `index.ts`.

## Layers

| Layer | File(s) | Owns |
|---|---|---|
| Tokens | `tokens.ts` | Emits the `:root` block: the provider theme plus every palette role as `--card-<kebab-role>`. The only place values are interpolated. |
| Palette | `palette.ts` | The light and dark value sets. No CSS, no selectors — one field per colour role. |
| Theme | `theme.ts` | `CardTheme` and the provider → colour registry. No CSS. |
| Base | `base.ts` | Reset, `body`, `.container` + watermark, `.card-inner`, deck spacing, `.footer`, bare-element defaults (`strong`/`em`/`h2`/`p`), emoji sizing. |
| Cards | `cards/*.ts` | One file per card type, styling only that card's own block. |
| Rich text | `richText.ts` | Typography for sanitized AI-authored HTML dropped into `.answer-content` / `.info-content` / `.definition`. |

`index.ts` concatenates them as: **tokens → base → cards → rich text → markdown card**.

That order is load-bearing. Rules in `richText.ts` deliberately override card-module
defaults at *equal* specificity (e.g. `.definition p`), so the rich-text layer only
works while it is composed after the cards. Everything else is order-independent by
construction: base only holds bare-element selectors, which lose to any class.

## Where a new rule goes

- Styling one card's own markup → that card's file in `cards/`.
- Styling AI-authored HTML that several cards embed → `richText.ts`, by adding the
  container to the `CONTENT` scope, never by adding a rule to a card file.
- Styling the frame around every card → `base.ts`.
- A card file must not contain bare element selectors or reach into another card's
  classes. If two cards want the same thing, it belongs in a shared layer or a token.

## Naming

**Classes** — a card's root is `.<type>-card` (`.stats-card`, `.quote-card`), its parts
are `.<type>-<part>` or a short unprefixed noun already scoped by the root
(`.stat-row`, `.step-number`, `.info-header`). Variants are separate modifier classes
applied to the block they modify (`.stat-row.highlight`, `.stat-rows.metric`,
`.info-box.warning`) — never a second element class.

**Tokens** — `--card-<role>[-<variant>]`, named for what the value *means*, not where
it is used (`--card-ink-muted`, not `--card-stat-label`). Any colour that depends on
whether the card surface is light or dark must be a palette role, even when a single
card uses it — a literal there is a card that cannot go dark. Only appearance-neutral
values (white text over the frame, an `rgba(var(--card-primary-rgb), …)` tint) stay
inline. Provider colours are always read through `var(--card-primary)` /
`var(--card-secondary)` / `var(--card-accent-gradient)`; a style module never takes the
theme as an argument.

**Appearance** — `getCardStyles(theme, appearance)` picks the palette; nothing below the
token layer knows which one is active, and there is no `.theme-dark` override sheet.
Adding a dark value means adding a field to `CardPalette`, not a second rule.

## Specificity traps

`:is(a, b, c)` takes the specificity of its *heaviest* argument. `richText.ts` keeps the
heavy scopes (`.styled-list > li > span:last-child`) out of its `:is()` list for exactly
this reason — folding them in raised the inline-code rule above the `pre code` reset and
put a grey pill behind every line of a code block.

When changing anything here, render a deck of all card types before and after and diff
the computed styles; a cascade break in this file is invisible in a type check.
`NO_FILE_LOG=1 bun run packages/bot/scripts/dev/render-card-deck.ts <outDir>` writes
that deck in both appearances.
