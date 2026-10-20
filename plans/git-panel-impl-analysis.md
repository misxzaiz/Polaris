# 实施分析：Git 面板 vNext（性能 / 交互 / 推进方式）

> ⚠️ 经四路对抗分析，PR 序列与 P0 形态已被修订：**PR-1 重定型为 invoke 兼容 shim + 纯转发**（slice 与测试零改动），队列/事件/错误分类延后到 PR-2a，commands/git.rs 摘除为 PR-2b；冲突状态机重画为「序列操作机」。最新基准见 `plans/git-panel-master-plan.md` §一/§二；本文未修订的其余手段（性能触点、状态机骨架、AI 管线细节）仍为有效参考。

> 前置：`git-panel-idea-parity-plan.md`（对标）与 `git-panel-prd.md`（裁定）；本文回答"怎么落"——按文件/接口/状态机/性能手段给实施级方案。仍为设计阶段文档。

## 0. 本次新核实的事实（影响设计的两点）

1. **事件双轨现成**：桌面 `app_handle.emit("chat-event", …)`；后端 `event_broadcast`（tokio broadcast）→ Web WS（AI 流式经 `EventBroadcaster.broadcast → WS 推送`）。cap.git 进度事件不新造通道，挂同一 broadcast。
2. **file_watcher 局限**：`IGNORED_DIRS` 含 `.git`，且 `start()` 在 `tauri-app` feature 下（Web 模式无 watcher）。→ 需要新增 `.git` 副监听 + Web 兜底（见 §2.3）。

## 1. 推进方式：PR 序列与每期真验收

| PR | 内容 | 触点文件 | 验收 |
|---|---|---|---|
| PR-1 | `cap.git` 短命令迁移（薄转发，不改业务） | `services/router/git_cap.rs`(新)、`web/api/ipc.rs`(转发改 cap)、`services/gitService.ts`(新)、`gitStore/*`(invoke→service) | 现 vitest 全绿；`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`；**删除 `git_dispatch.rs`** |
| PR-2 | 长任务协议（taskId/progress/cancel/per-repo 队列） | `git_cap.rs`、`models/`（新增事件类型）、`gitService.ts` 订阅 | pull 中途 cancel 演示 + 单测（队列串行性） |
| PR-3~5 | P1 功能（amend/fetch/stash 补全/log 搜索/force-with-lease） | `services/git/*.rs`、对应 slice | 每项单测 + slice vitest |
| P2 序列 | lane 计算、graph UI、.git 副监听、undo 网络 | 见 §2/§3 | §2.1 预算逐项 bench |
| P3 序列 | 冲突合并器、interactive rebase、AI-5/6 | 见 §3 状态机 | 四路冲突手测清单 |
| P4 | MCP 白名单 + 插件示例 | `dispatch_mcp_server.rs`（**`cargo build --bin polaris-mcp`**） | 插件三处同步 |

原则：PR-1/2 是**一切功能的前置**——任何新功能先过 cap.git 再上 UI（否则 web/插件/MCP 三处返工）。

## 2. 性能实施（预算 → 手段 → 触点）

### 2.1 log + 泳道（首图 <300ms / 热开 <80ms）
- **lane 计算放 Rust**：`services/git/graph.rs`（新）——写 `build_graph_page(commits) -> GraphCommitRow[] {sha, parents, refs, lanes: [{lane, colorIdx, rowKind: 'vertical'|'mergeIn'|'mergeOut'}]}`。算法移植 git `graph.c` 的 `mapping/new_columns/old_mapping` 四数组状态机（不需酷 body 的曲率，前端只结算坐标）。
- **协议**：`get_log` 返回类型扩展为 `GitLogPage { commits: GraphCommit[], page, total? 区间说明 }`；`parents/refs` 一次查询带回（refs 用 git2 tag→branch 一次遍历构建 HashMap<sha, Vec<RefDecor>>）。
- **增量缓存**：key = `(workspacePath hash, HEAD sha, ahead/behind digest)`；命中 HEAD 未变 → 直接回放缓存页（内存 LRU，最近 3 页；P2.5 再做 DataRoot 落盘）。头页 miss 时后台线程先行计算再回（前端骨架屏）。
- **前端渲染**：行组件 memo(graph 复用)；virtuoso 已有；`max-lanes=12`；「折叠线性分支」选项同 graph.c（把 lane 段折叠省节点、也省 lane 数）。

