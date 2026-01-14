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

/**
 * Convert simple markdown to HTML
 * Supports **bold**, *italic* (em), and line breaks
 */
function markdownToHtml(text: string): string {
  // Escape HTML first
  let html = escapeHtml(text);
  // Convert **bold** to <strong> first (before processing line breaks)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Convert *italic* to <em> (but not if it's part of **bold**)
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  // Convert line breaks to <br> tags
  html = html.replace(/\n/g, '<br>');
  return html;
}

/**
 * Q&A card template
 */
export function qaCard(data: QACardData): string {
  const question = escapeHtml(data.question);
  const answer = markdownToHtml(data.answer);
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
          <span>${markdownToHtml(item)}</span>
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
  const content = markdownToHtml(data.content);
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
 * Comparison card template
 */
export function comparisonCard(data: ComparisonCardData): string {
  const title = escapeHtml(data.title);
  const rows = data.items
    .map(
      (item) => `
        <tr>
          <td class="label">${escapeHtml(item.label)}</td>
          <td>${markdownToHtml(item.left)}</td>
          <td>${markdownToHtml(item.right)}</td>
        </tr>
      `,
    )
    .join('');
  return `
    <div class="comparison-card">
      <h2>${title}</h2>
      <table class="comparison-table">
        <thead>
          <tr>
            <th></th>
            <th>选项 A</th>
            <th>选项 B</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Knowledge card template
 */
export function knowledgeCard(data: KnowledgeCardData): string {
  const term = escapeHtml(data.term);
  const definition = markdownToHtml(data.definition);
  const examples = data.examples
    ? `
      <div class="examples">
        <div class="examples-title">📝 实际应用举例</div>
        <ul>
          ${data.examples.map((ex) => `<li>${markdownToHtml(ex)}</li>`).join('')}
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
