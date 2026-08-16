# Git 功能插件化方案

> 状态：规划中
> 日期：2026-08-16
> 目标：将 Polaris 主项目内硬编码的 Git 功能抽取为外部插件，置于 `Polaris-plugin` 仓库，并尽量支持脱离 Polaris 独立运行。

---

## 1. 背景与现状

### 1.1 当前 Git 功能盘点

主项目 Git 功能分布三层，合计约 **1450 行 Rust + 数千行 TS**：

| 层 | 位置 | 规模 | 实现方式 |
|---|---|---|---|
| 后端服务 | `src-tauri/src/services/git/` | 16 个子模块（status/diff/branch/tag/rebase/cherry_pick/revert/commit/remote/log/stash/reset/gitignore/executor/utils） | git2 (libgit2 0.18) + vendored-openssl |
| 后端命令 | `src-tauri/src/commands/git.rs` | 55 个 `#[cfg_attr(feature="tauri-app", tauri::command)]` | 全部门控 `tauri-app` feature |
| 后端模型 | `src-tauri/src/models/git.rs` | 688 行，30+ 结构体/枚举 | 与 TS `src/types/git.ts` 一一镜像 |
| Web 桥接 | `src-tauri/src/web/api/ipc.rs` | 55 个 `dispatch_git_*` + 一条 `cmd.starts_with("git_")` fallback 路由 | HTTP/LAN 通道 |
| 前端 Store | `src/stores/gitStore/` | 10 个 Zustand slice（status/branch/tag/commit/stash/remote/pr/gitignore/advanced/utility） | 直接 `invoke('git_*')` |
| 前端组件 | `src/components/GitPanel/` | 16 个组件（主面板/状态头/变更列表/提交输入/快捷操作/历史/分支/远程/标签/Stash/Gitignore/Blame/详情） | 通过 useGitStore 取数据 |
| 通用 Diff | `src/components/Diff/` | DiffViewer 编排 + Web Worker 异步 diff + split 窗口化 | 纯展示，零 Git IPC 依赖 |
| Chat 集成 | `GitSuggestion.tsx` / `gitContextService.ts` / `commitMessageChat.ts` / `ContextChip.tsx` | `@git` 联想 / commit/diff 上下文芯片 / AI 提交信息生成 | Git→Chat 桥，直接调 git IPC |
| 视图/Tab | `viewStore` (`showGitPanel`/`gitPanelWidth`) / `tabStore` (`TabType='git'`/`openGitTab`) / `CenterStage.tsx` (`tab.type==='git'` 渲染分支) | 硬编码在核心 store |
| 文件树 | `GitStatusIndicator.tsx`（工具栏徽章） | 分支徽章 + 未提交计数 | 深耦合 useGitStore + useViewStore |
| 配置 | `config.git_bin_path` (TS+Rust) | 可选 Git 二进制路径 | 不存 user.name/email（由系统 git 承担） |

### 1.2 关键事实（决定方案走向）

1. **没有编辑器 gutter Git 标记、没有文件树文件名 Git 着色** —— 两处最易深度耦合的点不存在，抽取难度低于预期。
2. **DiffViewer 是纯展示组件**（props 驱动，零 Git IPC）—— 可零成本迁移为共享/独立组件。
3. **Git IPC 调用分散在三处**：gitStore slices（主，50+ invoke）、gitContextService（Chat 上下文，3 invoke）、组件直接 invoke（CommitInput/QuickActions，2 处）—— 抽取前需先聚合为单一 service 层。
4. **后端是单块 git2/libgit2 实现**，55 个 tauri::command 硬注册在 `lib.rs` invoke_handler，web ipc.rs 同步维护 dispatch_* —— 这是最大的硬编码块。
5. Git 视图**已经半插件化**：`toolSwitcherData.tsx` 从 `pluginRegistry.listViewContributions('activityBar')` 派生面板按钮，git 视图已走插件 view contribution 机制。

### 1.3 插件体系能力边界（Polaris-plugin 现状）

