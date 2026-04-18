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

## 包结构（T3 抽包后）

```
packages/avatar/src/
├── AvatarService.ts
├── index.ts        # barrel（根入口）
├── types.ts
├── utils/          # 包内自持工具（logger shim / repoRoot 复制），不引用 bot
├── compiler/
├── drivers/
├── preview/        # 含 client/ 静态资产
├── state/
└── tags/
```

## 导出约定
- 第一版只暴露根入口 `@qqbot/avatar`，不配 subpath exports
- barrel 通过具名 re-export 覆盖所有消费点（`export *` 会导致 lint organizeImports 排序，具名更明确）
- 消费方 bot 从 6 处 import（含 PromptAssemblyStage inline type import）统一改为 `@qqbot/avatar`

## 反向依赖禁止
- avatar 不得 `from '@qqbot/bot'` / `from '@/...'`
- logger、repoRoot 已下沉到 `packages/avatar/src/utils/`

## Runtime 资产与默认位置
- 默认 action-map 内置于 `packages/avatar/assets/default-action-map.json`
- `ActionMap` 构造函数未传 `filePath` 时用 `fileURLToPath(new URL(..., import.meta.url))` 定位包内资产，**不依赖** `getRepoRoot()`
- 用户自定义映射通过 `avatar.actionMap.path` 配置（相对仓库根或绝对路径）
- `.vts-token` 默认写到 `data/avatar/.vts-token`（`data/` 已 gitignored，是 runtime state 目录）
- 仓库根 `config/avatar/` 目录已完全删除


## VTS 驱动层的"tracking param only"限制（2026-04-18 实测）

### 核心限制
VTS 的 `InjectParameterDataRequest` **只接受 tracking param**（`FaceAngleX` / `EyeOpenLeft` / `MouthSmile` 等 VTS 内置的、模拟人脸追踪数据的输入端），**不能直接注入 Live2D 模型的 paramId**（`ParamAngleX` 等）。尝试注入会被 VTS 以 errorID 453 拒绝：

> `Parameter ParamAngleX not found. Did you create it yet? Keep in mind, you can't inject data directly for Live2D parameters, only for tracking parameters.`

### 常见 VTS tracking param 清单
- 头: `FaceAngleX` / `FaceAngleY` / `FaceAngleZ`（度，-30~30）
- 身体位移: `FacePositionX` / `FacePositionY` / `FacePositionZ`（-1~1 或 0~1）
- 眼: `EyeOpenLeft` / `EyeOpenRight`（0~1）
- 嘴: `MouthOpen` / `MouthSmile`（0~1）
- 眉: `Brows`（-1~1，**单值**，不分左右）
- 其他: `CheekPuff` / `TongueOut` 等

### VTS tracking → Live2D model 绑定不由我们控制
每个 VTS 模型的 `.vtube.json` config 决定 tracking param → Live2D param 的映射。例：某模型作者把 `FacePositionY` 绑到"腿部步态"而非"身体上下浮动"——我们完全不可控。**想要"语义确定"只能等 Cubism SDK 直渲**，path A 只是能动起来，不保证动对。

### 空 param 包 errorID 450
`parameterValues: []` 被 VTS 拒以 errorID 450 "You have to provide data to inject"。新 compiler 语义（idle 间隙 frame = `{}`）会频繁撞上，`VTSDriver.sendFrame` 必须对空包 early-return。

### 诊断技巧
- 连接成功后发 `InputParameterListRequest`，log 前 15 个 param 名 —— 对比 action-map 用的 param 是否在模型里存在
- `handleMessage` 对**无 pending entry 的 APIError 响应**降级成 warn 日志（sendFrame 是 fire-and-forget，否则错误被静默吞）


## 语义 Channel 层（2026-04-18 架构修正）

### 动机
ActionMap 里直接写 `ParamAngleX` 这种 VTS/Live2D-specific 名字，违反分层。渲染器切换（VTS → Cubism → WebGPU）会要求改大量数据。

### 分层
```
StateNode (action 语义)
    ↓
ActionMap: action → ParamTarget { channel, targetValue, weight }
    ↓ [renderer-agnostic, natural units]
AnimationCompiler: tick / ASR envelope / 混合（key 是 channel 字符串，不关心含义）
    ↓
FrameOutput { params: Record<channel, value> }
    ↓
各 Driver Adapter 各自翻译:
  VTSDriver: channel → VTS tracking param（VTS_CHANNEL_MAP）
  Preview: 直接展示 channel 名
  (未来) CubismRenderer: channel → Live2D ParamXxx
```

