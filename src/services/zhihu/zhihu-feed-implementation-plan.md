# 知乎 Feed 订阅服务 — 实现方案

## 概述

直接调用知乎私有 API 拉取关注动态，存储到 SQLite，通过 Agenda cron 定时推送摘要到 QQ 群。

---

## 1. 核心 API

### 关注动态（核心）

```
GET https://www.zhihu.com/api/v3/moments
Query: desktop=true&limit=20
Headers:
  Cookie: <完整 cookie，必须包含 z_c0>
  User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...
  Referer: https://www.zhihu.com/
```

返回结构：
```typescript
interface ZhihuMomentsResponse {
  data: ZhihuFeedItem[];
  paging: {
    is_end: boolean;
    next: string;      // 带 cursor 的下一页 URL
    previous: string;
  };
}

interface ZhihuFeedItem {
  // 单条动态
  type: 'feed';
  verb: 'ANSWER_CREATE' | 'ARTICLE_CREATE' | 'ANSWER_VOTE_UP' | 'MEMBER_FOLLOW_QUESTION' | ...;
  target: {
    type: 'answer' | 'article' | 'question' | 'zvideo' | ...;
    id: number;
    title?: string;                 // article/zvideo 直接有
    question?: { id: number; title: string };  // answer 在此
    content?: string;               // HTML 全文
    excerpt?: string;               // 纯文本摘要
    voteup_count?: number;
    comment_count?: number;
    created_time: number;
    updated_time: number;
    author?: {
      id: string;
      name: string;
      url_token: string;
      headline?: string;
      avatar_url?: string;
    };
  };
  actors: Array<{ id: string; name: string; avatar_url: string; url_token: string }>;
  created_time: number;
  id: string;

  // 聚合动态（多条合并显示）
  group_text?: string;  // e.g. "你关注的 {LIST_COUNT} 人赞同了该回答"
  list?: ZhihuFeedItem[];
}
```

### 辅助 API

| 用途 | 端点 |
|------|------|
| 当前用户信息 | `GET https://www.zhihu.com/api/v4/me` |
| 关注列表 | `GET https://www.zhihu.com/api/v4/members/{url_token}/followees?limit=20&offset=0` |
| 单条回答全文 | `GET https://www.zhihu.com/api/v4/answers/{id}?include=content` |
| 单条文章全文 | `GET https://www.zhihu.com/api/v4/articles/{id}` |
| 热榜（无需cookie） | `GET https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50` |

---

## 2. 文件结构

```
src/
├── services/
│   └── zhihu/
│       ├── ZhihuClient.ts            # HTTP 客户端，cookie 管理，请求封装
│       ├── ZhihuFeedService.ts        # Feed 拉取、去重、存储的主服务
│       ├── ZhihuDigestService.ts      # 摘要生成 + 推送到 QQ 群
│       ├── ZhihuContentParser.ts      # 解析不同 verb/target 类型，提取统一结构
│       └── types.ts                   # TypeScript 类型定义
├── config 相关
│   └── zhihu 配置段（见下方）
```

---

## 3. 组件设计

### 3.1 ZhihuClient

职责：封装所有知乎 HTTP 请求，管理 cookie 和反爬。

```typescript
class ZhihuClient {
  private cookie: string;
  private userAgent: string;
  private requestInterval: number;   // 请求间隔 ms，默认 2000
  private lastRequestTime: number;

  constructor(config: ZhihuClientConfig) {}

  // 核心方法
  async fetchMoments(limit?: number, cursor?: string): Promise<ZhihuMomentsResponse>;
  async fetchAllMomentsSince(sinceTimestamp: number, maxPages?: number): Promise<ZhihuFeedItem[]>;
  async fetchAnswerContent(answerId: number): Promise<ZhihuAnswer>;
  async fetchArticleContent(articleId: number): Promise<ZhihuArticle>;
  async fetchMe(): Promise<ZhihuUser>;

  // Cookie 健康检查
  async checkCookieValidity(): Promise<boolean>;

  // 内部：限速 + 重试
  private async request<T>(url: string, options?: RequestInit): Promise<T>;
  private async throttle(): Promise<void>;

  // Cookie 热更新（通过 bot 管理指令）
  updateCookie(newCookie: string): void;
}
```

