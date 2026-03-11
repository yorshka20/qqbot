interface BreadcrumbProps {
  path: string
  onNavigate: (path: string) => void
}

export function Breadcrumb({ path, onNavigate }: BreadcrumbProps) {
  const segments = path ? path.split('/').filter(Boolean) : []

  return (
    <nav className="flex items-center gap-1 text-sm text-zinc-600 dark:text-zinc-400" aria-label="Breadcrumb">
      <button
        type="button"
        onClick={() => onNavigate('')}
        className="rounded px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-100 font-medium"
      >
        output
      </button>
      {segments.map((segment, i) => {
        const fullPath = segments.slice(0, i + 1).join('/')
        const isLast = i === segments.length - 1
        return (
          <span key={fullPath} className="flex items-center gap-1">
            <span className="text-zinc-400 dark:text-zinc-600">/</span>
            {isLast ? (
              <span className="text-zinc-900 dark:text-zinc-100 font-medium px-2 py-1">{segment}</span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(fullPath)}
                className="rounded px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-100 font-medium"
              >
                {segment}
              </button>
            )}
          </span>
        )
      })}
    </nav>
  )
}
