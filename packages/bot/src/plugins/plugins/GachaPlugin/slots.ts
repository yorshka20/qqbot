// Gacha slot configuration for SD/NAI standard 9-slot format
// Order matches HTML SLOT_CONFIG_STANDARD: quality, character, expression, appearance, clothing, action, items, scene, composition

export const GACHA_SLOT_IDS = [
  'quality',
  'character',
  'expression',
  'appearance',
  'clothing',
  'action',
  'items',
  'scene',
  'composition',
] as const;

export type GachaSlotId = (typeof GACHA_SLOT_IDS)[number];
