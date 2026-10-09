import { defineConfig } from 'vite';

const CORE_PORT = Number(process.env.SKY_PORT ?? 9825);

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${CORE_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://localhost:${CORE_PORT}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
