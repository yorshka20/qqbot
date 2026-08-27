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
    border-bottom: 2px solid #f0f0f0;
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
`;
