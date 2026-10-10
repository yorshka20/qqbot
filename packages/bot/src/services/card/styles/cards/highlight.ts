// Highlight card — a single takeaway.

export const HIGHLIGHT_STYLES = `
  .highlight-card {
    margin: 0;
    padding: 28px 32px;
    border-radius: 16px;
    background: var(--card-blue-bg);
    border: 2px solid var(--card-blue-line);
    box-shadow: 0 4px 16px var(--card-blue-glow);
  }
  .highlight-card .highlight-title {
    color: var(--card-blue-ink);
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 14px;
  }
  .highlight-card .highlight-summary {
    font-size: 17px;
    line-height: 1.75;
    color: var(--card-blue-ink-soft);
    font-weight: 500;
  }
  .highlight-card .highlight-detail {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--card-blue-wash);
    font-size: 15px;
    line-height: 1.7;
    color: var(--card-ink);
  }
`;
