/**
 * ProjectRegistry - manages known projects for multi-project Claude Code tasks
 *
 * Supports:
 * - Alias-based project resolution
 * - Path-based resolution (with whitelist validation)
 * - Auto-detection of project type
 * - Runtime registration/unregistration of projects
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';

export interface ProjectEntry {
  /** Unique alias for referencing in commands */
  alias: string;
  /** Absolute path */
  path: string;
  /** Project type, influences prompt template and quality checks */
  type: 'bun' | 'node' | 'python' | 'rust' | 'generic';
  /** Custom prompt template key (optional, overrides auto-detection) */
  promptTemplateKey?: string;
  /** Project description (injected into prompt context) */
  description?: string;
  /** Whether the project has a CLAUDE.md file (auto-detected at runtime) */
  hasClaudeMd: boolean;
}

/** Serializable format for persisted projects */
interface PersistedProject {
  alias: string;
  path: string;
  type?: ProjectEntry['type'];
  description?: string;
  promptTemplateKey?: string;
}

export interface ProjectRegistryOptions {
  /** Security whitelist: only allow projects under these directories */
  allowedBasePaths?: string[];
  /** Default project alias */
  defaultProject?: string;
  /** Pre-registered projects from config */
  projects?: Array<PersistedProject>;
  /** Path to persist dynamically added projects (default: data/projects.json) */
  persistPath?: string;
}

/** System directories that are always forbidden */
const FORBIDDEN_PATHS = ['/', '/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/boot', '/dev', '/proc', '/sys'];

export class ProjectRegistry {
  private projects = new Map<string, ProjectEntry>();
  /** Aliases that come from config — these cannot be removed via commands */
  private configAliases = new Set<string>();
  private allowedBasePaths: string[];
  private defaultProject: string;
  private persistPath: string;

  constructor(options: ProjectRegistryOptions | undefined = {}) {
    const opts = options ?? {};
    this.allowedBasePaths = (opts.allowedBasePaths ?? [process.cwd()]).map((p) => resolve(p));
    this.defaultProject = opts.defaultProject ?? 'default';
    this.persistPath = opts.persistPath || resolve(getRepoRoot(), 'data/projects.json');

    // 1. Register config projects (immutable via commands)
    for (const proj of options.projects ?? []) {
      try {
        this.register(proj);
        this.configAliases.add(proj.alias);
      } catch (error) {
        logger.warn(`[ProjectRegistry] Failed to register config project "${proj.alias}":`, error);
      }
    }

    // 2. Load and merge persisted dynamic projects
    this.reloadProjects();

    logger.info(
      `[ProjectRegistry] Initialized with ${this.projects.size} projects (${this.configAliases.size} from config)`,
    );
  }

  /**
   * Resolve a project identifier to a ProjectEntry.
   *
   * Supports:
   * - alias: "myapi" → lookup from registry
   * - absolute path: "/home/user/projects/foo" → validate and use directly
   * - home-relative: "~/projects/foo" → expand and validate
   * - undefined: return default project
   */
  resolve(identifier?: string): ProjectEntry | null {
    // No identifier → use default
    if (!identifier) {
      return this.projects.get(this.defaultProject) ?? null;
    }

    // Try alias lookup first
    let byAlias = this.projects.get(identifier);
    if (byAlias) {
      return byAlias;
    }

    // Alias miss — reload from file in case new projects were added at runtime
    this.reloadProjects();
    byAlias = this.projects.get(identifier);
    if (byAlias) {
      return byAlias;
    }

    // Try as path
    let resolvedPath: string;
    if (identifier.startsWith('~')) {
      const home = process.env.HOME || process.env.USERPROFILE || '/home';
      resolvedPath = resolve(home, identifier.slice(2));
    } else if (identifier.startsWith('/')) {
      resolvedPath = resolve(identifier);
    } else {
      // Not a recognized format
      return null;
    }

    // Validate path
    if (!this.validatePath(resolvedPath)) {
      logger.warn(`[ProjectRegistry] Path not in allowed base paths: ${resolvedPath}`);
      return null;
    }

    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
      return null;
    }

    // Create a temporary entry for path-based resolution
    const type = this.detectProjectType(resolvedPath);
    const hasClaudeMd = existsSync(resolve(resolvedPath, 'CLAUDE.md'));
    const alias = resolvedPath.split('/').pop() || 'unknown';

