import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: "./index.html",
      output: {
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/main-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
    minify: "esbuild",
    target: "es2020",
    sourcemap: false,
  },
});
