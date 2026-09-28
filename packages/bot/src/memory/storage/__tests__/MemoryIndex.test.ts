import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { RetrievalService } from '@/services/retrieval/RetrievalService';
import type { RAGDocument } from '@/services/retrieval/rag/types';
import { type IndexedFact, MemoryIndex } from '../MemoryIndex';

const GROUP = '100000001';
const USER = '10000001';
const OTHER_USER = '10000002';
const MODEL = 'test-embed';

interface Point {
  id: string;
  payload: Record<string, unknown>;
}

function fakeRag(points: Point[]) {
  const calls = { upserted: [] as RAGDocument[], relabelled: [] as string[][], removed: [] as string[] };
  const matches = (point: Point, filter?: Record<string, unknown>) =>
    ((filter?.must as Array<{ key: string; match: { value: unknown } }>) ?? []).every(
      (condition) => point.payload[condition.key] === condition.match.value,
    );
  const rag = {
    isEnabled: () => true,
    embeddingModel: MODEL,
    async *scrollAll(_collection: string, options: { filter?: Record<string, unknown> }) {
      yield points.filter((point) => matches(point, options.filter));
    },
    upsertDocuments: async (_collection: string, documents: RAGDocument[]) => {
      calls.upserted.push(...documents);
    },
    setPayload: async (_collection: string, ids: string[], payload: Record<string, unknown>) => {
      calls.relabelled.push(ids);
      expect(payload).toEqual({ source: 'auto' });
    },
    deleteByIds: async (_collection: string, ids: string[]) => {
      calls.removed.push(...ids);
    },
  };
  const index = new MemoryIndex({ getRAGService: () => rag } as unknown as RetrievalService);
  return { index, calls };
}

function fact(id: string, userId: string, content: string): IndexedFact {
  return { id, groupId: GROUP, userId, scope: 'identity:work', content };
}

function point(id: string, userId: string, content: string, source?: string): Point {
  return {
    id,
    payload: { userId, scope: 'identity:work', content, embedModel: MODEL, ...(source ? { source } : {}) },
  };
}

describe('MemoryIndex.reconcile', () => {
  it('holds exactly both sources: upserts what changed, labels unlabelled points, drops the rest', async () => {
    const { index, calls } = fakeRag([
      point('auto-same', USER, '做前端开发'),
      point('auto-old', USER, '做后端开发', 'auto'),
      point('manual-gone', USER, '爱吃甜食', 'manual'),
    ]);

    const result = await index.reconcile(GROUP, {
      auto: [fact('auto-same', USER, '做前端开发'), fact('auto-old', USER, '做全栈开发')],
      manual: [fact('manual-new', USER, '不吃辣')],
    });

    expect(result).toEqual({ upserted: 2, removed: 1 });
    expect(calls.upserted.map((d) => [d.id, d.payload?.source])).toEqual([
      ['auto-old', 'auto'],
      ['manual-new', 'manual'],
    ]);
    expect(calls.relabelled).toEqual([['auto-same']]);
    expect(calls.removed).toEqual(['manual-gone']);
  });
});

describe('MemoryIndex.reconcileManualSlot', () => {
  it("touches only the slot's manual points", async () => {
    const { index, calls } = fakeRag([
      point('auto-1', USER, '做前端开发', 'auto'),
      point('manual-keep', USER, '做前端开发', 'manual'),
      point('manual-gone', USER, '爱吃甜食', 'manual'),
      point('other-manual', OTHER_USER, '爱吃甜食', 'manual'),
    ]);

    const result = await index.reconcileManualSlot(GROUP, USER, [
      fact('manual-keep', USER, '做前端开发'),
      fact('manual-new', USER, '不吃辣'),
    ]);

    expect(result).toEqual({ upserted: 1, removed: 1 });
    expect(calls.upserted.map((d) => d.id)).toEqual(['manual-new']);
    expect(calls.removed).toEqual(['manual-gone']);
    expect(calls.relabelled).toEqual([]);
  });
});
