// Tests for formatTimeSpanCompact: the label used wherever a block covers a stretch
// of time rather than a moment (e.g. a compressed conversation summary).

import { describe, expect, it } from 'bun:test';
import { formatTimeSpanCompact } from '../dateTime';

/** Build an Asia/Tokyo wall-clock time (TZ used by the formatter). */
function jst(month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, month - 1, day, hour - 9, minute));
}

describe('formatTimeSpanCompact', () => {
  it('collapses the repeated date within one day', () => {
    expect(formatTimeSpanCompact(jst(8, 27, 12, 30), jst(8, 27, 13, 24))).toBe('8/27 12:30–13:24');
  });

  it('keeps both dates across a day boundary', () => {
    expect(formatTimeSpanCompact(jst(8, 26, 23, 10), jst(8, 27, 1, 5))).toBe('8/26 23:10 – 8/27 01:05');
  });

  it('renders a single stamp when there is no end', () => {
    expect(formatTimeSpanCompact(jst(8, 27, 12, 30))).toBe('8/27 12:30');
  });

  it('renders a single stamp when the span is under a minute', () => {
    expect(formatTimeSpanCompact(jst(8, 27, 12, 30), jst(8, 27, 12, 30))).toBe('8/27 12:30');
  });
});
