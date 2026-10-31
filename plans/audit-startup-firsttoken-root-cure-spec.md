# 审计子系统 + 启动路径 + ClaudeCode 首响 彻底根治 spec

> 2026-10-31 夜查定案。目标：**根除**（不是缓解）三类已实证的问题。
> 证据全部来自生产实例（anchor→`D:\app\polaris-s`）日志与数据文件实测。
> 关联记忆：`polaris-desktop-startup-slow-root-cause`、`polaris-host-dispatch-wedge-and-kv-list`、`polaris-audit-chain-interleaved-writes`。
>
> **§八、15 天多 agent 日志复核补强（2026-10-31 深夜，4 agent 并行分析 10-16~10-30）**：
> 1. **审计洪水恶化 230 倍**：接线计数 10-26 4.1万 → 10-27 43.4万 → 10-28 88.8万 → 10-29 593万 → 10-30 1042万；单日 +450 万条、~60 条/秒。尾部 2MB 实测 `cap.kv action=list` 占 59%、get 21%——插件共用 `kvclient.js` 的 `kvKeys()`（`action:list`）高频轮询是洪水源（list 正是记忆里会拖垮宿主的动作）。**已落**：审计降噪闸（`should_audit_dispatch_ok`：cap.kv get/list 的 dispatch.ok 不入链，写动作与 error/deny 保留）。
> 2. **detect_claude 修复曾生效又回归**：10-16~24 全天 0 次（修复生效），10-25 回归 66 次，10-29 爆发 **22.6 万次**（≈9 次/秒，21-23 时）。TTL 缓存（P0-2）已落。
> 3. **启动延迟随审计体积恶化**：中位 1-3s（10-16~28）→ 19-27s（10-29/30），最差 66s；审计接线扫描 max 63s。尾读（P0-1）已落。
> 4. **ClaudeCode init 台阶精确定位**：spawn→init n=495 中位 28.0s；**台阶在 3→5 个 MCP 之间（4.7s → 31.1s），5→56 个几乎不再增长**——固定成本不是每 server 线性叠加，是并行 init 的墙钟时间；10-29/30 的 mcp=55 中位 13.5s 是页面文件耗尽（os error 1455 ×71）令 MCP 批量夭折的「假快」。**白名单必须压到 ≤3 个才拿到 ~4-5s**。
> 5. **新 P0 族**：① 10-25 SQLite disk full 灾难（993 full + 195 WAL I/O + usage/voice 全写失败）＝D 盘满，已由 10-25 清理缓解，洪水根治后风险大降；② 10-29 Windows 资源耗尽（1450 审计写入失败 ×50 + 1455 页面文件太小 + WebView2 0x8007139F）＝52 个 node MCP 批量 spawn 打爆提交内存；③ `/api/read-directory` 缺 path 的 400 洪水 15 天 15,712 次（56→5191/天指数涨），宿主内无调用方，与 10-25 上线的 mobile client 高度同源（同日新增 notify-session-complete 404），待移动端修。
> 6. **已修不重复修**：`polaris-mcp.exe.exe` 双后缀在主仓源码已修（装机会随 11.0.5 带上）；SimpleAI 会话恢复惰性化（783 会话/启动，~8s）涉中断/继续热路径，风险大收益次级，留 P1。
> 7. **SimpleAI 侧**：MCP pool 就绪 2→40 server = 0.2s→12s；429 重试 15 天累计 ~20.7 分钟睡眠（deepseek-v4-flash 占 2700/3056）。
>
> **实施状态（2026-10-31）**：P0-1 尾读+归档 ✓、P0-2 TTL 缓存 ✓、P0-3 45s 启动宽限（健康检查+auto-restart 双路）✓、A.3 最小降噪闸 ✓、PluginDiscover 日志降级 ✓、C-P0 白名单机制 ✓（`mcp.sessionDefaults`，缺省 null=现行为；**要拿 4-5s 首字需用户在 config.json 配 2-3 个 server 名**）。全部 `cargo check` 通过。

---

## 〇、问题清单（全部有实证数字）

### P-A 审计子系统（三项病灶）

| # | 病灶 | 实证 |
|---|---|---|
| A1 | 启动全量扫描：`FileAuditSink::open`（`src-tauri/src/services/router/audit_sink.rs:132`）逐行 serde_json 解析**全量**审计文件只为取末条 `record_hash` 续链 | `dispatch.jsonl` 已 3.0GB / 695 万条；启动日志 00:19:13.5→00:19:29.8 **16 秒零日志空洞**；随历史线性恶化 |
| A2 | 多实例交错写 → 哈希链名存实亡：每实例内存各持 `last_hash`，3 实例并发追加同一文件 | 尾部 2000 条内**断链 91 次（4.5%）**；记忆 `polaris-audit-chain-interleaved-writes` 早已实证 broken at 147 |
| A3 | 无限增长无保留策略，噪声占 89%：每条 dispatch.ok 全量入链，插件高频 `cap.kv set` 是大头 | 13.9 万条/天（首条 2026-09-11，50 天 695 万条）；尾部 2000 条中 `cap.kv` 占 89%、`Remote` 源占 81% |

