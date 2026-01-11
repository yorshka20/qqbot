// Custom error classes

export class BotError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'BotError';
  }
}

export class ConnectionError extends BotError {
  constructor(message: string, public readonly protocol?: string) {
    super(message, 'CONNECTION_ERROR');
    this.name = 'ConnectionError';
  }
}

export class APIError extends BotError {
  constructor(
    message: string,
    public readonly action?: string,
    public readonly retcode?: number
  ) {
    super(message, 'API_ERROR');
    this.name = 'APIError';
  }
}

export class ProtocolError extends BotError {
  constructor(message: string, public readonly protocol?: string) {
    super(message, 'PROTOCOL_ERROR');
    this.name = 'ProtocolError';
  }
}

export class ConfigError extends BotError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}
