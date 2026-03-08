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
