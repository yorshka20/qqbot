// Discord connection - extends Connection to satisfy ConnectionManager's contract.
// Overrides connect()/disconnect() to manage discord.js Client lifecycle internally.
// ConnectionManager treats this identically to any other Connection — no special cases needed.

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { ProtocolConfig } from '@/core/config';
import { Connection } from '@/core/connection';
import { logger } from '@/utils/logger';

/** Map string intent names from config to discord.js GatewayIntentBits flags. */
const INTENT_MAP: Record<string, number> = {
  Guilds: GatewayIntentBits.Guilds,
  GuildMembers: GatewayIntentBits.GuildMembers,
  GuildMessages: GatewayIntentBits.GuildMessages,
  GuildMessageReactions: GatewayIntentBits.GuildMessageReactions,
  DirectMessages: GatewayIntentBits.DirectMessages,
  MessageContent: GatewayIntentBits.MessageContent,
};

export class DiscordConnection extends Connection {
  private client: Client;

  constructor(config: ProtocolConfig) {
    super(config);

    const intentNames = config.discord?.intents ?? ['Guilds', 'GuildMessages', 'MessageContent', 'DirectMessages'];
    const intents = intentNames.map((name) => INTENT_MAP[name]).filter((v): v is number => v != null);

    this.client = new Client({
      intents,
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
  }

  /** Returns the discord.js Client for use by DiscordAdapter. */
  getClient(): Client {
    return this.client;
  }

  /**
   * Override: login to Discord Gateway via discord.js.
   * Emits 'open' on success — ConnectionManager picks it up via the standard flow.
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.setState('connecting');

    const token = this.config.connection.accessToken;
    if (!token) {
      this.setState('disconnected');
      throw new Error('Discord bot token is not configured (connection.accessToken)');
    }

    this.client.once('clientReady', () => {
      logger.info(`[DiscordConnection] Connected as ${this.client.user?.tag}`);
      this.setState('connected');
      this.emit('open');
    });

    this.client.on('error', (error) => {
      logger.error(`[DiscordConnection] Client error: ${error.message}`);
      this.emit('error', error);
    });

    await this.client.login(token);
  }

  /** Override: destroy discord.js Client. */
  disconnect(): void {
    this.client.destroy();
    this.setState('disconnected');
    this.emit('close');
  }
}
