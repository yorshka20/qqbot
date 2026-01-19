// Parse message segments to text/objects

import type { MessageSegment } from './types';

export class MessageParser {
  static segmentsToText(segments: MessageSegment[]): string {
    return segments
      .map((segment) => {
        switch (segment.type) {
          case 'text':
            return segment.data.text;
          case 'at':
            return `@${segment.data.qq}`;
          case 'face':
            return `[Face:${segment.data.id}]`;
          case 'image':
            return `[Image:${segment.data.summary || segment.data.uri || segment.data.resource_id || 'N/A'}]`;
          case 'reply':
            return `[Reply:${segment.data.id}]`;
          default:
            return `[${(segment as any).type}]`;
        }
      })
      .join('');
  }

  static parseToSegments(message: string | MessageSegment[]): MessageSegment[] {
    if (Array.isArray(message)) {
      return message;
    }

    // Simple text message
    return [
      {
        type: 'text',
        data: {
          text: message,
        },
      },
    ];
  }
}
