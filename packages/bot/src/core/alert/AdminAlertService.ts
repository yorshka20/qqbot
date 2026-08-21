import type { Bot } from '@/core/Bot';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';

export interface AdminAlert {
  scope: string;
  title: string;
  error?: unknown;
  detail?: string;
}

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_CAP = 10;
const MAX_MESSAGE_LENGTH = 1500;
const STACK_LINE_LIMIT = 10;

/**
 * Pushes exceptions to the bot owner as a QQ private message. Consumers call
 * `alert()` explicitly, or rely on `installProcessBoundary()` to cover
 * process-level `uncaughtException` / `unhandledRejection` events.
 *
 * Owner id and protocol are resolved at send time (not construction time)
 * because protocols may not be connected yet when the service is built.
 */
export class AdminAlertService {
  private readonly config: ReturnType<Bot['getConfig']>;
  private readonly lastSentAt = new Map<string, number>();
  private readonly sentTimestamps: number[] = [];
  private capNoticeSent = false;
  private boundaryInstalled = false;

  constructor(config: ReturnType<Bot['getConfig']>) {
    this.config = config;
  }

  async alert(a: AdminAlert): Promise<void> {
    try {
      const errorMessage =
        a.error instanceof Error ? a.error.message : a.error !== undefined ? String(a.error) : '';
      const dedupeKey = `${a.scope}|${a.title}|${errorMessage}`;
      const now = Date.now();

      const lastSent = this.lastSentAt.get(dedupeKey);
      if (lastSent !== undefined && now - lastSent < DEDUPE_WINDOW_MS) {
        logger.debug(`[AdminAlertService] Suppressed duplicate alert: ${dedupeKey}`);
        return;
      }

      while (this.sentTimestamps.length > 0 && now - this.sentTimestamps[0] >= RATE_WINDOW_MS) {
        this.sentTimestamps.shift();
      }
      if (this.sentTimestamps.length >= RATE_CAP) {
        if (!this.capNoticeSent) {
          this.capNoticeSent = true;
          this.sentTimestamps.push(now);
          await this.send('⚠️ [AdminAlertService] alert rate cap reached; suppressing further alerts this hour');
        }
        return;
      }
      this.capNoticeSent = false;

      this.lastSentAt.set(dedupeKey, now);
      this.sentTimestamps.push(now);

      const lines = [`⚠️ [${a.scope}] ${a.title}`];
      if (a.detail) lines.push(a.detail);
      if (a.error instanceof Error) {
        lines.push(a.error.message);
        if (a.error.stack) {
          lines.push(a.error.stack.split('\n').slice(0, STACK_LINE_LIMIT).join('\n'));
        }
      } else if (a.error !== undefined) {
        lines.push(String(a.error));
      }

      await this.send(lines.join('\n').slice(0, MAX_MESSAGE_LENGTH));
    } catch (err) {
      // Never let an alert failure propagate — it would recurse through the
      // process boundary installed below.
      logger.error('[AdminAlertService] Failed to process alert:', err);
    }
  }

  private async send(message: string): Promise<void> {
    try {
      const { MessageAPI } = await import('@/api/methods/MessageAPI');
      const container = getContainer();
      const messageAPI = container.resolve<InstanceType<typeof MessageAPI>>(DITokens.MESSAGE_API);
      const ownerId = this.config.getConfig().bot?.owner;
      const enabledProtocols = this.config.getEnabledProtocols();
      const preferredProtocol = enabledProtocols[0]?.name;

      if (!ownerId || !preferredProtocol) {
        logger.warn(
          `[AdminAlertService] Not wired — bot.owner=${ownerId || 'missing'} preferredProtocol=${preferredProtocol || 'missing'}`,
        );
        return;
      }

      await messageAPI.sendPrivateMessage(ownerId, message, preferredProtocol);
    } catch (err) {
      logger.error('[AdminAlertService] Failed to send alert:', err);
    }
  }

  /** Idempotent — safe to call multiple times. */
  installProcessBoundary(): void {
    if (this.boundaryInstalled) return;
    this.boundaryInstalled = true;

    process.on('unhandledRejection', (reason) => {
      logger.error('[AdminAlertService] Unhandled promise rejection:', reason);
      void this.alert({ scope: 'unhandledRejection', title: 'Unhandled promise rejection', error: reason });
    });

    // Deliberately preserves the pre-existing fail-fast semantic: an
    // uncaught exception still crashes the process, this only adds a
    // best-effort notification before exit.
    process.on('uncaughtException', (err) => {
      logger.error('[AdminAlertService] Uncaught exception:', err);
      void (async () => {
        await Promise.race([
          this.alert({ scope: 'uncaughtException', title: 'Uncaught exception', error: err }),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
        process.exit(1);
      })();
    });
  }
}
