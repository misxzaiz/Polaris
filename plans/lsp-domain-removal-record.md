# LSP / 代码智能域移除记录

> 决策：**整体移除，不做插件化** · 日期：2026-11-12
> 上游：`plans/core-slimdown-plugin-extraction-plan.md`（瘦身总盘）
> 前例：`plans/voice-domain-removal-record.md`（语音与播报域，同样直接移除）

## 一、决定

用户裁定：**LSP / 代码智能相关能力整体从宿主移除**，不迁移到插件。

删除后宿主不再有任何语言服务器进程管理、tree-sitter 索引引擎、语义导航浮层与相关设置页。编辑器退化为纯文本 / 语法高亮编辑，保留全部基础编辑能力。

## 二、为什么没走插件化

与技术无关——是**收益 / 成本比**不成立：

1. **LSP 客户端必须挂在编辑器实例上**。`@codemirror/lsp-client` 通过 CM6 扩展数组接入 `EditorView`，而 `EditorView` 由宿主创建与持有。插件要拿到它，需要新增「编辑器实例句柄」类槽位（比 H3 `EditorScmProvider` 更深一层的数据通道），等于为单一消费者开一个新契约。
2. **四处浮层都是顶层级 UI**。`DefinitionPeek` / `ReferencesPanel` / `SymbolPalette` 在 `App.tsx` 顶层 `<Suspense>` 挂载（跨主舞台的浮窗），不是席位内容，需新增 overlay 槽位。
3. **索引引擎是后台长驻服务**。`lsp_index` 持有每 workspace 独立 SQLite DB + 文件 watcher + tree-sitter 解析线程池（rayon），是宿主级资源，插件服务化要额外处理 DB 生命周期与多实例一致性。
4. **用户实际不用**。这是决定性理由：为一个不使用的功能新增 3 类宿主契约（编辑器句柄 / overlay 槽 / 长驻服务托管）不划算。

对比 Git 域：Git 有面板席位（可插件化）、有独立 MCP 工具面（AI 需要）、且用户高频使用——才值得造 `cap.pluginServiceManager.request` + `uiSlots`。

## 三、删除范围

两个可独立 revert 的提交：

### 前端（16 文件删除 + 18 文件修改）

| 模块 | 文件 | 行数 |
|---|---|---|
| 状态层 | `src/stores/lspStore.ts` | 821 |
| LSP 客户端 | `src/services/lsp/`（TauriIpcTransport、dirtyBuffers、indexNavigation、languageExtensions、lspFormatting、lspNavigation、lspReferences） | 891 |
| 命令层 | `src/services/tauri/lspService.ts` | 176 |
| 编辑器浮层 | `DefinitionPeek`、`ReferencesPanel`、`SymbolPalette`、`IndexStatusBadge`、`ctrlHoverLink` | 1,424 |
| 设置页 | `tabs/LspTab.tsx`、`IndexEngineSection.tsx` | 925 |
| 孤儿模块 | `stores/diagnosticsStore.ts`（唯一写入方为 lspStore）、`Settings/KeyCapture.tsx`（唯一消费方为 LspTab） | 死代码 |

接线改动：
- `App.tsx`：3 个 lazy + 3 个 `<Suspense>` 浮层
- `Editor.tsx`：`activateForFile` 激活块、`formatOnSave` 保存前格式化
- `useAppInit.ts`：启动加载 LSP 配置 + 索引 init、卸载时 `deactivateAll`
- `configStore.ts`：`lspIndex` 开关热切换（true→false 关索引、false→true 热启动）
- `editorSettingsStore.ts`：`formatOnSave`、`lspKeyDefinition` / `lspKeyReferences` 与 setter/reset
- `types/config.ts`：`PerformanceFeatures.lspIndex`
- `settings.json`（zh-CN / en-US）：`lsp` 节点 41 key + `nav.lsp`
- `performanceFeatures.ts`：`isLspIndexEnabled`
- `PerformanceTab`：`lspIndex` 开关项
- `package.json`：`@codemirror/lsp-client`

### 后端（8 文件删除 + 18 文件修改）

| 模块 | 文件 | 行数 |
|---|---|---|
| 进程管理 | `services/lsp.rs`（JSON-RPC 帧编解码 + 子进程生命周期） | 341 |
| 配置持久化 | `services/lsp_config_repository.rs`（`config_dir/lsp/servers.json`） | 137 |
| 命令层 | `commands/lsp.rs`（17 个 Tauri 命令） | 292 |
| 索引引擎 | `services/lsp_index/`（mod / builder / db / model / query / ranker / regex_fallback / service / watcher / extractor / java / java_test / schema.sql） | 2,800+ |

接线改动：
- `lib.rs`：17 条命令注册、`lsp_index:status` 事件桥
- `state.rs`：`lsp_manager` / `lsp_config` / `lsp_index_service` 三字段与两处初始化
- `web/api/ipc.rs`：12 条 `lsp_*` 路由分支 + 317 行 `dispatch_*` 实现
- `models/config.rs`：`PerformanceFeatures.lsp_index`
- `config_capability.rs`：`performance` 段 schema 与默认值
- `Cargo.toml`：`lsp-index` feature、`tree-sitter` / `tree-sitter-java` / `rayon` / `xxhash-rust` 四个可选依赖
- `web/integration_tests.rs`：AppState 测试字面量

## 四、刻意保留项

| 保留项 | 理由 |
|---|---|
| `rusqlite` | 被 `dialog_index` / `session_db` / `usage_db` / `storage/sqlite` 等六个模块使用，与索引无关 |
| `@codemirror/lint` | 通用 lint 扩展，语法高亮链路仍引用 |
| `docs/pitfalls/codemirror-lsp-extensions.md` | 历史踩坑记录，描述的是 CM6 扩展挂载机制的坑，教训仍有效（已加顶部注记） |
| `types/fileEditor.ts` 的 1-indexed 行 / 0-indexed 列注释 | 通用坐标约定，与 LSP 无关（注释里提到 LSP 只是举例） |
| `models/config.rs` `PerformanceFeatures` 其余字段 | 文件监听 / 调度器 / 语法高亮等仍在用 |

## 五、遗留待决

1. **宿主 AI 工具面从未暴露 LSP 能力**（无 `cap.lsp`），所以 AI 侧无影响——这次不需要像 `cap.voice` 那样处理工具面减项。
2. **插件仓无 LSP 插件**。检索 `Polaris-plugin/plugins/` 与 `index.json` 均无 lsp 相关条目，插件商城不受影响。
3. **旧配置兼容**：`performance.lspIndex` 字段删除后，旧配置文件里的该键被 serde 忽略（`PerformanceFeatures` 无 `deny_unknown_fields`），不会导致加载失败。前端 `zustand` persist 同理。

## 六、验收口径

- `npx tsc --noEmit` → exit 0
- `npx vitest run` → 全量通过（减少 1 个文件：`diagnosticsStore.test.ts`）
- `vite build` → 成功
- `cargo check --lib --tests` → exit 0
- 全仓 `grep -i lsp` 在 `src/` 与 `src-tauri/src/` 仅剩历史注释
