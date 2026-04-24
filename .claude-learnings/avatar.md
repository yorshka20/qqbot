# Avatar

本地速查。覆盖 `@qqbot/avatar` 包、`packages/bot/src/services/live2d/*` pipeline、
以及配套 renderer（独立仓库 `qqbot-avatar-renderer`）。

## 设计基座 —— AI 写剧本，本地代码导演

LLM 只产出**语义标签**（情感 / 动作 / 视线 / 节奏），不产 30Hz 参数流。
`AnimationCompiler` 在本地把标签编译成多通道参数流，通过 WS 广播给
driver 层（VTS 或自研 renderer）。延迟吸收在编译阶段（ease-in、crossfade、
baseline 驻留），所以 LLM 推理抖动不外泄到动画。

完整方案见 `docs/local/live2d_compiler_plan.md`。

## 包分工

| 位置 | 作用 |
|------|------|
| `packages/avatar/` | 独立 npm workspace `@qqbot/avatar`。**不 import bot 代码**。编排器 `AvatarService`、`AnimationCompiler`、layer 栈、`PreviewServer`、driver 适配、`SpeechService`、tag parser、channel registry 都在这里 |
| `packages/bot/src/services/live2d/` | 5-stage `Live2DPipeline`：Gate → PromptAssembly → LLM → TagAnimation → Speak，各 stage 独立 `@injectable`。把 bot 生命周期事件映射到 `AvatarService.setActivity` / `enqueueTagAnimation` |
| `packages/bot/src/plugins/plugins/Live2DAvatarPlugin.ts` | 6 个 hook 的薄桥，`isPrivate()` gate，strip tag |
| `packages/bot/src/command/handlers/AvatarCommandHandler.ts` | `/avatar <text>` 走独立 LLM + `prompts/avatar/speak-system.txt`，bypass card-render |
| `qqbot-avatar-renderer` (另一个仓库) | Cubism + VRM renderer，WS client，HUD 面板，ambient-audio 采集 |
| `tools/vrma-to-clip/` | 独立 bun 包（不在 workspaces），离线 `.vrma` → `IdleClip` JSON 转换 |

## AvatarService 编排

`AvatarService` 是总线：初始化 `AnimationCompiler` + `LayerManager` + `ActivityTracker`
+ 可选 `VTSDriver` + 可选 `PreviewServer` + 可选 `SpeechService`。暴露：

- `setActivity({pose?, ambientGain?})` —— 部分更新，两轴正交
- `enqueueTagAnimation({action, emotion, intensity})` —— 主入口
- `enqueueEmotion(name, intensity)` —— 表情驻留（靠 channelBaseline）
- `setGazeTarget(target | null)` —— 覆盖 `EyeGazeLayer`
- `speak(text)` —— 下发 TTS 并注册 `AudioEnvelopeLayer` ephemeral
- `hasConsumer()` —— 消费端（VTS connected OR preview ws count>0）

**Consumer gating**：`AnimationCompiler.tick` 只在存在下游消费者时运行。没人消费
就暂停，避免空转 CPU。Preview client 0↔1 切换和 VTS connect/disconnect 都会触发
pause/resume。

## Activity 模型

替换早期 `BotState` 字符串枚举。现在是 `AvatarActivity = {pose, ambientGain}`：

- `pose`: `idle | listening | thinking | speaking | reacting`
- `ambientGain`: 0..1，由 plugin hook 推送，层栈用来做全局能量门控

三件正交事：**全局 gain** / **idle gate** / **pose 动画**。`IdleMotionLayer`
从旧"`state === 'idle'`"改成派生式 `pose === 'neutral' && gain >= 1`。
Plugin 用 `AMBIENT` 常量表达两轴，不写死状态枚举。

## AnimationCompiler —— 两条 action 路径

- **`kind: 'envelope'`** —— 旧 ADSR 路径。`ParamTarget[]` 参数列表，
  `defaultDuration` 决定基础时长，支持：
  - `endPose?: {channel, value, weight}[]` —— release 后的视觉落点；
    value 不被 intensity 缩放（绝对位）
  - `holdMs?` —— peak 后驻留时间
  - `accompaniment?: ParamTarget[]` —— 附带通道（不进 endPose）
  - `variants` —— `params` 为数组时 `resolveAction` 随机选一条
  - `leadMs`/`lagMs` per-target —— 二次运动的 phase shift，clamp ±1000ms
- **`kind: 'clip'`** —— 预加载 `IdleClip` JSON 路径。`ActionMap` 构造时
  同步 `readFileSync`，坏文件 drop。tick 里按 elapsed seconds 调共享
  `compiler/clips/sampleClip.ts` 多通道采样，包一层短 attack/release
  envelope 以接合 crossfade / baseline。

`ActiveAnimation` 是 discriminated union，`PreviewStatus.activeAnimationDetails[].kind`
反映本动画走哪条路径。

### Envelope / Baseline / Crossfade 三件套（2026-04-21 [A 1/3]）

- **channelBaseline**: 每次动画 harvest 时把 settled 值写入 baseline map，
  同时 snap spring state 到 settled 值（防"回追目标"闪烁）。每 tick 先指数
  衰减（`baselineHalfLifeMs`，默认 45s），再 harvest，避免双计数
- **crossfade**: 新动画进入时扫 `activeAnimations`，channel 冲突的旧动画
  打 `fadeOutStartMs`，旧 * `(1-fp)` + 新 * `fp`，无 pop
  （`crossfadeMs` 可调）
- **endPose**: release 阶段 peak → settled 单调插值，抑制 oscillate 残项
- tunable section `compiler:envelope` 暴露 `crossfadeMs` / `baselineHalfLifeMs`

### Jitter / Variants / Accompaniment（[A 2/3]）

- `CompilerConfig.jitter = {duration?, intensity?, intensityFloor?}`，
  `enqueueTagAnimation` 里应用，使同动作重放不 bit-identical
- tunable section `compiler:jitter` 暴露 3 个参数
- 不改 leadMs/lagMs 缺省路径：`effStart===anim.startTime` / `effEnd===anim.endTime`
  保证既有行为 bit-exact

### 消失的 `smoothingFactor`

弹簧阻尼替代单极低通后，`smoothingFactor` 完全不用，构造参数依然接受但忽略。
真正的平滑走 `compiler:spring-damper` tunable section 的 `(omega, zeta)` 参数，
支持 `springOverrides: Map<channel, Partial<SpringParams>>` 单通道覆盖。

## Layer 栈

`LayerManager` 按配置顺序 sample + 加法混合，参与 compiler tick 一起进入弹簧。
默认 6 层（`createDefaultLayers()`）：

1. **BreathLayer** —— 多谐波呼吸，4 通道（模拟 Cubism SDK native breath）
2. **AutoBlinkLayer** —— 4 阶段 always-emit
3. **EyeGazeLayer** —— OU 随机游走 + saccade，dt clamp ≤100ms。
   支持 `setGazeTarget({x,y} | 'camera'/'left'/... | null)` 覆盖模式；
   覆盖时直接 emit 常量 override，spring-damper 做过渡
4. **IdleMotionLayer** —— 简化 keyframe clip，`pose==='neutral' && gain>=1` 触发
5. **PerlinNoiseLayer** —— 手写 1D Perlin（fade 6t⁵-15t⁴+10t³、per-channel
   512-entry permutation、mulberry32 确定性种子），5 通道 weight 0.2 最末混入。
   **2026-04-23 起带 activity envelope**（慢 perlin × motion perlin）——详见下方
   "PerlinNoiseLayer activity envelope" 章节
6. **AmbientAudioLayer** —— 长生命，消费 renderer `ambient-audio` WS
   (`{rms,tMs}` ~30Hz)，silenceFloor(0.05)→normalize→x²→写 `body.z`
   (max 0.2) / `brow` (max 0.15)；500ms staleness gate 让 renderer 掉线后
   自然 fade

**AudioEnvelopeLayer** —— per-utterance ephemeral（不在默认栈）。
`SpeechService.drain()` 时 ffmpeg 主路径 + `audio-decode@3.9.3` fallback 解码，
`computeRmsEnvelope` 产 envelope，`registerLayer`→setTimeout→`unregisterLayer`。
恒出 `mouth.open`；`excite` 超阈值才额外驱动 `body.z` / `eye.open.*` / `brow`
（避免静音期写入眨眼/眉毛）。

## Channels

两套注册中心并存：

- **Cubism** `channels/registry.ts` —— `head.* / body.* / mouth.* / eye.* / brow` 等语义通道。
  每条记录 `cubismParam` 必填，可选 `alias`；driver 层（如 VTSDriver）按映射翻译
- **VRM** `channels/vrm-registry.ts` —— ~60 个 humanoid bone × 3 轴 + `vrm.expression.*`
  + `vrm.root.{x,z,rotY}` 根通道

VTS driver 限制：`InjectParameterData` 只收 tracking param。架构层通过"语义 channel"
抽象（`head.yaw`/`mouth.smile`）+ `VTS_CHANNEL_MAP`（现 `drivers/VTSDriver.ts` 内置）
翻译；compiler tick 数学重写，动画结束 param 从 emit drop，VTS 自然接管。

Renderer 侧的 cross-model 通过 `buildChannelMap(overrides)` + per-model
`/assets/models/<slug>/channel-map.json` 覆盖解决；`alsoWrite` fan-out 替代硬编码。

## Tag 语法（parser 在 `packages/avatar/src/tags/`）

- **Legacy**：`[LIVE2D: action=X, emotion=Y, intensity=Z]` —— 字段乱序容错，
  未知字段静默跳过
- **Rich（[A 3/3] 2026-04-21 引入）**：四个正交 slot
  - `[A:name@0.8]` —— action（intensity 可省，默认 1.0）
  - `[E:happy@0.6]` —— emotion，经 `channelBaseline` **持续到下一个 E 覆盖**
  - `[G:camera|left|right|up|down|center|clear|x,y]` —— gaze
  - `[H:brief|short|long]` —— 给下一条 [A:] 的 duration 缩放（0.5/0.8/1.4）

`parseRichTags(text)` 产 discriminated `ParsedTag[]`；legacy parser 变 shim，
内部调 rich parser。Legacy 的 `emotion=happy` 自动派生独立 `{kind:'emotion'}` tag
（`compiler.legacyEmotionPersist` 控制，默认开）。

`TagAnimationStage` 按 `kind` 分派：action→`enqueueTagAnimation`、
emotion→`enqueueEmotion`、gaze→`setGazeTarget`、hold→ctx-local 累计 wait for 下一条 action。

Prompt 层：`prompts/avatar/partials/tag-spec.txt` 作为 partial 被
`speak-system.txt` / `emotion-system.txt` / `bilibili-batch-system.txt` 通过
`{{tagSpec}}` include；改文本即全链路生效。

**动态 action 注入**：LLM prompt 里 `{{availableActions}}` 占位符由
`formatActionsForPrompt(avatar.listActions())` 按 category（emotion / movement / micro）
分组填入；action-map 改动自动同步到 prompt。

## PreviewServer

Bun.serve，`0.0.0.0:8002`（LAN 可见）。HTTP routes：

- `/` —— HTML
- `/health`
- `/action-map` —— action 列表 + category
- `/clip/:name` —— debug，按 ASCII 名返回 clip JSON

WS 双向。Outbound `frame` / `status`；`status` 带 `pose / ambientGain /
channelBaseline? / activeAnimationDetails?`。Inbound 消息：
`trigger`（测试动画入队）、`speak`（debug 绕过 LLM 直接 TTS）、
`ambient-audio`（renderer RMS 喂 AmbientAudioLayer）、
`tunable-params-request` / `tunable-param-set`。

