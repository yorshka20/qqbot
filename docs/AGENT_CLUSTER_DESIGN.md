# Agent Cluster 设计方案

> 本文档是 Agent Cluster 功能的完整实施方案，供 Claude Code 结合 codebase 实现。
> 目标：在 QQ Bot 上构建一个自主运行的 worker pool，通过 ContextHub（MCP server）实现 worker 间通信与状态同步，WebUI 为主要监控面板。

---

## 1. 概述

### 1.1 核心理念

QQ Bot 作为调度平台，管理一组持续自主运行的 agent worker。worker 通过 MCP 协议连接到中央 ContextHub 进行状态同步和通信。用户通过 WebUI 监控集群状态，QQ 侧仅保留极简的控制命令和关键事件通知。

### 1.2 系统架构

```
用户（QQ/WebUI）
  → QQ Bot 调度层
    → ClusterScheduler（调度循环）
      → WorkerPool（worker 生命周期管理）
        → Worker 实例（Claude Code CLI / 其他 executor）
          ←→ ContextHub（MCP Server，中央通信枢纽）
              ├→ EventLog（增量事件流）
              ├→ LockManager（文件锁）
              ├→ MessageBox（worker 间消息）
              └→ SQLite（持久化 + WebUI 数据源）
```

### 1.3 与现有架构的关系

| 现有组件 | 角色 |
|---------|------|
| `ProjectRegistry` | 直接复用，worker 绑定到已注册项目 |
| `ClaudeCodeService` + `ClaudeToolManager` | 重构为 `ClaudeCliBackend`（WorkerBackend 的一种实现） |
| `MCPServer` | 现有的 HTTP API server 作为参考，ContextHub 是独立的新 MCP server |
| `AgendaService` | 定时触发 Job、daily digest |
| `TodoWorkerHandler` / `RepeatingTodoWorkerHandler` | 升级为 `TodoFileSource`（TaskSource 实现） |
| `InternalEventBus` | 集群事件通知复用 |
| `DatabaseManager` | 新增 cluster 相关表 |
| API Router | 新增 `/api/cluster/*` 端点供 WebUI 使用 |

---

## 2. Worker 行为协议

### 2.1 设计原则

worker 的行为规则必须满足两个约束：
- **简单**：能写在一段 prompt 里讲清楚，不需要 worker 理解复杂的分布式系统概念
- **完备**：覆盖所有实际场景，worker 不会遇到"不知道该怎么办"的情况

### 2.2 从工作流推导动作集

一个 worker 的完整工作流：

```
启动 → 了解环境 → 声明任务 → 执行工作 → 遇到问题？→ 上报结果
```

每个阶段对应的需求：

1. **了解环境**：我需要知道当前项目状态、其他人在做什么、有没有给我的指令
2. **声明任务**：我要开始做 X 了，会碰这些文件，有没有冲突？
3. **执行中上报**：我做了什么、改了哪些文件、进展如何（同时作为心跳）
4. **同步情报**：其他人有没有改了我关心的东西？planner 有没有新指示？
5. **请求帮助**：我遇到了自己解决不了的问题，需要 planner 或人工介入
6. **完成/失败**：任务结束，汇报最终结果

分析后归纳为 **5 个 MCP tool**：

| Tool | 对应阶段 | 调用时机 |
|------|---------|---------|
| `hub_sync` | 了解环境 + 同步情报 | 任务开始前必调；执行中定期调；合并了"fetch update"的语义 |
| `hub_claim` | 声明任务 | 准备开始修改文件前调用 |
| `hub_report` | 执行中上报 + 完成/失败 | 每个有意义的步骤后调用；任务结束时带终态 |
| `hub_ask` | 请求帮助 | 遇到自己无法决策的问题时调用 |
| `hub_message` | 自由通信 | 需要通知其他 worker 或 planner 时调用 |

### 2.3 各 Tool 详细定义

#### `hub_sync`

统一的"获取外部信息"入口。合并了初始化环境感知和中途增量更新。

