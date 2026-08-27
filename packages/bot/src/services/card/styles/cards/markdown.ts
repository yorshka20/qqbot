// Markdown card. It carries its own typography scale instead of reusing the
// rich-text layer: its HTML comes from `marked`, so it can contain heading levels
// and block types the card templates never emit.

export const MARKDOWN_STYLES = `
  /* ===== Markdown card — typography-focused layout ===== */
  .markdown-card {
    color: #1f2937;
    font-size: 15px;
    line-height: 1.7;
    word-wrap: break-word;
  }
  .markdown-card .md-title {
    font-size: 24px;
    font-weight: 700;
    color: #111827;
    margin-bottom: 18px;
    padding-bottom: 12px;
    border-bottom: 2px solid var(--card-primary);
  }
  .markdown-card .md-content > *:first-child { margin-top: 0; }
  .markdown-card .md-content > *:last-child { margin-bottom: 0; }
  .markdown-card .md-content h1,
  .markdown-card .md-content h2,
  .markdown-card .md-content h3,
  .markdown-card .md-content h4,
  .markdown-card .md-content h5,
  .markdown-card .md-content h6 {
    color: #111827;
    font-weight: 700;
    line-height: 1.35;
    margin: 22px 0 10px;
  }
  .markdown-card .md-content h1 { font-size: 22px; }
  .markdown-card .md-content h2 { font-size: 20px; padding-bottom: 6px; border-bottom: 1px solid var(--card-hairline); }
  .markdown-card .md-content h3 { font-size: 18px; }
  .markdown-card .md-content h4 { font-size: 16px; }
  .markdown-card .md-content h5,
  .markdown-card .md-content h6 { font-size: 15px; color: #374151; }
  .markdown-card .md-content p {
    margin: 10px 0;
    color: #1f2937;
  }
  .markdown-card .md-content strong {
    color: #111827;
    font-weight: 700;
  }
  .markdown-card .md-content em { font-style: italic; color: #374151; }
  .markdown-card .md-content del,
  .markdown-card .md-content s {
    color: #9ca3af;
    text-decoration: line-through;
  }
  .markdown-card .md-content a {
    color: var(--card-primary);
    text-decoration: none;
    border-bottom: 1px dotted var(--card-primary);
  }
  .markdown-card .md-content ul,
  .markdown-card .md-content ol {
    margin: 10px 0;
    padding-left: 24px;
  }
  .markdown-card .md-content li {
    margin: 6px 0;
    color: #1f2937;
  }
  .markdown-card .md-content li > ul,
  .markdown-card .md-content li > ol {
    margin: 6px 0;
  }
  .markdown-card .md-content li > input[type="checkbox"] {
    margin-right: 6px;
    vertical-align: middle;
  }
  .markdown-card .md-content blockquote {
    margin: 14px 0;
    padding: 8px 16px;
    border-left: 4px solid var(--card-primary);
    background: #f9fafb;
    color: #4b5563;
    border-radius: 0 6px 6px 0;
  }
  .markdown-card .md-content blockquote p { margin: 4px 0; }
  .markdown-card .md-content hr {
    border: none;
    border-top: 1px solid var(--card-hairline);
    margin: 20px 0;
  }
  .markdown-card .md-content code {
    font-family: "JetBrains Mono", "Fira Code", "Consolas", "Monaco", monospace;
    font-size: 13.5px;
    background: #f3f4f6;
    color: #be185d;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .markdown-card .md-content pre {
    margin: 14px 0;
    padding: 14px 16px;
    background: #1f2937;
    color: #f9fafb;
    border-radius: 8px;
    overflow-x: auto;
    line-height: 1.55;
  }
  .markdown-card .md-content pre code {
    background: transparent;
    color: inherit;
    padding: 0;
    border-radius: 0;
    font-size: 13.5px;
    white-space: pre;
  }
  .markdown-card .md-content table {
    width: 100%;
    margin: 14px 0;
    border-collapse: collapse;
    font-size: 14px;
  }
  .markdown-card .md-content table th,
  .markdown-card .md-content table td {
    padding: 10px 14px;
    border: 1px solid var(--card-hairline);
    text-align: left;
    vertical-align: top;
  }
  .markdown-card .md-content table thead th {
    background: #f3f4f6;
    color: #111827;
    font-weight: 700;
  }
  .markdown-card .md-content table tbody tr:nth-child(even) td {
    background: #fafbfc;
  }
`;
