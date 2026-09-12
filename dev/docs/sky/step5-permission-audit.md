# Polaris 重构 · 第五步：权限与审计生产化

> 状态：✅ 已实施（阶段 A/B/C/D 全部落地，2026-09-12）
> 日期：2026-09-12（规划定稿）/ 2026-09-12（四阶段实施 + Web 实测）
> 原则：**机制先行、默认等价、分批收紧**。每个阶段单独可验收，默认策略与现状等价（零回归），
> 收紧动作逐批显式启用。

---

## ⏩ 实施进展（2026-09-12）

### ✅ 阶段 A：Source 注入收紧
- `commands/router.rs` — 移除 `source` 自报字段与 `map_source`/`default_source`；
  `router_dispatch` 注入 `window: tauri::WebviewWindow`，来源由后端按 caller webview
  判定（纯函数 `resolve_ipc_source`：`main` → Bootstrap，其余 → Remote）。
- 单测：main/browser-42/空串/大小写伪造 四条 + 前端自报 source 被 serde 忽略。
- `ContractExplorerPanel.tsx` — 测试台移除来源下拉，改为展示"来源：后端判定"。

### ✅ 阶段 B：FileAuditSink
- `services/router/audit_sink.rs` — JSONL 落 `<DataRoot>/audit/dispatch.jsonl`，
  O_APPEND 独立句柄；`record_hash = sha256(prev_hash ‖ canonical_json)`，首条 GENESIS；
  重开续链；source 脱敏只落变体名。`verify_chain` 逐条重算 + 链式衔接校验，篡改定位行号。
- `state.rs` 接线（打开失败 warn 不阻塞启动）；`audit_tail` / `audit_verify` 命令
  （Tauri + Web 桥 /api/audit-tail|audit-verify 双通道）；面板新增"审计链"块
  （尾部 12 条 + 校验徽标）。

### ✅ 阶段 C：PolicyPermission
- `services/router/policy_permission.rs` — `(source_class, capability)` 矩阵；
  精确 > 通配（`cap.config*`）特异性，同特异性后者覆盖；无匹配 → Allow（默认等价）；
  非法规则装配时跳过 + warn；`prompt` 原样透传（dispatch 安全失败）。
- `models/config.rs` — 新增 `permissions.rules` 段（缺省 = 全放行）；`state.rs` 装配时
  载入（运行中改动需重启生效，热加载后置）。

### ✅ 阶段 D：capability 落 domain_audit
- `todo_capability.rs` / `kv_capability.rs` — 写路径改走 `ctx.storage().begin()` +
  `Transaction::store/delete` + `append_audit` 同事务（读路径不落）；
  SqliteStorage 新增 `audit_count` 诊断访问器；capability 测试断言审计行数。

### 验证状态（2026-09-12 实测）

| 项 | 结果 |
|---|---|
| `cargo check --lib` / `--tests` / `--no-default-features --bin polaris-web` | ✅ 全绿，新文件零告警 |
| 独立 crate `sky-verify`（`scripts/tmp/scaffold-verify.mjs` 生成，绕 Tauri DLL 0xc0000139） | ✅ **80 passed / 0 failed**（含 audit_sink 4 + policy 6 + prompt_snippet 10 + 同事务审计测试） |
| HTTP API 实测（polaris-web :9829，token 鉴权） | ✅ 无 token 401；cap.kv/cap.todo/cap.prompt_snippet 全链路 ok；自报 `source:"bootstrap"` 被忽略，审计全部落 `Remote` |
| `audit_verify` 实测 | ✅ 25 条记录链完整（ok:true）；篡改定位由单测覆盖 |
| 前端 vitest（plugin-system + pluginStore + pluginDiscovery） | ✅ 66 passed |
| Web UI 实测（9827 vite） | ✅ Contracts 面板：来源后端判定 / cap.kv demo 徽标 / 审计链 ✅ / dispatch 测试台真实 ok |

### 附带修复（第五步验证中发现的既有 bug）
- `todo_capability.rs` `apply_updates` 从未应用 `status` 字段 + `update_timestamps`
  从不置位 `completed_at`（注释声称的语义未实现）——导致
  `update_completed_at_semantics` 测试在 HEAD 上就是失败的（第三步文档声称的
  "55 passed" 未覆盖此测试）。已修复：update 状态流转生效，completed_at 按注释语义置位/清空。

---

## 0. 承接前三步

- 第一步已冻结契约：`Permission` / `AuditSink` / `AuditEntry`（含 `prev_hash`）/
  `Source`（无 Local 变体，Shell 永不 Bootstrap）全部在 `src-tauri/src/contracts/mod.rs`。
- 第三步 RouterBus 落地：dispatch 是唯一调用入口，全链路统一过权限 gate（`router/mod.rs:125-170`）。
- 第四步 cap.todo 闭环后，**至少一个真实业务域已经只走 dispatch** —— gate 和审计
  从"占位"变"生产"的时机到了。

