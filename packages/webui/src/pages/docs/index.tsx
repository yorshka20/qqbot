/**
 * Docs preview — read-only browse of repo `docs/`, `claude-learnings/`, and `claude-workbook/` (monorepo root).
 * Uses shared StaticServer (`VITE_STATIC_SERVER_BASE`) so you can read host docs from a remote machine.
 */

import { useEffect, useMemo, useState } from 'react';

import { listDocsRoots } from '../../api';
import type { DocsRootInfo } from '../../types';
import { DocPreview } from './components/DocPreview';
import { DocsBreadcrumb } from './components/DocsBreadcrumb';
import { DocsFileList } from './components/DocsFileList';
import { useDirListing } from './hooks/useDirListing';
import { useDocPreview } from './hooks/useDocPreview';
import type { SelectedDoc } from './utils';

export function DocsPage() {
  const [roots, setRoots] = useState<DocsRootInfo[] | null>(null);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [rootId, setRootId] = useState<string>('docs');
  const [dirPath, setDirPath] = useState('');
  const [selected, setSelected] = useState<SelectedDoc | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await listDocsRoots();
        if (cancelled) return;
        setRoots(data.roots);
        setRootsError(null);
        const firstOk = data.roots.find((r) => r.exists);
        if (firstOk) {
          setRootId(firstOk.id);
        }
      } catch (e) {
        if (!cancelled) {
          setRootsError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const currentRoot = useMemo(() => roots?.find((r) => r.id === rootId), [roots, rootId]);
  const listing = useDirListing(roots, rootId, dirPath);
  const preview = useDocPreview(rootId, selected, currentRoot?.exists ?? false);

  const openRoot = (id: string) => {
    setRootId(id);
    setDirPath('');
    setSelected(null);
  };

  const openDir = (path: string) => {
    setDirPath(path);
    setSelected(null);
  };

  return (
    <div className="flex flex-1 min-h-0">
      <div className="w-[min(100%,380px)] shrink-0 border-r border-zinc-200 dark:border-zinc-700 flex flex-col bg-white dark:bg-zinc-800">
        <div className="p-3 border-b border-zinc-200 dark:border-zinc-700 space-y-2">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">文档根目录</h2>
          <select
            value={rootId}
            onChange={(e) => openRoot(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
          >
            {(roots ?? []).map((r) => (
              <option key={r.id} value={r.id} disabled={!r.exists}>
                {r.label}
                {!r.exists ? ' (不存在)' : ''}
              </option>
            ))}
          </select>
          {rootsError && <p className="text-xs text-red-600 dark:text-red-400">{rootsError}</p>}
          {currentRoot && (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 font-mono break-all" title={currentRoot.absPath}>
              {currentRoot.absPath}
            </p>
          )}
        </div>

        <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 text-xs text-zinc-600 dark:text-zinc-400">
          <DocsBreadcrumb rootId={rootId} dirPath={dirPath} onNavigate={openDir} />
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-2">
          <DocsFileList
            loading={roots === null || listing.loading}
            error={listing.error}
            rootExists={currentRoot?.exists ?? false}
            items={listing.items}
            selectedPath={selected?.path ?? null}
            onOpenDir={openDir}
            onSelectFile={setSelected}
          />
        </div>
      </div>

      <DocPreview rootId={rootId} selected={selected} preview={preview} />
    </div>
  );
}
