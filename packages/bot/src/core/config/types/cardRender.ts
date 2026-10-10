/** Light/dark selection for rendered cards. `auto` follows the night window below. */
export type CardAppearanceMode = 'auto' | 'light' | 'dark';

export interface CardRenderConfig {
  /**
   * Startup value for the appearance. `/cardmode` overrides it for the rest of
   * the process; the override is not written back here, so a restart returns to
   * this value.
   */
  appearance?: CardAppearanceMode;
  /**
   * Hours (0-23, in `DATE_TIMEZONE`) during which `auto` renders dark. The range
   * is half-open — `[18, 9)` means 18:00 up to but not including 09:00 — and
   * wraps past midnight whenever `from > to`.
   */
  darkHours?: { from: number; to: number };
}
