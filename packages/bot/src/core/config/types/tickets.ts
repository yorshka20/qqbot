/**
 * Tickets storage configuration.
 *
 * Tickets are cross-repo work units: each ticket has a `project` frontmatter
 * field that points at a ClaudeCode project alias, and the cluster resolves
 * that alias to the real repo path at dispatch time. Storing tickets inside
 * the qqbot repo forces every project's work items to be committed into
 * qqbot's git history, which is awkward when the ticket targets a different
 * codebase. This config lets the tickets directory live anywhere on disk —
 * typically a dedicated `cluster-tickets` repo shared across bot instances.
 *
 * Callsites that consume this directory:
 *   - `TicketBackend`                (read/write ticket markdown + results)
 *   - `ContextHub.handleWritePlan`   (write `<ticketsDir>/<id>/plan.md`)
 *   - `ContextHub.handleReadPlan`    (read that same plan)
 *   - `ClusterTicketWriteback`       (write job results into `<ticketsDir>/<id>/results/`)
 *
 * The ticket body template (`.templates/ticket.md` under the tickets dir)
 * also lives here so new ticket skeletons are version-controlled alongside
 * the tickets themselves.
 */
export interface TicketsConfig {
  /**
   * Filesystem directory where ticket markdown lives. Absolute path
   * recommended. Relative paths resolve against the repo root (resolved via
   * `getRepoRoot()`, independent of launch cwd). Defaults to
   * `tickets` (i.e. `<repoRoot>/tickets`) when the whole `tickets` block is
   * absent, preserving the pre-externalization behavior.
   */
  dir: string;
}