### 2.2 cap.git 并发与取消
- per-repo `Mutex` 串行队列（不是全局锁）：AI 多会话并发写文件不会打崩 git2；
- 长任务分类：push/pull/fetch/rebase/interactive-rebase 走队列；status/diff/log 并发只读。
- **取消语义**：`AtomicFlag` 检查点 + 子进程 kill（`CREATE_NO_WINDOW` 已有）；**绝不超时兜底**（AGENTS §4.2）；取消后的 git 状态（rebase in progress 等）以 `git status` 的 `conflicted/rebase` 位回读，而不是假设取消成功。
- 队列满（>8）返回 `busy` 错误码，UI 显示排队卡片（不是静默吞）。

### 2.3 status 自动刷新（AI 停写 ≤1s）
- **.git 副监听**（新 `services/git_watch.rs`）：仅 watch `<repo>/.git/{HEAD, index, refs/**}`（notify，非递归 refs），→ 同一 `event_broadcast` 发 `repo_touched { wsPath }`；桌面/Web 双通道自动（broadcast 已双轨）。
- 与既有内容 watcher（忽视 .git）**职责分离**：内容变化 → 工作区 status 刷新；.git 变化 → branch/ahead-behind/log 头页失效。
- **流式抑抖**：`useKernelSessionState(sessionId)=streaming` 时把 debounce 窗口拉到流结束（复用 commitMessage 会话判定），收流结束即刷一次。
- **Web 差距**：桌面看门是 Tauri emit；Web 独立模式当前无 AppHandle watcher——本项保持「Web 端轮询兜底（可见设置项，默认 60s)」并如实标注为已知边界，Watch 服务一并 `#[cfg]` 检查不进 web-only 编译。

### 2.4 diff / 其它
- 复用现有共享 worker + MAX_EDIT_LENGTH 降级；**新增「仅统计」阈值 2MB**（只返回 additions/deletions + status_hint，没有内容展开）。
- 图 virtuoso + 行 memo；改动iffin局部写入进 store（不整表刷新）。内存：保留最近 3 页 log。

## 3. 交互实施（状态机 + 语义锚点）

### 3.1 长任务状态机（cap.git + 前端 ledger）
```
idle → queued → running --progress--> done | failed {code, stderrSnip} | cancelled
前端：gitService 按 taskId 建立订阅；通知条/进度条挂在对应按钮（push/pull 图标）而非全局 spinner
语义：failed 带 GitServiceError 分类（网络 / 冲突 / 非快进 / 认证）→ 分别映射文案与「下一步建议」按钮
```
- 所有写操作（stage/commit/merge/…）一律走 ledger；UI 状态由 event 回灌，**不乐观假设成功**（git 会失败，双重写回 = 隐患）。

### 3.2 冲突解决状态机（合并器，最大交互风险点）
```
status.conflicted > 0
  └→ 面板出现 "Merge Conflicts" 节点（非阻塞，不强制弹窗 —— 对齐 IDEA 2024.1 规范）
      ├→ 点文件 → parse_conflict_markers(path) { hunks[{ base, ours, theirs, kind }] }
      ├→ MergeEditorState: per-hunk  { resolved: none|ours|theirs|manual }
      │     未解决计数 = 派生值（勿驻存控制 bug）
      ├→ Accept/建议 → 写入结果文件（中央可编辑 buffer） → stage_file → 复算该文件 conflict=0
      ├→ 全文件 resolved → 若处 merge/rebase/cherry-pick 进行中 → 引导「Continue」按钮（复用现有 *_continue）
      └→ Abort → 确认卡（AI-7 陈述后果 + 快照）
```
- **两形态**：独立对话框（首版）→ 编辑器内嵌（复用 CM6 的文档替换机制，见去 P3 拆分组件：`MergeEditor/{ThreePane,ConflictBlock,AiSuggest}`）。
- **current/incoming 语义标签**：按操作类型（merge/rebase/cherry-pick/stash-pop）在标题注明 theirs 的归属（唯一全局性易错点）。

