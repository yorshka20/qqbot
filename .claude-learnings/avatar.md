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