### Channel 命名约定
- kebab-case + 点分层级：`head.yaw` / `eye.open.left` / `mouth.smile` / `body.x`
- 值用**目标 renderer 的最自然范围**（省一次 normalize）：
  - 头部旋转: [-30, 30]° 度
  - 眼/嘴开合: [0, 1]
  - 嘴角: [0, 1]（VTS 的 MouthSmile 没 frown 方向）
  - 眉: [-1, 1]
  - 身体位移: [-1, 1]（z 通常 0~1）

### VTS Adapter 翻译表（`packages/avatar/src/drivers/vts-channel-map.ts`）
- 定义 `VTS_CHANNEL_MAP: Record<channel, vtsTrackingParamId>`
- 同 VTS tracking param 被多 channel 命中时取均值（`brow.left` + `brow.right` → `Brows` 平均）
- 无映射的 channel 静默 drop（`arm.*` / `breath` / `eye.smile.*` 等 VTS tracking 层缺失的语义）
- Path A 牺牲：`wave` / `shrug` / `breathe` 等只能近似（用头身位移模拟），表达力回归依赖 path B（`ParameterCreationRequest` 创建自定义 tracking param + 用户手工在 VTS UI 绑模型参数）或 Cubism 直渲

### ParamTarget 字段重命名
`paramId: string` → `channel: string`。types.ts / action-map.ts / AnimationCompiler.ts / default-action-map.json 全改。Compiler 本身对 channel 的含义无知，仅当字符串 key 处理。


## Compiler tick 数学 v2（2026-04-18 重写）

### 旧数学的 decay bug
```ts
const frameParams = { ...currentParams };  // base = current
for (anim of active) {
  delta = (target - base) * eased * weight;
  frameParams[id] = base + delta;
}
// 低通: current += (frame - current) * alpha
```
问题：release 到 eased=0 时 delta=0 → frameParams 不变 → current 永不衰减。param 被驱动过一次就**粘住**，下次同 action 目标相同时更观察不到变化。

### 新数学（现行）
```ts
// 累加所有活动动画的 contribution（不 base-on-current）
const contributions: Record<string, number> = {};
for (anim of active) {
  for (target of anim.targetParams) {
    contributions[target.channel] = (contributions[target.channel] ?? 0)
      + target.targetValue * eased * target.weight;
  }
}
// 低通 current 朝 contribution 收敛
const next = {};
for (id of Object.keys(contributions)) {
  next[id] = (current[id] ?? 0) + (contributions[id] - (current[id] ?? 0)) * alpha;
}
this.currentParams = next;   // ← 关键：没 contribution 的 channel 直接 drop
```

### "drop-on-release" 的语义
- 动画活动期间：channel 有 contribution，param 被 emit 到 frame
- 动画结束 / 无 contribution：channel 从 currentParams 被 drop，frame.params 不包含它
- 下游（VTS / Preview）看到 param 消失 → 对 VTS 来说相当于"我不再控制这个 param"，VTS 自己的 idle / physics / face tracking 接管 natural behavior
- Preview 只显示**当前正在被主动驱动的 param**（可读性极好）

### 副作用
- VTSDriver 必须处理空 frame（parameterValues=[]）的 early-return
- Preview 客户端渲染要允许 params 对象随时为空


## AvatarService status broadcast 与 tag enqueue（2026-04-18）

### Status 广播定时器
- 1s 周期：`stateMachine.currentState` + `compiler.getActiveAnimationCount()` + `compiler.getQueueLength()` + frame-count-derived `measuredFps`（window=1s），调 `PreviewServer.updateStatus()`
- 原 `updateStatus` 方法在 S1 (preview-server) 定义但无人调，属于"死代码"，本次补齐

### tag → animation 入队
- Plugin 之前只做 `parseLive2DTags → log + transition(state)`，**丢弃 action 字段**
- `AvatarService.enqueueTagAnimation(tag)` 新方法：tag → StateNode（duration 用 `compiler.getActionDuration(action) ?? 1500`，easing `easeInOutCubic`） → `compiler.enqueue([node])`
- Plugin 的 `onMessageBeforeSend` 在 transition 后额外调此方法

### Compiler 暴露的 getter
- `getActiveAnimationCount()` / `getQueueLength()` / `getActionDuration(action)`
- 都是"给 AvatarService 编排用"的只读 accessor，不参与 tick 主路径


## Live2DAvatarPlugin 私聊 gate（2026-04-18）

### Gate 方法
所有 6 个 hook 入口统一 `if (!this.active || !this.isPrivate(context)) return true;`
`isPrivate(ctx) => ctx.message?.messageType === 'private'`

### 动机
直播 / 群聊场景下，bot 处理大量群消息；每条都触发 transition('listening' → ...) 的话，观众看到 avatar 为所有群闲聊频繁抽搐。私聊 gate 让 avatar 只反映"用户在跟 bot 对话"的情境，群消息照常处理但 avatar 不动。

