// Prompt Manager - manages prompt templates
// Part of AI module - prompt management is integrated into AI scope

import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, extname, join, resolve } from 'path';

export interface PromptTemplate {
  name: string;
  content: string;
  variables?: string[]; // List of variable names used in template
  namespace?: string; // Namespace/category (e.g., 'llm', 'vision')
  version?: string; // Template version
}

/** Reserved template name for base prompt (file: prompts/base.txt). Injected into all rendered prompts by default. */
const BASE_TEMPLATE_NAME = 'base';

export interface RenderOptions {
  /** When true, prepend the base prompt. Default is false; set true where a flow needs base context (typically once per flow). */
  injectBase?: boolean;
}

/**
 * Prompt Manager - manages and loads prompt templates
 * Supports batch loading from directories, namespaces, and versioning.
 * If a template named "base" exists (e.g. prompts/base.txt), it is prepended only when render() is called with injectBase: true.
 */
export class PromptManager {
  private templates = new Map<string, PromptTemplate>();
  private templateDirectory: string;
  private namespaces = new Map<string, Map<string, PromptTemplate>>(); // namespace -> templates
  /** Current message context set by pipeline before processing; used by injectBase to resolve groupId and userInfo. */
  private currentMessageContext: { message: NormalizedMessageEvent } | null = null;
  /** Bot owner user id from config (bot.owner); used by injectBase for {{adminUserId}}. */
  private readonly adminUserId: string;

  constructor(templateDirectory?: string, adminUserId?: string) {
    this.templateDirectory = templateDirectory || resolve(process.cwd(), 'prompts');
    this.adminUserId = adminUserId ?? '';
  }

  /**
   * Set current message context for base prompt injection (groupId, userInfo).
   * Pipeline should call this at the start of message processing and clear with setCurrentMessageContext(null) when done.
   */
  setCurrentMessageContext(ctx: { message: NormalizedMessageEvent } | null): void {
    this.currentMessageContext = ctx;
  }

  /**
   * Load prompt template from file
   */
  loadTemplate(name: string, filePath: string, namespace: string): void {
    // Skip README file
    if (name === 'README') {
      return;
    }

    try {
      const resolvedPath = resolve(filePath);
      if (!existsSync(resolvedPath)) {
        throw new Error(`Template file not found: ${resolvedPath}`);
      }

      const content = readFileSync(resolvedPath, 'utf-8');
      const variables = this.extractVariables(content);

      const template: PromptTemplate = {
        name,
        content,
        variables,
        namespace,
      };

      this.templates.set(name, template);

      if (!this.namespaces.has(namespace)) {
        this.namespaces.set(namespace, new Map());
      }
      this.namespaces.get(namespace)!.set(name, template);

      logger.info(`[PromptManager] Loaded template: ${name} from ${resolvedPath} (namespace: ${namespace})`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`[PromptManager] Failed to load template ${name}:`, err);
      throw err;
    }
  }

  /**
   * Load all prompt templates from a directory (recursive)
   * Supports directory structure like:
   *   prompts/
   *     llm/
   *       reply.txt
   *     vision/
   *       image-description.txt
   */
  loadTemplatesFromDirectory(directory?: string): void {
    const dir = directory || this.templateDirectory;

    if (!existsSync(dir)) {
      logger.warn(`[PromptManager] Template directory does not exist: ${dir}`);
      return;
    }

    this.loadTemplatesRecursive(dir, '');
  }

