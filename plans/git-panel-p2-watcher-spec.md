# FR-P2-2 · File-Watcher 自动 Status 刷新 — Spec

> 四段式 spec：目标 / 契约 / 验收 / 不做。
> 依据：`git-panel-master-plan.md` 性能预算表「status 刷新：桌面 p95≤1s；rebase 中 ≤3s」+ 对抗裁决 C9（双 watcher + 自抑制 + 流式抑抖）。
> 效力顺序：master-plan > PRD > 本文。

---

## 一、目标

让 Git 面板的状态（staged / unstaged / untracked / 当前分支）在**工作区文件被外部修改、或被 git 操作改变**时自动刷新，无需用户手动点刷新按钮；同时避免三类刷新风暴：

1. **rebase 风暴**：rebase 进行中 `.git` 被频繁写（MERGE_HEAD / rebase-merge / index），若逐事件刷新会把状态请求刷爆。
2. **回环**：git 自己写 index（stage/commit 后 git 更新 index）也会触发 watcher → 再刷 status → 无意义的自我循环。
3. **AI 流式干扰**：AI 会话流式输出期间（尤其 agentic 工具正在写文件），频繁刷新 git 状态与高密度前端重渲染互相干扰。

现状：`file-system-change` 事件已被 FileExplorer / FileEditor 消费（刷新目录树、检测外部修改），但 **Git 面板没有订阅它**——Git 面板只在挂载、路径切换、手动操作后 `refreshStatus`。FR-P2-2 补上「Git 面板消费 file-system-change → 防抖刷新」这条链路。

---

## 二、契约

### 2.1 前端监听（新模块 `src/stores/gitStore/fileWatcherSubscriber.ts`）

```ts
/**
 * 订阅 file-system-change，防抖刷新当前 Git 面板生效仓库的 status。
 * 返回清理函数；在 GitPanel mount 时调用，unmount 时清理。
 */
export function initGitStatusWatcher(getEffectivePath: () => string | null): () => void
```

- 事件载荷沿用现有 `FsChangeEvent { affectedDirs: string[] }`，**不改协议、不动后端**。
- 触发条件：
  - `getEffectivePath()` 返回非空（Git 面板当前生效仓库路径）；
  - `affectedDirs` 非空（任何目录变化都可能影响 status，不做路径级过滤——status 刷新是轻操作且已 debounce；见 §四「不做」）。
- 刷新动作：调 `gitStore.refreshStatusDebounced(effectivePath, 800)`（**复用 statusSlice 既有 per-path seq 丢弃乱序机制**，不新写去重）。
- **流式抑抖**：AI 会话流式期间（判定见 2.2）**暂停**自动刷新；流式结束（下降沿）后补刷一次（`refreshStatus` 立即执行，不 debounce）。
- **自抑制**：debounce 窗口内若已有 git 写操作在途（见 2.3 的事件提示），延后到写操作结束后再刷。

### 2.2 流式判定（复用既有 kernel 会话状态适配层）

```ts
import { kernelSessionIsStreaming } from '@/session-v2/hooks/useKernelSessionState'
```

- 一次性判定：`await kernelSessionIsStreaming(activeSessionId)`。
- `activeSessionId` 取 conversationStore 的活动会话（调研结果定精确 getter）。
- 由于 watcher 回调非 React 环境，用**一次性查询 + 订阅下降沿**两种方式组合：
  - 事件到达时先 `kernelSessionIsStreaming` 查询：若 streaming → 跳过本轮，并把「待补刷」标记置位；
  - 通过 `subscribeKernelSessionState` 订阅当前活动会话，观察到 running → idle/error 下降沿时若「待补刷」置位 → 立即 `refreshStatus`。
- 服务侧等待流式结束已有 `waitKernelSessionStreamEnd` 可用；此处需**非 React 侧**订阅，用 `subscribeKernelSessionState`（同文件导出）。

### 2.3 git 写操作在途判定（自抑制）

