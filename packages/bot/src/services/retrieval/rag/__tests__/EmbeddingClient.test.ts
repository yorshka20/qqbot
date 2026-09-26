import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { EmbeddingClient } from '../EmbeddingClient';

// A local stand-in for an OpenAI-compatible /embeddings endpoint.
let server: ReturnType<typeof Bun.serve>;
const requests: Array<{ auth: string | null; input: string[] }> = [];
let failuresBeforeSuccess = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { input: string[] };
      requests.push({ auth: req.headers.get('authorization'), input: body.input });
      if (failuresBeforeSuccess > 0) {
        failuresBeforeSuccess--;
        return new Response('rate limited', { status: 429 });
      }
      // Answer out of order: the client must place vectors by `index`.
      const data = body.input.map((text, index) => ({ index, embedding: [text.length, 0] })).reverse();
      return Response.json({ data });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

function client(batchSize: number): EmbeddingClient {
  return new EmbeddingClient({ url: `http://localhost:${server.port}/v1/`, apiKey: 'sk-test', model: 'm', batchSize });
}

describe('EmbeddingClient', () => {
  it('batches, authenticates, and returns normalized vectors in input order', async () => {
    requests.length = 0;
    const vectors = await client(2).embed(['a', 'bb', 'ccc']);
    expect(requests.map((r) => r.input)).toEqual([['a', 'bb'], ['ccc']]);
    expect(requests[0].auth).toBe('Bearer sk-test');
    expect(vectors).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
  });

  it('retries a rate-limited request', async () => {
    requests.length = 0;
    failuresBeforeSuccess = 1;
    const vectors = await client(8).embed(['x']);
    expect(requests).toHaveLength(2);
    expect(vectors).toHaveLength(1);
  });
});
