import type { AudioMessage } from './preview/types';
import { splitIntoUtterances } from './tts/splitIntoUtterances';
import type { TTSProvider } from './tts/TTSProvider';

const DEFAULT_GAP_MS = 200;

export class SpeechService {
  private queue: string[] = [];
  private draining = false;
  private lastEndTime = 0;

  constructor(
    private provider: TTSProvider,
    private broadcastAudio: (msg: AudioMessage) => void,
    private hasConsumer: () => boolean,
    private clock: () => number = Date.now,
    private gapMs: number = DEFAULT_GAP_MS,
  ) {}

  speak(text: string, opts?: { maxCharsPerUtterance?: number }): void {
    if (!this.hasConsumer()) {
      // No consumer, discard immediately
      return;
    }

    const utterances = splitIntoUtterances(text, opts?.maxCharsPerUtterance);
    this.queue.push(...utterances);

    if (!this.draining) {
      this.draining = true;
      this.drain();
    }
  }

  isSpeaking(): boolean {
    return this.draining;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      if (!this.hasConsumer()) {
        // Consumer gone, clear queue and stop
        this.queue = [];
        break;
      }

      const utterance = this.queue.shift()!;

      let bytes: Uint8Array;
      let mime: string;
      let durationMs: number;

      try {
        const result = await this.provider.synthesize(utterance);
        bytes = result.bytes;
        mime = result.mime;
        durationMs = result.durationMs;
      } catch (err) {
        console.warn('[SpeechService] synthesize failed, skipping utterance:', err);
        continue;
      }

      const now = this.clock();
      const startAtEpochMs = Math.max(now, this.lastEndTime + this.gapMs);
      this.lastEndTime = startAtEpochMs + durationMs;

      this.broadcastAudio({
        type: 'audio',
        data: {
          base64: Buffer.from(bytes).toString('base64'),
          mime,
          startAtEpochMs,
          durationMs,
          utteranceId: crypto.randomUUID(),
        },
      });

      // Wait until the utterance's end time before processing the next
      const waitMs = this.lastEndTime - this.clock();
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
    }

    this.draining = false;
  }
}
