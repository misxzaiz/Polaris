# spec：插件服务孤儿进程治理（需求库 067）

> 状态：**方案定案，未实施**（2026-11-10 分析定稿）
> 需求：`Polaris-plugin/needs/067-plugin-service-orphan-process-governance.md`（idea → analyzed）
> 性质：生产级缺陷治理。宿主侧三处改动（主仓）+ 一个兜底插件（插件仓）。

---

## 一、背景与生产实证

- 2026-11-10 实测：单机 **53 个插件服务孤儿进程**（feed-radar×8、quote-sentinel×13、needs×13、whale-pet×12 等），横跨正式 / 开发 / 旧正式三个数据根；feed-radar 单孤儿持续写日志 44MB+。
- 多实例同启互踩实证（`plugin_service_manager.rs:40-46` BOOT_GRACE 注释自证）：一天 **91 次 auto-restart / 178 次「端口已被其他插件服务占用」**，全部聚簇在启动时刻。
- 用户侧症状：**MCP 注册失败高频出现**（因果链见 §三）。
- 历史修复的局限：X2（2026-10-24）修的是「谁持有谁负责杀」的 **graceful path**（drop/stop 时）；P0-3（BOOT_GRACE）治的是互踩症状（错峰），**均不覆盖宿主非正常死亡**。

## 二、根因链（四重缺口叠加，源码实证）

```
宿主死亡形态            现有防线                          结果
────────────────────────────────────────────────────────────────
任务管理器强杀/崩溃     无（kill_on_drop 不触发——Rust    100% 孤儿
                       drop 不跑；CloseRequested 钩子
                       不执行）
正常关窗               CloseRequested → stop_all(3s)     3s 超时后
(lib.rs:1050-1067)     → exit(0) 超时兜底                 残余成孤儿
                       ⚠ exit(0) 不跑 drop，kill_on_drop
                       兜底注释自相矛盾
卸载插件               stop_services_for_plugin（本实例  跨实例/历史
(plugin_service.rs     有效）→ kill_by_command_line      残留清杀全废
:1017-1093)            → ⚠ wmic 已从 Win11 移除，
                       失败仅 tracing::warn 不中止
多实例(3 数据根)       每实例独立 autostart 全套服务；    孤儿按实例
                       kvclient 端点自发现互相渗透        数线性放大
```

关键代码点：

| 缺口 | 位置 | 实证 |
|---|---|---|
| 无父子生命周期绑定 | `plugin_service_manager.rs:312-335` 仅 `kill_on_drop(true)` | 强杀即孤儿 |
| 无宿主心跳/宿主 PID 注入 | `build_args`（同文件 ：993-1017）模板仅 5 变量，无 `{{hostPid}}`；env 无注入 | 服务无从自知宿主已死 |
| 清杀手段失效 | `plugin_service.rs:1211` `wmic process where ...`，:1245 失败仅 warn | Win11 无 wmic，查询恒败 |
| 无孤儿检测 | 全库无任何发现通道 | 53 孤儿只能肉眼排查 |

## 三、「MCP 注册失败」因果链（本 spec 专查）

```
53 孤儿（跨数据根）
  └─ 各自 kvclient 端点自发现（anchor.json → config.json → 端口向上扫 25 个）
      └─ 高频 cap.kv 请求打到【活宿主】（feed-radar tick 每 7s kvKeys + 全插件轮询）
          └─ 活宿主 dispatch/kv 高负载（已知高危：kv list 可楔死通道，
             记忆 polaris-host-dispatch-wedge-and-kv-list）
              └─ AI 会话启动 → spawn 插件 MCP stdio server
                 (ai/engine/simple_ai/mcp/mod.rs 会话级并发 spawn)
                  └─ MCP server initialize / tools/call 须回访宿主 cap.kv
                     （feed-radar 的 MCP server 数据面 = kvclient → 宿主）
                      └─ 宿主响应慢/超时 → MCP 注册失败
```

共因：插件 **MCP stdio server 自身同样是 `Drop kill` 语义**（`simple_ai/mcp/client.rs:228-230` → `transport.rs:153-157`），宿主强杀时同样成孤儿（目前靠 node stdin EOF 自觉退出，无保证）。**任何只治理插件服务的方案都漏掉这条线**。

结论：MCP 注册失败是孤儿进程的**下游症状**而非独立故障——孤儿清零 + 宿主收容全覆盖后自然缓解；dispatch/kv list 楔死是另一共因（**另案**，见 §八）。

