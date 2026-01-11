// Prompt Manager - manages prompt templates
// Part of AI module - prompt management is integrated into AI scope

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '@/utils/logger';

export interface PromptTemplate {
  name: string;
  content: string;
  variables?: string[]; // List of variable names used in template
}

/**
 * Prompt Manager - manages and loads prompt templates
 */
export class PromptManager {
  private templates = new Map<string, PromptTemplate>();
  private templateDirectory: string;

  constructor(templateDirectory?: string) {
    this.templateDirectory = templateDirectory || resolve(process.cwd(), 'prompts');
  }

  /**
   * Load prompt template from file
   */
  loadTemplate(name: string, filePath: string): void {
    try {
      const resolvedPath = resolve(filePath);
      if (!existsSync(resolvedPath)) {
        throw new Error(`Template file not found: ${resolvedPath}`);
      }

      const content = readFileSync(resolvedPath, 'utf-8');
      const variables = this.extractVariables(content);

      this.templates.set(name, {
        name,
        content,
        variables,
      });

      logger.info(`[PromptManager] Loaded template: ${name} from ${resolvedPath}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`[PromptManager] Failed to load template ${name}:`, err);
      throw err;
    }
  }

  /**
   * Register prompt template
   */
  registerTemplate(template: PromptTemplate): void {
    this.templates.set(template.name, template);
    logger.info(`[PromptManager] Registered template: ${template.name}`);
  }

  /**
   * Get template by name
   */
  getTemplate(name: string): PromptTemplate | null {
    return this.templates.get(name) || null;
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
      logger.warn(
        `[PromptManager] Unresolved variables in template ${name}: ${unresolved.join(', ')}`,
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
}
