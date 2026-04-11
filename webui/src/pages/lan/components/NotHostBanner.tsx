/**
 * Friendly banner shown when the LAN page is loaded on an instance that
 * isn't running in `lanRelay.instanceRole = "host"`. The page is still
 * reachable on client/disabled instances (we don't 403/redirect — see
 * webui.md "LAN Relay 页面注意点"), but every other endpoint returns 503
 * so the rest of the page would be empty.
 */
export function NotHostBanner({ role }: { role: 'host' | 'client' | null }) {
  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm text-amber-900 dark:text-amber-200">
      <div className="font-semibold mb-1">Not in host mode</div>
      <div>
        The LAN page only works on a bot instance configured as
        <code className="mx-1 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60 font-mono text-xs">
          lanRelay.instanceRole = "host"
        </code>
        . Current role:{' '}
        <code className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60 font-mono text-xs">
          {role ?? 'disabled'}
        </code>
        . Open the host machine's WebUI to manage LAN clients.
      </div>
    </div>
  );
}
