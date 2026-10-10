// Surface-dependent colours for a rendered deck, in two sets: one for a light
// card surface and one for a dark one.
//
// Why this file exists: every colour that only makes sense against a particular
// surface used to be a literal inside a card module, so the deck could only ever
// be light. A role listed here is emitted by ./tokens as `--card-<kebab-role>`
// and read back as a custom property, which keeps the card modules free of
// interpolation and leaves exactly one place where a dark value is chosen.
//
// Provider identity (primary / secondary) is NOT here — it is the same in both
// appearances and comes from ./theme. A palette entry may reference those tokens,
// which is how the light frame stays provider-coloured.

export type CardAppearance = 'light' | 'dark';

/**
 * One field per colour role the stylesheet reads. Named for what the value
 * means, not where it is used; `ink` is text, `line` is a border, `wash` is a
 * translucent fill behind inline emphasis, `chip` is a small opaque label fill,
 * `cell` is a table cell fill.
 */
export interface CardPalette {
  /** `.container` — the band around the cards, carrying the watermark and footer. */
  frame: string;
  /** `.card-inner` and any panel that should read as the top-level card surface. */
  surface: string;
  /** A panel offset from the surface: list rows, table headers, blockquotes. */
  surfaceSunken: string;
  /** Elevation shadow colour for anything sitting on the surface. */
  surfaceShadow: string;
  /** Alternating table row fill. */
  zebra: string;

  ink: string;
  inkStrong: string;
  inkMuted: string;

  hairline: string;
  hairlineSoft: string;
  /** Translucent wash for rich-text code, neutral against any surface. */
  overlay: string;

  codeBg: string;
  codeInk: string;
  codeBlockBg: string;
  codeBlockInk: string;

  qaBg: string;
  knowledgeBg: string;

  blueBg: string;
  blueLine: string;
  blueInk: string;
  blueInkSoft: string;
  blueWash: string;
  blueChip: string;
  blueGlow: string;

  amberBg: string;
  amberLine: string;
  amberInk: string;
  amberInkSoft: string;
  amberWash: string;

  greenBg: string;
  greenLine: string;
  greenInk: string;
  greenInkSoft: string;
  greenWash: string;
  greenChip: string;
  greenChipLine: string;
  greenCell: string;
  greenCellLine: string;
  greenDot: string;

  purpleBg: string;
  purpleLine: string;
  purpleInk: string;
  purpleInkSoft: string;
  purpleWash: string;

  roseInk: string;
  roseChip: string;
  roseChipLine: string;
  roseCell: string;
  roseCellLine: string;
  roseDot: string;

  yellowBg: string;
  yellowLine: string;
  yellowInk: string;
  yellowInkSoft: string;

  tealBg: string;
  tealLine: string;
  /** 90deg gradient for a rule under a heading. */
  tealRule: string;
  /** 135deg gradient for a filled badge. */
  tealFill: string;
}

const LIGHT_PALETTE: CardPalette = {
  frame: 'var(--card-primary)',
  surface: '#ffffff',
  surfaceSunken: '#f4f6f8',
  surfaceShadow: 'rgba(0, 0, 0, 0.1)',
  zebra: '#fafbfc',

  ink: '#2c3e50',
  inkStrong: '#111827',
  inkMuted: '#6b7280',

  hairline: '#e5e7eb',
  hairlineSoft: '#f0f2f6',
  overlay: 'rgba(0, 0, 0, 0.06)',

  codeBg: '#f3f4f6',
  codeInk: '#be185d',
  codeBlockBg: '#1f2937',
  codeBlockInk: '#f9fafb',

  qaBg: 'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)',
  knowledgeBg: 'linear-gradient(180deg, #faf8f5 0%, #f0ebe3 100%)',

  blueBg: 'linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%)',
  blueLine: '#2196f3',
  blueInk: '#0d47a1',
  blueInkSoft: '#1565c0',
  blueWash: 'rgba(21, 101, 192, 0.15)',
  blueChip: '#e3f2fd',
  blueGlow: 'rgba(59, 130, 246, 0.15)',

  amberBg: 'linear-gradient(135deg, #fff3e0 0%, #ffe0b2 100%)',
  amberLine: '#ff9800',
  amberInk: '#bf360c',
  amberInkSoft: '#e65100',
  amberWash: 'rgba(230, 81, 0, 0.12)',

  greenBg: 'linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%)',
  greenLine: '#4caf50',
  greenInk: '#1b5e20',
  greenInkSoft: '#2e7d32',
  greenWash: 'rgba(46, 125, 50, 0.12)',
  greenChip: '#edfaf1',
  greenChipLine: '#b7eacb',
  greenCell: '#f6fef9',
  greenCellLine: '#d1fae5',
  greenDot: '#34d399',

  purpleBg: 'linear-gradient(135deg, #f3e5f5 0%, #e1bee7 100%)',
  purpleLine: '#9c27b0',
  purpleInk: '#6a1b9a',
  purpleInkSoft: '#7b1fa2',
  purpleWash: 'rgba(123, 31, 162, 0.12)',

  roseInk: '#c62828',
  roseChip: '#fff1f2',
  roseChipLine: '#fecdd3',
  roseCell: '#fff9f9',
  roseCellLine: '#fee2e2',
  roseDot: '#f87171',

  yellowBg: 'linear-gradient(135deg, #fefce8 0%, #fef9c3 100%)',
  yellowLine: '#eab308',
  yellowInk: '#1c1917',
  yellowInkSoft: '#78716c',

  tealBg: 'linear-gradient(135deg, #f0fdfa 0%, #ccfbf1 100%)',
  tealLine: '#0d9488',
  tealRule: 'linear-gradient(90deg, #0d9488, #06b6d4)',
  tealFill: 'linear-gradient(135deg, #0d9488, #06b6d4)',
};