**关键实现细节：**
- 使用 Bun 原生 `fetch`，不需要额外依赖
- `throttle()` 确保两次请求间隔 ≥ 2s（可配置）
- `fetchAllMomentsSince()` 通过 paging.next 自动翻页，直到 `created_time < sinceTimestamp` 或 `is_end=true`，设 `maxPages` 上限防止无限翻页
- 请求失败 3 次后标记 cookie 可能失效，触发告警
- `checkCookieValidity()` 调用 `/api/v4/me`，200 = 有效

### 3.2 ZhihuContentParser

职责：将异构的 feed item 解析为统一的 `ZhihuContentItem` 结构。

```typescript
interface ZhihuContentItem {
  id: string;                    // 唯一 ID: `${verb}:${target.type}:${target.id}`
  feedId: string;                // 原始 feed item id
  verb: string;                  // ANSWER_CREATE, ARTICLE_CREATE, ANSWER_VOTE_UP, ...
  targetType: string;            // answer, article, question, zvideo
  targetId: number;
  title: string;                 // 统一提取的标题
  excerpt: string;               // 纯文本摘要，截取前 500 字
  content?: string;              // HTML 全文（可选，按需拉取）
  url: string;                   // 知乎原文链接
  authorName: string;
  authorUrlToken: string;
  authorAvatarUrl?: string;
  voteupCount: number;
  commentCount: number;
  actorNames: string[];          // 触发这条动态的人（谁赞了、谁关注了）
  createdTime: number;           // Unix timestamp (秒)
  fetchedAt: string;             // ISO datetime
}
```

```typescript
class ZhihuContentParser {
  // 处理单条 feed item（可能是单条或聚合）
  parse(feedItem: ZhihuFeedItem): ZhihuContentItem[];

  // 内部方法
  private parseSingleFeed(item: ZhihuFeedItem): ZhihuContentItem;
  private parseGroupFeed(item: ZhihuFeedItem): ZhihuContentItem[];
  private extractTitle(target: any): string;
  private extractUrl(target: any): string;
  private stripHtml(html: string): string;       // 提取纯文本摘要
}
```

**verb 类型处理策略：**

| verb | 含义 | 处理 |
|------|------|------|
| `ANSWER_CREATE` | 关注的人创建了回答 | ★ 核心内容，保留全文 |
| `ARTICLE_CREATE` | 关注的人发布了文章 | ★ 核心内容，保留全文 |
| `ANSWER_VOTE_UP` | 关注的人赞了回答 | 保留，标记为 social |
| `MEMBER_FOLLOW_QUESTION` | 关注的人关注了问题 | 保留，仅标题 |
| `QUESTION_FOLLOW` | 同上变体 | 保留，仅标题 |
| `MEMBER_VOTEUP_ARTICLE` | 关注的人赞了文章 | 保留，标记为 social |
| `ZVIDEO_CREATE` | 关注的人发布了视频 | 保留标题+链接 |
| 其他 | 各类次要动态 | 记录但不推送 |

### 3.3 ZhihuFeedService

职责：定时拉取 feed → 去重 → 存 SQLite。是 Agenda cron 触发的核心 Service。

```typescript
class ZhihuFeedService {
  private client: ZhihuClient;
  private parser: ZhihuContentParser;
  private databaseManager: DatabaseManager;
  private eventBus: InternalEventBus;

  constructor(
    client: ZhihuClient,
    parser: ZhihuContentParser,
    databaseManager: DatabaseManager,
    eventBus: InternalEventBus,
  ) {}

  // Agenda cron 调用入口（每 30 分钟）
  async pollFeed(): Promise<{ newCount: number; duplicateCount: number }>;

  // 内部
  private async getLastFetchTimestamp(): Promise<number>;
  private async saveItems(items: ZhihuContentItem[]): Promise<number>;
  private async isDuplicate(itemId: string): Promise<boolean>;

  // Cookie 健康检查（每次 poll 前执行）
  private async ensureCookieValid(): Promise<boolean>;

  // Cookie 失效时通过 eventBus 发告警
  private emitCookieAlert(): void;

  // 管理接口
  async getRecentItems(limit?: number): Promise<ZhihuContentItem[]>;
  async getItemsByVerb(verb: string, limit?: number): Promise<ZhihuContentItem[]>;
  async getStats(): Promise<{ totalItems: number; lastFetchAt: string; cookieValid: boolean }>;
}
```

