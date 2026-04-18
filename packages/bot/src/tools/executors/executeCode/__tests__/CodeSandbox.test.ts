import { describe, expect, it } from 'bun:test';
import { CodeSandbox } from '../CodeSandbox';
import type { SandboxGlobals } from '../types';

/**
 * Builds minimal sandbox globals for testing.
 * Console capture is done via the logs array passed in.
 */
function buildTestGlobals(overrides: { tools?: SandboxGlobals['tools']; logs?: string[] } = {}): SandboxGlobals {
  const logs = overrides.logs ?? [];

  const capture = (level: string) => {
    return (...args: unknown[]) => {
      const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      logs.push(`[${level}] ${msg}`);
    };
  };

  return {
    tools: (overrides.tools ?? {}) as SandboxGlobals['tools'],
    console: { log: capture('log'), warn: capture('warn'), error: capture('error'), info: capture('info') },
    fetch: globalThis.fetch.bind(globalThis),
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    JSON: globalThis.JSON,
    Math: globalThis.Math,
    Date: globalThis.Date,
    Array: globalThis.Array,
    Object: globalThis.Object,
    Map: globalThis.Map,
    Set: globalThis.Set,
    RegExp: globalThis.RegExp,
    Promise: globalThis.Promise,
    parseInt: globalThis.parseInt,
    parseFloat: globalThis.parseFloat,
    isNaN: globalThis.isNaN,
    isFinite: globalThis.isFinite,
    encodeURIComponent: globalThis.encodeURIComponent,
    decodeURIComponent: globalThis.decodeURIComponent,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
  };
}

