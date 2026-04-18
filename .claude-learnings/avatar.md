# Avatar Preview — Live2D WebSocket Streaming

## Preview WS Protocol

### Message: `frame`
Emitted on every animation tick with current parameter values.
```typescript
{
  type: 'frame',
  data: {
    timestamp: number,        // Unix ms
    params: Record<string, number>  // Live2D parameter key → current value
  }
}
```

### Message: `status`
Emitted on state changes and periodically (e.g., every second).
```typescript
{
  type: 'status',
  data: {
    state: string,            // e.g., 'idle', 'talking', 'reacting'
    fps: number,              // current animation FPS
    activeAnimations: number, // number of playing animation tracks
    queueLength: number       // pending animation queue depth
  }
}
```

## LAN Configuration Rule

- **Bind PreviewServer to `0.0.0.0`** (not `127.0.0.1`) so it is reachable from other machines on the LAN.
- Use a **dedicated port** (default `8002`) separate from the bot's main API port.
- The preview HTML page derives its WebSocket host from `location.hostname` — it connects to `ws://<same hostname>:8002`. This means the page works automatically when opened from any LAN device, without hardcoding IPs.

## Implementation Notes

- **`PreviewServer` uses `Bun.serve`** with `idleTimeout=255` to keep connections alive efficiently.
- **Caches latest `PreviewStatus`** and sends it immediately to new clients on WebSocket connect — ensures newly connected clients see current state without waiting for the next periodic broadcast.
- **Client `Set`** is maintained; dead clients (send failure) are pruned from the set.
- The preview page is **fully self-contained** (single `index.html` with inline CSS/JS) — no build step, no external dependencies.


## State Machine (`src/avatar/state/`)

- **BotState 5 态**：`idle` / `listening` / `thinking` / `speaking` / `reacting`
- **状态转换输出**（`TRANSITION_ANIMATIONS`）：
  - `* → idle`：空数组（启动随机待机定时器）
  - `* → listening`：`lean_forward` intensity 0.3
  - `* → thinking`：`thinking` intensity 0.6，**duration=0 表示持续到下一次状态切换**
  - `* → speaking`：空数组（由 LLM 标签驱动）
  - `* → reacting`：空数组（由事件决定）
- **待机动画**（`IDLE_ANIMATIONS`）：`blink` / `head_sway` / `breathe`
  三种微动，idle 状态下按 `IdleConfig.idleIntervalMin..Max`（默认 3-8s）
  随机间隔发射 `'idle-animation'` 事件。
- **定时器策略**：`setTimeout` 链式重排（而非 `setInterval`），每次
  动画结束后重新随机下一次间隔。`stop()` / 非 idle 状态自动清定时器。
- **类型独立**：`StateNodeOutput` 在本模块内定义，结构与
  `src/avatar/compiler/` 的 `StateNode` 一致，**不**跨模块 import，
  由集成 ticket 统一。


## Driver Adapter Layer (`src/avatar/drivers/`)

### Contract: `DriverAdapter`

`DriverAdapter extends EventEmitter`. 事件：
- `'connected'`：认证成功
- `'disconnected' (error?: Error)`：连接断开
- `'error' (error: Error)`：通信错误

方法：`connect()` / `disconnect()` / `sendFrame(params)` / `isConnected()`

### VTS Auth Flow

1. **首次**：发送 `AuthenticationTokenRequest` → 用户在 VTS UI 批准插件 → 返回 `authenticationToken` → 持久化到 `config/avatar/.vts-token`（`Bun.write`，目录用 `mkdir(..., {recursive: true})`）
2. **后续**：加载缓存 token → 发送 `AuthenticationRequest` + `authenticationToken` → `data.authenticated === true` 则成功
3. `reconnectAttempts` 重置为 0

### Throttle Strategy

Drop-frame，不排队。`sendFrame` 在 `1000/throttleFps` ms 内被再次调用时直接 return。VTS 推荐 ≤30 writes/sec，默认 `throttleFps=30`。

### Reconnect

指数退避：`delay = min(30000, 3000 * 2^attempts)`。连接断开时 schedule 重连。`disconnect()` 设置 `destroyed=true` 抑制重连。

### Request/Response Correlation

