// Paragraph block — text laid directly on the container, with no white card behind it.

export const PARAGRAPH_STYLES = `
  .paragraph-block {
    position: relative;
    z-index: 1;
    padding: 20px 24px;
    background: rgba(255, 255, 255, 0.12);
    backdrop-filter: blur(8px);
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.95);
    font-size: 16px;
    line-height: 1.6;
  }
  .paragraph-block p {
    color: rgba(255, 255, 255, 0.95);
    margin: 8px 0;
    font-size: inherit;
    line-height: inherit;
  }
  .paragraph-block p:first-child { margin-top: 0; }
  .paragraph-block p:last-child { margin-bottom: 0; }
  .paragraph-block strong {
    color: #fff;
    font-weight: 700;
  }
  .paragraph-block em {
    color: rgba(255, 255, 255, 0.9);
    font-style: italic;
    background: rgba(255, 255, 255, 0.12);
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 500;
  }
  .paragraph-block code {
    font-family: "Consolas", "Monaco", "Courier New", monospace;
    font-size: 0.9em;
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .container > .paragraph-block + .card-inner,
  .container > .card-inner + .paragraph-block {
    margin-top: 16px;
  }
  .container > .paragraph-block + .paragraph-block {
    margin-top: 0;
    padding-top: 0;
  }
`;
