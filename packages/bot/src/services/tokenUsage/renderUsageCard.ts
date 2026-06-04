// Renders the /usage statistics into a styled image card via Puppeteer.
//
// Input vs output tokens are surfaced distinctly throughout (they're priced
// differently): input is blue, output is amber, repeated in the legend, the
// per-row proportion bar, and every number pair.

import type { Page } from 'puppeteer-core';
import { BrowserService } from '@/services/browser/BrowserService';
import { logger } from '@/utils/logger';
import type { DailyReport, DailyUsageAgg, ProviderUsageAgg, UserUsageAgg } from './TokenUsageService';

export interface UsageCardData {
  report: DailyReport;
  selfId: string;
  selfName?: string;
  mine: DailyUsageAgg[];
  /** userId → avatar data URI (pre-fetched); falls back to the QQ avatar URL. */
  avatarMap?: Map<string, string>;
}

const IN_COLOR = '#2563eb'; // input (prompt) tokens
const OUT_COLOR = '#f59e0b'; // output (completion) tokens

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const fmt = (n: number): string => n.toLocaleString('en-US');

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

function avatarSrc(userId: string, avatarMap?: Map<string, string>): string {
  return avatarMap?.get(userId) ?? `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=140`;
}

function providerChips(byProvider: ProviderUsageAgg[]): string {
  return byProvider
    .map((p) => {
      const value = p.type === 'image' ? `${p.imageCount}图` : compact(p.totalTokens);
      return `<span class="chip"><span class="chip-name">${esc(p.provider)}</span> ${value}</span>`;
    })
    .join('');
}

/** Horizontal bar split into input (blue) and output (amber) by proportion. */
function ratioBar(promptTokens: number, completionTokens: number): string {
  const total = promptTokens + completionTokens;
  if (total <= 0) return '<div class="bar"><div class="bar-empty"></div></div>';
  const inPct = (promptTokens / total) * 100;
  return `<div class="bar">
    <div class="bar-in" style="width:${inPct}%"></div>
    <div class="bar-out" style="width:${100 - inPct}%"></div>
  </div>`;
}

function rankBadge(i: number): string {
  const medals = ['🥇', '🥈', '🥉'];
  if (i < 3) return `<div class="rank rank-${i}">${medals[i]}</div>`;
  return `<div class="rank">${i + 1}</div>`;
}

function buildTopRows(top: UserUsageAgg[], avatarMap?: Map<string, string>): string {
  if (top.length === 0) {
    return `<div class="empty">今日暂无消耗记录</div>`;
  }
  return top
    .map((u, i) => {
      const name = u.nickname ? esc(u.nickname) : esc(u.userId);
      const imgTag = u.totalImages > 0 ? `<span class="img-tag">${u.totalImages} 图</span>` : '';
      return `
      <div class="row">
        ${rankBadge(i)}
        <img class="avatar" src="${avatarSrc(u.userId, avatarMap)}" alt="" />
        <div class="row-body">
          <div class="row-head">
            <span class="name">${name}</span>
            <span class="total">${fmt(u.totalTokens)}<span class="unit"> tok</span></span>
          </div>
          ${ratioBar(u.promptTokens, u.completionTokens)}
          <div class="row-meta">
            <span class="io"><i class="dot dot-in"></i>输入 ${fmt(u.promptTokens)}</span>
            <span class="io"><i class="dot dot-out"></i>输出 ${fmt(u.completionTokens)}</span>
            ${imgTag}
          </div>
          <div class="chips">${providerChips(u.byProvider)}</div>
        </div>
      </div>`;
    })
    .join('');
}

function buildMineRows(mine: DailyUsageAgg[]): string {
  const rows = mine
    .map((d) => {
      const md = d.date.slice(5); // MM-DD
      if (d.totalTokens === 0 && d.totalImages === 0) {
        return `<div class="day"><span class="day-date">${md}</span><span class="day-none">—</span></div>`;
      }
      const img = d.totalImages > 0 ? `<span class="day-img">${d.totalImages}图</span>` : '';
      return `<div class="day">
        <span class="day-date">${md}</span>
        <span class="day-val"><i class="dot dot-in"></i>${fmt(d.promptTokens)}</span>
        <span class="day-val"><i class="dot dot-out"></i>${fmt(d.completionTokens)}</span>
        <span class="day-total">${fmt(d.totalTokens)}</span>
        ${img}
      </div>`;
    })
    .join('');

  const sumIn = mine.reduce((s, d) => s + d.promptTokens, 0);
  const sumOut = mine.reduce((s, d) => s + d.completionTokens, 0);
  const sumTotal = mine.reduce((s, d) => s + d.totalTokens, 0);
  const sumImg = mine.reduce((s, d) => s + d.totalImages, 0);

  return `${rows}
    <div class="day day-sum">
      <span class="day-date">合计</span>
      <span class="day-val"><i class="dot dot-in"></i>${fmt(sumIn)}</span>
      <span class="day-val"><i class="dot dot-out"></i>${fmt(sumOut)}</span>
      <span class="day-total">${fmt(sumTotal)}</span>
      ${sumImg > 0 ? `<span class="day-img">${sumImg}图</span>` : ''}
    </div>`;
}

