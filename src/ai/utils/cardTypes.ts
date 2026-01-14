// Card data types for LLM response rendering

export type CardType = 'qa' | 'list' | 'info' | 'comparison' | 'knowledge' | 'stats';

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
 * Comparison card data
 */
export interface ComparisonCardData extends BaseCardData {
  type: 'comparison';
  title: string;
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
 * Union type for all card data types
 */
export type CardData =
  | QACardData
  | ListCardData
  | InfoCardData
  | ComparisonCardData
  | KnowledgeCardData
  | StatsCardData;

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
  if (obj.type !== 'comparison' || typeof obj.title !== 'string' || !Array.isArray(obj.items)) {
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
    default:
      return false;
  }
}

/**
 * Parse and validate card data from JSON string
 */
export function parseCardData(jsonString: string): CardData {
  try {
    const data = JSON.parse(jsonString);
    if (isCardData(data)) {
      return data;
    }
    throw new Error('Invalid card data format');
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON format: ${error.message}`);
    }
    throw error;
  }
}
