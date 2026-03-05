// Card templates for rendering LLM responses as HTML cards

import type {
  CardData,
  ComparisonCardData,
  InfoCardData,
  KnowledgeCardData,
  ListCardData,
  QACardData,
  StatsCardData,
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
 * Comparison card template (pros/cons style with left=positive, right=negative)
 */
export function comparisonCard(data: ComparisonCardData): string {
  const title = escapeHtml(data.title);
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
      <div class="comparison-card-title">${title}</div>
      <div class="comparison-col-headers">
        <div></div>
        <div class="comparison-col-header left-header">
          <span class="col-header-icon">✓</span>
          值得肯定
        </div>
        <div class="comparison-col-header right-header">
          <span class="col-header-icon">✗</span>
          争议 / 缺陷
        </div>
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
    default:
      throw new Error(`Unknown card type: ${(data as { type: string }).type}`);
  }
}
