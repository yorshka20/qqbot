/**
 * Shared hooks and small components for Moments views.
 */

import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

export function useDarkMode() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return isDark
}

export function useChartTooltipStyle(isDark: boolean) {
  return {
    backgroundColor: isDark ? '#27272a' : '#fff',
    border: `1px solid ${isDark ? '#3f3f46' : '#e4e4e7'}`,
    borderRadius: '8px',
    color: isDark ? '#fafafa' : '#18181b',
    fontSize: 13,
  }
}

export function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12 text-zinc-400 gap-2">
      <Loader2 className="w-4 h-4 animate-spin" />
      加载中...
    </div>
  )
}

export function EmptyState({ text }: { text: string }) {
  return <div className="text-center py-12 text-zinc-400 text-sm">{text}</div>
}
