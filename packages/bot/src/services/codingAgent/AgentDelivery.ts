/**
 * Everything the coding-agent service delivers to a chat — progress, results,
 * the agent's own messages, cards and files — goes through here, and each
 * delivery is written to that session's history. These sends bypass the reply
 * pipeline, so without the history write the chat LLM would never see what an
 * agent reported and could not discuss it on the next turn.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, sep } from 'node:path';
import type { CardRenderingHelper } from '@/ai/pipeline/helpers/CardRenderingHelper';
import type { FileAPI } from '@/api/methods/FileAPI';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { ProtocolName } from '@/core/config';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { CardData } from '@/services/card/cardTypes';
import { logger } from '@/utils/logger';

export interface AgentDeliveryDeps {
  messageAPI: MessageAPI;
  fileAPI: FileAPI;
  historyService: ConversationHistoryService;
  cardRenderer: CardRenderingHelper;
}

export interface DeliveryTarget {
  type: 'user' | 'group';
  id: string;
}

export interface DeliveryResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/** Protocol the bot is connected on and its own QQ id, both known only once connected. */
export type BotIdentity = () => { protocol: ProtocolName | undefined; selfId: number };

const FILE_UPLOAD_TIMEOUT_MS = 120_000;

export class AgentDelivery {
  constructor(
    private readonly deps: AgentDeliveryDeps,
    private readonly bot: BotIdentity,
  ) {}

  /**
   * Send text. `forwardAs` sends it as a forward message under that sender
   * name, which keeps long results from flooding the chat.
   */
  async sendText(target: DeliveryTarget, content: string, forwardAs?: string): Promise<DeliveryResult> {
    return this.deliver(target, 'coding_agent', async (protocol, chatId, selfId) => {
      const segments = new MessageBuilder().text(content).build();
      if (forwardAs && protocol === 'milky' && selfId > 0) {
        const result = await this.deps.messageAPI.sendForwardMessage(
          { type: target.type, id: chatId },
          [{ segments, senderName: forwardAs }],
          protocol,
          { botUserId: selfId },
        );
        return {
          messageSeq: result?.message_seq,
          messageId: result?.message_id ?? result?.message_seq,
          history: content,
        };
      }
      const messageSeq = await this.sendSegments(target, chatId, content, protocol);
      return { messageSeq, messageId: messageSeq, history: content };
    });
  }

  /** Render a card deck to an image and send it; history keeps the deck's text form. */
  async sendCards(
    target: DeliveryTarget,
    cards: CardData[],
    attribution: { agentName: string; model: string },
  ): Promise<DeliveryResult> {
    return this.deliver(target, 'coding_agent_card', async (protocol, chatId) => {
      const rendered = await this.deps.cardRenderer.renderParsedCards(cards, attribution.agentName, attribution.model);
      const messageSeq = await this.sendSegments(target, chatId, rendered.segments, protocol);
      return { messageSeq, messageId: messageSeq, history: rendered.textForHistory };
    });
  }

  /**
   * Send a file. The upload is the send: Milky's upload_group_file /
   * upload_private_file post the file to the chat themselves, and Milky rejects
   * an outgoing `file` segment, so nothing follows the upload. `root` bounds
   * which files may leave the machine: the path is resolved through symlinks
   * and must stay inside it.
   */
  async sendFile(
    target: DeliveryTarget,
    path: string,
    options: { root: string; maxBytes: number; fileName?: string },
  ): Promise<DeliveryResult> {
    const checked = await this.checkFile(path, options.root, options.maxBytes);
    if ('error' in checked) {
      return { success: false, error: checked.error };
    }
    const fileName = options.fileName || basename(checked.path);
    return this.deliver(target, 'coding_agent_file', async (protocol, chatId) => {
      const fileUri = `base64://${(await readFile(checked.path)).toString('base64')}`;
      if (target.type === 'group') {
        await this.deps.fileAPI.uploadGroupFile(chatId, fileUri, fileName, protocol, FILE_UPLOAD_TIMEOUT_MS);
      } else {
        await this.deps.fileAPI.uploadPrivateFile(chatId, fileUri, fileName, protocol, FILE_UPLOAD_TIMEOUT_MS);
      }
      const sizeKb = Math.ceil(checked.size / 1024);
      return { history: `[文件] ${fileName} (${sizeKb} KB)` };
    });
  }

  private async checkFile(
    path: string,
    root: string,
    maxBytes: number,
  ): Promise<{ path: string; size: number } | { error: string }> {
    let resolved: string;
    let resolvedRoot: string;
    try {
      [resolved, resolvedRoot] = await Promise.all([realpath(path), realpath(root)]);
    } catch {
      return { error: `文件不存在: ${path}` };
    }
    if (!resolved.startsWith(resolvedRoot + sep)) {
      return { error: `只能发送工作区 ${root} 内的文件` };
    }
    const info = await stat(resolved);
    if (!info.isFile()) {
      return { error: `不是普通文件: ${path}（目录请先打包成压缩包）` };
    }
    if (info.size > maxBytes) {
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      return { error: `文件 ${mb(info.size)} MB 超过上限 ${mb(maxBytes)} MB` };
    }
    return { path: resolved, size: info.size };
  }

  private async sendSegments(
    target: DeliveryTarget,
    chatId: number,
    message: string | unknown[],
    protocol: ProtocolName,
  ): Promise<number> {
    return target.type === 'user'
      ? this.deps.messageAPI.sendPrivateMessage(chatId, message, protocol)
      : this.deps.messageAPI.sendGroupMessage(chatId, message, protocol);
  }

  private async deliver(
    target: DeliveryTarget,
    viaTool: string,
    send: (
      protocol: ProtocolName,
      chatId: number,
      selfId: number,
    ) => Promise<{ messageSeq?: number; messageId?: number; history: string }>,
  ): Promise<DeliveryResult> {
    const { protocol, selfId } = this.bot();
    if (!protocol) {
      return { success: false, error: 'No protocol available' };
    }
    const chatId = Number(target.id);
    if (Number.isNaN(chatId)) {
      return { success: false, error: `Invalid target id: ${target.id}` };
    }
    try {
      const sent = await send(protocol, chatId, selfId);
      await this.deps.historyService.appendBotMessageToSession(
        { sessionType: target.type === 'group' ? 'group' : 'user', targetId: target.id },
        sent.history,
        protocol,
        { botUserId: selfId, messageSeq: sent.messageSeq, viaTool },
      );
      return { success: true, messageId: sent.messageId?.toString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[AgentDelivery] ${viaTool} to ${target.type}:${target.id} failed:`, error);
      return { success: false, error: message };
    }
  }
}