// The dark set keeps the provider accent for the watermark and the gradients but
// drops the frame to a neutral: a saturated 800px band is the single brightest
// thing in the image, which is what makes a light card harsh at night.
const DARK_PALETTE: CardPalette = {
  frame: '#13161b',
  surface: '#20242b',
  surfaceSunken: '#282e37',
  surfaceShadow: 'rgba(0, 0, 0, 0.5)',
  zebra: '#242931',

  ink: '#d5dbe4',
  inkStrong: '#f2f4f8',
  inkMuted: '#98a2b3',

  hairline: '#333a45',
  hairlineSoft: '#2a3038',
  overlay: 'rgba(255, 255, 255, 0.08)',

  codeBg: 'rgba(255, 255, 255, 0.08)',
  codeInk: '#f0a0c0',
  codeBlockBg: '#12161c',
  codeBlockInk: '#e6eaf0',

  qaBg: 'linear-gradient(135deg, #242932 0%, #1a1e25 100%)',
  knowledgeBg: 'linear-gradient(180deg, #1b1e24 0%, #15181d 100%)',

  blueBg: 'linear-gradient(135deg, #17283a 0%, #121f2e 100%)',
  blueLine: '#3b82f6',
  blueInk: '#9dc3f5',
  blueInkSoft: '#74a9ee',
  blueWash: 'rgba(59, 130, 246, 0.18)',
  blueChip: 'rgba(59, 130, 246, 0.18)',
  blueGlow: 'rgba(59, 130, 246, 0.2)',

  amberBg: 'linear-gradient(135deg, #3a2a14 0%, #2d2010 100%)',
  amberLine: '#f59e0b',
  amberInk: '#fcd34d',
  amberInkSoft: '#fbbf24',
  amberWash: 'rgba(245, 158, 11, 0.16)',

  greenBg: 'linear-gradient(135deg, #15301f 0%, #112618 100%)',
  greenLine: '#22c55e',
  greenInk: '#86efac',
  greenInkSoft: '#4ade80',
  greenWash: 'rgba(34, 197, 94, 0.16)',
  greenChip: 'rgba(34, 197, 94, 0.14)',
  greenChipLine: 'rgba(34, 197, 94, 0.4)',
  greenCell: '#182219',
  greenCellLine: 'rgba(34, 197, 94, 0.22)',
  greenDot: '#34d399',

  purpleBg: 'linear-gradient(135deg, #2b1c38 0%, #22162c 100%)',
  purpleLine: '#a855f7',
  purpleInk: '#d8b4fe',
  purpleInkSoft: '#c084fc',
  purpleWash: 'rgba(168, 85, 247, 0.18)',

  roseInk: '#fda4af',
  roseChip: 'rgba(251, 113, 133, 0.14)',
  roseChipLine: 'rgba(251, 113, 133, 0.4)',
  roseCell: '#241719',
  roseCellLine: 'rgba(251, 113, 133, 0.22)',
  roseDot: '#fb7185',

  yellowBg: 'linear-gradient(135deg, #332c12 0%, #28220e 100%)',
  yellowLine: '#eab308',
  yellowInk: '#f0e7c4',
  yellowInkSoft: '#b5ab87',

  tealBg: 'linear-gradient(135deg, #10302e 0%, #0c2624 100%)',
  tealLine: '#14b8a6',
  tealRule: 'linear-gradient(90deg, #14b8a6, #22d3ee)',
  tealFill: 'linear-gradient(135deg, #14b8a6, #22d3ee)',
};

export function getCardPalette(appearance: CardAppearance): CardPalette {
  return appearance === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;
}
