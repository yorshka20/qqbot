// Parse "链接: <url>" from proactive chunk string (from resultsToChunks format).

/** Match 链接: or 链接： (fullwidth colon) followed by URL. */
const LINK_REGEX = /链接[：:]\s*(https?:\/\/[^\s\n]+)/g;

/** Trim trailing punctuation that may be captured from surrounding text. */
function trimUrl(url: string): string {
  return url.trim().replace(/[.,;，。；)\]]+$/, '');
}

/**
 * Extract URLs from chunk strings. Each chunk is like:
 * "**title**\n摘要: ...\n链接: https://..."
 * Returns unique URLs in order of first appearance.
 * Uses a new RegExp per chunk to avoid global regex lastIndex leaking across strings.
 */
export function extractUrlsFromChunks(chunks: string[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const chunk of chunks) {
    const re = new RegExp(LINK_REGEX.source, 'g');
    let m = re.exec(chunk);
    while (m !== null) {
      const url = trimUrl(m[1]);
      if (url && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
      m = re.exec(chunk);
    }
  }
  return urls;
}

/**
 * Extract entries { url, title, snippet } from chunk strings (resultsToChunks format).
 * Title is the text inside **...** on the first line; 摘要: line for snippet; 链接: or 链接： for url.
 */
export function extractEntriesFromChunks(chunks: string[]): Array<{ url: string; title: string; snippet?: string }> {
  const entries: Array<{ url: string; title: string; snippet?: string }> = [];
  for (const chunk of chunks) {
    const titleMatch = chunk.match(/^\*\*([^*]+)\*\*/m);
    const snippetMatch = chunk.match(/摘要:\s*([\s\S]*?)(?=\n链接[：:]|$)/m);
    const linkMatch = chunk.match(/链接[：:]\s*(https?:\/\/[^\s\n]+)/);
    const title = (titleMatch?.[1] ?? '无标题').trim();
    const snippet = snippetMatch?.[1]?.trim();
    const rawUrl = linkMatch?.[1]?.trim();
    const url = rawUrl ? trimUrl(rawUrl) : '';
    if (url) {
      entries.push({ url, title, snippet });
    }
  }
  return entries;
}