export function renderUsageCardHTML(data: UsageCardData): string {
  const { report, mine, selfId, selfName, avatarMap } = data;
  const selfLabel = selfName ? `${esc(selfName)} · ${esc(selfId)}` : esc(selfId);

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    font-variant-numeric: tabular-nums;
  }
  .wrap {
    width: 720px;
    padding: 28px;
    background: linear-gradient(135deg, #eef2ff 0%, #faf5ff 100%);
  }
  .card {
    background: #fff;
    border-radius: 24px;
    overflow: hidden;
    box-shadow: 0 20px 48px rgba(79, 70, 229, 0.16);
  }

  /* Header */
  .header {
    padding: 26px 30px 22px;
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 55%, #a855f7 100%);
    color: #fff;
  }
  .header .eyebrow { font-size: 13px; letter-spacing: 2px; text-transform: uppercase; opacity: .8; }
  .header h1 { font-size: 26px; font-weight: 700; margin-top: 4px; letter-spacing: .5px; }
  .header .date { font-size: 14px; opacity: .85; margin-top: 2px; }

  .stats {
    display: flex;
    gap: 12px;
    margin-top: 20px;
  }
  .stat {
    flex: 1;
    background: rgba(255,255,255,.14);
    border: 1px solid rgba(255,255,255,.18);
    border-radius: 14px;
    padding: 12px 14px;
  }
  .stat .label { font-size: 12px; opacity: .85; display: flex; align-items: center; gap: 5px; }
  .stat .value { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .stat .sub { font-size: 11px; opacity: .7; margin-top: 1px; }

  /* Sections */
  .section { padding: 22px 30px; }
  .section + .section { border-top: 1px solid #f1f5f9; }
  .section-title {
    font-size: 15px; font-weight: 700; color: #1e293b;
    display: flex; align-items: center; gap: 8px; margin-bottom: 16px;
  }
  .section-title .badge { font-size: 12px; font-weight: 600; color: #6366f1; background: #eef2ff; padding: 2px 9px; border-radius: 999px; }

  /* Top rows */
  .row { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; }
  .row + .row { border-top: 1px solid #f4f4f7; }
  .rank {
    flex: 0 0 30px; height: 30px; border-radius: 9px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 700; color: #64748b; background: #f1f5f9;
  }
  .rank-0, .rank-1, .rank-2 { background: transparent; font-size: 20px; }
  .avatar { flex: 0 0 38px; width: 38px; height: 38px; border-radius: 11px; object-fit: cover; background: #e2e8f0; }
  .row-body { flex: 1; min-width: 0; }
  .row-head { display: flex; justify-content: space-between; align-items: baseline; }
  .name { font-size: 15px; font-weight: 600; color: #1e293b; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .total { font-size: 18px; font-weight: 700; color: #4338ca; }
  .total .unit { font-size: 12px; font-weight: 500; color: #94a3b8; }

  .bar { display: flex; height: 7px; border-radius: 999px; overflow: hidden; margin: 7px 0; background: #eef2f6; }
  .bar-in { background: ${IN_COLOR}; }
  .bar-out { background: ${OUT_COLOR}; }
  .bar-empty { width: 100%; background: #eef2f6; }

  .row-meta { display: flex; align-items: center; gap: 14px; font-size: 12.5px; color: #475569; }
  .io { display: flex; align-items: center; gap: 5px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot-in { background: ${IN_COLOR}; }
  .dot-out { background: ${OUT_COLOR}; }
  .img-tag { color: #be185d; background: #fce7f3; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
  .chip { font-size: 11px; color: #64748b; background: #f1f5f9; border-radius: 7px; padding: 2px 8px; }
  .chip-name { color: #334155; font-weight: 600; }

  .empty { text-align: center; color: #94a3b8; padding: 24px 0; font-size: 14px; }

  /* My recent days */
  .mine-head { font-size: 12px; color: #94a3b8; margin-bottom: 10px; }
  .day { display: flex; align-items: center; gap: 14px; padding: 9px 12px; border-radius: 10px; font-size: 13px; color: #334155; }
  .day:nth-child(odd) { background: #f8fafc; }
  .day-date { flex: 0 0 52px; font-weight: 600; color: #64748b; }
  .day-val { display: flex; align-items: center; gap: 5px; flex: 0 0 100px; }
  .day-total { margin-left: auto; font-weight: 700; color: #4338ca; }
  .day-none { color: #cbd5e1; }
  .day-img { color: #be185d; font-size: 11.5px; font-weight: 600; }
  .day-sum { background: #eef2ff !important; margin-top: 6px; }
  .day-sum .day-date, .day-sum .day-total { color: #4338ca; }

  .legend { display: flex; gap: 16px; font-size: 12px; color: #64748b; margin-bottom: 14px; }
  .legend .io { gap: 6px; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="header">
        <div class="eyebrow">Token Usage</div>
        <h1>Token 消耗统计</h1>
        <div class="date">${esc(report.date)} · ${report.userCount} 位用户</div>
        <div class="stats">
          <div class="stat">
            <div class="label"><i class="dot dot-in"></i>今日输入</div>
            <div class="value">${compact(report.promptTokens)}</div>
            <div class="sub">${fmt(report.promptTokens)} tokens</div>
          </div>
          <div class="stat">
            <div class="label"><i class="dot dot-out"></i>今日输出</div>
            <div class="value">${compact(report.completionTokens)}</div>
            <div class="sub">${fmt(report.completionTokens)} tokens</div>
          </div>
          <div class="stat">
            <div class="label">今日总计</div>
            <div class="value">${compact(report.totalTokens)}</div>
            <div class="sub">${report.totalImages > 0 ? `${report.totalImages} 张图片 · ` : ''}${fmt(report.totalTokens)} tokens</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">今日消耗 <span class="badge">Top ${report.topUsers.length || 10}</span></div>
        <div class="legend">
          <span class="io"><i class="dot dot-in"></i>输入 (prompt)</span>
          <span class="io"><i class="dot dot-out"></i>输出 (completion)</span>
        </div>
        ${buildTopRows(report.topUsers, avatarMap)}
      </div>

      <div class="section">
        <div class="section-title">我的近三日</div>
        <div class="mine-head">${selfLabel}</div>
        ${buildMineRows(mine)}
      </div>
    </div>
  </div>
</body>
</html>`;
}

/** Pre-fetch QQ avatars to base64 data URIs so the screenshot doesn't depend on in-page network. */
async function prefetchAvatars(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await Promise.allSettled(
    userIds.map(async (uid) => {
      try {
        const res = await fetch(`https://q1.qlogo.cn/g?b=qq&nk=${uid}&s=140`);
        if (!res.ok) return;
        const buf = Buffer.from(await res.arrayBuffer());
        const ct = res.headers.get('content-type') || 'image/jpeg';
        map.set(uid, `data:${ct};base64,${buf.toString('base64')}`);
      } catch {
        // Fall back to the external URL in the HTML.
      }
    }),
  );
  return map;
}

/** Render the usage card to a JPEG buffer via Puppeteer. */
export async function renderUsageCardImage(data: UsageCardData): Promise<Buffer> {
  const avatarMap = data.avatarMap ?? (await prefetchAvatars(data.report.topUsers.map((u) => u.userId)));
  const html = renderUsageCardHTML({ ...data, avatarMap });
  let page: Page | null = null;
  try {
    page = await BrowserService.getInstance().createPage();
    await page.setViewport({ width: 720, height: 1200, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Wait for avatar images and fonts so the screenshot isn't blank/unstyled.
    await page.evaluate(() =>
      Promise.allSettled(
        Array.from(document.querySelectorAll('img')).map(
          (img) =>
            new Promise<void>((resolve) => {
              if (img.complete) return resolve();
              img.onload = () => resolve();
              img.onerror = () => resolve();
              setTimeout(resolve, 4000);
            }),
        ),
      ),
    );
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 300));

    const bounds = await page.evaluate(() => {
      const el = document.querySelector('.wrap');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.max(0, Math.round(r.x)),
        y: Math.max(0, Math.round(r.y)),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    });
    if (!bounds) throw new Error('usage card bounds not found');

    const shot = await page.screenshot({ type: 'jpeg', quality: 92, clip: bounds });
    return shot as Buffer;
  } finally {
    if (page) {
      await page.close().catch((e) => logger.warn('[UsageCard] Failed to close page:', e));
    }
  }
}
