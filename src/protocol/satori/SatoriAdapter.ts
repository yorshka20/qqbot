// Satori protocol adapter implementation

import type { ProtocolName } from '@/core/config';
import type { BaseEvent } from '../base/types';
import { WebSocketProtocolAdapter } from '../base/WebSocketProtocolAdapter';
import type { SatoriEvent } from './types';

export class SatoriAdapter extends WebSocketProtocolAdapter {
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