### P-B 启动路径

| # | 病灶 | 实证 |
|---|---|---|
| B1 | detect_claude 风暴：`health_status`/`health_status_async`（`config_store.rs:538/558`）**零缓存**，每次 spawn `claude.cmd --version`（cmd→node 链 250-500ms） | 一天 **113,203 次**（≈5 次/秒全天候，深夜也在跑）；单次启动窗口 90 次；与 A1 抢 CPU/磁盘 |
| B2 | 多实例 + 窗口晚出 → 连点雪崩：窗口要等 A1 扫完才创建；默认 multi-instance（用户明确**需要保留**） | 冷启动 18-44s 白屏；10-29 两次启动 43-44s；00:19 同一秒 3 实例并发：各扫一遍 3GB + 抢端口 9820→9821→9822 |
| B3 | 插件服务启动期误判重启循环：宿主被 A1/B1 拖死时插件健康检查超时→判 unhealthy→auto-restart | 一天 91 次 auto-restart，全部聚簇在启动时刻（00:19×32、15:04×22、16:03×16、17:41×10）；relay-devkit/abacus/pocket-drop 连挂 3 次标 Error，插件本身没坏 |

### P-C ClaudeCode 首响慢（用户最痛）

| # | 病灶 | 实证 |
|---|---|---|
| C1 | **每条消息**重新 init 全部插件 MCP：stream-json 单发模式每条消息 spawn 新 CLI 进程，CLI 再 spawn 全部插件 MCP stdio server（每个都是 node 冷启动） | 10-30 共 33 次「进程启动，PID」；`SessionLauncher 解析到 52 个可用 MCP server`；init 事件（`mcp_servers=54, tools=455`）**距发消息 23s**；最差一次 **89s**（10:37:55→10:39:24） |
| C2 | 对照组铁证：MCP 少时首响正常 | `mcp_servers=1, tools=23` 的会话 init 仅 **3-4 秒** |
| C3 | 工具全量注入放大 payload | `tools=455`（54 MCP 时）vs `tools=23`（1 MCP 时） |

---

## 一、目标与非目标

**目标**
1. 启动路径 O(1) 化：启动耗时与审计历史体积解耦；冷启动（窗口出现）回到 2-3 秒级。
2. 审计哈希链在多实例下**真正完整**（每链可 verify，断链率 0）。
3. 审计体积有界：保留策略 + 分级降噪，增速 13.9 万条/天 → 预期 <1 万条/天。
4. ClaudeCode 发消息到首 token：54 MCP 场景 23-89s → 目标 <5s（P2 完成后 <2s）。
5. **多实例完整保留**（明确需求：一个窗口开插件面板、一个开 AI 对话）。

**非目标**
- 不改 cap 契约语义（能力集合、权限模型不动）。
- 不做运行时 schema 校验补齐（已知缺口，另行立项）。
- 不动 dispatch 通道楔死 bug②（`polaris-host-dispatch-wedge-and-kv-list`）——独立修复，本 spec 的审计改动不依赖它。

---

## 二、设计 A：审计子系统重构（分段 JSONL + 实例分链 + 分级 + 保留）

### A.1 文件布局与分链

```
<DataRoot>/audit/
  dispatch/                    # 新布局（按天 × 按实例分段）
    2026-10-31.inst0.jsonl
    2026-10-31.inst1.jsonl
  archive/
    dispatch-20261031.jsonl    # 旧 3GB 单文件整体归档（只读保留）
```

- **每实例只追加自己的段** → 链内永不交错，A2 根治。段名含日期 → 天然滚动。
- `FileAuditSink` 持有 `(current_date, instance)` 的 append 句柄；写入时发现跨天 → 滚动到新段（新段从 GENESIS 重新续链，链按段完整）。
- `verify_chain(path)` 语义升级为 `verify_segment(path)`：验证单段内链完整（每段独立成链）。
- `audit_verify` / `cap.self.inspect`：默认验证**当前实例**最近 N 段（参数化），不再隐式扫全历史。

### A.2 启动 O(1)（A1 根治）

`open()` 改为：
1. 算出当天段路径；不存在 → 新建，从 GENESIS 开始。
2. 存在 → `seek(末尾 - 64KB)`，丢弃首个可能被截断的半行，取**最后一条完整行**解析出 `record_hash` 续链。
3. 旧 `dispatch.jsonl` 若存在且未被归档 → 启动时**异步**改名进 `archive/`（文件被占用则跳过，下次再试；不阻塞、不报错刷屏）。

