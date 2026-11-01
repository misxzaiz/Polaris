# FE-2 CodeMirror 移出启动路径：切断静态 import 边（启动 JS -33%）

> 多 agent 评审第 4 名方案（5/25，评语「唯一有实测产物数字的方案」）。2026-11-01 立项。
> 证据已在 main@d22e4ce7 当日全部实读复核（行号为当前实况）；实施前仍须重定位。
> 硬数字（评审轮实测 dist）：`codemirror-D05K7m4i.js` 1,017,611B 经 main chunk 静态 import + index.html modulepreload 进首屏路径。

---

## 一、结论

CodeMirror 全家（view/state/lsp-client/language 包 ~1MB）被 5 条静态边拖进启动图：首帧解析/编译 1MB 编辑器代码，而编辑器在「打开文件 tab」前完全用不到。本方案把 5 条边全部改为**按需加载**（React.lazy 或动态 import），CodeMirror 及 EditorPanel 链整体移出首屏 chunk。范式在库内现成：App.tsx 已有 25+ 个 `lazy(() => import(...))` 先例，`configStore.ts:440` 已有 `import('@/components/Editor/Editor').then(...)` 动态先例。

## 二、五条边与精确切法（实施 checklist，逐条打勾）

| # | 现状（已实读） | 切法 |
|---|---|---|
| 1 | `App.tsx:11` `import { NarrowTabOverlay } from './components/Editor'`（barrel :6 静态拖出 CodeMirrorEditor） | 改直引 `from './Editor/NarrowTabOverlay'`，绕开 barrel |
| 2 | `CenterStage.tsx:15` `import { EditorPanel, BreadcrumbBar } from '@/components/Editor'` | 拆两条：`BreadcrumbBar` 直引 `@/components/Editor/BreadcrumbBar`（实施时验证其自身不引 codemirror）；`EditorPanel` 改 `React.lazy` + `<Suspense fallback={<编辑区骨架/>}>`（骨架=纯 div 占位，无新依赖）。CenterStage 本体**不动**（首帧 UI，不 lazy 组件本体） |
| 3 | `NarrowTabOverlay.tsx:25` `import { EditorPanel } from './EditorPanel'` | 同款 `React.lazy` + Suspense（overlay 仅窄屏浮 tab 打开时才挂载，启动不触达） |
| 4 | `useAppInit.ts:35` 静态引 `preloadLanguageExtensions`（:145 idle 时调用） | 改动态 `import('@/components/Editor/Editor').then(m => m.preloadLanguageExtensions()).catch(...)`，照抄 `configStore.ts:440` 先例；移除顶部静态 import |
| 5 | `lspStore.ts:11-17` 顶层值引 `@codemirror/lsp-client`（LSPClient/languageServerSupport/serverDiagnostics）+ `@codemirror/view`（EditorView/keymap）；`import type { Extension } from '@codemirror/state'` 是纯类型（擦除，不动） | 模块级惰性加载器：`let codemirrorDeps: Promise<{...}> \| null = null; function ensureCodemirrorDeps() { return (codemirrorDeps ??= Promise.all([import('@codemirror/lsp-client'), import('@codemirror/view')]).then(([lsp, view]) => ({...lsp, ...view}))); }`；所有用点改 `await ensureCodemirrorDeps()`（store actions 本就是 async 场景；实施者逐用点核实同步用点，如有则改造或说明） |

> 边 1-4 是「谁拖谁」的主干；边 5 是评审轮 dist 静态引链的另一半（lspStore 被 useAppInit 静态引，进入启动图）。
> 全仓静态引 `@/components/Editor` barrel / `Editor/Editor` 的启动图调用方经 grep 枚举**仅上述 4 处**（App.tsx:11、CenterStage.tsx:15、useAppInit.ts:35、configStore.ts:440 已动态）——实施后以 dist 断言为最终裁判，不靠 grep 自证。

## 三、目标与非目标

**目标**：① dist 产物中 CodeMirror 不再出现在 index.html modulepreload 与 main chunk 静态引链；② main chunk raw 缩小 ≥900KB（实测基线 1,017,611B，留余量）；③ 编辑器功能不回归（打开文件可编辑、窄屏 overlay 正常、LSP 面板正常）。