| 扩展点 | 现状 | 承载 Git 的适配性 |
|---|---|---|
| `contributes.views` (activityBar) | ✅ append/shadow/chain | git 面板可直接作为 view 注册 |
| `contributes.panel` | ✅ esbuild 自包含 bundle，`panelType` 注册为 LeftPanelType | git 面板组件可整体打包 |
| `contributes.mcpServers` | ✅ stdio MCP server | git 操作可封装为 MCP 工具供 AI 调用 |
| `contributes.chatCards` | ✅ result/interaction | diff/blame 工具结果可自定义卡片 |
| `contributes.services` | ✅ http/stdio/worker 后台进程 + 健康检查 + 自动重启 + `{{workspacePath}}` 占位 | 可承载独立 git HTTP 服务进程（独立运行关键） |
| `contributes.styles` | ✅ CSS 注入 | git 面板样式覆盖 |
| `contributes.toolProviders` (Capability Seam P1) | ✅ shell/fs/compaction/subagent 四 trait | 需新增 "git" capability 才能承载 |
| UI Slot (P3) | ✅ append/shadow/chain | 当前无 "git.panel" 命名 slot，需约定 |

**插件面板的数据通道（硬约束）：**
- MCP 工具（AI 调用，非面板直接调）
- `window.__POLARIS_PLUGIN_SERVICES__` 管自己的后台服务
- `fetch` 自己的 http 服务
- **`window.__TAURI_INTERNALS__.invoke` 直调 Tauri 命令**（marketplace 插件实测可行）—— 但依赖宿主暴露该内部 API，web-only/独立运行时不可用

---

## 2. 方案选型

### 2.1 三种抽取深度

| 方案 | 描述 | 独立运行 | 工作量 | 风险 |
|---|---|---|---|---|
| **A. 浅抽取（仅前端）** | 前端 GitPanel + gitStore 迁到插件，后端 git_* 命令保留核心，插件面板通过 `__TAURI_INTERNALS__.invoke` 调原命令 | ❌ 强依赖宿主 | 中 | 低，但未真正解耦 |
| **B. 中抽取（前端 + MCP）** | 前端迁插件，后端 git 逻辑封装为插件自带的 MCP server / http service 进程，主项目后端 git2 代码删除 | ✅ 插件进程独立 | 高 | 中，需重写后端为 Node/Rust 进程 |
| **C. 深抽取（全栈独立）** | B 基础上，git 引擎从 git2 换 isomorphic-git（纯 JS）或独立调 git CLI，插件完全自包含，可脱离 Polaris 单跑 | ✅✅ 完全独立 | 很高 | 高，isomorphic-git 能力边界需验证 |

### 2.2 推荐路线：B 为主、C 为可选增强

**核心理由：**
- 方案 A 未真正解耦（面板仍直调宿主命令），只是代码搬家，不符合"插件化"本意。
- 方案 B 把后端 git 逻辑移出主项目核心，主项目回归"纯编辑器/AI 容器"，Git 成为真正可选能力——这是插件化的本质目标。
- 方案 C 的"完全独立"是锦上添花，但 isomorphic-git 对 rebase/cherry-pick/merge 冲突等高级操作支持薄弱（纯 JS 重实现，无 libgit2 的合并引擎），盲目换引擎会丢失主项目现有能力。**建议 B 落地后，再针对"独立运行"子集做 C 的增量。**

### 2.3 独立运行可行性裁定

| 独立运行形态 | 可行性 | 说明 |
|---|---|---|
| 插件自带 git http service，面板 fetch 本服务 | ✅ 可行 | services 机制原生支持，进程隔离 |
| 插件面板脱离 Polaris 宿主单独跑（如独立 web app） | ⚠️ 部分可行 | 面板 bundle 自包含 React，但依赖 `__TAURI_INTERNALS__.invoke` 与宿主 store 的部分需替换为 http service 调用 |
| 完全离线 git 客户端（无 git CLI 依赖） | ⚠️ 受限 | isomorphic-git 可做到 clone/commit/push，但 rebase/merge 冲突需 libgit2 或 git CLI |
| 调系统 git CLI 的独立 git 客户端 | ✅ 可行 | 用 Node child_process 调 git，功能完整，但要求宿主机装 git |

