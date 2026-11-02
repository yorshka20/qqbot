// Prompt Manager - manages prompt templates
// Part of AI module - prompt management is integrated into AI scope

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { getCurrentDateHourForPrompt, getRepoRoot, logger } from '@qqbot/shared';
import { PromptMessageAssembler } from './PromptMessageAssembler';

export interface PromptTemplate {
  name: string;
  content: string;
  variables?: string[]; // List of variable names used in template
  namespace?: string; // Namespace/category (e.g., 'llm', 'vision')
  version?: string; // Template version
}

/** Reserved template name for base prompt (file: prompts/base.txt). */
const BASE_TEMPLATE_NAME = 'base';
const BASE_SYSTEM_TEMPLATE_NAME = 'base.system';

const PARTIAL_RE = /\{\{>\s*([\w.-]+)((?:\s+\w+="[^"]*")*)\s*\}\}/g;
const PARTIAL_PARAM_RE = /(\w+)="([^"]*)"/g;
const PARTIAL_SLOT_RE = /\uE000(\d+)\uE001/g;

interface PartialInclude {
  name: string;
  params: Record<string, string>;
}

/**
 * Prompt Manager - manages and loads prompt templates
 * Supports batch loading from directories, namespaces, and versioning.
 * Template "base" (prompts/base.txt) is rendered independently via renderBasePrompt()
 * and should be sent as system role instead of being inlined into user prompts.
 */
export class PromptManager {
  private templates = new Map<string, PromptTemplate>();
  private templateDirectory: string;
  private namespaces = new Map<string, Map<string, PromptTemplate>>(); // namespace -> templates
  /** Bot owner user id from config (bot.owner); used by renderBasePrompt() for {{adminUserId}}. */
  readonly adminUserId: string;
  /** Bot's own QQ id (bot.selfId); injected into base prompt as {{botSelfId}}. */
  readonly botSelfId: string;
  /** Bot's display nickname (bot.nickname); injected into base prompt as {{botNickname}}. */
  readonly botNickname: string;
  /**
   * Single shared {@link PromptMessageAssembler}, configured with the bot's
   * identity. Held here because both the reply pipeline (PromptAssemblyStage)
   * and ProactiveReplyGenerationService need the same instance — separate
   * `new` calls in each consumer would duplicate state for no reason.
   */
  readonly messageAssembler: PromptMessageAssembler;

  constructor(templateDirectory?: string, adminUserId?: string, botSelfId?: string, botNickname?: string) {
    this.templateDirectory = templateDirectory || resolve(getRepoRoot(), 'prompts');
    this.adminUserId = adminUserId ?? '';
    this.botSelfId = botSelfId ?? '';
    this.botNickname = botNickname ?? '';
    this.messageAssembler = new PromptMessageAssembler();

    this.loadTemplatesFromDirectory();
  }

  /**
   * Load prompt template from file
   */
  private loadTemplate(name: string, filePath: string, namespace: string): void {
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

      let namespaceMap = this.namespaces.get(namespace);
      if (!namespaceMap) {
        namespaceMap = new Map();
        this.namespaces.set(namespace, namespaceMap);
      }
      namespaceMap.set(name, template);

      // logger.info(`[PromptManager] Loaded template: ${name} from ${resolvedPath} (namespace: ${namespace})`);
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
   *     preference/
   *       {preferenceKey}/
   *         full.txt
   *         trigger.txt
   *       ...
   */
  private loadTemplatesFromDirectory(directory?: string): void {
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
      let namespaceMap = this.namespaces.get(template.namespace);
      if (!namespaceMap) {
        namespaceMap = new Map();
        this.namespaces.set(template.namespace, namespaceMap);
      }
      namespaceMap.set(template.name, template);
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
   * Render template with variables (single template only, no base injection).
   */
  render(name: string, variables?: Record<string, string>): string {
    return this.renderByName(name, variables, []);
  }

  private renderByName(name: string, variables: Record<string, string> | undefined, includeChain: string[]): string {
    const template = this.getTemplate(name);
    if (!template) {
      throw new Error(`Template "${name}" not found`);
    }

    return this.renderTemplateContent(template, name, variables, includeChain);
  }

  /**
   * Render a `{{> name key="value" ...}}` partial. A partial sees its own `key="value"`
   * parameters only — never the includer's variables — so one shared fragment says
   * exactly what its parameters say at every place that includes it.
   */
  private renderPartial(include: PartialInclude, includeChain: string[]): string {
    if (includeChain.includes(include.name)) {
      throw new Error(`Prompt partial cycle: ${[...includeChain, include.name].join(' → ')}`);
    }
    return this.renderByName(include.name, include.params, includeChain);
  }

  /**
   * Render a single template's content with variable substitution (no base injection).
   */
  private renderTemplateContent(
    template: PromptTemplate,
    templateName: string,
    variables?: Record<string, string>,
    includeChain: string[] = [],
  ): string {
    // Include tags become opaque slots while the includer renders, and are filled last:
    // the includer's conditionals decide whether a slot survives, but neither its
    // variables reach into a partial's output nor can a substituted value (user text)
    // smuggle in an include tag of its own.
    const includes: PartialInclude[] = [];
    let rendered = template.content.replace(PARTIAL_RE, (_match, name: string, rawParams: string) => {
      const params: Record<string, string> = {};
      for (const [, key, value] of rawParams.matchAll(PARTIAL_PARAM_RE)) {
        params[key] = value;
      }
      includes.push({ name, params });
      return `\uE000${includes.length - 1}\uE001`;
    });

    // Process {{#if var}}...{{else}}...{{/if}} blocks (supports nesting)
    if (variables) {
      rendered = this.processConditionalBlocks(rendered, variables);
    }

    if (variables) {
      // Simple variable replacement: {{variableName}}
      for (const [key, value] of Object.entries(variables)) {
        const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
        rendered = rendered.replace(regex, value);
      }
    }

    // Check for unresolved variables (exclude block syntax remnants)
    const unresolved = rendered.match(/\{\{(?!#|\/|else)(\w+)\}\}/g);
    if (unresolved) {
      logger.warn(`[PromptManager] Unresolved variables in template ${templateName}: ${unresolved.join(', ')}`);
    }

    if (includes.length > 0) {
      const chain = [...includeChain, templateName];
      rendered = rendered.replace(PARTIAL_SLOT_RE, (_match, index: string) =>
        this.renderPartial(includes[Number(index)], chain),
      );
    }

    return rendered.trim();
  }

  /**
   * Process {{#if var}}...{{else}}...{{/if}} conditional blocks.
   * A variable is truthy if it exists, is non-empty, and is not "false" or "0".
   * Supports nested blocks.
   */
  private processConditionalBlocks(content: string, variables: Record<string, string>): string {
    // Process from innermost blocks outward by repeating until no more blocks
    let result = content;
    let maxIterations = 20;

    while (maxIterations-- > 0) {
      // Match the innermost {{#if var}}...{{/if}} (no nested #if inside)
      const ifRegex = /\{\{#if\s+(\w+)\}\}((?:(?!\{\{#if)[\s\S])*?)\{\{\/if\}\}/;
      const match = ifRegex.exec(result);
      if (!match) break;

      const varName = match[1];
      const blockContent = match[2];
      const value = variables[varName];
      const isTruthy = value !== undefined && value !== '' && value !== 'false' && value !== '0';

      // Split on {{else}} if present
      const elseParts = blockContent.split(/\{\{else\}\}/);
      const ifBranch = elseParts[0];
      const elseBranch = elseParts.length > 1 ? elseParts.slice(1).join('{{else}}') : '';

      const replacement = isTruthy ? ifBranch : elseBranch;
      result = result.slice(0, match.index) + replacement + result.slice(match.index + match[0].length);
    }

    return result;
  }

  /**
   * @shim — Legacy renderer for the base.system template.
   *
   * As of the producer-driven prompt refactor (commit ffadab5), the main
   * reply pipeline (PromptAssemblyStage) **no longer** calls this method.
   * It now consumes a BaselineProducer registered with
   * PromptInjectionRegistry, which internally calls renderBasePrompt to
   * produce the same content but routed through the layered injection
   * model.
   *
   * This method is retained ONLY for sideline services that still build
   * their own prompts directly (not through PromptInjectionRegistry):
   *   - MemoryExtractService   (packages/bot/src/memory/MemoryExtractService.ts)
   *   - NsfwReplyService       (packages/bot/src/ai/services/NsfwReplyService.ts)
   *   - PreliminaryAnalysisService (packages/bot/src/ai/services/PreliminaryAnalysisService.ts)
   *   - ProactiveReplyGenerationService (packages/bot/src/ai/services/ProactiveReplyGenerationService.ts)
   *
   * Future cleanup: when those sideline services are migrated to the
   * producer model (separate ticket), this method and
   * renderBaseSystemTemplate below should both be deleted.
   *
   * Renders the base system prompt with stable variables only
   * (currentDate, adminUserId) to avoid cache miss. Optional overrides
   * (e.g. whitelistLimitedFragment) allow injecting per-request content
   * when whitelist is not full permissions.
   */
  renderBasePrompt(overrides?: Record<string, string>): string | undefined {
    const baseTemplate = this.getTemplate(BASE_SYSTEM_TEMPLATE_NAME) ?? this.getTemplate(BASE_TEMPLATE_NAME);
    if (!baseTemplate) {
      return undefined;
    }
    const baseVars: Record<string, string> = {
      currentDate: getCurrentDateHourForPrompt(),
      adminUserId: this.adminUserId || '（无管理员）',
      botSelfId: this.botSelfId || '（未配置）',
      botNicknameSuffix: this.botNickname ? `，昵称「${this.botNickname}」` : '',
      whitelistLimitedFragment: '',
      ...overrides,
    };
    return this.renderTemplateContent(baseTemplate, BASE_TEMPLATE_NAME, baseVars);
  }

  /**
   * @shim — Companion shim to renderBasePrompt; see that method's JSDoc
   * for the migration context. The main reply pipeline does not call
   * this method either; sub-pipelines (e.g. Live2D / avatar) that have
   * their own base.system template still do.
   *
   * Renders a base-style system prompt from an arbitrary template, using
   * the same environmental-variable injection as renderBasePrompt
   * (currentDate, adminUserId). Resolution order matches getTemplate
   * (short name, then fallback by basename), but falls back to the shared
   * base.system if the requested template is absent, so callers don't
   * need to special-case missing templates.
   */
  renderBaseSystemTemplate(templateName: string, overrides?: Record<string, string>): string | undefined {
    const template = this.getTemplate(templateName);
    if (!template) {
      return this.renderBasePrompt(overrides);
    }
    const baseVars: Record<string, string> = {
      currentDate: getCurrentDateHourForPrompt(),
      adminUserId: this.adminUserId || '（无管理员）',
      botSelfId: this.botSelfId || '（未配置）',
      botNicknameSuffix: this.botNickname ? `，昵称「${this.botNickname}」` : '',
      ...overrides,
    };
    return this.renderTemplateContent(template, templateName, baseVars);
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