### 未来扩展位
如果要允许"@ 机器人才算交互"的群消息也动 avatar，gate 逻辑加个 "is this message directed at bot" 判断即可；不改调用位置。


## PreviewServer WS upgrade 路由陷阱（2026-04-18 修复）

`Bun.serve` 的 `fetch(req, srv)` 里，WebSocket upgrade 请求的 `pathname` 也是 `/`（和加载 HTML 页面的请求同路径）。错误写法：
```ts
if (pathname === '/') return htmlResponse;  // ← upgrade 请求被吃掉
srv.upgrade(req);  // 永远执行不到
```
正确写法：**先无条件试 upgrade**，返回 undefined 表示已 upgrade，否则走 HTTP 路由：
```ts
if (srv.upgrade(req, { data: undefined })) return undefined;
if (pathname === '/') return htmlResponse;
```

## Preview 客户端 reconnect 双连接 bug（2026-04-18 修复）

客户端 `connect()` 若直接 `ws = new WebSocket(...)` 覆盖旧引用，旧 ws 在 CLOSING / CONNECTING 状态下不会被回收，服务端 `clients` Set 累积多条同源连接。正确写法：**新建前 detach 旧 handlers + close + null 化引用**：
```ts
function connect() {
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch {}
    ws = null;
  }
  ws = new WebSocket(...);
}
```


## 验证 gate 的教训（2026-04-18）

S1-S11 的 avatar tickets 全部通过 `typecheck + lint + smoke-test`，但用户第一次 `avatar.enabled=true` 跑就暴露 7 个集成 bug：preview 显示 disconnected、idle 动画 action 名不存在、LLM tag 从不入队 compiler、status 永不 broadcast、compiler decay bug、VTS 拒收 Live2D paramId、私聊 / 群聊没分。

**根因**：smoke-test 默认跑 `enabled=false` bootstrap，完全没 exercise avatar 运行时代码路径；ticket 验证只保证"静态正确"，没人验证整条链路跑通。

**应对**：avatar / IO-heavy feature 的 ticket 接受标准，**必须包含 `enabled=true` 手工 smoke**，至少验证：
- 每个 public 方法至少被一个调用路径覆盖
- 所有 event emitter 的 emit / on 名字一致
- 所有配置里引用的字符串 key（action 名、param 名）在被引用处实际存在
- Preview 页能看到参数在动，不是永远 Disconnected

单元验收 ≠ 集成正确。


## AmbientDriver vs StateNode action 分层 (2026-04-19)

### 两类 contribution source
- **StateNode action (discrete)**: ADSR 包络、有限持续时间、intensity 脉冲。
  由 IdleStateMachine 或 LLM 回复触发。用于 blink / smile / nod 等表情动作。
- **AmbientDriver (continuous)**: 永久注册、每 tick 贡献正弦值。用于提供
  "底色"motion（呼吸、身体微侧倾），保证 frame 永不空。

两者每 tick `additively mix`（同 channel 相加），再 smoothing → emit。

### Gate 语义
AmbientDriver.gate(BotState) 返回 0..1 全局幅度系数：
- idle: 1.0
- listening: 0.8
- thinking: 0.5
- speaking: 0.3 (LLM action 应占主导)
- reacting: 0.4

gate 返回 0 时该 driver 全通道跳过（contribution 不加）。

### Baseline-breath 对标 Cubism 4 native
幅度对标 pixi-live2d-display Cubism4 原生 breath（ParamAngleX=15/6.5s 等），
但不乘 weight=0.5（Cubism native 是与其他 layer mix 才乘）。Driver 用
semantic channel（head.yaw 度数、body.x 归一化），VTSDriver 的 channel→VTS
映射照旧，无需感知 driver 存在。

### opt-in 设计
`compiler.ambientDrivers.enabled` 默认 false，保证既有部署升级后行为不变。
纯 Cubism preview 场景手动开启。

### 实现要点
- `sampleDriver(driver, channel, nowMs, state)` 用 `Date.now()` 做时间源（不是 `performance.now()`），保证确定性
- `phase` 参数做散布（spread），不用 RNG
- Driver contributions 在 action contributions **之前**先写入 `contributions` map（顺序无关，两者 additively mix）
- `CompilerConfig.ambientDrivers?: { enabled: boolean }` — optional，default `enabled: false`
- `AnimationCompiler` 有 `registerDriver`/`unregisterDriver`/`setGateState` 三个公开方法
- `AvatarService.start()` 在 `compiler.start()` 后 guard-register DEFAULT_AMBIENT_DRIVERS
- `AvatarService.transition()` 里 `this.compiler.setGateState(state)` 与 `stateMachine.transition(state)` 并列调用
- bootstrap.ts 对 `ambientDrivers` 做 nested spread merge：`{ ...DEFAULT.compiler.ambientDrivers, ...raw.compiler.ambientDrivers }`
