import type { CardTheme } from './theme';

/**
 * Design tokens for a deck, emitted once per render as CSS custom properties.
 * Everything below this layer is plain CSS with no interpolation: a module that
 * needs the provider colour reads `var(--card-primary)` instead of taking the
 * theme as an argument.
 *
 * Naming is `--card-<role>[-<variant>]`, and the role is what the value means, not
 * where it is used. A literal earns a token once two or more modules use it for the
 * same role; a value only one card uses stays inline in that card.
 */
export function tokenStyles(theme: CardTheme): string {
  return `
  :root {
    /* Provider identity — the only theme-derived values in the whole stylesheet. */
    --card-primary: ${theme.primary};
    --card-secondary: ${theme.secondary};
    --card-primary-rgb: ${theme.primaryRgb};
    --card-secondary-rgb: ${theme.secondaryRgb};
    --card-accent-gradient: linear-gradient(135deg, ${theme.primary}, ${theme.secondary});
    --card-rule-gradient: linear-gradient(90deg, ${theme.primary}, ${theme.secondary});

    /* Ink scale for text sitting on a white card surface. */
    --card-ink: #2c3e50;
    --card-ink-muted: #6b7280;

    /* Hairlines that separate rows and cells inside a card. */
    --card-hairline: #e5e7eb;
    --card-hairline-soft: #f0f2f6;
  }
`;
}
