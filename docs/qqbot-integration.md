# video-knowledge-backend 对接文档 (QQBot)

> 本文档描述 QQBot 如何与 video-knowledge-backend 的 HTTP API 交互，完成视频分析任务的提交和结果获取。
>
> **当前部署**: 本地部署，无需鉴权。

## 基本信息

| 项目         | 值                       |
| ------------ | ------------------------ |
| Base URL     | `http://localhost:8080`  |
| Content-Type | `application/json`       |
| 协议         | HTTP/1.1                 |
| 超时建议     | 请求 10s，轮询间隔 5-10s |

---

## API 概览

| 方法 | 路径                 | 用途                   |
| ---- | -------------------- | ---------------------- |
| POST | `/api/v1/analyze`    | 提交视频分析任务       |
| POST | `/api/v1/ingest`     | 推送外部数据并触发分析 |
| GET  | `/api/v1/tasks/{id}` | 查询任务状态           |
| GET  | `/api/v1/health`     | 健康检查               |

---

## 1. 提交视频分析任务

用户在 QQ 群发送 B 站视频链接后，bot 提取 BV 号并调用此接口。

### 请求

```
POST /api/v1/analyze
Content-Type: application/json
```

```json
{
  "platform": "bilibili",
  "video_id": "BV1xxxxxxxxxx"
}
```

| 字段     | 类型   | 必填 | 说明                              |
| -------- | ------ | ---- | --------------------------------- |
| platform | string | Yes  | 平台标识，目前只支持 `"bilibili"` |
| video_id | string | Yes  | 视频 ID，B 站用 BV 号             |

### 响应

**202 Accepted** — 任务已入队

```json
{
  "task_id": 12345
}
```

**400 Bad Request** — 参数缺失

```json
{
  "error": "platform and video_id are required"
}
```

### 注意事项

- 同一 (platform, video_id) 如已有活跃任务（queued/claimed），不会重复创建，直接返回已有 task_id
- 手动提交的任务优先级最高 (priority=30)

---

## 2. 推送外部数据 (Ingest)

如果 bot 已经持有视频数据（如字幕、弹幕），可以直接推送数据并触发分析，跳过 backend 自行抓取。

### 请求

```
POST /api/v1/ingest
Content-Type: application/json
```

```json
{
  "platform": "bilibili",
  "video_id": "BV1xxxxxxxxxx",
  "source": "qqbot",
  "video_info": {
    "title": "视频标题",
    "duration": 226,
    "creator": "UP主名称",
    "desc": "视频描述（可选）"
  },
  "subtitles": [
    {
      "from": 0.0,
      "to": 1.68,
      "content": "字幕内容",
      "lang": "zh"
    }
  ],
  "overlays": [
    {
      "progress_ms": 5000,
      "content": "弹幕内容",
      "posted_at": 1711900000
    }
  ]
}
```

| 字段                   | 类型   | 必填 | 说明                                            |
| ---------------------- | ------ | ---- | ----------------------------------------------- |
| platform               | string | Yes  | 平台标识                                        |
| video_id               | string | Yes  | 视频 ID                                         |
| source                 | string | No   | 数据来源标识，默认 `"ingest"`，建议填 `"qqbot"` |
| video_info             | object | No   | 视频元信息                                      |
| video_info.title       | string | -    | 视频标题                                        |
| video_info.duration    | int    | -    | 视频时长（秒）                                  |
| video_info.creator     | string | -    | UP 主名称                                       |
| video_info.desc        | string | -    | 视频描述                                        |
| subtitles              | array  | No   | 字幕列表                                        |
| subtitles[].from       | float  | -    | 字幕开始时间（秒）                              |
| subtitles[].to         | float  | -    | 字幕结束时间（秒）                              |
| subtitles[].content    | string | -    | 字幕文本                                        |
| subtitles[].lang       | string | -    | 语言代码，如 `"zh"`                             |
| overlays               | array  | No   | 弹幕列表                                        |
| overlays[].progress_ms | int    | -    | 弹幕出现时间（毫秒）                            |
| overlays[].content     | string | -    | 弹幕文本                                        |
| overlays[].posted_at   | int64  | -    | 发送时间 Unix 时间戳（秒）                      |

