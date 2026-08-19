// SqlQueryPlugin - gives the LLM (and the owner) read-only SQL access to the
// bot's own SQLite database for ad-hoc analysis.
//
// Registers:
//   - query_database tool (admin-gated; action=describe|query)
//   - /sql command (owner/admin), the manual channel into the same runner
//
// The tool spec is built at enable time rather than through the @Tool decorator
// because its description carries the live table list — the model can then write
// a first query without spending a round trip on schema discovery.

import { resolve } from 'node:path';
import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolSpec } from '@/tools/types';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';
import { PluginCommandHandler } from '../../PluginCommandHandler';
import { formatRowsAsTable } from './formatRows';
import { SqlQueryRunner } from './SqlQueryRunner';
import { SqlQueryToolExecutor } from './SqlQueryToolExecutor';
import { fetchTableNames } from './schema';
import type { SqlQueryPluginConfig } from './types';
import { validateReadStatement } from './validateSql';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ROWS = 200;
const DEFAULT_OUTPUT_CHARS = 6_000;
/** Rows a `/sql` invocation returns; a chat message cannot usefully carry more. */
const COMMAND_ROW_LIMIT = 30;
const COMMAND_OUTPUT_CHARS = 2_000;

const TOOL_NAME = 'query_database';

@RegisterPlugin({
  name: 'sqlQuery',
  version: '1.0.0',
  description: "Read-only SQL access to the bot's own SQLite database, exposed as an admin-gated LLM tool and /sql",
})
export class SqlQueryPlugin extends PluginBase {
  private runner!: SqlQueryRunner;
  private limits = {
    defaultRows: 50,
    maxRows: DEFAULT_MAX_ROWS,
    maxOutputChars: DEFAULT_OUTPUT_CHARS,
  };

