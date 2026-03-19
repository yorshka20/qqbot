# 朋友圈分析 Tool 集成文档

## 目标

在现有 qqbot 项目中新增两个 Tool Executor，让 bot 能通过 LLM tool_use 自动检索和分析 `wechat_moments` 集合中的朋友圈数据。

---

## 1. 项目架构速览（已有）

### Tool 注册机制

- 所有 tool 通过 `@Tool()` 装饰器 + `@injectable()` 自动注册
- 继承 `BaseToolExecutor`，实现 `execute(call, context)` 方法
- 返回 `this.success(reply, data)` 或 `this.error(reply, errorMsg)`
- DI 注入通过 `@inject(DITokens.XXX)` 构造函数参数

### 已有的 RAG 基础设施

- `RetrievalService`（DI token: `DITokens.RETRIEVAL_SERVICE`）封装了 Qdrant + Ollama
- `retrievalService.vectorSearch(collection, query, { limit, minScore, filter })` — 语义向量搜索
- `retrievalService.vectorSearchMulti(collection, queries, { limitPerQuery, maxTotal, minScore })` — 多 query 合并搜索
- `retrievalService.isRAGEnabled()` — 检查 RAG 是否启用

### RAG 配置（config.yaml 中的 rag 节）

```yaml
rag:
  enabled: true
  ollama:
    url: "http://localhost:11434"
    model: "你的embedding模型名"    # 需要和 wechat_moments 入库时用的一致
    timeout: 30000
  qdrant:
    url: "http://192.168.50.97:6333"
    apiKey: ""                       # 如果有的话
    timeout: 30000
  defaultVectorSize: 2560            # 根据实际 embedding 维度
  defaultDistance: "Cosine"
  queryInstructionPrefix: "Instruct: Retrieve relevant conversation history\nQuery: "
```

### 现有 Tool 参考模板

参考 `src/services/wechat/executors/WechatArticleRAGToolExecutor.ts`，它做的事情几乎一样（对 `wechat_articles_chunks` 集合做语义搜索），只是目标集合和 payload 结构不同。

---

## 2. wechat_moments 数据结构

集合名：`wechat_moments`，约 7807 条记录，向量维度 2560（从 defaultVectorSize 推断，以实际为准）。

每条 point 的 payload：

```typescript
interface MomentPayload {
  content: string;        // 朋友圈正文
  create_time: string;    // 格式 "2025-06-05 17:21:41"
  type: string;           // "1" = 纯文本/图文, "2" = 纯文本（无媒体）, 其他待确认
  medias_count: number;   // 附带的图片/视频数量
  source: string;         // 原始 JSON 路径，如 "2025/0605/2025-06-05-17-21-41.json"
}
```

---

## 3. 需要新建的文件

### 3.1 Tool 1: `wechat_moments_search` — 朋友圈语义检索

**文件位置**: `src/services/wechat/executors/WechatMomentsSearchToolExecutor.ts`

**功能**: 对 `wechat_moments` 集合做语义搜索，返回按时间排序的匹配结果。这是一个基础检索工具，LLM 可以用它来查找与某个话题相关的朋友圈内容。

**Tool 定义**:

```typescript
@Tool({
  name: "wechat_moments_search",
  description:
    "从用户的微信朋友圈历史中语义搜索相关内容。" +
    "朋友圈数据库包含约7800+条记录，时间跨度覆盖多年，涵盖用户对各种话题的思考和记录。" +
    "适用于：1) 查找用户在某个话题上发过什么；2) 了解用户的兴趣和关注点；3) 追溯用户对某件事的看法变化。" +
    "返回按时间排序的匹配条目，含发布时间、正文内容和相似度评分。" +
    "支持多关键词搜索：传入多个 query 可以从不同角度检索同一话题（如 topic 的不同表述），结果会自动去重合并。",
  executor: "wechat_moments_search",
  parameters: {
    query: {
      type: "string",
      required: true,
      description: '主搜索查询（自然语言，如"AI本地部署的看法"、"对工作和生活的思考"）'
    },
    additionalQueries: {
      type: "string",
      required: false,
      description: '补充查询，用 | 分隔多个角度的搜索词（如"深度学习|机器学习|神经网络"），与主 query 一起做多角度检索'
    },
    limit: {
      type: "number",
      required: false,
      description: "最大返回条数，默认 10"
    },
    minScore: {
      type: "number",
      required: false,
      description: "最低相似度阈值（0-1），默认 0.35"
    }
  },
  examples: [
    "搜索我的朋友圈里关于AI的内容",
    "我以前发过什么关于旅行的朋友圈",
    "查找我朋友圈中讨论音乐的部分",
    "我对创业这件事说过什么"
  ],
  whenToUse:
    "当需要从用户的个人朋友圈历史中查找内容时使用。" +
    "与 wechat_article_rag（搜索公众号文章）不同，本工具搜索的是用户自己发布的朋友圈动态。" +
    "适合回答「我说过什么」「我怎么看XX」「我的朋友圈里有没有关于XX的内容」这类问题。"
})
```

