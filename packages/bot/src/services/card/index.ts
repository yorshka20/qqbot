// Card service - types, templates, rendering

export { CardAppearanceService } from './CardAppearanceService';
export { CardRenderer } from './CardRenderer';
export { CardRenderingService } from './CardRenderingService';
export {
  renderCard,
  renderCardDeck,
} from './cardTemplates';
export type {
  CardData,
  ComparisonCardData,
  HighlightCardData,
  ImageCardData,
  InfoCardData,
  KnowledgeCardData,
  ListCardData,
  ParagraphCardData,
  QACardData,
  QuoteCardData,
  StatsCardData,
  StepsCardData,
} from './cardTypes';
export type { CardAppearance } from './styles';
export { getCardStyles } from './styles';
