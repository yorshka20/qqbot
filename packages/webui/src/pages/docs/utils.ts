export type PreviewMode = 'markdown' | 'text' | 'image' | 'pdf' | 'binary';

export interface SelectedDoc {
  path: string;
  name: string;
}

export function previewMode(contentType: string, filename: string): PreviewMode {
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
