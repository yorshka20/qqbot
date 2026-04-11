/**
 * Clean WeChat article URL for regular browsers.
 * - Short URLs (/s/XXXXX): pass through (already browser-safe)
 * - Long URLs: keep only identity params (__biz, mid, idx, sn)
 * - Strips session params (key, pass_ticket, uin, wx_header, etc.) that cause "环境异常"
 */
export function cleanWxUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('weixin.qq.com')) return url;

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && parts[0] === 's' && parts[1].length > 1 && !parsed.searchParams.has('__biz')) {
      return `${parsed.origin}${parsed.pathname}`;
    }

    const clean = new URL(`${parsed.origin}${parsed.pathname}`);
    for (const key of ['__biz', 'mid', 'idx', 'sn']) {
      const val = parsed.searchParams.get(key);
      if (val) clean.searchParams.set(key, val);
    }
    return clean.toString();
  } catch {
    return url;
  }
}

export type InsightDatePreset = '全部' | '今天' | '近3天' | '近7天' | '近30天';

export const INSIGHT_DATE_PRESETS: InsightDatePreset[] = ['全部', '今天', '近3天', '近7天', '近30天'];

export function getInsightPresetStartDate(preset: InsightDatePreset): Date | null {
  if (preset === '全部') return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const days = preset === '今天' ? 0 : preset === '近3天' ? 2 : preset === '近7天' ? 6 : 29;
  now.setDate(now.getDate() - days);
  return now;
}
