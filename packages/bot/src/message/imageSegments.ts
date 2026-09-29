import type { MessageSegment } from './types';

/**
 * Segments the model may be shown as a picture: real images and QQ market stickers,
 * which carry a plain image URL. Built-in QQ faces stay out — they are words, rendered
 * as `[表情:名字]`.
 */
export type ViewableImageSegment = Extract<MessageSegment, { type: 'image' | 'market_face' }>;

/**
 * Every place that enumerates a message's pictures must go through this function: the
 * `<image_segment id="messageId:index">` tags in the prompt and the `fetch_image` lookup
 * address a picture by its position in this list, so a second definition of "image" would
 * make an id resolve to a different picture.
 */
export function collectViewableImageSegments(segments: MessageSegment[] | undefined): ViewableImageSegment[] {
  if (!segments?.length) {
    return [];
  }
  return segments.filter(
    (segment): segment is ViewableImageSegment =>
      typeof segment === 'object' &&
      segment !== null &&
      'type' in segment &&
      (segment.type === 'image' || segment.type === 'market_face'),
  );
}
