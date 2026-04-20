/**
 * Docs preview — read-only browse of repo `docs/`, `~/.claude/learnings`, and `~/.claude/workbook`.
 * Uses shared StaticServer (`VITE_STATIC_SERVER_BASE`) so you can read host docs from a remote machine.
 */

import { FileText, Folder, Loader2 } from 'lucide-react';
import { marked } from 'marked';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { docsRawUrl, listDocs, listDocsRoots } from '../../api';
import type { DocsRootInfo, FileItem } from '../../types';

marked.setOptions({ breaks: true, gfm: true });

function previewMode(contentType: string, filename: string): 'markdown' | 'text' | 'image' | 'pdf' | 'binary' {
  const lower = filename.toLowerCase();
  const ct = contentType.toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('markdown') || lower.endsWith('.md')) return 'markdown';
  if (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('typescript') ||
    ct.includes('javascript') ||
    lower.endsWith('.jsonc')
  ) {
    return 'text';
  }
  return 'binary';
}

export function DocsPage() {
  const [roots, setRoots] = useState<DocsRootInfo[] | null>(null);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [rootId, setRootId] = useState<string>('docs');
  const [dirPath, setDirPath] = useState('');
  const [items, setItems] = useState<FileItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selected, setSelected] = useState<{ path: string; name: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [blobKind, setBlobKind] = useState<'image' | 'pdf' | 'binary' | null>(null);

  const revokeBlob = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setBlobKind(null);
  }, []);

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

  const loadDir = useCallback(async () => {
    if (roots === null) {
      return;
    }
    const meta = roots.find((r) => r.id === rootId);
    if (!meta?.exists) {
      setItems([]);
      setListError(null);
      return;
    }
    setListLoading(true);
    setListError(null);
    try {
      const data = await listDocs(rootId, dirPath);
      setItems(data.items);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setListLoading(false);
    }
  }, [roots, rootId, dirPath]);

  useEffect(() => {
    loadDir();
  }, [loadDir]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: clear selection when changing root or folder
  useEffect(() => {
    setSelected(null);
    revokeBlob();
    setPreviewHtml(null);
    setPreviewText(null);
    setPreviewError(null);
  }, [rootId, dirPath, revokeBlob]);

  useEffect(() => {
    if (!selected || !currentRoot?.exists) {
      revokeBlob();
      setPreviewHtml(null);
      setPreviewText(null);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    (async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      setPreviewHtml(null);
      setPreviewText(null);
      revokeBlob();

      try {
        const res = await fetch(docsRawUrl(rootId, selected.path));
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const ct = res.headers.get('content-type') ?? '';
        const mode = previewMode(ct, selected.name);

        if (mode === 'image' || mode === 'pdf') {
          const blob = await res.blob();
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          blobUrlRef.current = url;
          setBlobKind(mode);
          return;
        }

        if (mode === 'markdown') {
          const text = await res.text();
          if (cancelled) return;
          const html = marked.parse(text, { breaks: true, gfm: true });
          setPreviewHtml(typeof html === 'string' ? html : '');
          return;
        }

        if (mode === 'text') {
          const text = await res.text();
          if (cancelled) return;
          setPreviewText(text);
          return;
        }

        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setBlobKind('binary');
      } catch (e) {
        if (!cancelled) {
          setPreviewError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected, rootId, currentRoot?.exists, revokeBlob]);

  useEffect(() => {
    return () => revokeBlob();
  }, [revokeBlob]);

  const navigateBreadcrumb = (path: string) => {
    setDirPath(path);
    setSelected(null);
  };

  const segments = dirPath ? dirPath.split('/').filter(Boolean) : [];

  return (
    <div className="flex flex-1 min-h-0">
      <div className="w-[min(100%,380px)] shrink-0 border-r border-zinc-200 dark:border-zinc-700 flex flex-col bg-white dark:bg-zinc-800">
        <div className="p-3 border-b border-zinc-200 dark:border-zinc-700 space-y-2">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">文档根目录</h2>
          <select
            value={rootId}
            onChange={(e) => {
              setRootId(e.target.value);
              setDirPath('');
              setSelected(null);
            }}
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
          <nav className="flex flex-wrap items-center gap-1" aria-label="路径">
            <button
              type="button"
              className="rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-700"
              onClick={() => navigateBreadcrumb('')}
            >
              {rootId}
            </button>
            {segments.map((seg, i) => {
              const full = segments.slice(0, i + 1).join('/');
              const isLast = i === segments.length - 1;
              return (
                <span key={full} className="flex items-center gap-1">
                  <span className="text-zinc-400">/</span>
                  {isLast ? (
                    <span className="text-zinc-900 dark:text-zinc-100 font-medium">{seg}</span>
                  ) : (
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                      onClick={() => navigateBreadcrumb(full)}
                    >
                      {seg}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-2">
          {roots === null || listLoading ? (
            <div className="flex justify-center py-8 text-zinc-500">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : (
            <>
              {listError && <p className="text-sm text-red-600 dark:text-red-400 px-2">{listError}</p>}
              {!listError && currentRoot && !currentRoot.exists && (
                <p className="text-sm text-zinc-500 px-2">该路径在磁盘上不存在。</p>
              )}
              {!listError && currentRoot?.exists && items.length === 0 && (
                <p className="text-sm text-zinc-500 px-2">空目录</p>
              )}
              {!listError && currentRoot?.exists && (
                <ul className="space-y-0.5">
                  {items.map((it) => (
                    <li key={it.path}>
                      {it.isDir ? (
                        <button
                          type="button"
                          className="w-full flex items-center gap-2 text-left rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-700"
                          onClick={() => {
                            setDirPath(it.path);
                            setSelected(null);
                          }}
                        >
                          <Folder className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-500" />
                          <span className="truncate">{it.name}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={`w-full flex items-center gap-2 text-left rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-700 ${
                            selected?.path === it.path ? 'bg-zinc-100 dark:bg-zinc-700' : ''
                          }`}
                          onClick={() => setSelected({ path: it.path, name: it.name })}
                        >
                          <FileText className="w-4 h-4 shrink-0 text-zinc-400" />
                          <span className="truncate">{it.name}</span>
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col bg-zinc-50 dark:bg-zinc-900">
        <div className="shrink-0 px-4 py-2 border-b border-zinc-200 dark:border-zinc-700 text-sm text-zinc-600 dark:text-zinc-400">
          {selected ? selected.name : '选择左侧文件以预览'}
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-4">
          {!selected && <p className="text-sm text-zinc-500">只读预览；支持 Markdown、文本、图片与 PDF。</p>}
          {selected && previewLoading && (
            <div className="flex justify-center py-16 text-zinc-500">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
          )}
          {selected && previewError && <p className="text-sm text-red-600 dark:text-red-400">{previewError}</p>}
          {selected && !previewLoading && !previewError && previewHtml !== null && (
            <article
              className="prose prose-zinc dark:prose-invert max-w-none prose-pre:bg-zinc-100 dark:prose-pre:bg-zinc-800"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown from local docs API on trusted host
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          )}
          {selected && !previewLoading && !previewError && previewText !== null && (
            <pre className="text-xs whitespace-pre-wrap font-mono bg-white dark:bg-zinc-800 rounded-lg p-4 border border-zinc-200 dark:border-zinc-700 overflow-x-auto">
              {previewText}
            </pre>
          )}
          {selected && !previewLoading && !previewError && blobUrlRef.current && blobKind === 'image' && (
            <img
              src={blobUrlRef.current}
              alt={selected.name}
              className="max-w-full max-h-[calc(100vh-8rem)] object-contain mx-auto"
            />
          )}
          {selected && !previewLoading && !previewError && blobUrlRef.current && blobKind === 'pdf' && (
            <iframe
              title={selected.name}
              src={blobUrlRef.current}
              className="w-full min-h-[calc(100vh-10rem)] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white"
            />
          )}
          {selected && !previewLoading && !previewError && blobUrlRef.current && blobKind === 'binary' && (
            <div className="space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
              <p>无法内联预览此文件类型。</p>
              <a
                href={blobUrlRef.current}
                download={selected.name}
                className="text-blue-600 dark:text-blue-400 font-medium hover:underline"
              >
                下载
              </a>
              <a
                href={docsRawUrl(rootId, selected.path)}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-blue-600 dark:text-blue-400 hover:underline"
              >
                在新标签页打开（同源 URL）
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