```
描述: 与 ContextHub 同步，获取最新的项目状态、其他 worker 的变更、给你的指令和消息。
      首次调用返回完整状态，后续调用返回增量更新。

输入:
  无必填参数（hub 通过 worker 身份自动追踪同步进度）

输出:
  updates: Array<{
    type: "file_changed"     // 其他 worker 修改了文件
         | "task_completed"  // 其他 worker 完成了任务
         | "directive"       // planner 给你的指令（必须遵守）
         | "answer"          // 对你之前 hub_ask 的回复
         | "lock_released"   // 你之前 claim 冲突的文件已释放
         | "worker_joined"   // 新 worker 加入
         | "worker_left"     // worker 退出
    from: string             // 来源 worker ID
    summary: string          // 人可读的摘要
    data?: object            // 结构化详情（文件列表、diff 摘要等）
  }>
  cluster: {                 // 集群概况
    activeWorkers: number
    pendingTasks: number
    myPendingMessages: number
  }
```

#### `hub_claim`

声明任务开始，锁定相关文件。

```
描述: 声明你要开始一个任务，锁定你预计会修改的文件。
      如果有文件被其他 worker 占用，会返回冲突信息。
      你不需要手动释放锁——hub_report 终态时自动释放。

输入:
  taskId: string             // 调度器分配的任务 ID
  intent: string             // 一句话描述你要做什么
  files: string[]            // 你预计会修改的文件路径列表

输出:
  granted: boolean           // 是否可以开始
  conflicts?: Array<{
    file: string
    heldBy: string           // 占用者的 worker ID
    since: number            // 占用开始时间戳
    estimatedRelease?: number // 预计释放时间（如果有）
  }>
  suggestion?: string        // hub 的建议（比如 "建议先处理不涉及冲突文件的部分"）
```

#### `hub_report`

上报进展，同时作为心跳。终态 report 触发锁释放。

```
描述: 上报你的工作进展。每完成一个有意义的步骤都应该调用。
      这也是你的心跳——长时间不 report 会被视为失联。
      status 为 completed/failed/blocked 时，hub 自动释放你持有的所有文件锁。

输入:
  status: "working"          // 正在进行中
        | "completed"        // 任务成功完成
        | "failed"           // 任务失败
        | "blocked"          // 任务被阻塞，无法继续
  summary: string            // 这次 report 以来做了什么
  filesModified?: string[]   // 实际修改过的文件列表
  detail?: {                 // 可选的详细信息
    linesAdded?: number
    linesRemoved?: number
    testsRan?: number
    testsPassed?: number
    error?: string           // 仅 failed/blocked 时
    blockReason?: string     // 仅 blocked 时
  }

输出:
  ack: true
  directives?: string[]      // 顺带返回 planner 给你的未读指令（减少一次 sync 调用）
```

#### `hub_ask`

请求帮助或决策。异步的——不阻塞 worker 执行。

```
描述: 遇到自己无法决策的问题时调用。问题会被转发给 planner 或人工。
      发出后不要停下来等回复——先跳过这个问题继续做能做的部分。
      回复会通过后续的 hub_sync 或 hub_report 的 directives 返回。

输入:
  type: "clarification"      // 任务描述有歧义
      | "decision"           // 需要架构/设计决策
      | "conflict"           // 发现和其他 worker 的工作有冲突
      | "escalation"         // 需要人工介入（会发 QQ 通知）
  question: string           // 具体问题描述
  context?: string           // 相关上下文
  options?: string[]         // 你认为可能的选项

输出:
  received: true
  askId: string              // 追踪 ID
  expectedResponseTime?: string // 预估回复时间（如 "planner 通常 1-2 分钟内回复"）
```

#### `hub_message`

自由形式的 worker 间通信。

```
描述: 发送消息给其他 worker 或 planner。用于主动通知，而非请求帮助。
      比如："我发现 X 模块有个 bug，和我的任务无关但你可能需要知道"。

输入:
  to: string                 // 目标 worker ID，或 "planner"，或 "all"（广播）
  content: string            // 消息内容
  priority: "info"           // 仅供参考
           | "warning"       // 需要注意

输出:
  delivered: true
```

### 2.4 Worker 行为规则（完整 prompt）

以下内容会注入到每个 worker 的 prompt 或项目的 CLAUDE.md 中：