## 四、方案空间与取舍

| 方案 | 覆盖面 | 判定 |
|---|---|---|
| A. Job Object 收容（Windows） | 强杀/崩溃/exit 全形态，OS 级强保证 | ✅ **根治层，定案** |
| B. `{{hostPid}}` 心跳协议 | 跨平台；依赖插件逐个自觉迁移 | ✅ 长期层（P2），不强制 |
| C. 仅心跳、不动宿主 | 不配合的插件永远漏 | ❌ 弃（「旧版乱来」的教训即靠约定不靠机制） |
| D. wmic → PowerShell CIM | 修复卸载清杀 | ⚠ 弃：实测 WMI 抽风返回空/单条，换汤不换药 |
| E. 清杀 Rust 原生化（sysinfo） | 消除外部命令依赖，WMI 坑消失 | ✅ **定案（P1）** |
| F. 启动时孤儿自愈清扫 | 历史存量常态化自愈 | ✅ **定案（P0-2）** |
| G. 看板插件（process-guard） | 兜底观测 + 用户手动清理 | ✅ 定案（P2，不动宿主核心，符合 067 边界） |

## 五、定案：四层防线

### P0-1 宿主进程级 Job Object 收容所（根治，Windows 主防线）

**原则：宿主的每一个直接子进程都进同一个 Job Object；宿主死亡 = OS 保证子进程全灭。**

