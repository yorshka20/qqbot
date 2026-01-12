// Prompt Manager - manages prompt templates
// Part of AI module - prompt management is integrated into AI scope

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

/**
 * Prompt Manager - manages and loads prompt templates
 * Supports batch loading from directories, namespaces, and versioning
 */
export class PromptManager {
  private templates = new Map<string, PromptTemplate>();
  private templateDirectory: string;
  private namespaces = new Map<string, Map<string, PromptTemplate>>(); // namespace -> templates

  constructor(templateDirectory?: string) {
    this.templateDirectory = templateDirectory || resolve(process.cwd(), 'prompts');
  }

  /**
   * Load prompt template from file
   */
  loadTemplate(name: string, filePath: string, namespace?: string): void {
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

      // Also register in namespace
      if (namespace) {
        if (!this.namespaces.has(namespace)) {
          this.namespaces.set(namespace, new Map());
        }
        this.namespaces.get(namespace)!.set(name, template);
      }

      logger.info(
        `[PromptManager] Loaded template: ${name} from ${resolvedPath}${namespace ? ` (namespace: ${namespace})` : ''}`,
      );
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
    logger.info(`[PromptManager] Loaded templates from directory: ${dir}`);
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
          if (ext === '.txt' || ext === '.md' || ext === '.prompt') {
            const templateName = basename(entry, ext);
            // Use full namespace path as template name if namespace exists
            const fullName = namespace ? `${namespace}.${templateName}` : templateName;
            this.loadTemplate(fullName, fullPath, namespace || undefined);
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
   * Render template with variables
   */
  render(name: string, variables: Record<string, string>): string {
    const template = this.getTemplate(name);
    if (!template) {
      throw new Error(`Template "${name}" not found`);
    }

    let rendered = template.content;

    // Simple variable replacement: {{variableName}}
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      rendered = rendered.replace(regex, value);
    }

    // Check for unresolved variables
    const unresolved = rendered.match(/\{\{(\w+)\}\}/g);
    if (unresolved) {
      logger.warn(`[PromptManager] Unresolved variables in template ${name}: ${unresolved.join(', ')}`);
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