`requestID = crypto.randomUUID()` + `pendingRequests` Map。每请求 10s 超时，超时删除 entry 并 reject。`resp.messageType === 'APIError'` 也 reject。

### `sendFrame` Fire-and-Forget

`InjectParameterDataRequest` 发送后**不 await**，不 track requestID。延迟预算 <5ms。`ws.send` 包在 try/catch 中，emit `'error'` 但不 throw。


## Animation Compiler (`src/avatar/compiler/`)

### 数据流
`StateNode[] → pendingQueue → processQueue() → activeAnimations → tick() → FrameOutput`

### 类型契约
- `StateNode`：LLM 输出的高层指令 (action/emotion/intensity/duration/delay/easing)
- `ParamTarget`：`{ paramId, targetValue, weight }`；action-map 解析的产物
- `ActiveAnimation`：StateNode + 计算后的 startTime/endTime/targetParams/phase
- `FrameOutput`：`{ timestamp, params: Record<paramId, value> }`，按 outputFps 发射
- `CompilerConfig`：fps(60) / outputFps(30) / smoothingFactor(0.3) / attackRatio(0.2) /
  releaseRatio(0.3) / defaultEasing('easeInOutCubic')

### ASR 包络
- Attack: elapsed ∈ [0, attackRatio*duration] → progress = elapsed/attackTime
- Sustain: elapsed ∈ [attackTime, duration-releaseTime] → progress = 1
- Release: elapsed ∈ [duration-releaseTime, duration] → progress 线性降至 0

### 关键实现细节
- **intensity 只乘一次**：在 `ActionMap.resolveAction` 里把 `targetValue *= intensity`；
  tick 循环内不要再乘，避免双重缩放
- **低通滤波**：`currentParams[id] += (targetValue - currentParams[id]) * smoothingFactor`；
  避免参数突变
- **降采样**：内部 60fps ticker，`'frame'` 事件按 `outputFps` 频率发射
  （emitEvery = round(fps/outputFps)）
- **EventEmitter 继承**：方便 Driver 和 Preview Server 同时订阅，不用回调链
- **除零保护**：`attackTime === 0` 返回 1，`releaseTime === 0` 返回 0

### Action Map 格式 (`config/avatar/action-map.json`)
- Key = action 名，value = `{ params: ParamTarget[], defaultDuration: ms }`
- 预置 8 个动作：smile / nod / wave / thinking / sad / angry / surprised / idle_blink
- 参数范围参考 Live2D Cubism（ParamAngleX/Y/Z: ±30，ParamEyeLOpen/ROpen: 0~1，
  ParamMouthForm: -1~1 等）

### 边界约束
- 不做 DI 注册（纯逻辑模块，由上层 AvatarService 实例化）
- 不引入新 npm 依赖，EventEmitter 用 `node:events`
- Easing 函数 `f(0)===0 && f(1)===1`，`easeOutElastic` 在端点处直接返回 t


## LLM 情感标签格式与解析

- **标签格式**：`[LIVE2D: emotion=X, action=Y, intensity=Z]`，附加在回复
  文本中，最多 3 个标签
- **可用情感**（9 种）：neutral, happy, sad, angry, surprised, thinking,
  shy, smug, excited
- **可用动作**（8 种）：idle, nod, shake_head, wave, lean_forward,
  lean_back, tilt_head, shrug
- **解析容错策略**（`packages/bot/src/avatar/tags/tagParser.ts`）：
  - 用 `key=value` 逐对扫描而非固定位置正则，支持字段乱序
  - key/value 都做 `.toLowerCase()` 归一化
  - 缺失字段填默认值：emotion=neutral, action=idle, intensity=0.5
  - intensity clamp 到 [0, 1]
  - 解析失败静默跳过（无动画 fallback，不抛异常）
- **责任边界**：本模块只产出标签生产 prompt + 解析/剥离纯函数。
  pipeline 集成（在 `onMessageBeforeSend` hook 中 strip 后发送给用户、
  把 parsed tags 接到 Avatar Driver）由后续 ticket 处理


## AvatarService 集成层 (`packages/bot/src/avatar/AvatarService.ts`)

### 子系统连线

