// GroupReportRenderer - renders group daily report data to JPEG image via Puppeteer
// Design inspired by QQ group daily report card style

import type { Page } from 'puppeteer-core';
import { BrowserService } from '@/services/browser/BrowserService';
import { logger } from '@/utils/logger';
import type { GroupReportData } from './types';

/** Escapes HTML special characters */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** QQ avatar URL */
function avatarUrl(userId: string): string {
  return `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=140`;
}

const RANK_COLORS = ['#FF6B6B', '#FF9A56', '#FFD93D', '#74B9FF', '#A29BFE'];
const RANK_LABELS = ['🥇', '🥈', '🥉', '④', '⑤'];

const TOPIC_COLORS = ['#FF7043', '#42A5F5', '#66BB6A', '#AB47BC', '#FFA726'];

/** Build the activity chart HTML (CSS bar chart) */
function buildActivityChart(hourlyActivity: { hour: number; count: number }[]): string {
  if (!hourlyActivity.length) return '';
  const maxCount = Math.max(...hourlyActivity.map((h) => h.count), 1);

  const bars = hourlyActivity
    .map((h) => {
      const heightPct = Math.max((h.count / maxCount) * 100, 3);
      const isActive = h.count > 0;
      const barColor = isActive ? (heightPct > 70 ? '#FF6B6B' : heightPct > 40 ? '#FF9A56' : '#FFBF86') : '#E8E8E8';
      const label = h.count > 0 ? String(h.count) : '';
      return `
        <div class="chart-bar-wrapper">
          <div class="chart-bar-value">${label}</div>
          <div class="chart-bar" style="height: ${heightPct}%; background: ${barColor}"></div>
          <div class="chart-bar-label">${h.hour}</div>
        </div>`;
    })
    .join('');

  return `
    <div class="activity-chart">
      <div class="chart-bars">${bars}</div>
    </div>`;
}

/** Build topics section HTML */
function buildTopicsSection(topics: GroupReportData['topics']): string {
  if (!topics.length) return '';
  const items = topics
    .map(
      (t, i) => `
      <div class="topic-item">
        <div class="topic-tag" style="background: ${TOPIC_COLORS[i % TOPIC_COLORS.length]}20; color: ${TOPIC_COLORS[i % TOPIC_COLORS.length]}">话题 ${i + 1}</div>
        <div class="topic-title">${escapeHtml(t.title)}</div>
        <div class="topic-summary">${escapeHtml(t.summary)}</div>
      </div>`,
    )
    .join('');

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-icon">🔥</span>
        <span class="section-title">今日热议 Topics</span>
      </div>
      ${items}
    </div>`;
}

/** Build member highlights section HTML */
function buildMemberHighlights(members: GroupReportData['memberHighlights']): string {
  if (!members.length) return '';
  const items = members
    .map(
      (m, i) => `
      <div class="member-item">
        <div class="member-rank" style="background: ${RANK_COLORS[i % RANK_COLORS.length]}">${RANK_LABELS[i] ?? i + 1}</div>
        <img class="member-avatar" src="${avatarUrl(m.userId)}" alt="${escapeHtml(m.nickname)}" />
        <div class="member-info">
          <div class="member-name-row">
            <span class="member-name">${escapeHtml(m.nickname)}</span>
            <span class="member-count">${m.messageCount} 条消息</span>
          </div>
          <div class="member-comment">${escapeHtml(m.comment)}</div>
        </div>
      </div>`,
    )
    .join('');

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-icon">👥</span>
        <span class="section-title">活跃榜 Participants</span>
      </div>
      <div class="member-list">${items}</div>
    </div>`;
}

