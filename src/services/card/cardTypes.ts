// Card data types for LLM response rendering

export type CardType = 'qa' | 'list' | 'info' | 'comparison' | 'knowledge' | 'stats' | 'quote' | 'steps' | 'highlight' | 'paragraph';

export type InfoBoxLevel = 'info' | 'warning' | 'success' | 'tip';

/**
 * Base card data interface
 */
export interface BaseCardData {
  type: CardType;
}

/**
 * Q&A card data
 */
export interface QACardData extends BaseCardData {
  type: 'qa';
  question: string;
  answer: string;
}

/**
 * List card data
 */
export interface ListCardData extends BaseCardData {
  type: 'list';
  title: string;
  items: string[];
  emoji?: string;
}

/**
 * Info box card data
 */
export interface InfoCardData extends BaseCardData {
  type: 'info';
  title: string;
  content: string;
  level: InfoBoxLevel;
}

/**
 * Comparison card data.
 * leftHeader/rightHeader: column headers (e.g. item names, "方案A"/"方案B"), not fixed "pros/cons".
 */
export interface ComparisonCardData extends BaseCardData {
  type: 'comparison';
  title: string;
  leftHeader: string;
  rightHeader: string;
  items: Array<{
    label: string;
    left: string;
    right: string;
  }>;
}

/**
 * Knowledge card data
 */
export interface KnowledgeCardData extends BaseCardData {
  type: 'knowledge';
  term: string;
  definition: string;
  examples?: string[];
}

/**
 * Stats card data
 */
export interface StatsCardData extends BaseCardData {
  type: 'stats';
  title: string;
  data: Array<{
    label: string;
    value: string;
    highlight?: boolean;
  }>;
}

/**
 * Quote card data (citation / key sentence)
 */
export interface QuoteCardData extends BaseCardData {
  type: 'quote';
  text: string;
  source?: string;
}

/**
 * Steps card data (ordered steps / timeline)
 */
export interface StepsCardData extends BaseCardData {
  type: 'steps';
  title: string;
  steps: string[];
}

/**
 * Highlight card data (single conclusion / takeaway)
 */
export interface HighlightCardData extends BaseCardData {
  type: 'highlight';
  title: string;
  summary: string;
  detail?: string;
}

/**
 * Paragraph block data (natural text, not a structured card)
 */
export interface ParagraphCardData extends BaseCardData {
  type: 'paragraph';
  content: string;
}

/**
 * Union type for all card data types
 */
export type CardData =
  | QACardData
  | ListCardData
  | InfoCardData
  | ComparisonCardData
  | KnowledgeCardData
  | StatsCardData
  | QuoteCardData
  | StepsCardData
  | HighlightCardData
  | ParagraphCardData;

/**
 * Type guard for Q&A card data
 */
export function isQACardData(data: unknown): data is QACardData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return obj.type === 'qa' && typeof obj.question === 'string' && typeof obj.answer === 'string';
}

/**
 * Type guard for list card data
 */
export function isListCardData(data: unknown): data is ListCardData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return (
    obj.type === 'list' &&
    typeof obj.title === 'string' &&
    Array.isArray(obj.items) &&
    obj.items.every((item) => typeof item === 'string')
  );
}

/**
 * Type guard for info card data
 */
export function isInfoCardData(data: unknown): data is InfoCardData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return (
    obj.type === 'info' &&
    typeof obj.title === 'string' &&
    typeof obj.content === 'string' &&
    (obj.level === 'info' || obj.level === 'warning' || obj.level === 'success' || obj.level === 'tip')
  );
}

/**
 * Type guard for comparison card data
 */
export function isComparisonCardData(data: unknown): data is ComparisonCardData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  if (
    obj.type !== 'comparison' ||
    typeof obj.title !== 'string' ||
    typeof obj.leftHeader !== 'string' ||
    typeof obj.rightHeader !== 'string' ||
    !Array.isArray(obj.items)
  ) {
    return false;
  }
  return obj.items.every(
    (item: unknown) =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).label === 'string' &&
      typeof (item as Record<string, unknown>).left === 'string' &&
      typeof (item as Record<string, unknown>).right === 'string',
  );
}

/**
 * Type guard for knowledge card data
 */
export function isKnowledgeCardData(data: unknown): data is KnowledgeCardData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  if (obj.type !== 'knowledge' || typeof obj.term !== 'string' || typeof obj.definition !== 'string') {
    return false;
  }
  if (obj.examples !== undefined) {
    return Array.isArray(obj.examples) && obj.examples.every((ex) => typeof ex === 'string');
  }
  return true;
}

/**
 * Type guard for stats card data
 */
export function isStatsCardData(data: unknown): data is StatsCardData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  if (obj.type !== 'stats' || typeof obj.title !== 'string' || !Array.isArray(obj.data)) {
    return false;
  }
  return obj.data.every(
    (item: unknown) =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).label === 'string' &&
      typeof (item as Record<string, unknown>).value === 'string',
  );
}

/**
 * Type guard for quote card data
 */
export function isQuoteCardData(data: unknown): data is QuoteCardData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  if (obj.type !== 'quote' || typeof obj.text !== 'string') {
    return false;
  }
  if (obj.source !== undefined && typeof obj.source !== 'string') {
    return false;
  }
  return true;
}

/**
 * Type guard for steps card data
 */
export function isStepsCardData(data: unknown): data is StepsCardData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  if (obj.type !== 'steps' || typeof obj.title !== 'string' || !Array.isArray(obj.steps)) {
    return false;
  }
  return obj.steps.every((step: unknown) => typeof step === 'string');
}

/**
 * Type guard for highlight card data
 */
export function isHighlightCardData(data: unknown): data is HighlightCardData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  if (obj.type !== 'highlight' || typeof obj.title !== 'string' || typeof obj.summary !== 'string') {
    return false;
  }
  if (obj.detail !== undefined && typeof obj.detail !== 'string') {
    return false;
  }
  return true;
}

/**
 * Type guard for paragraph block data
 */
export function isParagraphCardData(data: unknown): data is ParagraphCardData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return obj.type === 'paragraph' && typeof obj.content === 'string';
}

/**
 * Type guard for card data
 */
export function isCardData(data: unknown): data is CardData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  const type = obj.type;
  switch (type) {
    case 'qa':
      return isQACardData(data);
    case 'list':
      return isListCardData(data);
    case 'info':
      return isInfoCardData(data);
    case 'comparison':
      return isComparisonCardData(data);
    case 'knowledge':
      return isKnowledgeCardData(data);
    case 'stats':
      return isStatsCardData(data);
    case 'quote':
      return isQuoteCardData(data);
    case 'steps':
      return isStepsCardData(data);
    case 'highlight':
      return isHighlightCardData(data);
    case 'paragraph':
      return isParagraphCardData(data);
    default:
      return false;
  }
}

/**
 * Parse and validate card deck from JSON string.
 * Root must be a non-empty array of card objects. Single card = [one card].
 * @returns Non-empty array of CardData
 */
export function parseCardDeck(jsonString: string): CardData[] {
  try {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) {
      throw new Error('Card deck must be a JSON array (e.g. [{"type":"qa",...}] for single card)');
    }
    if (parsed.length === 0) {
      throw new Error('Card deck array must not be empty');
    }
    const cards: CardData[] = [];
    for (let i = 0; i < parsed.length; i++) {
      if (!isCardData(parsed[i])) {
        throw new Error(`Invalid card at index ${i}`);
      }
      cards.push(parsed[i]);
    }
    return cards;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON format: ${error.message}`);
    }
    throw error;
  }
}