HUD 侧 `SpeakDebugPanel`（TextArea + Cmd/Ctrl+Enter）、字幕 `SpeakToast`
底部居中固定（隐藏 bubble 模式仍渲染）。

## SpeechService + TTS

`TTSManager` 管多 provider（FishAudio / Sovits…），`bootstrap.ts` 从
`config.tts = {defaultProvider, providers:[...]}`（带 legacy `{apiKey}` shim）
构造，注册进 DI (`DITokens.TTS_MANAGER`)。
`/tts --provider X` 命令按 provider 展示 voices。

`AvatarService.speak(text)`：合成 → `SpeechService.drain()` 解码 → 注册
`AudioEnvelopeLayer` → broadcast `AudioMessage`（带 `text` 字段驱动 renderer toast）→
timeout 后 `unregisterLayer`。**Plugin.onMessageBeforeSend 不再自动 speak**
（避免 CardRenderingService 把长回复渲染成图）；`/avatar` 命令走独立短 LLM。

**两条消费通路对 provider 的要求不同**，provider 按调用入口自己处理（详见本文末
"SovitsProvider：streaming 字段归 provider 管" 一节）：
- `/tts` 命令（Milky `record` 段）→ `provider.synthesize()` → 必须完整 WAV
- renderer / Live2D（`drainOneStreaming`）→ `provider.synthesizeStream()` → 分块 raw PCM

`config.d/tts.jsonc` 的 `bodyTemplate` 只写稳定合成参数（`text_lang` / `ref_audio_path`
/ `prompt_text`），不要写 `streaming_mode` / `media_type`——provider 会覆盖。

## Tunable Params

统一 WS 契约：`TunableParam` / `TunableSection` + 3 种 msg（
`tunable-params-request` / `tunable-params` / `tunable-param-set`）。

- Layer 实现 optional `getTunableParams()` / `setTunableParam(key, value)`
- `AudioEnvelopeLayer` 走共享 singleton `audio-envelope-config.ts`
  （避免 per-utterance 实例化时丢配置，mid-utterance 改值立即生效）
- `AnimationCompiler.listTunableParams()` 聚合所有 layer + 自身（envelope /
  jitter / spring-damper）section
- Spring overrides 用 `Map<channel, Partial<SpringParams>>`，per-channel 热调

## 关键 Invariants / 坑

- **Avatar 代码不 import bot 代码**，抽包时用 `node:events`、logger shim，
  `tsc project references` + path alias 做类型边界
- **VTS 限制**：只接受 tracking param，自研语义 channel → VTS_CHANNEL_MAP 翻译；
  动画结束后 compiler drop emit，VTS 自然接管
- **Bilibili 连接不归属 avatar**，但走同 pipeline stage（`bilibili-batch-system`
  prompt），注意 `auth platform='danmuji'` / `buvid3` / 匿名 WS（见 `bilibili.md`）
- **Envelope/clip crossfade 对等语义**：clip 动画 enqueue 时同样会给冲突 channel
  的旧 active animation 打 `fadeOutStartMs`，双向线性过渡
- **endPose.value 不乘 intensity**：它是视觉落点，要绝对位；`params[].value` 才被
  intensity 缩放
- **`AutoBlinkLayer` always-emit**：即便 `mouth.open` 被 envelope 覆盖，blink 4 阶段
  也稳定输出，避免从 audio excite 回落时眼睛"卡住"
- **dt clamp in EyeGazeLayer**：长 stall（浏览器后台 tab / compiler pause）恢复
  时 OU 不应"跳一大步"，dt 上限 100ms
- **LipSync per-utterance ephemeral**：AudioEnvelopeLayer 每次说话都是新实例，
  `SpeechService` 负责生命周期；不要把它塞默认栈

## WalkingLayer MVP notes

- `WalkingLayer.walkTo()` 会在新请求或 `stop()` 时中断旧请求，并拒绝旧的 pending promise。
- 事件回调使用 Node `EventEmitter`，所以 `onStartWalk` / `onWalking` / `onArrive` 都是同步注册、异步触发。
- 这个 MVP 不做自动回到原点；位置由最后一次 walk / stop 保持，`getPosition()` 反映当前快照。
- renderer 端 root channels 是 sticky 的，所以 idle 时返回 `{}` 让最后一帧继续保留。

## Idle loop clip = rest pose（2026-04-22）

设计大清理：**去掉 `CompilerConfig.restPose` + `DEFAULT_VRM_REST_POSE`**，loop clip
是 VRM idle 姿态的唯一来源。同时 `IdleMotionLayer` loop 模式改 **freeze-on-gate-exit**。

### 为什么去掉 restPose

restPose 原本是"channel 没人写就填静态值"（override 语义），用来把 T-pose
纠正成 A-pose。但它和 loop clip 在同一语义层（绝对姿态），区别只是"静态 vs 循环"。
当 loop clip 不是 A-pose 风格（比如 peace_sign）时：

- idle 状态下，loop clip 驱动 channel，restPose 被 override 跳过 ✅
- 非 idle 状态（listening/thinking/speaking，`ambientGain<1`），`isTrulyIdle` gate 关闭，
  `IdleMotionLayer` 返回 `{}`，restPose 趁机把手拽回 A-pose ❌

结论：静态 pose 不适合当循环的"gate-off 兜底"。正确做法是 loop clip 自己负责
gate-off 时的视觉连续。

### freeze-on-gate-exit / resume-from-frozen-frame 语义

`IdleMotionLayer` 新增两个字段：

- `loopStartMs`：当前 loop cycle 的 t=0 对应 wallclock
- `frozenElapsedSec`：每个 idle tick 结束写入当前 `elapsedSec`

gate 关闭（`!isTrulyIdle`）：layer 继续 emit，用 `frozenElapsedSec` 作采样时间
（冻结帧），不推进。gate 重开：`loopStartMs = nowMs - frozenElapsedSec * 1000`，
从冻结帧继续往前走，无跳变。

gap mode 不做冻结（短 one-shot 冻结无意义），沿用"gate off 返回 `{}`"。

### 关键代码

- `packages/avatar/src/compiler/layers/IdleMotionLayer.ts` —— loop 分支的 freeze logic
- **`rest-pose.ts` / `rest-pose.test.ts` 已删除**，`CompilerConfig.restPose` 字段也删了

## Layer 路径 quat 输出（2026-04-22）

### 为什么需要

Peace_sign（VRMA_03）的 V-sign 动作**不在 upper arm scalar 轨道里**，真正的 raise
在 `vrm.rightLowerArm` quat 轨道（肘部 30° → 145°）。但原本 `IdleMotionLayer.sample()`
只 return `sampled.scalar`，`LayerManager` 也没 quat 聚合通道 —— 只有
`activeAnimations`（discrete 入队动画）路径会走 quat emission。

效果：peace_sign 循环在跑，但 elbow 一直是 identity，视觉上等同于 "A-pose 不动"，
导致用户以为 loop clip 没生效。

### AnimationLayer 接口

新增 optional 方法：

```ts
sampleQuat?(
  nowMs: number,
  activity: AvatarActivity,
  activeChannels?: ReadonlySet<string>,
): Record<string, {x:number; y:number; z:number; w:number}>;
```

键是 bone 基通道（如 `vrm.rightLowerArm`），值是单位四元数。

### LayerManager.sample 返回 `LayerFrame {scalar, quat}`

- **scalar**：老路径 —— `weight * ambientGain` scale，additively merged
- **quat**：新路径 —— **不乘 weight，不乘 ambientGain**，last-writer-wins
- 设计理由：`0.3 ×` 四元数不是"0.3 倍强度"，而是"slerp 向 identity 走 30%"，
  是不同姿态而非变暗的同姿态。绝对姿态层不该被 gate 调制

### IdleMotionLayer 的 per-tick cache

因为 `sample()` 和 `sampleQuat()` 是 LayerManager 在同一 tick 先后调用的，
而 state 前进（`wasIdle` / `loopStartMs` / `frozenElapsedSec` / `active`）每 tick 只能
发生一次 —— 所以把核心逻辑提成私有 `advanceAndSample(nowMs, activity)`：

1. `sample()` 调一次 `advanceAndSample`，缓存 `{nowMs, scalar, quat}`
2. `sampleQuat()` 只读缓存（`nowMs` mismatch 返空，不再推进）

`filterActiveChannels` 泛化成 `<V>`，两个路径都用。

### AnimationCompiler 消费 LayerFrame

第 4b 步从 `layerFrame.scalar` 取 contributions，然后把 `layerFrame.quat` 展开：

```ts
for (const [bone, q] of Object.entries(layerFrame.quat)) {
  contributions[`${bone}.qx`] = q.x;
  // ... qy / qz / qw
  this.quatFrameChannels.add(`${bone}.qx`);
  // ... 四个轴
}
```

和 discrete clip 路径同样绕过 spring-damper、channelBaseline。没有 slerpWithIdentity
缩放（`k=1`），因为 quat 路径本来就不被 ambientGain gate。

## Root channel contract（2026-04-22）

**clip 层不驱动 `vrm.root.*`**，`WalkingLayer` 独占。强制点在 `sampleClip` 内部：
遍历 tracks 时 `startsWith('vrm.root.')` 的轨道直接跳过，不进 scalar / quat 输出。

### 为什么

所有仓库里的 VRMA 文件（`VRMA_01..07` + `001..008_*`）的 `vrm.root.x / z / rotY`
都烘焙了非零值，纯粹是 AuthoringTool 的导出产物，不是有意位移。比如：

- `002_dogeza`: `root.x = -0.152` 常量，`rotY` 峰值 **2.58 rad ≈ 147°**
- `005_smartphone`: `root.x = -0.299` 常量
- `008_gatan`: `root.x = -0.487` 常量

以前直接 apply 这些值 → 动作触发时角色被甩到奇怪位置，release 段 envelope 再 ramp 回 0 造成"归位"假象。

### 合约放在 sampleClip 而不是调用点

统一在采样器里过滤，保证任何 clip 消费路径（当前：`IdleMotionLayer` 和
`AnimationCompiler` discrete 路径）自动遵守，未来加新 clip 消费者也不用操心。
`WalkingLayer` 不走 sampleClip，自己发 `vrm.root.*`，不受影响。

## sampleClip scalar 二分搜索（2026-04-22）

Peace_sign 有 117 scalar tracks × 351 keyframes = 41k keyframes。原先每 tick 每 track
线性扫到正确区间（`while (i < n-1 && kfs[i+1].time < t) i++`），30Hz 下 ~600k
比较/sec。quat 分支早就是二分，scalar 漏了。

改成二分：`lo=0, hi=n-1, while (hi-lo > 1) { mid=(lo+hi)>>1; ... }`。
形状和 `sampleClip` quat 分支一致，不改语义（同样是 `lo <= t < hi`）。

## channelBaseline 半衰期 3s（2026-04-22）

原默认 45s，来自没有绝对姿态 idle layer 的旧设计（那时 endPose baseline 就是
"下一次重置前的默认姿态"）。现在 loop clip 拥有 resting pose，envelope endPose
只需要短暂 linger 一次过渡就交回 clip —— 3s ≈ 一次对话轮次，既保留 gesture 余势
又快速让 channel 给 idle。

tunable slider range 保留 [1000, 120000]，只改默认值。

## IdleClip v2：kind:'quat' 轨道（2026-04-21 [B]）

### 为什么需要