### A.3 审计分级（A3 根治）

新增 `AuditTier`（Rust 枚举 + config.json `audit.tiers` 可覆盖）：

| Tier | 范围 | 落盘策略 |
|---|---|---|
| T0 安全敏感（全量入链） | `dispatch.deny*`、`cap.self.mutate*`、`cap.config` patch、`cap.fs` 写、`cap.bash`、`cap.git`、`cap.app.autolaunch.apply` | 逐条入链（现状） |
| T1 状态变更（入链） | `cap.kv` set/delete、`cap.pluginServiceManager` 状态迁移、`cap.ai.chat` 会话级（start/stop，不含流帧） | 逐条入链 |
| T2 高频噪声（**聚合计数**） | `cap.kv` set 的 `dispatch.ok`、`cap.pluginDiscovery` 周期扫描、`dispatch.ok` 中 detail 相同的连续成功 | 内存聚合：每分钟每 `(capability, source, action)` 一条 `{count, lastDetail}` 入链 |

- 聚合落点：`RouterBus` 的 `audit_append` 调用点按 tier 分流；T2 聚合器每 60s flush 一次入链。
- 预期效果：尾部 2000 条样本中 89% 的 cap.kv + 7% pluginDiscovery → 每分钟几条聚合 → **日增 <1 万条**。
- 兜底：`audit.tiers` 支持把任意 cap 拉到 T0（排查某插件时临时拉满）。

### A.4 保留策略

- config.json：`audit.retentionDays`（默认 30）、`audit.maxTotalBytes`（默认 1GB）。
- 执行：启动后 60s（避开启动窗口）+ 每 6h，后台任务删除超期/超限的**旧段**（当日段永不删）。
- `dispatch-mcp.jsonl` 同步迁入新布局（体量小，规则同上）。

### A.5 接口影响（三端同步点）

- `audit_tail` / `audit_verify`（tauri command + web ipc 双份）：签名不变，语义改为「当前实例段」；`audit_verify` 返回结构追加 `segments: [{file, ok|brokenAt}]`。
- 前端若有审计查看器：`audit_tail` 返回结构不变，无需改。
- 插件端：`cap.*` 契约不变，零感知。

---

## 三、设计 B：detect_claude TTL 缓存（B1 根治）

- `ConfigStore` 增加 `RwLock<Option<(Instant, Option<String>)>>` 探测缓存，**TTL 300s**。
- `health_status` / `health_status_async` / tauri `detect_claude` / web `health_check` 四个入口全部走缓存；新增 `detect_claude_force` 内部入口（仅设置页「重新检测」按钮用）。
- TTL 内 5 次/秒的 `/api/health` 轮询 → spawn 次数 0；按 TTL 计算日 spawn 上限 ~576 次（实际更低）。
- 附带：探测日志从 INFO 降为 debug（遵守 AGENTS.md 日志分级；仅失败时 warn）。

## 四、设计 C：ClaudeCode 首响三层根治（C1/C3，分阶段实施）

### C-P0 会话级 MCP 白名单（立竿见影，1 天内可完成）

- `SessionLauncher` 注入 MCP 时从「全量可用（52 个）」改为「**本会话实际启用集**」：
  - 数据源：config.json 新增 `mcp.sessionDefaults`（全局默认白名单）+ 会话级 override（前端会话设置里已有 aiToolAccess 过滤，升级为 MCP 粒度）。
  - 默认值：内置 6 个 + 用户高频插件（按 T1 审计的 `cap.ai.chat` 调用频次自动建议）。
  - 生成 mcp.json 时只写白名单内的 server → CLI init spawn 数从 54 → 通常 3-8 个。
  - **预期**：init 23-89s → 3-5s（对照实验：mcp_servers=1 时 init 3-4s）。
- UI：会话设置面板加「本会话 MCP 工具」多选（数据来自现有 `cap.mcp` 注册表，不新增后端接口）。

### C-P1 聚合 MCP 网关（消除 node 冷启动乘数）

- 宿主已有 `bus_mcp_server`（polaris-mcp bin 内嵌 RouterBus）。扩展：`polaris-mcp --aggregate` 模式——单 stdio server 代理全部插件 MCP 工具（`toolName` 前缀 `plugin_<id>__`）。
- ClaudeCode 会话 mcp.json 只挂 1 个聚合 server → CLI spawn 数恒为 1，与插件数量解耦。
- `tools` 数量不变（455），payload 靠 C-P2 裁剪；但 init 时间不再随插件数增长。
- 白名单仍生效：聚合网关按会话白名单过滤暴露的 tool 集。

