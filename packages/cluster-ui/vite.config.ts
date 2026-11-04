import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = (env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:3200').replace(/\/$/, '');

  return {
    base: '/',
    plugins: [react(), tailwindcss()],
    server: {
      host: true,
      allowedHosts: true,
      proxy: {
        '/api': { target: proxyTarget, changeOrigin: true },
        '/health': { target: proxyTarget, changeOrigin: true },
      },
    },
  };
});
