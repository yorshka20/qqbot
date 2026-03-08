import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/files/',
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // listen on 0.0.0.0 for LAN access
    proxy: {
      '/api': { target: 'http://localhost:8888', changeOrigin: true },
      '/output': { target: 'http://localhost:8888', changeOrigin: true },
    },
  },
})