- `AvatarService.initialize(config)` 创建 AnimationCompiler / IdleStateMachine / VTSDriver / PreviewServer（无网络 I/O）
- `AvatarService.start()` 连线事件并启动所有子系统：
  - `stateMachine['idle-animation']` → `compiler.enqueue(toStateNodes(nodes))` （idle 待机动画注入 compiler）
  - `compiler['frame']` → `driver.sendFrame(params)` （fire-and-forget）+ `previewServer.broadcastFrame(frame)` （实时预览）
  - driver.connect() 非致命（VTS 未运行不影响 bot 启动）
  - 启动后立即 `transition('idle')` 触发随机待机定时器
- `AvatarService.transition(state: BotState)` 供外部（hook/pipeline）调用，触发状态转换动画

### StateNodeOutput → StateNode 转换

`StateNodeOutput.easing` 是 `string`；`StateNode.easing` 是 `EasingType`。用 `n.easing as StateNode['easing']` 强转，无运行时开销。timestamp 用 `n.timestamp ?? Date.now()`。

### Config wiring 模式

- `BotConfig.avatar?: Record<string, unknown>` — 与 `cluster` 字段同模式
- `Config.getAvatarConfig()` — 直接返回 raw 对象
- bootstrap 里用 deep spread 合并 DEFAULT：
  ```ts
  const avatarConfig: AvatarConfig = {
    enabled: raw.enabled ?? DEFAULT.enabled,
    vts: { ...DEFAULT.vts, ...(raw.vts ?? {}) },
    compiler: { ...DEFAULT.compiler, ...(raw.compiler ?? {}) },
    idle: { ...DEFAULT.idle, ...(raw.idle ?? {}) },
    preview: { ...DEFAULT.preview, ...(raw.preview ?? {}) },
  };
  ```
- avatar 禁用时不注册 `DITokens.AVATAR_SERVICE`，ServiceRegistry 会 warn（预期行为，与 cluster 一致）

### 生命周期

- `initialize()` → bootstrap（无 I/O）
- `start()` → `index.ts`（bot.start() 之后，非致命）
- `stop()` → shutdown handler


## Live2DAvatarPlugin (`packages/bot/src/plugins/plugins/Live2DAvatarPlugin.ts`)

### Hook → BotState 映射表

| Hook | BotState transition |
|------|----|
| `onMessageReceived` | `'listening'` |
| `onAIGenerationStart` | `'thinking'` |
| `onAIGenerationComplete` | log only (parsed tag info) |
| `onMessageBeforeSend` | tag-derived: `happy`/`excited`/`surprised`/`sad`/`angry`/`shy` → `'reacting'`; `thinking` → `'thinking'`; else → `'speaking'` |
| `onMessageSent` | `'speaking'` |
| `onMessageComplete` | `'idle'` |

### Tag 剥离时机
- 在 `onMessageBeforeSend` 里 strip：因为 BeforeSend 拿到的 `context.reply.segments` 是即将真正发出的内容
- 仅当 `context.reply.source === 'ai'` 时 strip（避免改 plugin/command/task 自己塞的 segments）
- 用 `seg.type === 'text' && typeof seg.data?.text === 'string'` 守卫，原地改 `seg.data.text = stripLive2DTags(...)`

### Avatar 禁用容错
- `onInit` 用 `container.isRegistered(DITokens.AVATAR_SERVICE)` 守卫 lazy resolve；未注册时 `this.avatar = null`
- 私有 getter `active = this.enabled && this.avatar?.isActive() === true` 统一所有 hook 入口的快路径返回
- 所有 hook 用 `try/catch` + `logger.warn` 包，绝不向 pipeline 抛错

### PromptAssemblyStage 集成
- Stage 不通过 constructor 拿 AvatarService，避免动 DI 装配。改用 dynamic `await import('@/core/DIContainer')` + `container.isRegistered(DITokens.AVATAR_SERVICE)` 的运行时检查
- 激活时 `promptManager.render('avatar.emotion-system')`（key 来自 `prompts/avatar/emotion-system.txt` 的目录树派生）
- 拼接：`` finalSceneSystemPrompt = `${sceneSystemPrompt}\n\n${avatarPromptFragment}` `` 然后传给 `messageAssembler.buildNormalMessages({ sceneSystem: finalSceneSystemPrompt, ... })`