---

## 1. 关键判断（2026-09-12 代码级核实）

### 1.1 sky 也没做，本步是自研补全

借鉴分析（`plans/sky-refactor-borrow-analysis.md`）结论：sky 的 `Permission` 恒 Allow
（bin/sky.rs 仍 AllowAllPermission）、`Transaction::commit/rollback` 空操作。
**权限/审计生产化没有现成答案可抄**，但 Polaris 的契约面比 sky 完整
（AuditSink/LocalSecretProvider 已冻结），dispatch 单入口已成立，缺的只是三块实现。

### 1.2 事实清单（本步要修的洞）

| # | 事实 | 证据 | 定性 |
|---|---|---|---|
| 1 | `StaticPermission::check` 无条件 Allow，是当前生产接线 | `event_adapter.rs:100-106`、`state.rs:361` | gate 无策略 |
| 2 | RouterBus 审计接线传 `None`，dispatch.ok/deny **哪都不落** | `state.rs:363`、`router/mod.rs:215-223,253-263` | 审计缺失 |
| 3 | 已写入路径 `prev_hash` 恒空串，tamper-evident 链从未计算 | `router/mod.rs:221,260` | 链未实现 |
| 4 | SqliteStorage `append_audit`（同事务写 domain_audit 表）第二步已建成，capability 零调用 | `storage/sqlite.rs:373-379` | 产能闲置 |
| 5 | **Tauri IPC 侧 source 由前端自报**：读 payload 字符串映射，不传默认 Bootstrap，传任意值得 `Remote{token:""}` | `commands/router.rs:25-27,50-57` | **违反契约铁律**（Source 由传输层注入，调用方不可自填） |
| 6 | Web/HTTP 侧强制 `Source::Remote`，正确 | `web/api/ipc.rs:2635-2645` | 已达标，保持 |
| 7 | 命令层成体系的权限检查仅 plugin_config 一处（manifest permissions 校验） | `commands/plugin_config.rs:89-116` | 后续随域迁移并入 gate |
| 8 | 静态 token 未配置时 API 完全开放；CORS `allow_origin(Any)`（生产也放开，支持 ngrok/Tailscale） | `web/middleware.rs:86-109`、`web/router.rs:107-118` | 独立安全议题，本步不处理（§5） |

### 1.3 桌面来源语义的裁决（本步的立场）

契约铁律：Shell 永不获得 Bootstrap、无 Local 变体。Polaris 桌面 webview 与 Core
同进程同信任域，第三步 P3 已裁决"桌面 tauri 命令保留 Bootstrap 给本地可信"。

本步沿此裁决并**收紧判定方式**：来源不由前端声明，由**后端按调用通道判定**——

- Tauri IPC 且 caller webview label == `main` → `Bootstrap`（本地信任域）
- 其他任何 webview（内置浏览器 tab 等）/ HTTP / WS → `Remote`（强制）

这与 transport 层正在进行的原则（内置浏览器动态 webview 不暴露 Tauri IPC、走 HTTP，
`src/services/transport/detector.ts`）是同一条：**只有主窗口走本地信任通道**。
此为对 sky 契约的 Polaris 显式偏差（桌面 webview 即 Core 管理面），记录在案。

---

## 2. 交付清单

### A. Source 注入收紧（阶段 A，最小改动，先做）

**文件**：`src-tauri/src/commands/router.rs`

- 废弃读前端自报 source：`router_dispatch` 不再解析 payload/source 字符串，
  `default_source` / `map_source` 移除。
- 命令签名增加 caller webview 判定（Tauri v2 可取 `window.label()`）：
  label == `main` → `Bootstrap`；其余 → `Remote`。
- Web 桥（`web/api/ipc.rs`）保持强制 Remote，零改动。
- 契约测试面板：来源改为**展示后端判定结果**，移除前端 source 输入框
  （`ContractExplorerPanel.tsx`）。
- label→Source 判定抽成纯函数，单测覆盖 main / browser-<tabId> / 未知 label。

### B. FileAuditSink（阶段 B，零行为变化，紧随 A）

**文件**：`src-tauri/src/services/router/audit_sink.rs`（新增）

- JSONL 落 `<DataRoot>/audit/dispatch.jsonl`，`O_APPEND|O_WRONLY` 独立文件句柄
  （契约注释：Bootstrap 直管，不经 Storage trait，换 storage 不影响审计）。
- tamper-evident 链：每条 `prev_hash = sha256(prev_hash + canonical_json(entry 除 prev_hash 外字段))`；
  首条 prev_hash 用固定 `GENESIS` 常量。**不改冻结的 AuditEntry**，deny 原因编码进 `action`
  （如 `dispatch.deny:permission`）。
