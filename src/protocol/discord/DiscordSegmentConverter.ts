// Discord segment converter - bidirectional conversion between internal MessageSegment[] and Discord message format

import { AttachmentBuilder, type Message as DiscordMessage } from 'discord.js';
import type { MessageSegment } from '@/message/types';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/**
 * Convert a Discord.js Message to internal MessageSegment[].
 */
export function discordMessageToSegments(message: DiscordMessage): MessageSegment[] {
  const segments: MessageSegment[] = [];

  // Reply reference
  if (message.reference?.messageId) {
    segments.push({ type: 'reply', data: { id: message.reference.messageId } });
  }

  // Text content (with @mentions parsed)
  if (message.content) {
    // Replace <@userId> mentions with AtSegments
    const parts = message.content.split(/(<@!?\d+>)/g);
    for (const part of parts) {
      const mentionMatch = part.match(/^<@!?(\d+)>$/);
      if (mentionMatch) {
        segments.push({ type: 'at', data: { qq: mentionMatch[1] } });
      } else if (part) {
        segments.push({ type: 'text', data: { text: part } });
      }
    }
  }

  // Attachments
  for (const attachment of message.attachments.values()) {
    const ext = attachment.name?.split('.').pop()?.toLowerCase() ?? '';
    if (IMAGE_EXTENSIONS.has(ext) || attachment.contentType?.startsWith('image/')) {
      segments.push({ type: 'image', data: { uri: attachment.url } });
    } else {
      segments.push({
        type: 'file',
        data: { uri: attachment.url, file_name: attachment.name ?? 'file' },
      });
    }
  }

  return segments;
}

export interface DiscordOutgoingMessage {
  content: string;
  files: AttachmentBuilder[];
  reply?: { messageReference: string };
}

/**
 * Convert internal MessageSegment[] to Discord-compatible message options.
 */
export function segmentsToDiscordMessage(segments: MessageSegment[]): {
  content: string;
  files: AttachmentBuilder[];
  replyTo?: string;
} {
  let content = '';
  let replyTo: string | undefined;
  const files: AttachmentBuilder[] = [];

  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        content += segment.data.text ?? '';
        break;
      case 'at':
        content += `<@${segment.data.qq}>`;
        break;
      case 'face':
        // Best-effort: Discord doesn't have QQ faces, use emoji text
        content += `[face:${segment.data.id}]`;
        break;
      case 'image': {
        const uri = segment.data.uri;
        if (uri?.startsWith('base64://')) {
          const base64Data = uri.slice('base64://'.length);
          const buffer = Buffer.from(base64Data, 'base64');
          files.push(new AttachmentBuilder(buffer, { name: `image_${files.length}.png` }));
        } else if (uri?.startsWith('http://') || uri?.startsWith('https://')) {
          // External URLs can be embedded directly in content
          content += uri;
        } else if (uri) {
          // Other URI schemes: try as file attachment
          files.push(new AttachmentBuilder(uri, { name: `image_${files.length}.png` }));
        }
        break;
      }
      case 'reply':
        replyTo = String(segment.data.id);
        break;
      case 'record':
        if (segment.data.uri) {
          content += `[audio: ${segment.data.uri}]`;
        }
        break;
      case 'file':
        if (segment.data.uri) {
          content += segment.data.uri;
        }
        break;
    }
  }

  return { content, files, replyTo };
}
