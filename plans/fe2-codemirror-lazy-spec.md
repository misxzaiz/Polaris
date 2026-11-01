# FE-2 切断 CodeMirror 静态 import 边（codemirror chunk 移出首载）

## 目标

codemirror chunk（实测 1,017,611 字节）从首载 modulepreload 列表移除。
根因：vite.config.ts manualChunks 把所有 `@codemirror/*` 钉进单一 `codemirror` chunk
（vite.config.ts:140-141），**任一**从 main 入口到 `@codemirror/*` 的静态边都会让整个
chunk 进首载。因此必须切断全部静态链，而非只改 App.tsx 一条。

## 静态边清单（grep 实测，src/ 全仓）

| # | 链 | 处理 |
|---|---|---|
| ① | App.tsx:11 → Editor/index.ts barrel → NarrowTabOverlay → EditorPanel → Editor.tsx | NarrowTabOverlay 改 React.lazy + Suspense(null) |
| ② | App.tsx → Layout/CenterStage.tsx:15 → barrel → EditorPanel → Editor.tsx | EditorPanel 改 lazy + Suspense(null)；BreadcrumbBar 深度路径 import |
| ③ | Editor/index.ts barrel re-export 7 符号连坐 | 移除传导 CodeMirror 的 3 个 re-export，保留轻组件 |
| ④⑤ | EditorPanel.tsx:6/8 → Editor.tsx / MarkdownEditor | 不动（位于懒 chunk 内部） |
| ⑥ | hooks/useAppInit.ts:35 → Editor/Editor.tsx（preloadLanguageExtensions） | 改动态 import()（preload 调用点本就异步） |
| ⑦ | useAppInit.ts:23 → stores/lspStore → @codemirror/lsp-client、@codemirror/view、ctrlHoverLink | useAppInit 改动态 import('@/stores/lspStore')（init Promise.all 处 + unmount cleanup 处） |
| ⑧ | stores/index → configStore.ts:17 → lspStore | configStore 性能热切换两处改动态 import |
| ⑨ | App.tsx:49 → plugin-system/index.ts:43 → builtinPlugins.ts:7 → editor/ → gitGutter/blameHover/changeNavigator → @codemirror/state、@codemirror/view | builtinPlugins 改动态 import('./editor') |

type-only 引用（StatusBar.tsx、types/fileEditor.ts、editorExtensionRegistry.ts、lspService.ts）
编译期擦除，不构成边，不动。

## 所有权与时序

- lspStore 唯一所有者不变，仅加载时机从「模块求值」变「首次使用时动态 import」；
  configStore 热切换与 useAppInit 的 LSP 初始化/清理均为 fire-and-forget 异步语义，时序不变。
- builtinPlugins 的 git 扩展注册改为微任务异步：消费方 Editor.tsx 在懒 chunk 内，
  用户打开文件的加载时序恒晚于启动微任务，collectExtensions 不会早于注册。
- 依赖方向不变：Editor 域 → store/service；本次只删「main → Editor 域」的静态边。

## 改动点

1. `src/App.tsx`：NarrowTabOverlay 改 lazy（fallback null，对齐 FileSearchModal 等 overlay 范式）。
2. `src/components/Layout/CenterStage.tsx`：EditorPanel 改 lazy（fallback null——TabContent
   case 'editor' 容器 flex-1 自带尺寸约束，null 不引起布局跳动）；BreadcrumbBar 深度路径。
3. `src/components/Editor/index.ts`：删除 EditorPanel/CodeMirrorEditor/NarrowTabOverlay re-export。
4. `src/hooks/useAppInit.ts`：⑥⑦ 动态化。
5. `src/stores/configStore.ts`：⑧ 动态化。
6. `src/plugin-system/builtinPlugins.ts`：⑨ 动态化。
7. EditorPanel 内部对 ./Editor、./MarkdownEditor 导入保持不动。

## 验收指标

- `pnpm typecheck` 零错误。
- grep 复核：`@codemirror` 值引用静态链无一从 main 入口可达；CodeMirrorEditor 静态
  import 仅存在于 EditorPanel/MarkdownEditor（任务书明示保留，位于懒 chunk 内部）。
- `pnpm build` 后 dist/index.html modulepreload 列表不含 codemirror chunk（硬验证）。

## 回滚方式

单 commit（perf(editor)），`git revert` 即可整体回滚；spec 文档独立 commit 不受影响。
