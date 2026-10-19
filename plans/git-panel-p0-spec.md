# Git 面板 vNext — P0 实施 spec（PR-1）

> 上位文档：`plans/git-panel-master-plan.md`（裁决与 PR 序列以它为准，冲突裁决权归 master-plan）。
> 本 spec 只覆盖 **PR-1**：git 域命令通道上收 `cap.git`（RouterBus），删 Web 双写派发表。

## 一、目标

1. 建 `cap.git`（`services/router/git_capability.rs`）：**invoke 兼容 shim 的后端落点**——
   action = 去 `git_` 前缀的原命令名，payload = 原命令参数（camelCase 原样）。
2. 回归铁律：前端 10 个 gitStore slice & 测试**零改动**（`invoke('git_*')` 签名保持）。
3. 摘除双写点：删 `web/api/git_dispatch.rs`（~296 行），`ipc.rs` git 前缀路由臂改指 cap.git。
4. 能力内二级校验（master-plan 裁决 4）：破坏性动作对 `Source::Plugin` 调用方拒绝
   （Bootstrap/Remote 放行 = Web 用户不受影响）；完整权限矩阵延后 PR-2a。

## 二、契约

### 后端 `cap.git`（GitCapability）

| 项 | 值 |
|---|---|
| target | `cap.git` |
| payload | `{ "action": "<去 git_ 前缀命令名>", ...原命令参数 }` |
| Reply | 复用 `Result<Value, String>`（error = 人类可读串；PR-2a 再扩结构化载荷） |
| 动作集 | commands/git.rs 全部 58 个 git_* 域动作中前端锚定的 50 个 |

等值策略：各动作从 `commands/git` **同源薄转发**（与旧 tauri command、旧 web dispatch
调用同一批函数），camelCase 参数提取一一对应（`sourceBranch`/`startPoint`/`remoteUrl` 等）。
例外：`git_commit_changes` / `git_pull`（async 包装）在能力内直调 `GitService`（同步语义等价，
spawn_blocking 移交 PR-2a 写队列）。别名兼容：`git_get_stash_list` ≡ `stash_list`。

### 前端 shim（`src/services/transport/index.ts`）

- `invoke(cmd)`：`cmd.startsWith('git_')` → 改发 `invoke('router_dispatch', { req: { target:'cap.git', payload:{ action, ...args } } })`，
  `res.ok` → 返回 `res.result`；否则 throw `new Error(res.error)`。
- 错误串格式：`message (details)`（对齐 `parseGitError` 的 details 呈现习惯；对象路径旧行为由 tauri
  序列化产生，属 Delete 项非回归面）。
- 声明为 sunset shim：PR-2a 起逐 slice 改显式 `callGitCap(action, args)` 后删除拦截器。

### Source 二级校验（能力内）

```text
DESTRUCTIVE = { commit_changes, discard_changes, reset, checkout_branch, checkout_commit,
                merge_branch, rebase_*, cherry_pick*, revert*, push_*, pull, delete_branch,
                delete_tag, stash_pop, stash_drop, init_repository, save_gitignore, ... }
Source::Plugin{..} ∧ DESTRUCTIVE → Err("Plugin 来源禁止破坏性 git 操作（P2a 权限矩阵落地前临时规则）")
```

## 三、验收

### 实测记录（2026-10-19，PR-1 + PR-2b + PR-2a 增量）

- [x] gitStore vitest：**12 文件 / 190 用例全绿，测试文件零改动**（PR-1 shim + PR-2b 命令层摘除后复跑一致）。
- [x] `tsc --noEmit` 通过（两轮）。
- [x] `cargo check`（desktop）与 `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 均通过（多轮，含全部增量后）。
- [x] `grep commands::git` 零命中；`git_dispatch` 零命中（仅注释提及）；`commands/git.rs` / `web/api/git_dispatch.rs` 已删除。
- [x] `cargo test --no-run --lib`：git_capability 单测**编译**通过；**运行**受本机存量 Tauri DLL 限制不可执行（STATUS_ENTRYPOINT_NOT_FOUND，AGENTS §九 已知项）——单测实际运行留给 CI。
- [x] Web 模式冒烟：留运行时人工项（get_status / stage / commit / log 四链路，代码门均已过）。

### 基线注记（与本次改动无关的存量失败）

`src/services/pluginServiceManager.test.ts`（6）、`pluginDiscoveryService.test.ts`（8）、
`httpTransport.test.ts`（2）共 16 例失败——经 stash 前后对照验证为**存量问题**（不含本
改动的工作树同样失败），非本次回归面。

## 四、不做（后续 PR 边界）

- ~~删除 commands/git.rs~~ —— 已在 PR-2b 完成（write/read_file_absolute、
  test_param_serialization 迁 `commands/file_io.rs`，能力改直调 GitService）。
- ~~写 max=1~~ —— 裁决 8 的最简互斥（WRITE_GATE Mutex）已提前落地；带队列/取消语义
  的完整写任务队列 + progress ≤4Hz 合流仍归 PR-2a 后续。
- ~~sync dispatch 占 tokio worker~~——`router_dispatch`（desktop/web 两处）与 Web git
  臂已外包 `spawn_blocking`（PR-2a 性能轴增量）。
- Reply 结构化错误载荷（需扩 router Reply 契约，牵动全部能力向后兼容）——归 PR-2a 主体。
- lane 算法 / 缓存 key / 冲突协议（P2）。
- casing 统一（裁决 3）。

