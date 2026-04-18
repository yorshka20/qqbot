/**
 * Real-time log viewer page.
 *
 * Connects to /api/logs/stream (SSE) which pipes pm2 log output.
 * Features: auto-scroll, pause/resume, clear, text filter, line limit.
 */

import { ArrowDown, Circle, Pause, Play, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLogsStreamUrl } from '../../api';

interface LogLine {
  id: number;
  text: string;
  source: 'stdout' | 'stderr';
  ts: number;
}

let lineIdCounter = 0;

export function LogsPage() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showFilter, setShowFilter] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const pausedRef = useRef(paused);
  const bufferRef = useRef<LogLine[]>([]);

  // Keep ref in sync
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Flush buffered lines when unpausing
  useEffect(() => {
    if (!paused && bufferRef.current.length > 0) {
      const buf = bufferRef.current;
      bufferRef.current = [];
      setLines((prev) => [...prev, ...buf]);
    }
  }, [paused]);

  // SSE connection
  const connect = useCallback(() => {
    esRef.current?.close();

    const url = getLogsStreamUrl();
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('log', (e) => {
      try {
        const data = JSON.parse(e.data) as { text: string; source: 'stdout' | 'stderr' };
        const line: LogLine = {
          id: ++lineIdCounter,
          text: data.text,
          source: data.source,
          ts: Date.now(),
        };

        if (pausedRef.current) {
          bufferRef.current.push(line);
        } else {
          setLines((prev) => [...prev, line]);
        }
      } catch {
        // ignore malformed
      }
    });

    es.addEventListener('connected', () => {
      setConnected(true);
    });

    es.addEventListener('end', () => {
      setConnected(false);
    });
    es.onerror = () => {
      setConnected(false);
      es.close();
      // Reconnect after 3s
      setTimeout(connect, 3000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
    };
  }, [connect]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && !paused && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [autoScroll, paused]);

  // Detect manual scroll
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setAutoScroll(true);
    }
  }, []);

  const clearLines = useCallback(() => {
    setLines([]);
    bufferRef.current = [];
  }, []);

  const reconnect = useCallback(() => {
    setLines([]);
    bufferRef.current = [];
    connect();
  }, [connect]);

  // Filtered lines
  const filteredLines = useMemo(() => {
    if (!filter) return lines;
    const lower = filter.toLowerCase();
    return lines.filter((l) => l.text.toLowerCase().includes(lower));
  }, [lines, filter]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="shrink-0 px-4 py-2 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 flex items-center gap-2 flex-wrap">
        {/* Connection status */}
        <div className="flex items-center gap-1.5 text-sm mr-2">
          <Circle
            className={`w-2.5 h-2.5 ${connected ? 'fill-green-500 text-green-500' : 'fill-red-500 text-red-500'}`}
          />
          <span className="text-zinc-500 dark:text-zinc-400">{connected ? '已连接' : '未连接'}</span>
        </div>

        {/* Line count */}
        <span className="text-xs text-zinc-400 dark:text-zinc-500 mr-2">
          {filteredLines.length} 行{filter && ` (共 ${lines.length})`}
          {paused && bufferRef.current.length > 0 && (
            <span className="text-amber-500"> +{bufferRef.current.length} 缓冲</span>
          )}
        </span>

        <div className="flex-1" />

        {/* Filter toggle */}
        <button
          type="button"
          onClick={() => setShowFilter((v) => !v)}
          className={`p-1.5 rounded transition-colors ${
            showFilter || filter
              ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400'
              : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
          }`}
          title="过滤"
        >
          <Search className="w-4 h-4" />
        </button>

        {/* Pause / Resume */}
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className={`p-1.5 rounded transition-colors ${
            paused
              ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400'
              : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
          }`}
          title={paused ? '继续' : '暂停'}
        >
          {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
        </button>

        {/* Clear */}
        <button
          type="button"
          onClick={clearLines}
          className="p-1.5 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
          title="清空"
        >
          <Trash2 className="w-4 h-4" />
        </button>

        {/* Reconnect */}
        <button
          type="button"
          onClick={reconnect}
          className="p-1.5 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
          title="重连"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      {/* Filter bar */}
      {showFilter && (
        <div className="shrink-0 px-4 py-1.5 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="输入关键字过滤日志..."
            className="w-full max-w-md px-3 py-1 text-sm rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      )}

      {/* Log output */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto bg-zinc-950 text-zinc-200 font-mono text-[13px] leading-5 p-3 selection:bg-blue-800/50"
      >
        {filteredLines.length === 0 ? (
          <div className="text-zinc-500 text-center py-12">{connected ? '等待日志...' : '正在连接...'}</div>
        ) : (
          filteredLines.map((line) => (
            <div
              key={line.id}
              className={`whitespace-pre-wrap break-all ${line.source === 'stderr' ? 'text-red-400' : ''}`}
            >
              {line.text}
            </div>
          ))
        )}
      </div>

      {/* Scroll-to-bottom FAB */}
      {!autoScroll && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-6 right-6 p-2.5 rounded-full bg-blue-600 text-white shadow-lg hover:bg-blue-700 transition-colors"
          title="滚动到底部"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