```markdown
## 协作协议

你正在一个多 worker 协作环境中工作，通过 ContextHub MCP tools 与其他 worker 和 planner 通信。

### 核心规则

1. **开始任务前**
   - 调用 `hub_sync` 了解当前状态和有没有给你的指令
   - 调用 `hub_claim` 声明任务和涉及的文件
   - 如果 claim 返回冲突：先做不涉及冲突文件的部分，稍后重试 claim（最多 3 次，间隔 30 秒）
   - 3 次仍冲突：report status=blocked，说明原因，停止

2. **执行过程中**
   - 每完成一个有意义的步骤（修改完一个文件、写完一个函数、跑完一次测试），调用 `hub_report`
   - 当你修改超过 3 个文件，或执行超过 5 分钟，调用 `hub_sync` 检查外部变更
   - 如果 sync 返回了 directive，优先遵守。directive 和任务描述矛盾时，调用 `hub_ask` 请求澄清

3. **遇到问题时**
   调用 `hub_ask`，不要自己猜测，但也不要停下来等回复。继续做能做的部分。
   以下情况必须 ask：
   - 任务描述有歧义，存在多种理解
   - 需要修改不在你 claim 范围内的文件（先 claim 新文件，冲突则 ask）
   - 发现代码现状和任务预期不符
   - 需要做影响其他模块的架构决策

4. **任务结束时**
   调用 `hub_report` 并设置终态 status：
   - `completed`：任务成功，附上改动摘要
   - `failed`：任务失败，附上错误信息和失败原因
   - `blocked`：无法继续，附上阻塞原因
   不需要手动释放文件锁，hub 自动处理。

5. **绝对禁止**
   - 不 claim 就直接修改文件
   - 长时间不 report（你会被判定为失联，锁会被回收）
   - 忽略 directive（它们来自 planner，优先级高于你自己的判断）
   - 无限重试失败的操作（3 次失败就 report blocked）
```

---

## 3. ContextHub 设计

### 3.1 定位

ContextHub 是一个独立的 HTTP/MCP server，运行在 QQ Bot 进程内部。它是所有 worker 的唯一通信枢纽，职责：

- **状态存储**：所有 worker 的 claim、report、锁状态
- **事件分发**：增量事件流，每个 worker 按自己的 cursor 消费
- **消息路由**：worker 间的消息、planner 的 directive
- **锁管理**：文件锁的创建、续期、释放、过期回收
- **数据持久化**：所有数据落 SQLite，供 WebUI 查询和审计

### 3.2 内部组件

```
ContextHub
  ├── EventLog          // 有序事件流，每条事件有递增 seq
  ├── LockManager       // 文件锁管理
  ├── MessageBox        // per-worker 消息队列
  ├── WorkerRegistry    // worker 注册信息和心跳追踪
  └── PersistenceLayer  // SQLite 读写
```

### 3.3 EventLog

所有 worker 的 report、claim、message 都会产生 event 写入 EventLog。每个 worker 维护一个 cursor（上次 sync 到哪个 seq），sync 时返回 cursor 之后的所有事件（过滤掉自己产生的）。

```typescript
interface EventEntry {
  seq: number;               // 全局递增序列号
  timestamp: number;
  type: string;              // 'file_changed' | 'task_completed' | 'directive' | ...
  sourceWorkerId: string;
  targetWorkerId?: string;   // 如果是定向事件
  data: Record<string, any>;
}
```

EventLog 容量管理：
- 内存中保留最近 N 条（如 1000 条），超出时 compact 旧事件为摘要
- 全量持久化到 SQLite `cluster_events` 表，供审计查询
- worker 的 cursor 如果落后太多（比如被 compact 掉了），sync 返回一个 `compacted_summary` 字段给出合并摘要

### 3.4 LockManager

#### 锁的生命周期

```
hub_claim 创建锁 → hub_report(working) 续期 → hub_report(终态) 释放
                                             → TTL 过期释放（兜底）
                                             → 进程退出释放（调度器通知）
```

#### 锁的类型

只有一种：**独占锁**。简化设计，不搞 shared/exclusive 区分。

#### 续期机制

- 每次 `hub_report` 自动续期该 worker 持有的所有锁
- 每次 `hub_sync` 同样自动续期
- TTL 默认 10 分钟（即 worker 10 分钟不调任何 hub tool 才会过期）

#### 冲突处理

`hub_claim` 发现冲突时：
1. 返回冲突文件列表和占用者信息
2. 不阻塞——worker 自行决定等待或跳过（按行为规则：重试 3 次后 report blocked）
3. 锁释放时写入 EventLog 的 `lock_released` 事件
4. worker 下次 `hub_sync` 时收到通知，可以重新 claim

#### 过期和异常清理

三层防护，优先级递减：

