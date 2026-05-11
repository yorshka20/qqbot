/**
 * Configuration for the WebUI docs preview backend
 * (`DocsPreviewBackend`, served under `/api/docs/*`).
 *
 * Three built-in roots always exist: `docs`, `claude-learnings`, `claude-workbook`
 * (mapped to `<repoRoot>/docs`, `<repoRoot>/.claude-learnings`,
 * `<repoRoot>/.claude-workbook`). This config adds extra roots — typically
 * a full repo root or a `packages/<name>/src` subtree — so the WebUI doc
 * browser can read any project file.
 *
 * Security note: this backend is intended for local-only WebUI access.
 * Path traversal is blocked by `resolveSafe()`, but no secret-file filtering
 * is performed — exposed roots will surface `config.jsonc`, `.env`, etc.
 * Do not enable extra roots covering sensitive trees on a network-exposed
 * deployment.
 */
export interface DocsPreviewRootConfig {
  /** Stable id used in URLs and the WebUI dropdown. Must not collide with the
   * three built-in ids (`docs`, `claude-learnings`, `claude-workbook`). */
  id: string;
  /** Human-readable label shown in the WebUI root dropdown. */
  label: string;
  /** Absolute path, or relative path resolved against the monorepo root. */
  path: string;
}

export interface DocsPreviewConfig {
  /**
   * Extra roots to expose in the docs preview backend. Appended to the
   * built-in three roots. Ids must be unique across built-ins + extras
   * (duplicate ids are ignored with a warning).
   */
  roots?: DocsPreviewRootConfig[];
  /**
   * Directory/file names to hide from `readdir` listings (string match on
   * the entry's basename). Merged with a built-in noise deny-list
   * (`node_modules`, `.git`, `dist`, `build`, `coverage`, `.turbo`, `.cache`,
   * `output`, `.next`, `.DS_Store`) — user entries are **append-only**, the
   * built-ins cannot be disabled here.
   */
  exclude?: string[];
}
