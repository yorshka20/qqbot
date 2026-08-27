// Knowledge card — term, definition, examples.

export const KNOWLEDGE_STYLES = `
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
    color: var(--card-ink);
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
    color: var(--card-ink);
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
`;