/** Build featured messages section HTML */
function buildFeaturedMessages(messages: GroupReportData['featuredMessages']): string {
  if (!messages.length) return '';
  const items = messages
    .map(
      (m) => `
      <div class="featured-msg">
        <div class="featured-msg-header">
          <img class="featured-avatar" src="${avatarUrl(m.userId)}" alt="${escapeHtml(m.nickname)}" />
          <span class="featured-name">${escapeHtml(m.nickname)}</span>
        </div>
        <div class="featured-content">
          <div class="featured-quote-mark">"</div>
          <div class="featured-text">${escapeHtml(m.content)}</div>
        </div>
        <div class="featured-comment">💡 ${escapeHtml(m.comment)}</div>
      </div>`,
    )
    .join('');

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-icon">✨</span>
        <span class="section-title">精选发言 Best Quotes</span>
      </div>
      <div class="featured-grid">${items}</div>
    </div>`;
}

/** Build the full report HTML */
function buildReportHTML(data: GroupReportData): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${getReportStyles()}</style>
</head>
<body>
<div class="report-container">

  <!-- Header -->
  <div class="report-header">
    <div class="header-decoration"></div>
    <div class="header-content">
      <div class="header-badge">Daily Report</div>
      <div class="header-title">互联相伴的一天，来看看群里发生了什么吧！</div>
      <div class="header-subtitle">${escapeHtml(data.groupName)}</div>
    </div>
  </div>

  <!-- Stats Row -->
  <div class="stats-row">
    <div class="stat-box">
      <div class="stat-icon">💬</div>
      <div class="stat-number">${data.totalMessages}</div>
      <div class="stat-desc">总消息数</div>
    </div>
    <div class="stat-box">
      <div class="stat-icon">👤</div>
      <div class="stat-number">${data.activeMembers}</div>
      <div class="stat-desc">活跃成员</div>
    </div>
    <div class="stat-box accent">
      <div class="stat-label-top">Highlight Time</div>
      <div class="stat-number-sm">${escapeHtml(data.highlightTimeRange)}</div>
      <div class="stat-desc">最活跃时段</div>
    </div>
  </div>

  <!-- Activity Chart -->
  <div class="section">
    <div class="section-header">
      <span class="section-icon">📊</span>
      <span class="section-title">24小时活跃度</span>
    </div>
    ${buildActivityChart(data.hourlyActivity)}
  </div>

  <!-- Topics -->
  ${buildTopicsSection(data.topics)}

  <!-- Member Highlights -->
  ${buildMemberHighlights(data.memberHighlights)}

  <!-- Featured Messages -->
  ${buildFeaturedMessages(data.featuredMessages)}

  <!-- Summary -->
  <div class="summary-section">
    <div class="section-header">
      <span class="section-icon">📝</span>
      <span class="section-title">群聊总评 Summary</span>
    </div>
    <div class="summary-card">
      <div class="summary-text">${escapeHtml(data.totalSummary)}</div>
    </div>
  </div>

  <!-- Footer -->
  <div class="report-footer">
    <div class="footer-line"></div>
    <div class="footer-content">
      <span>📅 ${escapeHtml(data.date)}</span>
      <span class="footer-dot">·</span>
      <span>🤖 QQ Group Daily Report</span>
    </div>
  </div>

</div>
</body>
</html>`;
}