  /**
   * Recursively load templates from directory
   */
  private loadTemplatesRecursive(dir: string, namespace: string): void {
    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          // Directory becomes a namespace
          const newNamespace = namespace ? `${namespace}.${entry}` : entry;
          this.loadTemplatesRecursive(fullPath, newNamespace);
        } else if (stat.isFile()) {
          // Load template file
          const ext = extname(entry).toLowerCase();
          if (ext === '.txt' || ext === '.md' || ext === '.prompt' || ext === '.local') {
            const templateName = basename(entry, ext);
            // Use full namespace path as template name if namespace exists
            const fullName = namespace ? `${namespace}.${templateName}` : templateName;
            this.loadTemplate(fullName, fullPath, namespace);
          }
        }
      }
    } catch (error) {
      logger.warn(`[PromptManager] Failed to load templates from ${dir}:`, error);
    }
  }

  /**
   * Register prompt template
   */
  registerTemplate(template: PromptTemplate): void {
    this.templates.set(template.name, template);

    // Also register in namespace
    if (template.namespace) {
      if (!this.namespaces.has(template.namespace)) {
        this.namespaces.set(template.namespace, new Map());
      }
      this.namespaces.get(template.namespace)!.set(template.name, template);
    }

    logger.info(
      `[PromptManager] Registered template: ${template.name}${template.namespace ? ` (namespace: ${template.namespace})` : ''}`,
    );
  }

  /**
   * Get template by name
   */
  getTemplate(name: string): PromptTemplate | null {
    return this.templates.get(name) || null;
  }

  /**
   * Get templates by namespace
   */
  getTemplatesByNamespace(namespace: string): PromptTemplate[] {
    const namespaceTemplates = this.namespaces.get(namespace);
    if (!namespaceTemplates) {
      return [];
    }
    return Array.from(namespaceTemplates.values());
  }

  /**
   * Render template with variables.
   * If a base template exists (prompts/base.txt), its content is prepended only when options.injectBase is true.
   */
  render(name: string, variables: Record<string, string>, options?: RenderOptions): string {
    const template = this.getTemplate(name);
    if (!template) {
      throw new Error(`Template "${name}" not found`);
    }

    const mainRendered = this.renderTemplateContent(template, name, variables);

    if (!options?.injectBase) {
      return mainRendered;
    }

    const baseTemplate = this.getTemplate(BASE_TEMPLATE_NAME);
    if (baseTemplate) {
      // Inject base template; groupId and userInfo are resolved from current message context (set by pipeline).
      const msg = this.currentMessageContext?.message;
      const groupId =
        msg?.messageType === 'group' && msg?.groupId != null ? String(msg.groupId) : '（无）';
      const userInfo = msg
        ? `userId：${msg.userId}，nickname：${msg.sender?.nickname ?? '未知'}`
        : '（无）';
      const baseVars: Record<string, string> = {
        currentDate: new Date().toLocaleDateString('zh-CN', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          weekday: 'long',
        }),
        groupId,
        userInfo,
        adminUserId: this.adminUserId || '（无管理员）',
      };
      const baseRendered = this.renderTemplateContent(baseTemplate, BASE_TEMPLATE_NAME, baseVars);
      return baseRendered ? `${baseRendered}\n\n${mainRendered}` : mainRendered;
    }

    return mainRendered;
  }

  /**
   * Render a single template's content with variable substitution (no base injection).
   */
  private renderTemplateContent(
    template: PromptTemplate,
    templateName: string,
    variables: Record<string, string>,
  ): string {
    let rendered = template.content;

    // Simple variable replacement: {{variableName}}
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      rendered = rendered.replace(regex, value);
    }

    // Check for unresolved variables
    const unresolved = rendered.match(/\{\{(\w+)\}\}/g);
    if (unresolved) {
      logger.warn(
        `[PromptManager] Unresolved variables in template ${templateName}: ${unresolved.join(', ')}`,
      );
    }

    return rendered;
  }

  /**
   * Extract variable names from template content
   */
  private extractVariables(content: string): string[] {
    const matches = content.matchAll(/\{\{(\w+)\}\}/g);
    const variables = new Set<string>();

    for (const match of matches) {
      variables.add(match[1]);
    }

    return Array.from(variables);
  }

  /**
   * Get all registered templates
   */
  getAllTemplates(): PromptTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get all namespaces
   */
  getNamespaces(): string[] {
    return Array.from(this.namespaces.keys());
  }
}
