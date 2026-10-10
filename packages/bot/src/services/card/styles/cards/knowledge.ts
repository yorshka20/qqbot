// Knowledge card — term, definition, examples.

export const KNOWLEDGE_STYLES = `
  .knowledge-card {
    background: var(--card-knowledge-bg);
    border-radius: 16px;
    padding: 28px 30px;
    margin: 0;
    box-shadow: 0 8px 24px var(--card-surface-shadow);
  }
  .term-header {
    display: flex;
    align-items: center;
    margin-bottom: 22px;
    padding-bottom: 16px;
    border-bottom: 2px solid var(--card-rose-chip-line);
  }
  .term-icon {
    font-size: 32px;
    margin-right: 14px;
    flex-shrink: 0;
  }
  .term-header h2 {
    color: var(--card-rose-ink);
    font-size: 22px;
    font-weight: 700;
    line-height: 1.35;
    letter-spacing: 0.02em;
  }
  .definition {
    background: var(--card-surface);
    padding: 26px 28px;
    border-radius: 12px;
    line-height: 1.85;
    color: var(--card-ink);
    margin-bottom: 20px;
    font-size: 15px;
    white-space: pre-wrap;
    word-wrap: break-word;
    box-shadow: 0 4px 16px var(--card-surface-shadow);
    border: 1px solid var(--card-hairline-soft);
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
    color: var(--card-ink-strong);
    font-weight: 700;
  }
  .definition em {
    color: var(--card-purple-ink-soft);
    font-style: normal;
    background: var(--card-purple-wash);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .examples {
    background: var(--card-surface);
    padding: 24px 28px;
    border-radius: 12px;
    box-shadow: 0 4px 16px var(--card-surface-shadow);
    border: 1px solid var(--card-hairline-soft);
  }
  .examples-title {
    display: flex;
    align-items: center;
    font-weight: 700;
    color: var(--card-rose-ink);
    margin-bottom: 16px;
    font-size: 15px;
  }
  .examples-title .icon {
    margin-right: 8px;
    font-size: 18px;
  }
  .examples strong {
    background: var(--card-blue-chip);
    color: var(--card-blue-ink-soft);
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
    color: var(--card-ink);
    font-size: 15px;
  }
  .examples li:before {
    content: "▸";
    position: absolute;
    left: 0;
    color: var(--card-rose-ink);
    font-size: 14px;
    font-weight: bold;
  }
`;