/** CSS styles for the report */
function getReportStyles(): string {
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif;
    margin: 0;
    padding: 30px;
    background: transparent;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  .report-container {
    width: 800px;
    background: linear-gradient(180deg, #FFF8F0 0%, #FFFDF9 6%, #FFFFFF 25%);
    border-radius: 28px;
    padding: 0;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.1), 0 1px 3px rgba(0, 0, 0, 0.05);
  }

  /* ── Header ── */
  .report-header {
    background: linear-gradient(135deg, #FF9A56 0%, #FF6B6B 50%, #E84393 100%);
    padding: 44px 40px 36px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .header-decoration {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background:
      radial-gradient(circle at 85% 15%, rgba(255,255,255,0.15) 0%, transparent 40%),
      radial-gradient(circle at 10% 85%, rgba(255,255,255,0.1) 0%, transparent 35%),
      radial-gradient(circle at 50% 50%, rgba(255,255,255,0.05) 0%, transparent 60%);
  }
  .header-content {
    position: relative;
    z-index: 1;
  }
  .header-badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 700;
    color: rgba(255,255,255,0.9);
    background: rgba(255,255,255,0.2);
    padding: 4px 16px;
    border-radius: 20px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 16px;
    backdrop-filter: blur(10px);
  }
  .header-title {
    font-size: 28px;
    font-weight: 800;
    color: #fff;
    text-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
    line-height: 1.4;
  }
  .header-subtitle {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.8);
    margin-top: 10px;
    font-weight: 500;
  }

  /* ── Stats Row ── */
  .stats-row {
    display: flex;
    gap: 14px;
    padding: 0 28px;
    margin: -20px 0 0;
    position: relative;
    z-index: 2;
  }
  .stat-box {
    flex: 1;
    background: #fff;
    border-radius: 18px;
    padding: 22px 16px 18px;
    text-align: center;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
    border: 1px solid rgba(0, 0, 0, 0.03);
  }
  .stat-box.accent {
    background: linear-gradient(145deg, #FFF5EC 0%, #FFE8D6 100%);
    border: 1px solid rgba(255, 154, 86, 0.15);
  }
  .stat-icon {
    font-size: 24px;
    margin-bottom: 8px;
  }
  .stat-number {
    font-size: 38px;
    font-weight: 800;
    color: #FF7043;
    line-height: 1.1;
  }
  .stat-number-sm {
    font-size: 24px;
    font-weight: 700;
    color: #FF7043;
    line-height: 1.3;
    margin-top: 4px;
  }
  .stat-label-top {
    font-size: 11px;
    color: #FF9A56;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 6px;
    font-weight: 700;
  }
  .stat-desc {
    font-size: 12px;
    color: #999;
    margin-top: 6px;
    font-weight: 500;
  }

  /* ── Sections ── */
  .section {
    padding: 0 28px;
    margin: 28px 0;
  }
  .section-header {
    display: flex;
    align-items: center;
    margin-bottom: 18px;
    padding-bottom: 12px;
    border-bottom: 2px solid #FFF0E6;
  }
  .section-icon {
    font-size: 22px;
    margin-right: 10px;
  }
  .section-title {
    font-size: 18px;
    font-weight: 700;
    color: #2D3436;
    letter-spacing: 0.02em;
  }

  /* ── Activity Chart ── */
  .activity-chart {
    background: linear-gradient(180deg, #FAFAFA 0%, #F5F5F5 100%);
    border-radius: 16px;
    padding: 22px 18px 10px;
    border: 1px solid #EFEFEF;
  }
  .chart-bars {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    height: 130px;
    gap: 3px;
  }
  .chart-bar-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    height: 100%;
    position: relative;
  }
  .chart-bar {
    width: 65%;
    min-height: 3px;
    border-radius: 4px 4px 0 0;
  }
  .chart-bar-value {
    font-size: 9px;
    color: #FF7043;
    font-weight: 700;
    margin-bottom: 3px;
    min-height: 12px;
  }
  .chart-bar-label {
    font-size: 9px;
    color: #B0B0B0;
    margin-top: 5px;
    font-weight: 500;
  }

  /* ── Topics ── */
  .topic-item {
    background: #FAFAFA;
    border-radius: 14px;
    padding: 18px 22px;
    margin-bottom: 12px;
    border: 1px solid #F0F0F0;
    position: relative;
  }
  .topic-tag {
    display: inline-block;
    font-size: 11px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: 8px;
    margin-bottom: 8px;
  }
  .topic-title {
    font-size: 16px;
    font-weight: 700;
    color: #2D3436;
    margin-bottom: 6px;
    line-height: 1.4;
  }
  .topic-summary {
    font-size: 14px;
    color: #636E72;
    line-height: 1.65;
  }

  /* ── Member Highlights ── */
  .member-list {
    background: #FAFAFA;
    border-radius: 16px;
    padding: 8px 20px;
    border: 1px solid #F0F0F0;
  }
  .member-item {
    display: flex;
    align-items: center;
    padding: 16px 0;
    border-bottom: 1px solid #F0F0F0;
  }
  .member-item:last-child {
    border-bottom: none;
  }
  .member-rank {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 800;
    color: #fff;
    margin-right: 14px;
    flex-shrink: 0;
  }
  .member-avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    margin-right: 16px;
    flex-shrink: 0;
    object-fit: cover;
    border: 2.5px solid #FFF0E6;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.08);
  }
  .member-info {
    flex: 1;
    min-width: 0;
  }
  .member-name-row {
    display: flex;
    align-items: center;
    margin-bottom: 4px;
  }
  .member-name {
    font-size: 15px;
    font-weight: 700;
    color: #2D3436;
  }
  .member-count {
    font-size: 11px;
    color: #FF9A56;
    font-weight: 600;
    margin-left: 10px;
    background: #FFF3E6;
    padding: 2px 10px;
    border-radius: 10px;
  }
  .member-comment {
    font-size: 13px;
    color: #636E72;
    line-height: 1.6;
  }

  /* ── Featured Messages ── */
  .featured-grid {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .featured-msg {
    background: #FAFAFA;
    border-radius: 16px;
    padding: 20px 22px;
    border: 1px solid #F0F0F0;
  }
  .featured-msg-header {
    display: flex;
    align-items: center;
    margin-bottom: 12px;
  }
  .featured-avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    margin-right: 12px;
    object-fit: cover;
    border: 2px solid #FFE0CC;
  }
  .featured-name {
    font-size: 14px;
    font-weight: 700;
    color: #2D3436;
  }
  .featured-content {
    position: relative;
    padding: 16px 20px 16px 36px;
    background: #FFF;
    border-radius: 12px;
    border: 1px solid #F0F0F0;
    margin-bottom: 12px;
    border-left: 3px solid #FF9A56;
  }
  .featured-quote-mark {
    position: absolute;
    top: 8px;
    left: 12px;
    font-size: 28px;
    font-weight: 800;
    color: #FFD0B0;
    line-height: 1;
    font-family: Georgia, serif;
  }
  .featured-text {
    font-size: 15px;
    color: #2D3436;
    line-height: 1.7;
  }
  .featured-comment {
    font-size: 13px;
    color: #FF7043;
    line-height: 1.55;
    padding-left: 4px;
    font-weight: 500;
  }

  /* ── Summary ── */
  .summary-section {
    padding: 0 28px;
    margin: 28px 0;
  }
  .summary-card {
    background: linear-gradient(145deg, #FFF8F0 0%, #FFF3E6 100%);
    border-radius: 16px;
    padding: 24px 28px;
    border: 1px solid rgba(255, 154, 86, 0.12);
    position: relative;
    overflow: hidden;
  }
  .summary-card::before {
    content: '';
    position: absolute;
    top: 0; right: 0;
    width: 120px;
    height: 120px;
    background: radial-gradient(circle at 100% 0%, rgba(255, 154, 86, 0.08) 0%, transparent 70%);
  }
  .summary-text {
    font-size: 15px;
    line-height: 1.8;
    color: #2D3436;
    position: relative;
    z-index: 1;
  }

  /* ── Footer ── */
  .report-footer {
    padding: 0 28px 24px;
    margin-top: 12px;
  }
  .footer-line {
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, #F0F0F0 20%, #F0F0F0 80%, transparent 100%);
    margin-bottom: 16px;
  }
  .footer-content {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    font-size: 12px;
    color: #B8B8B8;
    font-weight: 500;
  }
  .footer-dot {
    font-size: 8px;
  }
`;
}

export class GroupReportRenderer {
  private static instance: GroupReportRenderer | null = null;

  static getInstance(): GroupReportRenderer {
    if (!GroupReportRenderer.instance) {
      GroupReportRenderer.instance = new GroupReportRenderer();
    }
    return GroupReportRenderer.instance;
  }

  /**
   * Render group report data to JPEG image buffer.
   */
  async render(data: GroupReportData): Promise<Buffer> {
    const html = buildReportHTML(data);
    let page: Page | null = null;

    try {
      page = await BrowserService.getInstance().createPage();

      await page.setViewport({
        width: 1000,
        height: 3000,
        deviceScaleFactor: 2,
      });

      await page.setContent(html, { waitUntil: 'networkidle0' });

      // Wait for avatar images to load
      await page.evaluate(() => {
        const images = Array.from(document.querySelectorAll('img'));
        return Promise.allSettled(
          images.map(
            (img) =>
              new Promise<void>((resolve) => {
                if (img.complete) return resolve();
                img.onload = () => resolve();
                img.onerror = () => resolve();
                // Timeout for slow images
                setTimeout(resolve, 5000);
              }),
          ),
        );
      });

      await page.evaluate(() => document.fonts.ready);
      await new Promise((r) => setTimeout(r, 500));

      const bounds = await page.evaluate(() => {
        const container = document.querySelector('.report-container');
        if (!container) return null;
        const rect = container.getBoundingClientRect();
        return {
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });

      if (!bounds) {
        throw new Error('Failed to calculate report content bounds');
      }

      logger.debug(`[GroupReportRenderer] Content bounds: ${bounds.width}x${bounds.height}`);

      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 85,
        clip: bounds,
        omitBackground: false,
      });

      return screenshot as Buffer;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[GroupReportRenderer] Failed to render report:', err);
      throw err;
    } finally {
      if (page) {
        await page.close().catch((e) => {
          logger.warn('[GroupReportRenderer] Failed to close page:', e);
        });
      }
    }
  }
}
