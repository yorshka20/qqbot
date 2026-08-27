// List card.

export const LIST_STYLES = `
  .list-card {
    margin: 0;
  }
  .list-card h2 {
    color: var(--card-ink);
    margin: 0 0 24px 0;
    font-size: 24px;
    padding-bottom: 12px;
    border-bottom: 3px solid;
    border-image: var(--card-rule-gradient) 1;
  }
  .styled-list {
    list-style: none;
  }
  /* Child combinator so styles only hit the top-level items rendered by listCard,
     not nested <li> inside an item's HTML content — descendant selectors here
     applied display:flex to nested <li>, which split inline runs into flex items
     and produced single-character vertical wraps. */
  .styled-list > li {
    display: flex;
    align-items: flex-start;
    padding: 16px 18px;
    margin: 12px 0;
    background: #f6f7f9;
    border-radius: 12px;
    transition: all 0.3s;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }
  .styled-list > li > .number {
    background: var(--card-accent-gradient);
    color: white;
    min-width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    font-size: 15px;
    margin-right: 14px;
    flex-shrink: 0;
    box-shadow: 0 3px 10px rgba(var(--card-primary-rgb), 0.3);
  }
  .styled-list > li > span:last-child {
    line-height: 1.7;
    color: var(--card-ink);
    flex: 1;
    min-width: 0;
  }
  .styled-list > li > span:last-child strong {
    color: #334155;
    font-weight: 700;
  }
  /* Nested lists inside an item's content: keep them as normal block lists with
     standard markers, not the styled flex cards used at the top level. */
  .styled-list > li > span:last-child ul,
  .styled-list > li > span:last-child ol {
    margin: 8px 0;
    padding-left: 22px;
  }
  .styled-list > li > span:last-child ul { list-style: disc; }
  .styled-list > li > span:last-child ol { list-style: decimal; }
  .styled-list > li > span:last-child li {
    display: list-item;
    margin: 4px 0;
    padding: 0;
    background: transparent;
    box-shadow: none;
    border-radius: 0;
    line-height: 1.7;
    color: var(--card-ink);
  }
  .styled-list > li > span:last-child p {
    margin: 6px 0;
    line-height: 1.7;
  }
`;
