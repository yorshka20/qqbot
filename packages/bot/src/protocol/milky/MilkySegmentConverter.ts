// Convert internal MessageSegment[] to Milky OutgoingSegment[] for sending (e.g. forward message nodes)

import type { OutgoingSegment } from '@saltify/milky-types';
import type { MessageSegment } from '@/message/types';

/**
 * Convert internal MessageSegment[] to Milky protocol OutgoingSegment[].
 * Used when building forward message nodes so each node's segments are valid for the Milky API.
 */
export function segmentsToMilkyOutgoing(segments: MessageSegment[]): OutgoingSegment[] {
  const out: OutgoingSegment[] = [];
  for (const seg of segments) {
    switch (seg.type) {
      case 'text': {
        out.push({ type: 'text', data: { text: seg.data.text } });
        break;
      }
      case 'at': {
        const userId = typeof seg.data.qq === 'string' ? parseInt(seg.data.qq, 10) : Number(seg.data.qq);
        if (!Number.isNaN(userId)) {
          out.push({ type: 'mention', data: { user_id: userId } });
        }
        break;
      }
      case 'face': {
        const faceId = typeof seg.data.id === 'string' ? seg.data.id : String(seg.data.id);
        out.push({
          type: 'face',
          data: { face_id: faceId, is_large: false },
        });
        break;
      }
      case 'image': {
        const uri = seg.data.uri ?? seg.data.temp_url ?? '';
        if (uri) {
          out.push({
            type: 'image',
            data: {
              uri,
              sub_type: seg.data.sub_type ?? 'normal',
              ...(seg.data.summary != null && { summary: seg.data.summary }),
            },
          });
        }
        break;
      }
      case 'reply': {
        const messageSeq = typeof seg.data.id === 'string' ? parseInt(seg.data.id, 10) : Number(seg.data.id);
        if (!Number.isNaN(messageSeq)) {
          out.push({ type: 'reply', data: { message_seq: messageSeq } });
        }
        break;
      }
      case 'record': {
        const uri = seg.data.uri ?? seg.data.url ?? '';
        if (uri) {
          out.push({ type: 'record', data: { uri } });
        }
        break;
      }
      case 'file':
        // Milky OutgoingSegment has no 'file' type; skip or represent as text placeholder
        if (seg.data.file_name) {
          out.push({ type: 'text', data: { text: `[File: ${seg.data.file_name}]` } });
        }
        break;
      default:
        break;
    }
  }
  return out;
}