**结论：** 独立运行的"成本"主要在后端引擎选型。**推荐分两档：**
- **宿主内运行档（默认）：** 插件自带 Node http service，内部调系统 git CLI（child_process），功能与现有 git2 对齐，宿主无需装 git2 依赖。
- **完全独立档（可选）：** 同一 service 进程可脱离 Polaris 单独启动（`node server.js --standalone`），提供 http API + 静态面板，作为轻量 web git 客户端。成本适中，建议作为 Phase 3 增量。

---

## 3. 目标架构（方案 B + 独立运行增量）

```
Polaris-plugin/plugins/polaris-git/
├── plugin.json                 # manifest：views + panel + mcpServers + services
├── update.json
├── src/                        # 前端面板源码
│   ├── Panel.tsx               # 主面板（从主项目 GitPanel 迁移）
│   ├── GitStatusHeader.tsx
│   ├── FileChangesList.tsx
│   ├── CommitInput.tsx
│   ├── HistoryTab.tsx
│   ├── BranchTab.tsx
│   ├── RemoteTab.tsx
│   ├── TagsTab.tsx
│   ├── StashTab.tsx
│   ├── GitignoreTab.tsx
│   ├── BlameView.tsx
│   ├── CommitDetailsPane.tsx
│   ├── Diff/                   # 从主项目 src/components/Diff/ 迁移（纯展示，零成本）
│   ├── stores/                 # 从主项目 gitStore 迁移，invoke 改为 fetch 本插件 http service
│   └── types.ts                # 从主项目 types/git.ts 迁移
├── dist/
│   └── panel.js                # esbuild 自包含 bundle
├── server/                     # 后端 git service（Node）
│   ├── index.js                # http server（express/fastify），--standalone 可独立跑
│   ├── git-engine.js           # git 操作抽象层（实现 A：child_process 调 git CLI）
│   ├── git-engine-isomorphic.js # 实现 B（可选）：isomorphic-git（独立运行档）
│   └── routes/
│       ├── status.js
│       ├── diff.js
│       ├── branch.js
│       ├── commit.js
│       ├── remote.js
│       ├── log.js
│       ├── stash.js
│       └── advanced.js         # rebase/cherry-pick/revert/reset
├── mcp/
│   └── server.js               # MCP server，把 git 操作暴露给 AI（调本插件 http service）
└── polaris-git.zip
```

### 3.1 plugin.json（草案）

```jsonc
{
  "id": "polaris.git",
  "name": "Git 工作台",
  "version": "1.0.0",
  "description": "完整的 Git 工作台：状态、变更、提交、分支、合并、rebase、历史、blame、远程、stash、.gitignore。自带独立 git 服务，可脱离 Polaris 单独运行。",
  "enabledByDefault": true,
  "contributes": {
    "views": [{
      "id": "git.panel",
      "area": "activityBar",
      "panelType": "git",
      "icon": "GitBranch",
      "labelKey": "labels.gitPanel",
      "labelDefault": "Git",
      "order": 20
    }],
    "panel": { "entry": "./dist/panel.js", "supportsFullscreen": true },
    "mcpServers": [{
      "id": "git-server",
      "transport": "stdio",
      "command": "node",
      "argsTemplate": ["{{pluginDir}}/mcp/server.js"]
    }],
    "services": [{
      "id": "git-http",
      "type": "http",
      "command": "node",
      "argsTemplate": ["{{pluginDir}}/server/index.js", "{{port}}", "{{workspacePath}}"],
      "healthCheck": "/__health",
      "autoStart": true,
      "restartOnFailure": true,
      "maxRestarts": 3,
      "description": "Git 操作 HTTP 服务"
    }],
    "chatCards": [
      { "id": "git-diff", "matchTool": "git_diff", "render": "./dist/panel.js", "exportName": "DiffChatCard" },
      { "id": "git-blame", "matchTool": "git_blame", "render": "./dist/panel.js", "exportName": "BlameChatCard" }
    ]
  },
  "permissions": { "aiToolAccess": true, "network": true, "filesystem": true }
}
```