**execute 逻辑**:

1. 校验 RAG 启用 + query 非空
2. 解析参数：`query`、`additionalQueries`（按 `|` split）、`limit`（默认 10）、`minScore`（默认 0.35）
3. 如果有 additionalQueries，用 `retrievalService.vectorSearchMulti("wechat_moments", allQueries, { limitPerQuery: limit, maxTotal: limit, minScore })`；否则用 `retrievalService.vectorSearch("wechat_moments", query, { limit, minScore })`
4. 结果按 `create_time` 升序排序（时间线顺序）
5. 格式化输出，每条格式：

```
[序号] 时间: {create_time}  相似度: {score}
{content 截取前800字，超出加省略号}
```

6. 返回 `this.success(formatted, { query, resultCount, timeRange: { earliest, latest } })`

### 3.2 Tool 2: `wechat_moments_analyze` — 朋友圈话题深度分析

**文件位置**: `src/services/wechat/executors/WechatMomentsAnalyzeToolExecutor.ts`

**功能**: 检索朋友圈中与某话题相关的内容，然后调用本地 Ollama Qwen3 14B 进行深度分析（思想变迁、核心立场提炼等）。

**依赖注入**: 除了 `RetrievalService`，还需要注入 `Config`（DI token: `DITokens.CONFIG`）来读取 Ollama URL 和模型名。

**Tool 定义**:

```typescript
@Tool({
  name: "wechat_moments_analyze",
  description:
    "对用户朋友圈中某个话题进行深度分析。" +
    "先从7800+条朋友圈记录中检索相关内容，然后调用本地 LLM 进行纵向分析：" +
    "识别用户在该话题上的核心立场、思想演变轨迹、关键转折点，并引用原文佐证。" +
    "适用于：1) 分析用户对某个话题的看法如何随时间变化；2) 提炼用户在某方面的核心观点；3) 发现用户自己可能没意识到的思想模式。" +
    "注意：本工具会调用本地 LLM 进行分析，响应时间较长（通常 10-30 秒），请在调用前告知用户正在分析中。",
  executor: "wechat_moments_analyze",
  parameters: {
    topic: {
      type: "string",
      required: true,
      description: '要分析的话题（如"对AI的看法"、"职业发展"、"创业"）'
    },
    searchQueries: {
      type: "string",
      required: false,
      description: '自定义搜索词，用 | 分隔（如"创业|商业化|赚钱"），不填则自动用 topic 作为搜索词'
    },
    analysisAngle: {
      type: "string",
      required: false,
      description: '分析角度提示（如"重点关注立场转变"、"对比早期和近期的态度差异"），会追加到 LLM prompt 中'
    },
    limit: {
      type: "number",
      required: false,
      description: "检索条数，默认 15"
    }
  },
  examples: [
    "分析我朋友圈里对AI行业的看法变化",
    "帮我梳理一下我对工作这件事的思考脉络",
    "我在音乐品味上有什么变化趋势"
  ],
  whenToUse:
    "当用户想要深度了解自己在某个话题上的思想变迁时使用。" +
    "与 wechat_moments_search（纯检索）不同，本工具会额外调用 LLM 进行分析并输出结构化的洞察。" +
    "适合回答「我的看法是怎么变的」「帮我梳理一下」「分析我在XX方面的思路」这类需要综合分析的问题。"
})
```

**execute 逻辑**:

1. 校验 RAG 启用 + topic 非空
2. 构造搜索 queries：如果有 `searchQueries`，按 `|` split 后与 `topic` 合并；否则只用 `[topic]`
3. 调用 `retrievalService.vectorSearchMulti("wechat_moments", queries, { limitPerQuery: 15, maxTotal: limit ?? 15, minScore: 0.3 })`
4. 按 `create_time` 升序排序
5. 如果结果少于 2 条，直接返回 `this.success("在朋友圈中未找到足够的相关内容来进行分析。", ...)`
6. 构造 Ollama 请求，调用本地 Qwen3 做分析：

```typescript
// 从 config 中读取 Ollama 配置
const ragConfig = this.config.getRAGConfig();
const ollamaUrl = ragConfig.ollama.url; // e.g. "http://localhost:11434"
const model = "qwen3:14b"; // 生成模型，注意这里不是 embedding 模型，可以硬编码或加到配置里

// 拼接上下文
const contextText = sortedHits.map((hit, i) => {
  return `[${hit.payload.create_time}]\n${hit.payload.content ?? hit.content}`;
}).join("\n\n---\n\n");

// 构造 prompt
const systemPrompt = `你是一个擅长深度分析的助手。以下是一个人在微信朋友圈发布的内容片段，按时间排列。
请基于这些内容，对用户关于「${topic}」这个话题进行深度分析。

要求：
1. 按时间线梳理此人在该话题上的思考演变
2. 识别核心立场——哪些观点是一以贯之的，哪些发生了转变
3. 如果有转折点，指出是什么时候、可能的原因是什么
4. 引用原文片段来支撑你的分析（不要泛泛而谈）
5. 最后提出 1-2 个你觉得有意思的观察或规律

