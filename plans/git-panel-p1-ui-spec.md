# Git 面板 vNext — P1 面板交互层实施 spec（FR-P1 落地）

> 上位文档：`plans/git-panel-master-plan.md`（裁决基准）；`plans/git-panel-prd.md`（需求基准）。
> 本 spec 覆盖 master-plan §七「仍开设口：**P1 UI 绑定**」的全部面板交互项。
> 后端动作与 slice 方法已在 P1 后端批量就绪（见 master-plan §七执行记录），本 spec 只做**前端绑定**。

## 一、目标

把 P1 后端批量已就绪的能力接到 UI，达成 PRD FR-P1-x 与 parity-plan §四的 IDEA 对齐规格：

| # | 功能 | 需求来源 | 落点 |
|---|---|---|---|
| F1 | **amend 提交**（空消息 = --no-edit 合并已暂存） | PRD FR-P1-x；parity §四 Commit | `CommitInput.tsx` |
| F2 | **force-with-lease 默认化**（force 勾选即走 `pushWithLease`，文案安全强推） | parity §四 Commit「force-with-lease 默认化」；PRD §3 AI-7 安全理念 | `PushDialog.tsx` |
| F3 | **fetch + auto-fetch 设置**（默认关） | PRD FR-P1-x；parity §四「fetch + auto-fetch」 | `RemoteTab.tsx` |
| F4 | **stash apply/show/pop 三动作** | PRD FR-P1-x；parity §四「stash apply/show/drop」 | `StashTab.tsx` |
| F5 | **reflog UI + 一键恢复**（超越点#1） | PRD FR-P1-x；parity §三差异点1 | `HistoryTab.tsx`（半成品） |
| F6 | **log 后端搜索**（grep/author/pickaxe/日期/分支范围） | PRD FR-P1-x；parity §四 Log「过滤四维」 | `HistoryTab.tsx` |

## 二、契约

### 前端已就绪方法（本 spec 直接消费）

- `useGitStore`: `amendCommit(ws, msg?, stageAll?, files?)` / `pushWithLease(ws, branch, remote, remoteBranch?, leaseSha?)` / `fetchRemote(ws, remote?, prune?)` / `stashApply(ws, index?)` / `stashShow(ws, index?)` / `searchLog(ws, filter, limit?, skip?)` / `getReflog(ws, branch?, limit?)`

### 交互规格

**F1 · CommitInput**
- 提交按钮旁加 amend 开关（toggle，默认关），带 explainer tooltip（空消息= --no-edit 合并 staged）。
- 开时 `handleCommit` 调 `amendCommit(ws, message.trim() || undefined)`；成功后清空 message + toast。
- 期间 `isLoading` 沿用 store 全局态禁用。

**F2 · PushDialog**
- force 勾选文案改为「安全强推（force-with-lease）」+ 副文案说明不会裸 `--force`。
- `handlePush` 中 force=true 时改调 `pushWithLease(ws, branch, remote, targetRemoteBranch)`；force=false 走原 `push`。
- 保持旧 5 键 payload 契约不变（后端已除名裸 force）。

**F3 · RemoteTab**
- 每条 remote 操作区加 Fetch 按钮（调 `fetchRemote(ws, name)`，成功 toast + `refreshStatus`）。
- 设置区加「auto-fetch」开关（默认关；开启后每 20 分钟对该 remote 拉一次——前端 interval，任务取消走现有 pattern）。存 localStorage `polaris.git.autoFetch`.
- 简化：首版只做「手动 Fetch 按钮 + auto-fetch 开关持久化」，interval 仅当设置开时生效。

**F4 · StashTab**
- 每条 stash 行操作从单「pop」改为三动作按钮组：Apply（保留）/ Pop / Show（查看 patch）。
- Apply/Pop 成功后 `loadStashes` + `refreshStatus`；Show 把 `stashShow` 返回值展示进新对话框（只读 patch 文本）。

**F5 · HistoryTab reflog**
- 顶部工具区（Branch 选择旁）加 Reflog 入口按钮（HistoryIcon 已 import）。
- 点击进入 reflog 模式：列表显示 selector / subject / shortSha / 相对时间 / branch 徽标。
- 行操作「恢复到该提交」→ 二次确认（说明将 checkout 到 detached HEAD，可新建分支）→ `checkoutCommit` → `refreshStatus`。
- 列表顶部返回历史按钮（复用现有 `handleExitFileHistory` 模式）。

**F6 · HistoryTab log 搜索**
- 搜索框旁加「精确搜索」开关（AdvancedSearch 图标）：开启后输入即调 `searchLog`，支持 `--grep / --author / -S / --since / --until / 分支范围`。
- 用 `GitLogSearchFilter` 组装；分支范围即现有 selectedBranch（a..b 语法透传）。
- 搜索结果用现有 commit 行渲染组件；保留本地 includes 过滤为即时通道（关闭精确搜索时）。
- 后端搜索进行中显示 loading；失败回退本地过滤。

### i18n
- 全部新文案进 `src/locales/zh-CN/git.json` 与 `en-US/git.json`（`reflog.*` / `stash.*` / `remote.*` / `commit.amend*` / `push.forceLease*` / `history.search*` 命名空间）。不硬编码文案。

### 视觉
- 全部用主题 token（`text-text-primary` 等）+ 现有组件（`Button` / 现有 dialog pattern），不新增颜色。

## 三、验收

- [ ] `pnpm exec tsc --noEmit` 通过
- [ ] `pnpm lint` 通过
- [ ] 相关组件 vitest 全绿（HistoryTab / StashTab / PushDialog 现有测试不回归 + 新增针对性用例）
- [ ] 6 项功能手测：amend 空消息/带消息、force-with-lease 对话框、fetch 按钮、stash 三动作、reflog 恢复、后端搜索
- [ ] i18n 双语补全

## 四、不做（边界）

- PR-2a 写任务队列/进度事件/结构化错误（未开始）
- P2 lane 图/泳道 UI（log 已切拓扑序，UI 层尚未消费）
- P2.5 冲突协议、P3 合并器/交互 rebase
- AI-6 参数编译器主体（本 spec 只接 `searchLog` 执行端）
- auto-fetch 的后端定时调度（首版前端 interval；后端 scheduler 归后续）