- 宿主启动时 `CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；Job 句柄随宿主进程存活，宿主任何死亡形态（强杀/崩溃/`exit(0)`/正常退出）OS 自动 `TerminateJobObject`。
- 统一 assign 点（收容清单，实施时逐点核对）：
  1. `plugin_service_manager.rs` 插件服务 spawn（`child.raw_handle()` → `AssignProcessToJobObject`）
  2. `simple_ai/mcp/transport.rs` MCP stdio server spawn
  3. 引擎子进程（`plugin_process_engine.rs` / `opencode.rs` / claude/zcode CLI spawn 点）
  4. portable-pty（cap.terminal）——评估是否纳入（终端进程被宿主崩溃连坐是否合预期，实施时定，默认纳入）
- 与 `kill_on_drop` 不冲突：graceful path 照旧走 drop/stop（更快更干净），Job 只兜非正常死亡。
- 已知取舍：
  - tokio `Command::spawn()` 无 SUSPENDED 窗口，assign 与宿主崩溃间存在毫秒级竞态窗口 → 接受（窗口内崩溃概率可忽略；追求零窗口需换 std Command + SUSPENDED，破坏 tokio watcher 架构，不值）。
  - 引擎 CLI 连坐：宿主崩溃时 CLI 全灭。现状 stdio 断裂 CLI 同样活不长，统一收容更干净。
  - 嵌套 Job：宿主自身被 IDE/CI 的 Job 包裹时 Win8+ 嵌套语义正常。
- 依赖：`windows-sys` 已有（0.59），补 feature `Win32_System_JobObjects`。代码放 `cfg(windows)` 模块，**天然过 web-only 门控**（polaris-web Windows 构建同样受益）。

### P0-2 启动孤儿自愈清扫（宿主侧，兜存量）

- 宿主 setup 完成后**后台线程**扫一次：枚举进程表（sysinfo），命中「命令行含 **本数据根** `plugins\<id>\` 路径」且「父进程已死（PID 不存在，或存在但映像名 ≠ 宿主）」→ 清杀。
- 只清本数据根：跨数据根的历史孤儿留给 P2-1 看板（避免多实例互杀——他实例的服务父进程活着，天然被排除，但保守起见范围先收窄）。
- 误杀防护双校验：PID 存活 + 映像名 = `polaris.exe`（防 PID 复用误判）。
- 效果：任何漏网孤儿在下一次启动时自愈，规模不再单调增长。

### P1-1 清杀链路 Rust 原生化（修 wmic 失效）

- `kill_processes_by_command_line` / `kill_processes_by_image_name` 重写：sysinfo 一次性枚举进程表（含命令行）→ 内存匹配 → `OpenProcess+TerminateProcess`（windows-sys）。
- 移除对 `wmic`（不存在）/`taskkill`（本地化输出、外部进程开销）的全部依赖；Unix 侧 `pgrep/kill` 同步替换为 sysinfo/nix。
- 卸载流程顺序不变：`stop_services_for_plugin` → 原生清杀（跨实例/残留兜底）→ 删目录。
- 新增依赖：`sysinfo`（纯 Rust、零系统依赖；同时服务 P0-2 与 Unix 路径）。Linux CI 无新增系统库负担。

### P1-2 端口占用改判非瞬态 + 分配竞态收窄

- 固定端口插件（`contribution.port = Some`）：`reserve_port` 冲突 → **Error 终态，不进 auto-restart**。「端口被外部进程占用」不是瞬态故障，91 次/天重试风暴的实证；面板给出可读错误。
- 动态分配（`allocate_port`）：bind 探测通过后**持有 TcpListener 直到 spawn 前释放**，收窄「探测→记账→spawn」窗口内他实例抢同一端口的竞态（多实例同启互踩的另一半根因）。
- `restart_on_failure` 对「端口类错误」单独降级：最多一次延迟重试，不消耗完整 maxRestarts 预算。

### P2-1 process-guard 看板插件（插件仓，兜底观测）

- 形态：工具型插件（同 builtin-plugin-cleanup 模式），`cap.bash`+`cap.fs` 只读扫描 → 面板列出孤儿（PID/命令行/启动时间/所属数据根）→ 用户确认后清杀。
- 实现纪律（决策记录已买坑）：
  - PowerShell 枚举加**数量下限校验 + 重试**（WMI 抽风返回空/单条）；
  - 函数返回数组用 `@()` 包裹（逗号包裹合并返回值坑）;
  - **短窗口策略**：扫描得 PID 清单 → 直接杀 → 复扫验证，不做杀前逐个复查（WMI 二查可能返回空导致全部 SKIP）。
- 定位：P0/P1 落地前是主清理手段；落地后退化为存量观测面。不动宿主核心二进制（067 边界）。

### P2-2 `{{hostPid}}` 协议字段 + env 注入（跨平台长期线）

- `build_args` 模板新增 `{{hostPid}}`；spawn 时同步注入 env `POLARIS_HOST_PID`（零协议破坏：旧插件不引用该变量则完全无感）。
- 插件服务可选自查（node: 轮询 `process.kill(pid, 0)`，ESRCH 即自杀）；宿主提供共享 helper 模板（插件仓一份参考实现，渐进迁移，不强制）。
- Unix 主防线为 `PR_SET_PDEATHSIG`（spawn 前 pre_exec）——**本 spec 不含**，标注 follow-up；Windows 上 Job Object 已是更强保证，心跳在 Windows 是冗余层。

## 六、明确不做（边界）

- 不动插件服务协议通道（mcpServers stdio 语义不变）。
- feed-radar 日志体量治理 → 另案（needs 065 / 050）。
- dispatch 通道 kv list 楔死修复 → 另案（MCP 注册失败共因之二，见记忆 `polaris-host-dispatch-wedge-and-kv-list`）。
- 心跳自杀不作为 Windows 防线（Job Object 已强保证）。

## 七、验收（对齐 067 四条 + 增补）

1. 任务管理器强杀宿主 → 复扫 **0** 残留插件服务/MCP stdio 进程（Job Object 生效；可脚本自动化：spawn → 强杀 → `Get-CimInstance` 复扫）。
2. 开发实例卸载 feed-radar → 原生清杀生效，进程表无相关 node 进程（不再依赖 wmic）。
3. 双实例同启（同固定端口插件）→ 端口冲突实例**一次性** Error 终态，audit log 无重试风暴新增。
4. process-guard 面板列出孤儿并可一键清理；无关 node 进程（用户自开 dev server）不命中。
5. （增补）自愈：人工造孤儿（spawn 后立即强杀宿主）→ 再次启动宿主 → 启动后复扫为 0。
6. （增补）门控：`cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过；`cargo check` / `cargo clippy --lib` 无新增 warning。

## 八、实施顺序建议

```
P0-1 Job Object 收容        ← 单点根治，收益最大，先做
P1-1 清杀 Rust 原生化        ← 与 P0-2 共用 sysinfo 引入
P0-2 启动自愈清扫            ← 依赖 P1-1 的枚举基建
P1-2 端口非瞬态改判          ← 独立小改，可并行
P2-1 看板插件                ← 插件仓独立推进（可先行，治理存量）
P2-2 hostPid 协议/env        ← 随任意宿主改动顺手落 env，插件迁移渐进
```

P0-1 + P1-1 + P0-2 三项落地即达成「孤儿不再产生 + 存量自愈」；P2 两项是兜底与长期。
