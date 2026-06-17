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
      const file = join(dayDir, `${turn}.md`);

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
    const lines: string[] = [`## ${this.formatTime(at)} · ${entry.opLabel} · ${entry.provider}${model}`, ''];

    if (entry.systemPrompt) {
      lines.push('**System**', '', '```', entry.systemPrompt, '```', '');
    }

    if (entry.messages && entry.messages.length > 0) {
      lines.push('### Input', '');
      for (const msg of entry.messages) {
        lines.push(...this.renderMessage(msg));
      }
    } else if (entry.prompt) {
      lines.push('### Input', '', '**[user]**', '', entry.prompt, '');
    }

    lines.push('### Output', '');
    const text = entry.response.text?.trim();
    lines.push(text ? text : '_(no text)_', '');
    if (entry.response.functionCalls?.length) {
      lines.push('**Tool calls (response):**', '');
      for (const fc of entry.response.functionCalls) {
        lines.push(`- \`${fc.name}\``, '', '```json', this.pretty(fc.arguments), '```', '');
      }
    }
    if (entry.response.usage) {
      const u = entry.response.usage;
      lines.push(`> tokens: prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.totalTokens}`, '');
    }

    lines.push('---', '');
    return lines.join('\n');
  }

  private renderMessage(msg: ChatMessage): string[] {
    const lines: string[] = [];
    const roleTag = msg.role === 'tool' && msg.tool_call_id ? `tool ← ${msg.tool_call_id}` : msg.role;
    lines.push(`**[${roleTag}]**`, '');

    const content = this.contentToText(msg.content);
    if (content) lines.push(content, '');

    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        lines.push(`→ tool_call \`${tc.name}\` (${tc.id})`, '', '```json', this.pretty(tc.arguments), '```', '');
      }
    }
    return lines;
  }

  private contentToText(content: ChatMessageContent | undefined): string {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    return content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('');
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
