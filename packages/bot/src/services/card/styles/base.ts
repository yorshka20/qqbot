// Frame shared by every deck: reset, container + watermark, card surface, deck
// spacing, footer, and the bare-element defaults that card modules override.
// Bare element selectors (strong / em / h2 / p) live here and nowhere else: a card
// that needs different type scopes it under its own block class instead.

export const BASE_STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif;
    margin: 0;
    padding: 30px;
    background: transparent;
    min-height: 100vh;
  }

  .container {
    background: var(--card-primary);
    border-radius: 24px;
    padding: 24px;
    padding-bottom: 0;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    width: 800px;
    box-sizing: border-box;
    position: relative;
    overflow: hidden;
  }
  .container::before {
    content: attr(data-provider);
    position: absolute;
    font-size: 72px;
    font-weight: 900;
    color: #fff;
    opacity: 0.13;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    white-space: nowrap;
    letter-spacing: 0.06em;
    pointer-events: none;
    z-index: 0;
    user-select: none;
    line-height: 1;
  }
  .card-inner {
    background: white;
    border-radius: 16px;
    padding: 35px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    position: relative;
    z-index: 1;
  }
  .container > .card-inner + .card-inner {
    margin-top: 24px;
  }
  strong {
    color: var(--card-primary);
    font-weight: 700;
  }
  em {
    color: var(--card-secondary);
    font-style: normal;
    background: rgba(var(--card-secondary-rgb), 0.1);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  h2 {
    margin: 24px 0 18px 0;
    font-weight: 700;
  }
  p {
    line-height: 1.9;
    margin: 14px 0;
    color: var(--card-ink);
    font-size: 16px;
  }
  .footer {
    margin-top: 24px;
    padding: 16px 0;
    border-top: 2px solid rgba(255, 255, 255, 0.4);
    text-align: center;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    position: relative;
    z-index: 1;
    letter-spacing: 0.04em;
  }
  .card-inner .footer {
    border-top-color: #e8e8e8;
    color: #999;
  }
  img.emoji {
    height: 1.25em;
    width: 1.25em;
    margin: 0 0.05em 0 0.1em;
    vertical-align: -0.15em;
    display: inline-block;
  }

`;
