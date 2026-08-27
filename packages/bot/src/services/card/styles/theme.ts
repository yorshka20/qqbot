// Provider identity for a rendered card deck. The colours here are the only
// theme-derived input to the CSS; every style module reads them back as the
// custom properties emitted by ./tokens.

export interface CardTheme {
  primary: string;
  secondary: string;
  primaryRgb: string;
  secondaryRgb: string;
  displayName: string;
}

/**
 * Canonical provider names used as theme keys. All internal/alias names are normalized to one of these.
 * Aligns with ProviderRouter: anthropic → claude, gpt → openai, 哈基米/豆包 → gemini/doubao.
 */
export const CANONICAL_THEME_KEYS = ['claude', 'openai', 'gemini', 'deepseek', 'doubao'] as const;
export type CanonicalThemeKey = (typeof CANONICAL_THEME_KEYS)[number];

/** Maps internal or alias provider names to the unique canonical theme key. */
export const THEME_KEY_ALIASES: Record<string, CanonicalThemeKey> = {
  anthropic: 'claude',
  gpt: 'openai',
  哈基米: 'gemini',
  豆包: 'doubao',
  claude: 'claude',
  openai: 'openai',
  gemini: 'gemini',
  deepseek: 'deepseek',
  doubao: 'doubao',
};

export const PROVIDER_THEMES: Record<CanonicalThemeKey, CardTheme> = {
  claude: {
    primary: '#D97757',
    secondary: '#C4514A',
    primaryRgb: '217, 119, 87',
    secondaryRgb: '196, 81, 74',
    displayName: 'Claude',
  },
  deepseek: {
    primary: '#4D6BFE',
    secondary: '#7C4DFF',
    primaryRgb: '77, 107, 254',
    secondaryRgb: '124, 77, 255',
    displayName: 'DeepSeek',
  },
  gemini: {
    primary: '#886FBF',
    secondary: '#6C5CE7',
    primaryRgb: '136, 111, 191',
    secondaryRgb: '108, 92, 231',
    displayName: 'Gemini',
  },
  doubao: {
    primary: '#36D6B6',
    secondary: '#2EA8D5',
    primaryRgb: '54, 214, 182',
    secondaryRgb: '46, 168, 213',
    displayName: '豆包',
  },
  openai: {
    primary: '#10A37F',
    secondary: '#0D8A6A',
    primaryRgb: '16, 163, 127',
    secondaryRgb: '13, 138, 106',
    displayName: 'OpenAI',
  },
};

export const DEFAULT_THEME: CardTheme = {
  primary: '#667eea',
  secondary: '#764ba2',
  primaryRgb: '102, 126, 234',
  secondaryRgb: '118, 75, 162',
  displayName: 'AI',
};

/**
 * Resolves any provider name (internal or alias) to the canonical theme key.
 * E.g. anthropic → claude, gpt → openai, 哈基米 → gemini.
 */
export function getCanonicalThemeKey(provider: string): CanonicalThemeKey | string {
  const normalized = provider.trim().toLowerCase();
  return THEME_KEY_ALIASES[normalized] ?? normalized;
}

export function getProviderTheme(provider: string): CardTheme {
  const key = getCanonicalThemeKey(provider);
  return PROVIDER_THEMES[key as CanonicalThemeKey] ?? DEFAULT_THEME;
}
