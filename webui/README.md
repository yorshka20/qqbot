# File Manager Web UI

How the UI works with the StaticFileServer backend (no build; dev server only).

## Two processes

| Process | Port | Role |
|--------|------|------|
| **Bot + StaticFileServer** | 8888 | Serves `/output/*` (static files) and `/api/files` (list, delete, move). |
| **Vite dev server (this UI)** | 5173 | Serves the React app. Proxies `/api` and `/output` to 8888. |

Run both with one command from repo root:

```bash
bun run dev
```

This starts the bot and the webui dev server in parallel (concurrently).

## How they connect

1. You open the UI in the browser at **http://localhost:5173** (or http://&lt;LAN-IP&gt;:5173; Vite is started with `host: true`).

2. The React app runs in the browser and calls:
   - `GET /api/files/list?path=...` → list directory
   - `DELETE /api/files?path=...` → delete file/dir
   - `POST /api/files/move` with `{ from, to }` → move

3. Those requests use relative URLs (`/api/...`, `/output/...`). The **Vite dev server** is configured to **proxy** them to the backend:

   - `vite.config.ts`: `proxy: { '/api': 'http://localhost:8888', '/output': 'http://localhost:8888' }`
   - So when the browser requests `http://localhost:5173/api/files/list`, Vite forwards it to `http://localhost:8888/api/files/list` and returns the response.

4. **Preview (images/video/audio)**: The UI uses URLs like `/output/downloads/group123/photo.png`. The browser requests them from the same origin (5173), Vite proxies to 8888, and the backend serves the file from the `output` directory. So `<img src="/output/...">` and `<video src="/output/...">` work without the frontend ever knowing the backend port.

## Summary

- **Backend (8888)** does not serve the React app; it only serves `/output/*` and `/api/files`.
- **Frontend (5173)** is the only thing you open in the browser; it talks to the backend via the Vite proxy, so all fetch and asset URLs are same-origin (`/api/...`, `/output/...`).
- No build step: you always use the dev server for the UI.

## Separate deployment (webui and static file server on different hosts)

You can run the webui on one machine and the static file server (bot + file API + `/output/`) on another (e.g. another machine on the LAN).

1. **Build the webui** with the server base URL set:

   ```bash
   cd webui
   VITE_STATIC_SERVER_BASE=http://192.168.1.100:3456 bun run build
   ```

   Or create a `.env` (see `.env.example`) with:

   ```
   VITE_STATIC_SERVER_BASE=http://192.168.1.100:3456
   ```

   Then run `bun run build`. All file API and `/output/` requests will go to that base URL.

2. **CORS**: If the webui origin (e.g. `http://localhost:5173`) and the static server origin (e.g. `http://192.168.1.100:3456`) differ, the static file server must send `Access-Control-Allow-Origin` (or allow the webui origin). Configure CORS on the server or put both behind the same reverse proxy.