### 3.2 数据流（核心解耦点）

```
插件面板 (dist/panel.js)
   │
   ├─ 面板内交互 ──> fetch http://127.0.0.1:{port}/git/status?path=...
   │                    │
   │                    └─ git-http service (server/index.js)
   │                          └─ git-engine.js (child_process 调 git CLI)
   │
   ├─ AI 工具调用 ──> MCP server ──> fetch 本插件 http service（同进程或同机）
   │
   └─ 文件树 GitStatusIndicator ──> fetch 本插件 http service（需主项目开放文件树 slot）
```

**关键：面板不再 `invoke('git_*')`，改走 `fetch` 自己的 http service。** 这是面板能脱离宿主独立运行的前提。

---

## 4. 阶段实施计划

### Phase 0：主项目解耦预备（~3 人日）

**目标：** 在不迁出任何代码前，先把主项目里的 Git 耦合点收敛为可替换的接口。

| 任务 | 说明 |
|---|---|
| 0-1 聚合 IPC 层 | 新建 `src/services/gitService.ts`，把 gitStore slices、gitContextService、组件直接 invoke 三处的 `invoke('git_*')` 全部收口到此 service。gitStore 改为调 gitService。 |
| 0-2 viewStore/tabStore 泛化 | `showGitPanel`/`gitPanelWidth` 改为插件可注册的 `panelStates` map；`TabType='git'` 改为 `TabType=string` + 插件 Tab 渲染器注册机制。 |
| 0-3 CenterStage Tab 渲染泛化 | `tab.type==='git'` 分支改为查 `pluginTabRenderers[tab.type]`，git 渲染器由插件注册。 |
| 0-4 文件树工具栏 slot | `FileExplorer` 工具栏开放 `toolbarSlot`，`GitStatusIndicator` 改为通过 slot 注册而非硬 import。 |
| 0-5 Chat 开放三个注册点 | `@` 命令注册点（GitSuggestion）、上下文芯片注册点（ContextChip commit/diff）、AI 会话 hook 注入点（commitMessageChat）。 |

**验收：** 主项目 Git 功能行为零变化；所有 git IPC 调用收口到 gitService.ts 单一入口；viewStore/tabStore/CenterStage/FileExplorer 不再出现 `git` 硬编码字面量。

### Phase 1：插件骨架 + 后端 service（~6 人日）

**目标：** 在 Polaris-plugin 落地 `polaris.git` 插件骨架，后端 git service 用 Node 调 git CLI 实现核心操作。

| 任务 | 说明 |
|---|---|
| 1-1 插件脚手架 | `plugins/polaris-git/` 目录、plugin.json、esbuild 构建配置（参考 marketplace 插件）。 |
| 1-2 git-http service | `server/index.js`：fastify http server，路由按主项目 git.rs 55 命令一一对应。`--standalone` 启动模式：附加静态面板托管。 |
| 1-3 git-engine (CLI 实现) | `server/git-engine.js`：child_process 调系统 git，porcelain 输出解析。覆盖 status/diff/branch/commit/stage/unstage/log/stash/tag/remote/push/pull/blame/reset。 |
| 1-4 高级操作 | rebase/cherry-pick/revert：调 git CLI，冲突时返回 conflicted files 列表供前端渲染冲突解决 UI。 |
| 1-5 端口与 workspacePath | service 启动收 `{{port}}` `{{workspacePath}}`，面板通过 `window.__POLARIS_PLUGIN_SERVICES__.getStatus` 拿端口。 |

**验收：** `node server/index.js 9870 /path/to/repo` 启动后，`curl http://127.0.0.1:9870/git/status?path=...` 返回与主项目 `git_get_status` 一致的 JSON。

