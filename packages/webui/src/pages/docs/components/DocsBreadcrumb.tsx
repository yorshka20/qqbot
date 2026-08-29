export function DocsBreadcrumb({
  rootId,
  dirPath,
  onNavigate,
}: {
  rootId: string;
  dirPath: string;
  onNavigate: (path: string) => void;
}) {
  const segments = dirPath ? dirPath.split('/').filter(Boolean) : [];

  return (
    <nav className="flex flex-wrap items-center gap-1" aria-label="路径">
      <button
        type="button"
        className="rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-700"
        onClick={() => onNavigate('')}
      >
        {rootId}
      </button>
      {segments.map((seg, i) => {
        const full = segments.slice(0, i + 1).join('/');
        const isLast = i === segments.length - 1;
        return (
          <span key={full} className="flex items-center gap-1">
            <span className="text-zinc-400">/</span>
            {isLast ? (
              <span className="text-zinc-900 dark:text-zinc-100 font-medium">{seg}</span>
            ) : (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                onClick={() => onNavigate(full)}
              >
                {seg}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
