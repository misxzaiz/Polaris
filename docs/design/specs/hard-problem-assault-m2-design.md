# 硬问题攻坚工作流 M2 设计

> 版本:1.1.0(完成态卡片已实施)
> 日期:2026-07-25
> 状态:**完成态 AssaultResultCard 已实施并测试通过**;运行中实时面板为未来项
> 关联:[ADR 0006](../../adr/0006-hard-problem-assault-workflow.md) · [PRD](../specs/hard-problem-assault-prd.md)

---

## 一、范围与实施状态

M2 在 M1(纯 workflow 脚本)基础上补三项:

| 项 | 状态 | 说明 |
|---|---|---|
| 1. 可观测面板 | **完成态已实施** | `AssaultResultCard.tsx` + chatBlocks 路由 + 9 测试全绿 |
| 2. 持久化恢复 | 设计待启动 | 复用 dispatch_tasks.json 加 assaultTasks 字段 |
| 3. 人工复核闸门 | **标志位已实施** | `needsHumanReview` 字段 + UI 提示;自动派发待启动 |

### 关键架构约束(2026-07-25 调研确认)

**workflow logs 是完成后一次性拉取,运行中不实时到达前端**:
- workflow 是 Claude Code SDK 内置工具(主会话内工具调用),不是独立 Tauri 会话进程
- `log()` 累积为工具最终 `tool_result`,仅完成后输出
- 前端无运行中 workflow 的 logs 拉取接口(TaskOutput 是主对话侧拉取,非前端可调用)
- 对比:DispatchCenter 实时性来自 dispatch 是 Polaris 自有后台会话(独立 CLI 子进程 + chat-event Tauri event 路由 + dispatch_report_status ipc 节流回报),workflow 工具不具备这些条件

**因此 M2 可观测面板采用"完成态展示"模式**(路径 C),非实时面板。运行中态仅展示工具自身 pending/running 状态。

## 二、已实施:AssaultResultCard.tsx

### 2.1 渲染策略

按 toolName `workflow` 在 `chatBlocks/index.tsx` 路由(类比 `DispatchTaskCard` 对 `dispatch_task` 的接线)。

数据源:`block.output`(workflow 完成后的 tool_result JSON 字符串)。

解析多格式兼容:
- 标准:`{summary, agentCount, totalTokens, logs, result, workflowProgress}`
- 嵌套:`{text: "..."}` 或 `{output: "..."}`
- 直接:result 对象作为顶层

### 2.2 展示内容

- **头部**:状态图标(solved 绿/open 灰)+ "硬问题攻坚" + Round 数 + needsHumanReview 徽标
- **结果摘要**:solved 显示 survivor 方法族;open 显示最强已证 + 缺口
- **验收件**:acceptanceArtifact 可展开(对应 wp2shell 的 /flag)
- **统计条**:agents / tokens / survivor / refuted / blocked 计数
- **方法族注册表**:从 logs 最后一个 STATE_SNAPSHOT 解析,blocked 灰显
- **攻坚时间线**:从 logs 提取 round_start/blocked/unlocked/survivor/refuted/snapshot/synth 事件,不同色标
- **人工复核提示**:needsHumanReview=true 时橙色提示条

### 2.3 降级

解析失败走 `ToolCallBlockRenderer`(通用工具块)。

### 2.4 测试

`AssaultResultCard.test.tsx` 9 用例全绿:
- 标准 output 解析 / solved 态 / 方法族注册表 / needsHumanReview / open 态 / 嵌套 text 格式 / 直接 result 格式 / 解析失败降级 / 运行中态

## 三、未来项:运行中实时面板(路径 A/B)

### 路径 A:文件状态 + 轮询(推荐)

- workflow 脚本通过 subagent 的 Bash 写状态到临时文件
- Rust 新增 `assault_read_state` ipc 命令读文件
- 前端 AssaultCenterButton 轮询(秒级,对攻坚任务几分钟~几小时够用)
- 成本:中;实时性:秒级延迟

### 路径 B:MCP 工具回报(最干净)

- 新增 polaris-assault MCP server + `assault_report_progress` 工具
- workflow 脚本调用该工具回报进度,由 MCP server emit Tauri event
- 成本:高(新增 MCP server);实时性:实时

### 启动条件

- M1 在真实场景被反复使用,证明完成态卡片不够
- 或攻坚任务时长超过单次会话(需运行中观察)
- 当前完成态卡片满足验证与回看需求

## 四、持久化恢复(设计待启动)

### 4.1 复用 dispatch_tasks.json

新增 `assaultTasks` 字段(不破坏现有 dispatch 字段):
```json
{
  "dispatchedTasks": [...],
  "assaultTasks": [
    {
      "id": "assault-...",
      "profile": "root-cause",
      "problem": "...",
      "status": "running|solved|open|failed",
      "rounds": 2,
      "families": [{key,blocked,attempts,lastNewMechanism}],
      "strongest": "...",
      "gap": "...",
      "solved": {family, artifacts, acceptanceArtifact} | null,
      "needsHumanReview": false,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

### 4.2 Rust 改动点

- `state.rs`:`AppState` 加 `assault_tasks: Vec<AssaultTask>` + Mutex
- `lib.rs` setup + web main:启动 `load_assault_tasks`
- 新增 `assault_*` ipc 命令(web 分支 `#[cfg(feature="tauri-app")]`,见 [[web-only-tauri-command-gate]])
- 原子写入 dispatch_tasks.json(tmp+rename)
- 风险:本机 cargo test --lib 受限,只能 cargo check --lib(见 [[rust-lib-test-env-limit]])

## 五、人工复核闸门

### 5.1 已实施

- workflow 脚本 `needsHumanReview = voteThreshold >= 3`(line 209-216)
- AssaultResultCard 渲染 needsHumanReview 徽标 + 提示条
- result 携带 `needsHumanReview` 字段

### 5.2 待启动:自动派发

- 前端按钮检测 needsHumanReview → 调 `dispatch_task`(role=主审)
- 主审 persona:`testing-reality-checker`(corpus 现实检验者)
- `continue_dispatched_task` 多轮追问
- 确认 → assaultTask.status: solved → confirmed

## 六、交付物

| 文件 | 状态 | 行数 |
|---|---|---|
| `src/components/Chat/AssaultResultCard.tsx` | ✅ | ~250 |
| `src/components/Chat/AssaultResultCard.test.tsx` | ✅ 9/9 | ~140 |
| `src/components/Chat/chatBlocks/index.tsx` | ✅ 接线 | +10 |
| `docs/design/specs/hard-problem-assault-m2-design.md` | ✅ 本文档 | — |

## 七、启动条件

实时面板/持久化/自动派发三项均不在本次范围。启动条件:
1. M1 在真实场景被反复使用,证明完成态卡片不够
2. 攻坚任务时长超过单次会话,需要跨重启恢复
3. 高风险结论(voteThreshold≥3)频繁出现,需自动派主审

当前完成态卡片 + needsHumanReview 标志满足验证与回看需求。

---
