# ServiceSupervisor 孤儿清杀误杀修复 spec（2026-11-11）

## 背景

2026-11-11 ServiceSupervisor 重构（`155f41f2`）上线后，codebuddy 引擎会话 100% 失败
（生产日志 11-11：5 会话全灭、`响应帧到达=0`；11-04~11-10 正常）。

根因：`collect_orphans` 的孤儿判定是「命令行含 `<dataRoot>\plugins\` 的进程即杀」，
**排除表传空**（`find_by_cmd_fragment(&fragment, &[])`），与注释声明的
「PID ∉ 在管记录」不符。误杀面：

1. **插件引擎适配器进程**（engine-v1 协议，`node <dataRoot>\plugins\<id>\adapter.js`，
   随会话生灭、不进 supervisor 管表）——codebuddy / qoder 等全部命中，
   每 10s tick 杀一次 →「发消息无回复 / 回复一半断掉」。
2. **supervisor 在管服务自身**（node 服务脚本路径同样含 plugins 路径）——
   拉起→10s 后被自己杀→重拉（11-11 日志 343 次清杀中大量为此「自杀循环」）。
3. 适配器被杀时 result 帧未到达 → `resume_token` 永远采不到 →
   续聊 `continue 查 map: token=None` 退化为新会话。

## 目标与原则

**打补丁不可接受**：不能只把「在管 PID + 引擎 PID」抄进排除表——排除表是
黑名单的白名单，新引擎/新 spawn 点忘登记就再回归一次（本 bug 正是
「注释写了、代码没写」的实现漂移）。

正解：**把「孤儿」的语义修正为真孤儿**——判定依据从「路径特征」改为
「**宿主还认不认这个进程**」。宿主认领进程的机制已存在：Job Object 收容所
（`job.rs`，`c3281d57` 已覆盖全部 8 个引擎 spawn 点 + supervisor 自身 spawn 点）。
宿主直接子进程全部收容进 Job → **Job 成员 = 宿主认领的进程全集** →
孤儿清杀 = 「命令行含 plugins 路径 && 不是 Job 成员」。

该判据下排除表天然完备：

- 在管服务：spawn 时已 `assign_child` → Job 成员 → 不杀；
- 引擎适配器 / MCP stdio server / CLI：spawn 点已接 `assign_std_child` → Job 成员 → 不杀；
- 真孤儿（宿主崩溃后残留、或收容失败的进程）：不在 Job → 照杀（保留原设计意图）。

宿主重启后 Job 清空，残留旧进程不属新 Job → 依然被判孤儿清杀，
启动对账「旧进程清扫」场景不回退。

## 接口

### 新增（`src-tauri/src/services/supervisor/proc_kill.rs` / `job.rs`）

```rust
/// 枚举本宿主 Job Object 内全部进程 PID（孤儿判定的排除全集）。
/// 非 Windows 或 Job 不可用时返回 None（调用方降级为旧路径语义）。
pub fn job_member_pids() -> Option<HashSet<u32>>;

/// 判断 PID 是否为本宿主 Job 成员。
pub fn is_job_member(pid: u32) -> bool;
```

Windows 实现：`QueryInformationJobObject(JobObjectBasicProcessIdList)`；
快照非实时但足够（清杀 tick 10s 周期，误判窗口 ≤ spawn 到 assign 的毫秒级间隙，
且 spawn 与 assign 在同一同步代码块内，实际窗口为零）。

### 变更（`service.rs::tick_once` / `collect_orphans`）

```rust
fn collect_orphans(snapshot, data_root, exclude: &HashSet<u32>) -> Vec<u32> {
    snapshot.find_by_cmd_fragment(&fragment, exclude_as_slice)
}
```

`tick_once`：`exclude` = Job 成员集合；Job 不可用（None）时降级为
「在管 epochs PID ∪ 引擎活跃适配器 PID」（见「降级路径」）。

### 降级路径（Job 不可用时，不裸奔回旧 bug）

`AppState.engine_registry` → 各引擎 `active_adapter_pids()`（`AIEngine` trait 新增
default 方法，返回 `Vec<u32>`；plugin_process_engine 实现 = `sessions` 表全部 PID）。
supervisor 持有 `Arc<AsyncMutex<EngineRegistry>>` 注入（`state.rs` 构造点接线）。

注意锁序：supervisor tick（std 无锁）→ 读 `engine_registry`（tokio Mutex）。
tick 在 tokio runtime 内运行，无死锁风险；registry 锁持有时间 =
各引擎 PID 枚举（微秒级），不与 `ai_chat_core` 的长临界区互斥饥饿。

### reconciler 纯函数侧（语义不变，签名不变）

`orphan_pids` 字段的语义契约收紧为「**已通过排除判定的真孤儿**」——
调用方（tick_once）完成 Job/降级排除后传入。reconciler 不感知 Job。
`Action::KillOrphan` 执行前再验一次 `is_job_member(pid)`（动作前重验幂等
不变式，与 Kill 动作同范式）：spawn→assign 竞态窗口内新收容的进程
到执行时刻已是 Job 成员 → 跳过并 note。

## 验收

- [x] 单测（reconciler 层）：`t7b_orphan_exclusion_happens_in_observation_layer`
      固定「排除发生在观测层」的分层契约；`t7` 原有矩阵回归无破坏
      （`cargo test --lib --no-default-features supervisor` 18/18 绿）。
- [x] 单测（job 层）：`job_member_pids_contains_assigned_child`——真实 spawn
      子进程 assign 后 ∈ 成员集合（本修复核心判据的运行期实证）。
- [x] `cargo check` 零 error、supervisor/job 模块 clippy 无新增 warning。
- [x] `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过
      （非 Windows 分支经降级路径编译验证——Windows cfg 分支由本机 cargo check 覆盖）。
- [x] 顺手修复存量编译错误：`web/integration_tests.rs` 残留 B1-6 出仓字段
      （`scheduler_daemon` / `executor_registry`），测试 profile 由此恢复可编译。
- [ ] 真宿主 E2E：codebuddy 会话运行 > 30s（跨 ≥3 个 tick），日志无
      `孤儿清杀 pid=<适配器PID>`，`响应帧到达` 恢复非零，续聊 `token=Some(...)`。
      （待用户安装新构建验证）

## 已知边界

- Job Object 为 Windows-only；非 Windows 的 `assign_*` 是空实现，
  `job_member_pids()` 返回 None → 降级路径生效（引擎 PID + 在管 PID 排除）。
  当前产品仅 Windows 桌面 + Web bin（同机），非 Windows 降级路径覆盖足够。
- `kill_pid` 是单点杀（非树杀）；孤儿清杀对「孤儿 CLI 孙进程」的覆盖依赖
  路径特征命中（node 进程命令行含 adapter 路径）——沿用现状，不在本次范围。
- 真孤儿若与活跃进程 PID 复用（Windows PID 重用极快）理论上可能误杀，
  概率极低且 Job 成员判定挡住绝大多数，不再加宽限期。
