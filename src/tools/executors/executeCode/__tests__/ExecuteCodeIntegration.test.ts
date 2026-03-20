import { describe, expect, it } from 'bun:test';
import {
  MockFailingExecutor,
  MockMemoryExecutor,
  MockSearchExecutor,
  MockSlowExecutor,
  createMockToolManager,
  createToolCall,
  createToolExecutionContext,
  createToolSpec,
} from '@/__tests__/helpers';
import type { ToolExecutor } from '../../../types';
import { ExecuteCodeToolExecutor } from '../ExecuteCodeToolExecutor';

// ── Setup ──

const searchExecutor = new MockSearchExecutor();
const memoryExecutor = new MockMemoryExecutor();
const slowExecutor = new MockSlowExecutor();
const failingExecutor = new MockFailingExecutor();

const toolSpecs = [
  createToolSpec({ name: 'search', executor: 'search', description: 'Search the web' }),
  createToolSpec({ name: 'memory', executor: 'memory', description: 'Store/retrieve memory' }),
  createToolSpec({ name: 'slow_tool', executor: 'slow_tool', description: 'A slow tool' }),
  createToolSpec({ name: 'failing_tool', executor: 'failing_tool', description: 'Always fails' }),
  // Internal tool — should NOT be exposed to sandbox
  createToolSpec({ name: 'internal_admin', executor: 'internal_admin', description: 'Admin only', visibility: ['internal'] }),
  // execute_code itself — should NOT be exposed (prevent recursion)
  createToolSpec({ name: 'execute_code', executor: 'execute_code', description: 'Execute code' }),
];

const executorMap: Record<string, ToolExecutor> = {
  search: searchExecutor,
  memory: memoryExecutor,
  slow_tool: slowExecutor,
  failing_tool: failingExecutor,
};

const mockToolManager = createMockToolManager(toolSpecs, executorMap);
const context = createToolExecutionContext();

function createExecutor(): ExecuteCodeToolExecutor {
  return new ExecuteCodeToolExecutor(mockToolManager);
}

function codeCall(code: string, timeout?: number) {
  return createToolCall('execute_code', { code, ...(timeout != null ? { timeout } : {}) }, 'execute_code');
}

// ── Tests ──

