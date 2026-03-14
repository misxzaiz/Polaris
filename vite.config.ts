import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(__dirname, './src')}/` },
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Build optimization configuration
  build: {
    // Code splitting configuration
    rollupOptions: {
      // 多入口配置
      input: {
        main: './index.html',
        floating: './floating.html',
      },
      output: {
        // Manual chunk splitting to separate large dependencies
        manualChunks: (id) => {
          // React core libraries
          if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
            return 'react-vendor';
          }
          // CodeMirror editor related - 只在主窗口使用
          if (id.includes('@codemirror')) {
            return 'codemirror';
          }
          // Mermaid diagram library - 使用更精确的匹配
          if (id.includes('node_modules/mermaid')) {
            // 将 mermaid 的不同部分分离
            if (id.includes('mermaid/dist/diagrams')) {
              return 'mermaid-diagrams';
            }
            if (id.includes('mermaid/dist/')) {
              return 'mermaid-core';
            }
            return 'mermaid';
          }
          // Cytoscape graph library
          if (id.includes('cytoscape')) {
            return 'cytoscape';
          }
          // KaTeX math library
          if (id.includes('katex')) {
            return 'katex';
          }
          // Markdown and utility libraries
          if (id.includes('marked') || id.includes('dompurify') || id.includes('zustand')) {
            return 'utils';
          }
          // Tauri API
          if (id.includes('@tauri-apps/api')) {
            return 'tauri';
          }
          // Lodash and other utility libraries
          if (id.includes('lodash') || id.includes('clsx') || id.includes('class-variance-authority')) {
            return 'lodash';
          }
        },
        // Set separate CSS file for each chunk
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'main.css') return 'assets/main-[hash].css';
          return 'assets/[name]-[hash][extname]';
        },
        // Chunk file naming
        chunkFileNames: 'assets/[name]-[hash].js',
        // Entry file naming - 分别命名主窗口和悬浮窗
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'floating') {
            return 'assets/floating-[hash].js';
          }
          return 'assets/main-[hash].js';
        },
      },
    },
    // Chunk size warning threshold (kb) - 提高到 1500kb 以适应大型依赖库
    chunkSizeWarningLimit: 1500,
    // Minify configuration
    minify: 'esbuild',
    // Target environment
    target: 'es2020',
    // Sourcemap configuration
    sourcemap: false,
  },

  // Dependency pre-build optimization
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      '@tauri-apps/api/core',
      '@tauri-apps/api/event',
    ],
  },
}));
