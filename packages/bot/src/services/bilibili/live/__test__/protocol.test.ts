// Tests for the Bilibili live WebSocket binary protocol decoder.
//
// Rather than recording a real server frame (which would pin to a specific
// brotli payload), we build known packets ourselves via `encodePacket` and
// round-trip them through `parseOne` / `decodeAll`. The zlib branch is also
// exercised using Node's built-in `deflateSync` to ensure the wrapper expand
// path recurses correctly into nested leaf packets.

import { describe, expect, it } from 'bun:test';
import { deflateSync } from 'node:zlib';
import {
  decodeAll,
  decodeBodyJson,
  decodeOnlineCount,
  encodePacket,
  HEADER_LEN,
  Op,
  Protover,
  parseOne,
} from '../protocol';

describe('protocol.encodePacket / parseOne', () => {
  it('encodes then parses a raw JSON business packet', () => {
    const body = { cmd: 'DANMU_MSG', info: ['meta', 'hello world', [12345, 'alice']] };
    const pkt = encodePacket(Op.MESSAGE, body, Protover.RAW_JSON);
    const parsed = parseOne(pkt);
    expect(parsed).not.toBeNull();
    expect(parsed?.frame.op).toBe(Op.MESSAGE);
    expect(parsed?.frame.protover).toBe(Protover.RAW_JSON);
    expect(parsed?.next).toBe(pkt.length);
    const decoded = decodeBodyJson<{ cmd: string; info: unknown[] }>(parsed!.frame);
    expect(decoded?.cmd).toBe('DANMU_MSG');
    expect(decoded?.info?.[1]).toBe('hello world');
  });

  it('returns null when the buffer is too short for a header', () => {
    expect(parseOne(Buffer.alloc(HEADER_LEN - 1))).toBeNull();
  });

  it('returns null when the buffer is too short for the declared packet length', () => {
    const pkt = encodePacket(Op.HEARTBEAT, '');
    // Truncate the body — header claims packLen=HEADER_LEN but we give only HEADER_LEN-1 bytes total.
    expect(parseOne(pkt.subarray(0, HEADER_LEN - 1))).toBeNull();
  });
});

describe('protocol.decodeAll', () => {
  it('expands a zlib-wrapped packet into its nested leaves', () => {
    const inner1 = encodePacket(Op.MESSAGE, { cmd: 'DANMU_MSG', info: [null, 'first'] });
    const inner2 = encodePacket(Op.MESSAGE, { cmd: 'SEND_GIFT', data: { giftName: 'HEART' } });
    const concatenated = Buffer.concat([inner1, inner2]);
    const compressed = deflateSync(concatenated);
    const wrapper = encodePacket(Op.MESSAGE, compressed, Protover.ZLIB);
    // encodePacket stringifies objects but passes a Buffer through json.stringify as well.
    // To keep the zlib body binary-clean, build the wrapper manually instead.
    const header = Buffer.alloc(HEADER_LEN);
    const packLen = HEADER_LEN + compressed.length;
    header.writeUInt32BE(packLen, 0);
    header.writeUInt16BE(HEADER_LEN, 4);
    header.writeUInt16BE(Protover.ZLIB, 6);
    header.writeUInt32BE(Op.MESSAGE, 8);
    header.writeUInt32BE(1, 12);
    const realWrapper = Buffer.concat([header, compressed]);
    void wrapper;

    const frames = decodeAll(realWrapper);
    expect(frames.length).toBe(2);
    expect(decodeBodyJson<{ cmd: string }>(frames[0])?.cmd).toBe('DANMU_MSG');
    expect(decodeBodyJson<{ cmd: string }>(frames[1])?.cmd).toBe('SEND_GIFT');
  });

  it('handles a concatenated stream of two raw packets', () => {
    const a = encodePacket(Op.MESSAGE, { cmd: 'A' });
    const b = encodePacket(Op.MESSAGE, { cmd: 'B' });
    const frames = decodeAll(Buffer.concat([a, b]));
    expect(frames.length).toBe(2);
    expect(decodeBodyJson<{ cmd: string }>(frames[0])?.cmd).toBe('A');
    expect(decodeBodyJson<{ cmd: string }>(frames[1])?.cmd).toBe('B');
  });

  it('returns empty on empty input', () => {
    expect(decodeAll(Buffer.alloc(0))).toEqual([]);
  });
});

describe('protocol.decodeOnlineCount', () => {
  it('reads a uint32 BE online count from a HEARTBEAT_REPLY body', () => {
    const body = Buffer.alloc(4);
    body.writeUInt32BE(12345, 0);
    const header = Buffer.alloc(HEADER_LEN);
    header.writeUInt32BE(HEADER_LEN + body.length, 0);
    header.writeUInt16BE(HEADER_LEN, 4);
    header.writeUInt16BE(Protover.RAW_JSON, 6);
    header.writeUInt32BE(Op.HEARTBEAT_REPLY, 8);
    header.writeUInt32BE(1, 12);
    const pkt = Buffer.concat([header, body]);
    const parsed = parseOne(pkt);
    expect(parsed).not.toBeNull();
    expect(decodeOnlineCount(parsed!.frame)).toBe(12345);
  });

  it('returns 0 when the body is too short', () => {
    const frame = { protover: Protover.RAW_JSON, op: Op.HEARTBEAT_REPLY, seq: 0, body: Buffer.alloc(2) };
    expect(decodeOnlineCount(frame)).toBe(0);
  });
});
