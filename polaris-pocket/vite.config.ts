import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

// 主项目源码目录（Pocket 通过 @/ 引用主项目的 transport 层）
const mainSrc = path.resolve(__dirname, "../src");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @/ 指向主项目 src/，Pocket 自身代码使用相对路径
      "@": mainSrc,
    },
  },
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
