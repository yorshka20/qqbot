// Owns the bot-wide light/dark choice for rendered cards.

import { inject, singleton } from 'tsyringe';
import { type CardAppearanceMode, Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { getHourInTimezone } from '@/utils/dateTime';
import type { CardAppearance } from './styles';

const DEFAULT_DARK_HOURS = { from: 18, to: 9 };

@singleton()
export class CardAppearanceService {
  private mode: CardAppearanceMode;
  private readonly darkHours: { from: number; to: number };

  constructor(@inject(DITokens.CONFIG) config: Config) {
    const cardRender = config.getCardRenderConfig();
    this.mode = cardRender?.appearance ?? 'auto';
    this.darkHours = this.normalizeDarkHours(cardRender?.darkHours);
  }

  getMode(): CardAppearanceMode {
    return this.mode;
  }

  setMode(mode: CardAppearanceMode): void {
    this.mode = mode;
  }

  /** The appearance a render should use right now. */
  resolve(now: Date = new Date()): CardAppearance {
    if (this.mode !== 'auto') {
      return this.mode;
    }
    return this.isDarkHour(getHourInTimezone(now)) ? 'dark' : 'light';
  }

  /** The configured window, as `18:00-09:00`, for command output. */
  describeDarkWindow(): string {
    const pad = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
    return `${pad(this.darkHours.from)}-${pad(this.darkHours.to)}`;
  }

  private isDarkHour(hour: number): boolean {
    const { from, to } = this.darkHours;
    // A window that starts later than it ends spans midnight, so the two halves
    // are a union rather than an interval.
    return from > to ? hour >= from || hour < to : hour >= from && hour < to;
  }

  private normalizeDarkHours(hours: { from: number; to: number } | undefined): { from: number; to: number } {
    if (!hours) {
      return DEFAULT_DARK_HOURS;
    }
    const inRange = (hour: number) => Number.isInteger(hour) && hour >= 0 && hour <= 23;
    if (!inRange(hours.from) || !inRange(hours.to)) {
      throw new Error(`cardRender.darkHours must be whole hours in 0-23, got ${hours.from}-${hours.to}`);
    }
    return hours;
  }
}
