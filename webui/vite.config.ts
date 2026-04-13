import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Must match the bot StaticServer URL (see bot logs: `[StaticServer] Started on ...`).
  // If port 8888 is taken, the server binds to 8889+ — set this so /api and /output proxy correctly.
  const proxyTarget = (env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:8888').replace(/\/$/, '');

  return {
    base: '/files/',
    plugins: [react(), tailwindcss()],
    server: {
      host: true, // listen on 0.0.0.0 for LAN access
      allowedHosts: true,
      proxy: {
        '/api': { target: proxyTarget, changeOrigin: true },
        '/output': { target: proxyTarget, changeOrigin: true },
      },
    },
  };
});