  // Registration lives in onInit, not onEnable: smoke-test runs onInit and skips
  // onEnable, so anything registered there would never be verified. `this.enabled`
  // is already populated from config by loadConfig() at this point, so a plugin
  // switched off in config still registers nothing.
  async onInit(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const container = getContainer();
    const config = container.resolve<Config>(DITokens.CONFIG);
    const databaseConfig = config.getDatabaseConfig();

    if (databaseConfig.type !== 'sqlite' || !databaseConfig.sqlite) {
      logger.warn(`[SqlQueryPlugin] Database type is "${databaseConfig.type}", not sqlite — plugin stays inactive`);
      return;
    }

    const pluginConfig = (this.pluginConfig?.config ?? {}) as SqlQueryPluginConfig;
    this.limits = {
      defaultRows: 50,
      maxRows: pluginConfig.maxRows ?? DEFAULT_MAX_ROWS,
      maxOutputChars: pluginConfig.maxOutputChars ?? DEFAULT_OUTPUT_CHARS,
    };

    // SQLiteAdapter resolves the configured path against cwd; do the same so
    // the child process opens the file the bot is actually using.
    this.runner = new SqlQueryRunner(resolve(databaseConfig.sqlite.path), pluginConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const toolManager = container.resolve<ToolManager>(DITokens.TOOL_MANAGER);
    toolManager.registerTool(this.buildToolSpec(await this.probeTableNames()));
    toolManager.registerExecutor(new SqlQueryToolExecutor(this.runner, this.limits));

    const commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    commandManager.register(
      new PluginCommandHandler(
        'sql',
        '只读查询 bot 自己的 SQLite 数据库',
        '/sql <SELECT ...>',
        (args, context) => this.handleCommand(args, context),
        this.context,
        ['admin', 'owner'],
      ),
      this.name,
    );

    logger.info(`[SqlQueryPlugin] Ready (db: ${databaseConfig.sqlite.path}, ${TOOL_NAME} tool + /sql registered)`);
  }

  private async probeTableNames(): Promise<string[]> {
    try {
      return await fetchTableNames(this.runner);
    } catch (error) {
      // The tool still works — action=describe reads the schema at call time.
      logger.warn(`[SqlQueryPlugin] Could not read the table list at startup: ${error}`);
      return [];
    }
  }

  private buildToolSpec(tableNames: string[]): ToolSpec {
    const tableList = tableNames.length > 0 ? `\n当前库中的表：${tableNames.join('、')}。` : '';

    return {
      name: TOOL_NAME,
      description:
        `以只读 SQL 查询 bot 自己的 SQLite 数据库并做统计分析（聊天记录 messages、token 用量 token_usage、` +
        `人格关系 persona_relationships、日程 agenda_items 等）。只接受 SELECT / WITH / EXPLAIN，写操作一律拒绝。${tableList}`,
      executor: TOOL_NAME,
      visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord', 'avatar-cmd'], adminOnly: true } },
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['query', 'describe'],
          description: 'query=执行 SQL / describe=查看表结构（不确定字段名时先用 describe）',
        },
        sql: {
          type: 'string',
          required: false,
          description:
            'action=query 时必填。单条只读语句，不要加分号。时间字段是 ISO 字符串，可用 substr(createdAt,1,10) 按天分组。',
        },
        tables: {
          type: 'array',
          required: false,
          items: { type: 'string' },
          description: 'action=describe 时可选。给出表名则返回这些表的完整 DDL 和索引；省略则列出全部表的字段概览。',
        },
        limit: {
          type: 'number',
          required: false,
          description: `action=query 时可选，返回行数上限，默认 50，最大 ${this.limits.maxRows}。聚合统计请在 SQL 里写 GROUP BY 而不是靠调大它。`,
        },
      },
      examples: [
        '统计群里谁发言最多 → action=query sql="SELECT userId, count(*) n FROM messages WHERE groupId=\'123\' GROUP BY userId ORDER BY n DESC"',
        '看看最近 7 天每天的消息量 → action=query sql="SELECT substr(createdAt,1,10) d, count(*) n FROM messages GROUP BY d ORDER BY d DESC LIMIT 7"',
        '不确定 token_usage 有哪些字段 → action=describe tables=["token_usage"]',
      ],
      triggerKeywords: ['查数据库', '统计一下', '数据分析', 'sql', '跑个查询'],
      whenToUse:
        '当问题需要对 bot 自己积累的结构化数据做统计/聚合/排行（发言量、活跃度、token 花费、人格亲密度变化等），' +
        '而现成的 search_chat_history 这类工具只能按关键词捞原文、给不出数字时使用。先 describe 再 query。',
    };
  }

  private async handleCommand(args: string[], _context: CommandContext): Promise<CommandResult> {
    const mb = new MessageBuilder();

    if (!this.runner) {
      mb.text('SQL 查询未启用：当前数据库不是 sqlite。');
      return { success: true, segments: mb.build() };
    }

    const validation = validateReadStatement(args.join(' '));
    if (!validation.ok) {
      mb.text(`❌ ${validation.reason}`);
      return { success: true, segments: mb.build() };
    }

    const outcome = await this.runner.run(validation.statement, COMMAND_ROW_LIMIT);
    if (!outcome.ok) {
      mb.text(`❌ ${outcome.error}`);
      return { success: true, segments: mb.build() };
    }

    if (outcome.rows.length === 0) {
      mb.text(`✅ 0 行（${outcome.elapsedMs}ms）`);
      return { success: true, segments: mb.build() };
    }

    const suffix = outcome.truncated ? `（已截断至 ${COMMAND_ROW_LIMIT} 行）` : '';
    mb.text(
      `✅ ${outcome.rows.length} 行${suffix}（${outcome.elapsedMs}ms）\n${formatRowsAsTable(
        outcome.columns,
        outcome.rows,
        COMMAND_OUTPUT_CHARS,
      )}`,
    );
    return { success: true, segments: mb.build() };
  }
}
