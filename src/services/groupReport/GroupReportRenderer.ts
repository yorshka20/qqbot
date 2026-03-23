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

/** Build the activity chart HTML (simple CSS bar chart) */
function buildActivityChart(hourlyActivity: { hour: number; count: number }[]): string {
  if (!hourlyActivity.length) return '';
  const maxCount = Math.max(...hourlyActivity.map((h) => h.count), 1);

  const bars = hourlyActivity
    .map((h) => {
      const heightPct = Math.max((h.count / maxCount) * 100, 2);
      const label = h.count > 0 ? String(h.count) : '';
      return `
        <div class="chart-bar-wrapper">
          <div class="chart-bar-value">${label}</div>
          <div class="chart-bar" style="height: ${heightPct}%"></div>
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
      (t) => `
      <div class="topic-item">
        <div class="topic-title">${escapeHtml(t.title)}</div>
        <div class="topic-summary">${escapeHtml(t.summary)}</div>
      </div>`,
    )
    .join('');

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-icon">💬</span>
        <span class="section-title">今日重点 Topics</span>
      </div>
      ${items}
    </div>`;
}

/** Build member highlights section HTML */
function buildMemberHighlights(members: GroupReportData['memberHighlights']): string {
  if (!members.length) return '';
  const items = members
    .map(
      (m) => `
      <div class="member-item">
        <img class="member-avatar" src="${avatarUrl(m.userId)}" alt="${escapeHtml(m.nickname)}" />
        <div class="member-info">
          <div class="member-name">${escapeHtml(m.nickname)} <span class="member-count">${m.messageCount}条消息</span></div>
          <div class="member-comment">${escapeHtml(m.comment)}</div>
        </div>
      </div>`,
    )
    .join('');

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-icon">👥</span>
        <span class="section-title">群成员点评 Highlights</span>
      </div>
      ${items}
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
        <div class="featured-content">"${escapeHtml(m.content)}"</div>
        <div class="featured-comment">💡 ${escapeHtml(m.comment)}</div>
      </div>`,
    )
    .join('');

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-icon">✨</span>
        <span class="section-title">精选发言 Moments</span>
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
    <div class="header-title">互联相伴的一天，来看看群里发生了什么吧！</div>
    <div class="header-subtitle">${escapeHtml(data.groupName)}</div>
  </div>

  <!-- Stats Row -->
  <div class="stats-row">
    <div class="stat-box">
      <div class="stat-number">${data.totalMessages}</div>
      <div class="stat-desc">总消息数</div>
    </div>
    <div class="stat-box">
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
    <div class="summary-text">${escapeHtml(data.totalSummary)}</div>
  </div>

  <!-- Footer -->
  <div class="report-footer">
    <span>📅 ${escapeHtml(data.date)}</span>
    <span>·</span>
    <span>🤖 QQ Group Daily Report</span>
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
    font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif;
    margin: 0;
    padding: 30px;
    background: transparent;
    min-height: 100vh;
  }

  .report-container {
    width: 800px;
    background: linear-gradient(180deg, #FFF8F0 0%, #FFFDF9 8%, #FFFFFF 30%);
    border-radius: 24px;
    padding: 0;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.12);
  }

  /* ── Header ── */
  .report-header {
    background: linear-gradient(135deg, #FF9A56 0%, #FF6B6B 100%);
    padding: 40px 36px 32px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .report-header::before {
    content: '';
    position: absolute;
    top: -30%;
    right: -10%;
    width: 200px;
    height: 200px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 50%;
  }
  .report-header::after {
    content: '';
    position: absolute;
    bottom: -20%;
    left: -5%;
    width: 150px;
    height: 150px;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 50%;
  }
  .header-title {
    font-size: 26px;
    font-weight: 800;
    color: #fff;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    position: relative;
    z-index: 1;
    line-height: 1.4;
  }
  .header-subtitle {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.85);
    margin-top: 8px;
    position: relative;
    z-index: 1;
  }

  /* ── Stats Row ── */
  .stats-row {
    display: flex;
    gap: 16px;
    padding: 24px 28px;
    margin: -16px 20px 0;
    position: relative;
    z-index: 2;
  }
  .stat-box {
    flex: 1;
    background: #fff;
    border-radius: 16px;
    padding: 20px 16px;
    text-align: center;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
    border: 1px solid rgba(0, 0, 0, 0.04);
  }
  .stat-box.accent {
    background: linear-gradient(135deg, #FFF3E6 0%, #FFE8D6 100%);
    border: 1px solid rgba(255, 154, 86, 0.2);
  }
  .stat-number {
    font-size: 36px;
    font-weight: 800;
    color: #FF7043;
    line-height: 1.2;
  }
  .stat-number-sm {
    font-size: 22px;
    font-weight: 700;
    color: #FF7043;
    line-height: 1.3;
  }
  .stat-label-top {
    font-size: 11px;
    color: #FF9A56;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
    font-weight: 600;
  }
  .stat-desc {
    font-size: 13px;
    color: #999;
    margin-top: 6px;
  }

  /* ── Sections ── */
  .section {
    padding: 0 28px;
    margin: 24px 0;
  }
  .section-header {
    display: flex;
    align-items: center;
    margin-bottom: 16px;
    padding-bottom: 10px;
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
    background: #FAFAFA;
    border-radius: 12px;
    padding: 20px 16px 8px;
    border: 1px solid #F0F0F0;
  }
  .chart-bars {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    height: 120px;
    gap: 4px;
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
    width: 70%;
    min-height: 2px;
    background: linear-gradient(180deg, #FF9A56 0%, #FFBF86 100%);
    border-radius: 4px 4px 0 0;
    transition: height 0.3s;
  }
  .chart-bar-value {
    font-size: 9px;
    color: #FF7043;
    font-weight: 600;
    margin-bottom: 2px;
    min-height: 12px;
  }
  .chart-bar-label {
    font-size: 10px;
    color: #AAA;
    margin-top: 4px;
  }

  /* ── Topics ── */
  .topic-item {
    background: #FAFAFA;
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 10px;
    border: 1px solid #F0F0F0;
  }
  .topic-title {
    font-size: 15px;
    font-weight: 700;
    color: #2D3436;
    margin-bottom: 6px;
  }
  .topic-summary {
    font-size: 14px;
    color: #636E72;
    line-height: 1.6;
  }

  /* ── Member Highlights ── */
  .member-item {
    display: flex;
    align-items: flex-start;
    padding: 16px 0;
    border-bottom: 1px solid #F5F5F5;
  }
  .member-item:last-child {
    border-bottom: none;
  }
  .member-avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    margin-right: 16px;
    flex-shrink: 0;
    object-fit: cover;
    border: 2px solid #FFF0E6;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  }
  .member-info {
    flex: 1;
    min-width: 0;
  }
  .member-name {
    font-size: 15px;
    font-weight: 700;
    color: #2D3436;
    margin-bottom: 4px;
  }
  .member-count {
    font-size: 12px;
    color: #FF9A56;
    font-weight: 500;
    margin-left: 8px;
    background: #FFF3E6;
    padding: 2px 8px;
    border-radius: 10px;
  }
  .member-comment {
    font-size: 14px;
    color: #636E72;
    line-height: 1.6;
  }

  /* ── Featured Messages ── */
  .featured-grid {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .featured-msg {
    background: #FAFAFA;
    border-radius: 14px;
    padding: 18px 20px;
    border: 1px solid #F0F0F0;
  }
  .featured-msg-header {
    display: flex;
    align-items: center;
    margin-bottom: 10px;
  }
  .featured-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    margin-right: 10px;
    object-fit: cover;
    border: 1.5px solid #FFE0CC;
  }
  .featured-name {
    font-size: 14px;
    font-weight: 600;
    color: #2D3436;
  }
  .featured-content {
    font-size: 15px;
    color: #2D3436;
    line-height: 1.65;
    padding: 12px 16px;
    background: #FFF;
    border-radius: 10px;
    border: 1px solid #F0F0F0;
    margin-bottom: 10px;
    font-style: italic;
  }
  .featured-comment {
    font-size: 13px;
    color: #FF7043;
    line-height: 1.5;
    padding-left: 4px;
  }

  /* ── Summary ── */
  .summary-section {
    padding: 0 28px;
    margin: 24px 0;
  }
  .summary-text {
    background: linear-gradient(135deg, #FFF8F0 0%, #FFF3E6 100%);
    border-radius: 14px;
    padding: 22px 24px;
    font-size: 15px;
    line-height: 1.75;
    color: #2D3436;
    border: 1px solid rgba(255, 154, 86, 0.15);
  }

  /* ── Footer ── */
  .report-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 20px 28px;
    border-top: 1px solid #F5F5F5;
    font-size: 13px;
    color: #B0B0B0;
    margin-top: 8px;
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
