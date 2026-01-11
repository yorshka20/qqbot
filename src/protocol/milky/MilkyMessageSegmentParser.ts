// Milky message segment parser utilities
// Can be reused by other parts of the system that need to parse Milky segments

import type { IncomingSegment } from '@saltify/milky-types';

/**
 * Utility class for parsing Milky message segments
 * This can be reused across the codebase for converting segments to text
 */
export class MilkyMessageSegmentParser {
  /**
   * Convert Milky message segments to plain text representation
   * @param segments Array of incoming message segments
   * @returns Plain text representation of the segments
   */
  static segmentsToText(segments: IncomingSegment[]): string {
    return segments
      .map((segment) => {
        switch (segment.type) {
          case 'text':
            return segment.data.text || '';
          case 'mention':
            return `@${segment.data.user_id}`;
          case 'mention_all':
            return '@全体成员';
          case 'face':
            return `[Face:${segment.data.face_id}]`;
          case 'image':
            return `[Image:${segment.data.summary || segment.data.resource_id}]`;
          case 'reply':
            return `[Reply:${segment.data.message_seq}]`;
          case 'record':
            return `[Record:${segment.data.duration}s]`;
          case 'video':
            return `[Video:${segment.data.duration}s]`;
          case 'file':
            return `[File:${segment.data.file_name}]`;
          case 'forward':
            return `[Forward:${segment.data.title}]`;
          case 'market_face':
            return `[MarketFace:${segment.data.summary}]`;
          case 'light_app':
            return `[LightApp:${segment.data.app_name}]`;
          case 'xml':
            return `[XML]`;
        }
      })
      .join('');
  }
}