**非目标**：不改 vite 配置（manualChunks 现状已把 codemirror 切成独立 chunk，问题只在静态边）；不动 DiffViewer/BrowserPanel/ImagePreview 等 CenterStage 其他静态依赖（若 dist 断言暴露新的大头另立项）；零后端改动。

## 四、验证方法

```bash
pnpm typecheck && pnpm lint          # 前端门槛
pnpm build                            # 产 dist
# dist 断言（实施者自查 + 验收官复跑）：
#   a. dist/index.html 的 modulepreload 列表不含 codemirror
#   b. dist/assets/main-*.js 不含 from"./codemirror- 静态引（动态 import 的 chunk 映射串除外——以字节 grep "codemirror" 判定形态）
#   c. main-*.js 体积对比基线：构建后与 git stash 基线各跑一次 pnpm build，raw 差值 ≥900KB
```

**行为冒烟（验收官执行，实施者不承担）**：vite preview 起 dist → 浏览器自动化：① 应用正常启动渲染（无白屏/报错）；② 打开一个文件 tab → EditorPanel chunk 按需拉取、编辑器渲染可输入；③ 窄屏 overlay（NarrowTabOverlay）可用；④ LSP 相关面板打开不报错（边 5 动态化后首用加载）。

## 五、风险与回滚

| 风险 | 缓解 |
|---|---|
| Suspense 首开闪变 | fallback 为编辑区骨架（同尺寸占位）；本地 chunk 加载毫秒级 |
| lspStore 动态化引入行为差异 | type-only/value import 分离核实；冒烟④覆盖；async action 语义不变 |
| 漏边（dist 断言不过）| 断言即裁判：不过则按 main chunk 中 codemirror 引用形态反查调用方补切，禁止放宽断言 |
| 回滚 | 单 PR revert；零协议/零后端 |

## 六、预期收益

启动 JS raw -1,017,611B（-33%，评审轮同法实测）；首帧解析/编译 CPU 相应下降；编辑器、LSP 功能零损失（首次使用毫秒级延迟）。

---

## 七、实施记录（perf(editor) 6e64fcdc，2026-11-01）

按本 spec 落盘，三处取舍 + 一处增量（均已在实现注释中说明根因）：

1. 边 1 改为 `React.lazy`（而非直引 NarrowTabOverlay 深度路径）：App.tsx 既有 25+ lazy 范式同构，且把 overlay 本体也移出首载；fallback null 对齐 FileSearchModal 等既有 Suspense(null) 先例。
2. 边 5 改为整仓动态 `import('@/stores/lspStore')`（useAppInit init/cleanup + configStore 热切换两处，共 3 个调用面）：比 lspStore 内部惰性加载器侵入面小——后者需 async 化 `getExtensionsForClient`/`getIndexExtensions` 等同步用点，风险更高。构建证实 lspStore 已成独立懒 chunk（`lspStore-*.js`）。
3. Suspense fallback 选 null 而非编辑区骨架：TabContent case 'editor' 容器 flex-1 自带尺寸约束（尺寸由外层 flex 决定），null 前后占位不变、零跳动。
4. **增量边 ⑥⑧⑨（评审清单外，grep 实测补切）**：useAppInit.ts:35 静态引 `Editor/Editor.tsx`（preloadLanguageExtensions）；configStore.ts:17 静态引 lspStore；plugin-system/index.ts:43 → builtinPlugins.ts:7 → editor/gitGutter 等的 `@codemirror/state`、`@codemirror/view` 值引用。任一残留都会经 manualChunks 把整个 codemirror chunk 拽回首载。

验证（本 worktree 实测）：`pnpm typecheck` 零错误；改动六文件 eslint 0 error；`pnpm build` 后 dist/index.html modulepreload 仅 utils/react-vendor/tauri 三项、入口 main chunk 无指向 codemirror 的静态 import 语句（仅动态 import 的 `__vite__mapDeps` 映射串）。§四断言 c（基线重建比 raw 差值）未跑，留验收官复跑。
