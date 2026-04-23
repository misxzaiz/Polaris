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
    // 强制所有 @codemirror 包解析到项目根 node_modules 中的同一实例
    // 避免 @codemirror/lsp-client 内部依赖链导致 @codemirror/state 被加载为不同实例
    // CodeMirror 使用 instanceof 检查 extension 类型，多实例会触发
    // "Unrecognized extension value" 错误
    dedupe: [
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@codemirror/autocomplete',
      '@codemirror/lint',
      '@codemirror/search',
      '@codemirror/commands',
      '@lezer/highlight',
      '@lezer/common',
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
      input: './index.html',
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
        // Entry file naming
        entryFileNames: 'assets/main-[hash].js',
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
      // CodeMirror LSP client — 必须与其他 CM6 包在同一预构建上下文中，
      // 否则 @codemirror/state 会被加载为两个不同实例，导致 instanceof 检查失败
      '@codemirror/lsp-client',
    ],
  },
}));