### Phase 2：前端面板迁移（~8 人日）

**目标：** 把主项目 GitPanel + DiffViewer + gitStore 迁到插件，面板改走 http service。

| 任务 | 说明 |
|---|---|
| 2-1 类型迁移 | `src/types/git.ts` → `plugins/polaris-git/src/types.ts`。 |
| 2-2 DiffViewer 迁移 | `src/components/Diff/` 整体迁入 `plugins/polaris-git/src/Diff/`（纯展示，零改动）。 |
| 2-3 gitStore 迁移改造 | `src/stores/gitStore/` 10 slice 迁入，`invoke('git_*')` 全部替换为 `fetchGit(action, params)` 调本插件 http service。 |
| 2-4 GitPanel 组件迁移 | 16 个组件迁入，保持 props/store 接口不变。 |
| 2-5 Chat 集成迁移 | GitSuggestion / gitContextService / commitMessageChat 迁入插件，通过 Phase 0-5 开放的注册点挂回 Chat。 |
| 2-6 i18n 迁移 | `locales/*/git.json` 迁入插件 contributes.styles + 插件自带 i18n。 |

**验收：** 插件安装后，Polaris 内 Git 面板功能与迁移前一致；面板不再 import 任何主项目 `@/` 路径。

### Phase 3：主项目瘦身 + 独立运行（~5 人日）

**目标：** 删除主项目 Git 硬编码，插件支持 `--standalone` 独立跑。

| 任务 | 说明 |
|---|---|
| 3-1 删除主项目后端 git | 移除 `services/git/`、`commands/git.rs`、`models/git.rs`、`Cargo.toml` 的 git2 依赖、`lib.rs` 的 55 命令注册、`web/api/ipc.rs` 的 dispatch_git_*。 |
| 3-2 删除主项目前端 git | 移除 `components/GitPanel/`、`components/Diff/`（若 DiffViewer 被非 git 场景复用则保留为通用组件）、`stores/gitStore/`、`types/git.ts`、`services/gitContextService.ts`、`commitMessageChat.ts`。 |
| 3-3 内置插件注册 | `builtinPlugins.ts` 注册 `polaris.git` 为内置插件（用户可禁用），或仅作远程插件不内置。 |
| 3-4 独立运行档 | `server/index.js --standalone`：托管 `dist/panel.js` 静态资源 + http API，浏览器打开即用，不依赖 Polaris。 |
| 3-5 可选：isomorphic-git 引擎 | `git-engine-isomorphic.js`：为无 git CLI 环境（纯浏览器/Tauri web-only）提供 clone/commit/push 子集，功能受限但真正零原生依赖。 |

**验收：** 主项目 `cargo check --lib` 不含 git2；`grep -ri 'git_' src/` 仅剩通用 .gitignore 感知（ignore crate）；`node plugins/polaris-git/server/index.js --standalone` 可独立启动并访问。

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| git CLI 实现与 git2 行为不一致（porcelain 输出格式、错误码） | 功能回归 | Phase 1 每个路由写 golden test：对同一仓库同时跑 git2 命令与 CLI 实现，比对 JSON。保留主项目 `git.rs` 作为参照直到 Phase 3 删除。 |
| rebase/merge 冲突解决 UI 依赖 libgit2 的 index 操作 | 高级操作体验下降 | CLI 实现走 `git rebase` 真实子进程，冲突时返回 `git status` 的 unmerged paths，前端渲染冲突解决面板调 `git checkout --theirs/--ours`。不依赖 libgit2 内存 index。 |
| 面板改 fetch http service 后，Tauri 打包模式下 http 服务端口可能被防火墙拦 | 面板无法取数据 | service 绑定 `127.0.0.1` 而非 `0.0.0.0`；提供 `__TAURI_INTERNALS__.invoke` 回退通道（检测宿主可用时优先 invoke，否则 fetch）。 |
| DiffViewer 被非 Git 场景复用（Chat 内嵌 patch diff） | 删主项目 Diff 会破坏 Chat diff 渲染 | 评估 `InlineDiffView`/`PatchDiffRenderer`/`diffService` 对 DiffViewer 的依赖。若被复用，DiffViewer 保留为主项目通用组件，git 插件通过 peerDep 引用；否则整体迁入插件。 |
| isomorphic-git 能力不足（无 rebase/merge 冲突） | 独立运行档功能残缺 | 明确独立运行档为"只读 + 基础提交"子集，高级操作标注"需 git CLI 或 Polaris 宿主"。不试图用 isomorphic-git 全量替代。 |
| `git_bin_path` 配置项去留 | 配置迁移 | 迁入插件设置面板；主项目 config 的 `git_bin_path` 字段保留为兼容读取，或随 Phase 3 删除。 |
| PR 功能（create_pr/get_pr_status）依赖 gh CLI / Git host API | PR 功能迁移 | PR 单独作为插件的子模块，可选启用；实现走 `gh` CLI 或直接 GitHub API（需 token）。 |

