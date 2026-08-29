import { useCallback, useEffect, useState } from 'react';

import { listDocs } from '../../../api';
import type { DocsRootInfo, FileItem } from '../../../types';
import { byNewestFirst } from '../utils';

export interface DirListingState {
  items: FileItem[];
  loading: boolean;
  error: string | null;
}

export function useDirListing(roots: DocsRootInfo[] | null, rootId: string, dirPath: string): DirListingState {
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (roots === null) {
      return;
    }
    const meta = roots.find((r) => r.id === rootId);
    if (!meta?.exists) {
      setItems([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await listDocs(rootId, dirPath);
      setItems([...data.items].sort(byNewestFirst));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [roots, rootId, dirPath]);

  useEffect(() => {
    load();
  }, [load]);

  return { items, loading, error };
}