${analysisAngle ? `额外关注角度：${analysisAngle}` : ""}

朋友圈内容：
${contextText}`;

// 调用 Ollama /api/chat
const response = await fetch(`${ollamaUrl}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `请分析我关于「${topic}」的思想脉络。` }
    ],
    stream: false,
    options: { num_predict: 2048 }
  })
});
const result = await response.json();
const analysis = result.message?.content ?? "分析生成失败";
```

7. 返回格式：

```typescript
return this.success(
  `## 朋友圈话题分析：${topic}\n\n` +
  `> 基于 ${hits.length} 条相关内容（${earliest} ~ ${latest}）\n\n` +
  analysis,
  { topic, hitsCount: hits.length, timeRange: { earliest, latest } }
);
```

---

## 4. 批量打标签方案

这个不作为 Tool 集成，而是一个独立脚本。可以新建 `src/scripts/moments-tag.ts` 或类似位置。

### 思路

1. 用 Qdrant REST API 的 scroll 接口分页遍历 `wechat_moments` 全部 7807 条记录
2. 每批取 20 条，拼成一个 prompt 送入 Qwen3 14B
3. 让模型为每条返回 JSON 格式的标签和摘要
4. 结果写回 Qdrant 的 payload（通过 set_payload API）或存入本地 SQLite/JSON

### Ollama 调用 prompt 模板

```
你是一个内容分类助手。请为以下每条朋友圈内容打上主题标签并写一句话摘要。

输出格式（严格 JSON 数组，不要有其他内容）：
[
  { "index": 0, "tags": ["AI", "技术评论"], "summary": "讨论了大模型部署成本过高的问题" },
  { "index": 1, "tags": ["生活", "旅行"], "summary": "记录了去京都旅行的感受" }
]

可选的标签参考（不限于此）：AI、技术、创业、工作、生活、旅行、音乐、电影、读书、情感、社会观察、经济、哲学、吐槽、美食

---
内容列表：

[0] {content_0}

[1] {content_1}

...
```

### Qdrant 写回

```bash
# 通过 REST API 更新 payload
PUT http://192.168.50.97:6333/collections/wechat_moments/points/payload
{
  "payload": {
    "tags": ["AI", "技术评论"],
    "summary": "讨论了大模型部署成本过高的问题"
  },
  "points": [point_id]
}
```

### 注意事项

- Qwen3 14B 处理 20 条朋友圈大约需要 15-30 秒（取决于内容长度和硬件）
- 7807 条 / 20 = 约 390 批，预计总耗时 1.5-3 小时
- 建议加断点续传：记录已处理的 offset，中断后可从上次位置继续
- 建议先对前 40 条跑一次，检查标签质量，调整 prompt 后再全量跑

---

## 5. 配置扩展建议

在 `config.yaml` 的 `rag` 节或新建一个 `moments` 节，加入分析用的 LLM 配置：

```yaml
# 方案 A：复用 rag 节，加一个 generationModel 字段
rag:
  enabled: true
  ollama:
    url: "http://localhost:11434"
    model: "你的embedding模型"        # embedding 用
    generationModel: "qwen3:14b"     # 生成分析用
  qdrant:
    url: "http://192.168.50.97:6333"

# 方案 B：独立配置节
moments:
  analysis:
    ollamaUrl: "http://localhost:11434"
    model: "qwen3:14b"
    maxTokens: 2048
    defaultSearchLimit: 15
    defaultMinScore: 0.3
```

选哪种取决于你对配置结构的偏好。方案 A 改动最小，方案 B 更清晰但需要在 Config 类里加 `getMomentsConfig()`。

---

## 6. 文件清单

| 文件 | 作用 |
|------|------|
| `src/services/wechat/executors/WechatMomentsSearchToolExecutor.ts` | Tool: 朋友圈语义检索 |
| `src/services/wechat/executors/WechatMomentsAnalyzeToolExecutor.ts` | Tool: 朋友圈话题深度分析 |
| `src/scripts/moments-tag.ts` | 脚本: 批量打标签 |
| `config.yaml`（修改） | 新增 moments 分析相关配置 |

---

## 7. 关键实现细节备忘

- `vectorSearch` 返回的结果结构：`{ id, score, payload, content }`，其中 `content` 等于 `payload.content`
- Qdrant 地址：`http://192.168.50.97:6333`
- 集合名固定：`wechat_moments`
- minScore 建议 moments 用 0.3~0.35（比 conversation_history 的 0.5~0.7 低，因为朋友圈内容更发散）
- `create_time` 格式是 `"YYYY-MM-DD HH:mm:ss"` 字符串，可以直接做字符串排序
- content 可能很长（几百到上千字），送给 LLM 分析时注意 context window，15 条长内容可能有 8000+ tokens
- Ollama `/api/chat` 的 `stream: false` 模式会等完整响应，适合 tool executor 场景；如果要流式返回需要另外处理
- 项目用 Bun 运行，fetch 是原生可用的，不需要额外 import
