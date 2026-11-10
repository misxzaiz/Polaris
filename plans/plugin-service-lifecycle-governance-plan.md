# plan：插件服务生命周期治理总案（声明式对账架构）

> 状态：**方案定案，未实施**（2026-11-10 分析定稿）
> 需求：needs 068（本总案上位）；067 孤儿进程专项收编为执行层（R1）
> 性质：架构级治理。现状评价「管理不了」的根因不是某个 bug，而是**管理范式错误**：命令式进程管理 + 无对账，状态漂移必然累积。

---

## 一、三症状的机制定位（全部源码实证）

### 症状 1：「需要的插件没有注册进 AI」

| # | 机制 | 位置 | 定性 |
|---|---|---|---|
| A | **auto-restart 全废回归**：`aba91319`（X2-⑥，2026-10-24）加「Starting 也挡」防双拉，但 watcher 重启路径自己置 `Starting` 再调 `start_service_internal` → **被自己的挡检查拦死，永不重新 spawn**。日志打「auto-restarting」假象，进程死了状态永久卡 Starting（无 healthCheck）或宽限后判 Error | `plugin_service_manager.rs:277-284` vs `:785/:884` | **P0 bug，症状主因** |
| B | **MCP 注册与实际可用性脱节**：`resolve_external_plugin_mcp_servers` 纯静态解析（enabled + mcp_enabled），不看服务健康。服务死了 MCP 配置照发，AI 会话 spawn 的 stdio server 调不动后台服务 | `mcp_config_service.rs:537-627` | 架构缺口 |
| C | **spawn 失败静默跳过**：MCP client 并发 spawn「失败的跳过并 log，不阻断会话」，工具列表静默缺失，用户无从得知原因 | `ai/engine/simple_ai/mcp/mod.rs:42` | 可观测缺口 |

### 症状 2：「插件没有关闭」
= needs 067 全部（强杀/崩溃无收容、`exit(0)` 不跑 drop 与注释自相矛盾、wmic 失效、多实例放大）。另有 A 的衍生：状态卡「启动中」的服务实际进程已死，面板呈现与真相相反。

### 症状 3：「重复启动」

| # | 机制 | 定性 |
|---|---|---|
| A | **多实例功能重复**：每实例独立 autostart 全套服务，动态端口各自分配**不撞**（178 次/天端口报错只是互踩副作用），真正问题是**两份 feed-radar 同时抓取**→ 双写 kv 竞态。「重复启动」的真形态是服务重复，不是端口冲突 | 架构缺口 |
| B | **跨数据根渗透**：kvclient 端点自发现（anchor/config → 端口向上扫 25 个），A 根的服务请求打到 B 根宿主 → 三个数据根的服务可能**写同一个 kv**，竞写放大 | `kvclient.js:10-16`，注释自证「env 优先」但宿主从未注入 env |
| C | 用户补偿操作叠加：看到服务不工作手动重启，多实例下每实例又各起一份 | 症状 1 的下游 |

**共同根因**：服务状态是内存 HashMap 的「独断真理」，但真实世界（OS 进程、其他实例、MCP 注册）从不与之对账；且全局没有「同一插件服务应当存在几份」的唯一性语义。

## 二、业界范式调研（定案依据）

