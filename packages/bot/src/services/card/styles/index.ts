// Card CSS, assembled from one module per concern — see ./README.md for the layer
// contract, the naming rules, and where a new rule belongs.
//
// The composition order is part of that contract: card modules come before the
// rich-text layer, which overrides some of their defaults at equal specificity.

import { BASE_STYLES } from './base';
import { COMPARISON_STYLES } from './cards/comparison';
import { HIGHLIGHT_STYLES } from './cards/highlight';
import { IMAGE_STYLES } from './cards/image';
import { INFO_STYLES } from './cards/info';
import { KNOWLEDGE_STYLES } from './cards/knowledge';
import { LIST_STYLES } from './cards/list';
import { MARKDOWN_STYLES } from './cards/markdown';
import { PARAGRAPH_STYLES } from './cards/paragraph';
import { QA_STYLES } from './cards/qa';
import { QUOTE_STYLES } from './cards/quote';
import { STATS_STYLES } from './cards/stats';
import { STEPS_STYLES } from './cards/steps';
import { RICH_TEXT_STYLES } from './richText';
import type { CardTheme } from './theme';
import { tokenStyles } from './tokens';

export type { CardTheme } from './theme';
export {
  CANONICAL_THEME_KEYS,
  type CanonicalThemeKey,
  DEFAULT_THEME,
  getCanonicalThemeKey,
  getProviderTheme,
  PROVIDER_THEMES,
  THEME_KEY_ALIASES,
} from './theme';

/** One entry per card type, in the order the templates are declared. */
const CARD_STYLES = [
  PARAGRAPH_STYLES,
  QA_STYLES,
  LIST_STYLES,
  INFO_STYLES,
  COMPARISON_STYLES,
  KNOWLEDGE_STYLES,
  STATS_STYLES,
  QUOTE_STYLES,
  STEPS_STYLES,
  HIGHLIGHT_STYLES,
  IMAGE_STYLES,
];

export function getCardStyles(theme: CardTheme): string {
  return [tokenStyles(theme), BASE_STYLES, ...CARD_STYLES, RICH_TEXT_STYLES, MARKDOWN_STYLES].join('\n');
}
