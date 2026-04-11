export type ZhihuDatePreset = '全部' | '今天' | '近3天' | '近7天' | '近30天';

export const ZHIHU_DATE_PRESETS: ZhihuDatePreset[] = ['全部', '今天', '近3天', '近7天', '近30天'];

export function getZhihuPresetSinceTs(preset: ZhihuDatePreset): number | undefined {
  if (preset === '全部') return undefined;
  const now = Math.floor(Date.now() / 1000);
  const days = preset === '今天' ? 1 : preset === '近3天' ? 3 : preset === '近7天' ? 7 : 30;
  return now - days * 86400;
}
