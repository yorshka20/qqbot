// Card styles - optimized version with proper clipping and better visuals

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

export function getCardStyles({ primary, secondary, primaryRgb, secondaryRgb }: CardTheme): string {
  // Note: displayName is not used here — it is injected as data-provider attribute on the
  // container element in CardRenderer, then referenced via content: attr(data-provider)
  // for the watermark pseudo-element.
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif;
    margin: 0;
    padding: 30px;
    background: transparent;
    min-height: 100vh;
  }

  .container {
    background: ${primary};
    border-radius: 24px;
    padding: 24px;
    padding-bottom: 0;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    width: 800px;
    box-sizing: border-box;
    position: relative;
    overflow: hidden;
  }
  .container::before {
    content: attr(data-provider);
    position: absolute;
    font-size: 72px;
    font-weight: 900;
    color: #fff;
    opacity: 0.13;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    white-space: nowrap;
    letter-spacing: 0.06em;
    pointer-events: none;
    z-index: 0;
    user-select: none;
    line-height: 1;
  }
  .card-inner {
    background: white;
    border-radius: 16px;
    padding: 35px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    position: relative;
    z-index: 1;
  }
  .container > .card-inner + .card-inner {
    margin-top: 24px;
  }
  .paragraph-block {
    position: relative;
    z-index: 1;
    padding: 20px 24px;
    background: rgba(255, 255, 255, 0.12);
    backdrop-filter: blur(8px);
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.95);
    font-size: 16px;
    line-height: 1.6;
  }
  .paragraph-block p {
    color: rgba(255, 255, 255, 0.95);
    margin: 8px 0;
    font-size: inherit;
    line-height: inherit;
  }
  .paragraph-block p:first-child { margin-top: 0; }
  .paragraph-block p:last-child { margin-bottom: 0; }
  .paragraph-block strong {
    color: #fff;
    font-weight: 700;
  }
  .paragraph-block em {
    color: rgba(255, 255, 255, 0.9);
    font-style: italic;
    background: rgba(255, 255, 255, 0.12);
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 500;
  }
  .paragraph-block code {
    font-family: "Consolas", "Monaco", "Courier New", monospace;
    font-size: 0.9em;
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .container > .paragraph-block + .card-inner,
  .container > .card-inner + .paragraph-block {
    margin-top: 16px;
  }
  .container > .paragraph-block + .paragraph-block {
    margin-top: 0;
    padding-top: 0;
  }
  .qa-card {
    background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
    border-radius: 16px;
    padding: 28px;
    margin: 0;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
  }
  .question {
    display: flex;
    align-items: center;
    margin-bottom: 24px;
    font-size: 19px;
    font-weight: 600;
    color: #2c3e50;
  }
  .q-icon {
    background: linear-gradient(135deg, ${primary}, ${secondary});
    color: white;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    margin-right: 14px;
    flex-shrink: 0;
    font-size: 16px;
    box-shadow: 0 4px 12px rgba(${primaryRgb}, 0.3);
  }
  .answer {
    display: flex;
    align-items: flex-start;
  }
  .a-icon {
    background: linear-gradient(135deg, ${secondary}, ${primary});
    color: white;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    margin-right: 14px;
    flex-shrink: 0;
    font-size: 16px;
    box-shadow: 0 4px 12px rgba(${secondaryRgb}, 0.3);
  }
  .answer-content {
    line-height: 1.9;
    color: #2c3e50;
    font-size: 16px;
    word-wrap: break-word;
    flex: 1;
  }
  .answer-content br {
    display: block;
    content: "";
    margin-top: 0.6em;
  }
  .question strong {
    color: #1a1f36;
    font-weight: 700;
  }
  .answer-content strong {
    color: #1e3a5f;
    font-weight: 700;
  }
  .answer-content em {
    color: #5b21b6;
    font-style: normal;
    background: rgba(91, 33, 182, 0.12);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .list-card {
    margin: 0;
  }
  .list-card h2 {
    color: #2c3e50;
    margin: 0 0 24px 0;
    font-size: 24px;
    padding-bottom: 12px;
    border-bottom: 3px solid;
    border-image: linear-gradient(90deg, ${primary}, ${secondary}) 1;
  }
  .styled-list {
    list-style: none;
  }
  .styled-list li {
    display: flex;
    align-items: flex-start;
    padding: 16px 18px;
    margin: 12px 0;
    background: #f6f7f9;
    border-radius: 12px;
    transition: all 0.3s;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }
  .styled-list .number {
    background: linear-gradient(135deg, ${primary}, ${secondary});
    color: white;
    min-width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    font-size: 15px;
    margin-right: 14px;
    flex-shrink: 0;
    box-shadow: 0 3px 10px rgba(${primaryRgb}, 0.3);
  }
  .styled-list li span:last-child {
    line-height: 1.7;
    color: #2c3e50;
  }
  .styled-list li span:last-child strong {
    color: #334155;
    font-weight: 700;
  }
  .info-box {
    padding: 24px;
    border-radius: 12px;
    margin: 0;
    border-left: 5px solid;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  }
  .info-box.info {
    background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%);
    border-color: #2196f3;
  }
  .info-box.warning {
    background: linear-gradient(135deg, #fff3e0 0%, #ffe0b2 100%);
    border-color: #ff9800;
  }
  .info-box.success {
    background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%);
    border-color: #4caf50;
  }
  .info-box.tip {
    background: linear-gradient(135deg, #f3e5f5 0%, #e1bee7 100%);
    border-color: #9c27b0;
  }
  .info-header {
    display: flex;
    align-items: center;
    margin-bottom: 14px;
    font-size: 17px;
    font-weight: 600;
  }
  .info-header .icon {
    font-size: 26px;
    margin-right: 12px;
  }
  .info-content {
    line-height: 1.8;
    color: #2c3e50;
    font-size: 15px;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .info-content br {
    display: block;
    content: "";
    margin-top: 0.6em;
  }
  .info-box.info .info-header strong,
  .info-box.info .info-content strong {
    color: #0d47a1;
    font-weight: 700;
  }
  .info-box.info .info-content em {
    color: #1565c0;
    font-style: normal;
    background: rgba(21, 101, 192, 0.15);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .info-box.warning .info-header strong,
  .info-box.warning .info-content strong {
    color: #bf360c;
    font-weight: 700;
  }
  .info-box.warning .info-content em {
    color: #e65100;
    font-style: normal;
    background: rgba(230, 81, 0, 0.12);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .info-box.success .info-header strong,
  .info-box.success .info-content strong {
    color: #1b5e20;
    font-weight: 700;
  }
  .info-box.success .info-content em {
    color: #2e7d32;
    font-style: normal;
    background: rgba(46, 125, 50, 0.12);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .info-box.tip .info-header strong,
  .info-box.tip .info-content strong {
    color: #6a1b9a;
    font-weight: 700;
  }
  .info-box.tip .info-content em {
    color: #7b1fa2;
    font-style: normal;
    background: rgba(123, 31, 162, 0.12);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .comparison-card {
    margin: 0;
  }
  .comparison-card-title {
    font-size: 21px;
    font-weight: 700;
    color: #fff;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 2px solid #f0f0f0;
    letter-spacing: 0.01em;
  }
  .card-inner .comparison-card-title {
    color: #2c3e50;
    border-bottom-color: #e5e7eb;
  }
  .comparison-col-headers {
    display: grid;
    grid-template-columns: 96px 1fr 1fr;
    gap: 6px;
    margin-bottom: 6px;
  }
  .comparison-col-header {
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 7px;
    border-radius: 8px;
  }
  .comparison-col-header.left-header {
    background: #edfaf1;
    color: #1a7a3c;
    border: 1px solid #b7eacb;
  }
  .comparison-col-header.right-header {
    background: #fff1f2;
    color: #b91c2c;
    border: 1px solid #fecdd3;
  }
  .col-header-icon {
    font-size: 14px;
    line-height: 1;
  }
  .comparison-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .comparison-row {
    display: grid;
    grid-template-columns: 96px 1fr 1fr;
    gap: 6px;
  }
  .comparison-row-label {
    display: flex;
    align-items: flex-start;
  }
  .row-label-text {
    font-size: 13px;
    font-weight: 600;
    color: #6b7280;
    line-height: 1.5;
    letter-spacing: 0.01em;
    padding-right: 8px;
    border-right: 2px solid #e5e7eb;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    text-align: left;
  }
  .comparison-cell {
    padding: 14px 16px;
    font-size: 14px;
    line-height: 1.75;
    color: #374151;
    border-radius: 8px;
  }
  .comparison-cell.left-cell {
    background: #f6fef9;
    border: 1px solid #d1fae5;
  }
  .comparison-cell.right-cell {
    background: #fff9f9;
    border: 1px solid #fee2e2;
  }
  .comparison-cell.empty-cell {
    background: transparent;
    border: none;
  }
  .comparison-cell ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .comparison-cell ul li {
    position: relative;
    padding-left: 14px;
    margin: 6px 0;
    line-height: 1.7;
  }
  .left-cell ul li::before {
    content: "";
    position: absolute;
    left: 1px;
    top: 8px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #34d399;
  }
  .right-cell ul li::before {
    content: "";
    position: absolute;
    left: 1px;
    top: 8px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #f87171;
  }
  .comparison-cell p {
    margin: 0;
    line-height: 1.8;
  }
  .comparison-cell strong {
    color: #111827;
    font-weight: 700;
  }
  .knowledge-card {
    background: linear-gradient(180deg, #faf8f5 0%, #f0ebe3 100%);
    border-radius: 16px;
    padding: 28px 30px;
    margin: 0;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  }
  .term-header {
    display: flex;
    align-items: center;
    margin-bottom: 22px;
    padding-bottom: 16px;
    border-bottom: 2px solid rgba(216, 67, 21, 0.15);
  }
  .term-icon {
    font-size: 32px;
    margin-right: 14px;
    flex-shrink: 0;
  }
  .term-header h2 {
    color: #c62828;
    font-size: 22px;
    font-weight: 700;
    line-height: 1.35;
    letter-spacing: 0.02em;
  }
  .definition {
    background: #ffffff;
    padding: 26px 28px;
    border-radius: 12px;
    line-height: 1.85;
    color: #2c3e50;
    margin-bottom: 20px;
    font-size: 15px;
    white-space: pre-wrap;
    word-wrap: break-word;
    box-shadow:
      0 4px 16px rgba(0, 0, 0, 0.06),
      0 1px 3px rgba(0, 0, 0, 0.04);
    border: 1px solid rgba(0, 0, 0, 0.04);
  }
  .definition p {
    margin: 0 0 12px 0;
  }
  .definition p:last-child {
    margin-bottom: 0;
  }
  .definition br {
    display: block;
    content: "";
    margin-top: 0.5em;
  }
  .definition strong {
    color: #1e3a5f;
    font-weight: 700;
  }
  .definition em {
    color: #5b21b6;
    font-style: normal;
    background: rgba(91, 33, 182, 0.08);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .examples {
    background: #ffffff;
    padding: 24px 28px;
    border-radius: 12px;
    box-shadow:
      0 4px 16px rgba(0, 0, 0, 0.06),
      0 1px 3px rgba(0, 0, 0, 0.04);
    border: 1px solid rgba(0, 0, 0, 0.04);
  }
  .examples-title {
    display: flex;
    align-items: center;
    font-weight: 700;
    color: #c62828;
    margin-bottom: 16px;
    font-size: 15px;
  }
  .examples-title .icon {
    margin-right: 8px;
    font-size: 18px;
  }
  .examples strong {
    background: #e3f2fd;
    color: #1565c0;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 600;
  }
  .examples ul {
    list-style: none;
    padding-left: 0;
    margin: 0;
  }
  .examples li {
    padding: 8px 0 8px 22px;
    position: relative;
    line-height: 1.75;
    color: #2c3e50;
    font-size: 15px;
  }
  .examples li:before {
    content: "▸";
    position: absolute;
    left: 0;
    color: #c62828;
    font-size: 14px;
    font-weight: bold;
  }
  .stats-card h2 {
    color: #2c3e50;
    margin-bottom: 28px;
    font-size: 24px;
    text-align: center;
    font-weight: 700;
  }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 20px;
  }
  .stat-item {
    background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
    padding: 28px 20px;
    border-radius: 14px;
    text-align: center;
    transition: all 0.3s;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  }
  .stat-item.highlight {
    background: linear-gradient(135deg, ${primary} 0%, ${secondary} 100%);
    color: white;
    box-shadow: 0 8px 24px rgba(${primaryRgb}, 0.4);
  }
  .stat-value {
    font-size: 36px;
    font-weight: 800;
    margin-bottom: 10px;
    color: #2c3e50;
  }
  .stat-item.highlight .stat-value {
    color: white;
  }
  .stat-label {
    font-size: 15px;
    opacity: 0.85;
    font-weight: 500;
  }
  .stat-item:not(.highlight) .stat-label {
    color: #374151;
  }
  .quote-card {
    margin: 0;
    padding: 28px 32px;
    border-radius: 16px;
    background: linear-gradient(135deg, #fefce8 0%, #fef9c3 100%);
    border-left: 5px solid #eab308;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
  }
  .quote-card .quote-text {
    margin: 0 0 12px 0;
    font-size: 18px;
    line-height: 1.75;
    color: #1c1917;
    font-style: italic;
  }
  .quote-card .quote-source {
    font-size: 14px;
    color: #78716c;
    text-align: right;
  }
  .steps-card {
    margin: 0;
  }
  .steps-card .steps-title {
    color: #2c3e50;
    margin-bottom: 20px;
    font-size: 22px;
    font-weight: 700;
    padding-bottom: 12px;
    border-bottom: 3px solid;
    border-image: linear-gradient(90deg, #0d9488, #06b6d4) 1;
  }
  .steps-list {
    list-style: none;
    padding-left: 0;
    margin: 0;
  }
  .steps-list .step-item {
    display: flex;
    align-items: flex-start;
    padding: 14px 18px;
    margin: 10px 0;
    background: linear-gradient(135deg, #f0fdfa 0%, #ccfbf1 100%);
    border-radius: 12px;
    border-left: 4px solid #0d9488;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  }
  .steps-list .step-number {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    margin-right: 14px;
    background: linear-gradient(135deg, #0d9488, #06b6d4);
    color: white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 14px;
  }
  .steps-list .step-content {
    line-height: 1.7;
    color: #2c3e50;
    font-size: 15px;
  }
  .highlight-card {
    margin: 0;
    padding: 28px 32px;
    border-radius: 16px;
    background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
    border: 2px solid #3b82f6;
    box-shadow: 0 4px 16px rgba(59, 130, 246, 0.15);
  }
  .highlight-card .highlight-title {
    color: #1e40af;
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 14px;
  }
  .highlight-card .highlight-summary {
    font-size: 17px;
    line-height: 1.75;
    color: #1e3a8a;
    font-weight: 500;
  }
  .highlight-card .highlight-detail {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid rgba(59, 130, 246, 0.3);
    font-size: 15px;
    line-height: 1.7;
    color: #2c3e50;
  }
  strong {
    color: ${primary};
    font-weight: 700;
  }
  em {
    color: ${secondary};
    font-style: normal;
    background: rgba(${secondaryRgb}, 0.1);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .answer-content strong,
  .info-content strong,
  .definition strong {
    font-weight: 700;
  }
  .answer-content em,
  .info-content em,
  .definition em {
    font-style: normal;
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .answer-content code,
  .info-content code,
  .definition code,
  .styled-list li span:last-child code,
  .comparison-cell code {
    font-family: "Consolas", "Monaco", "Courier New", monospace;
    font-size: 0.9em;
    background: rgba(0, 0, 0, 0.06);
    padding: 2px 6px;
    border-radius: 4px;
    word-break: break-all;
  }
  .answer-content pre,
  .info-content pre,
  .definition pre {
    margin: 12px 0;
    padding: 14px 16px;
    background: rgba(0, 0, 0, 0.06);
    border-radius: 8px;
    overflow-x: auto;
    font-family: "Consolas", "Monaco", "Courier New", monospace;
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .answer-content pre code,
  .info-content pre code,
  .definition pre code {
    background: none;
    padding: 0;
  }
  .answer-content h2,
  .info-content h2,
  .definition h2 {
    font-size: 1.05em;
    margin: 16px 0 10px 0;
    font-weight: 700;
    color: #2c3e50;
  }
  .answer-content h3,
  .info-content h3,
  .definition h3 {
    font-size: 1em;
    margin: 14px 0 8px 0;
    font-weight: 600;
    color: #2c3e50;
  }
  .answer-content p,
  .info-content p,
  .definition p {
    line-height: 1.9;
    margin: 10px 0;
    color: #2c3e50;
    font-size: inherit;
  }
  .answer-content ul,
  .info-content ul,
  .definition ul,
  .answer-content ol,
  .info-content ol,
  .definition ol {
    margin: 10px 0;
    padding-left: 24px;
  }
  .answer-content ul {
    list-style-type: disc;
  }
  .answer-content ol {
    list-style-type: decimal;
  }
  .info-content ul {
    list-style-type: disc;
  }
  .info-content ol {
    list-style-type: decimal;
  }
  .definition ul {
    list-style-type: disc;
  }
  .definition ol {
    list-style-type: decimal;
  }
  .answer-content li,
  .info-content li,
  .definition li {
    margin: 6px 0;
    line-height: 1.7;
  }
  .answer-content table,
  .info-content table,
  .definition table,
  .answer-content table.content-table,
  .info-content table.content-table,
  .definition table.content-table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 14px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
    border-radius: 8px;
    overflow: hidden;
  }
  .answer-content th,
  .info-content th,
  .definition th,
  .answer-content td,
  .info-content td,
  .definition td {
    padding: 10px 14px;
    border: 1px solid #e0e0e0;
    text-align: left;
  }
  .answer-content thead th,
  .info-content thead th,
  .definition thead th {
    background: linear-gradient(135deg, ${primary}, ${secondary});
    color: white;
    font-weight: 600;
  }
  .footer {
    margin-top: 24px;
    padding: 16px 0;
    border-top: 2px solid rgba(255, 255, 255, 0.4);
    text-align: center;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    position: relative;
    z-index: 1;
    letter-spacing: 0.04em;
  }
  .card-inner .footer {
    border-top-color: #e8e8e8;
    color: #999;
  }
  h2 {
    margin: 24px 0 18px 0;
    font-weight: 700;
  }
  p {
    line-height: 1.9;
    margin: 14px 0;
    color: #2c3e50;
    font-size: 16px;
  }
  .image-block {
    margin: 0;
    text-align: center;
  }
  .image-block img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 0 auto;
    border-radius: 8px;
    object-fit: contain;
  }
  img.emoji {
    height: 1.25em;
    width: 1.25em;
    margin: 0 0.05em 0 0.1em;
    vertical-align: -0.15em;
    display: inline-block;
  }
`;
}
