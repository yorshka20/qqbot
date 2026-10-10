// Q&A card.

export const QA_STYLES = `
  .qa-card {
    background: var(--card-qa-bg);
    border-radius: 16px;
    padding: 28px;
    margin: 0;
    box-shadow: 0 4px 12px var(--card-surface-shadow);
  }
  .question {
    display: flex;
    align-items: center;
    margin-bottom: 24px;
    font-size: 19px;
    font-weight: 600;
    color: var(--card-ink);
  }
  .q-icon {
    background: var(--card-accent-gradient);
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
    box-shadow: 0 4px 12px rgba(var(--card-primary-rgb), 0.3);
  }
  .answer {
    display: flex;
    align-items: flex-start;
  }
  .a-icon {
    background: linear-gradient(135deg, var(--card-secondary), var(--card-primary));
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
    box-shadow: 0 4px 12px rgba(var(--card-secondary-rgb), 0.3);
  }
  .answer-content {
    line-height: 1.9;
    color: var(--card-ink);
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
    color: var(--card-ink-strong);
    font-weight: 700;
  }
  .answer-content strong {
    color: var(--card-ink-strong);
    font-weight: 700;
  }
  .answer-content em {
    color: var(--card-purple-ink-soft);
    font-style: normal;
    background: var(--card-purple-wash);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
`;
