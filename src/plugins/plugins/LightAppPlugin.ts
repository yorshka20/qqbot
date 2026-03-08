// LightApp Plugin - when user sends a mini-program (light_app) message,
// parse json_payload, extract URLs, and send them as a forward message

import { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import { extractUrlsFromLightAppPayload } from '@/protocol/milky/utils/lightAppParser';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

/** Normalized message segment (type + data from protocol) */
interface SegmentLike {
  type: string;
  data?: Record<string, unknown>;
}

export interface LightAppPluginConfig {
  /** Prefix line before the URL list (default: "小程序链接：") */
  prefix?: string;
  /** Only send in group (default: true). If false, also send in private. */
  groupOnly?: boolean;
  /** Group IDs where the plugin is enabled. When absent or empty, all groups are allowed. */
  groupIds?: string[];
}

@RegisterPlugin({
  name: 'lightApp',
  version: '1.0.0',
  description:
    'When user sends a mini-program (light_app), parse json_payload, extract URLs, and send them as a message.',
})
export class LightAppPlugin extends PluginBase {
  private messageAPI!: MessageAPI;
  private prefix = '小程序链接：';
  private groupOnly = true;
  private config!: Config;
  /** When non-empty, only these group IDs get light_app URL extraction. Empty = all groups. */
  private allowedGroupIds = new Set<string>();

  async onInit(): Promise<void> {
    this.enabled = true;
    this.messageAPI = new MessageAPI(this.api);
    const pluginConfig = this.pluginConfig?.config as LightAppPluginConfig | undefined;
    if (pluginConfig?.prefix !== undefined) {
      this.prefix = String(pluginConfig.prefix);
    }
    if (pluginConfig?.groupOnly !== undefined) {
      this.groupOnly = Boolean(pluginConfig.groupOnly);
    }
    if (pluginConfig?.groupIds && Array.isArray(pluginConfig.groupIds)) {
      this.allowedGroupIds = new Set(pluginConfig.groupIds.map((id) => String(id).trim()).filter(Boolean));
    }
    this.config = getContainer().resolve<Config>(DITokens.CONFIG);
    logger.info(
      `[LightAppPlugin] Enabled | prefix="${this.prefix}" | groupOnly=${this.groupOnly} | groupIds=${this.allowedGroupIds.size > 0 ? Array.from(this.allowedGroupIds).join(',') : 'all'}`,
    );
  }

  /**
   * Get json_payload from light_app segment data (support snake_case and camelCase from protocol)
   */
  private getJsonPayload(data: Record<string, unknown>): string | undefined {
    const raw = (data.json_payload as string | undefined) ?? (data.jsonPayload as string | undefined);
    return typeof raw === 'string' ? raw : undefined;
  }

  /**
   * Collect all URLs from light_app segments in the message
   */
  private collectUrlsFromSegments(segments: SegmentLike[]): string[] {
    const allUrls: string[] = [];
    const seen = new Set<string>();
    for (const seg of segments) {
      if (seg.type !== 'light_app' || !seg.data) {
        continue;
      }
      const jsonPayload = this.getJsonPayload(seg.data);
      if (!jsonPayload) {
        continue;
      }
      const urls = extractUrlsFromLightAppPayload(jsonPayload);
      for (const u of urls) {
        if (!seen.has(u)) {
          seen.add(u);
          allUrls.push(u);
        }
      }
    }
    return allUrls;
  }

  @Hook({
    stage: 'onMessageReceived',
    priority: 'NORMAL',
    order: 0,
  })
  async onMessageReceived(context: HookContext): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }
    const message = context.message;
    if (this.groupOnly && message.messageType !== 'group') {
      return true;
    }
    if (message.messageType === 'group' && this.allowedGroupIds.size > 0 && message.groupId != null) {
      const groupIdStr = String(message.groupId);
      if (!this.allowedGroupIds.has(groupIdStr)) {
        return true;
      }
    }
    const segments = message.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      return true;
    }
    const urls = this.collectUrlsFromSegments(segments as SegmentLike[]);
    if (urls.length === 0) {
      return true;
    }
    const text = `${this.prefix}\n${urls.join('\n')}`;
    const builder = new MessageBuilder();
    builder.text(text);
    const replySegments = builder.build();

    try {
      const protocol = message.protocol;
      const botUserId = this.config.getBotUserId();

      if (protocol === 'milky' && botUserId) {
        await this.messageAPI.sendForwardFromContext([{ segments: replySegments, senderName: 'Bot' }], message, 10000, {
          botUserId,
        });
      } else {
        await this.messageAPI.sendFromContext(replySegments, message, 10000);
      }
    } catch (_error) {}
    return true;
  }
}
