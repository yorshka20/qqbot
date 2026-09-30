import { describe, expect, it } from 'bun:test';
import { parseDeliveryMarkers, SKIP_CARD_MARKER, SKIP_FORWARD_MARKER } from './contentMarkers';

describe('parseDeliveryMarkers', () => {
  it.each([
    ['at the start', `${SKIP_CARD_MARKER} 正文`, '正文'],
    ['in the middle', `前半 ${SKIP_CARD_MARKER} 后半`, '前半 后半'],
    ['at the end', `正文。 ${SKIP_CARD_MARKER}`, '正文。'],
    ['on its own line', `第一段\n${SKIP_CARD_MARKER}\n第二段`, '第一段\n\n第二段'],
  ])('honours and strips a skip-card marker %s', (_where, input, expected) => {
    expect(parseDeliveryMarkers(input)).toEqual({ text: expected, skipCard: true, skipForward: false });
  });

  it('honours and strips a skip-forward marker anywhere', () => {
    expect(parseDeliveryMarkers(`前半 ${SKIP_FORWARD_MARKER} 后半`)).toEqual({
      text: '前半 后半',
      skipCard: false,
      skipForward: true,
    });
  });

  it('keeps the two markers independent and strips both', () => {
    expect(parseDeliveryMarkers(`${SKIP_FORWARD_MARKER} 正文 ${SKIP_CARD_MARKER}`)).toEqual({
      text: '正文',
      skipCard: true,
      skipForward: true,
    });
  });

  it('strips every repeat of a marker', () => {
    expect(parseDeliveryMarkers(`${SKIP_CARD_MARKER} 正文 ${SKIP_CARD_MARKER}`).text).toBe('正文');
  });

  it('does not treat a longer word that starts with a marker as the marker', () => {
    const text = `${SKIP_CARD_MARKER}s 正文`;
    expect(parseDeliveryMarkers(text)).toEqual({ text, skipCard: false, skipForward: false });
  });

  it('returns unmarked text as is, trimmed', () => {
    expect(parseDeliveryMarkers('  正文  ')).toEqual({ text: '正文', skipCard: false, skipForward: false });
  });
});