- 接线：`state.rs` 替换 `None`。
- 校验：纯函数 `verify_chain(lines) -> Result<(), usize>`（返回破损行号）；
  单测覆盖 追加→校验通过→篡改一条→定位失败。
- 可选面板块：契约测试面板增加"审计链"视图（`audit_tail` / `audit_verify` 两个命令，
  展示尾部 N 条 + 校验结果）——可推迟到阶段 C 之后。

### C. PolicyPermission（阶段 C，机制先行，默认等价）

**文件**：`src-tauri/src/services/router/policy_permission.rs`（新增），`state.rs` 接线

- 策略模型：`(source_class, capability)` → Allow/Deny 静态矩阵；
  `source_class ∈ {bootstrap, remote, plugin}`；规则 = 内置默认表 +
  `config.json` 的 `permissions` 段覆盖（经 `RouterBus` 注入，装配时校验）。
- **默认策略与现状等价**（Bootstrap allow / Remote allow / plugin 预留），本阶段零回归；
  机制跑通后分批启用收紧规则。首批预埋（对应域迁上总线后启用）：
  - 管理面写：cap.config 写、数据根迁移、插件安装/卸载 → `remote: deny`
  - 读默认放行（远程访问场景 ngrok/Tailscale 不被误伤）
- Prompt 维持安全失败 Deny（契约注释已预留 PromptChannel，Phase 0 不做审批 UI）。
- 单测：矩阵匹配 / 覆盖优先级（capability 精确 > 前缀通配 > 默认）/ 默认等价性
  （同一组 dispatch 输入在 StaticPermission 与 PolicyPermission 默认表下结果一致）。

### D. capability 落 domain_audit（阶段 D，激活闲置产能）

- cap.todo / cap.kv 的**写路径**改走 `ctx.storage().begin()` +
  `Transaction::store` + `Transaction::append_audit` 同事务提交（读路径不落）。
  这是第二步"审计与业务写同库同事务"红线的首次真实使用。
- 注意保留既有语义：事务失败回滚含审计，单测验证。

---

## 3. 边界（做/不做）

- ❌ 不做动态 Prompt 审批 UI / PromptChannel（契约预留，后置）
- ❌ 不改冻结契约（AuditEntry / Permission / Source 原样；不加 Local 变体）
- ❌ 不动 web token 鉴权与 CORS 策略（独立安全议题，见 §5）
- ❌ 不动旧命令层散落检查（plugin_config.rs 保持，随域迁移逐步并入 gate）
- ❌ 不在本步迁移任何新业务域（cap.config 的迁移排在阶段 C 之后，见第四步 backlog）

## 4. 验收标准

1. `cargo check --lib` / `--tests` / `--no-default-features --bin polaris-web` 全绿；
   独立 crate 单测实跑通过（沿用 /tmp 验证 crate 模式）。
2. 阶段 A：前端自报 source 完全无效——Web 测试台即使传 `bootstrap` 也被判 Remote；
   桌面主窗口判 Bootstrap；内置浏览器 webview 判 Remote。
3. 阶段 B：每次 dispatch（ok/deny）都落 JSONL；`verify_chain` 通过；手工篡改一条后
   校验失败并定位行号。
4. 阶段 C：PolicyPermission 默认表与 StaticPermission 行为等价（零回归）；
   config 覆盖生效；矩阵单测全绿。
5. 阶段 D：cap.todo create 后 domain_audit 表同事务出现审计行；回滚场景审计同步消失。

## 5. 影响面与风险

| 维度 | 影响 | 说明 |
|---|---|---|
| 现有代码 | 🟡 中 | `commands/router.rs` 签名变化 + `state.rs` 接线 + 两个新模块 |
| 前端 | 🟢 低 | 测试台移除 source 输入、改展示判定结果 |
| 数据 | 🟢 低 | 新增 `<DataRoot>/audit/` 目录，不碰业务库 |
| 行为回归 | 🟢 低 | A/B 零行为变化；C 默认等价；收紧逐批显式启用 |
| 安全 | 🟢 正向 | 关闭"前端自报来源"洞；dispatch 可追责 |

**遗留风险记录**（本步不处理，防丢失）：静态 token 未配置则 HTTP API 完全开放 +
CORS Any。若远程暴露场景成为主路径，应单独立项（token 强制 + origin 白名单 +
与 Source::Remote{token} 的真实鉴权打通——当前 Remote 的 token 字段是空占位）。

## 6. 实施顺序

- **阶段 A**（半天级）→ **阶段 B**（零行为，紧随）可一次完成；
- **阶段 C** 机制可随后做，**收紧规则的启用时机**需逐批裁决（依赖第四步对应域迁移）；
- **阶段 D** 独立，随时可插。
- 与第四步并行不冲突；唯一硬前置：**cap.config 迁移必须在阶段 C 落地之后**。