### 3.4 ZhihuDigestService

职责：汇总最近 N 小时的 feed items，用 LLM 生成摘要，推送到 QQ 群。

```typescript
class ZhihuDigestService {
  private feedService: ZhihuFeedService;
  private llmService: LLMService;
  private messageAPI: MessageAPI;
  private promptManager: PromptManager;

  constructor(...) {}

  // Agenda cron 调用入口（每天 1-2 次）
  async generateAndPushDigest(groupId: string, hoursBack?: number): Promise<void>;

  // 内部
  private async collectDigestItems(hoursBack: number): Promise<ZhihuContentItem[]>;
  private async generateDigestText(items: ZhihuContentItem[]): Promise<string>;
  private async sendToGroup(groupId: string, digest: string): Promise<void>;

  // 按需拉取全文（对 ANSWER_CREATE/ARTICLE_CREATE 类型的高赞内容）
  private async enrichTopItems(items: ZhihuContentItem[], topN?: number): Promise<void>;
}
```

**摘要生成策略（低 token 消耗）：**
- 只对摘要文本调 LLM，不传全文
- 使用 `generateLite`（DeepSeek 或 Gemini Flash）
- Prompt 模板：输入结构化的 items 列表（标题+摘要+互动数），输出分类整理的中文摘要
- 预计单次 digest：输入 ~2000 tokens，输出 ~500 tokens

---

## 4. 数据库 Schema

在 SQLiteAdapter 的 `migrate()` 中新增：

```sql
CREATE TABLE IF NOT EXISTS zhihu_feed_items (
  id TEXT PRIMARY KEY,                    -- ZhihuContentItem.id
  feedId TEXT NOT NULL,                   -- 原始 feed item id
  verb TEXT NOT NULL,                     -- ANSWER_CREATE, ARTICLE_CREATE, ...
  targetType TEXT NOT NULL,               -- answer, article, question, ...
  targetId INTEGER NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT,                           -- 纯文本摘要
  content TEXT,                           -- HTML 全文（可选）
  url TEXT NOT NULL,
  authorName TEXT,
  authorUrlToken TEXT,
  authorAvatarUrl TEXT,
  voteupCount INTEGER DEFAULT 0,
  commentCount INTEGER DEFAULT 0,
  actorNames TEXT,                        -- JSON array
  createdTime INTEGER NOT NULL,           -- Unix timestamp
  fetchedAt TEXT NOT NULL,                -- ISO datetime
  digestedAt TEXT,                        -- 已推送摘要的时间，NULL = 未推送
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_zhihu_feed_createdTime ON zhihu_feed_items(createdTime);
CREATE INDEX IF NOT EXISTS idx_zhihu_feed_verb ON zhihu_feed_items(verb);
CREATE INDEX IF NOT EXISTS idx_zhihu_feed_digestedAt ON zhihu_feed_items(digestedAt);
CREATE INDEX IF NOT EXISTS idx_zhihu_feed_targetId ON zhihu_feed_items(targetType, targetId);

-- Cookie 状态跟踪
CREATE TABLE IF NOT EXISTS zhihu_cookie_status (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  cookie TEXT NOT NULL,                   -- 当前 cookie（加密存储或明文，视安全需求）
  isValid INTEGER NOT NULL DEFAULT 1,
  lastCheckedAt TEXT NOT NULL,
  lastFailedAt TEXT,
  failCount INTEGER NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL
);
```

---

## 5. 配置

在主配置文件中新增 `zhihu` 段：

