// Card templates for rendering LLM responses as HTML cards

import { marked } from 'marked';
import type {
  CardData,
  ComparisonCardData,
  HighlightCardData,
  ImageCardData,
  InfoCardData,
  KnowledgeCardData,
  ListCardData,
  MarkdownCardData,
  ParagraphCardData,
  QACardData,
  QuoteCardData,
  StatsCardData,
  StepsCardData,
} from './cardTypes';

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

/** Allowed tags for AI-generated content HTML (whitelist) */
const ALLOWED_CONTENT_TAGS = new Set([
  'p',
  'strong',
  'em',
  'code',
  'pre',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'br',
]);

/**
 * Wider tag whitelist for markdown-rendered HTML. Adds headings 1/4-6, blockquote,
 * hr, strikethrough (del/s), task-list checkboxes, and anchor (href stripped via
 * sanitize). Inputs come from `marked.parse()` so structure is constrained but
 * we still defensively sanitize attributes.
 */
const ALLOWED_MARKDOWN_TAGS = new Set([
  ...ALLOWED_CONTENT_TAGS,
  'h1',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'hr',
  'del',
  's',
  'a',
  'input', // checkbox for task lists
]);

/**
 * Sanitize HTML from AI: keep only allowed tags and class="content-table" on table.
 * Removes script, style, and all other tags/attributes to prevent XSS.
 */
function sanitizeContentHtml(html: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }
  // Remove script and style blocks with their content
  let out = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  // Replace opening tags: allow only whitelisted tags; for table allow class="content-table"
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9]*)\s*([^>]*)>/g, (_, tagName, attrs) => {
    const lower = tagName.toLowerCase();
    if (!ALLOWED_CONTENT_TAGS.has(lower)) {
      return '';
    }
    if (lower === 'br') {
      return '<br>';
    }
    if (lower === 'table' && /class\s*=\s*["']content-table["']/i.test(attrs)) {
      return '<table class="content-table">';
    }
    return `<${lower}>`;
  });
  // Replace closing tags: allow only whitelisted (no closing for br)
  out = out.replace(/<\/([a-zA-Z][a-zA-Z0-9]*)>/g, (_, tagName) => {
    const lower = tagName.toLowerCase();
    if (!ALLOWED_CONTENT_TAGS.has(lower) || lower === 'br') {
      return '';
    }
    return `</${lower}>`;
  });
  return out;
}

/**
 * Q&A card template
 */
export function qaCard(data: QACardData): string {
  const question = escapeHtml(data.question);
  const answer = sanitizeContentHtml(data.answer);
  return `
    <div class="qa-card">
      <div class="question">
        <span class="q-icon">Q</span>
        <span>${question}</span>
      </div>
      <div class="answer">
        <span class="a-icon">A</span>
        <div class="answer-content">${answer}</div>
      </div>
    </div>
  `;
}

/**
 * List card template
 */
export function listCard(data: ListCardData): string {
  const title = escapeHtml(data.title);
  const emoji = data.emoji || '📋';
  const items = data.items
    .map(
      (item, i) => `
        <li>
          <span class="number">${i + 1}</span>
          <span>${sanitizeContentHtml(item)}</span>
        </li>
      `,
    )
    .join('');
  return `
    <div class="list-card">
      <h2>${emoji} ${title}</h2>
      <ul class="styled-list">
        ${items}
      </ul>
    </div>
  `;
}

/**
 * Info box card template
 */
export function infoCard(data: InfoCardData): string {
  const icons: Record<string, string> = {
    info: '💡',
    warning: '⚠️',
    success: '✅',
    tip: '💭',
  };
  const icon = icons[data.level] || '💡';
  const title = escapeHtml(data.title);
  const content = sanitizeContentHtml(data.content);
  return `
    <div class="info-box ${data.level}">
      <div class="info-header">
        <span class="icon">${icon}</span>
        <strong>${title}</strong>
      </div>
      <div class="info-content">${content}</div>
    </div>
  `;
}

/**
 * Comparison card template.
 * leftHeader/rightHeader are column headers (e.g. item names), not fixed labels.
 */