1. **进程退出清理**（最优先）：ClusterScheduler 持有 worker 进程引用，进程退出时调用 `hub.workerExited(workerId)`，立即释放该 worker 的所有锁
2. **终态 report 清理**：`hub_report(completed|failed|blocked)` 触发 `releaseAllLocks(workerId)`
3. **TTL 过期清理**（兜底）：定时扫描，过期锁释放并写入 EventLog。仅在前两层都失效时（如 QQ Bot 进程本身崩溃后重启）才触发

### 3.5 MessageBox

每个 worker 有一个消息队列。消息来源：
- 其他 worker 的 `hub_message`
- planner 对 `hub_ask` 的回复（type 为 `answer`）
- planner 主动发出的 directive

消息通过 `hub_sync` 返回（合并在 `updates` 里），取出后标记已读。
也会在 `hub_report` 的返回值 `directives` 字段中顺带返回 directive 类型的消息，减少额外的 sync 调用。

### 3.6 WorkerRegistry

追踪所有已注册的 worker：

```typescript
interface WorkerRegistration {
  workerId: string;
  role: 'coder' | 'planner' | 'reviewer' | 'custom';
  project: string;          // 绑定的项目 alias
  templateName: string;     // 使用的 worker 模板
  status: 'active' | 'idle' | 'exited';
  currentTaskId?: string;
  lastSeen: number;          // 最后一次 sync/report 的时间
  syncCursor: number;        // EventLog cursor
  stats: {
    tasksCompleted: number;
    tasksFailed: number;
    totalReports: number;
    registeredAt: number;
  };
}
```

worker 首次调用任何 hub tool 时自动注册（通过 MCP 请求中的 env 传入 workerId 等信息）。

---

## 4. WorkerPool 和调度器

### 4.1 WorkerPool

管理 worker 实例的生命周期：

```typescript
interface WorkerPool {
  start(): Promise<void>;       // 启动 pool，开始调度循环
  stop(): Promise<void>;        // 停止所有 worker，清理资源
  pause(): Promise<void>;       // 暂停领取新任务，当前任务跑完
  resume(): Promise<void>;

  // 手动操作
  spawnWorker(template: string, project: string, task: TaskRecord): Promise<WorkerInstance>;
  killWorker(workerId: string): Promise<void>;

  // 状态查询
  getStatus(): ClusterStatus;
  getWorkers(): WorkerInstance[];
}
```

### 4.2 WorkerInstance

```typescript
interface WorkerInstance {
  id: string;                    // 'worker-a3f2'
  templateName: string;          // 'claude-sonnet'
  project: string;               // 项目 alias
  process: ChildProcess | null;  // 底层进程引用
  status: 'starting' | 'running' | 'idle' | 'stopping' | 'exited';
  currentTask: TaskRecord | null;
  startedAt: number;
  lastReport: number;            // 最后一次 hub_report 的时间
}
```

### 4.3 WorkerBackend

不同类型 executor 的统一接口：

```typescript
interface WorkerBackend {
  name: string;
  spawn(config: WorkerSpawnConfig): Promise<ChildProcess>;
}

interface WorkerSpawnConfig {
  workerId: string;
  taskPrompt: string;
  projectPath: string;
  mcpConfigPath: string;       // 动态生成的 MCP config，指向 ContextHub
  env: Record<string, string>;
  timeout: number;
}
```

初期只实现 `ClaudeCliBackend`（从现有 `ClaudeToolManager.executeTask` 提取），后续可扩展 `OllamaBackend`、`ShellBackend` 等。

### 4.4 ClusterScheduler

核心调度循环，持续运行：

```typescript
class ClusterScheduler {
  // 主循环
  async run(): Promise<void> {
    while (this.running) {
      // 1. 从 TaskSources 收集待办任务
      const candidates = await this.collectTasks();

      // 2. 过滤掉正在处理的、不满足前置条件的
      const actionable = this.filterActionable(candidates);

      // 3. 按优先级排序
      const sorted = this.prioritize(actionable);

      // 4. 分配给空闲 worker 或创建新 worker
      for (const task of sorted) {
        if (!this.canSpawnMore()) break;
        const template = this.selectTemplate(task);
        await this.workerPool.spawnWorker(template, task.project, task);
      }

      // 5. 检查 worker 健康（超时检测、进程退出检测）
      await this.healthCheck();

      // 6. 等待下一个调度周期
      await sleep(this.config.schedulingInterval);
    }
  }
}
```

### 4.5 TaskSource

