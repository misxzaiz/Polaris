import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Dev-only: 提供 /.polaris-dev/* 访问，映射到项目根 .polaris-dev/ 目录。
 *
 * 用途：桌面 dev HTTP 模式下，后端（debug 构建）把「实际端口 + token md5」写到
 * 项目根 .polaris-dev/server.json，前端通过此 middleware 自发现，实现动态端口适配。
 *
 * 为何用 middleware 而非 public/：public/ 内容在 `vite build` 时会被原样拷进产物，
 * 会把 dev 发现文件带进线上包。middleware 只在 dev server (configureServer) 生效，
 * build 时不存在，线上零污染。
 */
const devDiscoveryPlugin = () => ({
  name: "dev-discovery",
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      const url: string = req.url || "";
      if (!url.startsWith("/.polaris-dev/")) return next();
      const name = url.slice("/.polaris-dev/".length).split("?")[0];
      // 防路径穿越：只允许纯文件名
      if (!/^[\w.-]+$/.test(name)) {
        res.statusCode = 400;
        return res.end("bad request");
      }
      const file = path.resolve(__dirname, ".polaris-dev", name);
      fs.readFile(file, (err, data) => {
        if (err) {
          res.statusCode = 404;
          return res.end("not found");
        }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(data);
      });
    });
  },
});

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), devDiscoveryPlugin()],
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
    port: 9827,
    strictPort: true,
    host: host || true,
    // Dev-only: 把 /api 与 /api/ws 代理到后端 Web server。
    // 开发时浏览器打开 9827（vite dev server），页面里的 `/api/*` 请求经此转发到
    // 后端（tauri 内置 web server，`pnpm tauri:dev:web` 用 POLARIS_WEB_PORT 固定 9829），
    // WebSocket 一并升级代理。桌面 Tauri 端走 IPC 不经此；生产部署由 polaris-web
    // 前后端同源托管（同 9829），也不走 vite。
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.POLARIS_WEB_PORT || '9829'}`,
        changeOrigin: true,
        ws: true,
      },
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 9827,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Build optimization configuration
  build: {
    // Tree-shaking configuration
    // cryptoPolyfill 是纯副作用模块（顶层自执行 ensureCryptoSubtleDigest 注入
    // crypto.subtle.digest polyfill），包内无被引用的导出值时 Rollup 会误判为
    // 死代码整棵删除——实测生产 bundle 曾因此丢失 SHA-256 实现，导致非安全
    // 上下文 Web 端永远降级浏览器内置 TTS。此处显式声明其模块副作用，禁止移除。
    treeshake: {
      moduleSideEffects: (id) => {
        if (id.includes('cryptoPolyfill')) return true;
        // 其余模块走 Rollup 默认（无 package.json sideEffects 字段时默认 true）
        return undefined;
      },
    },
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
          // Mermaid diagram library - 动态加载，使用更精确的匹配
          // 注：mermaid 已排除在 optimizeDeps 之外，确保 rollup 能识别其子模块
          if (id.includes('node_modules/mermaid')) {
            // 各类图表渲染器单独拆分
            if (id.includes('diagrams/')) {
              return 'mermaid-diagrams';
            }
            // 核心运行时（解析器、渲染引擎、API）
            if (id.includes('mermaid/dist/')) {
              return 'mermaid-core';
            }
            return 'mermaid';
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
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@xterm/addon-web-links',
    ],
    // 排除大型动态加载库，让 rollup 在 manualChunks 中精确拆分
    exclude: [
      'mermaid',
      'katex',
    ],
  },
}));