export function comparisonCard(data: ComparisonCardData): string {
  const title = escapeHtml(data.title);
  const leftHeader = escapeHtml(data.leftHeader);
  const rightHeader = escapeHtml(data.rightHeader);
  const rows = data.items
    .map((item) => {
      const label = escapeHtml(item.label);
      const leftContent = sanitizeContentHtml(item.left);
      const rightContent = item.right.trim() === '' ? '' : sanitizeContentHtml(item.right);
      const rightCellClass = rightContent === '' ? 'comparison-cell empty-cell' : 'comparison-cell right-cell';
      return `
          <div class="comparison-row">
            <div class="comparison-row-label">
              <span class="row-label-text">${label}</span>
            </div>
            <div class="comparison-cell left-cell">${leftContent}</div>
            <div class="${rightCellClass}">${rightContent}</div>
          </div>
        `;
    })
    .join('');
  return `
    <div class="comparison-card">
      <div class="comparison-card-title">🔍${title}</div>
      <div class="comparison-col-headers">
        <div></div>
        <div class="comparison-col-header left-header">${leftHeader}</div>
        <div class="comparison-col-header right-header">${rightHeader}</div>
      </div>
      <div class="comparison-rows">
        ${rows}
      </div>
    </div>
  `;
}

/**
 * Knowledge card template
 */
export function knowledgeCard(data: KnowledgeCardData): string {
  const term = escapeHtml(data.term);
  const definition = sanitizeContentHtml(data.definition);
  const examples = data.examples
    ? `
      <div class="examples">
        <div class="examples-title"><span class="icon">📝</span>实际应用举例</div>
        <ul>
          ${data.examples.map((ex) => `<li>${sanitizeContentHtml(ex)}</li>`).join('')}
        </ul>
      </div>
    `
    : '';
  return `
    <div class="knowledge-card">
      <div class="term-header">
        <span class="term-icon">📖</span>
        <h2>${term}</h2>
      </div>
      <div class="definition">${definition}</div>
      ${examples}
    </div>
  `;
}

/**
 * Stats card template
 */
export function statsCard(data: StatsCardData): string {
  const title = escapeHtml(data.title);
  const stats = data.data
    .map(
      (item) => `
        <div class="stat-item ${item.highlight ? 'highlight' : ''}">
          <div class="stat-value">${escapeHtml(item.value)}</div>
          <div class="stat-label">${escapeHtml(item.label)}</div>
        </div>
      `,
    )
    .join('');
  return `
    <div class="stats-card">
      <h2>${title}</h2>
      <div class="stats-grid">
        ${stats}
      </div>
    </div>
  `;
}

/**
 * Quote card template (citation / key sentence)
 */
export function quoteCard(data: QuoteCardData): string {
  const text = sanitizeContentHtml(data.text);
  const source = data.source ? `<div class="quote-source">${escapeHtml(data.source)}</div>` : '';
  return `
    <div class="quote-card">
      <blockquote class="quote-text">${text}</blockquote>
      ${source}
    </div>
  `;
}

/**
 * Steps card template (ordered steps / timeline)
 */
export function stepsCard(data: StepsCardData): string {
  const title = escapeHtml(data.title);
  const stepsHtml = data.steps
    .map(
      (step, i) => `
        <li class="step-item">
          <span class="step-number">${i + 1}</span>
          <span class="step-content">${sanitizeContentHtml(step)}</span>
        </li>
      `,
    )
    .join('');
  return `
    <div class="steps-card">
      <h2 class="steps-title">${title}</h2>
      <ol class="steps-list">
        ${stepsHtml}
      </ol>
    </div>
  `;
}

/**
 * Highlight card template (single conclusion / takeaway)
 */
export function highlightCard(data: HighlightCardData): string {
  const title = escapeHtml(data.title);
  const summary = sanitizeContentHtml(data.summary);
  const detail = data.detail ? `<div class="highlight-detail">${sanitizeContentHtml(data.detail)}</div>` : '';
  return `
    <div class="highlight-card">
      <h2 class="highlight-title">${title}</h2>
      <div class="highlight-summary">${summary}</div>
      ${detail}
    </div>
  `;
}

/**
 * Paragraph block template (natural text, not a structured card)
 */
export function paragraphCard(data: ParagraphCardData): string {
  const content = sanitizeContentHtml(data.content);
  return `
    <div class="paragraph-block">${content}</div>
  `;
}