worker 从哪里获取任务：

```typescript
interface TaskSource {
  name: string;
  poll(project: ProjectInfo): Promise<TaskCandidate[]>;
}
```

初期实现两种：
- **TodoFileSource**：扫描项目的 `todo.md`，解析出待办项（从 `TodoWorkerHandler` 逻辑提取）
- **QueueSource**：手动提交的任务队列（通过 QQ 命令或 WebUI 提交）

### 4.6 Planner 作为特殊 Worker

planner 也是一个 worker，但行为不同：

- **长驻运行**：不像 coder 做完一个任务就退出，planner 持续在线监控
- **额外 MCP tool**：`hub_dispatch`（向调度器请求启动新的 coder worker）、`hub_directive`（给特定 worker 发指令）
- **触发时机**：
  - 新 Job 创建时，planner 负责拆解为具体 task
  - coder 发出 `hub_ask` 时，planner 收到并回复
  - coder 完成任务后，planner 审查结果，决定是否需要后续工作

planner 的额外 MCP tools：

```
hub_dispatch:
  描述: 请求调度器启动一个新的 coder worker 来执行任务
  输入:
    project: string
    taskDescription: string
    files: string[]           // 预计涉及的文件
    workerTemplate?: string   // 可选指定 worker 模板
    priority?: number

hub_directive:
  描述: 向特定 worker 发送指令（worker 必须遵守）
  输入:
    to: string                // 目标 worker ID
    content: string           // 指令内容
```

---

## 5. 配置

### 5.1 配置文件

新增 `agent-cluster.yaml`（或合并到现有 `config.yaml` 的新 section）：

```yaml
cluster:
  enabled: true
  schedulingInterval: 30s
  maxConcurrentWorkers: 6

  # ContextHub 配置
  hub:
    port: 3200
    host: 127.0.0.1
    lockTTL: 600s              # 文件锁过期时间
    eventLogMaxSize: 1000      # 内存中保留的最大事件数

  # Worker 模板
  workerTemplates:
    claude-sonnet:
      type: claude-cli
      command: claude
      args:
        - '--print'
        - '--dangerously-skip-permissions'
        - '--output-format'
        - 'text'
        - '--model'
        - 'sonnet'
      maxConcurrent: 4
      timeout: 600s
      capabilities: [code, test, docs, refactor]
      costTier: medium

    claude-opus:
      type: claude-cli
      command: claude
      args:
        - '--print'
        - '--dangerously-skip-permissions'
        - '--output-format'
        - 'text'
        - '--model'
        - 'opus'
      maxConcurrent: 1
      timeout: 900s
      capabilities: [architecture, complex-refactor, review, planning]
      costTier: high

  # 项目的集群配置（叠加在 ProjectRegistry 之上）
  projects:
    qqbot:
      maxWorkers: 3
      taskSources:
        - type: todo-file
          path: todo.md
          pollInterval: 5m
        - type: queue
      workerPreference: claude-sonnet
      plannerTemplate: claude-opus  # 可选：为该项目指定 planner

  # 通知策略
  notifications:
    qq:
      events: [job-failed, escalation, daily-digest]
      digestTime: "22:00"
      target:
        type: user
        id: "${BOT_OWNER_QQ}"    # 你的 QQ 号
    webui:
      events: [all]

  # 静默时段（可选）
  quietHours:
    enabled: false
    start: "09:00"
    end: "18:00"
    timezone: Asia/Tokyo
```

---

## 6. 数据持久化

### 6.1 新增 SQLite 表

#### `cluster_jobs`

```sql
CREATE TABLE cluster_jobs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed | cancelled
  createdAt TEXT NOT NULL,
  startedAt TEXT,
  completedAt TEXT,
  taskCount INTEGER DEFAULT 0,
  tasksCompleted INTEGER DEFAULT 0,
  tasksFailed INTEGER DEFAULT 0,
  metadata TEXT                            -- JSON: 额外信息
);
```

#### `cluster_tasks`

```sql
CREATE TABLE cluster_tasks (
  id TEXT PRIMARY KEY,
  jobId TEXT NOT NULL,
  project TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | running | completed | failed | blocked
  workerId TEXT,
  workerTemplate TEXT,
  source TEXT,                             -- 'todo-file' | 'queue' | 'planner'
  createdAt TEXT NOT NULL,
  claimedAt TEXT,
  startedAt TEXT,
  completedAt TEXT,
  output TEXT,                             -- worker 的最终输出
  error TEXT,
  filesModified TEXT,                      -- JSON array
  diffSummary TEXT,                        -- JSON: { additions, deletions }
  metadata TEXT                            -- JSON
);
```