Euler XYZ 分解在旋转幅度 > π/2 时不单射，会产生折叠/翻转（`vrm.hips.y` 在俯身/舞蹈时
出现跳变）。解决方案：超过阈值的 bone 直接存四元数。

### 转换器启发式（`tools/vrma-to-clip`）

```
maxAngle = max over sampled 30Hz frames of (2 × acos(|w|))
if maxAngle > π/2  →  emit {kind:'quat', channel:'vrm.<bone>', keyframes:[{time,x,y,z,w}]}
else               →  decompose Euler XYZ + filterStatic（旧路径）
```

Float32 坑：GLB binary 存 Float32，`sin(π/4)` 解码后略小于真值，使 `2*acos(decoded) > π/2`。
合成测试 fixture 需用 `Math.PI/2 - 0.05` 确保幅度安全低于阈值。

### compiler 侧 quat 轨道合约

1. `sampleClip()` 返回 `SampledClipFrame {scalar, quat}` — quat tracks 内联 `slerpQuat()` 相邻帧插值（无 THREE 依赖）
2. `AnimationCompiler` 对 quat 贡献做 **slerp-with-identity**：`q_out = slerp(identity, q_clip, k)`（`k = clamp(intensity×envelope×fade, 0, 1)`）
3. 发射 **`vrm.<bone>.qx/.qy/.qz/.qw`** 四个标量通道（renderer 按名读出拼 quaternion）
4. **绕过 spring-damper**：quat 输出通道直接进 `currentParams`，不创建 spring state
5. **绕过 channelBaseline**：quat 通道不参与 baseline 加法步骤
6. **自动消失**：若该 tick 无 quat clip 贡献，通道从 `currentParams` 消失（不 sticky）
7. **endPose guard**：`/\.q[xyzw]$/` 通道在 endPose harvest 时 warn + skip

`quatFrameChannels: Set<string>` 每 tick 开始清空，用于标记哪些通道是当前 tick 的 quat 贡献。

### 资产

所有 `packages/avatar/assets/clips/vrm/VRMA_0{1..7}.json` 均已用新转换器重新生成，
包含 `"kind": "quat"` 轨道（全部 7 个文件均有 quat tracks）。

Schema 参考：`packages/avatar/docs/clip-schema.md`。

## Model-Aware Handshake（2026-04-22 [C]）

### hello 握手契约

Renderer → bot，WS open 时（或 model hot-swap 后）发送：

```jsonc
{ "type": "hello", "modelKind": "cubism" | "vrm" | null, "protocolVersion": 1 }
```

- `null` = renderer 已连接但未加载模型
- 老 renderer 不发 `hello` → `currentModelKind` 保持 `null` → 完全后向兼容（不过滤）

### last-hello-wins 语义

`AnimationCompiler.currentModelKind` 是**单一全局值**。每次收到合法 `hello`
就覆写，没有 per-client 状态。实践中同时只有一个 renderer 连接。

链路：`PreviewServer.message({ type:'hello' })` → `handlers.onModelKindChange(kind)`
→ `AvatarService.onModelKindChange` → `compiler.setCurrentModelKind(kind)`。

### AnimationLayer.modelSupport

```ts
readonly modelSupport?: readonly ModelKind[];
```

- 缺省（`undefined`）= 两种模型都兼容
- 当 `modelKind` 非 null，`LayerManager.sample()` 跳过 `modelSupport` 不包含该 kind 的层
  （scalar 和 quat 都跳过）
- 当 `modelKind` 为 null，不过滤

### ActionMapEntry.modelSupport

```jsonc
"modelSupport": "cubism" | "vrm" | "both"  // 缺省 = 'both'
```

- `ActionMap.resolveAction()` 和 `listActions()` 均按 `currentModelKind` 过滤
- `modelKind = null` 时所有 entry 都通过
- `/action-map` HTTP 返回的 list 因此也随 renderer 连接状态自动 narrow

### restPose 字段已删除（ticket §D superseded）

`CompilerConfig.restPose` 在 2026-04-22 idle-loop-as-rest-pose 重构中删除，
**不能重新引入**。理由：restPose（静态绝对姿态）和 loop clip（循环绝对姿态）
语义层相同，gate 关闭时 restPose 会抢占 loop clip 正在驱动的 channel，
造成"手被拉回 A-pose"。正确方案是 `compiler.idle.loopClipActionName`
（freeze-on-gate-exit 语义）作为 idle 姿态唯一来源。

## Action modelSupport 过滤：channel-based 自动推导（2026-04-22 patch）

### 现状（两条规则并存）

1. **显式 `modelSupport`** 始终优先：`'cubism' | 'vrm' | 'both'`
2. **缺省时自动推导**：`isEntryCompatible` 会扫 entry 的 channel 集：
   - 任一 channel 以 `vrm.` 开头 → auto-derive **vrm-only**
   - 否则 → auto-derive **both**（head.\* / body.\* / eye.\* / brow / mouth.\* 走 renderer channel-map 跨模型映射）
   - clip-kind 的 channel 集取 `clipsByName` 里该 action 预加载 clip 的 `track.channel` 汇总

### 什么时候仍要保留显式 `modelSupport: 'cubism'`

**运行时"层冲突"而非"渲染不兼容"**。典型例子：
`wave / raise_hand / shrug / cross_arms / hand_on_hip / point_forward` 使用
`arm.left` / `arm.right`，在 VRM renderer 上会别名到 `vrm.leftUpperArm.z` / `vrm.rightUpperArm.z`，
**这正是当前 VRM idle loop clip（peace_sign / 类似）scalar 写绝对值的骨骼**
→ last-writer-wins → 动作结束后上臂回 T-pose。

此类 action 仍要显式标 `modelSupport: 'cubism'`。注释写在 `action-map.ts`
`deriveFromChannels` 上方，default-action-map.json 无法带注释（走 JSON.parse）。

### TODO-C（暂缓，别忘了）：动态 conflict set

理想解：**IdleMotionLayer 运行时汇报自己占用的 channel 集，ActionMap 用该集过滤 action**。
这样换 idle clip（比如从 peace_sign 切到 greet 或 custom pose clip）不用手工改 JSON —
被占的骨骼集自动变，action 过滤自动跟随。

实现草图：

1. `IdleMotionLayer.getOccupiedChannels()` 扫 `loopClip.tracks[*].channel` 返回 Set
   （quat track 返回基 channel，scalar track 返回本体 channel）
2. channel-map 反查：Cubism alias 映射到 VRM channel 的逆表（`arm.left` → `vrm.leftUpperArm.z`）
3. `ActionMap.setRuntimeConflictSet(occupied: Set<string>)` 把占用集和反查合并存一份
4. `isEntryCompatible` 在 `modelKind==='vrm'` 时，除了走 vrm-prefix 推导，还把
   entry channel ∩ conflictSet 视为不兼容（等价于当前 arm.\* 的手工标记）

触发条件：
- 用户开始频繁切 idle clip，或
- 新增 absolute-pose layer（除 IdleMotionLayer 外）也要占 channel

没到这个场景前**不要做**，因为引入"运行时衍生数据影响 action 过滤"会让"为什么这个
action 在这个模型下不可见"的调试变复杂。

### 其他已在代码里打的 TODO

- `IdleMotionLayer.ts` freeze-on-gate-exit 路径：`sampleClip(loopClip, frozenElapsedSec)`
  在 gate-off 期间每 tick 都跑但输入不变，可缓存。暂缓（没性能问题，引入缓存会干扰
  freeze/resume 的边界 bug 定位）。
- `PreviewServer.ts` hello handler：未来可扩 `modelSlug` / `capabilities`，
  `protocolVersion` 先维持 1。

## WalkingLayer walk-cycle clip（2026-04-22 [Walk 2/2]）

### 播放速率跟踪实际步速，不盲目用配置速度

`rateFactor = clamp(actualStepMps / authoredSpeedMps, 0.2, 2.0)` 其中
`actualStepMps = step / dtSec`（本 tick 实际走的距离 / 时间）。用实际速度而非
`config.speedMps` 的原因：匀速走时两者相同，但靠近目标的最后一步 `step` 会被
`Math.min(speedMps * dtSec, dist)` 截短，实际速度低于配置速度；若还用配置速度
推进 clip timeline，脚步会比实际位移快，产生"迈步不落地"感。

clamp 下界 0.2 防止极慢收尾时 clip 几乎冻结；上界 2.0 防止 dt 过小（精度损失）
时 clip 飞速推进。

### walk clip 的 root 通道必须过滤；bone-only overlay 避免双 root motion

`sampleClip` 内部对 `ch.startsWith('vrm.root.')` 的 track 直接 `continue`。
`WalkingLayer.sample()` 还在 clip 输出侧再加一层 guard（`if ch.startsWith('vrm.root.') continue`）。

双重守护理由：VRMA 导出工具通常会把 root 烘焙进 clip（作者工具的副产品），
如果不过滤，clip root 会和 WalkingLayer 自己算的 root delta 叠加，造成
avatar 被"双推"到错误位置，或 release 段 envelope ramp 回零产生"归位假象"。

### unresolved/missing walk clip 必须降级为 slide mode，不能 crash

`AvatarService.start()` 里用 `compiler.getClipByActionName(walkCycleName)` 解析；
返回 `null` 时只 `this.logger.warn(...)` + 继续。不抛异常，不中止启动。
WalkingLayer 无 clip 时仍正常工作（root motion only），用户配置错误只影响腿部动画。

用 `cycleClipActionName` 指向用户本机才有的资产时，不要把该 action 条目 commit 进
仓库（否则启动时 `ActionMap.preloadClips()` 因文件缺失而 drop + warn，但 walking
仍会拿到 null 并 fallback）。

## Absolute-scalar bypass（2026-04-22 patch）

LayerFrame 三条路：

- **`scalar`** —— delta-style 加法混合，乘 `ambientGain × weight`。breath / blink / perlin / gaze / 非 tangent-preserving 的 IdleMotion
- **`scalarBypass`** —— 绝对姿态 scalar，**不乘 weight / gain，不走 spring-damper，不走 baseline**，last-writer-wins。`AnimationLayer.scalarIsAbsolute = true` 声明路由。WalkingLayer 的 root + walk-cycle bone Euler 走这条
- **`quat`** —— 绝对四元数姿态，同 scalarBypass 语义（都不 gate、都 bypass）

### 为什么要引入 scalarBypass

原 `quatFrameChannels` 机制已实现 spring/baseline 绕过，但只覆盖 quat 展开通道
（`.qx/.qy/.qz/.qw`）。WalkingLayer 的 `vrm.root.*` 走普通 scalar 路径，被 `ambientGain` 缩放 →
说话时 gain=0.3 导致位置坐标也缩小 → avatar 边说边走漂回原点。

修复：第三条 scalarBypass 路径。`AnimationCompiler` 的 `quatFrameChannels` 改名为 `bypassFrameChannels`，
同时覆盖 quat 展开和 scalarBypass 两路。

### WalkingLayer.sampleQuat 契约

LayerManager 在同一 tick 先 `sample()` 后 `sampleQuat()`。WalkingLayer 在 `sample()` 里推进所有 state
（Motion 状态 / 位置 / walk-cycle clip 时间），同时把 quat 部分塞进 `cachedQuat: {nowMs, quat}`。
`sampleQuat()` 仅读缓存；nowMs 不匹配返 `{}`（防 standalone 调用双推进）。

同样的 pattern 在 IdleMotionLayer 已用过（`advanceAndSample` + cache）。