/**
 * Sanitize markdown-rendered HTML: keep markdown-output tags, drop everything else.
 * Attributes are stripped except `href` on anchors (http/https only) and the
 * `class="task-list-item"` / `disabled checked` shape on task-list inputs.
 */
function sanitizeMarkdownHtml(html: string): string {
  if (!html || typeof html !== 'string') return '';
  let out = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9]*)\s*([^>]*)>/g, (_, tagName, attrs) => {
    const lower = tagName.toLowerCase();
    if (!ALLOWED_MARKDOWN_TAGS.has(lower)) return '';
    if (lower === 'br' || lower === 'hr') return `<${lower}>`;
    if (lower === 'a') {
      const hrefMatch = /href\s*=\s*["']([^"']+)["']/i.exec(attrs);
      const href = hrefMatch?.[1] ?? '';
      if (/^https?:\/\//i.test(href)) {
        return `<a href="${escapeHtml(href)}">`;
      }
      return '<a>';
    }
    if (lower === 'input') {
      // Only allow disabled task-list checkboxes that marked emits.
      const isCheckbox = /type\s*=\s*["']checkbox["']/i.test(attrs);
      if (!isCheckbox) return '';
      const checked = /checked/i.test(attrs) ? ' checked' : '';
      return `<input type="checkbox" disabled${checked}>`;
    }
    if (lower === 'code' && /class\s*=\s*["']language-[\w-]+["']/i.test(attrs)) {
      const m = /class\s*=\s*["'](language-[\w-]+)["']/i.exec(attrs);
      return `<code class="${m?.[1] ?? ''}">`;
    }
    return `<${lower}>`;
  });
  out = out.replace(/<\/([a-zA-Z][a-zA-Z0-9]*)>/g, (_, tagName) => {
    const lower = tagName.toLowerCase();
    if (!ALLOWED_MARKDOWN_TAGS.has(lower) || lower === 'br' || lower === 'hr' || lower === 'input') return '';
    return `</${lower}>`;
  });
  return out;
}

/**
 * Markdown block template — parses GFM markdown to HTML, sanitizes it, and wraps
 * in a typographic container. Bypasses the LLM card-format conversion entirely.
 */
export function markdownCard(data: MarkdownCardData): string {
  const html = marked.parse(data.content, { gfm: true, breaks: false, async: false }) as string;
  const sanitized = sanitizeMarkdownHtml(html);
  const titleHtml = data.title ? `<h1 class="md-title">${escapeHtml(data.title)}</h1>` : '';
  return `
    <div class="markdown-card">
      ${titleHtml}
      <div class="md-content">${sanitized}</div>
    </div>
  `;
}

/**
 * Image block template (single image, base64 data URI)
 */
export function imageCard(data: ImageCardData): string {
  const alt = data.alt ? escapeHtml(data.alt) : '';
  return `
    <div class="image-block">
      <img src="${data.src}" alt="${alt}" />
    </div>
  `;
}

/**
 * Render card data to HTML
 */
export function renderCard(data: CardData): string {
  switch (data.type) {
    case 'qa':
      return qaCard(data);
    case 'list':
      return listCard(data);
    case 'info':
      return infoCard(data);
    case 'comparison':
      return comparisonCard(data);
    case 'knowledge':
      return knowledgeCard(data);
    case 'stats':
      return statsCard(data);
    case 'quote':
      return quoteCard(data);
    case 'steps':
      return stepsCard(data);
    case 'highlight':
      return highlightCard(data);
    case 'paragraph':
      return paragraphCard(data);
    case 'image':
      return imageCard(data);
    case 'markdown':
      return markdownCard(data);
    default:
      throw new Error(`Unknown card type: ${(data as { type: string }).type}`);
  }
}

/**
 * Render multiple cards to HTML (deck). Each card is wrapped in .card-inner for consistent layout.
 */
export function renderCardDeck(cards: CardData[]): string {
  if (cards.length === 0) {
    throw new Error('Card deck must not be empty');
  }
  return cards
    .map((card) => {
      // Paragraph blocks render directly in the container without .card-inner wrapper
      if (card.type === 'paragraph') {
        return renderCard(card);
      }
      return `<div class="card-inner">${renderCard(card)}</div>`;
    })
    .join('\n');
}