### 3.3 Interactive Rebase
- 后端：`git rebase -i <dest>`，`GIT_SEQUENCE_EDITOR=/path/polaris-rebase-editor`（web bin 或 CLI 共工具）；`polaris-rebase-editor` 读 $TODO_PATH → **不是编辑器而是结构化文件**（首调用返回 todo JSON 给前端编辑，编辑完成后调用 confirm-is-sequence 写回并退出——巡航两阶段协议）。
  - 改在 P3 详 spec；风险点：``--autosquash``与 fixup! 检测（本地启发式）。
- 前端：TODO 表格组件（拖拽现有 dnd? 评估是否引入 `@dnd-kit`，或自有 HTML5 DnD，建议自研 lite——13 行拖拽满足单列表需求）；edit 停点 → 面板 notification（Continue/Abort）+ Log tab 顶部 banner（错过通知的折成入口）。

### 3.4 Undo 网络（快照协议）
- 触发点：discard / reset hard / checkout（会丢改动）/ drop commits / rebase --hard 起点前。
- 实现：把将被影响的未提交改动导出为 patch 文件（`git diff` + `git diff --cached` 两份 + untracked 拷贝）→ `<data_root>/git-backups/<wsId>/<ts>/`。
- 恢复：`git apply -R` patch + untracked 回写 + 冲突时 UI 给出「部分恢复」结果（不静默失败）。
- 通知条 3 分钟内常驻 + 操作流水留痕（可与 undo log一起被 P2-4 Activity 面板检索）。

### 3.5 AI 管线（以 commitMessageChat 为范式的克隆线）
- 新 helper：`services/gitAiSessions.ts`
  ```ts
  withGitAiSession(kind, workspaceId, engineId, buildPrompt) → { sessionId, result$ }
  ```
  内部维持「唯一会话 per (kind, ws)」+ `oneTimeSystemPrompt` + 流式订阅 hook；AI-2/AI-3/AI-5 各自薄壳。
- **输入裁剪器**（AI-2/AI-5 共用）：`buildGitAiPayload(diffEntries, tokenBudget)`：先 `formatGitDiffSummary` → 依 PRD 文件优先级填充，超出即 truncate 并在卡片标「已裁剪」。
- 成本档位：轻引擎默认由 engineMetadataStore 的 `defaultLightEngine`（P1 引入设置项）。

### 3.6 细节交互基线
- 微交互：状态条 hover → inline 前后对照；行选区 stage（P3.5）；操作用 toast + 操作流水不阻塞；错误 Cadillac：冲突识别后的 census 直接给下一步按钮（解决 / abort / 稍后）。
- i18n：全部文案进 `locales/*/git.json`（已有命名空间）。
- 无障碍：dialog 弹层 role/aria（对齐项目 client 其他面板习惯，作 P3 展开 spec 内清单）。

## 4. 已知风险 / 边界（实施时必答）

1. **协议双同步**：新增 GraphCommit/ConflictParse/rebase Todo 等类型必须 Rust ↔ `src/types/git.ts` 双补 + 字段级 vitest（顺序：先 Rust serde 再 TS types，禁止口头同步）。
2. **web-only gate**：PR-1 起每 PR 跑 `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`；P0 交付物之一是 git_dispatch.rs 的删除——但 `git_dispatch` 的调用点在 `web/api/ipc.rs` 前缀路由，迁移要同 PR 处理（见 PR-1 触点）。
3. **Rust 单测的机不可用问题**：`cargo test --lib` 本机不可跑（DLL 限制），graph lane / conflict parser 测试**建议写成前端可验证西数>即核心纯函数先在 TS 侧写一份参考实现 + 测试，Rust 侧同算法对照契约用例**，或挂 `#[cfg(test)]` 用 `cargo test --bin polaris-web`（如可用）实跑一次验证契约。
4. **MCP schema 陈旧**：P4 改 dispatch 白名单后务必 `cargo build --bin polaris-mcp`（记忆 polaris-mcp-schema-exe-staleness）。
5. **巨型文件纪律**：JumpHistoryTab/合并器/Graph 一新组件；`gitStore` 新 slice 单文件≤200 行。

## 5. 第一步建议（可直接开工的最小切片）

PR-1 = `cap.git` 纯薄转发 + gitService 收口 + git_dispatch.rs 删除。
- 不含任何新功能 → 回归风险最小，同时把全部「后续都要用的地基」（队列、事件、错误分类）先铺好。
- 预估规模：`router/git_cap.rs` ~400 行（照搬 50 命令签名），gitService ~200 行，slice 改动每处 ~5 行。
