// Stats card — label/value rows; `.metric` when every value is short enough to read as a number.

export const STATS_STYLES = `
  .stats-card h2 {
    color: var(--card-ink);
    margin: 0 0 20px 0;
    font-size: 22px;
    font-weight: 700;
    padding-bottom: 12px;
    border-bottom: 3px solid;
    border-image: var(--card-rule-gradient) 1;
  }
  .stat-rows {
    border: 1px solid var(--card-hairline);
    border-radius: 14px;
    overflow: hidden;
  }
  .stat-row {
    display: grid;
    grid-template-columns: minmax(88px, 152px) 1fr;
    gap: 20px;
    align-items: baseline;
    padding: 15px 20px;
  }
  .stat-row + .stat-row {
    border-top: 1px solid var(--card-hairline-soft);
  }
  .stat-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--card-ink-muted);
    line-height: 1.6;
  }
  .stat-value {
    font-size: 17px;
    font-weight: 600;
    color: #1f2937;
    line-height: 1.65;
  }
  .stat-row.highlight {
    background: rgba(var(--card-primary-rgb), 0.07);
    box-shadow: inset 3px 0 0 var(--card-primary);
  }
  .stat-row.highlight .stat-label {
    color: var(--card-secondary);
  }
  .stat-row.highlight .stat-value {
    color: #111827;
    font-weight: 700;
  }
  /* Cards whose values are all short read as a metric board: label left, number right. */
  .stat-rows.metric .stat-row {
    grid-template-columns: 1fr auto;
    padding: 13px 20px;
  }
  .stat-rows.metric .stat-label {
    font-size: 15px;
  }
  .stat-rows.metric .stat-value {
    font-size: 26px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }
`;