#### `cluster_events`

```sql
CREATE TABLE cluster_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  sourceWorkerId TEXT,
  targetWorkerId TEXT,
  data TEXT NOT NULL,                      -- JSON
  jobId TEXT,
  taskId TEXT
);

CREATE INDEX idx_cluster_events_worker ON cluster_events(sourceWorkerId, seq);
CREATE INDEX idx_cluster_events_type ON cluster_events(type, seq);
```

#### `cluster_locks`

```sql
CREATE TABLE cluster_locks (
  filePath TEXT PRIMARY KEY,
  workerId TEXT NOT NULL,
  taskId TEXT,
  claimedAt INTEGER NOT NULL,
  lastRenewed INTEGER NOT NULL,
  ttl INTEGER NOT NULL                     -- 毫秒
);
```

#### `cluster_help_requests`

```sql
CREATE TABLE cluster_help_requests (
  id TEXT PRIMARY KEY,
  workerId TEXT NOT NULL,
  taskId TEXT,
  type TEXT NOT NULL,                      -- clarification | decision | conflict | escalation
  question TEXT NOT NULL,
  context TEXT,
  options TEXT,                            -- JSON array
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | answered | expired
  answer TEXT,
  answeredBy TEXT,                         -- worker ID 或 'human'
  createdAt TEXT NOT NULL,
  answeredAt TEXT
);
```

---

## 7. WebUI API

挂在现有 API Router 上，所有路由前缀 `/api/cluster/`。

### 7.1 端点列表

```
GET  /api/cluster/status           → 集群总览
GET  /api/cluster/workers          → worker 列表和状态
GET  /api/cluster/jobs             → job 列表（分页、过滤）
GET  /api/cluster/jobs/:id         → 单个 job 详情
GET  /api/cluster/tasks            → task 列表（分页、过滤）
GET  /api/cluster/tasks/:id        → 单个 task 详情 + 完整日志
GET  /api/cluster/tasks/:id/events → 该 task 的事件流
GET  /api/cluster/events           → 全局事件流（分页）
GET  /api/cluster/locks            → 当前活跃的文件锁
GET  /api/cluster/help             → 待处理的 help request 列表

POST /api/cluster/jobs             → 创建 job（手动提交）
POST /api/cluster/pause            → 暂停调度
POST /api/cluster/resume           → 恢复调度
POST /api/cluster/workers/:id/kill → 终止指定 worker

POST /api/cluster/help/:id/answer  → 回复 help request（人工介入）

GET  /api/cluster/stream           → SSE 实时事件流（WebUI 实时面板）
```

### 7.2 SSE 事件流

`/api/cluster/stream` 返回 Server-Sent Events，WebUI 通过 EventSource 订阅：

```
event: worker_status
data: {"workerId":"worker-a3f2","status":"running","task":"优化 ProviderRouter"}

event: task_completed
data: {"taskId":"task-001","summary":"修改了 3 个文件","duration":180}

event: help_request
data: {"askId":"ask-001","type":"decision","question":"是否应该修改 public API？"}

event: lock_change
data: {"file":"src/X.ts","action":"locked","by":"worker-b1c3"}
```

---

## 8. QQ 侧交互

极简，只保留控制命令和关键通知。

### 8.1 命令

```
/cluster                       → 一行状态摘要
/cluster start <project>       → 启动项目的 agent 集群
/cluster stop [project]        → 停止集群（指定项目或全部）
/cluster pause / resume        → 暂停/恢复调度
/cluster task <project> "描述" → 手动提交任务到队列
```

### 8.2 通知（默认静默，仅关键事件）

- **job-failed**：Job 失败，附上失败原因
- **escalation**：worker 请求人工介入
- **daily-digest**（每日 22:00）：

```
📊 Agent Cluster 日报
完成 15 任务 | 失败 2 | 修改 47 文件
qqbot: 10 任务，game-engine: 5 任务
⚠️ 2 个失败任务需审查 → WebUI 查看
```

---

## 9. 实施计划

### Phase 1：基础框架

**目标**：能从配置启动 ContextHub + 手动 dispatch 单个 Claude Code worker + worker 能和 hub 通信

