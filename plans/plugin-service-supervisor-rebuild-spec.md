# spec：插件服务子系统完全重构（ServiceSupervisor + Reconciler）

> 状态：**specd（2026-11-11 定案）**。用户定案：完全重构，不迁就历史包袱。
> 取代：`plugin-service-lifecycle-governance-plan.md` 的 R0→R3 渐进路线（该文档降级为背景与根因依据）。
> 需求：needs 068（总案）/ 067（收编为其中的进程收容与清杀模块）。
> 范围：`src-tauri` 宿主侧。插件仓只新增一个可选 helper（服务自查加速），宿主不依赖它。

---

## 一、定案声明

**推倒 `plugin_service_manager.rs`（1074 行）+ `plugin_service.rs` 内两个 wmic 清杀函数，重建为「单写者对账引擎」。**

渐进路线作废的理由（写在前面，防止回头）：R0-R3 保留 watcher/stop_service 既有语义逐步改造，但根因分析已证明竞态病灶（X2 全系列修的双拉/僵尸/停丢）正是**多写者分散决策**的结构产物——watcher、stop_service、start_service_internal 三处各持一半状态机。在这种结构上做增量，每个补丁都是新竞态的温床（X2-⑥ 挡死 auto-restart 即实证）。不关注历史数据与兼容 = 授权一次性换掉状态机本身。

## 二、目标架构

```
                ┌────────────────────────────────────────────────┐
  期望（纯派生）  │  desired(pluginId, serviceId)                  │
  plugin_states ─→  = enabled && autoStart/service 声明            │
  manifest      │    随时可重算，无存储、无记忆                      │
                └───────────────┬────────────────────────────────┘
                                │ 输入
                ┌───────────────▼────────────────────────────────┐
                │  Reconciler::tick()  —— 唯一写者、幂等、可重入    │
                │  1 读期望  2 读 registry(账本)  3 探测实际        │
                │    (sysinfo 进程表 + PID + 端口 + http 健康)     │
                │  4 算 diff → 动作表                              │
                │  5 执行：spawn / kill / 注销 / MCP 注册联动       │
                │  6 写 registry + 广播快照                        │
                └───┬───────────────┬─────────────────┬──────────┘
      触发：定时10s   │               │                 │
            事件唤醒──┘               │                 │
        (状态变更/进程退出/            ▼                 ▼
         用户请求/卸载/唤醒)    registry(账本json)    对外快照
                                dataRoot 内         cap.pluginServiceManager
        ▲                       epoch/PID/端口        + service.status 事件
        │ 投递事件，不摸进程      每次执行后单点重写      (对外协议字段不变)
  ProcessObserver
  (唯一保留的旧概念：
   tokio Child wait →
   投递「epoch 已死」事件)
```

### 三条不变式（架构门槛，评审按此验收）

1. **单写者**：全系统只有 `Reconciler::tick()` 执行进程动作（spawn/kill/端口分配回收）。用户启停、卸载、健康判死、进程退出——一律转化为「事件或期望变更 + 唤醒」，绝不直接摸进程。X2 系列竞态在新结构下**不可表达**，而非被修复。
2. **真相三方制**：期望 = 纯派生（可随时重算）；实际 = OS 探测（不信任任何缓存）；registry = 账本（只记录「宿主承诺过什么」，供孤儿归属判定与启动对账，**不是状态权威**）。任何两方不一致以 tick 收敛，无超时掩盖。
3. **幂等可重入**：tick 可在任意时刻被任意事件打断重跑；动作表执行前按实际重验（spawn 前查端口、kill 前查 epoch 归属）。崩溃/强杀后重启，第一轮 tick 即恢复一致（含清理上一任残留——即 067 的「启动自愈」不再是独立机制，是 tick 的自然行为）。

## 三、核心设计

### 3.1 进程身份契约（epoch）

- 每次 spawn 生成 `epoch = 时间戳^随机`（u64），写入 registry，并以 env `POLARIS_EPOCH` 注入进程（配合命令行日志可追溯）。
- 进程归属判定：命令行含 `<dataRoot>/plugins/<pluginId>/` → 本数据根服务候选；再查 registry：
  - epoch 在册且 PID 匹配 → 在管
  - epoch 不在册 / PID 不匹配 / registry 无记录 → **孤儿 → 杀**（父进程校验只作为多实例保护的双保险：PID 活且映像名为本宿主则跳过并告警）
