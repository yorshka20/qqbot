// Builder for constructing messages

import type { MessageSegment } from './types';

export class MessageBuilder {
  private segments: MessageSegment[] = [];

  text(content: string): this {
    this.segments.push({
      type: 'text',
      data: {
        text: content,
      },
    });
    return this;
  }

  at(userId: number | string): this {
    this.segments.push({
      type: 'at',
      data: {
        qq: userId,
      },
    });
    return this;
  }

  face(faceId: number | string): this {
    this.segments.push({
      type: 'face',
      data: {
        id: faceId,
      },
    });
    return this;
  }

  image(file: string, url?: string): this {
    this.segments.push({
      type: 'image',
      data: {
        file,
        url,
      },
    });
    return this;
  }

  reply(messageId: number | string): this {
    this.segments.push({
      type: 'reply',
      data: {
        id: messageId,
      },
    });
    return this;
  }

  build(): MessageSegment[] {
    return [...this.segments];
  }

  clear(): this {
    this.segments = [];
    return this;
  }
}
