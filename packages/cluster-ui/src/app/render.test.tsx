import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type {
  ClusterEventEntry,
  ClusterHelpRequest,
  ClusterTask,
  ClusterTaskDetail,
  ClusterTemplatesResponse,
  ClusterWorkerHistoryEntry,
  EnrichedWorkerRegistration,
  ProjectsResponse,
  Ticket,
} from '@qqbot/api-types';

GlobalRegistrator.register({ url: 'http://localhost/', width: 1280, height: 800 });

// happy-dom has no layout engine; React Flow and the virtual lists read these.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
    this.m22 = scale ? Number(scale) : 1;
  }
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverStub, DOMMatrixReadOnly: DOMMatrixReadOnlyStub });
for (const prop of ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight']) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get: () => (prop.endsWith('Width') ? 1024 : 768),
  });
}
Element.prototype.scrollIntoView = () => {};
// Radix Select asks the pointer-capture API before it opens.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

const { render, cleanup, screen, within, fireEvent } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router');
const { ClusterDataContext } = await import('./ClusterData');
const { Shell } = await import('./Shell');
const { buildRuns } = await import('../lib/runs');

type ClusterData = NonNullable<React.ContextType<typeof ClusterDataContext>>;

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MIN = 60_000;

function task(id: string, patch: Partial<ClusterTask>): ClusterTask {
  return {
    id,
    jobId: `job-${id}`,
    project: 'demo',
    description: id,
    status: 'running',
    source: 'queue',
    createdAt: iso(-30 * MIN),
    ...patch,
  };
}

const ROOT = 'root-run';
const DONE = 'child-done';
const FAILED = 'child-failed';
const HISTORY = 'history-root';

const root = task(ROOT, {
  description: '整理示例项目的配置',
  workerTemplate: 'planner',
  workerId: 'worker-root',
  startedAt: iso(-20 * MIN),
  model: 'claude-opus-5-5',
});
const doneChild = task(DONE, {
  description: '实现甲模块',
  workerTemplate: 'coder-done',
  parentTaskId: ROOT,
  status: 'completed',
  startedAt: iso(-18 * MIN),
  completedAt: iso(-10 * MIN),
  diffSummary: '甲模块已完成',
  filesModified: JSON.stringify(['src/a.ts']),
});
const failedChild = task(FAILED, {
  description: '实现乙模块',
  workerTemplate: 'coder-failed',
  parentTaskId: ROOT,
  status: 'failed',
  startedAt: iso(-9 * MIN),
  completedAt: iso(-5 * MIN),
  error: 'Process exited with code 1',
});
const historyRoot = task(HISTORY, {
  description: '已结束的历史任务',
  status: 'completed',
  startedAt: iso(-3 * 60 * MIN),
  completedAt: iso(-2 * 60 * MIN),
});

const ask: ClusterHelpRequest = {
  id: 'ask-1',
  workerId: 'worker-root',
  taskId: ROOT,
  type: 'question',
  question: '要不要保留旧配置？',
  options: ['保留', '丢弃'],
  status: 'pending',
  createdAt: iso(-4 * MIN),
};

const TASKS = [root, doneChild, failedChild, historyRoot];

const TICKET_ID = 'T-1';
const TICKET: Ticket = {
  id: TICKET_ID,
  frontmatter: {
    id: TICKET_ID,
    title: '示例 ticket',
    status: 'ready',
    project: 'demo',
    template: 'coder-done',
    created: iso(-60 * MIN),
    updated: iso(-60 * MIN),
  },
  body: '示例 ticket 正文',
};
const RESULT_FILE = 'plan.md';

const worker = (patch: Partial<EnrichedWorkerRegistration>): EnrichedWorkerRegistration => ({
  workerId: 'worker-root',
  role: 'planner',
  project: 'demo',
  templateName: 'planner',
  status: 'busy',
  lastSeen: NOW,
  syncCursor: 0,
  stats: { tasksCompleted: 0, tasksFailed: 0, totalReports: 1, registeredAt: NOW - 20 * MIN },
  spawnedAt: NOW - 20 * MIN,
  lastReportSummary: '正在整理配置',
  ...patch,
});
const aliveWorker = worker({});
const exitedWorker: ClusterWorkerHistoryEntry = {
  ...worker({
    workerId: 'worker-old',
    templateName: 'coder-done',
    role: 'coder',
    status: 'exited',
    exitedAt: NOW - 60 * MIN,
    lastReportStatus: 'completed',
    lastReportSummary: '甲模块已收尾',
  }),
};