### 响应

**200 OK**

```json
{
  "video_id": "BV1xxxxxxxxxx",
  "accepted": ["video_info", "subtitles", "overlays"],
  "task_id": 12345
}
```

| 字段     | 类型     | 说明                   |
| -------- | -------- | ---------------------- |
| video_id | string   | 视频 ID                |
| accepted | string[] | 成功缓存的数据类型列表 |
| task_id  | int64    | 入队的分析任务 ID      |

---

## 3. 查询任务状态

提交任务后，通过 task_id 轮询任务状态。

### 请求

```
GET /api/v1/tasks/{id}
```

### 响应

**200 OK**

```json
{
  "id": 12345,
  "type": "analyze",
  "status": "done",
  "priority": 30,
  "retry_count": 0,
  "created_at": "2026-04-01T10:30:00Z",
  "claimed_at": "2026-04-01T10:31:00Z",
  "done_at": "2026-04-01T10:35:00Z"
}
```

失败时会额外包含 `error_msg`：

```json
{
  "id": 12345,
  "type": "analyze",
  "status": "failed",
  "priority": 30,
  "retry_count": 3,
  "error_msg": "fetch video info: bilibili api returned 412",
  "created_at": "2026-04-01T10:30:00Z",
  "claimed_at": "2026-04-01T10:31:00Z",
  "done_at": "2026-04-01T10:35:00Z"
}
```

**404 Not Found** — 任务不存在

```json
{
  "error": "task not found"
}
```

### 任务状态枚举

| status    | 说明       | 是否终态 |
| --------- | ---------- | -------- |
| `queued`  | 等待处理   | No       |
| `claimed` | 正在处理中 | No       |
| `done`    | 分析完成   | Yes      |
| `failed`  | 分析失败   | Yes      |

---

## 4. 健康检查

```
GET /api/v1/health
```

**200 OK**

```json
{
  "status": "ok"
}
```

**503 Service Unavailable** — 数据库不可用

```json
{
  "error": "database unhealthy"
}
```

---

## 推荐对接流程

### 场景：用户发送 B 站链接，bot 自动分析并回复

```
用户 → QQBot: "帮我分析这个视频 https://www.bilibili.com/video/BV1xxxxxxxxxx"

QQBot:
  1. 正则提取 BV 号: BV1xxxxxxxxxx
  2. POST /api/v1/analyze  →  得到 task_id
  3. 回复用户: "已提交分析任务 #12345，请稍候..."
  4. 每 5-10 秒轮询 GET /api/v1/tasks/12345
  5. status == "done" → 读取结果，格式化回复
  6. status == "failed" → 回复用户: "分析失败: {error_msg}"
```

### BV 号提取正则参考

```typescript
// 从 URL 或纯文本中提取 BV 号
const BV_REGEX = /BV[a-zA-Z0-9]{10}/;

function extractBVID(text: string): string | null {
  const match = text.match(BV_REGEX);
  return match ? match[0] : null;
}
```

### 轮询任务状态参考实现

```typescript
async function pollTaskResult(
  taskId: number,
  baseUrl = "http://localhost:8080",
  intervalMs = 5000,
  timeoutMs = 300000, // 5 minutes
): Promise<TaskResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const res = await fetch(`${baseUrl}/api/v1/tasks/${taskId}`);
    const task = await res.json();

    if (task.status === "done") {
      return { success: true, task };
    }
    if (task.status === "failed") {
      return { success: false, error: task.error_msg, task };
    }

    // queued or claimed — keep polling
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return { success: false, error: "polling timeout" };
}

interface TaskResult {
  success: boolean;
  error?: string;
  task?: any;
}
```

---

## 分析结果获取

