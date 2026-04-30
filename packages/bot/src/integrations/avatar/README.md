# `@qqbot/avatar` 包的 bot 端集成层

bot 主包消费 `@qqbot/avatar` 包（保持 bot-agnostic）的 adapter / plugin / driver。
**目录约定参考**：[`.claude-learnings/core.md` "bot ↔ external-package integration 目录约定"](../../../../../.claude-learnings/core.md)。

## 子目录组织

```
integrations/avatar/
├── plugins/      ← 主 pipeline plugin（@Hook，message-flow-driven）
│   ├── AvatarPlugin.ts              LLM 回复 tag → avatar 动画 / TTS
│   ├── PoseLifecyclePlugin.ts       thinking ↔ neutral 包裹（synthetic source）
│   └── SessionStrategyPlugin.ts     per-source history adapter 选择
│
├── services/     ← 长时运行 daemon（独立循环 / 事件订阅）
│   ├── AutonomousTriggerScheduler.ts   读 Persona phenotype → 驱 yawn / valence drift（消费 persona）
│   ├── AvatarIdleTrigger.ts            沉默 N 秒 → 触发 idle reaction
│   ├── AvatarMemoryExtractionCoordinator.ts  debounced memory extraction
│   ├── AvatarSessionService.ts         avatar 自有 session thread
│   ├── PersonaModulationAdapter.ts     PersonaState → MindModulation（avatar 包接口）
│   └── wander/                         WanderScheduler（autonomous wander 调度）
│
└── livemode/     ← bilibili 直播相关 livemode 状态机
    ├── LivemodeInterceptor.ts
    └── LivemodeState.ts
```

## 依赖方向

- `@qqbot/avatar` 包 **不 import** `packages/bot/`（保证可独立分发）
- 本目录 import `@qqbot/avatar` + `@/persona/...` + 其他 bot 服务
- `services/` 下若干文件**消费** persona 状态（如 `AutonomousTriggerScheduler` 读 `persona.phenotype` 决定何时 yawn）—— 这不破坏 avatar 包独立性，因为它们在 bot 主包内

## 不要做

- **不要**把这些 plugin / driver 塞进 `packages/avatar/` —— 那会让 avatar 包反向依赖 bot
- **不要**把 plugin 散落回 `packages/bot/src/plugins/plugins/` —— `integrations/<pkg>/plugins/` 的命名让"胶水代码"语义显式
- **不要**把 services/ 内的 `AutonomousTriggerScheduler` / `WanderScheduler` 搬回 `packages/bot/src/persona/` —— 它们是"读 persona / 写 avatar"的集成层，不属于 persona 模拟本身
