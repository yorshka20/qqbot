// Steps card — ordered timeline.

export const STEPS_STYLES = `
  .steps-card {
    margin: 0;
  }
  .steps-card .steps-title {
    color: var(--card-ink);
    margin-bottom: 20px;
    font-size: 22px;
    font-weight: 700;
    padding-bottom: 12px;
    border-bottom: 3px solid;
    border-image: var(--card-teal-rule) 1;
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
    background: var(--card-teal-bg);
    border-radius: 12px;
    border-left: 4px solid var(--card-teal-line);
    box-shadow: 0 2px 8px var(--card-surface-shadow);
  }
  .steps-list .step-number {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    margin-right: 14px;
    background: var(--card-teal-fill);
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
    color: var(--card-ink);
    font-size: 15px;
  }
`;