### C-P2 工具集裁剪 + 长驻进程（彻底形态）

- **工具裁剪**：`aiToolAccess` 粒度下沉到会话（与 C-P0 同一面板），默认只暴露该助手声明的工具域；`tools=455` → 常态 <100。收益：CLI→模型的 system prompt 变小，TTFT 进一步下降。
- **长驻进程**（可选工程项，风险高，后置）：claude engine 改 stream-json 多消息长驻模式（`--input-format stream-json` 不关 stdin），MCP 只 init 一次。**前置条件**：先修复中断链路已知风险（`ai-chat-interrupt-continue-root-cause`、`simpleai-interrupt-race-fixed` 遗留项），否则晚到消息/中断语义会踩雷。本 spec 只立项不排期。

## 五、设计 D：启动窗口先行 + 插件健康检查宽限（B2/B3 根治）

### D.1 窗口先行

- `lib.rs` setup 顺序调整：**主窗口创建提前到所有重初始化之前**（audit 接线、插件 discover、MCP 注册全部已 O(1)/轻量，但保底顺序防御）。
- 前端已有 loading 态即可，无需新协议。

### D.2 插件服务健康检查启动宽限

- `plugin_service_manager`：进程启动后 **45s 宽限期**内，health 失败只记 warn、**不判 unhealthy、不 auto-restart**（宽限期从宿主 setup 完成起算，非进程 spawn 时刻）。
- 宽限后首次全量健康检查，此后维持现状（consecutive_failures=3 判定不变）。
- 验收锚点：启动后 5 分钟内 `auto-restarting plugin service` 日志 = 0（正常插件）。

### D.3 多实例端口/锁体验（保留功能，消除断裂感）

- 维持 multi-instance 默认（用户明确需求）。
- 已有机制保留：端口自动递增 9820→9821→9822、调度器锁单持有。
- 新增轻量提示：第 2+ 实例窗口标题追加 `（实例 N）`（`instance::id()` 已有数据，纯前端 title 拼接）——用户能分辨多开，不再误判「没点上」而连点。

---

## 六、实施顺序与验收

| 阶段 | 内容 | 验收（可断言） |
|---|---|---|
| **P0-1** | A.2 启动尾读 + 旧文件归档迁移 | 新冷启动日志中 `[AuditSink]` 行出现时间距进程首行日志 **<200ms**；`dispatch/` 段文件产生 |
| **P0-2** | B detect TTL 缓存 | `detect_claude] 尝试执行` 日志日量 113,203 → **<700** |
| **P0-3** | D.2 健康检查宽限 | 启动后 5 分钟 `auto-restarting` = 0 |
| **P1-1** | A.1 分段分实例 + A.3 分级 + A.4 保留 | ① 对同一段 `verify_segment` 断链数 = 0（多实例并发压测下）；② 日增审计条数 <1 万；③ 启动 7 天后 audit 目录 <1.2GB |
| **P1-2** | C-P0 会话级 MCP 白名单 | 54 MCP 场景发消息→init 事件 **<5s**；`tools` 数 = 白名单内工具之和 |
| **P2** | D.1 窗口先行 + D.3 实例标识 + C-P1 聚合网关 | 窗口出现距进程首行 <2s；C-P1 后 init 时间与插件数量无关 |
| **P3（立项不排期）** | C-P2 长驻进程 | 依赖中断链路修复遗留项 |

**本地验证门**（每阶段）：`cargo check`；动命令层跑 `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`；audit_router 相关前端改动跑 `pnpm exec tsc --noEmit`；新增/更新 Rust 单测（audit_sink 段滚动/尾读截断行/分级聚合）并实际执行。

## 七、风险与回退

| 风险 | 缓解 |
|---|---|
| 尾读遇「最后一行正被写入」（本实例不可能：自己持有锁；跨实例读归档才可能） | 丢弃无换行结尾的半行，取上一完整行；写入方 append 原子性（单 write <4KB 行）足够 |
| 段滚动瞬间 crash | append-only，最坏丢当前段最后一行，下段从 GENESIS 续——段内链仍完整 |
| T2 聚合丢粒度（排查时想看每条 kv set） | `audit.tiers` 运行时拉满该 cap；聚合器 flush 周期内数据在内存可见（`audit_tail` 返回含 pending 聚合） |
| 旧审计查看器假设单文件 | `audit_tail` 响应结构不变；归档文件保留可回溯 |
| C-P0 白名单改变现有用户工作流（以前全量可用） | 迁移策略：首启把**当前所有已启用 MCP** 写入 `mcp.sessionDefaults`（行为不回退），用户后续自行裁剪 |
| 长驻进程与中断语义冲突（历史踩坑） | P3 仅立项；前置依赖中断链路遗留项闭环 |
