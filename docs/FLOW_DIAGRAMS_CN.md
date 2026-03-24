# QQBot 架构流程图

## 目录

1. [总览](#1-总览)
2. [Protocol 协议层](#2-protocol-协议层)
3. [Command 命令系统](#3-command-命令系统)
4. [Reply 回复系统（AI Pipeline）](#4-reply-回复系统ai-pipeline)
5. [AIService 核心循环（多轮工具调用）](#5-aiservice-核心循环多轮工具调用)
6. [Proactive Reply 主动回复](#6-proactive-reply-主动回复)
7. [Agenda 定时任务](#7-agenda-定时任务)

---

## 1. 总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          QQ (Milky/OB11/Satori)                        │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ WebSocket
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  ConnectionManager                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ MilkyAdapter  │  │ OB11Adapter  │  │ SatoriAdapter │                 │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                  │
│         └─────────────────┼─────────────────┘                          │
│                           ▼                                             │
│                   NormalizedEvent                                        │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │   EventDeduplicator     │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │      EventRouter        │
              │  message/notice/request │
              └────────────┬────────────┘
                           │ message
                           ▼
              ┌─────────────────────────┐
              │   ConversationManager   │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │    MessagePipeline      │
              │                         │
              │  ┌───────────────────┐  │
              │  │    Lifecycle      │  │
              │  │                   │  │
              │  │ 1. RECEIVE       │  │
              │  │ 2. PREPROCESS    │  │
              │  │ 3. PROCESS ──────┼──┼──► CommandSystem / ReplySystem
              │  │ 4. PREPARE       │  │
              │  │ 5. SEND ─────────┼──┼──► MessageAPI → Protocol → QQ
              │  │ 6. COMPLETE      │  │
              │  └───────────────────┘  │
              └─────────────────────────┘

              ┌──────────────────────────────────────────────────┐
              │   Proactive Reply (消息驱动)                      │
              │   onMessageComplete hook                         │
              │         │                                         │
              │         ▼                                         │
              │   ProactiveConversationPlugin                    │
              │   触发词匹配 / 累积计数 / Thread用户继续发言       │
              │         │                                         │
              │         ▼                                         │
              │   ProactiveConversationService                   │
              │   debounce → PreliminaryAnalysis → Thread管理    │
              │         │                                         │
              │         ▼                                         │
              │   ProactiveReplyGenerationService                │
              │   LLM + Tools (maxToolRounds=10)                 │
              │         │                                         │
              │         ▼                                         │
              │   MessageAPI ──────────────────────┼──► QQ       │
              └──────────────────────────────────────────────────┘

              ┌──────────────────────────────────────────────────┐
              │   Agenda (定时驱动，独立于 EventRouter)            │
              │   cron / once / onEvent                          │
              │         │                                         │
              │         ▼                                         │
              │     AgentLoop                                    │
              │     LLM + Tools                                  │
              │         │                                         │
              │         ▼                                         │
              │     MessageAPI ────────────────────┼──► QQ       │
              └──────────────────────────────────────────────────┘
```

---

## 2. Protocol 协议层

### 连接建立流程

```
bootstrap.ts
    │
    ├─ registerConnectionClass('milky', WebSocketConnection)
    ├─ registerConnectionClass('onebot11', WebSocketConnection)
    ├─ registerConnectionClass('satori', WebSocketConnection)
    │
    ▼
ProtocolAdapterInitializer.initialize()
    │  监听 connectionManager 事件
    │
    ▼
bot.start()
    │
    ▼
connectionManager.connectAll()
    │
    ├─► new WebSocketConnection(config)
    │       │
    │       ▼
    │   ws = new WebSocket(url, { Authorization: Bearer <token> })
    │       │
    │       ▼  ws.onopen
    │   setState('connected') → emit('open')
    │
    ▼
connectionManager.emit('connectionOpen', protocolName)
    │
    ▼  [ProtocolAdapterInitializer 监听器触发]
    │
    ├─ switch(protocol):
    │     'milky'    → new MilkyAdapter(config, connection)
    │     'onebot11' → new OneBot11Adapter(config, connection)
    │     'satori'   → new SatoriAdapter(config, connection)
    │
    ├─ ProtocolRegistry.registerProtocol(name, { adapter, selfId })
    ├─ adapter.onEvent(event => eventRouter.routeEvent(event))
    └─ apiClient.registerAdapter(name, adapter)
```

### 消息收发对比

```
┌─────────────────────────────────────────────────────────────────┐
│                        Milky 协议                                │
│                                                                  │
│  接收: WebSocket ──► MilkyEventNormalizer ──► NormalizedEvent    │
│  发送: MessageAPI ──► MilkyAPIConverter ──► HTTP POST (apiUrl)  │
│                                                                  │
│  特点: 收发分离 (WS收, HTTP发)                                    │
│        段消息转换: MilkySegmentConverter                          │
│        支持 Forward Message                                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      OneBot11 协议                               │
│                                                                  │
│  接收: WebSocket ──► OB11 normalizeEvent ──► NormalizedEvent    │
│  发送: MessageAPI ──► WebSocket echo机制 (sendAPI)              │
│                                                                  │
│  特点: 收发均走 WebSocket                                        │
│        echo 请求追踪: pendingRequests Map                        │
│        段格式与内部格式一致，无需转换                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                       Satori 协议                                │
│                                                                  │
│  接收: WebSocket ──► 直接映射 ──► NormalizedEvent               │
│  发送: WebSocket echo机制                                        │
│                                                                  │
│  特点: 最薄的适配层，大部分字段直接透传                             │
└─────────────────────────────────────────────────────────────────┘
```

### 事件去重与路由

```
adapter.onEvent(normalizedEvent)
    │
    ▼
EventRouter.routeEvent(event)
    │
    ├─ EventDeduplicator.shouldProcess(event)
    │     │
    │     ├─ 指纹生成:
    │     │    message → msg_{messageId} 或 group_{gid}_user_{uid}_{content50}
    │     │    其他    → event_{protocol}_{content50}
    │     │
    │     ├─ 已见过(窗口内) → 丢弃
    │     └─ 未见过 → 放行
    │
    ▼
    emit(event.type)   ──► message  → MessageHandler  → ConversationManager
                        ├► notice   → NoticeHandler   → Hook: onNoticeReceived
                        ├► request  → RequestHandler
                        └► meta     → MetaEventHandler
```

---

## 3. Command 命令系统

### 命令注册流程

```
模块加载时 (import './handlers')
    │
    ▼
@Command({ name, description, permissions })  ← 装饰器
@injectable()
export class XxxCommand implements CommandHandler
    │
    ├─ commandRegistry[] 静态数组收集元数据
    └─ WeakSet 防重复注册
    │
    ▼
CommandManager 构造函数
    │
    ├─ getAllCommandMetadata() → 去重
    │
    ├─ autoRegisterDecoratedCommands()
    │     │
    │     └─ 对每个命令:
    │           创建 Proxy (懒加载)           ← 此时不实例化 Handler
    │           存入 builtinCommands Map
    │           别名也存入同一 Map
    │
    └─ 插件命令: register(handler, pluginName)
          存入 pluginCommands Map
          pluginName → 用于卸载时清理
```

### 命令执行流程

```
消息到达 Lifecycle
    │
    ▼  [PREPROCESS 阶段]
Lifecycle.routeCommand(ctx)
    │
    ├─ CommandRouter.routeFromSegments(segments)
    │     仅提取 text 段，跳过 reply/at/image
    │
    ▼
CommandParser.parse(text)
    │
    ├─ 前缀检测: '/' 或 '!'
    ├─ 分割: name + args
    └─ 返回 ParsedCommand { name, args, raw, prefix }
    │
    ▼
ctx.command = parsedCommand   (若非命令则为 null)
    │
    ▼  [PROCESS 阶段]
CommandSystem.execute(ctx)     (priority=100, 高于 ReplySystem)
    │
    ├─ ctx.command 为空? → return (交给 ReplySystem)
    │
    ├─ hookManager.execute('onCommandDetected')
    │
    ▼
CommandManager.execute(command, commandContext)
    │
    ├─ 1. 查找注册: builtinCommands[name] → pluginCommands[name]
    │
    ├─ 2. 权限检查:
    │     ┌──────────────────────────────────────────┐
    │     │  PermissionLevel 层级 (由低到高):         │
    │     │                                           │
    │     │  user         ← 所有人                    │
    │     │  group_admin  ← QQ群管理员                 │
    │     │  group_owner  ← QQ群主                    │
    │     │  admin        ← 配置文件 bot.admins[]     │
    │     │  owner        ← 配置文件 bot.owner        │
    │     │                                           │
    │     │  检查顺序:                                 │
    │     │  1. ConversationConfigService (会话级覆盖) │
    │     │  2. DefaultPermissionChecker (配置 + 协议) │
    │     │                                           │
    │     │  isSystemExecution=true → 跳过权限检查     │
    │     └──────────────────────────────────────────┘
    │
    ├─ 3. 启用检查 (admin可绕过)
    │
    ├─ 4. handler.execute(args, context)
    │     │
    │     └─ Proxy.get → container.resolve(HandlerClass) → 首次调用才实例化
    │
    ├─ 5. hookManager.execute('onCommandExecuted')
    │
    └─ 6. 返回 CommandResult { success, segments, error }
              │
              ▼
         replaceReplyWithSegments(ctx, segments, 'command')
              │
              ▼  [PREPARE → SEND → COMPLETE]
         正常走后续阶段发送
```

---

## 4. Reply 回复系统（AI Pipeline）

### 外层 Lifecycle (6 阶段)

```
MessagePipeline.process(event)
    │
    ├─ 创建 HookContext (userId, groupId, message, sessionId, ...)
    │
    ▼
Lifecycle.execute(ctx)
    │
    │  ┌─────────────────────────────────────────────────────────────┐
    │  │ Stage 1: RECEIVE                                            │
    │  │   hook: onMessageReceived                                   │
    │  │   WhitelistPlugin 在此拦截无权限消息                          │
    │  ├─────────────────────────────────────────────────────────────┤
    │  │ Stage 2: PREPROCESS                                         │
    │  │   routeCommand() → 解析命令                                  │
    │  │   hook: onMessagePreprocess                                 │
    │  │   MessageTriggerPlugin 在此设置触发标记                       │
    │  ├─────────────────────────────────────────────────────────────┤
    │  │ Stage 3: PROCESS                                            │
    │  │                                                              │
    │  │   ProcessStageInterceptor 检查 (如 NSFW)                    │
    │  │       ↓ 未拦截                                               │
    │  │   CommandSystem (priority=100)                               │
    │  │       ctx.command? → 执行命令 → 设置 reply                   │
    │  │       ↓ 无命令                                               │
    │  │   ReplySystem  (priority=20)                                │
    │  │       条件: 无 command, 无 reply, 非 noReplyPath             │
    │  │       → aiService.generateReplyWithSkills(ctx)              │
    │  │       → 进入 AI 内层 Pipeline (见下方)                       │
    │  │                                                              │
    │  ├─────────────────────────────────────────────────────────────┤
    │  │ Stage 4: PREPARE                                            │
    │  │   ReplyPrepareSystem:                                       │
    │  │     - 清理 DSML 残留                                         │
    │  │     - 判断 sendAsForward (长消息转合并转发)                    │
    │  ├─────────────────────────────────────────────────────────────┤
    │  │ Stage 5: SEND                                               │
    │  │   hook: onMessageBeforeSend                                 │
    │  │   SendSystem → MessageAPI → ProtocolAdapter → QQ            │
    │  │   hook: onMessageSent                                       │
    │  ├─────────────────────────────────────────────────────────────┤
    │  │ Stage 6: COMPLETE                                           │
    │  │   DatabasePersistenceSystem: 持久化到DB                      │
    │  │   RAGPersistenceSystem: 向量索引                             │
    │  │   hook: onMessageComplete                                   │
    │  └─────────────────────────────────────────────────────────────┘
    │
    ▼
MessagePipeline.buildResult()
    └─ contextManager.addMessage() 保存对话历史 (异步)
```

### 内层 AI Pipeline (8 阶段)

```
ReplySystem → AIService.generateReplyWithSkills(ctx)
    │
    ▼
ReplyPipelineOrchestrator.generateReplyFromToolResults(ctx)
    │
    ▼  new ReplyPipelineContext(hookContext, taskResults)
    │
    │  ┌──────────────────────────────────────────────────────────────┐
    │  │                                                              │
    │  │  Stage 1: GateCheckStage                                    │
    │  │    ├─ 白名单能力检查 (WHITELIST_CAPABILITY.reply)            │
    │  │    ├─ hook: onMessageBeforeAI   ← 插件可取消                 │
    │  │    └─ hook: onAIGenerationStart                              │
    │  │                                                              │
    │  │  Stage 2: ContextResolutionStage                            │
    │  │    ├─ 解析引用消息 → "被引用的消息: ..."                      │
    │  │    ├─ 提取图片 (当前消息 + 引用消息) → ctx.messageImages      │
    │  │    └─ 构建 tool result 摘要                                  │
    │  │                                                              │
    │  │  Stage 3: HistoryStage                                      │
    │  │    └─ EpisodeCacheManager.buildNormalHistoryEntries()        │
    │  │         ├─ 缓存命中 → 稳定前缀 + 增量加载                    │
    │  │         ├─ 缓存未命中 → 加载最近10条(10min窗口内)             │
    │  │         └─ 超过24条 → SummarizeService 压缩                  │
    │  │                                                              │
    │  │  Stage 4: ContextEnrichmentStage                            │
    │  │    ├─ [并行] MemoryService.getFilteredMemory()               │
    │  │    │    └─ 语义过滤 minRelevance=0.7                         │
    │  │    │    └─ instruction/rule 类型总是包含                      │
    │  │    └─ [并行] RetrievalService.vectorSearch()                 │
    │  │         └─ RAG 向量检索 limit=5, minScore=0.7               │
    │  │                                                              │
    │  │  Stage 5: ProviderSelectionStage                            │
    │  │    ├─ ProviderRouter: 检测前缀路由 (如 "gpt:问题")          │
    │  │    ├─ 检查 vision 能力 → ctx.useVisionProvider              │
    │  │    ├─ 检查 tool use 支持 → ctx.toolDefinitions              │
    │  │    └─ 构建工具使用说明 (自然语言注入 scene prompt)            │
    │  │                                                              │
    │  │  Stage 6: PromptAssemblyStage                               │
    │  │    └─ PromptMessageAssembler.buildNormalMessages()           │
    │  │         → 最终 ChatMessage[] (见下方结构)                     │
    │  │                                                              │
    │  │  Stage 7: GenerationStage                                   │
    │  │    ├─ 路由分派:                                              │
    │  │    │    vision+tools → generateWithTools(visionProvider)     │
    │  │    │    vision       → visionService.generateWithVision()    │
    │  │    │    tools        → generateWithTools(selectedProvider)   │
    │  │    │    plain        → generateMessages(selectedProvider)    │
    │  │    ├─ 失败 → 健康检查 + 最多4个 fallback provider 重试       │
    │  │    └─ 工具调用循环 (见第5节)                                  │
    │  │                                                              │
    │  │  Stage 8: ResponseDispatchStage                             │
    │  │    ├─ usedCardFormat? → Puppeteer 渲染卡片图片               │
    │  │    ├─ 文本过长? → LLM 转卡片 JSON → 渲染                    │
    │  │    ├─ 普通文本 → 清理残留标签 → replaceReply()               │
    │  │    └─ hook: onAIGenerationComplete                          │
    │  │                                                              │
    │  └──────────────────────────────────────────────────────────────┘
    │
    ▼
ctx.reply 已设置 → 返回外层 Lifecycle → PREPARE → SEND → COMPLETE
```

### Prompt 最终结构

```
ChatMessage[] 排列顺序:

  ┌─ system ─────────────────────────────────────────────────┐
  │  baseSystem prompt (base.system.txt)                     │
  │  变量: currentDate, adminUserId, whitelistLimited...     │
  │  ← Anthropic prompt cache 锚点                           │
  └──────────────────────────────────────────────────────────┘
  ┌─ system ─────────────────────────────────────────────────┐
  │  sceneSystem prompt (llm.reply.system)                   │
  │  变量: contextInstruct, toolInstruct                     │
  │  toolInstruct = 完整工具列表 + whenToUse + params         │
  └──────────────────────────────────────────────────────────┘
  ┌─ history (交替 user/assistant) ──────────────────────────┐
  │  user:      "[speaker:uid:nick] 消息内容"                 │
  │  assistant: "回复内容"                                    │
  │  (vision时: ContentPart[] 含 base64 图片)                │
  └──────────────────────────────────────────────────────────┘
  ┌─ user (最终用户消息块) ──────────────────────────────────┐
  │  <memory_context>                                        │
  │    ## 关于本群的记忆                                      │
  │    {groupMemory}                                         │
  │    ## 关于当前用户的记忆                                   │
  │    {userMemory}                                          │
  │  </memory_context>                                       │
  │                                                          │
  │  <rag_context>                                           │
  │    {检索到的相关对话片段}                                  │
  │  </rag_context>                                          │
  │                                                          │
  │  <current_query>                                         │
  │    [speaker:uid:nick] 当前用户消息                        │
  │  </current_query>                                        │
  └──────────────────────────────────────────────────────────┘
```

---

## 5. AIService 核心循环（多轮工具调用）

### LLMService.generateWithTools() 循环

```
输入: messages[], tools[], options { maxToolRounds=3 }
    │
    ▼
┌─────────────────────────────────────── Loop ────────────────────────────┐
│                                                                         │
│  round = 0                                                              │
│    │                                                                    │
│    ▼                                                                    │
│  ┌──────────────────────────────────────────────┐                      │
│  │  TokenRateLimiter.waitForCapacity()           │                     │
│  │  估算 token: ~2.5 chars/token (CJK)          │                      │
│  └──────────────────┬───────────────────────────┘                      │
│                     │                                                   │
│                     ▼                                                   │
│  ┌──────────────────────────────────────────────┐                      │
│  │  provider.generate(prompt, {                  │                     │
│  │    messages, tools, temperature, maxTokens    │                     │
│  │  })                                           │                     │
│  └──────────────────┬───────────────────────────┘                      │
│                     │                                                   │
│                     ▼                                                   │
│           response.functionCalls?                                       │
│            │              │                                             │
│           有              无 ──────────► return response (end_turn)     │
│            │                                                            │
│            ▼                                                            │
│  ┌──────────────────────────────────────────────┐                      │
│  │  Promise.allSettled(                          │                     │
│  │    functionCalls.map(call =>                  │                     │
│  │      toolExecutor(call)                       │                     │
│  │    )                                          │                     │
│  │  )                                            │                     │
│  │                                               │                     │
│  │  toolExecutor = executeToolCall():            │                     │
│  │    1. ToolManager 查找 ToolSpec               │                     │
│  │    2. container.resolve(ExecutorClass)         │                     │
│  │    3. toolManager.execute(call, toolCtx)      │                     │
│  │    4. return result.data ?? result.reply       │                     │
│  └──────────────────┬───────────────────────────┘                      │
│                     │                                                   │
│                     ▼                                                   │
│  messages.push({                                                        │
│    role: 'assistant',                                                   │
│    tool_calls: [{ id, name, arguments }]                               │
│  })                                                                     │
│  messages.push({                                                        │
│    role: 'tool',                                                        │
│    tool_call_id: id,                                                    │
│    content: toolResult                                                  │
│  })   x N (每个 tool call 一条)                                         │
│                     │                                                   │
│                     ▼                                                   │
│              round++ < maxRounds?                                       │
│               │           │                                             │
│              是           否                                            │
│               │           │                                             │
│           继续循环        ▼                                             │
│                   ┌────────────────────────────────┐                    │
│                   │ 追加 user 消息:                 │                   │
│                   │ "请直接给出最终回答"             │                    │
│                   │ generateMessages() 无 tools     │                   │
│                   │ 清理残留 DSML 标签              │                    │
│                   │ return (stopReason: max_rounds) │                   │
│                   └────────────────────────────────┘                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Provider 体系

```
AIManager (注册中心)
    │
    ├─ providers: Map<string, AIProvider>
    ├─ defaultProvider: per capability
    └─ ProviderSelector: per-session (群级) 覆盖，持久化到 DB
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Provider 列表                                │
│                                                                     │
│  ┌────────────┐  ┌─────────────┐  ┌───────────┐  ┌─────────────┐  │
│  │   OpenAI    │  │  Anthropic   │  │  DeepSeek  │  │   Doubao    │ │
│  │  tools: Y   │  │  tools: Y    │  │            │  │             │ │
│  │  vision: Y  │  │  vision: Y   │  │            │  │             │ │
│  │             │  │  cache: Y    │  │            │  │  webSearch  │ │
│  └────────────┘  └─────────────┘  └───────────┘  └─────────────┘  │
│                                                                     │
│  ┌────────────┐  ┌─────────────┐  ┌───────────┐  ┌─────────────┐  │
│  │   Gemini    │  │   Ollama     │  │ OpenRouter│  │    Groq     │  │
│  │             │  │  local       │  │  relay     │  │  relay      │ │
│  └────────────┘  └─────────────┘  └───────────┘  └─────────────┘  │
│                                                                     │
│  Fallback 链: doubao → deepseek → gemini → openai → anthropic      │
│  健康检查: 失败后异步触发，serverless 类跳过                          │
└─────────────────────────────────────────────────────────────────────┘
```

### DSML 回退机制

```
Provider 不支持原生 tool use 时:

LLM 输出文本中包含:
  <dsml_function_call>
  {"name": "search", "arguments": {"query": "..."}}
  </dsml_function_call>

    │
    ▼
parseDSMLFunctionCall(text)
    │
    ▼
转换为结构化 functionCalls[]
    │
    ▼
正常进入 tool 执行循环
```

### Episode 缓存与历史管理

```
EpisodeCacheManager
    │
    ▼
┌─ Episode 生命周期 ──────────────────────────────────────────┐
│                                                              │
│  episodeKey = "{sessionId}:{episodeNumber}"                  │
│                                                              │
│  首次 (无缓存):                                              │
│    ConversationHistoryService.getRecentMessages(10)          │
│    → 过滤 10min 窗口内                                       │
│    → 存入 episodeHistoryCache[key]                           │
│                                                              │
│  后续轮次 (缓存命中):                                        │
│    cached entries (稳定前缀，利于 prompt cache)               │
│    + 增量加载 since lastTimestamp                             │
│    = combined entries                                        │
│    → 超过 24 条 → SummarizeService 压缩旧消息                │
│    → 更新缓存                                                │
│                                                              │
│  回复后:                                                     │
│    maintainEpisodeContext() (fire-and-forget)                │
│    → 再次检查是否需要压缩                                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 6. Proactive Reply 主动回复

Proactive Reply 是 Reply 系统的一种模式（与普通 episode 模式并列），在 **消息 pipeline 完成后** 触发。
它通过 ProactiveConversationPlugin 在 `onMessageComplete` 阶段调度，由 ProactiveConversationService 编排整个流程。

> **与 Agenda 的区别**: Proactive Reply 由群聊消息驱动（plugin hook → debounced analysis），
> 依赖 Thread 系统管理多轮上下文；Agenda 由 cron/once/event 独立触发，不经过 MessagePipeline。

### 触发条件

```
Lifecycle COMPLETE 阶段
    │
    ▼
ProactiveConversationPlugin.onMessageComplete(ctx)
    │
    ├─ 前置检查:
    │     whitelistDenied? → 跳过
    │     无 proactive capability? → 跳过
    │     非群消息? → 跳过
    │     群不在配置中? → 跳过
    │     Bot 自身消息? → 跳过
    │     已触发 direct reply (replyTriggerType)? → 跳过
    │     命令消息? → 跳过
    │
    ├─ 活跃 Thread 中的 triggerUser 继续发言?
    │     → 直接调度 (无需触发词/累积)
    │
    ├─ 触发词匹配? (preference/{key}/trigger.txt)
    │     → 直接调度
    │
    └─ 触发词未匹配:
          累加计数器 → 达到阈值(30) → 以 idleMode 调度
```

### 分析与回复流程

```
ProactiveConversationService.scheduleForGroup(groupId)
    │
    ├─ Debounce 1s (每个群独立)
    │
    ▼
enqueueAnalysis()   ← 串行队列: 同一群前一次分析完成后才执行下一次
    │
    ▼
runAnalysis(context)
    │
    ├─ 1. 检查群是否有 proactive 配置和权限
    │
    ├─ 2. 结束超时的 Thread (空闲 > 10min)
    │
    ├─ 3. 加载最近 30 条消息 → 过滤为可读文本
    │
    ├─ 4. 用户发 "话题结束"? → 结束当前 Thread → return
    │
    ├─ 5. PreliminaryAnalysisService.analyze()
    │     ┌──────────────────────────────────────────────┐
    │     │  LLM (轻量 provider, e.g. doubao/deepseek)   │
    │     │                                                │
    │     │  输入: preference 人设摘要 + 最近消息          │
    │     │        + 活跃 Thread 上下文 (如有)             │
    │     │                                                │
    │     │  输出 JSON:                                    │
    │     │    shouldJoin: boolean                          │
    │     │    topic: string                                │
    │     │    preferenceKey: string                        │
    │     │    replyInThreadId?: string  (回复已有Thread)   │
    │     │    createNew?: boolean       (创建新Thread)     │
    │     │    threadShouldEndId?: string (结束某Thread)    │
    │     │    searchQueries?: string[]  (RAG搜索词)        │
    │     └──────────────────────────────────────────────┘
    │
    ├─ 6. 处理 threadShouldEndId → 结束指定 Thread
    │
    ├─ 7. shouldJoin=false? → 调度压缩 → return
    │
    ├─ 8. 解析 preferenceKey + 回复目标
    │
    ▼
    ├─ [路径 A] replyInThreadId 有效 → 回复已有 Thread
    │     │
    │     ├─ 等待前次回复完成 (串行化)
    │     ├─ 追加新消息到 Thread
    │     └─ replyInThread()
    │
    └─ [路径 B] createNew 或无活跃 Thread → 创建新 Thread
          │
          ├─ 边界检查: 上次新建 Thread 后有无新用户消息?
          │     → 无 → 阻止 (防重复)
          └─ joinWithNewThread()
```

### 回复生成流程

```
replyInThread() / joinWithNewThread()
    │
    ▼
ProactiveReplyContextBuilder.buildForExistingThread / buildForNewThread
    │
    ├─ [并行]
    │     ├─ getMemoryContext()         → 群记忆 + 用户记忆 (语义过滤)
    │     ├─ getRetrievedContext()      → PreferenceKnowledge RAG 搜索
    │     └─ getConversationRagSection() → 对话历史向量搜索
    │
    ├─ Thread 上下文 → historyEntries (最多24条, 超出压缩)
    ├─ preference 人设文本
    └─ 构建 ProactiveReplyInjectContext
    │
    ▼
ProactiveReplyGenerationService.generateProactiveReply(context)
    │
    ├─ 1. 解析 Provider + 能力 (vision, tool use)
    │
    ├─ 2. 构建工具定义 + 使用说明
    │
    ├─ 3. 构建 Prompt:
    │     ┌─ system: baseSystem prompt                    │
    │     ├─ system: llm.proactive.system                 │
    │     │    含 preference, contextInstruct, toolInstruct │
    │     ├─ history: Thread 消息 (user/assistant 交替)   │
    │     └─ user: memory + RAG + currentQuery            │
    │
    ├─ 4. LLM 调用 (同 AIService 核心循环):
    │     vision+tools / vision / tools / plain
    │     → generateWithTools (maxToolRounds=10)
    │
    └─ 5. 返回 response.text
    │
    ▼
processReplyMaybeCard()  → 长文本可能转卡片图片
    │
    ▼
sendGroupMessage() → MessageAPI → QQ
    │
    ▼
threadService.appendMessage()  → 更新 Thread 上下文
conversationHistoryService.appendBotReplyToGroup()  → 持久化
```

### Thread 生命周期

```
┌─ Thread 生命周期 ───────────────────────────────────────────┐
│                                                              │
│  创建: threadService.create(groupId, preferenceKey,          │
│         filteredEntries, triggerUserId, topic)                │
│                                                              │
│  消息追加: appendGroupMessages() / appendMessage()           │
│    → Thread 内维护完整消息列表                                │
│    → 超过 24 条 → replaceEarliestWithSummary()              │
│                                                              │
│  当前 Thread: setCurrentThread(groupId, threadId)            │
│    → 标记为当前活跃 Thread                                    │
│    → triggerUser 发言时自动触发回复                            │
│                                                              │
│  结束:                                                       │
│    1. 超时: 空闲 > 10min → endTimedOutThreads()             │
│    2. AI 判断: threadShouldEndId → applyThreadShouldEnd()   │
│    3. 用户请求: "话题结束" → tryEndThreadByTriggerUser()    │
│    → 结束前持久化到 DB (ProactiveThreadPersistenceService)   │
│                                                              │
│  压缩: ThreadContextCompressionService                       │
│    → 每 10 条新消息触发一次                                   │
│    → 压缩 Thread 上下文，维持 LLM 窗口可管理                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. Agenda 定时任务

### 初始化流程

```
ConversationInitializer.initialize()
    │
    ▼  Phase 4.5 (LLMService, ToolManager, MessageAPI 已就绪)
    │
AgendaInitializer.initialize(deps)
    │
    ├─ 1. new InternalEventBus()
    ├─ 2. new AgentLoop(llmService, messageAPI, historyService, ...)
    ├─ 3. new AgendaReporter(data/agenda/reports/)
    ├─ 4. new AgendaService(databaseManager, agentLoop, eventBus, reporter)
    ├─ 5. new ScheduleFileService(data/agenda/schedule.md, agendaService)
    │
    ├─ 6. scheduleFileService.ensureFileExists()   ← 首次创建模板
    ├─ 7. agendaService.start()                    ← 从 DB 加载并调度
    └─ 8. scheduleFileService.syncFromFile()       ← 文件 → DB 同步
    │
    ▼
ServiceRegistry.registerAgendaServices()
    → DI: AGENDA_SERVICE, AGENT_LOOP, INTERNAL_EVENT_BUS,
           AGENDA_REPORTER, SCHEDULE_FILE_SERVICE
```

### 三种触发方式

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AgendaService                                │
│                                                                     │
│  ┌─── cron 触发 ──────────────────────────────────────────────┐    │
│  │  node-cron.schedule(cronExpr, callback)                     │    │
│  │  存储: cronTasks Map                                        │    │
│  │  冷却: 不检查 (cron 表达式本身控制频率)                      │    │
│  │  示例: "0 8 * * *" → 每天8点                                │    │
│  └─────────────────────────────────┬───────────────────────────┘    │
│                                    │                                │
│  ┌─── once 触发 ──────────────────────────────────────────────┐    │
│  │  setTimeout(callback, delay)                                │    │
│  │  存储: onceTimers Map                                       │    │
│  │  执行后自动删除                                              │    │
│  │  过期且未执行过 → 立即删除                                   │    │
│  │  示例: "2026-06-01T08:00:00"                                │    │
│  └─────────────────────────────────┬───────────────────────────┘    │
│                                    │                                │
│  ┌─── onEvent 触发 ───────────────────────────────────────────┐    │
│  │  InternalEventBus.subscribe(eventType, handler)             │    │
│  │  存储: eventHandlers Map                                    │    │
│  │  过滤: groupId 匹配 + eventFilter JSON 键值匹配             │    │
│  │  冷却: 检查 cooldownMs                                      │    │
│  │  示例: "group_member_join", "keyword_match"                 │    │
│  └─────────────────────────────────┬───────────────────────────┘    │
│                                    │                                │
│                                    ▼                                │
│                          fireItem(item, eventContext)               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 主动会话执行流程

```
触发 (cron/once/onEvent)
    │
    ▼
AgendaService.fireItem(item, eventContext)
    │
    ├─ 1. 从 DB 重新获取 item (防止过期数据)
    ├─ 2. enabled? → No → 跳过
    ├─ 3. 冷却检查 (once/onEvent): elapsed >= cooldownMs?
    │       → No → 跳过
    │
    ▼
AgentLoop.run(item, eventContext)
    │
    ├─ 确定目标: groupId → 群消息 / userId → 私聊
    │
    ▼
AgentLoop.generateReply(item, contextId, eventContext)
    │
    │  ┌─────────────────────────────────────────────────────┐
    │  │  a. fetchRecentContext(groupId)                      │
    │  │     ConversationHistoryService.getRecentMessages(15) │
    │  │     → 取最近10条                                     │
    │  │     → 格式化: "Bot: ..." / "User(id): ..."          │
    │  │                                                      │
    │  │  b. getAgendaToolDefinitions()                       │
    │  │     reply scope + subagent scope 工具合并去重         │
    │  │                                                      │
    │  │  c. buildPrompt(item, context, event, toolInstruct)  │
    │  │     ┌─ system: agenda.agent_loop_system              │
    │  │     │           含 toolInstruct                       │
    │  │     └─ user:   当前时间                               │
    │  │                任务意图: {item.intent}                │
    │  │                事件信息 (如有)                         │
    │  │                最近聊天记录                            │
    │  │                                                      │
    │  │  d. buildAgendaHookContext()                          │
    │  │     构造合成 HookContext (含假 MessageEvent)          │
    │  │     → 使 tool 执行与正常回复 pipeline 行为一致        │
    │  │                                                      │
    │  │  e. llmService.generateWithTools(                     │
    │  │       messages, tools,                                │
    │  │       { maxToolRounds: item.maxSteps },               │
    │  │       DEFAULT_PROVIDER                                │
    │  │     )                                                 │
    │  │     → 多轮工具调用循环 (同第5节)                      │
    │  │                                                      │
    │  │  f. return response.text                              │
    │  └─────────────────────────────────────────────────────┘
    │
    ▼
有回复?
    │         │
   是         否 → 结束
    │
    ▼
messageAPI.sendGroupMessage(groupId, reply, 'milky')
  或 messageAPI.sendPrivateMessage(userId, reply, 'milky')
    │
    ▼
reporter.recordRun({ item, duration, success: true })
    │
    ▼
once 类型? → 删除 item
其他      → 更新 lastRunAt
```

### schedule.md 文件格式

```markdown
## 每日早安问候
- 触发: `cron 0 8 * * *`
- 群: `123456789`
- 冷却: `23h`
- 步数: `10`

根据最近的聊天氛围，生成一条自然的早安问候。

---

## 新成员欢迎
- 触发: `onEvent group_member_join`
- 群: `123456789`
- 冷却: `30s`
- 事件过滤: `{"groupId":"123456789"}`

热情地欢迎新成员加入群聊。
```

### InternalEventBus 事件发布

```
任何模块                               AgendaService
    │                                       │
    ├─ container.resolve(INTERNAL_EVENT_BUS) │
    │                                       │
    ▼                                       │
eventBus.publish({                          │
  type: 'group_member_join',                │
  groupId: '123',                ──────────►│ subscribe(type, handler)
  userId: '456',                            │     ├─ groupId 过滤
  data: { ... }                             │     ├─ eventFilter 匹配
})                                          │     └─ fireItem()
                                            │
已知事件源:                                  │
  - WechatEventBridge (微信消息/群事件)      │
  - NoticeHandler (可扩展)                   │
```

---

## 附录：Hook 全景图

```
Pipeline Stage        Hook Name                  典型用途
─────────────────────────────────────────────────────────────
RECEIVE               onMessageReceived          白名单拦截
PREPROCESS            onMessagePreprocess         触发规则、元数据
PROCESS               onCommandDetected           命令拦截/日志
                      onCommandExecuted           命令后处理
                      onMessageBeforeAI           AI前拦截 (如 NSFW)
                      onAIGenerationStart         AI开始
                      onAIGenerationComplete      AI完成后处理
SEND                  onMessageBeforeSend         发送前修改
                      onMessageSent               发送后通知
COMPLETE              onMessageComplete           持久化、统计
(任意)                onError                     全局错误处理
(通知)                onNoticeReceived            通知事件处理

Hook 优先级: HIGHEST(0) → HIGH(300) → NORMAL(500) → LOW(700) → LOWEST(900)
返回 false 可中断 pipeline
```