---

## 6. 里程碑与裁决点

| 里程碑 | 决策点 | 裁决标准 |
|---|---|---|
| Phase 0 完成 | 是否继续 Phase 1？ | gitService 单一入口收敛完成，viewStore/tabStore 泛化无回归 |
| Phase 1 完成 | CLI 实现是否对齐 git2？ | 55 命令 golden test 通过率 ≥ 95%，失败项为已知高级操作 |
| Phase 2 完成 | 前端迁移是否零功能回归？ | 10 个 slice 的集成测试全绿，人工冒烟全功能 |
| Phase 3 删除前 | DiffViewer 是否被非 Git 复用？ | 若是，保留主项目；否则迁移 |
| Phase 3 完成 | 独立运行档是否落地？ | `--standalone` 启动 + 浏览器可用，且不牺牲宿主内体验 |

---

## 7. 待确认问题（需用户决策）

1. **内置 vs 远程：** polaris.git 作为内置插件（随 Polaris 发布，用户可禁用）还是仅远程插件（用户主动安装）？内置更符合"Git 是编辑器核心能力"的预期，远程更纯粹的插件化。
2. **DiffViewer 归属：** DiffViewer 是随 git 插件迁出，还是保留为主项目通用 diff 组件（Chat patch 渲染复用）？
3. **独立运行档优先级：** `--standalone` 独立 web git 客户端是否本期落地，还是作为后续增量？
4. **isomorphic-git 是否引入：** 纯 JS 引擎成本高且能力受限，是否值得为"零原生依赖"投入，还是统一用 git CLI 实现？
5. **PR 功能去留：** create_pr/get_pr_status 是否纳入 git 插件首期，还是作为可选子模块延后？

---

## 8. 参考资料

- 主项目后端：`src-tauri/src/commands/git.rs:1-619`、`src-tauri/src/services/git/mod.rs`、`src-tauri/src/models/git.rs:1-688`、`src-tauri/Cargo.toml:72`（git2 依赖）
- 主项目前端：`src/stores/gitStore/index.ts`、`src/components/GitPanel/`、`src/components/Diff/`、`src/services/gitContextService.ts`、`src/services/commitMessageChat.ts`、`src/components/Chat/GitSuggestion.tsx`
- 主项目视图耦合：`src/stores/viewStore.ts`、`src/stores/tabStore.ts`、`src/components/Layout/CenterStage.tsx`、`src/components/Layout/toolSwitcherData.tsx`、`src/components/FileExplorer/GitStatusIndicator.tsx`
- 插件规范：`Polaris-plugin/docs/SPEC.md`、`Polaris-plugin/docs/plugin-development-guide.md`、`Polaris-plugin/examples/plugin.json.template`
- 插件样例：`Polaris-plugin/plugins/marketplace/`（views+panel+mcpServers 三合一模板）、`Polaris-plugin/plugins/relay-devkit/`（services http 后台样例）
- 第三方库：isomorphic-git（纯 JS git，Node+浏览器同构，支持 clone/commit/push/fetch，社区维护）、gitoxide/gix（纯 Rust，仅 Rust 环境，不适合浏览器）

