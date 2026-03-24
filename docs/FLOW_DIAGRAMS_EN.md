# QQBot Architecture Flow Diagrams

## Table of Contents

1. [Overview](#1-overview)
2. [Protocol Layer](#2-protocol-layer)
3. [Command System](#3-command-system)
4. [Reply System (AI Pipeline)](#4-reply-system-ai-pipeline)
5. [AIService Core Loop (Multi-turn Tool Calling)](#5-aiservice-core-loop-multi-turn-tool-calling)
6. [Proactive Conversation (Agenda)](#6-proactive-conversation-agenda)

---

## 1. Overview

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

              ┌─────────────────────────┐
              │   AgendaService         │  (independent trigger, bypasses EventRouter)
              │   cron / once / onEvent │
              │         │               │
              │         ▼               │
              │     AgentLoop           │
              │     LLM + Tools         │
              │         │               │
              │         ▼               │
              │     MessageAPI ─────────┼──► Protocol → QQ
              └─────────────────────────┘
```

---

## 2. Protocol Layer

### Connection Establishment

```
bootstrap.ts
    │
    ├─ registerConnectionClass('milky', WebSocketConnection)
    ├─ registerConnectionClass('onebot11', WebSocketConnection)
    ├─ registerConnectionClass('satori', WebSocketConnection)
    │
    ▼
ProtocolAdapterInitializer.initialize()
    │  Listens on connectionManager events
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
    ▼  [ProtocolAdapterInitializer listener fires]
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

### Protocol Send/Receive Comparison

```
┌─────────────────────────────────────────────────────────────────┐
│                        Milky Protocol                            │
│                                                                  │
│  Recv: WebSocket ──► MilkyEventNormalizer ──► NormalizedEvent    │
│  Send: MessageAPI ──► MilkyAPIConverter ──► HTTP POST (apiUrl)  │
│                                                                  │
│  Notes: Separate channels (WS for recv, HTTP for send)           │
│         Segment conversion: MilkySegmentConverter                │
│         Supports Forward Message                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      OneBot11 Protocol                           │
│                                                                  │
│  Recv: WebSocket ──► OB11 normalizeEvent ──► NormalizedEvent    │
│  Send: MessageAPI ──► WebSocket echo mechanism (sendAPI)        │
│                                                                  │
│  Notes: Both send and recv via WebSocket                         │
│         Echo-based request tracking: pendingRequests Map         │
│         Segment format matches internal format, no conversion    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                       Satori Protocol                            │
│                                                                  │
│  Recv: WebSocket ──► direct mapping ──► NormalizedEvent         │
│  Send: WebSocket echo mechanism                                  │
│                                                                  │
│  Notes: Thinnest adapter layer, most fields pass through         │
└─────────────────────────────────────────────────────────────────┘
```

### Event Deduplication & Routing

```
adapter.onEvent(normalizedEvent)
    │
    ▼
EventRouter.routeEvent(event)
    │
    ├─ EventDeduplicator.shouldProcess(event)
    │     │
    │     ├─ Fingerprint generation:
    │     │    message → msg_{messageId} or group_{gid}_user_{uid}_{content50}
    │     │    other   → event_{protocol}_{content50}
    │     │
    │     ├─ Already seen (within window) → Drop
    │     └─ First seen → Pass through
    │
    ▼
    emit(event.type)   ──► message  → MessageHandler  → ConversationManager
                        ├► notice   → NoticeHandler   → Hook: onNoticeReceived
                        ├► request  → RequestHandler
                        └► meta     → MetaEventHandler
```

---

## 3. Command System

### Command Registration

```
Module load time (import './handlers')
    │
    ▼
@Command({ name, description, permissions })  ← decorator
@injectable()
export class XxxCommand implements CommandHandler
    │
    ├─ commandRegistry[] static array collects metadata
    └─ WeakSet prevents duplicate registration
    │
    ▼
CommandManager constructor
    │
    ├─ getAllCommandMetadata() → deduplicate
    │
    ├─ autoRegisterDecoratedCommands()
    │     │
    │     └─ For each command:
    │           Create Proxy (lazy)              ← Handler NOT instantiated yet
    │           Store in builtinCommands Map
    │           Aliases also stored in same Map
    │
    └─ Plugin commands: register(handler, pluginName)
          Store in pluginCommands Map
          pluginName → used for cleanup on unload
```

### Command Execution Flow

```
Message arrives at Lifecycle
    │
    ▼  [PREPROCESS stage]
Lifecycle.routeCommand(ctx)
    │
    ├─ CommandRouter.routeFromSegments(segments)
    │     Extract text segments only, skip reply/at/image
    │
    ▼
CommandParser.parse(text)
    │
    ├─ Prefix detection: '/' or '!'
    ├─ Split into: name + args
    └─ Return ParsedCommand { name, args, raw, prefix }
    │
    ▼
ctx.command = parsedCommand   (null if not a command)
    │
    ▼  [PROCESS stage]
CommandSystem.execute(ctx)     (priority=100, higher than ReplySystem)
    │
    ├─ ctx.command is null? → return (hand off to ReplySystem)
    │
    ├─ hookManager.execute('onCommandDetected')
    │
    ▼
CommandManager.execute(command, commandContext)
    │
    ├─ 1. Lookup: builtinCommands[name] → pluginCommands[name]
    │
    ├─ 2. Permission check:
    │     ┌──────────────────────────────────────────────┐
    │     │  PermissionLevel hierarchy (low → high):      │
    │     │                                                │
    │     │  user         ← everyone                       │
    │     │  group_admin  ← QQ group admin                 │
    │     │  group_owner  ← QQ group owner                 │
    │     │  admin        ← config bot.admins[]            │
    │     │  owner        ← config bot.owner               │
    │     │                                                │
    │     │  Check order:                                   │
    │     │  1. ConversationConfigService (session override)│
    │     │  2. DefaultPermissionChecker (config + protocol)│
    │     │                                                │
    │     │  isSystemExecution=true → skip permission check │
    │     └──────────────────────────────────────────────┘
    │
    ├─ 3. Enabled check (admin can bypass)
    │
    ├─ 4. handler.execute(args, context)
    │     │
    │     └─ Proxy.get → container.resolve(HandlerClass) → first-call instantiation
    │
    ├─ 5. hookManager.execute('onCommandExecuted')
    │
    └─ 6. Return CommandResult { success, segments, error }
              │
              ▼
         replaceReplyWithSegments(ctx, segments, 'command')
              │
              ▼  [PREPARE → SEND → COMPLETE]
         Continue through remaining stages
```

---

## 4. Reply System (AI Pipeline)

### Outer Lifecycle (6 Stages)

```
MessagePipeline.process(event)
    │
    ├─ Create HookContext (userId, groupId, message, sessionId, ...)
    │
    ▼
Lifecycle.execute(ctx)
    │
    │  ┌─────────────────────────────────────────────────────────────┐
    │  │ Stage 1: RECEIVE                                            │
    │  │   hook: onMessageReceived                                   │
    │  │   WhitelistPlugin gates unauthorized messages here           │
    │  ├─────────────────────────────────────────────────────────────┤
    │  │ Stage 2: PREPROCESS                                         │
    │  │   routeCommand() → parse command                            │
    │  │   hook: onMessagePreprocess                                 │
    │  │   MessageTriggerPlugin sets trigger flags here               │
    │  ├─────────────────────────────────────────────────────────────┤
    │  │ Stage 3: PROCESS                                            │
    │  │                                                              │
    │  │   ProcessStageInterceptor check (e.g. NSFW)                 │
    │  │       ↓ not intercepted                                      │
    │  │   CommandSystem (priority=100)                               │
    │  │       ctx.command? → execute command → set reply             │
    │  │       ↓ no command                                           │
    │  │   ReplySystem  (priority=20)                                │
    │  │       Conditions: no command, no reply, not noReplyPath     │
    │  │       → aiService.generateReplyWithSkills(ctx)              │
    │  │       → Enter inner AI Pipeline (see below)                 │
    │  │                                                              │
    │  ├─────────────────────────────────────────────────────────────┤
    │  │ Stage 4: PREPARE                                            │
    │  │   ReplyPrepareSystem:                                       │
    │  │     - Strip DSML artifacts                                   │
    │  │     - Resolve sendAsForward (long messages → forward msg)   │
    │  ├─────────────────────────────────────────────────────────────┤
    │  │ Stage 5: SEND                                               │
    │  │   hook: onMessageBeforeSend                                 │
    │  │   SendSystem → MessageAPI → ProtocolAdapter → QQ            │
    │  │   hook: onMessageSent                                       │
    │  ├─────────────────────────────────────────────────────────────┤
    │  │ Stage 6: COMPLETE                                           │
    │  │   DatabasePersistenceSystem: persist to DB                  │
    │  │   RAGPersistenceSystem: vector indexing                     │
    │  │   hook: onMessageComplete                                   │
    │  └─────────────────────────────────────────────────────────────┘
    │
    ▼
MessagePipeline.buildResult()
    └─ contextManager.addMessage() save conversation history (async)
```

### Inner AI Pipeline (8 Stages)

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
    │  │    ├─ Whitelist capability check (WHITELIST_CAPABILITY.reply)│
    │  │    ├─ hook: onMessageBeforeAI   ← plugins can cancel        │
    │  │    └─ hook: onAIGenerationStart                              │
    │  │                                                              │
    │  │  Stage 2: ContextResolutionStage                            │
    │  │    ├─ Resolve quoted message → "Referenced message: ..."    │
    │  │    ├─ Extract images (current + quoted msg) → ctx.msgImages │
    │  │    └─ Build tool result summary                              │
    │  │                                                              │
    │  │  Stage 3: HistoryStage                                      │
    │  │    └─ EpisodeCacheManager.buildNormalHistoryEntries()        │
    │  │         ├─ Cache hit → stable prefix + incremental load     │
    │  │         ├─ Cache miss → load recent 10 msgs (10min window)  │
    │  │         └─ Over 24 entries → SummarizeService compresses    │
    │  │                                                              │
    │  │  Stage 4: ContextEnrichmentStage                            │
    │  │    ├─ [parallel] MemoryService.getFilteredMemory()          │
    │  │    │    └─ Semantic filter minRelevance=0.7                  │
    │  │    │    └─ instruction/rule types always included            │
    │  │    └─ [parallel] RetrievalService.vectorSearch()            │
    │  │         └─ RAG vector search limit=5, minScore=0.7          │
    │  │                                                              │
    │  │  Stage 5: ProviderSelectionStage                            │
    │  │    ├─ ProviderRouter: detect prefix routing (e.g. "gpt:Q") │
    │  │    ├─ Check vision capability → ctx.useVisionProvider       │
    │  │    ├─ Check tool use support → ctx.toolDefinitions          │
    │  │    └─ Build tool usage instructions (inject into scene)     │
    │  │                                                              │
    │  │  Stage 6: PromptAssemblyStage                               │
    │  │    └─ PromptMessageAssembler.buildNormalMessages()           │
    │  │         → Final ChatMessage[] (see structure below)         │
    │  │                                                              │
    │  │  Stage 7: GenerationStage                                   │
    │  │    ├─ Capability-based dispatch:                             │
    │  │    │    vision+tools → generateWithTools(visionProvider)     │
    │  │    │    vision       → visionService.generateWithVision()    │
    │  │    │    tools        → generateWithTools(selectedProvider)   │
    │  │    │    plain        → generateMessages(selectedProvider)    │
    │  │    ├─ Failure → health check + up to 4 fallback providers   │
    │  │    └─ Tool calling loop (see Section 5)                     │
    │  │                                                              │
    │  │  Stage 8: ResponseDispatchStage                             │
    │  │    ├─ usedCardFormat? → Puppeteer render card image         │
    │  │    ├─ Text too long? → LLM convert to card JSON → render   │
    │  │    ├─ Plain text → strip residual tags → replaceReply()     │
    │  │    └─ hook: onAIGenerationComplete                          │
    │  │                                                              │
    │  └──────────────────────────────────────────────────────────────┘
    │
    ▼
ctx.reply is set → return to outer Lifecycle → PREPARE → SEND → COMPLETE
```

### Final Prompt Structure

```
ChatMessage[] ordering:

  ┌─ system ─────────────────────────────────────────────────┐
  │  baseSystem prompt (base.system.txt)                     │
  │  Vars: currentDate, adminUserId, whitelistLimited...     │
  │  ← Anthropic prompt cache anchor                         │
  └──────────────────────────────────────────────────────────┘
  ┌─ system ─────────────────────────────────────────────────┐
  │  sceneSystem prompt (llm.reply.system)                   │
  │  Vars: contextInstruct, toolInstruct                     │
  │  toolInstruct = full tool list + whenToUse + params      │
  └──────────────────────────────────────────────────────────┘
  ┌─ history (alternating user/assistant) ───────────────────┐
  │  user:      "[speaker:uid:nick] message content"         │
  │  assistant: "reply content"                              │
  │  (with vision: ContentPart[] with base64 images)         │
  └──────────────────────────────────────────────────────────┘
  ┌─ user (final user message block) ───────────────────────┐
  │  <memory_context>                                        │
  │    ## Group memory                                       │
  │    {groupMemory}                                         │
  │    ## User memory                                        │
  │    {userMemory}                                          │
  │  </memory_context>                                       │
  │                                                          │
  │  <rag_context>                                           │
  │    {retrieved relevant conversation segments}             │
  │  </rag_context>                                          │
  │                                                          │
  │  <current_query>                                         │
  │    [speaker:uid:nick] current user message               │
  │  </current_query>                                        │
  └──────────────────────────────────────────────────────────┘
```

---

## 5. AIService Core Loop (Multi-turn Tool Calling)

### LLMService.generateWithTools() Loop

```
Input: messages[], tools[], options { maxToolRounds=3 }
    │
    ▼
┌─────────────────────────────────────── Loop ────────────────────────────┐
│                                                                         │
│  round = 0                                                              │
│    │                                                                    │
│    ▼                                                                    │
│  ┌──────────────────────────────────────────────┐                      │
│  │  TokenRateLimiter.waitForCapacity()           │                     │
│  │  Estimate tokens: ~2.5 chars/token (CJK)     │                      │
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
│          Yes              No ──────────► return response (end_turn)     │
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
│  │    1. ToolManager lookup ToolSpec             │                     │
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
│  })   x N (one per tool call)                                           │
│                     │                                                   │
│                     ▼                                                   │
│              round++ < maxRounds?                                       │
│               │           │                                             │
│             Yes           No                                            │
│               │           │                                             │
│          Continue loop    ▼                                             │
│                   ┌────────────────────────────────┐                    │
│                   │ Append user message:            │                   │
│                   │ "Please provide final answer"   │                   │
│                   │ generateMessages() without tools│                   │
│                   │ Strip residual DSML tags         │                   │
│                   │ return (stopReason: max_rounds) │                   │
│                   └────────────────────────────────┘                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Provider Architecture

```
AIManager (Registry)
    │
    ├─ providers: Map<string, AIProvider>
    ├─ defaultProvider: per capability
    └─ ProviderSelector: per-session (group-level) override, persisted to DB
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Provider List                                │
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
│  Fallback chain: doubao → deepseek → gemini → openai → anthropic   │
│  Health check: async on failure, serverless providers skip          │
└─────────────────────────────────────────────────────────────────────┘
```

### DSML Fallback Mechanism

```
When provider does not support native tool use:

LLM output text contains:
  <dsml_function_call>
  {"name": "search", "arguments": {"query": "..."}}
  </dsml_function_call>

    │
    ▼
parseDSMLFunctionCall(text)
    │
    ▼
Convert to structured functionCalls[]
    │
    ▼
Enter normal tool execution loop
```

### Episode Cache & History Management

```
EpisodeCacheManager
    │
    ▼
┌─ Episode Lifecycle ────────────────────────────────────────┐
│                                                              │
│  episodeKey = "{sessionId}:{episodeNumber}"                  │
│                                                              │
│  First time (no cache):                                      │
│    ConversationHistoryService.getRecentMessages(10)          │
│    → Filter within 10min window                              │
│    → Store in episodeHistoryCache[key]                       │
│                                                              │
│  Subsequent turns (cache hit):                               │
│    cached entries (stable prefix, aids prompt caching)       │
│    + incremental load since lastTimestamp                    │
│    = combined entries                                        │
│    → Over 24 entries → SummarizeService compresses old msgs │
│    → Update cache                                            │
│                                                              │
│  After reply:                                                │
│    maintainEpisodeContext() (fire-and-forget)                │
│    → Re-check if compression needed                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 6. Proactive Conversation (Agenda)

### Initialization Flow

```
ConversationInitializer.initialize()
    │
    ▼  Phase 4.5 (LLMService, ToolManager, MessageAPI ready)
    │
AgendaInitializer.initialize(deps)
    │
    ├─ 1. new InternalEventBus()
    ├─ 2. new AgentLoop(llmService, messageAPI, historyService, ...)
    ├─ 3. new AgendaReporter(data/agenda/reports/)
    ├─ 4. new AgendaService(databaseManager, agentLoop, eventBus, reporter)
    ├─ 5. new ScheduleFileService(data/agenda/schedule.md, agendaService)
    │
    ├─ 6. scheduleFileService.ensureFileExists()   ← create template on first run
    ├─ 7. agendaService.start()                    ← hydrate schedules from DB
    └─ 8. scheduleFileService.syncFromFile()       ← sync file → DB
    │
    ▼
ServiceRegistry.registerAgendaServices()
    → DI: AGENDA_SERVICE, AGENT_LOOP, INTERNAL_EVENT_BUS,
           AGENDA_REPORTER, SCHEDULE_FILE_SERVICE
```

### Three Trigger Types

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AgendaService                                │
│                                                                     │
│  ┌─── Cron Trigger ──────────────────────────────────────────┐     │
│  │  node-cron.schedule(cronExpr, callback)                    │     │
│  │  Storage: cronTasks Map                                    │     │
│  │  Cooldown: NOT checked (cron expression controls freq)     │     │
│  │  Example: "0 8 * * *" → daily at 8am                      │     │
│  └─────────────────────────────────┬──────────────────────────┘     │
│                                    │                                │
│  ┌─── Once Trigger ──────────────────────────────────────────┐     │
│  │  setTimeout(callback, delay)                               │     │
│  │  Storage: onceTimers Map                                   │     │
│  │  Auto-deleted after execution                              │     │
│  │  Expired & never run → deleted immediately                 │     │
│  │  Example: "2026-06-01T08:00:00"                            │     │
│  └─────────────────────────────────┬──────────────────────────┘     │
│                                    │                                │
│  ┌─── Event Trigger ─────────────────────────────────────────┐     │
│  │  InternalEventBus.subscribe(eventType, handler)            │     │
│  │  Storage: eventHandlers Map                                │     │
│  │  Filters: groupId match + eventFilter JSON key-value match │     │
│  │  Cooldown: checks cooldownMs                               │     │
│  │  Example: "group_member_join", "keyword_match"             │     │
│  └─────────────────────────────────┬──────────────────────────┘     │
│                                    │                                │
│                                    ▼                                │
│                          fireItem(item, eventContext)               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Proactive Message Execution Flow

```
Trigger fires (cron/once/onEvent)
    │
    ▼
AgendaService.fireItem(item, eventContext)
    │
    ├─ 1. Re-fetch item from DB (prevent stale data)
    ├─ 2. enabled? → No → Skip
    ├─ 3. Cooldown check (once/onEvent): elapsed >= cooldownMs?
    │       → No → Skip
    │
    ▼
AgentLoop.run(item, eventContext)
    │
    ├─ Determine target: groupId → group msg / userId → private msg
    │
    ▼
AgentLoop.generateReply(item, contextId, eventContext)
    │
    │  ┌─────────────────────────────────────────────────────┐
    │  │  a. fetchRecentContext(groupId)                      │
    │  │     ConversationHistoryService.getRecentMessages(15) │
    │  │     → Take last 10 messages                          │
    │  │     → Format as: "Bot: ..." / "User(id): ..."       │
    │  │                                                      │
    │  │  b. getAgendaToolDefinitions()                       │
    │  │     Merge reply + subagent scope tools (deduplicated) │
    │  │                                                      │
    │  │  c. buildPrompt(item, context, event, toolInstruct)  │
    │  │     ┌─ system: agenda.agent_loop_system              │
    │  │     │           includes toolInstruct                 │
    │  │     └─ user:   current datetime                      │
    │  │                task intent: {item.intent}            │
    │  │                event info (if any)                    │
    │  │                recent chat history                    │
    │  │                                                      │
    │  │  d. buildAgendaHookContext()                          │
    │  │     Build synthetic HookContext (with fake MsgEvent) │
    │  │     → Ensures tool execution behaves like normal flow│
    │  │                                                      │
    │  │  e. llmService.generateWithTools(                     │
    │  │       messages, tools,                                │
    │  │       { maxToolRounds: item.maxSteps },               │
    │  │       DEFAULT_PROVIDER                                │
    │  │     )                                                 │
    │  │     → Multi-turn tool calling loop (same as Sec. 5)  │
    │  │                                                      │
    │  │  f. return response.text                              │
    │  └─────────────────────────────────────────────────────┘
    │
    ▼
Has reply?
    │         │
   Yes        No → End
    │
    ▼
messageAPI.sendGroupMessage(groupId, reply, 'milky')
  or messageAPI.sendPrivateMessage(userId, reply, 'milky')
    │
    ▼
reporter.recordRun({ item, duration, success: true })
    │
    ▼
once type? → Delete item
otherwise → Update lastRunAt
```

### schedule.md File Format

```markdown
## Daily Morning Greeting
- trigger: `cron 0 8 * * *`
- group: `123456789`
- cooldown: `23h`
- steps: `10`

Generate a natural morning greeting based on recent chat atmosphere.

---

## New Member Welcome
- trigger: `onEvent group_member_join`
- group: `123456789`
- cooldown: `30s`
- eventFilter: `{"groupId":"123456789"}`

Warmly welcome the new member to the group.
```

### InternalEventBus Event Publishing

```
Any module                             AgendaService
    │                                       │
    ├─ container.resolve(INTERNAL_EVENT_BUS) │
    │                                       │
    ▼                                       │
eventBus.publish({                          │
  type: 'group_member_join',                │
  groupId: '123',                ──────────►│ subscribe(type, handler)
  userId: '456',                            │     ├─ groupId filter
  data: { ... }                             │     ├─ eventFilter match
})                                          │     └─ fireItem()
                                            │
Known event sources:                        │
  - WechatEventBridge (WeChat msg/group)    │
  - NoticeHandler (extensible)              │
```

---

## Appendix: Hook Overview

```
Pipeline Stage        Hook Name                  Typical Usage
─────────────────────────────────────────────────────────────
RECEIVE               onMessageReceived          Whitelist gating
PREPROCESS            onMessagePreprocess         Trigger rules, metadata
PROCESS               onCommandDetected           Command intercept/logging
                      onCommandExecuted           Post-command processing
                      onMessageBeforeAI           Pre-AI intercept (e.g. NSFW)
                      onAIGenerationStart         AI generation begins
                      onAIGenerationComplete      Post-AI processing
SEND                  onMessageBeforeSend         Modify before send
                      onMessageSent               Post-send notification
COMPLETE              onMessageComplete           Persistence, analytics
(any)                 onError                     Global error handling
(notice)              onNoticeReceived            Notice event processing

Hook priority: HIGHEST(0) → HIGH(300) → NORMAL(500) → LOW(700) → LOWEST(900)
Return false to interrupt pipeline
```
