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
    // 强制所有 CodeMirror 相关包在整个依赖树中只解析到同一份实例。
    // CodeMirror 的 Facet / StateField 等内部使用 instanceof 做类型检查，
    // 出现两份 @codemirror/state 会直接报：
    //   "Unrecognized extension value in extension set"
    // 进而导致编辑器视图创建失败（看不到内容）、LSP 扩展也无法挂载（LSP 无效）。
    dedupe: [
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@codemirror/commands',
      '@codemirror/search',
      '@codemirror/autocomplete',
      '@codemirror/lint',
      '@codemirror/lsp-client',
      '@lezer/highlight',
      '@lezer/common',
      '@lezer/lr',
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
    // 把编辑器用到的所有 CodeMirror 包一起放进同一次 esbuild 预打包里，
    // 保证它们共享同一份 @codemirror/state 实例。
    // 不能再单独 exclude '@codemirror/lsp-client'，否则它会走原生 ESM 解析，
    // 而其它 CM 包已经被预打包了内联一份 state，造成双实例。
    include: [
      'react',
      'react-dom',
      '@tauri-apps/api/core',
      '@tauri-apps/api/event',
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@codemirror/commands',
      '@codemirror/search',
      '@codemirror/autocomplete',
      '@codemirror/lint',
      '@codemirror/lsp-client',
      '@lezer/highlight',
    ],
  },
}));
