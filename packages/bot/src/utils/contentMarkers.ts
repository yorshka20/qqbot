// Content markers — special tokens embedded in LLM output to control delivery behavior.
// A marker counts wherever it appears in the text. Every path that delivers model text
// parses the markers once, before deciding on card or forward, and sends the text with
// them removed, so detection and stripping can never drift apart.

/** Deliver as plain text instead of a rendered card image; forwarding is decided as usual. */
export const SKIP_CARD_MARKER = '/skip_card';

/** Send directly instead of as a forward message (合并转发); card rendering is decided as usual. */
export const SKIP_FORWARD_MARKER = '/skip_forward';

export interface DeliveryMarkers {
  text: string;
  skipCard: boolean;
  skipForward: boolean;
}

/** Removes the marker together with the spaces before it, so `a /skip_card b` leaves `a b`. */
function stripMarker(text: string, marker: string): { text: string; found: boolean } {
  const stripped = text.replace(new RegExp(`[ \\t]*${marker}\\b`, 'g'), '');
  return { text: stripped, found: stripped !== text };
}

export function parseDeliveryMarkers(text: string): DeliveryMarkers {
  const card = stripMarker(text, SKIP_CARD_MARKER);
  const forward = stripMarker(card.text, SKIP_FORWARD_MARKER);
  return { text: forward.text.trim(), skipCard: card.found, skipForward: forward.found };
}
