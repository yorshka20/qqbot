// LLMDumpPlugin - dumps every LLM call (prompt + response + tool calls) to clean
// markdown files, grouped per message turn, for inspecting what actually hit the model.
//
// It subscribes to LLMService's trace observer — the single chokepoint every
// generation path flows through (generate / generateLite / generateFixed /
// generateStream; tool-use rounds arrive as separate entries since generateWithTools
// drives them through generate()). So one turn's file shows the main reply, each
// tool-calling round (with the model's tool_calls and the tool results fed back),
// and any sub-agent calls, in order.
//
// Day directories older than the retention window are zipped into <outputDir>/archive/,
// the same shape LogArchivePlugin uses for logs/.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ScheduledTask } from 'node-cron';
import { schedule } from 'node-cron';
import { isAssembledEnvelope } from '@/ai/prompt/PromptMessageAssembler';
import type { LLMService } from '@/ai/services/LLMService';
import type { ChatMessage, ChatMessageContent, LLMTraceEntry } from '@/ai/types';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { archiveDateDirs } from '@/utils/dateDirArchive';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import { RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

export interface LLMDumpPluginConfig {
  /** Output directory, relative to repo root (default: "logs/llm-dumps"). */
  outputDir?: string;
  /** Days of dumps kept uncompressed; older days are zipped (default: 7). */
  retainDays?: number;
  /** Cron for the archive pass (default: "0 4 * * 1" = Mondays at 04:00). */
  archiveCron?: string;
  /** Timezone for the archive cron (default: "Asia/Tokyo"). */
  timezone?: string;
}

/** Rule flanking each transcript entry's header line. */
const TRANSCRIPT_RULE = '='.repeat(10);

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
  private retainDays = 7;
  private archiveCron = '0 4 * * 1';
  private timezone = 'Asia/Tokyo';
  private archiveJob: ScheduledTask | null = null;

  async onInit(): Promise<void> {
    const config = (this.pluginConfig?.config ?? {}) as LLMDumpPluginConfig;
    if (config.outputDir) {
      this.outputDir = join(getRepoRoot(), config.outputDir);
    }
    this.retainDays = config.retainDays ?? 7;
    this.archiveCron = config.archiveCron ?? '0 4 * * 1';
    this.timezone = config.timezone ?? 'Asia/Tokyo';

    await this.archiveOldDumps();
    this.archiveJob = schedule(this.archiveCron, () => void this.archiveOldDumps(), {
      scheduled: true,
      timezone: this.timezone,
    });
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
    logger.info(
      `[LLMDumpPlugin] Dumping LLM calls to ${this.outputDir} (archive: ${this.archiveCron}, retain ${this.retainDays}d)`,
    );
  }

  async onDisable(): Promise<void> {
    super.onDisable();
    if (this.archiveJob) {
      this.archiveJob.stop();
      this.archiveJob = null;
    }
  }

  private async archiveOldDumps(): Promise<void> {
    try {
      await archiveDateDirs({
        sourceDir: this.outputDir,
        archiveDir: join(this.outputDir, 'archive'),
        retainDays: this.retainDays,
        batchDays: this.retainDays,
        format: 'zip',
        deleteAfterArchive: true,
        logLabel: '[LLMDumpPlugin]',
      });
    } catch (err) {
      logger.error('[LLMDumpPlugin] Archive failed:', err);
    }
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
      lines.push(...this.renderMessages(entry.messages));
    } else {
      if (entry.systemPrompt) lines.push('### system', '', this.fence(entry.systemPrompt), '');
      if (entry.prompt) lines.push('### prompt', '', this.fence(entry.prompt), '');
    }

    if (entry.response.reasoningContent?.trim()) {
      lines.push('### ⟵ thinking', '', this.fence(entry.response.reasoningContent), '');
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
    const stats: string[] = [];
    if (entry.response.usage) {
      const u = entry.response.usage;
      stats.push(`tokens: prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.totalTokens}`);
    }
    stats.push(`elapsed: ${this.formatDuration(entry.durationMs)}`);
    lines.push(`> ${stats.join(' · ')}`, '');

    lines.push('---', '');
    return lines.join('\n');
  }

  /**
   * Three kinds of message get three renderings, because they are three different
   * things wearing the same `role` field:
   *
   * - system prompts and tool payloads → their own headed blocks (bulk text);
   * - the assembler's request envelope → its own chapter, one sub-block per context
   *   section, so retrieved memory/RAG/persona material never reads as something a
   *   person said;
   * - everything else → a chat transcript.
   *
   * Which message is the envelope is PromptMessageAssembler's question to answer
   * (`isAssembledEnvelope`) — position won't do it, since tool rounds append further
   * user turns after it.
   */
  private renderMessages(messages: ChatMessage[]): string[] {
    // Number system messages (base system / scene system / …) so the distinct
    // prompts are easy to tell apart.
    const systemCount = messages.filter((m) => m.role === 'system').length;
    let systemIdx = 0;
    const envelopeIdx = messages.findLastIndex(isAssembledEnvelope);
    const lines: string[] = [];
    let transcript: string[] = [];

    const flushTranscript = () => {
      if (transcript.length === 0) return;
      lines.push('### conversation', '', this.fence(transcript.join('\n\n')), '');
      transcript = [];
    };

    for (const [idx, msg] of messages.entries()) {
      if (msg.role === 'system') {
        flushTranscript();
        const label = systemCount > 1 ? `system #${++systemIdx}` : 'system';
        lines.push(`### ${label}`, '', this.fence(this.contentToText(msg.content)), '');
        continue;
      }
      if (msg.role === 'tool') {
        flushTranscript();
        lines.push(`### tool ← ${msg.tool_call_id ?? ''}`, '', this.fence(this.contentToText(msg.content)), '');
        continue;
      }

      const content = this.contentToText(msg.content).trim();
      if (idx === envelopeIdx) {
        flushTranscript();
        lines.push('### request envelope', '');
        const sections = this.splitEnvelopeSections(content);
        if (sections.length === 0) {
          lines.push(this.fence(content), '');
        }
        for (const section of sections) {
          lines.push(`#### ${section.tag}`, '', this.fence(section.body), '');
        }
      } else if (content) {
        transcript.push(this.transcriptEntry(msg.role, content));
      } else if (!msg.tool_calls?.length) {
        transcript.push(this.transcriptEntry(msg.role, '(empty)'));
      }

      if (msg.tool_calls?.length) {
        flushTranscript();
        lines.push('**tool calls:**', '');
        for (const tc of msg.tool_calls) {
          lines.push(`- \`${tc.name}\` (${tc.id})`, '', this.fence(this.pretty(tc.arguments), 'json'), '');
        }
      }
    }

    flushTranscript();
    return lines;
  }

  /**
   * Break the envelope into its `<tag>…</tag>` context sections, or return none when
   * the caller assembled the final turn some other way (the renderer then prints it
   * whole). Anything left after the last section is kept so nothing is dropped.
   */
  private splitEnvelopeSections(content: string): Array<{ tag: string; body: string }> {
    const sections: Array<{ tag: string; body: string }> = [];
    let rest = content.trim();

    while (rest.startsWith('<')) {
      const nameEnd = rest.indexOf('>');
      if (nameEnd === -1) break;
      const tag = rest.slice(1, nameEnd);
      const closeAt = rest.indexOf(`</${tag}>`, nameEnd);
      if (closeAt === -1) break;
      sections.push({ tag, body: rest.slice(nameEnd + 1, closeAt).trim() });
      rest = rest.slice(closeAt + tag.length + 3).trim();
    }

    if (sections.length > 0 && rest) {
      sections.push({ tag: '(trailing)', body: rest });
    }
    return sections;
  }

  /**
   * A ruled header line (`===== role [speaker] time =====`) then the body verbatim.
   * The rule is what separates entries — a blank line would not, since message
   * bodies contain their own blank lines and would split into phantom messages.
   */
  private transcriptEntry(role: string, content: string): string {
    const { time, speaker, body } = this.splitHistoryLabels(content);
    const header = [role, speaker, time].filter(Boolean).join(' ');
    return `${TRANSCRIPT_RULE} ${header} ${TRANSCRIPT_RULE}\n${body}`;
  }

  /**
   * Peel the labels PromptMessageAssembler writes in front of a history turn —
   * `[M/DD HH:mm]`, then `[speaker:…]` on user turns — off the message body.
   * A leading bracket that is neither (a message opening with `[Image:…]`,
   * `[Reply:…]`) is left in the body.
   */
  private splitHistoryLabels(content: string): { time: string; speaker: string; body: string } {
    let time = '';
    let speaker = '';
    let rest = content;

    while (rest.startsWith('[')) {
      const end = rest.indexOf('] ');
      if (end === -1) break;
      const label = rest.slice(1, end);
      if (label.startsWith('speaker:')) {
        speaker = `[${label}]`;
      } else if (this.isTimeLabel(label)) {
        time = label;
      } else {
        break;
      }
      rest = rest.slice(end + 2);
    }

    return { time, speaker, body: rest };
  }

  /** `M/DD HH:mm` — the only non-speaker label the assembler emits. */
  private isTimeLabel(label: string): boolean {
    const [date, clock] = label.split(' ');
    if (date === undefined || clock === undefined) return false;
    const parts = [...date.split('/'), ...clock.split(':')];
    return parts.length === 4 && parts.every((p) => p.length > 0 && Number.isInteger(Number(p)));
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

  /** Sub-second calls are the cheap ones; seconds is the resolution worth comparing. */
  private formatDuration(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
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