- registry per dataRoot 天然隔离多实例；env `POLARIS_HOST/PORT/TOKEN/POLARIS_EPOCH/HOST_PID/SERVICE_ID` 一步注入（kvclient 优先读 env——跨根渗透与孤儿骚扰活宿主同时根治）。

### 3.2 diff 动作矩阵（tick 核心逻辑，纯函数，全单测）

对每个 `(pluginId, serviceId)`：

| 期望 | 实际(OS) | 判定 | 动作 |
|---|---|---|---|
| Running | 无进程 | 缺失 | spawn（受退避预算约束，见 3.3） |
| Running | 进程活，健康 ok | 一致 | 无（更新快照） |
| Running | 进程活，健康连续 N 败 | 僵死 | kill → 下轮 spawn |
| Stopped | 在管进程活 | 违约 | kill + 注销 + 端口回收 |
| 任意 | registry 无记录的 plugins/ 路径进程 | 孤儿 | 杀（3.1 归属判定） |
| 任意 | 同 pluginId 多个在管 epoch | 重复 | 保最新 epoch，杀其余 |
| 任意 | MCP 注册态 ≠ 服务 Running | 注册漂移 | 补注册 / 摘除+标注原因 |

参数沿用现值（已合理）：稳定 60s 清零重启预算、健康连败阈值 3、探测间隔 30s、tick 周期 10s。**BOOT_GRACE 删除**——它是「多实例同拍互踩」的补丁；新架构下重启由退避预算+抖动自然错峰（保留现有纳秒抖动逻辑），且互踩源（跨根渗透）已断。

### 3.3 退避预算（唯一保留的旧语义，收编进 tick）

per-service `restart_count + 指数退避`，逻辑与现值一致但**只在 tick 内决策**：spawn 失败/进程早夭（<60s）计数+退避，超 `maxRestarts` → Error 终态（tick 不再拉起，快照标注原因）。固定端口冲突 = 非瞬态，直接 Error 终态不进预算（067 P1-2 吸收）。动态端口 hold-listener 吸收。

### 3.4 Windows 收容与清杀（067 spec 原样收编）

- 宿主级 Job Object（KILL_ON_JOB_CLOSE），所有直接子进程（插件服务/MCP stdio/引擎 CLI/PTY）spawn 即 assign——tick 之外的一切死亡形态（强杀/崩溃/exit）由 OS 兜底。`cfg(windows)` 模块，`windows-sys` 补 `Win32_System_JobObjects` feature，web-only 门控天然通过。
- 清杀模块：sysinfo 枚举（一次性进程表快照）+ TerminateProcess，替代 `kill_processes_by_command_line`/`by_image_name` 全部外部命令依赖。卸载流程改为「期望删除 + 唤醒 tick（收敛停机）→ 清杀兜底 → 删目录」。

### 3.5 协议 v2 与 MCP 门控（一步到位，无迁移期）

- `build_args` 增加 `{{hostPid}}`；env 注入全家桶（3.1）。旧插件不引用新变量即无感——无需版本协商。
- `resolve_external_plugin_mcp_servers` 增加 supervisor 快照入参：服务非 Running → 该插件 MCP server 不进 AI 配置，产出 `unavailable_reason`（面板 + AI 诊断可见）；`status` 事件 → MCP 注册重算（已有 broadcast 通道）。
- `simple_ai/mcp` spawn 失败不再静默：失败原因进会话诊断 + 工具列表标注。

### 3.6 对外协议（唯一保留的兼容承诺）

`ServiceStatus` 结构与 `plugin.service.status` 事件字段**不变**（前端 56 store 之一在消费）——这是对前端的稳定接口承诺，不属于「历史包袱」。新增字段（epoch、lastAction、unavailableReason）向后兼容追加。`cap.pluginServiceManager` 输出对账快照 + 最近动作环形日志（10 条）。

### 3.7 registry 文件

