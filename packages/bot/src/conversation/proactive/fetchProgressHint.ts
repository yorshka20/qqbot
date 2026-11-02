import type { FetchProgressNotifier } from '@qqbot/retrieval';
import { logger } from '@qqbot/shared';

/**
 * A notifier that posts "正在查询：" with the titles about to be fetched. `send` is bound to the
 * chat the reply will go to, so the hint always lands beside its reply. Fire-and-forget: the
 * fetch never waits on the hint, and a failed hint is not a failed reply.
 */
export function fetchProgressHint(send: (text: string) => Promise<unknown>): FetchProgressNotifier {
  return {
    onFetchingUrls(titles) {
      if (titles.length === 0) {
        return;
      }
      const text = `正在查询：\n${titles.map((t) => `- ${t}`).join('\n')}`;
      send(text).catch((err: unknown) => {
        logger.debug(
          `[fetchProgressHint] Failed to send fetch hint: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
  };
}