| 范式 | 要点 | 对 Polaris 的映射 |
|---|---|---|
| **systemd / s6 / supervisord / k8s**：desired state + reconciliation loop（[Chainguard: The Principle of Reconciliation](https://www.chainguard.dev/unchained/the-principle-of-reconciliation)、[K8s Reconciliation Patterns](https://hkassaei.com/posts/kubernetes-and-reconciliation-patterns)、[s6 overview](https://skarnet.org/software/s6/overview.html)） | supervisor 持有**期望状态**（up/down + 重启策略 always/on-failure），持续观察实际进程，收敛 diff；s6 哲学「daemons never started manually, always under a supervisor」 | 服务永不裸跑、状态靠对账收敛而非靠启动时刻记对 |
| **VS Code**：进程面收敛——所有扩展跑在**单一 extension host 进程**，activation events 懒激活，崩溃隔离（[extension host 进程模型](https://github.com/microsoft/vscode/issues/208380)、[懒激活](https://github.com/microsoft/vscode/issues/171135)） | VS Code 用「进程面收敛」换「管理面简单」。Polaris 产品需求是每插件独立服务（进程面不收敛），因此**必须自建 supervisor**，无法像 VS Code 那样只靠单进程收容 | 管理复杂度要有专门的架构层承接 |
| **MCP 规范**：核心 spec 不强制生命周期（[NSA MCP 安全备忘](https://www.nsa.gov/Portals/75/documents/Cybersecurity/CSI_MCP_SECURITY.pdf)、[AWS MCP 部署实践](https://docs.aws.amazon.com/prescriptive-guidance/latest/mcp-deployment-patterns-on-aws/best-practices-for-mcp-deployments.html)） | 生命周期责任落在 client（宿主）侧。stdio server 由 client 全权托管是社区事实标准 | Job Object 收容（宿主死=子进程死）是对 spec 空白的正确补位 |
| **Dapr/sidecar**：sidecar 与主进程同生共死，发现信息由控制面注入 | 服务进程与宿主的绑定不能靠插件自觉，靠 spawn 时注入 | env 注入端点，断跨根渗透 |

与项目自身哲学同构：session-v2「**日志即真相，前端只是缓存**」→ 服务域推广为「**registry 即真相，内存只是缓存**」。项目已有对账先例，不是引入新范式，是把已验证的范式推广到服务域。

## 三、定案：期望状态 + 对账循环 + 可靠执行，三层架构

```
┌─────────────────────────────────────────────────────┐
│ L1 期望状态（desired state，唯一权威，纯派生）           │
│   = f(plugin_states, manifest, 用户开关)               │
│   不新增存储：启用状态已有，服务该不该跑完全由它推导        │
├─────────────────────────────────────────────────────┤
│ L2 对账循环（reconciler，新增核心）                      │
│   周期(10s) + 事件触发(启停/安装卸载/健康变化/窗口唤醒)    │
│   每轮：读期望 → 读实际(registry落盘+OS进程+健康探测)     │
│        → 算 diff → 收敛动作                             │
│   收敛动作集：                                          │
│   · 应跑没跑 → 拉起（受重启策略约束）                     │
│   · 不该跑在跑 / 登记外进程(孤儿) / 重复进程 → 杀          │
│   · 服务 Running 但 MCP 未注册 → 补注册                  │
│   · 服务非 Running 但 MCP 注册着 → 摘除+面板标注原因       │
│   registry 落盘 per dataRoot：PID/epoch/端口/数据根身份    │
├─────────────────────────────────────────────────────┤
│ L3 执行可靠性（= 067 spec 全部收编）                     │
│   Job Object 收容所 / 清杀原生化(sysinfo) /              │
│   端口非瞬态改判 / hostPid+env 协议                      │
└─────────────────────────────────────────────────────┘
```

关键设计决策与理由：

1. **唯一性语义定案**：服务身份 = `(pluginId, dataRoot)`，registry 落盘在数据根内 → 同根唯一（对账保证）；跨根重复由「服务只与启动自己的宿主通信」消除（见 2）。不做全局单例（多实例各管各根是合理形态，重复之害在数据写串，不在进程并存）。
2. **env 注入断渗透**（高收益低改动）：spawn 时注入 `POLARIS_HOST/PORT/TOKEN`（kvclient 注释自证 env 优先）。效果：服务只与自己的宿主通信；孤儿指向死宿主端口，请求快速失败不再骚扰活宿主；跨根竞写根除。**MCP 注册失败的共因之一随之消解**。
3. **MCP 注册健康门控**：`resolve_external_plugin_mcp_servers` 增加服务状态输入（服务非 Running → 不进 AI 配置 + 面板/AI 诊断给出明确原因）；`status_events` 广播（已有）触发注册重算。spawn 失败不再静默——失败原因进会话诊断与工具列表标注。
4. **auto-restart 由 reconciler 收编**：现 watcher 内嵌的退避/重启逻辑与「Starting 挡」天然冲突（回归即证据）。重构后 watcher 只负责「观察进程退出 → 上报 reconciler」，拉起决策与退避策略全部上收到 reconciler 单点——「挡双拉」与「自动拉起」不再可能打架。
5. **BOOT_GRACE 降级为对账参数**：宽限期本质是「启动风暴期的对账退避」，保留语义但作为 reconciler 的节流参数存在，不再是散在 health_check/process_watcher 两处的特判。

## 四、实施路线（R0 停血 → R3 完善）

### R0 停血（bug 级，独立可先行，1 个提交粒度）
| # | 项 | 说明 |
|---|---|---|
| R0-1 | **修 auto-restart 回归** | 挡检查改为「仅挡外部 start」：watcher 重启走专用入口（或重启前将状态置 Stopped 再调 start）。回归用例：spawn→kill 进程→断言重拉 |
| R0-2 | **spawn 注入 POLARIS_HOST/PORT/TOKEN** | 一行级改动，断跨根渗透 + 孤儿失能 |

### R1 收容与清杀（= 067 spec P0-1/P0-2/P1-1/P1-2，已有 spec 不重复）
Job Object 收容所、sysinfo 清杀原生化、启动对账清扫（并入 reconciler 首轮）、固定端口非瞬态改判 + hold-listener。

### R2 对账架构（核心重构，本总案主体）
| # | 项 | 要点 |
|---|---|---|
| R2-1 | registry 落盘 | `dataRoot/services-registry.json`；写路径单点（reconciler），宿主启动先对账后行动 |
| R2-2 | reconciler 控制循环 | 吸收 stop_all/stop_services_for_plugin 的收敛语义；watcher 瘦身为纯观察者 |
| R2-3 | MCP 注册健康门控 | 见决策 3；`cap.mcp` 管理面透出「不可用原因」 |
| R2-4 | MCP spawn 失败显性化 | `simple_ai/mcp/mod.rs` 失败不再静默跳过：会话诊断面板 + 工具列表标注 |

### R3 可观测与兜底
面板服务健康总览（状态/PID/重启数/最后错误）、process-guard 看板插件（067 P2-1）、`{{hostPid}}` 协议（067 P2-2）。

**顺序依据**：R0 立即止血且零架构依赖；R1 独立生效（即使 R2 缓做，孤儿与清杀问题已根治）；R2 是范式切换，动 watcher/stop 语义，须在 R1 的 Job Object 兜底就位后进行（重构期任何收敛漏洞有 OS 级兜底）；R3 依赖 R2 的事件面。

## 五、明确不做

- 不收敛进程面（不学 VS Code 单 extension host）——每插件独立服务是既定产品形态，插件「独立后台」被用户明确认可。
- 不引入外部 supervisor（Windows 服务 / 计划任务 / 独立 daemon 进程）——宿主内嵌 reconciler 已满足，外部 supervisor 自身引入新的生命周期问题（它自己谁来管）。
- 不做插件服务协议大改（mcpServers stdio 通道不动）。
- dispatch 通道 kv list 楔死、feed-radar 日志膨胀 → 另案（065）。

## 六、验收总口径

1. kill -9 服务进程 → ≤15s 内 reconciler 自动拉起（受重启策略约束），面板状态与真实进程一致。
2. 禁用插件 → 服务进程终止 + MCP 工具从 AI 配置摘除，全程无手工干预。
3. 服务进程死 → 面板/AI 诊断可见「服务未运行」及原因，AI 工具列表同步标注，无静默缺失。
4. 三数据根实例同启 → 各根服务只与自己的宿主通信（抓包/日志验证无跨根请求）；无功能重复抓取。
5. 强杀宿主 → 0 残留（067 验收 1 继承）。
6. auto-restart 回归用例进 CI（watcher 重启路径断言真实 re-spawn）。
7. 门控：`cargo check --no-default-features --bin polaris-web --bin polaris-mcp` / `cargo clippy --lib` 无新增 warning。

## 附：067 与本总案的关系

067（孤儿进程）是本总案 L3 执行层 + R1 的具体化，spec 独立有效（plans/plugin-service-orphan-process-governance-spec.md）；本总案补上 L1/L2（期望状态 + 对账）与 MCP 门控，回答「管理不了」的完整问题。068 登记为本总案载体，067 在 R1 阶段并入实施。
