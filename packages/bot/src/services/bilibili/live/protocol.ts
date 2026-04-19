// Bilibili live WebSocket binary protocol.
//
// Each packet starts with a 16-byte header:
//   +0  uint32 BE  packLen   total packet length (header + body)
//   +4  uint16 BE  headerLen always 16
//   +6  uint16 BE  protover  0 = raw JSON, 1 = popularity (uint32 BE in body),
//                            2 = zlib-compressed nested packets,
//                            3 = brotli-compressed nested packets
//   +8  uint32 BE  op        operation code (see Op enum)
//   +12 uint32 BE  seq       sequence id (client-chosen; echoed by server)
//   +16 body      length = packLen - headerLen
//
// A protover=2 / protover=3 packet's body decompresses to one or more
// nested packets (each with its own 16-byte header), which may themselves be
// op=5 business messages carrying raw JSON.
//
// Reference: https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/live/message_stream.md

import { brotliDecompressSync, inflateSync } from 'node:zlib';

export const HEADER_LEN = 16;

export enum Op {
  /** Heartbeat (client → server, every ~30s). Empty body. */
  HEARTBEAT = 2,
  /** Heartbeat reply (server → client). Body = uint32 BE online viewer count. */
  HEARTBEAT_REPLY = 3,
  /** Business message (server → client). Body = JSON. */
  MESSAGE = 5,
  /** Auth packet (client → server, first frame after connect). Body = JSON. */
  AUTH = 7,
  /** Auth reply (server → client). Body = JSON, `code:0` on success. */
  AUTH_REPLY = 8,
}

export enum Protover {
  RAW_JSON = 0,
  POPULARITY = 1,
  ZLIB = 2,
  BROTLI = 3,
}

export interface RawFrame {
  protover: Protover;
  op: Op;
  seq: number;
  body: Buffer;
}

/**
 * Encode a single packet. Used for auth + heartbeat. Body may be a JSON
 * object (will be stringified) or empty.
 */
export function encodePacket(op: Op, body: object | string = '', protover: Protover = Protover.RAW_JSON): Buffer {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const bodyBuf = Buffer.from(bodyStr, 'utf8');
  const packLen = HEADER_LEN + bodyBuf.length;
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt32BE(packLen, 0);
  header.writeUInt16BE(HEADER_LEN, 4);
  header.writeUInt16BE(protover, 6);
  header.writeUInt32BE(op, 8);
  header.writeUInt32BE(1, 12);
  return Buffer.concat([header, bodyBuf]);
}

/**
 * Parse one raw packet (no decompression recursion). Returns null if the
 * buffer is too short for a complete packet at the given offset.
 *
 * The protover/op fields drive the caller's dispatch: protover=2/3 bodies
 * need further decompression + recursive decoding, whereas protover=0 with
 * op=5 bodies are ready-to-parse JSON.
 */
export function parseOne(buf: Buffer, offset = 0): { frame: RawFrame; next: number } | null {
  if (buf.length - offset < HEADER_LEN) return null;
  const packLen = buf.readUInt32BE(offset + 0);
  const headerLen = buf.readUInt16BE(offset + 4);
  if (packLen < headerLen || buf.length - offset < packLen) return null;
  const protover = buf.readUInt16BE(offset + 6) as Protover;
  const op = buf.readUInt32BE(offset + 8) as Op;
  const seq = buf.readUInt32BE(offset + 12);
  const body = buf.subarray(offset + headerLen, offset + packLen);
  return { frame: { protover, op, seq, body }, next: offset + packLen };
}

/**
 * Decode a buffer into a flat list of decompressed frames, recursively
 * expanding protover=2 (zlib) and protover=3 (brotli) wrappers. Only leaf
 * frames (protover=0/1) are returned.
 */
export function decodeAll(buf: Buffer): RawFrame[] {
  const out: RawFrame[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const parsed = parseOne(buf, offset);
    if (!parsed) break;
    offset = parsed.next;
    const { frame } = parsed;
    if (frame.protover === Protover.BROTLI) {
      const decompressed = brotliDecompressSync(frame.body);
      out.push(...decodeAll(decompressed));
    } else if (frame.protover === Protover.ZLIB) {
      const decompressed = inflateSync(frame.body);
      out.push(...decodeAll(decompressed));
    } else {
      out.push(frame);
    }
  }
  return out;
}

/**
 * Interpret a body as JSON (for op=MESSAGE leaf frames). Returns null on
 * parse failure — some server-side cmd payloads ship malformed JSON that we
 * should tolerate without killing the connection.
 */
export function decodeBodyJson<T = unknown>(frame: RawFrame): T | null {
  try {
    return JSON.parse(frame.body.toString('utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Interpret a HEARTBEAT_REPLY body as the online viewer count (uint32 BE).
 */
export function decodeOnlineCount(frame: RawFrame): number {
  if (frame.body.length < 4) return 0;
  return frame.body.readUInt32BE(0);
}
