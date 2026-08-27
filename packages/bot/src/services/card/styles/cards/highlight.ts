// Highlight card — a single takeaway.

export const HIGHLIGHT_STYLES = `
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
    color: var(--card-ink);
  }
`;
