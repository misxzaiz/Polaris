# spec：启动 Bundle「mermaid 静态泄漏」根治（manualChunks 钉位）

- 日期：2026-11-01
- 类型：构建配置 / 冷启动性能（无行为、协议、UI 改动）
- 改动文件：`vite.config.ts`（`build.rollupOptions.output.manualChunks` 两处钉位规则）
- 目标：弱性能设备冷启动流畅。启动 JS 解析/执行量砍半。

## 1. 问题（实测）

生产构建（`pnpm build`）后 `dist/index.html` 对入口静态闭包做 modulepreload，实测包含：

```
main 1,683 kB + mermaid-core 3,081 kB + mermaid 302 kB + codemirror 1,018 kB
+ react-vendor 332 kB + utils 74 kB + tauri 19 kB ≈ 6.5 MB（gzip ≈ 1.93 MB）
```

mermaid 本应纯按需（`MermaidDiagram` / `DeferredMermaidDiagram` 内 `await import('mermaid')`），
实际却在**每次冷启动**全量解析执行——3.4 MB 高密度 JS（cytoscape/d3/dagre/parser），
弱机主线程阻塞数百 ms 级，另增 ~40-60 MB 堆占用。

## 2. 根因（两条，均为 manualChunks 默认分配陷阱）

Rollup 对未命中 manualChunks 规则的模块按遍历顺序默认分配 chunk，会产生「小模块
落进大懒 chunk → 入口被迫静态 import 整个大懒 chunk」的反向泄漏：

1. **`\0vite/preload-helper.js`**（Vite 动态导入预加载助手，几百字节）被所有含
   dynamic import 的模块静态依赖（main 内 464 个调用点）。实测落进 mermaid-core
   chunk → main 为拿它静态 import mermaid-core。
2. **`@mermaid-js/parser`**（mermaid 解析器子包，路径 `node_modules/@mermaid-js/parser`）
   不匹配旧规则 `id.includes('node_modules/mermaid')`。实测其动态导入 facade
   （0 字节命名空间壳，如 `{InfoModule, createInfoServices}`）落进 main chunk，
   壳需要从 mermaid-core 拿 27 个真实导出 → main 静态 import mermaid-core。

## 3. 修复

`manualChunks` 增加两条钉位规则（顺序在 react 规则之前）：

1. `id.includes('vite/preload-helper')` → `'react-vendor'`（启动必载、被入口静态依赖）。
2. mermaid 全生态（`node_modules/mermaid`、`@mermaid-js/`、`cytoscape`、`dagre`、
   `layout-base`、`lodash-es`——均仅被 mermaid 引用，src 零引用已核实）→
   `diagrams/` 走 `mermaid-diagrams`，其余统一 `mermaid-core`。

## 4. 验收（已执行）

- `pnpm build`：index.html modulepreload 只剩 `utils / react-vendor / tauri / codemirror`；
  main.js 静态 import 闭包无任何 mermaid chunk；mermaid-core 仍可经 main 内
  `import("./mermaid-core-*.js")` 动态到达（懒加载链路完好）。
- `pnpm typecheck`：通过。
- `pnpm test:run`：183 文件 / 2455 tests 全部通过（14 skipped 为存量）。

## 5. 效果（实测）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 启动 JS（minified） | ~6,509 kB | ~3,048 kB |
| 启动 JS（gzip） | ~1,926 kB | ~966 kB |
| modulepreload 数 | 7（含 mermaid 两个） | 4 |

启动解析量 **-3.4 MB（-52%）**，gzip 传输 **-48%**。mermaid（3.3 MB）恢复纯按需。

## 6. 后续项（已勘探、未实施）

- **codemirror chunk（993 kB / gzip 344 kB）仍被入口静态引入**。eager 链有三条，
  chunk 级懒化是「全或无」（任一静态引用即整体加载），须一并切断：
  1. `App → Layout/CenterStage → components/Editor barrel → Editor.tsx`（CodeMirrorEditor）
  2. `App → hooks/useAppInit → stores/lspStore`（`@codemirror/lsp-client` + `EditorView`）
  3. `App → plugin-system → editor 扩展注册`（gitGutter/blameHover/changeNavigator）
  形态：懒化 CodeMirrorEditor + lspStore 动作内动态 import + 扩展注册改惰性工厂；
  需编辑器/LSP/插件三域回归冒烟。
- **locales（zh-CN+en-US 双语全量静态，~267 kB rendered）**：非活跃语言懒加载，低风险。
- **zod（~233 kB rendered）**：仅 `plugin-system/schema.ts`（manifest 契约校验），
  消费方 `pluginDiscoveryService` 启动即用；懒化需重构校验为异步路径，性价比待评估。
