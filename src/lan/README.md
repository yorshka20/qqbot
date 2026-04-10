# LAN Relay (Phase 2 dispatch model)

WebSocket-based remote control for multi-machine bot deployments where IM
(QQ/Discord) is single-login.

```
┌──────────────────────────────────┐         ┌──────────────────────────────────┐
│  Host instance (192.168.50.209)  │         │  Client instance (work laptop)   │
│                                  │         │                                  │
│  • Holds the live IM connection  │         │  • No IM connection              │
│  • Bun.serve LAN WebSocket       │ ◄─────► │  • Runs cluster / claudeCode     │
│  • LanControlPlugin: /lan ...    │   WS    │  • Silent until dispatched       │
│  • Persists internal_reports     │         │  • Auto-reconnect / fire-forget  │
└──────────────────────────────────┘         └──────────────────────────────────┘
              ▲                                           │
              │ /lan @workstation-A run a long task       │
              │                                           │
        ┌─────────────┐                                   │
        │  user @ QQ  │ ◄─────────── reply via host ──────┘
        └─────────────┘
```

## When to use this

- **Single-login IM** but you want a *worker bot* on another machine that
  can run long-running Agent Cluster / Claude Code tasks.
- The worker has its own DB, plugins, AI providers — it just doesn't have
  an IM connection.
- You control the worker by dispatching commands from QQ/Discord through
  the host.

## When NOT to use this

- You just want every machine to receive every IM message → that's the
  Phase 1 broadcast model (removed in Phase 2 — use Agent Cluster instead).
- You need full sub-second IM event mirroring → use Agent Cluster's
  ContextHub, not LAN relay.

## Folder layout

```
src/lan/
├── index.ts            — public exports
├── init.ts             — initLanRelay() entry; called from src/index.ts
├── README.md           — this file
├── types/
│   ├── wire.ts         — WebSocket envelope shapes (versioned)
│   └── runtime.ts      — ILanRelayRuntime + module-level singleton
├── host/
│   ├── LanRelayHost.ts          — Bun.serve, registry, dispatch, relay_action
│   ├── LanInternalReportStore.ts— sqlite-backed /lan log storage
│   └── registry.ts              — ClientEntry type
└── client/
    └── LanRelayClient.ts        — auto-reconnecting WebSocket, dispatch handler,
                                   sendToUser / reportToHost APIs
```

## Wire protocol envelopes

All envelopes are `{ v: 1, type, id?, payload }` JSON. Versioning lives in
`v`; bump only on backwards-incompatible changes.

| `type`              | direction       | purpose |
| ------------------- | --------------- | ------- |
| `hello` / `hello_ack` | client ↔ host | initial handshake; host rejects duplicate clientId |
| `client_register`   | client → host   | metadata after hello (lanAddress, plugins, uptime) |
| `dispatch_to_client`| host → client   | run a synthesized command on a specific client |
| `dispatch_ack`      | client → host   | transport-level ack of a dispatch |
| `relay_action`      | client → host   | "send this reply via IM"; supports `target` field |
| `relay_ack`         | host → client   | result of relay_action |
| `relay_error`       | host → client   | malformed relay_action |
| `internal_report`   | client → host   | log line persisted to sqlite (no IM) |
| `ping` / `pong`     | both            | optional liveness probe |

## Deployment

### Host

```jsonc
// config.d/lanRelay.jsonc
{
  "lanRelay": {
    "enabled": true,
    "instanceRole": "host",
    "token": "<openssl rand -hex 24>",
    "listenHost": "0.0.0.0",
    "listenPort": 47123,
    "defaultReplyTarget": {
      "protocol": "milky",
      "chatType": "private",
      "userId": "123456789"
    }
  }
}
```

### Client

```jsonc
// config.d/lanRelay.jsonc
{
  "lanRelay": {
    "enabled": true,
    "instanceRole": "client",
    "token": "<same as host>",
    "connectUrl": "ws://192.168.50.209:47123/lan-relay",
    "clientId": "workstation-A",
    "clientLabel": "MacBook Pro M3",
    "publicAddress": "192.168.50.42",
    "client": {
      "disabledPlugins": ["zhihuFeed", "wechatIngest"],
      "disabledServices": ["staticServer"]
    }
  }
}
```

## Commands (`/lan`, owner only)

```
/lan list                   # list all connected clients (uptime, lastSeen, plugins)
/lan @workstation-A <text>  # dispatch <text> to workstation-A as if user typed it locally
/lan log workstation-A 50   # show last 50 internal reports from workstation-A
/lan kick workstation-A     # force-disconnect a client (host registry cleared)
/lan status                 # show host LAN-relay status (port, client count)
```

## Client APIs (for business code)

```typescript
import { getLanRelayRuntime } from '@/lan';

const runtime = getLanRelayRuntime();
if (runtime?.isClientMode()) {
  // Talk back to the dispatch originator (uses currentOrigin).
  await runtime.sendToUser([{ type: 'text', data: { text: 'task done' } }]);

  // Send a status line to host (no IM, persisted to sqlite for /lan log).
  await runtime.reportToHost('info', 'phase 2 of build complete');
}
```

## Important gotchas

### Zero-protocol bootstrap pitfall

When `instanceRole=client`, `Config.getProtocolsToConnect()` returns `[]`
and `connectionManager.connectAll()` emits `connectSettled` *synchronously*.
`Bot.waitForConnections` short-circuits at the top to avoid a 30s timeout —
any future code that waits on `connectSettled` after `await connectAll()`
must do the same check or use a pre-attached listener.

### Initial-connect failure must NOT crash

`LanRelayClient.start()` is fire-and-forget: if the host is briefly down at
boot, the process must still come up and reconnect in the background.
Initial-failure path falls through to `scheduleReconnect()` (idempotent —
single timer at a time, no double-incrementing backoff).

### Duplicate clientId

The host rejects a `hello` whose `clientId` is already present in the
registry (B1 decision). The client surfaces the rejection as a fatal error
and asks the operator to change `lanRelay.clientId`. There is *no
auto-takeover* on reconnect — if your client crashes and restarts, the old
socket must close (TCP reset / WebSocket timeout) before the registry
entry frees up.

### Origin context is "覆盖式"

Per A5, the client only remembers the most recent dispatch origin. If two
dispatches arrive concurrently, the second overwrites the first and any
later `sendToUser` will route to the second user. Acceptable for the
single-task workflow this was built for; revisit if you need multi-user
parallelism.

### Phase 2 ≠ Agent Cluster

LAN relay is intentionally separate from `src/cluster/`. It runs its own
Bun.serve, defines its own config block, and has no shared HTTP routes or
DI tokens. If Agent Cluster ever needs cross-machine LAN transport, it
should call into `src/lan/` rather than reimplementing a parallel WS server.
