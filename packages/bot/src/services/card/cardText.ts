// Readable-text serialization of a card deck, for conversation history.
//
// A send_card turn delivers an IMAGE; what survives into history is text. That
// text is what the next turn's LLM reads as "what I said" — raw JSON there
// forces the model to re-parse its own past output and reads as garbage in any
// history-derived context (RAG, summaries). This renders the deck as the plain
// text a reader of the card would see, prefixed with a [卡片] marker so the
// model knows the content went out as a card image.

import type { CardData } from './cardTypes';

export function cardDeckToHistoryText(cards: CardData[]): string {
  const parts = cards.map((card) => cardToText(card)).filter((s) => s.length > 0);
  return `[卡片]\n${parts.join('\n\n')}`;
}

function cardToText(card: CardData): string {
  switch (card.type) {
    case 'paragraph':
      return card.content.trim();
    case 'markdown':
      return [card.title ? `# ${card.title}` : '', card.content.trim()].filter(Boolean).join('\n');
    case 'qa':
      return `问：${card.question}\n答：${card.answer}`;
    case 'list':
      return [`${card.title}：`, ...card.items.map((item) => `- ${item}`)].join('\n');
    case 'steps':
      return [`${card.title}：`, ...card.steps.map((step, i) => `${i + 1}. ${step}`)].join('\n');
    case 'knowledge':
      return [
        `${card.term}：${card.definition}`,
        ...(card.examples?.length ? [`例：${card.examples.join('；')}`] : []),
      ].join('\n');
    case 'comparison':
      return [
        `${card.title}（${card.leftHeader} vs ${card.rightHeader}）：`,
        ...card.items.map((row) => `- ${row.label}：${card.leftHeader} ${row.left}｜${card.rightHeader} ${row.right}`),
      ].join('\n');
    case 'stats':
      return [`${card.title}：`, ...card.data.map((d) => `- ${d.label}：${d.value}`)].join('\n');
    case 'highlight':
      return [`【${card.title}】${card.summary}`, card.detail ?? ''].filter(Boolean).join('\n');
    case 'quote':
      return card.source ? `「${card.text}」——${card.source}` : `「${card.text}」`;
    case 'info':
      return `[${card.level}] ${card.title}：${card.content}`;
    case 'image':
      return card.alt ? `（图片：${card.alt}）` : '（图片）';
    default:
      return '';
  }
}
