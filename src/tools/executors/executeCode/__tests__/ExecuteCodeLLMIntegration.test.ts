/**
 * Execute Code — Multi-Provider LLM Integration Tests
 *
 * Tests the REAL round-trip for 5 providers (doubao, deepseek, gemini, openai, anthropic):
 *   LLM API → execute_code tool call → parse arguments →
 *   real ToolManager → real ExecuteCodeToolExecutor → CodeSandbox →
 *   real sub-tool executors (search, memory, fetch_page) with stubbed services → result back to LLM.
 *
 * Uses the REAL DI container with stubbed backend services (no network for sub-tools).
 * The tool executors, ToolManager, and code execution pipeline are all production code.
 *
 * Run all:  bun test src/tools/executors/executeCode/__tests__/ExecuteCodeLLMIntegration.test.ts
 * Run one:  bun test ... -t "doubao"
 */
import 'reflect-metadata';

// Import all executors to trigger @Tool() decorator registration
import '@/tools/executors';

import { describe, expect, test } from 'bun:test';
import {
  ALL_TOOL_USE_PROVIDERS,
  createAIManagerWithProvider,
  getIntegrationProvider,
  type IntegrationProviderName,
} from '@/ai/services/integrationTestHelpers';
import { LLMService, type LLMServiceConfig } from '@/ai/services/LLMService';
import type { ChatMessage, FunctionCall, ToolDefinition } from '@/ai/types';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { ToolManager } from '@/tools/ToolManager';
import type { ToolCall, ToolResult } from '@/tools/types';

// ── DI Setup: register stubbed services so real executors can be instantiated ──

function setupDIContainer(): ToolManager {
  const di = getContainer();

  // Stub RetrievalService (used by SearchToolExecutor, FetchPageToolExecutor, RagSearchToolExecutor)
  // Must match the real RetrievalService interface methods called by executors.
  di.registerInstance(
    DITokens.RETRIEVAL_SERVICE,
    {
      isSearchEnabled: () => true,
      search: async (query: string) => [
        { title: `Result 1 for "${query}"`, url: 'https://example.com/1', content: `Snippet about ${query}` },
        { title: `Result 2 for "${query}"`, url: 'https://example.com/2', content: `More about ${query}` },
      ],
      formatSearchResults: (results: { title: string; url: string; content: string }[]) =>
        results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`).join('\n\n'),
      getPageContentFetchService: () => ({
        isEnabled: () => true,
        fetchPages: async (entries: { url: string; title?: string }[]) =>
          entries.map((e) => ({
            url: e.url,
            title: e.title ?? 'Stub Article',
            text: `Article content from ${e.url}. TypeScript is a typed superset of JavaScript.`,
          })),
      }),
    },
    { allowOverride: true },
  );

  // Stub MemoryService (used by GetMemoryToolExecutor, SearchMemoryToolExecutor)
  // Must match MemoryService.getMemory(groupId, userId?) signature.
  di.registerInstance(
    DITokens.MEMORY_SERVICE,
    {
      getMemory: (groupId: string, userId?: string) => ({
        userId: userId ?? '__group__',
        isGroupMemory: !userId,
        content: userId
          ? `User ${userId} memory in group ${groupId}: likes TypeScript, prefers dark mode`
          : `Group ${groupId} memory: friendly community, discuss tech topics`,
      }),
      searchMemory: (_groupId: string, query: string) => [
        { userId: '__group__', isGroupMemory: true, snippet: `Group memory match for "${query}"` },
        { userId: 'user1', isGroupMemory: false, snippet: `User memory match for "${query}"` },
      ],
    },
    { allowOverride: true },
  );

  // Stub FileReadService (used by ReadFileToolExecutor, SearchCodeToolExecutor, DeduplicateFilesToolExecutor)
  di.registerInstance(
    DITokens.FILE_READ_SERVICE,
    {
      readFile: async (path: string) => ({ success: true, content: `Contents of ${path}` }),
      listDirectory: async (_path: string) => ({
        success: true,
        content: `file1.ts\nfile2.ts\nREADME.md`,
      }),
      searchCode: async (pattern: string, path: string) => ({
        matches: [
          { file: `${path}/index.ts`, line: '10', content: `// match: ${pattern}` },
          { file: `${path}/utils.ts`, line: '25', content: `// match: ${pattern}` },
        ],
        totalMatches: 2,
      }),
    },
    { allowOverride: true },
  );

  // Stub ConversationHistoryService (used by FetchHistoryByTimeToolExecutor)
  di.registerInstance(
    DITokens.CONVERSATION_HISTORY_SERVICE,
    {
      getHistoryByTimeRange: async () => ({
        messages: [
          { userId: 123, nickname: 'Alice', content: 'Hello', createdAt: new Date().toISOString(), isBotReply: false },
        ],
        uniqueUsers: [{ userId: 123, nickname: 'Alice', messageCount: 1 }],
      }),
    },
    { allowOverride: true },
  );

  // Stub PromptManager (used by CardFormatToolExecutor)
  di.registerInstance(
    DITokens.PROMPT_MANAGER,
    {
      render: (key: string) => `[Rendered: ${key}]`,
      getTemplate: () => null,
    },
    { allowOverride: true },
  );

  // Stub CommandManager + PluginManager (used by ListBotFeaturesToolExecutor)
  di.registerInstance(
    DITokens.COMMAND_MANAGER,
    {
      getAllCommandInfos: () => [{ name: 'help', description: 'Show help', permission: 'user', usage: '/help' }],
    },
    { allowOverride: true },
  );
  di.registerInstance(
    DITokens.PLUGIN_MANAGER,
    {
      getAllPlugins: () => [{ name: 'test-plugin', version: '1.0', description: 'Test', enabled: true }],
    },
    { allowOverride: true },
  );

  // Create and register the real ToolManager with auto-registered tools
  const toolManager = new ToolManager();
  toolManager.autoRegisterTools();
  di.registerInstance(DITokens.TOOL_MANAGER, toolManager, { allowOverride: true });

  return toolManager;
}

