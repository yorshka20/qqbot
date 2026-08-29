import { Loader2 } from 'lucide-react';

import { docsRawUrl } from '../../../api';
import { DumpView } from '../dump/DumpView';
import type { DocPreviewState } from '../hooks/useDocPreview';
import type { SelectedDoc } from '../utils';

export function DocPreview({
  rootId,
  selected,
  preview,
}: {
  rootId: string;
  selected: SelectedDoc | null;
  preview: DocPreviewState;
}) {
  const { loading, error, html, text, dump, blobUrl, blobKind } = preview;

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-zinc-50 dark:bg-zinc-900">
      <div className="shrink-0 px-4 py-2 border-b border-zinc-200 dark:border-zinc-700 text-sm text-zinc-600 dark:text-zinc-400">
        {selected ? selected.name : '选择左侧文件以预览'}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {!selected && <p className="text-sm text-zinc-500">只读预览；支持 Markdown、文本、图片与 PDF。</p>}
        {selected && loading && (
          <div className="flex justify-center py-16 text-zinc-500">
            <Loader2 className="w-8 h-8 animate-spin" />
          </div>
        )}
        {selected && error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {selected && !loading && !error && dump !== null && <DumpView key={selected.path} dump={dump} />}
        {selected && !loading && !error && html !== null && (
          <article
            className="prose prose-zinc dark:prose-invert max-w-none prose-pre:bg-zinc-100 dark:prose-pre:bg-zinc-800 prose-pre:whitespace-pre-wrap prose-pre:break-words"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown from local docs API on trusted host
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {selected && !loading && !error && text !== null && (
          <pre className="text-xs whitespace-pre-wrap break-words font-mono bg-white dark:bg-zinc-800 rounded-lg p-4 border border-zinc-200 dark:border-zinc-700">
            {text}
          </pre>
        )}
        {selected && !loading && !error && blobUrl && blobKind === 'image' && (
          <img
            src={blobUrl}
            alt={selected.name}
            className="max-w-full max-h-[calc(100vh-8rem)] object-contain mx-auto"
          />
        )}
        {selected && !loading && !error && blobUrl && blobKind === 'pdf' && (
          <iframe
            title={selected.name}
            src={blobUrl}
            className="w-full min-h-[calc(100vh-10rem)] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white"
          />
        )}
        {selected && !loading && !error && blobUrl && blobKind === 'binary' && (
          <div className="space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
            <p>无法内联预览此文件类型。</p>
            <a
              href={blobUrl}
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
  );
}
