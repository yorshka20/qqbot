// Satori protocol adapter implementation

import type { ProtocolConfig, ProtocolName } from '@/core/config';
import { Connection } from '@/core/Connection';
import { ProtocolAdapter } from '../base/ProtocolAdapter';
import type { BaseEvent } from '../base/types';
import type { SatoriEvent } from './types';

export class SatoriAdapter extends ProtocolAdapter {
  constructor(config: ProtocolConfig, connection: Connection) {
    super(config, connection);
  }

  getProtocolName(): ProtocolName {
    return 'satori';
  }

  normalizeEvent(rawEvent: unknown): BaseEvent | null {
    if (typeof rawEvent !== 'object' || rawEvent === null) {
      return null;
    }

    const event = rawEvent as SatoriEvent;

    // Check if it's a Satori event
    if (!('type' in event) || !('id' in event)) {
      return null;
    }

    const baseEvent: BaseEvent = {
      id: event.id,
      type: event.type,
      timestamp: event.timestamp || Date.now(),
      protocol: 'satori',
    };

    // Return base event with additional properties from Satori event
    return {
      ...baseEvent,
      ...event,
    };
  }
}