const TEMPLATES: ClusterTemplatesResponse = {
  templates: [
    {
      name: 'planner',
      type: 'claude',
      role: 'planner',
      command: 'claude',
      model: 'claude-opus-5-5',
      maxConcurrent: 1,
      capabilities: [],
      costTier: 'high',
    },
    {
      name: 'coder-done',
      type: 'codex',
      role: 'executor',
      command: 'codex',
      maxConcurrent: 2,
      capabilities: [],
      costTier: 'low',
    },
  ],
  projectDefaults: { demo: 'coder-done' },
};
const PROJECTS: ProjectsResponse = {
  defaultAlias: 'demo',
  projects: [
    {
      alias: 'demo',
      path: '/tmp/demo-project',
      type: 'git',
      description: '示例项目说明',
      hasClaudeMd: false,
      isDefault: true,
      isConfig: true,
    },
  ],
};

function event(seq: number, type: ClusterEventEntry['type'], taskId: string, data: Record<string, unknown>) {
  return {
    seq,
    timestamp: NOW - (20 - seq) * MIN,
    createdAt: iso(-(20 - seq) * MIN),
    type,
    sourceWorkerId: 'worker-root',
    taskId,
    data,
  } as ClusterEventEntry;
}

const EVENTS: Record<string, ClusterEventEntry[]> = {
  [ROOT]: [
    event(1, 'worker_progress', ROOT, { status: 'working', summary: '正在拆分子任务', nextSteps: '派发甲模块' }),
    event(2, 'help_request', ROOT, { askId: ask.id, question: ask.question }),
  ],
  [DONE]: [event(3, 'worker_progress', DONE, { status: 'working', summary: '甲模块进行中' })],
  [FAILED]: [
    event(4, 'task_failed', FAILED, {
      status: 'failed',
      summary: '乙模块失败',
      detail: { error: 'Process exited with code 1' },
    }),
  ],
};

const detailOf = (id: string): ClusterTaskDetail | undefined => {
  const found = TASKS.find((candidate) => candidate.id === id);
  if (!found) {
    return undefined;
  }
  return id === ROOT ? { ...found, children: [doneChild, failedChild] } : found;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const realFetch = globalThis.fetch;

function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input), 'http://localhost').pathname;
  const events = path.match(/^\/api\/cluster\/tasks\/([^/]+)\/events$/);
  if (events) {
    return Promise.resolve(json(EVENTS[decodeURIComponent(events[1])] ?? []));
  }
  const taskMatch = path.match(/^\/api\/cluster\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const detail = detailOf(decodeURIComponent(taskMatch[1]));
    return Promise.resolve(detail ? json(detail) : json({ error: 'not found' }, 404));
  }
  if (path === '/api/tickets') {
    return Promise.resolve(json({ tickets: [TICKET.frontmatter] }));
  }
  if (path === `/api/tickets/${TICKET_ID}/results/${RESULT_FILE}`) {
    return Promise.resolve(json({ content: '示例结果内容' }));
  }
  if (path === `/api/tickets/${TICKET_ID}`) {
    return Promise.resolve(json(TICKET));
  }
  return Promise.resolve(json({ error: 'not found' }, 404));
}

