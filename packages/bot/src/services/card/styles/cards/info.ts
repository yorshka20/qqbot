// Info box — one accent per level (info / warning / success / tip).

export const INFO_STYLES = `
  .info-box {
    padding: 24px;
    border-radius: 12px;
    margin: 0;
    border-left: 5px solid;
    box-shadow: 0 4px 12px var(--card-surface-shadow);
  }
  .info-box.info {
    background: var(--card-blue-bg);
    border-color: var(--card-blue-line);
  }
  .info-box.warning {
    background: var(--card-amber-bg);
    border-color: var(--card-amber-line);
  }
  .info-box.success {
    background: var(--card-green-bg);
    border-color: var(--card-green-line);
  }
  .info-box.tip {
    background: var(--card-purple-bg);
    border-color: var(--card-purple-line);
  }
  .info-header {
    display: flex;
    align-items: center;
    margin-bottom: 14px;
    font-size: 17px;
    font-weight: 600;
  }
  .info-header .icon {
    font-size: 26px;
    margin-right: 12px;
  }
  .info-content {
    line-height: 1.8;
    color: var(--card-ink);
    font-size: 15px;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .info-content br {
    display: block;
    content: "";
    margin-top: 0.6em;
  }
  .info-box.info .info-header strong,
  .info-box.info .info-content strong {
    color: var(--card-blue-ink);
    font-weight: 700;
  }
  .info-box.info .info-content em {
    color: var(--card-blue-ink-soft);
    font-style: normal;
    background: var(--card-blue-wash);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .info-box.warning .info-header strong,
  .info-box.warning .info-content strong {
    color: var(--card-amber-ink);
    font-weight: 700;
  }
  .info-box.warning .info-content em {
    color: var(--card-amber-ink-soft);
    font-style: normal;
    background: var(--card-amber-wash);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .info-box.success .info-header strong,
  .info-box.success .info-content strong {
    color: var(--card-green-ink);
    font-weight: 700;
  }
  .info-box.success .info-content em {
    color: var(--card-green-ink-soft);
    font-style: normal;
    background: var(--card-green-wash);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .info-box.tip .info-header strong,
  .info-box.tip .info-content strong {
    color: var(--card-purple-ink);
    font-weight: 700;
  }
  .info-box.tip .info-content em {
    color: var(--card-purple-ink-soft);
    font-style: normal;
    background: var(--card-purple-wash);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
`;