`<dataRoot>/services-registry.json`：`[{ epoch, pluginId, serviceId, pid, port, startedAt, lastError }]`。单写者（tick 执行末尾整文件重写，tmp+rename 原子）。损坏/缺失 → 当轮按「无记录」处理，孤儿判定转为全部候选杀 + 重拉——安全方向失败。

## 四、删除清单（完全重构的兑现）

| 删除 | 位置 | 去向 |
|---|---|---|
| ManagedService 状态机（services HashMap 权威、stop_signal/finalize 握手、spawn_process_watcher 内嵌重启决策、spawn_health_check 独立任务、BOOT_GRACE 两处特判） | plugin_service_manager.rs 约 700 行 | ProcessObserver 缩为 ~40 行（Child wait → 投递事件）；探针并入 tick |
| 「Starting/Running 挡检查」等全部并发挡 | start_service_internal | 结构性消失（无并发写者） |
| `kill_processes_by_command_line` / `kill_processes_by_image_name`（wmic/taskkill） | plugin_service.rs :1165-1311 | sysinfo 清杀模块 |
| stop_service 的 3s 超时 block_on（lib.rs CloseRequested） | lib.rs :1050-1067 | 改为「置期望+唤醒」，退出不等 tick（Job Object 兜底），`exit(0)` 矛盾消失 |
| serviceKey 双锁（allocated_ports/port_counter 并锁 dance） | allocate_port/reserve_port | 收进 tick 串行段，锁只剩一把 |

## 五、实施切分（3 个 PR，顺序依赖）

| PR | 内容 | 验证 |
|---|---|---|
| PR-1 基建 | sysinfo 依赖 + Job Object 收容模块 + 清杀模块（独立可用，先落不改行为） | 现有 spawn 路径接入 assign；强杀宿主 0 残留 |
| PR-2 核心 | ServiceSupervisor + Reconciler + registry + 协议 v2 env/args；**一次切换删除旧实现**（§四清单） | diff 矩阵全单测（fake observer）；e2e 冒烟：spawn→kill→tick 拉起；双构建门控 |
| PR-3 联动 | MCP 健康门控 + spawn 失败显性化 + cap 快照 + 卸载接线 + 前端面板新增字段 | 禁用插件→MCP 摘除；服务死→面板/AI 标注原因 |

PR-1 可独立交付应急（孤儿即刻根治）；PR-2 是范式切换点；PR-3 依赖 PR-2 快照。

## 六、验收（对应 067/068 合并口径）

1. diff 矩阵每行至少一个单测（纯函数，fake 输入）；auto-restart 回归场景（进程死后 tick 真实 re-spawn）为固定用例。
2. 强杀宿主（任务管理器）→ 复扫 0 残留（Job Object）。
3. kill -9 单个服务进程 → ≤tick 周期+退避内自动拉起，快照与真实进程一致。
4. 禁用插件 → 进程终止 + MCP 工具摘除 + 面板标注，全程无手工干预；反向启用同理。
5. 三数据根同启 → 无跨根请求（日志验证）；同根无重复服务进程。
6. 孤儿（手工构造）→ 下一轮 tick 清杀，无需看板插件介入（看板降级为纯观测，可选不建）。
7. `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`、`cargo check`、`cargo clippy --lib` 零新增 warning；前端 `pnpm exec tsc --noEmit` 通过（status 协议未破坏）。

## 七、风险与对策

- **一次切换风险**：PR-2 替换面大 → 对外协议冻结（3.6）+ diff 矩阵单测先行 + PR-1 已把 OS 层独立验证。回滚 = revert 单 PR。
- **Job Object 连坐面**：引擎 CLI/PTY 一并收容，宿主崩溃全灭——现状 stdio 断裂同样全灭，行为等价且更干净；PTY 若有独立诉求可在 PR-1 评审时豁免（默认收容）。
- **tick 串行段延迟**：全量探测（sysinfo 枚举 + http 健康）可能数百 ms → tick 在 tokio spawn 的独立任务执行，不占 runtime；探测超时上限 3s/服务，串行段仅动作执行。
- **registry 与实际竞态窗口**：tick 内「先探测后动作」窗口内世界可能变化 → 动作执行前重验（幂等不变式），最坏情况多一轮 tick 收敛。
