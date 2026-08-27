// Q&A card.

export const QA_STYLES = `
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
`;
