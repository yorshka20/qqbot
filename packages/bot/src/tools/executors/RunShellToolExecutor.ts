import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { FileReadService } from '@/services/file';
import { ReadOnlyShellService } from '@/services/shell/ReadOnlyShellService';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'run_shell',
  description: `在 bot 部署机的项目仓库根目录下执行一条只读检查命令，返回其输出。用于查看 git 提交记录/diff、搜索和阅读本地代码。

规则（写命令前先看，不要试错）：
- 可用命令：git（只读子命令 log/show/diff/status/blame/branch/tag/grep/ls-files/rev-parse 等）、rg、grep、ls、cat、head、tail、wc。
- 没有 shell：不支持管道、重定向、命令串联、变量展开；一次一条命令。需要加工输出时，把结果拿回来后用 execute_code 处理。
- config.d、.env 等密钥路径与项目外路径不可访问；git 的写操作子命令（commit/push/checkout 等）不可用。
- 与 execute_command 不同：execute_command 代理的是 bot 斜杠命令，本工具执行的是仓库检查命令。`,
  executor: 'run_shell',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'], adminOnly: true } },
  parameters: {
    command: {
      type: 'string',
      required: true,
      description:
        '完整命令行，如 "git log --oneline -20"、"rg sendMessageCount packages/bot/src"、"cat package.json"。正则等含特殊字符的参数用引号包裹。',
    },
  },
  examples: [
    'git log --oneline -20',
    'git show HEAD --stat',
    'rg "endTurn" packages/bot/src',
    'ls packages/bot/src/tools',
  ],
  whenToUse:
    '需要查看本地仓库状态时调用：最近提交、某次提交的改动、分支情况、按关键词搜代码、浏览目录、读小文件。读大段文件内容优先 read_file（有更好的截断），语义化代码搜索优先 search_code。',
})
@injectable()
export class RunShellToolExecutor extends BaseToolExecutor {
  name = 'run_shell';

  private readonly shellService: ReadOnlyShellService;

  constructor(@inject(DITokens.FILE_READ_SERVICE) fileReadService: FileReadService) {
    super();
    this.shellService = new ReadOnlyShellService(fileReadService);
  }

  execute(call: ToolCall, _context: ToolExecutionContext): ToolResult {
    const command = typeof call.parameters?.command === 'string' ? call.parameters.command.trim() : '';
    if (!command) {
      return this.error('请提供要执行的命令', 'Missing required parameter: command');
    }

    const result = this.shellService.run(command);
    if (!result.success) {
      return this.error(result.error ?? '命令执行失败', result.error ?? 'command failed');
    }
    return this.success(result.output);
  }
}