    return {
      alias,
      path: resolvedPath,
      type,
      hasClaudeMd,
    };
  }

  /**
   * Register a new project (internal, does not persist)
   */
  register(entry: Omit<ProjectEntry, 'hasClaudeMd' | 'type'> & { type?: ProjectEntry['type'] }): ProjectEntry {
    const resolvedPath = resolve(entry.path);

    if (!this.validatePath(resolvedPath)) {
      throw new Error(`Path not in allowed base paths: ${resolvedPath}`);
    }

    const type = entry.type || this.detectProjectType(resolvedPath);
    const hasClaudeMd = existsSync(resolve(resolvedPath, 'CLAUDE.md'));

    const project: ProjectEntry = {
      alias: entry.alias,
      path: resolvedPath,
      type,
      promptTemplateKey: entry.promptTemplateKey,
      description: entry.description,
      hasClaudeMd,
    };

    this.projects.set(entry.alias, project);
    logger.info(`[ProjectRegistry] Registered project "${entry.alias}" at ${resolvedPath} (type: ${type})`);
    return project;
  }

  /**
   * Register a project dynamically and persist to file.
   * Config-defined projects with the same alias will NOT be overwritten.
   */
  addProject(entry: Omit<ProjectEntry, 'hasClaudeMd' | 'type'> & { type?: ProjectEntry['type'] }): ProjectEntry {
    if (this.configAliases.has(entry.alias)) {
      throw new Error(`项目 "${entry.alias}" 由配置文件定义，无法通过命令覆盖`);
    }

    const project = this.register(entry);
    this.savePersistedProjects();
    return project;
  }

  /**
   * List all registered projects
   */
  list(): ProjectEntry[] {
    return Array.from(this.projects.values());
  }

  /**
   * Check if a project is defined in config (immutable via commands)
   */
  isConfigProject(alias: string): boolean {
    return this.configAliases.has(alias);
  }

  /**
   * Unregister a project by alias (only dynamic projects can be removed)
   */
  unregister(alias: string): boolean {
    if (this.configAliases.has(alias)) {
      throw new Error(`项目 "${alias}" 由配置文件定义，无法通过命令删除。请修改配置文件。`);
    }

    const removed = this.projects.delete(alias);
    if (removed) {
      this.savePersistedProjects();
      logger.info(`[ProjectRegistry] Unregistered project "${alias}"`);
    }
    return removed;
  }

  /**
   * Get the default project alias
   */
  getDefaultProject(): string {
    return this.defaultProject;
  }

  /**
   * Reload dynamic projects from the persist file.
   * Clears all non-config projects first, then re-reads the file.
   * Called automatically on startup and when resolve() misses a lookup.
   */
  reloadProjects(): void {
    // Remove all dynamic (non-config) projects before reloading
    for (const alias of this.projects.keys()) {
      if (!this.configAliases.has(alias)) {
        this.projects.delete(alias);
      }
    }

    if (!existsSync(this.persistPath)) {
      return;
    }

    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const persisted: PersistedProject[] = JSON.parse(raw);

      if (!Array.isArray(persisted)) {
        logger.warn('[ProjectRegistry] Invalid persisted projects file, expected array');
        return;
      }

      let loaded = 0;
      for (const proj of persisted) {
        // Config projects win — skip duplicates
        if (this.configAliases.has(proj.alias)) {
          continue;
        }
        try {
          this.register(proj);
          loaded++;
        } catch (error) {
          logger.warn(`[ProjectRegistry] Failed to load persisted project "${proj.alias}":`, error);
        }
      }

      if (loaded > 0) {
        logger.info(`[ProjectRegistry] Loaded ${loaded} project(s) from ${this.persistPath}`);
      }
    } catch (error) {
      logger.warn('[ProjectRegistry] Failed to read persisted projects:', error);
    }
  }

  /**
   * Save all dynamic (non-config) projects to the persist file.
   */
  private savePersistedProjects(): void {
    const dynamicProjects: PersistedProject[] = [];

    for (const [alias, entry] of this.projects) {
      if (this.configAliases.has(alias)) {
        continue;
      }
      dynamicProjects.push({
        alias: entry.alias,
        path: entry.path,
        type: entry.type,
        description: entry.description,
        promptTemplateKey: entry.promptTemplateKey,
      });
    }

    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.persistPath, JSON.stringify(dynamicProjects, null, 2), 'utf-8');
      logger.info(`[ProjectRegistry] Saved ${dynamicProjects.length} dynamic project(s) to ${this.persistPath}`);
    } catch (error) {
      logger.error('[ProjectRegistry] Failed to save persisted projects:', error);
    }
  }

  /**
   * Auto-detect project type by checking for known config files
   */
  private detectProjectType(projectPath: string): ProjectEntry['type'] {
    // Check for bun-specific files first
    if (existsSync(resolve(projectPath, 'bun.lockb')) || existsSync(resolve(projectPath, 'bunfig.toml'))) {
      return 'bun';
    }

    // Check for package.json (Node or Bun)
    if (existsSync(resolve(projectPath, 'package.json'))) {
      try {
        const pkg = JSON.parse(require('node:fs').readFileSync(resolve(projectPath, 'package.json'), 'utf-8'));
        // If scripts reference bun, it's a bun project
        const scripts = JSON.stringify(pkg.scripts || {});
        if (scripts.includes('bun ')) {
          return 'bun';
        }
      } catch {
        // ignore parse errors
      }
      return 'node';
    }

    // Rust
    if (existsSync(resolve(projectPath, 'Cargo.toml'))) {
      return 'rust';
    }

    // Python
    if (
      existsSync(resolve(projectPath, 'pyproject.toml')) ||
      existsSync(resolve(projectPath, 'setup.py')) ||
      existsSync(resolve(projectPath, 'requirements.txt'))
    ) {
      return 'python';
    }

    return 'generic';
  }

  /**
   * Validate that a path is within allowed base paths.
   * Resolves symlinks and prevents path traversal.
   */
  private validatePath(targetPath: string): boolean {
    const resolved = resolve(targetPath);

    // Check forbidden system paths
    if (FORBIDDEN_PATHS.includes(resolved)) {
      return false;
    }

    // Prevent path traversal via ..
    if (resolved.includes('/..') || resolved.includes('\\..')) {
      return false;
    }

    // Resolve symlinks if the path exists
    let realPath = resolved;
    try {
      if (existsSync(resolved)) {
        realPath = realpathSync(resolved);
      }
    } catch {
      // If we can't resolve, use the original
    }

    // Check against allowed base paths
    return this.allowedBasePaths.some((base) => realPath === base || realPath.startsWith(`${base}/`));
  }
}