## WalkingLayer semantic motion system（2026-04-22 patch）

从单一 `walkTo(x, z, face)` snap-facing 的 tank-style walker 重构为 **Motion discriminated union**。

### Motion 类型

```ts
type Motion = LinearMotion | OrbitMotion
```

- **LinearMotion**：`target: {x, z, facing}`。每 tick 并行推进位置（`speedMps`）和 facing（`angularSpeedRadPerSec`）。
  **"走时能转"天然支持** —— 旧 snap-facing 被 gradual interp 替代
- **OrbitMotion**：`center + radius + startAngle + totalSweepRad` 参数化圆。character 沿弧 speed = `speedMps`。
  `keepFacingTangent` 默认 true → facing 贴 tangent 方向；false 时 facing interp 到 `targetFacing`

### 坐标 / 符号约定（要精确记住，符号混了调试很麻烦）

```
facing = 0       → 看 +Z        (character 默认姿态)
facing = +π/2    → 看 +X        (character 自己的"右"方向)
facing = ±π      → 看 -Z
facing = -π/2    → 看 -X

forward_world(f) = (sin f, cos f)      // 角色自身 forward 的世界向量
right_world(f)   = (cos f, -sin f)     // 角色自身 right 的世界向量
```

Three.js Ry 正角实际上**从上方俯视是顺时针**（反直觉，右手系 + Y 向上的结果）。所以：

- `turn(+rad)` → `facing += rad` → CW from above → **角色自身"右转"**（positive = right）
- `walkForward(+m)` → 沿当前 forward 移动
- `strafe(+m)` → 沿当前 right 移动（角色自身右侧；背对观众时和观众右一致，面对时相反）
- `orbit({sweepRad:+θ})` → 数学标准 CCW（from above），默认 center 在角色自身左侧 `radius` m

### 公开 API 分层

**bot 侧（AvatarService 薄封装）**：

| 方法 | 用途 |
|------|------|
| `walkForward(m)` / `strafe(m)` / `turn(rad)` / `orbit(opts)` | 语义原语，HUD + 未来 LLM tool 主入口 |
| `walkTo(x, z, face?)` | 低层 absolute-coord，LLM 需要绝对调度时用 |
| `stopMotion()` | interrupt（`stopWalk()` 仍是 alias，已 deprecated） |
| `getCurrentPosition()` | 读当前姿态，仅 debug 用 |

**WS 协议**（客户端 → bot）：`walk-command` discriminated union，`kind` 判别：

```ts
  | {kind:'forward', meters}
  | {kind:'strafe', meters}
  | {kind:'turn', radians}
  | {kind:'orbit', sweepRad, radius?, center?, keepFacingTangent?}
  | {kind:'to', x, z, face?}     // 对应 walkTo
  | {kind:'stop'}
```

旧 `walk` / `stop-walk` 消息**已淘汰**。`PreviewServer.validateWalkCommand` 做 shape + finite-number 入口校验，
避免 NaN / malformed data 进 layer。

### rootPosition 广播（bot → HUD）

`PreviewStatus.rootPosition: {x, z, facing}` 由 AvatarService 从 `WalkingLayer.getPosition()` 填入，
每秒 ~1 次 broadcast。HUD **只读不派生** —— 显示用，绝不反推用于命令参数。

cubism 模型下 WalkingLayer 不注册（`modelSupport=['vrm']`），rootPosition 缺省。

### Config fields 对应 tunable

| config 字段 | tunable id | 用途 |
|------------|-----------|------|
| `speedMps` | `speedMps`（m/s）| 线速上限 |
| `angularSpeedRadPerSec` | `angularSpeedDegPerSec`（°/s）| 转向角速度上限。HUD 用度展示 |
| `arrivalThresholdM` | `arrivalThresholdM` | 位置到达容差 |
| `arrivalThresholdRad` | —（暂未 tunable）| facing 到达容差，默认 0.01 rad |
| `onWalkingThrottleMs` | —（不暴露）| progress event 节流 |

### 构造函数 NaN 坑（曾经的 bug）

`{ ...DEFAULT, ...config }` 会让 `config.speedMps = undefined` 盖掉默认 1.0。
`undefined * dtSec = NaN` → `currentX = NaN` → `JSON.stringify(NaN) === 'null'` →
renderer 收到 `'vrm.root.x': null` → 位置不动，只转朝向。

改成 per-field `??` 合并。有回归测试 `undefined fields in config fall back to defaults`。

### 游戏式"走时同时转"何处做

LinearMotion 里位置和 facing **各自独立用自己的速度上限往前推**，每 tick 都进一步。
`walkTo(x, z, face)` 如果 face 和当前 facing 差很大，会产生曲线路径（走的同时转身）。
需要精准曲线则用 `orbit` 参数化圆。

更激进的"game controller" 连续 velocity 控制（任意组合 forward + strafe + turn rate）**未实现**。
触发条件："需要平滑遥杆输入" 或 "LLM 要频繁中途变向"。短期不做。

### 未做但已讨论的方向

- LLM tool：`walk_forward(m)` / `turn(rad)` / `orbit({sweepRad, radius})` / `walk_to(x, z, face?)` 作为 Anthropic tool_use 暴露。和 prompt 一起做
- 贝塞尔 / Catmull-Rom 路径 API（`walkPath([p0, p1, p2])` 或 `walkCurve(controlPoints)`）——LLM 驱动优先级高时再加
- velocity command 模式（`setMotionVelocity({forwardMps, strafeMps, angularVelRadPerSec})`）——game-controller 风格

## Renderer Capabilities API（2026-04-22 [SN]）

### Canonical expression vocabulary = VRM 1.0 preset names

`CANONICAL_EXPRESSIONS` (18 names: happy/sad/angry/surprised/relaxed/neutral +
visemes aa/ih/ee/oh/ou + eyelids blink/blinkLeft/blinkRight + gaze lookUp/lookDown/
lookLeft/lookRight) is the authoritative cross-repo vocabulary because VRM 1.0
preset names are the existing spec shared by both bot and renderer. Defining a
new vocabulary would create a translation layer with no benefit; the preset set
covers all the expression channels the compiler and LLM already use.

### `capabilities` must stay separate from `hello`

`hello` fires at WS open before any model is loaded — at that point the renderer
has no expression or channel data to report. `capabilities` fires after model
load (or hot-swap), when the data actually exists. Combining them would either:
- delay the `hello` handshake until model load (breaking the existing handshake
  timing contract), or
- force `capabilities` fields to be nullable in `hello` (ambiguous: null = no
  model loaded vs null = unknown capability).
Keep them as separate message types with separate triggers.

### Per-connection state keyed by WebSocket must be cleaned in the close hook

`AvatarService.connectedCapabilities` is `Map<WebSocket, {caps, receivedAt}>`.
The WebSocket object is the only stable per-connection identity available without
adding a session ID layer. Entries must be deleted in `onConnectionClosed`
(called from `PreviewServer.close(ws)`) to avoid stale entries from renderers
that refreshed or reconnected. Without this, `listConnectedCapabilities()` would
return ghost entries from dead sockets.

### Follow-up consumer directions (capability-gating)

Three planned follow-ups tracked by `TODO(capability-gating)` in `AvatarService`:

1. **Capability-gating compiler output** — per-socket frame routing that skips
   channels or expressions not in `caps.expressions` / `caps.supportedChannels`
   for that connection. Requires splitting the current single broadcast into
   per-socket filtered frames — non-trivial architectural change, defer until
   a model with a noticeably different expression set is actually connected.

2. **Canonical alias mapping** — a lookup table from CANONICAL_EXPRESSIONS
   names to renderer-local morph target names (for renderers that use vendor
   names rather than VRM 1.0 preset names). `RendererCapabilities.customExpressions`
   feeds this use case.

3. **LLM emotion prompt injection** — the LLM `{{availableActions}}` mechanism
   already injects action names; a parallel `{{availableExpressions}}` placeholder
   populated from `listConnectedCapabilities()` would let the LLM know which
   emotion presets are available at runtime and avoid asking for unsupported
   expressions.

## `[W:...]` walk tag（2026-04-22）

LLM 通过 rich tag 驱动位移。Parser 和 `[A/E/G/H]` 同级，字母 `W`。

### 语法

相对位移（不依赖当前位置）：
- `[W:forward:m]` / `[W:back:m]`（sugar for `forward:-m`）
- `[W:strafe:m]`（正=右，负=左，角色自身坐标系）
- `[W:turn:deg]`（正=右转 = CW from above）
- `[W:orbit:deg[:radius]]`（radius 默认 1m；CCW 正）
- `[W:stop]`

语义目标（代码映射成固定舞台位）：
- `[W:to:camera|center|back]` → `walkTo(x, z, face)`
- `[W:face:camera|back|left|right]` → `walkTo(currentX, currentZ, face)`（只转不走）

### 舞台约定 —— 不依赖 renderer 相机位置

`STAGE_POSITIONS` / `FACE_ANGLES` 在 `AvatarService.ts`：
- `camera = {x:0, z:0.5, face:0}`（+Z 为镜头方向，`facing=0` 面镜头）
- `center = {x:0, z:0, face:0}`、`back = {x:0, z:-0.5, face:0}`
- `face:back` = π，`face:left` = -π/2，`face:right` = +π/2

**关键**：`camera` 是 world 约定的"舞台前方"，不是 renderer 真实相机坐标。Renderer 侧
的相机用户可自由拖动，但 LLM 永远不需要知道真实位置 —— "靠近镜头"就是"向 +Z 走"。
这样避免了"需要 `getCurrentPosition` + 相机坐标注入 prompt 供 LLM 计算"的复杂度。

### LLM 不需要位置感知

**短期不加** `{{avatarPosition}}` placeholder。覆盖 90% 表演场景的方式：
- 相对位移处理"靠近一点/退一步/右转"等语感命令
- 语义目标处理"走向镜头/回到中央/转身"等完整 intent

真正需要 LLM 自己做空间计算的场景（"走到中点一半"）罕见；等它出现再注入。

### 度数 vs 弧度

**LLM 侧用度数**（`[W:turn:30]`）。`dispatchParsedTag` 内部 `(deg * π / 180)` 转弧度
后传给 `avatar.turn / orbit`。弧度对 LLM 不友好，容易 3.14 / 1.57 写错。

### Cubism 模型自动 no-op

`getWalkingLayer()` 返 null → `walkForward / walkTo / walkToSemantic / faceSemantic`
全部 `Promise.resolve()`，`stopMotion` 直接 skip。Cubism LLM 发 `[W:...]` 不会报错，
只是没效果。Prompt spec 里写明"仅 VRM 生效"提示 LLM 但 runtime 不强制。

### "位置即时机"对 walk 同样成立

tag 写在文本哪一位置就在哪一刻触发：
- ✅ `让我靠近你点儿——[W:to:camera]嗨！` —— 说完过渡句再走
- ❌ `[W:to:camera]让我靠近你点儿——嗨！` —— 走完才开口

Prompt `tag-spec.txt` 的"移动"节强调这一点。

## LLMStage streaming 分派走全 kind（2026-04-22 patch）

旧代码 `LLMStage.flusher` 用 `parseLive2DTags(chunk)`（只返 action kind），rich 格式下
`[E:]/[G:]/[H:]/[W:]` 在 streaming 期间被 drop；`TagAnimationStage` 因 `streamingHandled=true`
skip 不补。结果：streaming 路径 emotion/gaze/hold/walk **从来没被 dispatch**，只 legacy
`[LIVE2D:emotion=X]` 被 parseLive2DTags 塞进 action tag 一起走。