```yaml
zhihu:
  enabled: true
  cookie: "z_c0=...;d_c0=...;_xsrf=..."    # 或从环境变量 ZHIHU_COOKIE 读取
  pollIntervalCron: "*/30 * * * *"           # 每 30 分钟拉一次 feed
  digestCron: "0 9,21 * * *"                 # 每天 9:00 和 21:00 推送摘要
  digestGroupIds: ["123456789"]              # 推送目标 QQ 群
  requestIntervalMs: 2000                    # 请求间隔
  maxPagesPerPoll: 5                         # 单次 poll 最多翻页数
  digestHoursBack: 12                        # 摘要覆盖的小时数
  digestProvider: "deepseek"                 # 摘要用的 LLM provider
  topItemsToEnrich: 3                        # 拉全文的 top 内容数
  verbFilter:                                # 要保留的 verb 类型
    - ANSWER_CREATE
    - ARTICLE_CREATE
    - ANSWER_VOTE_UP
    - MEMBER_VOTEUP_ARTICLE
    - ZVIDEO_CREATE
```

---

## 6. 注册与接线

### 6.1 DI 注册

```typescript
// DITokens 新增
ZHIHU_CLIENT: "ZhihuClient",
ZHIHU_FEED_SERVICE: "ZhihuFeedService",
ZHIHU_DIGEST_SERVICE: "ZhihuDigestService",

// 初始化
const zhihuConfig = globalConfig.zhihu;
if (zhihuConfig?.enabled) {
  const zhihuClient = new ZhihuClient({
    cookie: zhihuConfig.cookie || process.env.ZHIHU_COOKIE,
    requestIntervalMs: zhihuConfig.requestIntervalMs ?? 2000,
  });

  const zhihuParser = new ZhihuContentParser({
    verbFilter: zhihuConfig.verbFilter,
  });

  const zhihuFeedService = new ZhihuFeedService(
    zhihuClient, zhihuParser, databaseManager, internalEventBus,
  );

  const zhihuDigestService = new ZhihuDigestService(
    zhihuFeedService, llmService, messageAPI, promptManager,
    { provider: zhihuConfig.digestProvider, topItemsToEnrich: zhihuConfig.topItemsToEnrich },
  );

  container.register(DITokens.ZHIHU_CLIENT, { useValue: zhihuClient });
  container.register(DITokens.ZHIHU_FEED_SERVICE, { useValue: zhihuFeedService });
  container.register(DITokens.ZHIHU_DIGEST_SERVICE, { useValue: zhihuDigestService });
}
```

### 6.2 Agenda 注册

在 `schedule.md` 或启动时程序化注册：

```typescript
// 定时 poll feed
agendaService.createItem({
  name: "zhihu-feed-poll",
  triggerType: "cron",
  cronExpr: zhihuConfig.pollIntervalCron,  // "*/30 * * * *"
  intent: "poll_zhihu_feed",
  enabled: true,
  maxSteps: 1,
});

// 定时生成+推送 digest
agendaService.createItem({
  name: "zhihu-digest-push",
  triggerType: "cron",
  cronExpr: zhihuConfig.digestCron,  // "0 9,21 * * *"
  intent: "generate_zhihu_digest",
  groupId: zhihuConfig.digestGroupIds[0],
  enabled: true,
  maxSteps: 3,
});
```

### 6.3 Bot 管理指令（通过 Skill 或直接消息处理）

```
/zhihu status           → 显示 cookie 状态、最近拉取时间、总条目数
/zhihu cookie <new>     → 热更新 cookie
/zhihu digest           → 手动触发一次摘要推送
/zhihu recent [n]       → 显示最近 n 条 feed 项
/zhihu poll             → 手动触发一次 feed 拉取
```

这些可以作为 Skill 注册到 SkillRegistry，或在消息处理链中做前缀匹配。

---

## 7. Prompt 模板

文件：`prompts/zhihu.digest.system.md`

