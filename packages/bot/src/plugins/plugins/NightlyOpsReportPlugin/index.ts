// NightlyOpsReportPlugin - scans ops/reports/ and pushes TL;DR summaries to bot owner

import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ScheduledTask } from 'node-cron';
import { schedule } from 'node-cron';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import type { ProtocolName } from '@/core/config/types/protocol';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import { RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';

export interface NightlyOpsReportPluginConfig {
  // Cron expression for when to run the scan (default: every 10 minutes)
  cron?: string;
  /** Timezone for the cron job (default: "Asia/Tokyo") */
  timezone?: string;
  /** Directory containing date-based report subdirs (default: <repoRoot>/ops/reports) */
  reportDir?: string;
  /** Protocol to use for sending private messages (default: "milky") */
  protocol?: ProtocolName;
  /** Whether this plugin is enabled */
  enabled?: boolean;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

@RegisterPlugin({
  name: 'nightlyOpsReport',
  version: '1.0.0',
  description: 'Scans ops/reports/ for completed nightly runs and pushes TL;DR summaries to bot owner',
})
export class NightlyOpsReportPlugin extends PluginBase {
  private cronJob: ScheduledTask | null = null;
  private messageAPI!: MessageAPI;
  private ownerId!: string;
  private reportDir!: string;
  private protocol!: ProtocolName;

  async onInit(): Promise<void> {
    const container = getContainer();
    const config = container.resolve<Config>(DITokens.CONFIG);
    this.messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);

    const botConfig = config.getConfig();
    this.ownerId = botConfig.bot.owner;

    if (!this.ownerId) {
      logger.warn('[NightlyOpsReportPlugin] bot.owner is empty — plugin will not start cron');
      return;
    }

    const pluginCfg = (this.pluginConfig?.config ?? {}) as NightlyOpsReportPluginConfig;
    const cron = pluginCfg.cron ?? '*/10 * * * *';
    const timezone = pluginCfg.timezone ?? 'Asia/Tokyo';
    this.protocol = pluginCfg.protocol ?? 'milky';

    // Resolve reportDir: absolute → use as-is; relative → resolve from repo root; default → ops/reports
    if (pluginCfg.reportDir) {
      this.reportDir = isAbsolute(pluginCfg.reportDir) ? pluginCfg.reportDir : join(getRepoRoot(), pluginCfg.reportDir);
    } else {
      this.reportDir = join(getRepoRoot(), 'ops', 'reports');
    }

    // Run once on startup (errors must not block bot startup)
    try {
      await this.scanAndReport();
    } catch (err) {
      logger.error('[NightlyOpsReportPlugin] Startup scan error:', err);
    }

    this.cronJob = schedule(
      cron,
      async () => {
        try {
          await this.scanAndReport();
        } catch (err) {
          logger.error('[NightlyOpsReportPlugin] Cron scan error:', err);
        }
      },
      { scheduled: true, timezone },
    );

    logger.info(
      `[NightlyOpsReportPlugin] Initialized (cron: ${cron}, timezone: ${timezone}, reportDir: ${this.reportDir})`,
    );
  }

  async onDisable(): Promise<void> {
    super.onDisable();
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    logger.info('[NightlyOpsReportPlugin] Cron job stopped');
  }

  /**
   * Scan reportDir for date directories with .completed but no .pushed, then push summaries.
   */
  private async scanAndReport(): Promise<void> {
    if (!existsSync(this.reportDir)) {
      logger.debug(`[NightlyOpsReportPlugin] reportDir does not exist: ${this.reportDir}`);
      return;
    }

    const entries = readdirSync(this.reportDir);

    for (const entry of entries) {
      if (!DATE_PATTERN.test(entry)) {
        continue;
      }

      const dateDirPath = join(this.reportDir, entry);

      try {
        if (!statSync(dateDirPath).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      const completedMarker = join(dateDirPath, '.completed');
      const pushedMarker = join(dateDirPath, '.pushed');

      if (!existsSync(completedMarker)) {
        continue;
      }

      if (existsSync(pushedMarker)) {
        continue;
      }

      await this.processDateDir(entry, dateDirPath, pushedMarker);
    }
  }

  /**
   * Process a single date directory: collect reports, build message, send, write .pushed.
   */
  private async processDateDir(dateStr: string, dateDirPath: string, pushedMarker: string): Promise<void> {
    const allEntries = readdirSync(dateDirPath);

    // Collect .md files, excluding .session.log files
    const mdFiles = allEntries.filter((f) => f.endsWith('.md') && !f.endsWith('.session.log')).sort();

    if (mdFiles.length === 0) {
      logger.warn(`[NightlyOpsReportPlugin] Date dir ${dateStr} has .completed but no report .md files`);
      writeFileSync(pushedMarker, '');
      return;
    }

    const sections: string[] = [];

    for (const mdFile of mdFiles) {
      const taskId = mdFile.slice(0, -3); // strip .md
      const mdPath = join(dateDirPath, mdFile);

      let content: string;
      try {
        content = await readFile(mdPath, 'utf8');
      } catch (err) {
        logger.warn(`[NightlyOpsReportPlugin] Failed to read ${mdFile}:`, err);
        sections.push(`■ ${taskId}\n(读取失败)`);
        continue;
      }

      const tldr = extractTldr(content);
      sections.push(`■ ${taskId}\n${tldr}`);
    }

    const message = [
      `📋 Nightly Ops Report — ${dateStr}`,
      '',
      sections.join('\n\n'),
      '',
      `📁 详细报告：ops/reports/${dateStr}/`,
    ].join('\n');

    try {
      await this.messageAPI.sendPrivateMessage(this.ownerId, message, this.protocol);
      writeFileSync(pushedMarker, '');
      logger.info(`[NightlyOpsReportPlugin] Pushed report for ${dateStr}`);
    } catch (err) {
      logger.error(`[NightlyOpsReportPlugin] Failed to send report for ${dateStr}:`, err);
      // Do not write .pushed — will retry next cron tick
    }
  }
}

/**
 * Extract the TL;DR section from a markdown report.
 * Looks for "## TL;DR" heading and collects lines until the next "## " heading or EOF.
 * Returns trimmed content, or "(无 TL;DR 段)" if the section is missing or empty.
 */
function extractTldr(content: string): string {
  const lines = content.split('\n');
  let inTldr = false;
  const tldrLines: string[] = [];

  for (const line of lines) {
    if (!inTldr) {
      if (line.trimEnd() === '## TL;DR') {
        inTldr = true;
      }
    } else {
      if (line.startsWith('## ')) {
        break;
      }
      tldrLines.push(line);
    }
  }

  if (!inTldr) {
    return '(无 TL;DR 段)';
  }

  const trimmed = tldrLines.join('\n').trim();
  return trimmed || '(无 TL;DR 段)';
}
