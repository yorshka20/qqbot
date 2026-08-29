import { marked } from 'marked';
import { useEffect, useState } from 'react';

import { docsRawUrl } from '../../../api';
import { type DumpFile, isLLMDump, parseDump } from '../dump/parseDump';
import { previewMode, type SelectedDoc } from '../utils';

marked.setOptions({ breaks: true, gfm: true });

export type BlobKind = 'image' | 'pdf' | 'binary';

export interface DocPreviewState {
  loading: boolean;
  error: string | null;
  html: string | null;
  text: string | null;
  dump: DumpFile | null;
  blobUrl: string | null;
  blobKind: BlobKind | null;
}

export function useDocPreview(rootId: string, selected: SelectedDoc | null, rootExists: boolean): DocPreviewState {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [dump, setDump] = useState<DumpFile | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobKind, setBlobKind] = useState<BlobKind | null>(null);

  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  useEffect(() => {
    setError(null);
    setHtml(null);
    setText(null);
    setDump(null);
    setBlobUrl(null);
    setBlobKind(null);

    if (!selected || !rootExists) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(docsRawUrl(rootId, selected.path));
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const ct = res.headers.get('content-type') ?? '';
        const mode = previewMode(ct, selected.name);

        if (mode === 'markdown') {
          const raw = await res.text();
          if (cancelled) return;
          if (isLLMDump(raw)) {
            setDump(parseDump(raw));
            return;
          }
          const parsed = marked.parse(raw, { breaks: true, gfm: true });
          setHtml(typeof parsed === 'string' ? parsed : '');
          return;
        }

        if (mode === 'text') {
          const raw = await res.text();
          if (cancelled) return;
          setText(raw);
          return;
        }

        const blob = await res.blob();
        if (cancelled) return;
        setBlobUrl(URL.createObjectURL(blob));
        setBlobKind(mode === 'binary' ? 'binary' : mode);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected, rootId, rootExists]);

  return { loading, error, html, text, dump, blobUrl, blobKind };
}
