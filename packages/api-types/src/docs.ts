// `/api/docs` — read-only docs preview.

import type { FileItem } from './files';

export interface DocsRootInfo {
  id: string;
  label: string;
  /** Absolute path on disk, for display and debugging. */
  absPath: string;
  exists: boolean;
}

/** `GET /api/docs/roots` */
export interface DocsRootsResponse {
  roots: DocsRootInfo[];
}

/** `GET /api/docs/list` */
export interface DocsListResponse {
  items: FileItem[];
}
