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
