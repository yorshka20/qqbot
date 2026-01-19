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

  image(input: { file?: string; url?: string; data?: string }): this {
    const { file, url, data } = input;
    const imageData: {
      uri?: string;
      sub_type?: 'normal' | 'sticker';
      summary?: string;
    } = {
      sub_type: 'normal',
      summary: '',
    };

    // Convert to Milky protocol format: use uri field
    if (data) {
      // Base64 data: convert to base64:// URI format
      imageData.uri = `base64://${data}`;
    } else if (url) {
      // HTTP/HTTPS URL: use as-is
      imageData.uri = url;
    } else if (file) {
      // File path: convert to file:// URI format
      if (
        file.startsWith('file://') ||
        file.startsWith('http://') ||
        file.startsWith('https://') ||
        file.startsWith('base64://')
      ) {
        // Already a URI
        imageData.uri = file;
      } else {
        // Local file path: convert to file:// URI
        imageData.uri = `file://${file}`;
      }
    }

    this.segments.push({
      type: 'image',
      data: imageData,
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

  record(input: { file?: string; url?: string; data?: string }): this {
    const { file, url, data } = input;
    const recordData: {
      uri?: string;
    } = {};

    // Convert to Milky protocol format: use uri field
    if (data) {
      // Base64 data: convert to base64:// URI format
      recordData.uri = `base64://${data}`;
    } else if (url) {
      // HTTP/HTTPS URL: use as-is
      recordData.uri = url;
    } else if (file) {
      // File path: convert to file:// URI format
      if (
        file.startsWith('file://') ||
        file.startsWith('http://') ||
        file.startsWith('https://') ||
        file.startsWith('base64://')
      ) {
        // Already a URI
        recordData.uri = file;
      } else {
        // Local file path: convert to file:// URI
        recordData.uri = `file://${file}`;
      }
    }

    this.segments.push({
      type: 'record',
      data: recordData,
    });
    return this;
  }

  file(input: { file?: string; url?: string; file_name?: string }): this {
    const { file, url, file_name } = input;
    const fileData: {
      uri?: string;
      file_name?: string;
    } = {};

    // Convert to Milky protocol format: use uri field
    if (url) {
      // HTTP/HTTPS URL: use as-is
      fileData.uri = url;
    } else if (file) {
      // File path: convert to file:// URI format
      if (
        file.startsWith('file://') ||
        file.startsWith('http://') ||
        file.startsWith('https://') ||
        file.startsWith('base64://')
      ) {
        // Already a URI
        fileData.uri = file;
      } else {
        // Local file path: convert to file:// URI
        fileData.uri = `file://${file}`;
      }
    }

    // Set file name if provided, otherwise extract from file path
    if (file_name) {
      fileData.file_name = file_name;
    } else if (file && !file.startsWith('file://') && !file.startsWith('http://') && !file.startsWith('https://') && !file.startsWith('base64://')) {
      // Extract filename from local file path
      const pathParts = file.split(/[/\\]/);
      const fileName = pathParts[pathParts.length - 1];
      if (fileName) {
        fileData.file_name = fileName;
      }
    }

    this.segments.push({
      type: 'file',
      data: fileData,
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
