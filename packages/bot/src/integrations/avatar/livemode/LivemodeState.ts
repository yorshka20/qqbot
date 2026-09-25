// LivemodeState — per-user "simulated livestream" state.
//
// When a user runs `/livemode on`, their private-chat messages stop being
// answered as regular 1:1 dialogue and instead feed a DanmakuBuffer that
// aggregates on a 3-second window and dispatches to the avatar pipeline as
// `livemode-private-batch` — mocking the bilibili live-room flow so the
// avatar can be exercised without an actual live room.
//
// Per-user ownership: each user has their own buffer so messages from
// different users never mix into the same batch (users testing in
// parallel would otherwise cross-contaminate).
//
// Lifecycle:
//   - enable(userId, opts): create a buffer, wire its `flush` event to
//     `dispatch` (the main MessagePipeline), and start the 3s timer.
//   - disable(userId): stop the buffer, unsubscribe listeners, drop state.
//     Any in-flight message still inside the buffer is flushed one last
//     time before teardown so the user's final words get a response.
//
// This is process-memory only — a bot restart resets all livemode state.

import { inject, singleton } from 'tsyringe';
import { MessagePipeline } from '@/conversation/MessagePipeline';
import { makeSyntheticEvent } from '@/conversation/synthetic';
import { DanmakuBuffer, type FlushPayload } from '@/services/bilibili/live/DanmakuBuffer';
import { logger } from '@/utils/logger';

export interface LivemodeEnableOptions {
  /** When false, idle-trigger Phase 2c won't fire for this user. Default true. */
  proactive?: boolean;
}

/** Called with the user id whenever real input from that user is flushed to the pipeline. */
export type LivemodeInputListener = (userId: string) => void;

interface LivemodeUserState {
  proactive: boolean;
  buffer: DanmakuBuffer;
  unsubscribe: () => void;
  enabledAt: number;
}

@singleton()
export class LivemodeState {
  private users = new Map<string, LivemodeUserState>();
  private readonly inputListeners: LivemodeInputListener[] = [];

  constructor(@inject(MessagePipeline) private readonly messagePipeline: MessagePipeline) {}

  onInput(listener: LivemodeInputListener): void {
    this.inputListeners.push(listener);
  }

  /**
   * Run one livemode turn for this user through the main pipeline. Every livemode
   * turn — a flushed batch of the user's messages or an idle kickoff — enters here,
   * so they share one session and one source.
   */
  async dispatch(userId: string, text: string): Promise<void> {
    const event = makeSyntheticEvent({
      source: 'idle-trigger',
      userId,
      groupId: null,
      text,
      messageType: 'private',
      protocol: 'milky',
    });
    try {
      await this.messagePipeline.process(
        event,
        { message: event, sessionId: `idle-${userId}`, sessionType: 'user', botSelfId: '', source: 'idle-trigger' },
        'idle-trigger',
      );
    } catch (err) {
      logger.warn(`[LivemodeState] dispatch failed | userId=${userId}:`, err);
    }
  }

  isEnabled(userId: string | number): boolean {
    return this.users.has(String(userId));
  }

  isProactive(userId: string | number): boolean {
    return this.users.get(String(userId))?.proactive ?? false;
  }

  /** Iterable of enabled user ids — used by the idle trigger to fan out. */
  getEnabledUserIds(): string[] {
    return [...this.users.keys()];
  }

  /** Wall-clock at which livemode was enabled for this user. */
  getEnabledAt(userId: string | number): number | null {
    return this.users.get(String(userId))?.enabledAt ?? null;
  }

  enable(userId: string | number, opts: LivemodeEnableOptions = {}): void {
    const key = String(userId);
    if (this.users.has(key)) {
      // Already enabled — update proactive flag but keep the existing buffer.
      const current = this.users.get(key);
      if (current) current.proactive = opts.proactive !== false;
      return;
    }

    const buffer = new DanmakuBuffer({});
    const onFlush = (payload: FlushPayload): void => {
      for (const listener of this.inputListeners) {
        listener(key);
      }
      void this.dispatch(key, payload.summaryText);
    };
    buffer.on('flush', onFlush);
    buffer.start();

    this.users.set(key, {
      proactive: opts.proactive !== false,
      buffer,
      unsubscribe: () => buffer.off('flush', onFlush),
      enabledAt: Date.now(),
    });
    logger.info(`[LivemodeState] enabled | userId=${key} proactive=${opts.proactive !== false}`);
  }

  disable(userId: string | number): void {
    const key = String(userId);
    const state = this.users.get(key);
    if (!state) return;
    // Flush any pending messages so the user's tail gets handled before we
    // shut the buffer down. `flushNow()` emits the `flush` event which our
    // listener is still subscribed to at this point.
    state.buffer.flushNow();
    state.unsubscribe();
    state.buffer.stop();
    this.users.delete(key);
    logger.info(`[LivemodeState] disabled | userId=${key}`);
  }

  /**
   * Push a raw text message into the user's buffer. Creates a synthetic
   * DanmakuEvent — uid/username come from the message sender, the bufffer
   * dedups by normalized text and the 3s timer flushes the batch.
   */
  pushMessage(userId: string | number, text: string, nickname?: string): void {
    const key = String(userId);
    const state = this.users.get(key);
    if (!state) return;
    state.buffer.push({
      uid: key,
      username: nickname ?? key,
      text,
      timestamp: Date.now(),
    });
  }
}