---

## 9. 实施记录（2026-08-16）

> 目标调整为：编辑器查看差异（最高价值）优先 + 外部插件落地。后端 git2 保留不动（性能零退化）。

### 主项目（Polaris 仓库）

| 提交 | 内容 |
|---|---|
| `18711221` | **Phase 0 + 编辑器集成** |
| | `editorExtensionRegistry`：插件注入 CM6 Extension 的扩展点（P0-1） |
| | `viewStore` 泛化：`panelStates` map + `togglePanel/setPanelVisible/setPanelWidth/getPanelState`；`gitPanelWidth/showGitPanel` 保留为兼容别名（P0-2） |
| | `tabStore`：`TabType` 扩展为 `(string & {})`，允许插件自定义 Tab 类型（P0-2） |
| | `pluginTabRendererRegistry` + CenterStage default 分支回退（P0-3） |
| | `fileExplorerToolbarSlot` + GitStatusIndicator 通过 slot 注册（P0-5） |
| | `gitEditorService`：编辑器文件 git 状态/diff/blame 数据服务（status 1.5s TTL + blame 60s TTL 缓存） |
| | `gitGutter`：行号区 diff 标记 + 行内背景高亮（CM6 ViewPlugin + Decoration） |
| | `blameHover`：悬停显示作者/时间/消息（hoverTooltip） |
| | `changeNavigator`：Alt+Up/Down 改动间导航（预载+同步读缓存模式） |
| | `.gitattributes`：源码统一 LF，消除 Windows autocrlf 导致的 diff 膨胀 |

### Polaris-plugin 仓库

| 提交 | 内容 |
|---|---|
| `c4b6900` | **polaris-git 外部插件** |
| | `plugin.json`：activityBar git 面板（panelType=git）+ stdio MCP server |
| | `mcp/server.js`：13 个 git MCP 工具（调系统 git CLI，独立可运行）——status/diff/log/stage/commit/create_branch/checkout/pull/push/blame/stash_list/stash_pop/repo_info |
| | `src/Panel.tsx` + `dist/panel.js`：自包含 Git 面板（14KB bundle）——工作区选择/状态条/变更列表/diff 预览/提交/AI 提交信息 |
| | `index.json`：注册到商城（sha256 已算） |

### 架构决策（实施中修正）

1. **外部插件面板无法 import 主项目 `@/` 路径**——外部插件是独立 ESM blob（esbuild bundle），只能 import react（pluginModuleLoader shim）。因此 GitPanel（17k 行，依赖核心 stores）无法整体迁出。
2. **插件面板改为自包含**：直接调 `window.__TAURI_INTERNALS__.invoke` 的 git_get_* 命令（与 marketplace 插件同模式），零外部依赖。
3. **主项目内置 GitPanel 保留**：更完整（branch/rebase/stash/tags/PR 等），后端 git2 不动。外部插件面板作为轻量独立入口。
4. **AI 能力等价**：MCP server 的 git 工具可被 AI 消费，取代 commitMessageChat 的外部化需求。
5. **编辑器集成在宿主侧实现**（非插件内）——CM6 扩展必须在宿主编辑器实例挂载，通过 editorExtensionRegistry（P0-1）注入，外部插件未来可通过同一 registry 注册自己的 CM6 扩展。

### 测试验证

- ✅ 主项目 `tsc --noEmit`：49 个 pre-existing 错误（未新增，全部是 ThemeEditor 等无关文件）
- ✅ MCP server 独立运行：`node server.js --tool git_repo_info --args '...'` 返回仓库信息
- ✅ MCP server 交互协议：initialize / tools/list(13 工具) / tools/call(git_status→有效 JSON)
- ✅ 插件打包：pack.js 生成 `polaris-git.zip`（4 文件：dist/panel.js + mcp/server.js + plugin.json + update.json）
