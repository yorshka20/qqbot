// Comparison card — label column plus two value columns.

export const COMPARISON_STYLES = `
  .comparison-card {
    margin: 0;
  }
  .comparison-card-title {
    font-size: 21px;
    font-weight: 700;
    color: #fff;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 2px solid rgba(255, 255, 255, 0.4);
    letter-spacing: 0.01em;
  }
  .card-inner .comparison-card-title {
    color: var(--card-ink);
    border-bottom-color: var(--card-hairline);
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
    background: var(--card-green-chip);
    color: var(--card-green-ink-soft);
    border: 1px solid var(--card-green-chip-line);
  }
  .comparison-col-header.right-header {
    background: var(--card-rose-chip);
    color: var(--card-rose-ink);
    border: 1px solid var(--card-rose-chip-line);
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
    color: var(--card-ink-muted);
    line-height: 1.5;
    letter-spacing: 0.01em;
    padding-right: 8px;
    border-right: 2px solid var(--card-hairline);
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
    color: var(--card-ink);
    border-radius: 8px;
  }
  .comparison-cell.left-cell {
    background: var(--card-green-cell);
    border: 1px solid var(--card-green-cell-line);
  }
  .comparison-cell.right-cell {
    background: var(--card-rose-cell);
    border: 1px solid var(--card-rose-cell-line);
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
    background: var(--card-green-dot);
  }
  .right-cell ul li::before {
    content: "";
    position: absolute;
    left: 1px;
    top: 8px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--card-rose-dot);
  }
  .comparison-cell p {
    margin: 0;
    line-height: 1.8;
  }
  .comparison-cell strong {
    color: var(--card-ink-strong);
    font-weight: 700;
  }
`;
