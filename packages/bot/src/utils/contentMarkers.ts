// Content markers — special tokens embedded in LLM output to control delivery behavior.
// The markers are detected and stripped before the message is sent.

/** Marker to skip card rendering and forward delivery; output as plain text directly. */
export const SKIP_CARD_MARKER = '/skip_card';

/** Check if text contains the skip-card marker. */
export function hasSkipCardMarker(text: string): boolean {
  return text.includes(SKIP_CARD_MARKER);
}

/** Strip the skip-card marker from text and trim whitespace. */
export function stripSkipCardMarker(text: string): string {
  return text.replaceAll(SKIP_CARD_MARKER, '').trim();
}
