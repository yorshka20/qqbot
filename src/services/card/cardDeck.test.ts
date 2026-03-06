/**
 * Unit tests for card deck: parseCardDeck and renderCardDeck (converted JSON → HTML).
 */

import { describe, expect, test } from 'bun:test';
import { renderCardDeck } from './cardTemplates';
import { parseCardDeck } from './cardTypes';

const validQaCard = {
  type: 'qa',
  question: 'What is X?',
  answer: '<p>X is something.</p>',
} as const;

const validListCard = {
  type: 'list',
  title: 'Steps',
  items: ['First', 'Second'],
} as const;

const validComparisonCard = {
  type: 'comparison',
  title: 'Compare',
  leftHeader: 'A',
  rightHeader: 'B',
  items: [{ label: 'Cost', left: 'Low', right: 'High' }],
} as const;

describe('parseCardDeck', () => {
  test('parses single card as array [one card]', () => {
    const json = JSON.stringify([validQaCard]);
    const cards = parseCardDeck(json);
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('qa');
    expect((cards[0] as { question: string }).question).toBe('What is X?');
  });

  test('parses multiple cards array', () => {
    const json = JSON.stringify([validQaCard, validListCard]);
    const cards = parseCardDeck(json);
    expect(cards).toHaveLength(2);
    expect(cards[0].type).toBe('qa');
    expect(cards[1].type).toBe('list');
  });

  test('throws when root is not array (single object)', () => {
    const json = JSON.stringify(validQaCard);
    expect(() => parseCardDeck(json)).toThrow('Card deck must be a JSON array');
  });

  test('throws when array is empty', () => {
    const json = '[]';
    expect(() => parseCardDeck(json)).toThrow('Card deck array must not be empty');
  });

  test('throws when JSON is invalid', () => {
    expect(() => parseCardDeck('not json')).toThrow('Invalid JSON format');
    expect(() => parseCardDeck('{')).toThrow('Invalid JSON format');
  });

  test('throws when card at index is invalid', () => {
    const json = JSON.stringify([validQaCard, { type: 'invalid' }]);
    expect(() => parseCardDeck(json)).toThrow('Invalid card at index 1');
  });

  test('parses comparison card with leftHeader and rightHeader', () => {
    const json = JSON.stringify([validComparisonCard]);
    const cards = parseCardDeck(json);
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('comparison');
    expect((cards[0] as unknown as typeof validComparisonCard).leftHeader).toBe('A');
    expect((cards[0] as unknown as typeof validComparisonCard).rightHeader).toBe('B');
  });
});

describe('renderCardDeck', () => {
  test('single card: HTML has one .card-inner and correct card class', () => {
    const cards = parseCardDeck(JSON.stringify([validQaCard]));
    const html = renderCardDeck(cards);
    expect(html).toContain('class="card-inner"');
    expect(html).toContain('class="qa-card"');
    expect(html).toContain('What is X?');
    expect(html).toContain('X is something');
    // Exactly one card-inner
    const innerCount = (html.match(/class="card-inner"/g) ?? []).length;
    expect(innerCount).toBe(1);
  });

  test('two cards: HTML has two .card-inner in order (qa then list)', () => {
    const cards = parseCardDeck(JSON.stringify([validQaCard, validListCard]));
    const html = renderCardDeck(cards);
    const innerCount = (html.match(/class="card-inner"/g) ?? []).length;
    expect(innerCount).toBe(2);
    expect(html).toContain('class="qa-card"');
    expect(html).toContain('class="list-card"');
    const qaPos = html.indexOf('qa-card');
    const listPos = html.indexOf('list-card');
    expect(qaPos).toBeLessThan(listPos);
    expect(html).toContain('Steps');
    expect(html).toContain('First');
  });

  test('comparison card: HTML has leftHeader and rightHeader text', () => {
    const cards = parseCardDeck(JSON.stringify([validComparisonCard]));
    const html = renderCardDeck(cards);
    expect(html).toContain('class="comparison-card"');
    expect(html).toContain('>A</div>');
    expect(html).toContain('>B</div>');
    expect(html).toContain('Compare');
    expect(html).toContain('Cost');
    expect(html).toContain('Low');
    expect(html).toContain('High');
  });

  test('throws when cards array is empty', () => {
    expect(() => renderCardDeck([])).toThrow('Card deck must not be empty');
  });
});

describe('parseCardDeck + renderCardDeck (converted JSON → HTML)', () => {
  test('multi-card JSON string renders to valid multi-card HTML', () => {
    const multiCardJson = JSON.stringify([
      validQaCard,
      validListCard,
      {
        type: 'highlight',
        title: 'Summary',
        summary: 'Key point here.',
      },
    ]);
    const cards = parseCardDeck(multiCardJson);
    expect(cards).toHaveLength(3);
    const html = renderCardDeck(cards);
    expect(html).toContain('class="card-inner"');
    expect((html.match(/class="card-inner"/g) ?? []).length).toBe(3);
    expect(html).toContain('qa-card');
    expect(html).toContain('list-card');
    expect(html).toContain('highlight-card');
    expect(html).toContain('Key point here');
    expect(html).toContain('Summary');
  });
});