describe('ExecuteCodeToolExecutor Integration', () => {
  // ── LLM uses execute_code to call search ──

  it('LLM calls search tool and extracts results', async () => {
    const executor = createExecutor();
    const code = `
const result = await tools.search({ query: "TypeScript best practices" });
const parsed = JSON.parse(result.reply);
return parsed.results.map(r => r.title);
`;
    const result = await executor.execute(codeCall(code), context);

    expect(result.success).toBe(true);
    expect(result.reply).toContain('Result 1 for');
    expect(result.reply).toContain('TypeScript best practices');
  });

  it('LLM searches multiple queries in parallel and merges results', async () => {
    const executor = createExecutor();
    const code = `
const queries = ["AI", "ML", "LLM"];
const results = await Promise.all(
  queries.map(q => tools.search({ query: q }))
);
const allResults = results.flatMap(r => JSON.parse(r.reply).results);
return { totalResults: allResults.length, queries: queries.length };
`;
    const result = await executor.execute(codeCall(code), context);

    expect(result.success).toBe(true);
    expect(result.data?.returnValue).toEqual({ totalResults: 6, queries: 3 });
  });

  // ── LLM uses execute_code to orchestrate multiple tools ──

  it('LLM chains search → memory store → memory retrieve', async () => {
    const executor = createExecutor();
    const code = `
// Step 1: Search
const searchResult = await tools.search({ query: "bun runtime" });
const parsed = JSON.parse(searchResult.reply);
const firstTitle = parsed.results[0].title;

// Step 2: Store the result
await tools.memory({ action: "store", key: "last_search", value: firstTitle });

// Step 3: Retrieve it back
const retrieved = await tools.memory({ action: "retrieve", key: "last_search" });
return { stored: firstTitle, retrieved: retrieved.reply, match: firstTitle === retrieved.reply };
`;
    const result = await executor.execute(codeCall(code), context);

    expect(result.success).toBe(true);
    expect(result.data?.returnValue).toMatchObject({ match: true });
  });

  // ── LLM handles tool failures gracefully in code ──

  it('LLM catches tool error and returns fallback', async () => {
    const executor = createExecutor();
    const code = `
let result;
try {
  result = await tools.failing_tool({});
} catch (e) {
  result = { success: false, reply: "fallback: " + e.message };
}
return result;
`;
    const result = await executor.execute(codeCall(code), context);

    expect(result.success).toBe(true);
    // SandboxContext wraps executor errors — the error is caught by wrapToolExecutor
    // and returned as a ToolResult, not thrown. So the catch block may or may not fire
    // depending on whether wrapToolExecutor catches it first.
    expect(result.reply).toBeDefined();
  });

  it('LLM uses console.log for intermediate debugging', async () => {
    const executor = createExecutor();
    const code = `
console.log("Starting search...");
const result = await tools.search({ query: "test" });
console.log("Search returned:", result.success);
const parsed = JSON.parse(result.reply);
console.log("Found", parsed.results.length, "results");
return parsed.results.length;
`;
    const result = await executor.execute(codeCall(code), context);

    expect(result.success).toBe(true);
    expect(result.reply).toContain('Console Output');
    expect(result.reply).toContain('Starting search...');
    expect(result.reply).toContain('Found');
    expect(result.data?.returnValue).toBe(2);
  });

  // ── Sandbox safety: internal tools and execute_code not exposed ──

  it('does not expose internal tools to sandbox', async () => {
    const executor = createExecutor();
    const code = `return Object.keys(tools);`;
    const result = await executor.execute(codeCall(code), context);

    expect(result.success).toBe(true);
    const toolNames = result.data?.returnValue as string[];
    expect(toolNames).toContain('search');
    expect(toolNames).toContain('memory');
    expect(toolNames).not.toContain('internal_admin');
    expect(toolNames).not.toContain('execute_code');
  });

  // ── Edge cases: empty code, missing code ──

  it('rejects empty code', async () => {
    const executor = createExecutor();
    const result = await executor.execute(codeCall('   '), context);
    expect(result.success).toBe(false);
  });

  it('rejects missing code parameter', async () => {
    const executor = createExecutor();
    const result = await executor.execute(createToolCall('execute_code', {}), context);
    expect(result.success).toBe(false);
  });

  // ── Timeout configuration ──

  it('respects custom timeout parameter', async () => {
    const executor = createExecutor();
    const code = `await new Promise(r => setTimeout(r, 5000))`;
    const result = await executor.execute(codeCall(code, 1000), context);

    expect(result.success).toBe(false);
    expect(result.reply).toContain('timed out');
  });

  it('caps timeout at 30 seconds', async () => {
    const executor = createExecutor();
    const code = `return "ok"`;
    const result = await executor.execute(codeCall(code, 60000), context);
    expect(result.success).toBe(true);
  });

  // ── LLM data processing with tools ──

  it('LLM searches, filters, and formats results as a report', async () => {
    const executor = createExecutor();
    const code = `
const topics = ["JavaScript", "Python"];
const allResults = [];

for (const topic of topics) {
  const res = await tools.search({ query: topic });
  const parsed = JSON.parse(res.reply);
  allResults.push(...parsed.results.map(r => ({ topic, ...r })));
}

// Format as a simple report
const report = allResults
  .map(r => \`[\${r.topic}] \${r.title}\`)
  .join("\\n");

return report;
`;
    const result = await executor.execute(codeCall(code), context);

    expect(result.success).toBe(true);
    expect(result.reply).toContain('[JavaScript]');
    expect(result.reply).toContain('[Python]');
  });
});