修复：
- `LLMStage.flusher` 改用 `parseRichTags(chunk)`
- 新建 `packages/bot/src/services/live2d/dispatchParsedTag.ts` 作共享 helper
- `TagAnimationStage` 从 inline switch 改成调这个 helper，代码减 60 行
- 两路（streaming / non-streaming）分派行为完全一致
- `pendingHoldMultiplier` 通过 `ctx` 在 chunk 间持久 → `[H:long]` 跨 chunk 仍作用于下一个 `[A:]`

## `outputFps` 默认 60（2026-04-22）

原 30Hz 输出 + 144Hz 显示 → 每帧 bone 保持 4-5 个显示帧不动 → 视觉阶跃（"卡顿"）。
提到 60Hz 后减半至 2 个显示帧，停顿感基本消失。内部 tick 本就 60Hz，
唯一新成本是每 tick 多一次 `{ ...currentParams }` + `JSON.stringify + ws.send`，
约 2% CPU 增量。Renderer 侧独立加 60fps 渲染 cap（rAF 仍按刷新率 fire，
skip `vrm.update + render` 当距上次 <16.67ms-1），互补省 GPU。

**不做 renderer 侧时间插值**（即使做了，stepping 的根因是发送率 < 显示率）。
60Hz 发送已经把 stepping 周期压到感知不到的水平；真正用 120+Hz 的极致场景再考虑。

## Bot perf log 门控（`AVATAR_PERF_LOG=1`）

`AnimationCompiler` 自带 per-second tick/emit/gap/handler 聚合日志，但**默认关闭**。
未启用时每 tick 一个 boolean check 开销；启用后每秒一行 logger.info。

```
[compiler] tick/s=54.8 emit/s=27.7 gapMax=19.0ms handlerAvg=0.2ms handlerMax=0.4ms active=1
```

诊断表（对比 bot 侧 vs renderer 侧）：
- `tick/s ≈ 60` + `emit/s ≈ 配置值` + `gapMax<50ms` → bot 健康，问题在 renderer
- `tick/s < 30` + `gapMax > 100ms` + `handlerAvg` 小 → event loop 被外部同步 CPU 阻塞
- `tick/s < 30` + `handlerAvg > 15ms` → tick 本身太慢（layer/clip/spring 热点）

**Renderer 侧不留 log 仪表**，浏览器频繁 I/O 有崩页风险；需要定位时临时加，定完删。

## Legacy `[LIVE2D:...]` 从 prompt 撤离（2026-04-22）

Parser shim 保留（兼容旧会话/旧 prompt 泄漏），但 `tag-spec.txt` 不再教 LLM 用 legacy
格式。理由：three system prompt 以前的 few-shot 混用 rich + legacy，LLM 温度稍高就
regression 回 legacy。rich-only prompt + few-shot 全改 rich 后，LLM 稳定产 rich tag。

## Live2D bot 侧 + Speech + 线程 + DeepSeek + 配置/落盘（2026-04-22 [11]）

> 长表、文件清单、验证命令见 **`.claude-workbook/2026-04-22.md` §11**。不放在 `docs/`
> 下跟踪，避免和本机 learnings 重复。

- **Reasoner / 输出预算**：`deepseek-reasoner` 等可把 token 全花在 `reasoning_content`，`content` 可整段空 → Live2D 无 TTS。`LLMStage` 默认 `maxTokens` 提到 **2048** 缓解；`DeepSeekProvider` 在流式/非流式对「只有 reasoning 无 content」打 **warn**；**TTS 仍只消费 `content`**，不是 reasoning。
- **SpeechService 泵**：每句播完后 **prefetch** 下一句 `synthesize`；**不再**在 `broadcast` 后按**本句客户端播放墙钟** `setTimeout` 再 pump 下一句（时间轴仍靠 `startAtEpochMs` 对齐）。
- **历史双轨已删**：曾有的 avatar 配置 `live2dMaxHistoryMessages` + prompt 侧 `slice` 与存储侧 `ThreadContextCompressionService.scheduleCompressOnly` **目标重复** —— 已删前者；`PromptAssemblyStage` 用 **`getHistoryEntries` 全量**；长会话仍由 thread 压缩服务负责，不在 LLM 输入里再砍一刀 N。
- **落盘复用**：`packages/avatar/src/utils/writeFileUnderDirectory.ts` 导出到 `@qqbot/avatar`；TTS 导出与 `ResourceDownloader.saveFile` 共用，避免各写 `mkdir`/`writeFileSync`。
- **`mergeAvatarConfig`**（`packages/avatar/src/config.ts`）：`isRecord` / `mergeObject` / `mergeCompilerConfig` 分层；`llmStream` 仅当 **JSON `=== true`** 为真，避免 `"false"` 字符串被当真。
- **SoVITS 运维**：`prompt_text` 与 `ref_audio_path` 所读内容若语义不一致，可 HTTP 200 但合成波形 **RMS 极低**（像「没声」），与网络失败区分排查。

## Sovits streaming + PCM 分片音频链路（2026-04-23）

### AudioChunkMessage schema 语义

`AudioChunkMessage`（`packages/avatar/src/preview/types.ts`）是 bot → renderer 的流式
PCM 分片协议：

| 字段 | 存在时机 | 说明 |
|------|---------|------|
| `utteranceId` | 所有 chunk | 一句话的稳定标识，所有 chunk 共享 |
| `seq` | 所有 chunk | 从 0 起的顺序号，renderer 严格串行播放 |
| `base64` | 所有 chunk | 编码后的音频字节，终结符 chunk 可为空字符串 |
| `isLast` | 所有 chunk | 整句恰好一个 isLast=true，信号 EOS |
| `totalDurationMs` | 仅 isLast=true | renderer 用来知道何时结束，不依赖解码器上报 |
| `mime` | 仅 seq=0 | 音频格式，如 `'audio/pcm'`，后续 chunk 省略以节省带宽 |
| `sampleRate` | 仅 seq=0 | PCM 必须。后续 chunk 沿用 |
| `startAtEpochMs` | 仅 seq=0 | 播放起始墙钟；过期直接播 |
| `text` | 仅 seq=0 | 原始句子，renderer 用于字幕/toast |

### 零延迟合约

- **每个 chunk 到达立即广播**，不攒批，不等下一块 envelope
- `AudioEnvelopeLayer` 在流式模式下注册于**第一个 chunk 到达之前**，携带
  `durationMs = STREAMING_PLACEHOLDER_DURATION_MS (60_000)`
- 当播放时刻（`t = nowMs - startAtMs`）超出已写入的 envelope 帧数时，
  `AudioEnvelopeLayer.sample()` 返回 `{}`（空 Record）——这是**期望行为**，
  不是错误：lipsync 数据还没到，用空输出让其他 layer（呼吸/眨眼）接管
- `finalize(actualDurationMs)` 在最后一块到达后立即调用，修正边界

### 为什么 AudioEnvelopeLayer.sample() 在 envelope 未到时返回 `{}`

`sample()` 逻辑：
```
if (i0 >= this.envelopeLength) return {};  // streaming: frames not arrived yet
```
这是流式模式的刻意设计：`envelopeLength` 是已写入的有效帧数（≤ buffer 容量），
当 `t/hopMs` 超出已有帧时，函数返回空而不是重复最后一帧，避免"卡嘴型"。
等 RmsStreamer 推入更多帧后，下一个 tick 会正常插值。

### 为什么流式 RMS 只支持 PCM，不支持 WAV/MP3

WAV 的 RIFF header 在首个 chunk，后续裸字节无法独立解码。MP3 每 chunk 是独立的
Mpeg frame，但 `audio-decode` / ffmpeg 都需要完整流才能建立解码上下文。

`audio/pcm` 是裸 little-endian int16 样本，可直接逐 chunk `decodeToMonoPcm` →
`RmsStreamer.push()`，无需状态。所以流式 lipsync **只在 `mime === 'audio/pcm'`** 时
生效；其他格式 chunk decode 跳过，layer 注册但无 envelope（静默期 `sample()` 返回 `{}`）。

### SpeechService 双路径架构（2026-04-23）

选路条件：
```ts
const canStream = this.broadcastAudioChunk !== undefined
  && typeof this.provider.synthesizeStream === 'function';
```

- **drainOneBuffered** — 保留原始 `inflightNext` prefetch 优化（queue[1] 与 queue[0] 的
  decode+broadcast 并行），行为 bit-for-bit 等价于旧 drain()
- **drainOneStreaming** — 无 prefetch（AsyncIterable 不是 Promise），独立处理
  层生命周期、RmsStreamer、零延迟 chunk 广播
- `broadcastAudioChunk` 是末位可选构造参数，现有调用者（AvatarService / tests）不需改动

**Fallback 策略**（streaming → buffered）：
- `synthesizeStream()` 同步抛异常 → 降级
- AsyncIterator 首次 next() 抛异常（seq=0，未播任何 chunk）→ unregister layer，降级
- 中途（seq>0）抛异常 → unregister layer，继续 queue，**不**降级（部分 chunk 已推出）
- 消费端断开 → 立即 unregister + shift queue + return

### PCM chunk 必须样本对齐（否则全是白噪声）

**坑**：HTTP chunked transfer 在**任意字节位置**切分流，`reader.read()` 返回的
`Uint8Array` 长度**不保证**是 `SAMPLE_BYTES` 的倍数。实际观察到 Sovits GPU 后端
会返回 `1441 / 8687 / 16295 / 30231` 这类**奇数字节** read。

`s16le` 每样本 2 bytes。如果把奇数字节的 chunk 直接丢给解码器（无论是 bot 侧
`decodeToMonoPcm`，还是 renderer 侧 `decodePcmToAudioBuffer`）：

```ts
const frameCount = Math.floor(bytes.byteLength / 2);  // 尾字节被 floor 掉
```

**尾字节被丢**，而下一块 chunk 的首字节本应是那个样本的高字节——从此整条流
每个 int16 的高低字节都**错位 1**，听感上就是**纯白噪声**（所有样本幅度
接近随机 int16）。

**修正位置**：`SovitsProvider.synthesizeStream`（`packages/avatar/src/tts/providers/SovitsProvider.ts`）
在流式循环里维护 `residual: Uint8Array`：

```ts
const combined = new Uint8Array(residual.length + value.length);
combined.set(residual, 0);
combined.set(value, residual.length);
const alignedLen = combined.length - (combined.length % SAMPLE_BYTES);
if (alignedLen === 0) { residual = combined; continue; }  // 不够一个样本就攒着
const alignedChunk = combined.slice(0, alignedLen);
residual = combined.slice(alignedLen);
yield { bytes: alignedChunk, ... };
```

**契约收紧**：`SynthesisChunk` 的 docstring 明确"`audio/pcm` 流 chunk 的 bytes
长度必须是样本宽度的整数倍"——新 provider 必须在自身内部做对齐，不能甩给
SpeechService / renderer。

**为什么在 Provider 侧修、不在 SpeechService 修**：
1. SpeechService 不应该知道 "s16le = 2 bytes/sample"，只有 provider 才知道自己
   emit 什么格式
2. `SynthesisChunk.bytes` 语义变成"一组完整样本"，对所有下游（RMS 管线、
   renderer）都更有用
3. 未来其他流式 provider（如 Fish WebSocket）同理各自处理对齐

**回归测试**（`SovitsProvider.test.ts`）：
- 奇数字节 read 序列 `[3, 4, 1]` → 必须 `yield.bytes.length % 2 === 0`，且
  串联回原字节流