- 范围：本 FR 只做**读侧自动刷新**；git 写操作在途的判定依赖 PR-2/P2 的 cap.git 队列（读无限并发 + 写 max=1）与长任务事件（taskId/progress）。
- **本 FR 最小实现**：写操作在途时，Git 操作后代码路径已各自显式 `refreshStatus`（如 handleBatchStage 等 finally），watcher 自动刷新与其互斥由 `_statusSeq` 兜底（后发覆盖先发）。因此本 FR **不新增**写操作在途的显式抑制，只在 debounce 内做「流式抑抖」。
- rebase 风暴缓解：`.git` 内的写（rebase-merge 等）会触发大量事件，但 800ms debounce + seq 丢弃已把请求压到「每 800ms 至多一次且丢弃乱序」，达到 C9「rebase 中刷新预算 ≤3s」的实际效果；无需再为 rebase 单独降频。

### 2.4 挂载点

`src/components/GitPanel/index.tsx` 的 `useEffect`（mount 时启动、unmount 清理）：

```ts
useEffect(() => {
  const cleanup = initGitStatusWatcher(() => effectivePath)
  return cleanup
}, []) // 挂载一次；回调每次读取最新 effectivePath，无需重订阅
```

- `effectivePath` 已含子仓库选择逻辑（`selectedRepoPath ?? currentWorkspace?.path`），回调每次调用时读取最新值，避免子仓库切换后订阅过期。
- 不额外调用 `startFileWatcher`：watcher 由 FileExplorer 的 `initFileWatcherListener` / `startFileWatcher` 管理（`performance.fileWatcher` 开关）。**Git 面板只在 watcher 已开启时才收到事件**；若用户关闭 fileWatcher，本订阅自然静默——这是可接受边界（§四）。

---

## 三、验收

1. **单元测试**（`src/stores/gitStore/fileWatcherSubscriber.test.ts`）：
   - 事件到达且未流式 → 调 `refreshStatusDebounced(path, 800)`；
   - 事件到达且流式中 → 不刷，置「待补刷」；
   - 流式下降沿（running→idle）到达且「待补刷」置位 → 立即 `refreshStatus`；
   - `getEffectivePath()` 返回 null → 事件到达不刷；
   - cleanup 取消订阅与待补刷状态。
2. **组件挂载测试**：`GitPanel` mount 时调用 `initGitStatusWatcher`，unmount 时清理（mock 断言）。
3. **集成验证（手动）**：
   - 桌面端开 Git 面板，外部编辑器改文件 → ≤1s 内 staged/unstaged 计数变化；
   - rebase 进行中 → status 不风暴（DevTools 看 `git_get_status` 调用 ≤3s 一次量级）；
   - AI 会话流式期间外部改文件 → 不刷新；流式结束 → 补刷一次。
4. **回归**：既有 `statusSlice.test.ts` 与 GitPanel 相关 vitest 全绿；`pnpm exec tsc --noEmit` + `pnpm lint` 通过。

---

## 四、不做（边界）

- **不改后端** `file_watcher.rs` / 事件名 / 协议。若未来要按 repo 归属事件、路径级过滤、或 `.git` 专用事件，属后续 FR。
- **不做路径级过滤**：任何 `affectedDirs` 都触发整仓 status 刷新。status 是轻操作（git2 一次性读取），逐路径精确刷新收益低、复杂度高。
- **不做 Web 端轮询**：master-plan 已裁决 Web=60s 轮询是边界（watch 是 tauri-app feature）；本 FR 只覆盖 tauri-app 的事件链路。
- **不新增**写操作在途抑制（见 2.3）：现有显式刷新 + `_statusSeq` 已覆盖互斥；写队列/长任务事件抑制归 P2 队列 PR 一并做。
- **不启动** Git 面板自己的 watcher：沿用 FileExplorer 的 watcher（`performance.fileWatcher` 开关控制）。
- **不做** status 之外的数据自动刷新（log / branches / stash 等）：它们各自有独立手动入口，自动刷新机制与本 FR 正交，避免一次改动范围过大。

---

## 五、关键文件

- `src/stores/gitStore/fileWatcherSubscriber.ts`（新建）
- `src/stores/gitStore/fileWatcherSubscriber.test.ts`（新建）
- `src/components/GitPanel/index.tsx`（挂载点）
- 复用：`src/stores/gitStore/statusSlice.ts`（refreshStatusDebounced / refreshStatus / _statusSeq）
- 复用：`src/session-v2/hooks/useKernelSessionState.ts`（kernelSessionIsStreaming / subscribeKernelSessionState）
- 复用：`src/stores/fileExplorerStore.ts`（FsChangeEvent 类型 / startFileWatcher 既有链路）
