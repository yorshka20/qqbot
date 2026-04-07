// Discord API converter - converts unified API actions to discord.js method calls

import { AttachmentBuilder, type Client, type TextChannel } from 'discord.js';
import { logger } from '@/utils/logger';
import { segmentsToDiscordMessage } from './DiscordSegmentConverter';

/**
 * Execute a unified API action using the discord.js Client.
 * Returns the result in a format compatible with the framework's expected response shape.
 */
export async function executeDiscordAPI(
  client: Client,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case 'send_group_msg':
    case 'send_group_message':
      return await sendChannelMessage(client, params);

    case 'send_private_msg':
    case 'send_private_message':
      return await sendPrivateMessage(client, params);

    case 'recall_group_message':
    case 'delete_msg':
      return await deleteMessage(client, params);

    case 'get_group_member_info':
      return await getGuildMemberInfo(client, params);

    case 'get_group_member_list':
      return await getGuildMemberList(client, params);

    case 'get_user_info':
    case 'get_stranger_info':
      return await getUserInfo(client, params);

    case 'upload_group_file':
      return await uploadChannelFile(client, params);

    case 'upload_private_file':
      return await uploadPrivateFile(client, params);

    default:
      logger.warn(`[DiscordAPIConverter] Unsupported action: ${action}`);
      throw new Error(`Discord protocol does not support action: ${action}`);
  }
}

async function sendChannelMessage(client: Client, params: Record<string, unknown>): Promise<{ message_id: string }> {
  const channelId = String(params.group_id ?? params.groupId ?? '');
  const channel = await client.channels.fetch(channelId);
  if (!channel || !('send' in channel)) {
    throw new Error(`Channel ${channelId} not found or is not a text channel`);
  }

  const textChannel = channel as TextChannel;
  const { content, files, replyTo } = buildMessageContent(params);

  const sentMessage = await textChannel.send({
    content: content || undefined,
    files,
    ...(replyTo ? { reply: { messageReference: replyTo } } : {}),
  });

  return { message_id: sentMessage.id };
}

async function sendPrivateMessage(client: Client, params: Record<string, unknown>): Promise<{ message_id: string }> {
  const userId = String(params.user_id ?? params.userId ?? '');
  const user = await client.users.fetch(userId);
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  const { content, files, replyTo } = buildMessageContent(params);

  const sentMessage = await user.send({
    content: content || undefined,
    files,
    ...(replyTo ? { reply: { messageReference: replyTo } } : {}),
  });

  return { message_id: sentMessage.id };
}

async function deleteMessage(client: Client, params: Record<string, unknown>): Promise<void> {
  const channelId = String(params.group_id ?? params.groupId ?? params.channel_id ?? '');
  const messageId = String(params.message_id ?? params.messageId ?? '');

  if (!channelId || !messageId) {
    throw new Error('delete_msg requires channel_id/group_id and message_id');
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !('messages' in channel)) {
    throw new Error(`Channel ${channelId} not found or is not a text channel`);
  }

  const textChannel = channel as TextChannel;
  const message = await textChannel.messages.fetch(messageId);
  await message.delete();
}

async function getGuildMemberInfo(client: Client, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const guildId = String(params.group_id ?? params.groupId ?? params.guild_id ?? '');
  const userId = String(params.user_id ?? params.userId ?? '');

  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId);

  return {
    user_id: member.id,
    nickname: member.displayName,
    card: member.nickname ?? '',
    role: member.roles.highest.name,
    join_time: member.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : 0,
  };
}

async function getGuildMemberList(
  client: Client,
  params: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const guildId = String(params.group_id ?? params.groupId ?? params.guild_id ?? '');
  const guild = await client.guilds.fetch(guildId);
  const members = await guild.members.fetch();

  return members.map((member) => ({
    user_id: member.id,
    nickname: member.displayName,
    card: member.nickname ?? '',
    role: member.roles.highest.name,
  }));
}

async function getUserInfo(client: Client, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const userId = String(params.user_id ?? params.userId ?? '');
  const user = await client.users.fetch(userId);

  return {
    user_id: user.id,
    nickname: user.displayName ?? user.username,
  };
}

function buildFileAttachment(params: Record<string, unknown>): AttachmentBuilder {
  const fileUri = String(params.file_uri ?? '');
  const fileName = String(params.file_name ?? 'file');

  if (fileUri.startsWith('base64://')) {
    const base64Data = fileUri.slice('base64://'.length);
    const buffer = Buffer.from(base64Data, 'base64');
    return new AttachmentBuilder(buffer, { name: fileName });
  }

  // file:// or http:// URLs
  const path = fileUri.startsWith('file://') ? fileUri.slice('file://'.length) : fileUri;
  return new AttachmentBuilder(path, { name: fileName });
}

async function uploadChannelFile(client: Client, params: Record<string, unknown>): Promise<{ file_id: string }> {
  const channelId = String(params.group_id ?? '');
  const channel = await client.channels.fetch(channelId);
  if (!channel || !('send' in channel)) {
    throw new Error(`Channel ${channelId} not found or is not a text channel`);
  }

  const attachment = buildFileAttachment(params);
  const sentMessage = await (channel as TextChannel).send({ files: [attachment] });
  return { file_id: sentMessage.id };
}

async function uploadPrivateFile(client: Client, params: Record<string, unknown>): Promise<{ file_id: string }> {
  const userId = String(params.user_id ?? '');
  const user = await client.users.fetch(userId);
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  const attachment = buildFileAttachment(params);
  const sentMessage = await user.send({ files: [attachment] });
  return { file_id: sentMessage.id };
}

function buildMessageContent(params: Record<string, unknown>): ReturnType<typeof segmentsToDiscordMessage> {
  // If message is a segment array, convert to Discord format
  if (Array.isArray(params.message)) {
    return segmentsToDiscordMessage(params.message as import('@/message/types').MessageSegment[]);
  }

  // If message is a plain string
  if (typeof params.message === 'string') {
    return { content: params.message, files: [] };
  }

  return { content: '', files: [] };
}
