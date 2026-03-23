import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  MessageSquare,
  Newspaper,
  Users,
} from 'lucide-react';
import { marked } from 'marked';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getReport } from '../api';
import { getOutputBase } from '../config';
import type { ArticleSummary, GroupSummary, ReportDetailResponse, WechatStats } from '../types';

interface ReportDetailProps {
  reportId: string;
  onBack: () => void;
}

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

export function ReportDetail({ reportId, onBack }: ReportDetailProps) {
  const [data, setData] = useState<ReportDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'rich' | 'markdown'>('rich');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getReport(reportId);
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load report');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  useEffect(() => {
    load();
  }, [load]);

  const markdownHtml = useMemo(() => {
    if (!data?.report.markdownContent) return '';
    return marked(data.report.markdownContent) as string;
  }, [data?.report.markdownContent]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3 text-zinc-500 dark:text-zinc-400">
          <Loader2 className="w-10 h-10 animate-spin text-zinc-400 dark:text-zinc-500" />
          <span className="text-sm font-medium">加载报告...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          <ArrowLeft className="w-4 h-4" />
          返回列表
        </button>
        <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/40 dark:border-red-900 p-6 text-red-800 dark:text-red-300 text-sm">
          {error ?? '报告不存在'}
        </div>
      </div>
    );
  }

  const { report } = data;

  return (
    <div className="space-y-6">
      {/* Back button & View toggle */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          <ArrowLeft className="w-4 h-4" />
          返回列表
        </button>

        <div className="flex items-center gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
          <button
            type="button"
            onClick={() => setViewMode('rich')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              viewMode === 'rich'
                ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
            }`}
          >
            富文本
          </button>
          <button
            type="button"
            onClick={() => setViewMode('markdown')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              viewMode === 'markdown'
                ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
            }`}
          >
            Markdown
          </button>
        </div>
      </div>

      {/* Header */}
      <header className="border-b border-zinc-200 dark:border-zinc-700 pb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">{report.title}</h1>
        <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
          <span>生成于 {format(new Date(report.generatedAt), 'yyyy年MM月dd日 HH:mm', { locale: zhCN })}</span>
          <span>统计范围: {report.period.label}</span>
        </div>
      </header>

      {viewMode === 'rich' ? (
        <RichContent report={report} />
      ) : (
        <div
          className="prose prose-zinc dark:prose-invert max-w-none prose-headings:scroll-mt-20 prose-a:text-blue-600 dark:prose-a:text-blue-400"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown rendering
          dangerouslySetInnerHTML={{ __html: markdownHtml }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Rich Content Components
// ────────────────────────────────────────────────────────────────────────────

function RichContent({ report }: { report: ReportDetailResponse['report'] }) {
  return (
    <div className="space-y-8">
      {/* Stats Overview */}
      {report.stats && <StatsSection stats={report.stats} />}

      {/* Groups */}
      {report.groups.length > 0 && <GroupsSection groups={report.groups} />}

      {/* Articles */}
      {report.articles.length > 0 && <ArticlesSection articles={report.articles} />}
    </div>
  );
}

function StatsSection({ stats }: { stats: WechatStats }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4 flex items-center gap-2">
        <span className="text-xl">📊</span> 数据概览
      </h2>

      {/* Main stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="总消息" value={stats.messages.total} icon={<MessageSquare className="w-5 h-5" />} />
        <StatCard label="群聊消息" value={stats.messages.groups} subtitle={`${stats.messages.groupCount} 个群`} />
        <StatCard
          label="私聊消息"
          value={stats.messages.private}
          subtitle={`${stats.messages.privateCount} 个联系人`}
        />
        <StatCard label="文章" value={stats.articles.total} icon={<Newspaper className="w-5 h-5" />} />
      </div>

      {/* Top groups & accounts */}
      <div className="grid md:grid-cols-2 gap-6">
        {stats.topGroups.length > 0 && (
          <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-xl p-4">
            <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">活跃群聊 Top 10</h3>
            <div className="space-y-2">
              {stats.topGroups.slice(0, 10).map((g, i) => (
                <div key={g.conversationId} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span className="text-zinc-400 dark:text-zinc-500 w-4 text-right">{i + 1}.</span>
                    <span className="text-zinc-700 dark:text-zinc-300 truncate max-w-[180px]">
                      {g.groupName || g.conversationId}
                    </span>
                  </span>
                  <span className="text-zinc-500 dark:text-zinc-400 text-xs">
                    {g.messageCount}条 · {g.senderCount}人
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {stats.topAccounts.length > 0 && (
          <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-xl p-4">
            <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">活跃公众号 Top 10</h3>
            <div className="space-y-2">
              {stats.topAccounts.slice(0, 10).map((a, i) => (
                <div key={a.accountNick} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span className="text-zinc-400 dark:text-zinc-500 w-4 text-right">{i + 1}.</span>
                    <span className="text-zinc-700 dark:text-zinc-300 truncate max-w-[180px]">{a.accountNick}</span>
                  </span>
                  <span className="text-zinc-500 dark:text-zinc-400 text-xs">{a.articleCount}篇</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function StatCard({
  label,
  value,
  subtitle,
  icon,
}: {
  label: string;
  value: number;
  subtitle?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl p-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">{label}</span>
        {icon && <span className="text-zinc-400 dark:text-zinc-500">{icon}</span>}
      </div>
      <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{value.toLocaleString()}</div>
      {subtitle && <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{subtitle}</div>}
    </div>
  );
}

function GroupsSection({ groups }: { groups: GroupSummary[] }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4 flex items-center gap-2">
        <span className="text-xl">💬</span> 群聊摘要
      </h2>
      <div className="space-y-4">
        {groups.map((g) => (
          <GroupCard key={g.conversationId} group={g} />
        ))}
      </div>
    </section>
  );
}

/** Parse "[HH:MM] sender: content" into structured parts */
interface ParsedMessage {
  time: string;
  sender: string;
  content: string;
  /** Detected tag like 链接/图片/文件/视频号/other, or null for plain text */
  tag: string | null;
  /** Content after the tag prefix (stripped of [tag] wrapper) */
  body: string;
}

const MSG_RE = /^\[(\d{2}:\d{2})\]\s+(.+?):\s(.+)$/;
const TAG_RE = /^\[([^\]]+)\]\s*(.*)$/;

function parseMessage(line: string): ParsedMessage | null {
  const m = MSG_RE.exec(line);
  if (!m) return null;
  const [, time, sender, content] = m;
  const tagMatch = TAG_RE.exec(content);
  if (tagMatch) {
    return { time, sender, content, tag: tagMatch[1], body: tagMatch[2] };
  }
  return { time, sender, content, tag: null, body: content };
}

const TAG_STYLES: Record<string, { bg: string; text: string }> = {
  链接: { bg: 'bg-blue-100 dark:bg-blue-900/40', text: 'text-blue-700 dark:text-blue-300' },
  图片: { bg: 'bg-emerald-100 dark:bg-emerald-900/40', text: 'text-emerald-700 dark:text-emerald-300' },
  文件: { bg: 'bg-amber-100 dark:bg-amber-900/40', text: 'text-amber-700 dark:text-amber-300' },
  视频号: { bg: 'bg-violet-100 dark:bg-violet-900/40', text: 'text-violet-700 dark:text-violet-300' },
  other: { bg: 'bg-zinc-100 dark:bg-zinc-700', text: 'text-zinc-600 dark:text-zinc-300' },
};

function getTagStyle(tag: string) {
  return TAG_STYLES[tag] ?? TAG_STYLES.other;
}

/** Encode a file path for use in a URL — encode each segment but preserve `/` separators. */
function encodeFilePath(filePath: string): string {
  return filePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** Convert an image file path from formattedMessages to a serveable URL.
 *  Paths come as "output/wechat/..." — strip the leading "output/" and prepend getOutputBase(). */
function toImageUrl(body: string): string | null {
  const p = body.trim();
  if (!p) return null;
  const relative = p.startsWith('output/') ? p.slice('output/'.length) : p;
  return `${getOutputBase()}/${encodeFilePath(relative)}`;
}

function MessageBody({ parsed: p }: { parsed: ParsedMessage }) {
  if (p.tag === '图片') {
    const url = toImageUrl(p.body);
    if (url) {
      return (
        <a href={url} target="_blank" rel="noopener noreferrer" className="block mt-1.5">
          <img
            src={url}
            alt={p.body || '图片'}
            loading="lazy"
            decoding="async"
            className="max-w-xs max-h-48 rounded-lg border border-zinc-200 dark:border-zinc-600 object-cover hover:shadow-md transition-shadow"
          />
        </a>
      );
    }
  }
  return <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-0.5 break-words leading-relaxed">{p.body}</p>;
}

const PREVIEW_COUNT = 15;

function GroupCard({ group }: { group: GroupSummary }) {
  const [expanded, setExpanded] = useState(false);

  const allMessages = useMemo(() => {
    return group.formattedMessages
      .split('\n')
      .filter((l) => l.trim())
      .map((line, i) => ({ id: `${i}-${line.slice(0, 32)}`, raw: line, parsed: parseMessage(line) }));
  }, [group.formattedMessages]);

  const visibleMessages = expanded ? allMessages : allMessages.slice(0, PREVIEW_COUNT);
  const hasMore = allMessages.length > PREVIEW_COUNT;

  return (
    <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-700/50">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-base text-zinc-900 dark:text-zinc-100">
              {group.groupName || group.conversationId}
            </h3>
            <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400 mt-1.5">
              <span className="flex items-center gap-1">
                <MessageSquare className="w-3.5 h-3.5" />
                {group.messageCount} 条消息
              </span>
              <span className="flex items-center gap-1">
                <Users className="w-3.5 h-3.5" />
                {group.senderCount} 人发言
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 shrink-0">
            {group.categories.map((cat) => (
              <span
                key={cat}
                className="px-2 py-0.5 text-xs rounded-full bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 font-medium"
              >
                {cat}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Message list */}
      <div className="divide-y divide-zinc-100 dark:divide-zinc-700/30">
        {visibleMessages.map((msg) => {
          const p = msg.parsed;
          if (!p) {
            // Unparseable line — render as-is
            return (
              <div key={msg.id} className="px-5 py-2.5 text-sm text-zinc-500 dark:text-zinc-400">
                {msg.raw}
              </div>
            );
          }

          return (
            <div
              key={msg.id}
              className="px-5 py-2.5 flex items-start gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-700/20 transition-colors"
            >
              {/* Time */}
              <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono pt-0.5 shrink-0 w-11 text-right tabular-nums">
                {p.time}
              </span>

              {/* Sender + content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 shrink-0">{p.sender}</span>
                  {p.tag && (
                    <span
                      className={`inline-flex px-1.5 py-px text-[10px] font-semibold rounded ${getTagStyle(p.tag).bg} ${getTagStyle(p.tag).text}`}
                    >
                      {p.tag}
                    </span>
                  )}
                </div>
                <MessageBody parsed={p} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Expand / Collapse */}
      {hasMore && (
        <div className="border-t border-zinc-100 dark:border-zinc-700/50">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="w-full py-2.5 flex items-center justify-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-zinc-50 dark:hover:bg-zinc-700/20 transition-colors"
          >
            {expanded ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" /> 收起
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" /> 显示全部 {allMessages.length} 条消息
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function ArticlesSection({ articles }: { articles: ArticleSummary[] }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4 flex items-center gap-2">
        <span className="text-xl">📰</span> 文章推荐
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {articles.map((a) => (
          <ArticleCard key={`${a.url}-${a.pubTime}`} article={a} />
        ))}
      </div>
    </section>
  );
}

function ArticleCard({ article }: { article: ArticleSummary }) {
  const sourceLabel =
    article.sourceType === 'oa_push' ? `公众号: ${article.accountNick}` : `分享自: ${article.sharedBy || '未知'}`;

  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group block bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl p-4 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-md transition-all"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="font-medium text-zinc-900 dark:text-zinc-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors line-clamp-2">
          {article.title}
        </h3>
        <ExternalLink className="w-4 h-4 flex-shrink-0 text-zinc-400 dark:text-zinc-500 group-hover:text-blue-500" />
      </div>

      {article.summary && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400 line-clamp-3 mb-3">{article.summary}</p>
      )}

      <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span>{sourceLabel}</span>
        <span>{format(new Date(article.pubTime * 1000), 'MM/dd HH:mm', { locale: zhCN })}</span>
      </div>
    </a>
  );
}