```markdown
你是一个知乎动态摘要助手。根据提供的知乎关注动态列表，生成一份简洁的中文摘要。

要求：
1. 按内容类型分组：新回答/文章 > 高赞内容 > 其他动态
2. 每条内容一行：标题 + 作者 + 互动数据 + 一句话概括
3. 高赞（>100赞）的内容优先排列并标注 🔥
4. 总结不超过 800 字
5. 不要虚构任何内容，仅基于提供的数据
```

文件：`prompts/zhihu.digest.user.md`

```markdown
以下是过去 {{hoursBack}} 小时的知乎关注动态（共 {{itemCount}} 条）：

{{#items}}
- [{{verb}}] {{title}} — {{authorName}}
  赞同: {{voteupCount}} | 评论: {{commentCount}}
  摘要: {{excerpt}}
{{/items}}

请生成摘要。
```

---

## 8. Cookie 失效应对

```
┌─────────────┐
│ pollFeed()  │
└──────┬──────┘
       │
       ▼
  checkCookieValid?
       │
  ┌────┴────┐
  │ Valid   │ Invalid (401/403 或 /me 失败)
  │         │
  ▼         ▼
 正常拉取  failCount++
            │
       failCount >= 3?
       ┌────┴────┐
       │ No      │ Yes
       │         │
       ▼         ▼
    下次重试   emitCookieAlert()
              → eventBus.emit('zhihu:cookie_invalid')
              → 群内发消息提醒 owner
              → 暂停 poll 直到 cookie 更新
```

更新 cookie 后自动恢复：
```typescript
// ZhihuClient
updateCookie(newCookie: string) {
  this.cookie = newCookie;
  // 同步更新到数据库
  this.saveCookieToDb(newCookie);
  // 重置失败计数
  this.resetFailCount();
  // 立即验证
  this.checkCookieValidity().then(valid => {
    if (valid) this.eventBus.emit('zhihu:cookie_restored');
  });
}
```

---

## 9. 实现优先级

Claude Code 通宵任务队列建议顺序：

### P0 — 当晚必须完成
1. **types.ts** — 所有 TypeScript 类型定义
2. **ZhihuClient.ts** — HTTP 客户端（fetch + throttle + retry + cookie check）
3. **ZhihuContentParser.ts** — Feed item 解析器
4. **ZhihuFeedService.ts** — Feed 拉取 + 去重 + SQLite 存储
5. **SQLiteAdapter migration** — 新增 `zhihu_feed_items` + `zhihu_cookie_status` 表
6. **配置段** — config schema 新增 zhihu 段
7. **DI 注册** — 在启动链中注册所有新 service
8. **Agenda 注册** — pollFeed cron 任务

### P1 — 次优先
9. **ZhihuDigestService.ts** — 摘要生成 + 推送
10. **Prompt 模板** — digest system/user prompts
11. **Agenda 注册** — digest cron 任务
12. **Bot 管理指令** — /zhihu status/cookie/digest/recent/poll

### P2 — 后续迭代
13. Cookie 失效自动告警到群
14. 可选：按 verb 类型配置不同推送频率
15. 可选：高赞内容自动拉全文存 Qdrant，供 RAG 检索
16. 可选：知乎热榜定时拉取（不需要 cookie）

---

## 10. 注意事项

1. **Cookie 获取方式**：浏览器登录知乎 → F12 → Network → 找任意请求的 Cookie header → 复制完整值（必须包含 `z_c0`）
2. **请求频率**：建议 ≥ 2 秒间隔，单次 poll 不超过 5 页（100 条）
3. **东京 IP 优势**：从你的服务器直接请求知乎，不经过代理，东京 IP 比大陆机房 IP 风控更宽松
4. **数据量预估**：关注 200 人，每天约 50-200 条动态，SQLite 完全扛得住
5. **Token 消耗**：仅 digest 生成用 LLM，每次约 2500 tokens（DeepSeek 约 $0.001），可忽略
6. **HTML 全文**：知乎 API 返回的 content 是 HTML，包含 LaTeX 公式（`<img ... eeimg="1">`）和图片，存储时保留原始 HTML，展示时按需转纯文本
