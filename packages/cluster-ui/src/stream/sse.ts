export interface SSEMessage {
  event: string;
  data: string;
}

/**
 * Incremental `text/event-stream` parser (WHATWG HTML §9.2). Network chunks split anywhere,
 * so everything after the last complete line stays buffered for the next `feed`.
 */
export class SSEParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];

  feed(chunk: string): SSEMessage[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r\n|\n|\r(?!$)/);
    this.buffer = lines.pop() ?? '';

    const messages: SSEMessage[] = [];
    for (const line of lines) {
      if (line === '') {
        if (this.data.length > 0) {
          messages.push({ event: this.event || 'message', data: this.data.join('\n') });
        }
        this.event = '';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) {
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') {
        this.event = value;
      } else if (field === 'data') {
        this.data.push(value);
      }
    }
    return messages;
  }
}
