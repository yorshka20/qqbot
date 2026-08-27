// Info box — one accent per level (info / warning / success / tip).

export const INFO_STYLES = `
  .info-box {
    padding: 24px;
    border-radius: 12px;
    margin: 0;
    border-left: 5px solid;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  }
  .info-box.info {
    background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%);
    border-color: #2196f3;
  }
  .info-box.warning {
    background: linear-gradient(135deg, #fff3e0 0%, #ffe0b2 100%);
    border-color: #ff9800;
  }
  .info-box.success {
    background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%);
    border-color: #4caf50;
  }
  .info-box.tip {
    background: linear-gradient(135deg, #f3e5f5 0%, #e1bee7 100%);
    border-color: #9c27b0;
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
    color: #0d47a1;
    font-weight: 700;
  }
  .info-box.info .info-content em {
    color: #1565c0;
    font-style: normal;
    background: rgba(21, 101, 192, 0.15);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .info-box.warning .info-header strong,
  .info-box.warning .info-content strong {
    color: #bf360c;
    font-weight: 700;
  }
  .info-box.warning .info-content em {
    color: #e65100;
    font-style: normal;
    background: rgba(230, 81, 0, 0.12);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .info-box.success .info-header strong,
  .info-box.success .info-content strong {
    color: #1b5e20;
    font-weight: 700;
  }
  .info-box.success .info-content em {
    color: #2e7d32;
    font-style: normal;
    background: rgba(46, 125, 50, 0.12);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .info-box.tip .info-header strong,
  .info-box.tip .info-content strong {
    color: #6a1b9a;
    font-weight: 700;
  }
  .info-box.tip .info-content em {
    color: #7b1fa2;
    font-style: normal;
    background: rgba(123, 31, 162, 0.12);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
`;