const toolManager = setupDIContainer();

// ── Config ──

const LLM_CONFIG: LLMServiceConfig = {
  toolUseProviders: [...ALL_TOOL_USE_PROVIDERS],
  fallback: { fallbackOrder: [...ALL_TOOL_USE_PROVIDERS] },
};

// ── Logging ──

const LOG = '[ExecCodeLLM]';
function log(msg: string, data?: unknown): void {
  const payload = data !== undefined ? (typeof data === 'string' ? data : JSON.stringify(data, null, 2)) : '';
  console.log(LOG, msg, payload);
}

// ── Tool definition sent to LLM ──
// Derived from the real ToolManager rather than hand-crafted.

function getExecuteCodeDef(): ToolDefinition {
  const specs = toolManager.getToolsByScope('reply');
  const defs = toolManager.toToolDefinitions(specs);
  const def = defs.find((d) => d.name === 'execute_code');
  if (!def) throw new Error('execute_code not found in registered tools');
  return def;
}

// ── Production-like tool executor callback ──

const toolContext = {
  userId: 12345,
  groupId: 67890,
  messageType: 'group' as const,
  conversationId: 'test-conv',
  messageId: 'test-msg',
};

async function executeToolCall(call: FunctionCall): Promise<unknown> {
  log(`--- [${call.name}] Tool call ---`);
  log('Arguments:', call.arguments);

  let parameters: Record<string, unknown>;
  try {
    parameters = JSON.parse(call.arguments) as Record<string, unknown>;
  } catch (e) {
    log('ERROR: parse failed', String(e));
    return { error: `Parse failed: ${e}` };
  }

  if (typeof parameters.code === 'string') {
    log(`Code:\n${parameters.code}`);
  }

  const spec = toolManager.getTool(call.name);
  if (!spec) return { error: `Tool not found: ${call.name}` };
  const executor = toolManager.getExecutor(spec.executor);
  if (!executor) return { error: `Executor not found: ${spec.executor}` };

  const toolCall: ToolCall = { type: call.name, parameters, executor: spec.executor };
  const result: ToolResult = await executor.execute(toolCall, toolContext);

  log('Success:', String(result.success));
  log('Reply (200):', result.reply?.slice(0, 200));
  if (result.error) log('Error:', result.error);

  return result.data ?? result.reply;
}

// ── Shared test scenarios ──

interface TestScenario {
  name: string;
  messages: ChatMessage[];
  verify: (calls: FunctionCall[], res: { text: string; stopReason?: string }) => void;
}