- 单字节 read `[1, 1, 1, 1]` → 不能 yield 空 chunk
- 流末尾残留 1 字节 → drop + warn，不 yield 出去

### 流式 startAtMs 必须锚在首 chunk 到达时刻（否则 lipsync 全失效）

**坑**：`synthesizeStream()` 返回 `AsyncIterable`，但 HTTP 请求**只在 `for await`
首次迭代时才发出**。对 Sovits GPU 后端这意味着：stream-start 到 first-chunk 之间
有 300~800ms 的真实 round-trip 延迟。

如果在 `for await` 之前就 `startAtEpochMs = Date.now()` 并据此建 `AudioEnvelopeLayer`：

```ts
// 错误写法
const startAtEpochMs = Math.max(now, lastEndTime + gapMs);  // 记录请求发出前墙钟
const layer = new AudioEnvelopeLayer({ startAtMs: startAtEpochMs, ... });
this.registerLayer(layer);

for await (const chunk of stream) {  // 500ms 后首 chunk 才到
  ...
}
```

那么当 renderer 实际开始播音时（首 chunk 到达 renderer → `ctx.currentTime` 起播），
bot 侧 `Date.now()` 已经比 `startAtMs` 超过 500ms，但 envelope 写入速度只能是实时：

- `sample(nowMs)` 算出 `t = nowMs - startAtMs ≈ 500ms`
- `idx = t / 20ms = 25` 帧
- 但 `envelopeLength` 此时只有 first chunk 刚 push 进去的 ~20 帧
- `i0 >= envelopeLength` → 返回 `{}` → 嘴完全不动

即使 GPU 合成快于实时，envelope 也要多生产 500ms 的内容才能追上，整句大部分时间
都是哑巴。

**修正**（`SpeechService.drainOneStreaming`）：把 `startAtEpochMs` 的捕获与
`AudioEnvelopeLayer` 的构造都**延后到 `seq === 0` 的分支里**——首 chunk 刚
到达的墙钟 ≈ renderer 接收到首 chunk 的墙钟（只差 WS latency ~10ms），这样
envelope 时钟与音频时钟同步。

```ts
let startAtEpochMs = 0;
let layer: AudioEnvelopeLayer | null = null;

for await (const chunk of stream) {
  if (seq === 0) {
    const now = this.clock();
    startAtEpochMs = Math.max(now, this.lastEndTime + this.gapMs);
    layer = new AudioEnvelopeLayer({ startAtMs: startAtEpochMs, ... });
    this.registerLayer(layer);
  }
  if (!layer) continue;  // TS narrow, dead at runtime
  ...
}
```

**启示 / 一般性原则**：**所有依赖"渲染端何时开始播放"的定时锚点**，都要取
"**我们即将发出首个能让渲染端播放的数据包**"的墙钟，而不是"我发出请求"的墙钟。
AsyncIterable 因为 lazy 求值天然引入这个陷阱，尤其要小心。

## 流式 RMS 必须做运行时 peak 归一化（否则嘴型幅度打骨折）

**症状**：对比缓冲路径，流式路径嘴型明显"只动一点点"，哪怕语句音量正常。

**根因**：
- 缓冲路径用 `computeRmsEnvelope({ normalize: true })`，把整段 RMS 峰值归一到 0.95。
- 流式路径用 `RmsStreamer` 每 hop 算一次原始 RMS——**没有归一化**。
- 人声原始 RMS 典型峰值只有 0.2~0.3，直接当 `mouth.open` 输出，嘴最大也就张 30% 幅度。
- 更糟的是 `AudioEnvelopeLayer` 的 excite 分支阈值 0.3，所以 eye.open / body.z / brow
  这些联动通道整个都不触发，头显得更呆。

**修复**：在 `AudioEnvelopeLayer` 自己维护运行 peak，在 `sample()` 时归一：

```ts
// append: peak 单调上升
for (const f of arr) if (f > this.streamingPeak) this.streamingPeak = f;

// sample: streaming 分支归一，缓冲分支保持旧行为避免双归一
let v = rawV;
if (this.streamingMode && this.streamingPeak > 0) {
  v = Math.min(1, (rawV / this.streamingPeak) * 0.95);
}
```

peak 单调上升会让"更早帧按更小 peak 已经输出过"，但因为 `sample(nowMs)` 的 nowMs
单调前进，观众永远看不到同一时刻被重渲——所以 peak 跳涨不会造成可见跳变。

**为什么不用 `RmsStreamer` 自带归一**：因为 peak 需要持续更新，而 `RmsStreamer`
只是数据源（每次 push 返回几帧），它不持有"整段峰值"这个概念——加进去会让
API 变得带状态、且上游也没法决定何时"flush 重算"。放在 Layer 里最对味：Layer
本来就是"按 nowMs 采样"的语义。

**对 excite 派生通道的副作用**：归一后 `v` 常常能过阈值，所以流式路径下
eye.open / body.z / brow 的联动也自动恢复，和缓冲路径视觉表现对齐。

**启示 / 一般性原则**：
> 所有"把流式信号映射到某固定视觉范围"的路径，都要把**归一化**作为头等公民
> 处理——缓冲路径靠整体求 peak 免费得到，流式路径必须显式维护 peak 跟随器。
> 否则"数值全对，但视觉幅度全 wrong"会是最难察觉的 bug 之一。

## 视位估计用 2-band 投影而不是 5-band per-vowel

**场景**：把 Float32 PCM 映射成 5 个 AEIUO 视位权重（`aa/ih/ee/oh/ou`），
驱动 VRM preset expression。

**尝试过的错路**：5 个 biquad，每个中心频率选一个"该视位的典型 formant"
（aa@800, ih@350, ee@2300, oh@600, ou@450 这样）。问题在于：

- /o/ 和 /u/ 都是 low-formant 后舌元音（F1 ≈ 300~600，F2 ≈ 840~870）。
  两个中心频率都在 400~700 的 biquad 对同样的 voiced 信号响应几乎一致，
  仅靠单带能量**根本无法区分**。
- 不得不引入 ad-hoc 减法（"把 ou 的分数减去 oh 的"等）来拉开差距，调起来
  工程师要盯着 oscilloscope 猜参数。

**正确做法**：投影到 2D formant 平面（F1 / F2），再在 1D 轴上 softmax：

```
L = energy(biquad @ 500 Hz, Q=1.4)   # F1 区
H = energy(biquad @ 2000 Hz, Q=1.4)  # F2 区
h = H / (L + H + ε)                    # 0..1，loudness-invariant

# 每个视位有一个 centroid h 值（从公认 F1/F2 表推导）
centroids = { oh: 0.18, ou: 0.25, aa: 0.45, ih: 0.70, ee: 0.82 }

# 高斯打分 + softmax
score(v) = exp(-(h - centroid[v])² / temperature²)
weights = softmax(scores)  # sum ≈ 1
```

