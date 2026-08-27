/**
 * Typography for AI-authored HTML embedded in a card. Three card types drop
 * sanitized content HTML into a container of their own — `.answer-content`,
 * `.info-content`, `.definition` — and all three must render that HTML
 * identically, so the rules are written once against a shared scope instead of
 * being repeated per card.
 *
 * This layer is composed after the card modules on purpose: several rules here
 * override a card's own defaults at equal specificity, which only holds while it
 * comes last.
 */

/** Containers that receive sanitized AI content HTML. A new one is added here, not in a card module. */
const CONTENT = ':is(.answer-content, .info-content, .definition)';

/**
 * Inline code also shows up in list items and comparison cells, which are not content
 * containers. They stay outside the :is() above because :is() takes the specificity of
 * its heaviest argument, and `.styled-list > li > span:last-child` is heavy enough to
 * beat the `pre code` reset further down.
 */
const INLINE_CODE = `${CONTENT} code, .styled-list > li > span:last-child code, .comparison-cell code`;

export const RICH_TEXT_STYLES = `
  ${CONTENT} strong {
    font-weight: 700;
  }
  ${CONTENT} em {
    font-style: normal;
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  ${INLINE_CODE} {
    font-family: "Consolas", "Monaco", "Courier New", monospace;
    font-size: 0.9em;
    background: rgba(0, 0, 0, 0.06);
    padding: 2px 6px;
    border-radius: 4px;
    word-break: break-all;
  }
  ${CONTENT} pre {
    margin: 12px 0;
    padding: 14px 16px;
    background: rgba(0, 0, 0, 0.06);
    border-radius: 8px;
    overflow-x: auto;
    font-family: "Consolas", "Monaco", "Courier New", monospace;
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  ${CONTENT} pre code {
    background: none;
    padding: 0;
  }
  ${CONTENT} h2 {
    font-size: 1.05em;
    margin: 16px 0 10px 0;
    font-weight: 700;
    color: var(--card-ink);
  }
  ${CONTENT} h3 {
    font-size: 1em;
    margin: 14px 0 8px 0;
    font-weight: 600;
    color: var(--card-ink);
  }
  ${CONTENT} p {
    line-height: 1.9;
    margin: 10px 0;
    color: var(--card-ink);
    font-size: inherit;
  }
  ${CONTENT} :is(ul, ol) {
    margin: 10px 0;
    padding-left: 24px;
  }
  ${CONTENT} ul {
    list-style-type: disc;
  }
  ${CONTENT} ol {
    list-style-type: decimal;
  }
  ${CONTENT} li {
    margin: 6px 0;
    line-height: 1.7;
  }
  ${CONTENT} table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 14px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
    border-radius: 8px;
    overflow: hidden;
  }
  ${CONTENT} :is(th, td) {
    padding: 10px 14px;
    border: 1px solid #e0e0e0;
    text-align: left;
  }
  ${CONTENT} thead th {
    background: var(--card-accent-gradient);
    color: white;
    font-weight: 600;
  }
`;