beforeAll(() => {
  globalThis.fetch = fakeFetch as typeof fetch;
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  // React schedules work on a macrotask; letting it drain keeps it from running after `window` is gone.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

function clusterData(): ClusterData {
  const rows = TASKS.map((row) => ({ task: row }));
  return {
    loaded: true,
    unreachable: false,
    health: { ok: true, startedAt: iso(-3 * 60 * MIN), cluster: { running: true, paused: false, activeWorkers: 1 } },
    cluster: {
      started: true,
      status: {
        running: true,
        paused: false,
        activeWorkers: 1,
        idleWorkers: 0,
        pendingTasks: 0,
        runningTasks: 1,
        completedTasks: 0,
        failedTasks: 0,
        workers: [],
      },
    },
    runs: buildRuns(rows, [ask], [], NOW),
    help: [ask],
    helpHistory: [ask],
    workers: [aliveWorker],
    workerHistory: [exitedWorker],
    locks: [],
    templates: TEMPLATES,
    projects: PROJECTS,
    workerExits: new Map(),
    hasMoreHistory: false,
    oldestLoadedAt: null,
    version: 1,
    refresh: async () => {},
    loadMoreHistory: () => {},
  };
}

function renderAt(url: string) {
  return render(
    <ClusterDataContext.Provider value={clusterData()}>
      <MemoryRouter initialEntries={[url]}>
        <Shell />
      </MemoryRouter>
    </ClusterDataContext.Provider>,
  );
}

describe('Shell routes render', () => {
  const cases: Array<[string, string, string | RegExp]> = [
    ['home', '/', '等你处理'],
    ['inbox', '/inbox', /件需要你/],
    ['task default tab', `/t/${ROOT}`, '正在拆分子任务'],
    ['task chat', `/t/${ROOT}?tab=chat`, '要不要保留旧配置？'],
    ['task topology', `/t/${ROOT}?tab=topology`, 'coder-failed'],
    ['task result', `/t/${ROOT}?tab=result`, '派生了 2 条子运行'],
    ['worker chat', `/t/${ROOT}/w/${DONE}`, '甲模块进行中'],
    ['failed worker', `/t/${ROOT}/w/${FAILED}`, 'Process exited with code 1'],
    ['log overlay', `/t/${ROOT}?log=1`, '日志'],
    ['unknown task', '/t/不存在的id', '找不到这条运行。它可能已被清理，或调度已停止。'],
    ['settings workers: live', '/settings/workers', '正在整理配置'],
    ['settings workers: exited', '/settings/workers', '甲模块已收尾'],
    ['settings templates', '/settings/templates', '探测模板'],
    ['settings projects', '/settings/projects', '示例项目说明'],
    ['settings concurrency', '/settings/concurrency', /各模板余量之和/],
    ['settings daemon', '/settings/daemon', '启动时间'],
    ['settings console', '/settings/console', '快捷键'],
    ['unknown settings group falls to workers', '/settings/不存在', '正在整理配置'],
    ['composer', '/?new=1', '开始运行'],
    ['ticket body sheet', `/t/${ROOT}?ticket=${TICKET_ID}`, '保存正文'],
    ['ticket result sheet', `/t/${ROOT}?ticket=${TICKET_ID}&file=${RESULT_FILE}`, '示例结果内容'],
    ['composer with ticket sheet', `/?new=1&ticket=${TICKET_ID}`, '保存正文'],
    ['created ticket link', `/t/${ROOT}?created=${TICKET_ID}`, `已建 ticket ${TICKET_ID}`],
  ];

  for (const [name, url, text] of cases) {
    test(`${name}: ${url}`, async () => {
      renderAt(url);
      const found = await screen.findAllByText(text, {}, { timeout: 3000 });
      expect(found.length).toBeGreaterThan(0);
    });
  }

  test('inbox lists the pending question with its answer box and the archive heading', async () => {
    const { container } = renderAt('/inbox');
    await screen.findAllByText('等你回答');
    expect(container.querySelector('[data-answer-box]')).not.toBeNull();
    expect(container.querySelector('[data-row]')).not.toBeNull();
  });

  test('topology draws every task of the tree, finished ones included', async () => {
    const { container } = renderAt(`/t/${ROOT}?tab=topology`);
    await screen.findAllByText('coder-done');
    const canvas = container.querySelector<HTMLElement>('.react-flow');
    expect(canvas).not.toBeNull();
    const inCanvas = within(canvas as HTMLElement);
    expect(inCanvas.queryAllByText('coder-done').length).toBe(1);
    expect(inCanvas.queryAllByText('coder-failed').length).toBe(1);
    expect(inCanvas.queryAllByText('整理示例项目的配置').length).toBe(1);
    expect(inCanvas.queryAllByText('已结束的历史任务').length).toBe(0);
  });

  test('settings workers shows model name, run link and pid fields', async () => {
    renderAt('/settings/workers');
    await screen.findAllByText('正在整理配置');
    expect(screen.getAllByText('终止 worker').length).toBe(1);
    expect(screen.getAllByText('最近 7 天退出 · 1').length).toBe(1);
  });

  test('daemon popover offers pause and stop while running', async () => {
    renderAt('/');
    fireEvent.click(await screen.findByLabelText('调度运行中'));
    await screen.findByText('暂停调度');
    expect(screen.getAllByText('停止调度').length).toBeGreaterThan(0);
    expect(screen.getAllByText('打开设置').length).toBe(1);
  });

  test('composer template select renders the auto choice without throwing', async () => {
    renderAt('/?new=1');
    const trigger = await screen.findByLabelText('模板');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const option = await screen.findByRole('option', { name: '自动选择' });
    expect(option).not.toBeNull();
    expect(screen.getAllByRole('option').length).toBe(3);
  });
});