**为什么这样就能区分 /o/ 和 /u/**：
- /o/ F2 ≈ 840 → 2 kHz biquad 响应中等（gain ≈ 0.3），对 500 Hz 响应高（≈ 0.8）
  → h ≈ 0.12
- /u/ F2 ≈ 870（几乎一样），但 F1 更低（300 vs 570）→ 500 Hz biquad 响应更低
  → L 更小 → **h ≈ 0.22**

关键是 `h = H / (L+H)` 的比值对 /o/ 和 /u/ 的 F1 差异敏感——单看绝对能量区分
不开，但**比值**行。

**通用原则 / 启示**：
> 当一组信号类别在原始 feature 空间里不可分但在某个**比值 / 方向 / 投影**上
> 可分时，优先找到那个投影而不是堆更多 feature 提取器。物理上说得通的投影
> 比硬堆带通往往少一半代码还更 robust。

**实现定位**：`packages/avatar/src/compiler/audio/biquad.ts` 通用基元；
`packages/avatar/src/compiler/audio/visemeEstimation.ts` 是估计器。完全独立
于 `RmsStreamer` / `AudioEnvelopeLayer`——后续整合通过"发射 channel"的 bot
ticket 统一接入，这样独立模块本身可以先 land、先单测、先离线校准。

**可调空间**（`VisemeStreamerOptions`）：
- `temperature` (默认 0.12)：小 → 硬切单视位，大 → 所有视位都均匀开一点
- `lowCenterHz / highCenterHz / q`：整体移动"F1 / F2 侦测窗"的位置
- `centroids`：精细平移每个视位在 h 轴上的位置。中文有 /ü/ 这种在英文视位表
  之外的元音，如果实机观察到某些音节落到错的 centroid，优先调这个
- `preEmphasis / preEmphasisAlpha`：见下一条。

## Viseme 估计必须先做 pre-emphasis（否则 oh 一家独大）

`h = E_high / (E_high + E_low)` 是个几何上均匀分布的空间，但真实语音在这空间里
**绝不均匀**：浊音 F1 能量天然比 F2 高 10-20 dB（spectral tilt），不做预处理直接
喂两个 biquad，h 的经验分布会全挤在 0.1-0.3 段。

**后果**：谁的 centroid 落在 0.1-0.3 谁就赢。原始 `DEFAULT_VISEME_CENTROIDS` 里
`oh=0.18` 正好撞上，实机 Mandarin TTS 上 60-70% 帧都是 oh 主导，和发音内容完全
无关——这是 probe 工具（`packages/avatar/scripts/probe-visemes.ts --dump-h`）
在 4 条 Sovits 输出上直接跑出来的现象。

**修复**：
1. 在 biquad 之前加一阶 pre-emphasis `y[n] = x[n] − 0.97·x[n−1]`（MFCC、speech codec
   都是这么干的）。消掉 spectral tilt 后 h 的经验分布就摊开到 [0, 1]。
2. 用 pre-emphasized 信号的 h 分位数重设 centroids：`{ oh: 0.09, ou: 0.21, aa: 0.4,
   ih: 0.69, ee: 0.94 }`——是对 `output/tts/*.wav`（4872 voiced frames）的 10/30/50/70/90
   分位数取整。

**坑 #1**：pre-emphasis 要跨 `push()` 保留一个浮点状态（`preEmphPrev`）。不保留
的话每次 chunk 边界处首样本会被当成 `x[n−1] = 0`，产生假的高频 spike；表现是
chunk 边界帧的 h 值突然拉高一截。对应测试：
`pre-emphasis state carries across push() calls (no seam artifact)`。

**坑 #2**：RMS 要测在**原信号**上，不要测在 pre-emphasized 信号上。
pre-emphasis 会把低频砍掉一大半，原始 0.5 的 sine 经 pre-emphasis 后 RMS 只剩
≈0.15，如果 mouth.open 的幅度从这里来就打骨折了。我们的约定是 `VisemeFrame.rms`
等价于 `RmsStreamer` 的输出，这样两个流的 loudness 语义一致。

**跨语言 / 换 TTS 引擎**：centroids 的数字是 Mandarin Sovits 驱动的，换语言一定要
重跑 `probe-visemes.ts --dump-h` 校准。pre-emphasis 是信号物理层的事，换语言不动。

## SovitsProvider：streaming 字段归 provider 管，不归 config 管（2026-04-23）

**背景**：`config.d/tts.jsonc` 里 `bodyTemplate` 直接写了
`{streaming_mode: true, media_type: "raw"}`，`SovitsProvider.synthesize()`
把模板原样 POST 给服务器。结果：`/tts` 命令拿到的是**分块 raw PCM 字节**，
但代码把它 label 成 `audio/wav` 塞进 Milky `record` 段，Milky 直接 500：
`Internal error: 消息体无法解析，请检查是否发送了不支持的消息类型`。

**症结**：两条下游通路对音频格式的要求互相冲突——
- `/tts` 命令 → Milky `record` 段 → 必须是**完整自描述的 WAV 文件**
- renderer / Live2D 的 `SpeechService.drainOneStreaming` → 需要**流式 raw PCM**（低首字节延迟）

让用户在 config 里挑一个就一定坑另一个。

**方案**：streaming 字段不再由 config 控制，`SovitsProvider` 按调用入口自己决定——
- `synthesize()` 总是 `{ ...bodyTemplate, streaming_mode: false, media_type: 'wav' }`，
  返回值 mime 硬编码为 `'audio/wav'`（不信 server `Content-Type`，有的 GPT-SoVITS
  版本会吐 `application/octet-stream`）
- `synthesizeStream()` 总是 `{ ...bodyTemplate, streaming_mode: true, media_type: 'raw' }`，
  `pcmSampleRate` 仍是必填（raw PCM 无 in-band sample rate）

**config 契约变化**：`bodyTemplate` 现在只承载**稳定合成参数**（`text_lang` /
`ref_audio_path` / `prompt_text` / `prompt_lang`），`streaming_mode` / `media_type`
写了也会被 provider 覆盖。`responseFormat` 选项从 `SovitsProviderOptions` 删除
（mime 现在由 forced `media_type` 推出，不需要再让用户二次指定）。

**测试里的回归 guard**：`overwrites streaming fields already present in the template`
—— 直接给 `bodyTemplate` 塞 `{streaming_mode: true, media_type: 'raw'}`，断言发出的
请求 body 里仍然是 `streaming_mode: false, media_type: 'wav'`。这条专门防有人
"从旧 config 迁过来但没删字段" 又把坑踩回来。

## LLM reasoning effort：两条管线分开控（2026-04-23）

**背景**：Live2D/avatar 管线跑 qwen3-32b（Groq）时，一次回复 TTFT 37s，completionTokens=368
而 responseChars=47。模型把 80%+ 的 output 预算花在 `<think>` 块上，非 streaming 的
`generate()` 又让整个 thinking 阻塞首字节。用户本来是要 "hello，你是谁" 的回复。

**根因**是多层叠加：
1. `PromptAssemblyStage`（conversation 管线）硬编码 `reasoningEffort: 'medium'`。
   每条用户消息都强制 thinking，但绝大多数闲聊根本不需要推理。
2. **Avatar 管线不走 conversation 管线**，它有自己的 `services/live2d/stages/LLMStage.ts`。
   这条路径里根本没传 `reasoningEffort`——Groq 默认就是 thinking ON。
3. `GroqProvider.generateStream` **完全没把 `reasoning_effort` 写进请求 body**
   （只有非 streaming 的 `generate()` 写了）。所以就算 avatar 管线传了 `'none'`，
   stream 路径也会丢字段。
4. Stream 路径对 `<think>` 块也不做过滤，直接 `handler(content)` 原样转发到
   SentenceFlusher → TTS。模型把自己的内部独白**念出来**。

**修复分层**（belt and suspenders）：

| 层 | 在哪 | 做什么 |
|---|---|---|
| 1 | `AIConfig.chat` + `PromptAssemblyStage` | Conversation 管线的 reasoning effort 从硬编码改成配置驱动，拆成 `reasoningEffort`（无 tool）/ `toolReasoningEffort`（有 tool），两个都默认 `'medium'` 保留原行为 |
| 2 | `AvatarConfig.llmReasoningEffort` + `Live2D/LLMStage` | Avatar 管线独立配置，**默认 `'none'`**——avatar 是纯 live roleplay，thinking 纯粹税 TTFT 还会让模型出戏 |
| 3 | `GroqProvider.applyGroqReasoningParams()` | 抽出的 helper，stream 和非 stream 路径都调。同时无条件加 `reasoning_format: 'hidden'`——API 侧直接丢弃 thinking，不再占用 content stream |
| 4 | `GroqProvider.createThinkStripper()` | 客户端防漏。带状态的 `<think>`/`</think>` 拦截器，能处理横跨 SSE chunk 的标签。Unclosed 块在 stream 结束时**故意丢弃**（让 avatar 说一半思路比沉默还糟） |

**关键决策**：不要一刀切认为"非 tool-use 就不需要 reasoning"。Conversation 管线
要处理"帮我总结一下这段聊天"、"这条消息是什么意思"、"帮我分析下这个选项"之类
需要真实推理的任务，默认 `'none'` 会回归质量。avatar 管线才是纯 RP，那里默认
`'none'` 是明确对的。

**Stripper 的边界**：`OPEN_TAIL = <think>.length - 1 = 6` 和 `CLOSE_TAIL = </think>.length - 1 = 7`。
Not-in-think 时保留尾部 6 字符防止把 `<thin` 这种部分前缀提前 emit；in-think 时保留
尾部 7 字符等闭合标签。一定要状态化跨 push()——Groq 的 SSE 常把 `<`、`think>`、
body、`</`、`think>` 切成独立帧发过来。

**实现定位**：
- `packages/bot/src/core/config/types/ai/index.ts` —— `AIChatConfig` + `ReasoningEffort` 类型导出
- `packages/avatar/src/types.ts` / `config.ts` —— avatar 侧配置 schema + `coerceReasoningEffort` 白名单
- `packages/bot/src/services/live2d/stages/LLMStage.ts` —— `resolveReasoningEffort()` 注入 `streamOpts.reasoningEffort`
- `packages/bot/src/ai/providers/GroqProvider.ts` —— `applyGroqReasoningParams` + `createThinkStripper` + 11 条单测

## Avatar pipeline 补强：investigator / roleplay 双线程架构（规划，2026-04-23）

> **状态**：planning。还没落地。是应对"single-LLM 既负责 RP 又负责 tool calling"
> 这个结构性问题的设计方向，必须保留不能丢。等 Phase 0 的数据（streaming +
> reasoning_effort=none 后的 TTFT）出来后决定是否立刻上 Phase 1。

### 问题陈述

现在 `GenerationStage`（conversation）和 `LLMStage`（avatar）都在一次 LLM 调用里
让同一个模型干两件**优化目标相互冲突**的事：

1. **冷逻辑**：判断要不要调工具、选哪个工具、构造参数、串多轮 tool_calls
2. **热表演**：出带 `[LIVE2D: ...]` tag 的 in-character 回复，保持人设、口吻、长度约束

一个模型同时优化这两个目标会出现：

- **thinking 预算两难**：给 thinking 就 RP 慢且容易"角色出戏"（模型在 `<think>` 里
  用元语言分析自己的人设），不给 thinking 就工具调用质量下滑。今天的 37s TTFT
  就是这个取舍的副作用。
- **prompt 污染**：RP 线里塞工具定义、skills manifest、工具使用规范，对纯闲聊
  是纯噪声；反之工具场景被人设 prompt 拖着语气，tool_calls arg 不精准。
- **模型选择被锁死**：一个 session 只能选一个 provider/model。没法"工具用带
  thinking 的强模型、RP 用快模型"。
- **失败耦合**：工具链挂了整个回复挂；其实"抱歉我查不到，不过……"是个合理降级。

### 推荐演化路径：三阶段

**Phase 1 —— Reactive Delegation（我的强推荐起点）**

RP 永远是主线，只在 RP 自己判断"我不知道这个事实"时才去请外援。

```
user msg
  → RP LLM（fast model，reasoning=none，persona prompt，带一个 `investigate` skill）
      emit 普通回复 (90% case)  → 完
      emit investigate(question, why) tool_call
        → InvestigatorSubAgent (strong model，thinking ON，全工具集)
          → 返回 { summary, key_facts[], sources? }
        → 注入 tool_result 给 RP 继续生成  → 带 fact 的人设回复
```

优点：
- 90% 闲聊一次调用，零额外延迟
- 复杂问题自动升级，RP 不需要"装懂"（关键人设优势）
- 两个 LLM 责任清晰，prompt 各自精简
- 失败解耦：Investigator 超时/挂掉，RP 可以降级说"我也不确定诶"
- **改动面小**。几乎用现有零件

**Phase 2 —— 并行占位 + 后补**

当 RP 预判要查东西，先输出"让我查查哦~"占位，后台并行跑 Investigator，
结果到了再 append 补充回复。要求 `SpeechService` 支持多 utterance 追加
（这个零件已经有）。

**Phase 3 —— 全 subagent orchestrator**

多个专职 subagent（RAG、记忆检索、代码搜索、emoji 选择器……）+ 轻量 router。
Anthropic Swarm 那一套。在我们的体量下 ROI 不高，不推荐主动上。

### 半数零件已经有

`packages/bot/src/agent/SubAgentManager.ts` + `SubAgentExecutor.ts` +
`ai.taskProviders.subagent` 配置已经是**完整的 subagent 执行器**。目前是通过
tool_call 触发：工具内部跑一个独立 LLM + 独立 provider + 独立 prompt。

**这正好匹配 Phase 1**——只要：

1. 在 `packages/bot/src/agent/` 定义 `InvestigatorSubAgent`（或复用现有 SubAgent
   配置），system prompt 写成"冷逻辑助理，不演任何角色，只返回事实/要点/建议"
2. 注册一个 `investigate` skill：`{ question: string, why: string }` → 
   `{ summary, key_facts[], sources? }`
3. avatar persona prompt 加一行："遇到不知道的事实或需要工具时，调用 investigate
   工具，**不要装懂**"
4. 完全跑在现有 `GenerationStage` / `LLMStage` 的 tool loop 上，基础设施 0 改动

### 成本 / 风险

- **Schema 设计是核心**：`InvestigatorSubAgent` 返回什么 RP 才能自然消化？我的
  当前倾向是 `{ summary: string (50-150字), key_facts: string[], confidence: 'low'|'medium'|'high' }`。
  太长 RP 会念出一堆客观陈述破坏人设；太短 RP 信息不够编不出自然回复。
- **订阅决策**：RP 要自主判断"该调 investigate"。人设 prompt 要明确写"哪些情况
  该调"——事实查询、工具操作、需要最新数据、需要多步推理。不写清楚模型会不调或乱调。
- **Latency stacking**：Phase 1 里 investigate 路径总时长 = RP_decide + Investigator + RP_synthesize。
  三段都是 LLM。需要 Investigator 用**非 thinking 的强模型**或者流式，否则
  investigate 路径会比现在的单 LLM 还慢。
- **Consistency**：Investigator 的记忆和 RP 分离。如果 Investigator 在 session N
  说 A，session N+1 说 B，RP 会矛盾。短期靠 episode key 共享上下文，长期看需不需要
  共享 memory service。

### 零成本前置改进（先做、和 Phase 1 正交）

在 `ProviderSelectionStage` 按是否有 tools 分流 provider：

- 无 tool → 用 `llmFallback` 第一档（fast，Groq/qwen3 这种）
- 有 tool → 用 `toolUseProviders` 里的强模型（DeepSeek / Anthropic）

这条不需要拆架构，单测覆盖也容易加。做完之后再评估 Phase 1 的收益是否还够大。

### 明确不推荐

- 每条消息都强制双调用——简单消息被拖慢、成本翻倍
- 让 Investigator 也负责出最终文本——风格飘移，用户能感觉到语气不一致
- 用同一个模型做两个角色——省不了 prompt，也省不了 thinking 预算

### 决策记录

- 方向：**推荐 Phase 1 落地**，Phase 2/3 按需再说
- 顺序（我建议）：先观察 Phase 0（streaming + reasoning=none 重启后 TTFT 数据）
  → 做零成本前置（按 tool-use 分流 provider）→ 再 Phase 1
- 执行者：future me 或独立 ticket。不要拆成 patchwork，要作为一个完整的
  "avatar pipeline 补强 v1" 来做

### 相关文件 / 参考点

- `packages/bot/src/agent/SubAgentManager.ts` / `SubAgentExecutor.ts` —— 已有执行器
- `packages/bot/src/ai/pipeline/stages/GenerationStage.ts` —— tool loop 在这
- `packages/bot/src/services/live2d/stages/LLMStage.ts` —— avatar 的 LLM 入口
- `packages/bot/src/ai/services/LLMService.ts` —— `generateWithTools` 是 tool loop 的低层
- `config.example.jsonc` —— `ai.taskProviders.subagent` 已有的配置项

## PerlinNoiseLayer activity envelope（2026-04-23）

### 问题

原 `PerlinNoiseLayer.sample()` 每个通道 = `perlin(t * freq) * amplitude`，输出**永远非零**。即使 weight 0.2 / 峰值 0.4°，视觉读作"头从不停下来，一直微微转圈"——人类 idle 是"停顿 / 微动 / 停顿"的节奏，不是匀速连续的。

### 解决：two-perlin（motion × activity envelope）

每个通道**两个独立**的 perlin 随机源：

- **Motion perlin**（保留）：快（0.3–0.4 Hz），实际抖动
- **Envelope perlin**（新）：慢（0.06–0.08 Hz，一循环 12–17 s），经两阈值 smoothstep 映射到 `[0,1]`：

  ```
  envRaw ≤ envPauseBelow   → envelope = 0   (完全停)
  envRaw ≥ envActiveAbove  → envelope = 1   (满幅)
  之间                       → smoothstep 过渡
  ```

最终：`output = motion * amplitude * envelope`。

### `PerlinChannelConfig` 新字段

```ts
envelopeFrequencyHz: number;  // 慢 envelope 频率
envelopeSeed: number;         // envelope 随机种子（与 motion seed 解耦）
envPauseBelow: number;        // 默认 -0.1
envActiveAbove: number;       // 默认 0.45
```

默认 5 通道（`head.yaw/pitch/roll`、`body.x/y`）各自一套独立参数，见
`DEFAULT_CHANNELS` in `PerlinNoiseLayer.ts`。

### 设计要点 / 坑

1. **不用状态机**：状态机切换边缘必然有离散跳变，再补 fade 就是变相重新实现
   smoothstep。用慢 perlin 自带连续性，天然没问题。

2. **阈值偏向停顿**（`envPauseBelow=-0.1`，`envActiveAbove=0.45`）：用户 complaint
   是"动太多"，所以阈值偏负让 envelope 多数时间在低段或 0。实测：
   - ~55% 帧 `|head.yaw| < 0.05`
   - 活动占空比（`|v|>0.2`）< 65%
   - 最长静止段 ~14 s，活动段中位数 ~2.6 s

3. **每个通道独立 envelope seed** + 略不同 `envelopeFrequencyHz`：yaw/pitch/roll
   不会在同一瞬间一起停 / 一起动，更有机。
   - 想要"整个头一起停"：把 3 个 head 通道的 `envelopeSeed` 和
     `envelopeFrequencyHz` 设一样

4. **Escape hatch**：设 `envActiveAbove: -10` → envelope 恒为 1 → 退化回
   老"持续运动"行为。测试和 tunable 实验用。

5. **向后兼容**：`buildChannelConfigs` 按字段 merge，所有 4 个新字段都可省略
   （用默认值）。老调用 `new PerlinNoiseLayer()` / `{ channels: { 'head.yaw':
   { amplitude: 0 } } }` 无需改。

6. **连续性 / 幅度上界不破**：envelope ∈ [0,1] 只会缩小 `|output|`，不会放大。
   原 continuity 测试（16.67 ms 步长 delta < 0.3）和 amplitude 上界测试
   （`|head.yaw| < 2.5`）不动。

### 调参 recipe

| 想要 | 改 |
|------|-----|
| 更长 / 更频繁的停顿 | `envPauseBelow` 往 0 靠（如 `0.0`）或降低 `envelopeFrequencyHz` |
| 更少停顿、更活跃 | `envPauseBelow` 更负（如 `-0.3`） |
| 满幅更难达到（幅度更柔和） | `envActiveAbove` 升高（如 `0.7`） |
| 完全关掉 envelope（老行为） | 单通道或全通道 `envActiveAbove: -10` |
| 同步 head 三轴的停顿 | 3 轴用同一 `envelopeSeed` + `envelopeFrequencyHz` |

### 为什么没改 `setWeight(0.2)`

`createDefaultLayers` 里 `perlinNoiseLayer.setWeight(0.2)` 没动。改 envelope
已经解决"动太多"的根因（时间维度：加了停顿 + 幅度变化），再同时降 weight
属于过度响应，会让活跃期也变得过分轻微。

### 未做 / 有意推迟

- envelope 形状目前是单 smoothstep，未暴露给 HUD 作 tunable。需要时走
  `TunableParam` API 加——不是这次的事
- 其他 layer（Breath 多谐波 / Blink 4 阶段 / EyeGaze OU+saccade）都已有自己
  的节奏模型，不需要加 envelope

### 相关代码

- `packages/avatar/src/compiler/layers/PerlinNoiseLayer.ts` —— 实现（`envelopeValue()`
  helper + `envelopePermutations` map + `sample()` 中 `motion * amp * env`）
- `packages/avatar/src/compiler/layers/PerlinNoiseLayer.test.ts` —— 4 个新测试
  （2 s 静止窗口、占空比 < 65%、10 s window peak 方差、escape hatch）

## Avatar Phase 2 — Autonomous API + Rate Multipliers（2026-04-24）

Ticket `2026-04-24-avatar-autonomous-api`。实现 mind-system 的两项 Phase 2 改造：
programmatic animation enqueue API，以及 layer 级频率调制。

### `StateNodeSource` 类型语义

```ts
export type StateNodeSource = 'llm' | 'autonomous';
```

写到每个 `StateNode.source?`（optional，old state-machine transition nodes 不带）：

- **`'llm'`**: 从 LLM reply tag 解析（`[A:...]`），经 `TagAnimationStage` 入队
- **`'autonomous'`**: programmatic 调用（`enqueueAutonomous`），不经 LLM 解析

用于 HUD debug trace 和 log 行区分两条路径。export 路径：
`packages/avatar/src/index.ts` → `export type { StateNodeSource }`.

### `enqueueAutonomous(actionName, intensity, opts?)` API

```ts
enqueueAutonomous(
  actionName: string,
  intensity: number,
  opts?: { emotion?: string; durationOverrideMs?: number },
): void
```

- 完全走**相同的 modulation + jitter pipeline**（`_enqueueModulated`），
  persona modulation 自动应用。和 `enqueueTagAnimation` 唯一差别是 `source='autonomous'`
- `opts.emotion` 默认 `'neutral'`
- `opts.durationOverrideMs` 替代 action-map 默认时长作 jitter base，
  不传则用 `getActionDuration(actionName) ?? 1500`
- compiler 为 null（未 initialize）→ warn + no-op，不 throw
- action-map 查不到动作 → 仍 enqueue，compiler 侧 silently drop，duration fallback 1500ms
- intensity 超出 `[0,1]` → modulation 管道出口 `clamp(intensityFloor, 1, ...)`，不提前截断

### `enqueueAutonomousEmotion(name, intensity)` API

```ts
enqueueAutonomousEmotion(name: string, intensity: number): void
```

- 行为与 `enqueueEmotion()` 完全相同（resolve → filter emotion channels → `seedChannelBaseline`）
- 唯一区别：log 行里 `source=autonomous`
- 内部共享 `_applyEmotionBaseline(name, intensity, source)` private helper，确保两条路径 parity
- intensity clamped to `[0, 1]` before `resolveAction`
- 未知 emotion / clip-kind action / 空 emotion channels → warn + no-op（不 throw）

### 两个 helper 的设计意图

| Helper | 目的 |
|--------|------|
| `_enqueueModulated(actionName, emotion, baseIntensity, baseDuration, source, meta)` | `enqueueTagAnimation` 和 `enqueueAutonomous` 的唯一 modulation+jitter 实现。任何管道数学改动自动同步两路 |
| `_applyEmotionBaseline(name, intensity, source)` | `enqueueEmotion` 和 `enqueueAutonomousEmotion` 的唯一 baseline-seed 实现 |

**不要把 modulation 逻辑复制到 `enqueueAutonomous` 里**——这是设计 invariant。

### `BreathLayer.setRate(multiplier)` API

改变呼吸的**时间频率**（角频率），不改振幅/center/DC offset。

```ts
setRate(multiplier: number): void
// clamp [0.2, 3.0]; NaN → no-op; default = 1.0 (identity)
```

**语义**：设 rate=r，则 `layer.sample(t)` === `default_layer.sample(t * r)`。

即：rate=2.0 → layer 在 t 时刻的值等于默认 layer 在 `2t` 时刻的值，呼吸频率翻倍。
实现方式：`omega = (2π / periodSec) * _rate`（包括所有谐波分量），amplitude/center 不变。

| 值 | 效果 |
|----|------|
| `setRate(1.0)` | identity，行为等同于从不调用 |
| `setRate(2.0)` | 加倍频率（减半周期） |
| `setRate(0.5)` | 减半频率（加倍周期） |
| `setRate(0.0)` / `setRate(-100)` | clamp 到 0.2（不冻结） |
| `setRate(100)` / `setRate(Infinity)` | clamp 到 3.0 |
| `setRate(NaN)` | no-op，`_rate` 不变 |

### `AutoBlinkLayer.setRate(multiplier)` API

同样的 clamp/NaN 合约。影响所有 blink timing：

```ts
setRate(multiplier: number): void
// clamp [0.2, 3.0]; NaN → no-op; default = 1.0 (identity)
```

- `open` 阶段等待间隔 = `randomInterval() / _rate`（interval 被 rate 除）
- `closing` / `closed` / `opening` 阶段时长均被 `_rate` 除（duration / _rate）
- **已调度的 `nextBlinkAt` 不回溯修正**：当前 open-wait 按原计划完成，之后的 interval 和 phase 时长立即用新 rate

**为什么不回溯 `nextBlinkAt`**：mind-system 可能在 talking 期间改 rate。如果立刻重调时钟，
可能造成"刚设完就马上眨眼"的抽搐感。让当前 wait 自然完成，体验更平滑。

### 测试覆盖

- `AvatarService.autonomous.test.ts`：25 tests，覆盖 normal path / edge / modulation pipeline / regression
- `BreathLayer.test.ts`：11 tests，包含 identity / 频率语义 / clamp / NaN / Infinity / 值域验证
- `AutoBlinkLayer.test.ts`：15 tests，包含 identity / 频率语义 / clamp / NaN / phase state / reset

全量验证（2026-04-24）：459 tests pass, 0 fail.

## 本地笔记

- 工作日志落 `.claude-workbook/YYYY-MM-DD.md`（本地）
- 功能级详解（endPose/baseline/crossfade、leadMs/accompaniment、rich tag、clip）
  最后落 `packages/avatar/README.md`
- 相关 tickets 在 `~/project/cluster-tickets/qqbot/2026-04-1[89]-avatar-*/`
  和 `2026-04-20-avatar-*/` / `2026-04-21-avatar-*/`
