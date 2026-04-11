import type { LucideIcon } from 'lucide-react';
import { Activity, Clock, Layers, Smile, TrendingUp, Users } from 'lucide-react';

export type MomentsViewMode = 'browse' | 'interest' | 'clusters' | 'sentiment' | 'entities' | 'behavior';

export const MOMENTS_VIEW_MODES: Array<{ key: MomentsViewMode; label: string; icon: LucideIcon }> = [
  { key: 'browse', label: '浏览', icon: Clock },
  { key: 'interest', label: '兴趣演化', icon: TrendingUp },
  { key: 'clusters', label: '内容聚类', icon: Layers },
  { key: 'sentiment', label: '情绪分析', icon: Smile },
  { key: 'entities', label: '实体图谱', icon: Users },
  { key: 'behavior', label: '行为模式', icon: Activity },
];
