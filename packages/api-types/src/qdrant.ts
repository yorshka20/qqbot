// `/api/qdrant` — Qdrant collection explorer.

export interface QdrantCollectionInfo {
  name: string;
  pointsCount: number;
  vectorSize: number;
  distance: string;
}

/** `GET /api/qdrant/collections` */
export interface QdrantCollectionsResponse {
  collections: QdrantCollectionInfo[];
}

/** `GET /api/qdrant/collection/:name` */
export interface QdrantCollectionDetailResponse {
  info: QdrantCollectionInfo;
}

export interface QdrantSearchHit {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
}

/** `GET /api/qdrant/search` */
export interface QdrantSearchResponse {
  results: QdrantSearchHit[];
  query: string;
  collection: string;
}

/** `GET /api/qdrant/scroll` — one page only; `total` counts that page. */
export interface QdrantScrollResponse {
  points: Array<{ id: string | number; payload: Record<string, unknown> }>;
  total: number;
}
