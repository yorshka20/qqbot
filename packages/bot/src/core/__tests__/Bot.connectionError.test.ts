import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'bun:test';

/**
 * A connection fault must not reach the `error` channel.
 *
 * `Bot` extends EventEmitter and nothing listens for `error`, so emitting it there throws —
 * escalating a fault the transport is already retrying into an uncaught exception that the
 * process boundary turns into an exit. These tests pin the EventEmitter behaviour that makes
 * the distinction load-bearing, and the channel `Bot.setupConnectionManagerEvents` uses.
 */
describe('connection error channel', () => {
  it('throws when `error` is emitted with no listener', () => {
    const emitter = new EventEmitter();
    expect(() => emitter.emit('error', new Error('connect failed'))).toThrow('connect failed');
  });

  it('does not throw on the `connectionError` channel with no listener', () => {
    const emitter = new EventEmitter();
    expect(() => emitter.emit('connectionError', 'milky', new Error('connect failed'))).not.toThrow();
  });

  it('still delivers protocol and error to a listener', () => {
    const emitter = new EventEmitter();
    const seen: Array<[string, string]> = [];
    emitter.on('connectionError', (protocol: string, error: Error) => seen.push([protocol, error.message]));
    emitter.emit('connectionError', 'milky', new Error('connect failed'));
    expect(seen).toEqual([['milky', 'connect failed']]);
  });

  it('routes connection faults away from `error` in Bot', async () => {
    const source = await Bun.file(`${import.meta.dir}/../Bot.ts`).text();
    const handler = source.slice(source.indexOf("this.connectionManager.on('connectionError'"));
    const body = handler.slice(0, handler.indexOf('});'));
    expect(body).toContain("this.emit('connectionError'");
    expect(body).not.toContain("this.emit('error'");
  });
});
