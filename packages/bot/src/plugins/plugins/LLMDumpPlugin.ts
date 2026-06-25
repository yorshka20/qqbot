// LLMDumpPlugin - dumps every LLM call (prompt + response + tool calls) to clean
// markdown files, grouped per message turn, for inspecting what actually hit the model.
//
// It subscribes to LLMService's trace observer — the single chokepoint every
// generation path flows through (generate / generateLite / generateFixed /
// generateStream; tool-use rounds arrive as separate entries since generateWithTools
// drives them through generate()). So one turn's file shows the main reply, each
// tool-calling round (with the model's tool_calls and the tool results fed back),
// and any sub-agent calls, in order.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMService } from '@/ai/services/LLMService';
import type { ChatMessage, ChatMessageContent, LLMTraceEntry } from '@/ai/types';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import { RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

export interface LLMDumpPluginConfig {
  /** Output directory, relative to repo root (default: "logs/llm-dumps"). */
  outputDir?: string;
}

@RegisterPlugin({
  name: 'llm-dump',
  version: '1.0.0',
  description: 'Dumps every LLM prompt/response (incl. tool calls) to per-turn markdown files for inspection.',
})
export class LLMDumpPlugin extends PluginBase {
  private outputDir = join(getRepoRoot(), 'logs', 'llm-dumps');
  /** Turn keys we have already written a file header for. */
  private readonly headerWritten = new Set<string>();
  private registered = false;

  async onInit(): Promise<void> {
    const config = (this.pluginConfig?.config ?? {}) as LLMDumpPluginConfig;
    if (config.outputDir) {
      this.outputDir = join(getRepoRoot(), config.outputDir);
    }
  }

  onEnable(): void {
    super.onEnable();
    if (this.registered) return;
    const container = getContainer();
    if (!container.isRegistered(DITokens.LLM_SERVICE)) {
      logger.warn('[LLMDumpPlugin] LLM_SERVICE not registered; dump observer not attached');
      return;
    }
    const llmService = container.resolve<LLMService>(DITokens.LLM_SERVICE);
    llmService.addTraceObserver((entry) => this.handleEntry(entry));
    this.registered = true;
    logger.info(`[LLMDumpPlugin] Dumping LLM calls to ${this.outputDir}`);
  }

  private handleEntry(entry: LLMTraceEntry): void {
    try {
      const now = new Date();
      const dayDir = join(this.outputDir, this.formatDay(now));
      if (!existsSync(dayDir)) mkdirSync(dayDir, { recursive: true });

      const turn = this.sanitize(entry.turnKey ?? 'background');
      const hhmmss = new Date().toTimeString().split(' ')[0].replace(/:/g, '');
      const file = join(dayDir, `${hhmmss}-${turn}.md`);

      let out = '';
      if (!this.headerWritten.has(file)) {
        this.headerWritten.add(file);
        if (!existsSync(file)) {
          out += `# LLM dump — ${entry.turnKey ?? 'background'}\n\n`;
        }
      }
      out += this.renderEntry(entry, now);
      appendFileSync(file, out, 'utf-8');
    } catch (err) {
      logger.warn('[LLMDumpPlugin] Failed to write dump:', err);
    }
  }

  private renderEntry(entry: LLMTraceEntry, at: Date): string {
    const model = entry.resolvedModel ? ` · ${entry.resolvedModel}` : '';
    // The h2 call header is the ONLY heading that survives — message contents are
    // fenced (below) so the prompt's own markdown headers can't hijack the outline.
    const lines: string[] = [`## ${this.formatTime(at)} · ${entry.opLabel} · ${entry.provider}${model}`, ''];

    if (entry.messages && entry.messages.length > 0) {
      // Number system messages (base system / scene system / …) so the distinct
      // prompts are easy to tell apart.
      const systemCount = entry.messages.filter((m) => m.role === 'system').length;
      let systemIdx = 0;
      for (const msg of entry.messages) {
        const idx = msg.role === 'system' && systemCount > 1 ? ++systemIdx : undefined;
        lines.push(...this.renderMessage(msg, idx));
      }
    } else {
      if (entry.systemPrompt) lines.push('### system', '', this.fence(entry.systemPrompt), '');
      if (entry.prompt) lines.push('### user', '', this.fence(entry.prompt), '');
    }

    lines.push('### ⟵ output', '');
    const text = entry.response.text ?? '';
    lines.push(text.trim() ? this.fence(text) : '_(no text)_', '');
    if (entry.response.functionCalls?.length) {
      lines.push('**tool calls (response):**', '');
      for (const fc of entry.response.functionCalls) {
        lines.push(`- \`${fc.name}\``, '', this.fence(this.pretty(fc.arguments), 'json'), '');
      }
    }
    if (entry.response.usage) {
      const u = entry.response.usage;
      lines.push(`> tokens: prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.totalTokens}`, '');
    }

    lines.push('---', '');
    return lines.join('\n');
  }

  private renderMessage(msg: ChatMessage, systemIdx?: number): string[] {
    let label: string;
    if (msg.role === 'system') label = systemIdx ? `system #${systemIdx}` : 'system';
    else if (msg.role === 'tool') label = `tool ← ${msg.tool_call_id ?? ''}`;
    else label = msg.role;

    const lines: string[] = [`### ${label}`, ''];

    const content = this.contentToText(msg.content);
    if (content.trim()) {
      lines.push(this.fence(content), '');
    } else if (!msg.tool_calls?.length) {
      lines.push('_(empty)_', '');
    }

    if (msg.tool_calls?.length) {
      lines.push('**tool calls:**', '');
      for (const tc of msg.tool_calls) {
        lines.push(`- \`${tc.name}\` (${tc.id})`, '', this.fence(this.pretty(tc.arguments), 'json'), '');
      }
    }
    return lines;
  }

  private contentToText(content: ChatMessageContent | undefined): string {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    return content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('');
  }

  /**
   * Wrap content in a fenced block so its own markdown (headers, lists, fences)
   * renders verbatim instead of clashing with the dump's structure. The fence is
   * always longer than the longest backtick run inside the content, so embedded
   * code blocks can't break out.
   */
  private fence(content: string, lang = ''): string {
    const longest = (content.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
    const ticks = '`'.repeat(Math.max(3, longest + 1));
    return `${ticks}${lang}\n${content}\n${ticks}`;
  }

  /** Pretty-print a JSON argument string; fall back to the raw string if it isn't JSON. */
  private pretty(jsonish: string): string {
    try {
      return JSON.stringify(JSON.parse(jsonish), null, 2);
    } catch {
      return jsonish;
    }
  }

  private sanitize(key: string): string {
    return key.replace(/[^\w.-]+/g, '-');
  }

  private formatDay(d: Date): string {
    return `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`;
  }

  private formatTime(d: Date): string {
    return `${this.pad(d.getHours())}:${this.pad(d.getMinutes())}:${this.pad(d.getSeconds())}`;
  }

  private pad(n: number): string {
    return String(n).padStart(2, '0');
  }
}