describe('CodeSandbox', () => {
  // ── Basic execution ──

  it('executes simple expression and returns result', async () => {
    const sandbox = new CodeSandbox({ timeoutMs: 5000, maxOutputLength: 8000, maxConsoleLogs: 100 });
    const result = await sandbox.execute('1 + 2', buildTestGlobals());

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(3);
  });

  it('executes multi-statement code and returns last expression', async () => {
    const sandbox = new CodeSandbox();
    const code = `
const a = 10;
const b = 20;
a + b
`;
    const result = await sandbox.execute(code, buildTestGlobals());

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(30);
  });

  it('handles explicit return statement', async () => {
    const sandbox = new CodeSandbox();
    const code = `
const items = [1, 2, 3];
return items.map(x => x * 2);
`;
    const result = await sandbox.execute(code, buildTestGlobals());

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual([2, 4, 6]);
  });

  it('supports async/await', async () => {
    const sandbox = new CodeSandbox();
    const code = `
const result = await Promise.resolve(42);
result
`;
    const result = await sandbox.execute(code, buildTestGlobals());

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(42);
  });

  // ── Console capture ──

  it('captures console.log output via globals', async () => {
    const sandbox = new CodeSandbox();
    const logs: string[] = [];
    const code = `
console.log("hello");
console.log("world");
"done"
`;
    const result = await sandbox.execute(code, buildTestGlobals({ logs }));

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe('done');
    expect(logs).toEqual(['[log] hello', '[log] world']);
  });

  // ── Tool calling ──

  it('can call tools via the tools object', async () => {
    const sandbox = new CodeSandbox();
    const mockSearch = async (params: Record<string, unknown>) => ({
      success: true as const,
      data: `Found results for: ${params.query}`,
      text: `Found results for: ${params.query}`,
    });
    const code = `
const result = await tools.search({ query: "test query" });
result.text
`;
    const result = await sandbox.execute(code, buildTestGlobals({ tools: { search: mockSearch } }));

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe('Found results for: test query');
  });

  it('can call multiple tools in parallel', async () => {
    const sandbox = new CodeSandbox({ timeoutMs: 5000, maxOutputLength: 8000, maxConsoleLogs: 100 });
    const mockTool = async (params: Record<string, unknown>) => ({
      success: true as const,
      data: `result:${params.id}`,
      text: `result:${params.id}`,
    });
    const code = `
const results = await Promise.all([
  tools.myTool({ id: 1 }),
  tools.myTool({ id: 2 }),
  tools.myTool({ id: 3 }),
]);
results.map(r => r.text)
`;
    const result = await sandbox.execute(code, buildTestGlobals({ tools: { myTool: mockTool } }));

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual(['result:1', 'result:2', 'result:3']);
  });

  it('handles tool errors gracefully', async () => {
    const sandbox = new CodeSandbox();
    const failingTool = async () => {
      throw new Error('tool exploded');
    };
    const code = `
try {
  await tools.broken({});
} catch (e) {
  return "caught: " + e.message;
}
`;
    const result = await sandbox.execute(code, buildTestGlobals({ tools: { broken: failingTool } }));

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe('caught: tool exploded');
  });

  // ── Timeout ──

  it('times out for long-running code', async () => {
    const sandbox = new CodeSandbox({ timeoutMs: 200, maxOutputLength: 8000, maxConsoleLogs: 100 });
    const code = `await new Promise(r => setTimeout(r, 10000))`;
    const result = await sandbox.execute(code, buildTestGlobals());

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('times out when a tool call hangs', async () => {
    const sandbox = new CodeSandbox({ timeoutMs: 200, maxOutputLength: 8000, maxConsoleLogs: 100 });
    const hangingTool = async (_params: Record<string, unknown>) => new Promise<never>(() => {}); // never resolves
    const code = `await tools.hanging({})`;
    const result = await sandbox.execute(code, buildTestGlobals({ tools: { hanging: hangingTool } }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  // ── Error handling ──

  it('reports syntax errors', async () => {
    const sandbox = new CodeSandbox();
    const code = `const x = {;`;
    const result = await sandbox.execute(code, buildTestGlobals());

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('reports runtime errors', async () => {
    const sandbox = new CodeSandbox();
    const code = `
const obj = null;
obj.property
`;
    const result = await sandbox.execute(code, buildTestGlobals());

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  // ── Edge case: 'return ' appearing in strings should not break wrapping ──

  it('handles code containing "return " inside a string literal', async () => {
    const sandbox = new CodeSandbox();
    // This code has 'return ' in a string but no actual return statement.
    // The heuristic `code.includes('return ')` would match it, treating it
    // as raw function body instead of wrapping in IIFE.
    const code = `
const msg = "please return the book";
msg.length
`;
    const result = await sandbox.execute(code, buildTestGlobals());

    expect(result.success).toBe(true);
    // 'return ' appears inside a string, but addImplicitReturn correctly
    // identifies the last line (msg.length) as an expression and adds return.
    expect(result.returnValue).toBe(22);
  });

  // ── Data processing patterns LLMs commonly generate ──

  it('handles JSON parsing and transformation', async () => {
    const sandbox = new CodeSandbox();
    const code = `
const data = JSON.parse('{"items": [1, 2, 3, 4, 5]}');
const sum = data.items.reduce((a, b) => a + b, 0);
return { sum, count: data.items.length, avg: sum / data.items.length };
`;
    const result = await sandbox.execute(code, buildTestGlobals());

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ sum: 15, count: 5, avg: 3 });
  });

  it('handles Map and Set operations', async () => {
    const sandbox = new CodeSandbox();
    const code = `
const set = new Set([1, 2, 3, 2, 1]);
const map = new Map();
for (const v of set) map.set(v, v * v);
return Array.from(map.entries());
`;
    const result = await sandbox.execute(code, buildTestGlobals());

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual([
      [1, 1],
      [2, 4],
      [3, 9],
    ]);
  });

  it('handles string encoding utilities', async () => {
    const sandbox = new CodeSandbox();
    const code = `
const encoded = btoa("hello world");
const decoded = atob(encoded);
return { encoded, decoded };
`;
    const result = await sandbox.execute(code, buildTestGlobals());

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ encoded: 'aGVsbG8gd29ybGQ=', decoded: 'hello world' });
  });

  // ── Compile-check fallback edge cases ──

  it('gracefully falls back when last line is a multi-line chain tail', async () => {
    const sandbox = new CodeSandbox();
    // Adding `return .filter(...)` would be a syntax error.
    // The compile-check catches it and falls back to no implicit return.
    const code = `
const arr = [1, 2, 3, 4, 5]
  .map(x => x * 2)
  .filter(x => x > 4)
`;
    const result = await sandbox.execute(code, buildTestGlobals());

    // Falls back to original code → no return → returnValue is undefined, but no crash
    expect(result.success).toBe(true);
  });

  it('gracefully falls back when last line is a closing bracket', async () => {
    const sandbox = new CodeSandbox();
    const code = `
if (true) {
  console.log("yes");
}
`;
    const logs: string[] = [];
    const result = await sandbox.execute(code, buildTestGlobals({ logs }));

    expect(result.success).toBe(true);
    expect(logs).toEqual(['[log] yes']);
  });

  it('handles return inside a nested function without interfering', async () => {
    const sandbox = new CodeSandbox();
    // The `return 42` is inside an arrow function, not a top-level return.
    // The last expression `fn()` should get implicit return.
    const code = `
const fn = () => { return 42; };
fn()
`;
    const result = await sandbox.execute(code, buildTestGlobals());

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(42);
  });
});
