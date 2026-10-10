import type { CardPalette } from './palette';
import type { CardTheme } from './theme';

/**
 * Design tokens for a deck, emitted once per render as CSS custom properties.
 * Everything below this layer is plain CSS with no interpolation: a module that
 * needs the provider colour reads `var(--card-primary)` instead of taking the
 * theme as an argument, and a module that needs a surface-dependent colour reads
 * the matching `var(--card-…)` instead of carrying a light-mode literal.
 *
 * Naming is `--card-<role>[-<variant>]`, and the role is what the value means, not
 * where it is used. Provider identity is spelled out below because it is the same
 * in both appearances; every other role comes from ./palette, which holds the one
 * light and the one dark value set.
 */
export function tokenStyles(theme: CardTheme, palette: CardPalette): string {
  const paletteVars = Object.entries(palette)
    .map(([role, value]) => `    --card-${toKebabCase(role)}: ${value};`)
    .join('\n');

  return `
  :root {
    /* Provider identity — appearance-independent, so it is not part of the palette. */
    --card-primary: ${theme.primary};
    --card-secondary: ${theme.secondary};
    --card-primary-rgb: ${theme.primaryRgb};
    --card-secondary-rgb: ${theme.secondaryRgb};
    --card-accent-gradient: linear-gradient(135deg, ${theme.primary}, ${theme.secondary});
    --card-rule-gradient: linear-gradient(90deg, ${theme.primary}, ${theme.secondary});

${paletteVars}
  }
`;
}

function toKebabCase(role: string): string {
  return role.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}