> **注意**: 当前 backend 没有结果查询 API，分析完成后结果写入本地文件系统。
> 因为是本地部署，bot 可以直接读取文件。

### 结果文件位置

```
data/kb/{creator_name}/{date}-{sanitized_title}.json   # 结构化数据
data/kb/{creator_name}/{date}-{sanitized_title}.md      # 可读 Markdown
```

示例：

```
data/kb/SomeCreator/20260401-这是一个示例视频标题__.json
```

### JSON 结果结构

```json
{
  "video_info": {
    "platform": "bilibili",
    "video_id": "BV1xxxxxxxxxx",
    "title": "视频标题",
    "duration": 300,
    "creator": {
      "platform": "bilibili",
      "id": "12345678",
      "name": "CreatorName"
    },
    "stats": {
      "view_count": 10000,
      "like_count": 500,
      "comment_count": 200,
      "danmaku_count": 80
    }
  },
  "summary": "LLM 生成的视频内容摘要...",
  "highlights": [
    {
      "start_sec": 30.0,
      "end_sec": 60.0,
      "title": "高光片段标题",
      "description": "片段描述",
      "reason": "被标记为高光的原因"
    }
  ],
  "peaks": [
    {
      "start_sec": 45.0,
      "end_sec": 55.0,
      "count": 23,
      "density": 4.6,
      "peak_rank": 1,
      "subtitle_text": "该时段字幕",
      "top_overlays": ["弹幕1", "弹幕2"]
    }
  ],
  "timeline": [...],
  "data_sources": ["video_info", "subtitles", "danmaku"],
  "processed_at": "2026-04-01T10:35:00Z"
}
```

### QQBot 回复格式化建议

从结果 JSON 中提取关键信息，格式化为群消息：

```typescript
function formatAnalysisReply(result: any): string {
  const info = result.video_info;
  const lines: string[] = [];

  lines.push(`📺 ${info.title}`);
  lines.push(`👤 ${info.creator.name} | ⏱ ${formatDuration(info.duration)}`);
  lines.push(`👀 ${info.stats.view_count} | 👍 ${info.stats.like_count}`);
  lines.push("");

  // Summary
  if (result.summary) {
    lines.push("📝 内容摘要:");
    lines.push(result.summary);
    lines.push("");
  }

  // Highlights
  if (result.highlights?.length) {
    lines.push("🔥 高光时刻:");
    for (const h of result.highlights) {
      lines.push(
        `  [${formatTime(h.start_sec)}] ${h.title} — ${h.description}`,
      );
    }
    lines.push("");
  }

  // Peaks (danmaku hot spots)
  if (result.peaks?.length) {
    lines.push("💬 弹幕高能时刻:");
    for (const p of result.peaks.slice(0, 3)) {
      lines.push(
        `  [${formatTime(p.start_sec)}] ${p.count}条弹幕 — ${p.top_overlays?.slice(0, 3).join("、") || ""}`,
      );
    }
  }

  return lines.join("\n");
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
```

---

## 错误处理建议

| 场景                     | 处理方式                                                   |
| ------------------------ | ---------------------------------------------------------- |
| backend 不可达           | 先 GET /health 检查，不可达时提示用户 "分析服务暂时不可用" |
| 任务入队失败 (500)       | 提示 "提交失败，请稍后重试"                                |
| 轮询超时 (5min 未完成)   | 提示 "分析时间较长，请稍后用命令查询结果"                  |
| 任务失败 (status=failed) | 显示 error_msg 帮助定位问题                                |
| 结果文件不存在           | 任务 done 但文件未找到 — 可能路径逻辑有误，记录日志        |

---

## 后续扩展（待实现）

- [ ] **结果查询 API**: `GET /api/v1/results/{platform}/{video_id}` — 让 bot 不依赖文件系统读取结果
- [ ] **Webhook 回调**: 任务完成后主动推送结果到 bot，替代轮询
- [ ] **鉴权**: 生产部署时增加 API Key 或 Token 鉴权