1. 新增 `src/cluster/` 目录结构：
   ```
   src/cluster/
     ├── ContextHub.ts              // MCP server + 事件分发
     ├── EventLog.ts                // 有序事件流
     ├── LockManager.ts             // 文件锁管理
     ├── MessageBox.ts              // per-worker 消息队列
     ├── WorkerRegistry.ts          // worker 注册信息
     ├── ClusterScheduler.ts        // 调度循环
     ├── WorkerPool.ts              // worker 生命周期管理
     ├── backends/
     │   └── ClaudeCliBackend.ts    // Claude Code CLI executor
     ├── sources/
     │   ├── TaskSource.ts          // 接口定义
     │   ├── TodoFileSource.ts      // todo.md 解析
     │   └── QueueSource.ts         // 手动队列
     ├── config.ts                  // 配置 schema + 解析
     └── types.ts                   // 共享类型定义
   ```

2. 实现 ContextHub（HTTP server，暴露 5 个 MCP tool endpoint）
3. 实现 WorkerPool + ClaudeCliBackend（从现有 `ClaudeToolManager.executeTask` 提取核心逻辑）
4. 新增 SQLite migration
5. 新增 `DITokens.CLUSTER_MANAGER`，注册到 DI 容器
6. 配置解析 + 初始化流程

**验证标准**：通过 QQ 命令手动 dispatch 一个 worker，worker 能连接 hub、调用 sync/claim/report，hub 能记录事件，worker 完成后锁自动释放。

### Phase 2：调度循环 + TaskSource

**目标**：集群能自主运行，自动从 todo.md 获取任务并分配 worker

1. 实现 ClusterScheduler 主循环
2. 实现 TodoFileSource（从 `TodoWorkerHandler` 提取 todo 解析逻辑）
3. 实现 QueueSource
4. 集成 AgendaService 触发调度（cron 启动、停止）
5. worker 健康检查（超时检测、进程退出通知 hub 清理锁）

**验证标准**：配置 qqbot 项目的 todo-file source，scheduler 自动扫描 todo.md，创建 task，分配 worker，worker 自主完成任务。

### Phase 3：Planner + 多 worker 协作

**目标**：planner worker 能拆解 Job 为多个 task，多个 coder worker 并行执行，通过 hub 协调

1. 实现 planner 的额外 MCP tool（`hub_dispatch`, `hub_directive`）
2. 实现 Job 拆解流程（planner 输出结构化的 task 列表）
3. 实现 `hub_ask` → planner 自动应答链路
4. 冲突检测和 worker 间文件协调
5. worker 行为规则 prompt 模板

**验证标准**：提交一个复杂 Job（如"重构 X 模块"），planner 拆分为 3 个 task，3 个 coder 并行执行，遇到文件冲突时自动协调。

### Phase 4：WebUI + 通知

**目标**：完整的监控和审计能力

1. API 路由实现（`/api/cluster/*`）
2. SSE 事件流
3. QQ 通知集成（daily digest via AgendaService cron）
4. WebUI 前端页面（如果有独立 WebUI 项目的话）

**验证标准**：WebUI 能实时展示 worker 状态、查看任务历史、响应 help request。

---

## 10. 关键设计决策记录

1. **ContextHub 作为独立 HTTP server 运行在 bot 进程内**，而不是独立进程。理由：共享 SQLite、共享 DI 容器、减少部署复杂度。如果未来 hub 负载过高可以拆出去。

2. **Worker 通过 MCP tool call（HTTP）通信**，而不是 WebSocket。理由：Claude Code 的 tool-use loop 天然是请求-响应模式，不需要推送能力。worker 通过轮询 `hub_sync` 获取更新。

3. **锁的粒度是文件级别，生命周期绑定 task**。理由：比方法级锁简单得多，比项目级锁灵活得多。绝大多数情况下同一个 task 内修改的文件是确定的。

4. **Planner 也是 worker，不是独立系统**。理由：统一管理、统一通信协议、统一监控。只是有额外的 MCP tool 和不同的行为模式。

5. **默认静默，WebUI 为主**。理由：集群持续运行时，频繁 QQ 消息是噪音。关键信息（失败、需要人工介入）才发 QQ。

6. **配置文件驱动 + 动态 dispatch**。理由：常规运行用配置文件定义的 worker 模板和项目绑定；特殊情况可以通过 QQ/WebUI 手动提交任务覆盖。
