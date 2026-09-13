import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { DEV_CLIENT_PORT, SERVER_PORT } from './src/shared/defaults';

// 開発時は画面を :5273 で出し、API と WebSocket はサーバ :7781 へ中継する。
export default defineConfig({
  plugins: [react()],
  server: {
    port: DEV_CLIENT_PORT,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${SERVER_PORT}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: true,
  },
});