const SYSTEM_PROMPT = [
  'You have the execute_code tool. You MUST use it — never write code as plain text.',
  'Inside sandbox you can call these tools:',
  '  - tools.search({ query }) — web search. Returns { success, data: { results: [{title,url},...], resultCount }, text }',
  '  - tools.get_memory({ userId? }) — read bot memory for current group/user. Returns { success, data: { content, isGroupMemory }, text }',
  '  - tools.fetch_page({ url }) — fetch web page content. Returns { success, data: { url, title, text }, text }',
  'Each tool returns { success, data, text }. Use data for structured access.',
  'Example: const r = await tools.search({ query: "hello" }); r.data.results[0].title',
].join('\n');

function scenarios(): TestScenario[] {
  return [
    {
      name: 'calculation — simple math via execute_code',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: '用 execute_code 计算 (2 ** 10) + 24，告诉我结果。' },
      ],
      verify: (calls, res) => {
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0].name).toBe('execute_code');
        const args = JSON.parse(calls[0].arguments) as Record<string, unknown>;
        expect(typeof args.code).toBe('string');
        if (res.stopReason === 'end_turn') {
          expect(res.text).toContain('1048');
        }
      },
    },
    {
      name: 'search + get_memory — chain two tools in one code block',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            '用 execute_code 完成：',
            '1. 调用 tools.search({ query: "Bun runtime" }) 搜索',
            '2. 取 data.results 第一个结果的 title',
            '3. 调用 tools.get_memory({}) 读取群记忆',
            '4. 返回 { searchTitle: title, memoryContent: 群记忆的 data.content }',
          ].join('\n'),
        },
      ],
      verify: (calls) => {
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0].name).toBe('execute_code');
        const code = (JSON.parse(calls[0].arguments) as Record<string, unknown>).code as string;
        expect(code).toContain('search');
        expect(code).toContain('get_memory');
      },
    },
    {
      name: 'fetch_page — fetch URL and extract info in code',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            '用 execute_code 完成：',
            '1. 调用 tools.fetch_page({ url: "https://example.com/ts" })',
            '2. console.log 打印 data.title',
            '3. 统计 data.text 字符数',
            '4. 返回 { title: data.title, charCount: 字符数 }',
          ].join('\n'),
        },
      ],
      verify: (calls) => {
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0].name).toBe('execute_code');
        const code = (JSON.parse(calls[0].arguments) as Record<string, unknown>).code as string;
        expect(code).toContain('fetch_page');
      },
    },
    {
      name: 'parallel search — Promise.all with multiple queries',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            '用 execute_code 完成：',
            '1. 用 Promise.all 并行搜索 "JavaScript" 和 "Python"',
            '2. 合并两次的 data.results',
            '3. 返回 { totalResults: 总数, queries: 2 }',
          ].join('\n'),
        },
      ],
      verify: (calls) => {
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0].name).toBe('execute_code');
        const code = (JSON.parse(calls[0].arguments) as Record<string, unknown>).code as string;
        expect(code.toLowerCase()).toContain('promise.all');
        expect(code).toContain('search');
      },
    },
  ];
}

// ── Generate test suite per provider ──

function defineProviderSuite(providerName: IntegrationProviderName): void {
  describe.skipIf(!getIntegrationProvider(providerName))(`ExecuteCode LLM — ${providerName}`, () => {
    const aiManager = createAIManagerWithProvider(providerName);
    const llmService = LLMService.create(aiManager, undefined, undefined, LLM_CONFIG);

    for (const scenario of scenarios()) {
      test(scenario.name, async () => {
        log(`\n========== [${providerName}] ${scenario.name} ==========`);
        const executedCalls: FunctionCall[] = [];

        const res = await llmService.generateWithTools(
          scenario.messages,
          [getExecuteCodeDef()],
          {
            maxToolRounds: 5,
            maxTokens: 1024,
            toolExecutor: async (call) => {
              executedCalls.push(call);
              return executeToolCall(call);
            },
          },
          providerName,
        );

        log('--- Final ---');
        log('Stop reason:', res.stopReason);
        log('Tool rounds:', String(res.toolCalls?.length ?? 0));
        log('Executed:', String(executedCalls.length));
        log('Text (300):', res.text?.slice(0, 300));

        scenario.verify(executedCalls, { text: res.text, stopReason: res.stopReason });
      }, 120_000); // 2min — multi-round tool use can be slow with some providers
    }
  });
}

// ── Register all 5 provider suites ──

for (const provider of ALL_TOOL_USE_PROVIDERS) {
  defineProviderSuite(provider);
}
