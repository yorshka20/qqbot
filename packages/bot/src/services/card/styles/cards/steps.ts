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
    color: var(--card-ink);
    font-size: 15px;
  }
`;
