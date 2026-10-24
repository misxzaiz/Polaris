# 插件 Cap 全自由度（plugin-cap-full-freedom v1）

> 目标（goal）：让插件具备**注册任意自定义逻辑 cap** + **覆盖任意既有 cap** 的能力，
> 在保留统一权限/审计/超时护栏的前提下，把自由度拉到与宿主内置 cap 等价。
> 状态：**方案（待评审）**
> 日期：2026-10-23

---

## 0. TL;DR

现状自由度只有 **L1（命名）**：插件经 `cap.registry register` 能加任意 `cap.*` id，但 handler 只有 `forward` 别名，且**禁止覆盖**任何已注册 cap。

本方案放开两件事，达成 **L1 + L2 + L3**：

| 自由度 | 含义 | 现状 | 本方案 |
|---|---|---|---|
| **L1 命名** | 注册任意 `cap.*` id | ✅ 已支持 | 保持 |
| **L2 语义** | 承载真正的业务逻辑（任意语言实现） | ❌ 仅 `forward` 别名 | ★ `plugin-rpc` handler |
| **L3 覆盖** | 替换/包装/兜底任意既有 cap | ❌ 硬禁止 | ★ `replace` + `ReplaceMode` + 分级权限 |

**核心设计**：`DynamicHandler` 从单变体扩为多变体（`forward` / `plugin-rpc` / `wasm` / `remote-http` / `ui-render` / `composite`），`register` 加 `replace` + `replaceMode` 语义，`SENSITIVE_TARGETS` 黑名单换成**分级授权表**。PluginRpc 是"最大自由度"的最低成本路径——复用已有插件进程生命周期（`cap.pluginServiceManager`）与 MCP 桥（`McpClientPool`），不需要 WASM 工具链。

**不变的护栏**（"最大自由"不等于"裸奔"）：统一 `dispatch` gate + `PolicyPermission` + `AuditSink` 全链路不动；覆盖事件强制落审计不可关闭；覆盖 cap 的 handler 崩溃可降级到原 handler；敏感 cap 覆盖需签名插件 + config 显式 allow + 用户会话级确认。

---

## 1. 现状盘点（承接 §0 结论）

三条既有通道，作用域各不相同：

| 通道 | 作用层 | 自由度 | 位置 |
|---|---|---|---|
| `cap.registry register` | RouterBus 注册表 | 只能 `forward` 别名，禁覆盖 | `router/registry_capability.rs:113-189` |
| `contributes.toolProviders` | AI 引擎工具层 | 替换某个工具域的 MCP server 进程 | `mcp_config_service.rs:931` |
| `contributes.executors` | ExecutorRegistry | 注册自定义执行器 | `models/plugin.rs:246` |

关键约束点：

- `DynamicHandler` 是单变体枚举（`dynamic_capability.rs:41`），`invoke` 只做一次 `router.dispatch` 转发。
- `check_id_available` 遇 `is_registered` 直接报错（`registry_capability.rs:56-64`）。
- `unregister` 拒绝对非动态能力卸载（`registry_capability.rs:203-206`）——封死了"先卸后装"绕过路径。
- `SENSITIVE_TARGETS = ["cap.ai.chat", "cap.registry", "cap.help", "cap.context"]`（`registry_capability.rs:41`）——目标侧黑名单。
- `register_handle` 是宿主内 `pub`，`resolve_handle` 是 `pub(crate)`（`router/mod.rs:14`）——入口不外露给插件。

**结论**：RouterBus 是封闭的可信执行域，可拓展性刻意收敛在"命名空间内加别名"和"引擎工具层替换"两个受控面。要"最大自由度"，必须扩展 handler 语义 + 放开覆盖。

---

## 2. 三条可选路径对比

| 路径 | 语言支持 | 安全边界 | 开发成本 | 与 Polaris 契合度 |
|---|---|---|---|---|
| **A. WASM 沙箱** | Rust / JS（需编译到 WASM） | 最强（wasmtime） | 高（工具链、生态、调试） | 中（契约已 WIT-compatible，但工具链未建） |
| **B. 插件进程即 handler（PluginRpc）** | 任意（Node/Python/Go…） | 中（进程隔离 + 超时 + 权限 gate） | 低（复用 MCP 桥、插件进程管理） | ★ 高（已有 `cap.pluginServiceManager` + `McpClientPool` + `bus_dispatch`） |
| **C. 内嵌脚本求值** | JS/Python | 弱（需 JIT 沙箱，边界弱） | 中 | 低（引入新解释器依赖） |
| **D. 混合（推荐）** | 任意 + WASM 可选 | 分级 | 分阶段递增 | ★ 高 |

**推荐路径 D**：首发 `plugin-rpc`（路径 B，覆盖 L2 + L3），WASM 作为可选增强预留扩展位（P4）。理由：

1. **最低侵入**：`DynamicHandler` 加变体 + `register` 加字段，不动 `RouterBus` 主流程、不动 `Capability` trait、不动 `dispatch` 权限 gate。
2. **最大开发者自由度**：插件用任意语言写 handler，不强制学 WASM。
3. **护栏不降级**：PluginRpc 仍过 `dispatch` 统一 gate（因为 handler 是宿主侧代码，插件进程只在被调用时参与），审计、超时、权限、降级全链路复用。
4. **WASM 留位**：`wasm` 变体先占位不实现，后续 P4 补 `wasmtime` 集成（`plans/new-app-bootstrap-wasm-load.md` 已有 wasmtime 5 集成经验可复用）。

---

## 3. 核心设计

### 3.1 Handler 类型扩展

```rust
// src-tauri/src/services/router/dynamic_capability.rs
// 从单变体扩为多变体，rename_all camelCase 保持

pub enum DynamicHandler {
    /// 现有：既有 cap 的转发别名（保持不变，向后兼容）
    Forward { target: String, defaults: Option<Value> },

    /// 新增：调用插件进程内的 handler（最大自由度的核心）
    PluginRpc {
        plugin_id: String,          // 目标插件 id（与 PluginId 对齐）
        endpoint: String,           // 插件进程内 handler 路由键
        timeout_ms: Option<u64>,    // 默认 30000
        fallback: Option<FallbackPolicy>,  // 覆盖场景下的降级策略
    },

    /// 预留：WASM 沙箱（P4 实现）
    Wasm { module_id: String, function: String },

    /// 新增：远程 HTTP 转发（可指向自托管服务，等价于"远程插件"）
    RemoteHttp {
        url: String,
        method: String,             // GET/POST/...
        headers: BTreeMap<String, String>,
        auth: Option<Value>,        // 复用 cap.http 的认证语义
        timeout_ms: Option<u64>,
    },

    /// 已在 plans/plugin-cap-inject-render-v1.md §2.2 规划
    UiRender { frame: Value, defaults: Option<Value> },

    /// 新增：组合多个步骤（可串行编排多个 handler）
    Composite { steps: Vec<CompositeStep> },
}
```

**PluginRpc 的宿主侧执行语义**（`DynamicCapability::invoke` 新增分支）：

1. 从 `state.plugins` 找 `plugin_id` 对应插件进程；未启动 → 尝试拉起（复用 `cap.pluginServiceManager.start`）。
2. 通过插件进程的 MCP 客户端池或专用 WS 通道，向插件进程发 `invoke_cap { capId, endpoint, payload, ctx }`。
3. **超时护栏**：`timeout_ms` 到期未响应 → 返回 `Err("provider timeout")`。
4. 反序列化插件返回的 `Value` → 作为 cap 结果。
5. 全链路落审计（`dispatch.ok` / `dispatch.error`，含 plugin_id + endpoint）。

**关键**：PluginRpc 的 `invoke` 仍在宿主进程内执行，`RouterBus.dispatch` 的权限 gate 与审计完全复用。插件进程只是"handler 的远程实现"，不是新的 dispatch 入口。

### 3.2 覆盖语义

```jsonc
{
  "action": "register",
  "id": "cap.bash",                     // 覆盖目标
  "replace": true,                      // ★ 新字段：允许覆盖
  "replaceMode": "wrap",                 // ★ 新字段：override | wrap | fallback
  "summary": "...",
  "handler": { "type": "plugin-rpc", "pluginId": "xxx", "endpoint": "bashImpl" }
}
```

**三种覆盖模式**：

| 模式 | 语义 | 典型用途 |
|---|---|---|
| `override` | 完全替换，原 handler 不再响应 | 彻底禁用内置实现 |
| `wrap` | 包装式：新 handler 先跑，把结果 + 原 handler 结果一起返回；或新 handler 决定是否调用原 handler | 增强/审计/装饰器 |
| `fallback` | 新 handler 失败/超时时回退原 handler | 灰度替换、渐进迁移 |

**实现要点**（`RouterBus.register_handle` 增强）：

- 新增 `RegisterOptions { replace: bool, mode: ReplaceMode }`。
- 覆盖时**不删除原 handle**，而是建立覆盖链：`handles[id] = [原 handle, 新 handle]`（内部改为 `Vec<Arc<dyn Capability>>`，取最后一个有效者）。
- 增加 `provider_of(id) -> Vec<(CapabilityHandle, ProviderSource)>` 查询覆盖链。
- 覆盖方卸载时，从覆盖链移除，原 handle 自动恢复响应（无感回滚）。
- 增加 `provider_status: HashMap<CapabilityId, ProviderStatus>`（`active` / `offline` / `degraded`）标记运行态。

**覆盖期间的行为**：

- `dispatch` 按覆盖链顺序取 handler，`fallback` 模式遇 Err 自动下探。
- 插件进程退出 → PluginRpc handler 标记 `offline`；后续 dispatch 该 cap 时，若配置了 `fallback` 则下探，否则返回明确错误 `{"provider": "offline", "cap": "..."}`。
- `cap_list` / `cap.help` 增加 `provider` 字段：`{ type: "plugin"|"builtin"|"dynamic", pluginId, since, mode }`。

### 3.3 覆盖权限分级（替代 SENSITIVE_TARGETS 黑名单）

原黑名单是"一刀切拒绝"，本方案换成**分级授权表**（`policy_permission.rs` 新增规则表）：

| 级别 | 可覆盖的 cap | 授权条件 |
|---|---|---|
| **L0 UNRESTRICTED** | `cap.prompt_snippet` / `cap.ui.*` / `cap.kv` / `cap.history` / `cap.context` | 任意插件可覆盖，无需审批 |
| **L1 USER_CONFIRM** | `cap.http` / `cap.fs` / `cap.data_root`（读类）/ `cap.todo` / `cap.git`（读类） | 插件安装/更新时用户确认一次 |
| **L2 SIGNED_PLUGIN** | `cap.bash` / `cap.data_root`（写类）/ `cap.ai.chat` / `cap.pluginDiscovery` / `cap.pluginServiceManager` / `cap.self.*` | 插件签名 + `config.capOverride.allow` 显式列表 + 会话级二次确认 |
| **L3 EXTREME** | `cap.registry` / `cap.help` / `cap.self.inspect` | 仅签名插件 + config allow + 用户会话级确认；覆盖 `cap.registry` 需额外保护（覆盖后新注册经新 handler 走） |
| **L4 FORBIDDEN** | 内部句柄 / 非 `cap.*` 前缀 / `cap.registry` 自递归保护目标 | 永不覆盖，`config` 也不可放开 |

**分级判定**：`RegistryCapability.do_register` 在 `check_id_available` 前先跑 `check_replace_permission(id, source, config)`：

1. 查分级表 → 得到 level。
2. L0 → 直接放行。
3. L1 → 检查 `state.plugin_overrides.<pluginId>.<capId>` 是否有用户确认记录。
4. L2/L3 → 检查 `config.capOverride.allow` 白名单 + 插件签名（可选，v1 先只做白名单）+ 会话级 `Prompt` 确认（`PolicyPermission` 已有 `Prompt` 裁决，见 `policy_permission.rs:95`）。
5. L4 → 一律拒绝。

**覆盖原 handler 时的权限边界不变**：覆盖方调用外部 cap 时，仍过 `RouterBus.dispatch` 的 `PolicyPermission` gate。也就是说，插件覆盖 `cap.bash` 后，其 handler 内部再调 `cap.fs` 仍需 fs 权限——**"最大自由"是覆盖入口自由，不是能力调用自由**。

### 3.4 生命周期与降级

- **插件安装**：解析 manifest → 校验覆盖权限（L1+ 弹窗）→ 注册 handler → 覆盖链生效 → 审计落 `cap.override.register`。
- **插件更新**：新版本覆盖注册，旧 handler 保留在覆盖链底层（`wrap` 模式可回退）；更新失败自动回滚覆盖链。
- **插件禁用**：`unregister` 该插件所有 handler → 覆盖链自动回退原 handler → 审计落 `cap.override.unregister`。
- **插件卸载**：等同禁用 + 清理持久化。
- **插件崩溃**：PluginRpc handler 状态标记 `offline` → 覆盖链中跳过 → 若 `fallback: true` 下探原 handler → 否则返回明确错误。
- **宿主重启**：`load_persisted` 重建覆盖链（顺序敏感：按注册时间戳升序重建，覆盖链顺序与运行期一致）。

**降级策略**（`DynamicCapabilityConfig.fallback`）：

```rust
pub enum FallbackPolicy {
    KeepOriginal,      // 失败回退原 handler（默认，覆盖场景）
    ReturnError,       // 不回退，直接报错（禁用内置场景）
    Skip,              // 失败时静默跳过（wrap 装饰器场景）
}
```

### 3.5 安全护栏（"最大自由"的边界）

即使放开覆盖，以下护栏**不可关闭**：

1. **统一 `dispatch` gate**：所有 cap 调用（含覆盖方 handler 内部调用）仍过 `PolicyPermission`。
2. **审计不可关闭**：覆盖注册/卸载/降级全程落 `AuditSink`，记录 `{ who, cap, mode, originalHandler, pluginSignature, timestamp }`。
3. **超时护栏**：`PluginRpc` / `Wasm` / `RemoteHttp` handler 强制超时（默认 30s，可配置上限 5min）。
4. **崩溃降级**：覆盖链有原 handler 兜底，避免"覆盖一个 cap 就挂掉整个宿主"。
5. **签名校验（L2+）**：v1 先做 config 白名单，v2 引入插件签名（ECDSA），签名不匹配拒绝覆盖。
6. **命名空间隔离**：插件注册新 cap 默认前缀 `cap.<pluginId>.<id>`，覆盖时显式声明目标 id，避免"误覆盖"。
7. **自递归保护**：覆盖 `cap.registry` 后，新注册请求经新 handler 走，若新 handler 是 `plugin-rpc` 类型，其反向调用 `cap.registry` 需显式 `allow` 标志（防环）。
8. **会话级确认**：L2/L3 覆盖需用户在 UI 二次确认（复用 `PolicyPermission::Prompt` 裁决 + `ask_user_question` 通道）。

---

## 4. 接口/契约变更清单

### 4.1 契约层（`src-tauri/src/contracts/` + `router/dynamic_capability.rs`）

| 变更 | 位置 | 兼容性 |
|---|---|---|
| `DynamicHandler` 扩为多变体 | `router/dynamic_capability.rs` | 向后兼容（新增变体，`Forward` 不变） |
| `DynamicCapabilityConfig` +`replace: Option<bool>` / `replaceMode: Option<ReplaceMode>` / `fallback: Option<FallbackPolicy>` | 同上 | 向后兼容（新增字段，缺省 `None` = 旧语义） |
| 新增 `ReplaceMode` 枚举（`override` / `wrap` / `fallback`） | `contracts/mod.rs` | 新增 |
| 新增 `FallbackPolicy` 枚举 | `contracts/mod.rs` | 新增 |
| 新增 `ProviderSource` 枚举（`Builtin` / `Plugin{pluginId, version}` / `Dynamic` / `Remote`） | `contracts/mod.rs` | 新增（与 `capabilities/registry.rs` 现有同名类型合并） |

### 4.2 RouterBus（`router/mod.rs`）

| 变更 | 说明 |
|---|---|
| `register_handle` 增 `RegisterOptions` 参数（或新增 `register_handle_opts` 方法） | 支持 `replace` + `mode` |
| `handles` 值类型从 `Arc<dyn Capability>` 改为 `Vec<Arc<dyn Capability>>`（覆盖链） | **破坏性内部变更**，需更新所有调用点 |
| 新增 `provider_of(id) -> Vec<(Handle, ProviderSource)>` | 查询覆盖链 |
| 新增 `provider_status: RwLock<HashMap<CapabilityId, ProviderStatus>>` | 运行态标记 |
| `dispatch` 按覆盖链顺序取 handler，`fallback` 模式遇 Err 下探 | 主流程改动 |
| `is_dynamic` / `is_registered` 兼容覆盖链语义 | 小改 |

### 4.3 RegistryCapability（`router/registry_capability.rs`）

| 变更 | 说明 |
|---|---|
| `do_register` 支持 `replace` + `replaceMode` + 分级权限检查 | 核心改动 |
| `check_id_available` 改为 `check_register_permission`（含覆盖场景） | 替换原逻辑 |
| `SENSITIVE_TARGETS` 常量替换为分级表 `OVERRIDE_LEVELS` | 删除旧黑名单 |
| `do_unregister` 允许卸载覆盖方（覆盖链自动回退），保留"拒绝对内置原生 handle 卸载" | 区分"覆盖方卸载" vs "内置卸载" |
| `describe` 增加 `provider` / `overridden` 字段 | 可观测性 |

### 4.4 插件侧（`models/plugin.rs` + `mcp_config_service.rs` + `plugin_service.rs`）

| 变更 | 说明 |
|---|---|
| manifest 新增 `contributes.capabilities: Vec<PluginCapabilityContribution>` | 声明插件提供的 cap（含覆盖目标） |
| `PluginCapabilityContribution { id, summary, handler, replaces?, replaceMode?, fallback? }` | 新类型 |
| 插件安装/更新流程增加覆盖权限校验 + L1/L2/L3 审批 UI | 复用 `ask_user_question` |
| 插件进程需要暴露"cap invoke"端点（MCP 工具或专用 WS） | 复用 `McpClientPool` |
| `bus_dispatch` 增加"从插件进程反向调 cap"的通道（若尚未支持） | 现状应已支持 |

### 4.5 前端（`src/`）

| 变更 | 位置 |
|---|---|
| 插件安装/更新审批 UI（覆盖 L1+ 时弹窗） | `PluginTab.tsx` |
| `cap_list` 面板显示覆盖来源 + 降级状态 | `CapListPanel`（如有） |
| `config.capOverride.allow` 配置面板（L2/L3 白名单） | 设置页 |
| `respond_plugin_card` 支持覆盖审批场景 | 复用既有通道 |

### 4.6 PolicyPermission（`router/policy_permission.rs`）

| 变更 | 说明 |
|---|---|
| 新增覆盖分级规则表 `OVERRIDE_LEVELS` | 从 `registry_capability.rs` 迁入（单一权威） |
| 新增 `check_override(req: &OverrideRequest) -> Verdict` 方法 | 与现有 `check` 并列 |
| 复用现有通配符匹配（`cap.config*`）+ source 匹配 | 无新语义 |

---

## 5. 分阶段落地路线

**总原则**：每阶段独立可验证、向后兼容、可回滚。

### P0 — 契约与 RouterBus 覆盖链（2-3 天）

- `DynamicHandler` 扩变体（先实现 `Forward` + `PluginRpc` 骨架 + `Wasm` 占位）。
- `RouterBus.handles` 改覆盖链 + `register_handle_opts` + `dispatch` 下探逻辑。
- `ReplaceMode` / `FallbackPolicy` / `ProviderSource` 契约类型。
- 单测覆盖：覆盖链顺序、fallback 下探、插件崩溃降级、覆盖链查询。
- 验证：`cargo check` + 新增单测全绿。

**不接插件侧**：P0 只让宿主内部能注册覆盖 handler（测试用），插件侧不动。

### P1 — PluginRpc handler 落地（3-5 天）

- `DynamicCapability::invoke` 实现 PluginRpc 分支（拉起插件进程 → 调用 handler → 超时护栏）。
- 复用 `cap.pluginServiceManager` 拉进程、复用 `McpClientPool` 或专用 WS 发 invoke。
- `DynamicCapabilityConfig` 持久化新增字段。
- 端到端测试：动态注册一个 PluginRpc cap → dispatch → 插件进程响应 → 结果回宿主。
- 验证：`cargo check` + E2E 手测。

### P2 — 分级权限与覆盖注册（2-3 天）

- `RegistryCapability.do_register` 支持 `replace` + 分级权限检查。
- `OVERRIDE_LEVELS` 表迁入 `policy_permission.rs`。
- 覆盖方 `unregister` 支持覆盖链回退。
- `describe` / `cap_list` 增加 `provider` / `overridden` 字段。
- 审计增强：覆盖事件落 `cap.override.register` / `cap.override.unregister` / `cap.override.degrade`。
- 单测：分级权限各档、覆盖链回退、崩溃降级、自递归保护。

### P3 — 插件 manifest + UI 审批（3-5 天）

- `PluginCapabilityContribution` 类型 + manifest 解析。
- 插件安装/更新流程接入覆盖权限校验 + L1/L2/L3 审批 UI（`ask_user_question`）。
- `config.capOverride.allow` 配置面板。
- 前端 `cap_list` 显示覆盖来源。
- 验证：`pnpm exec tsc --noEmit` + `pnpm lint` + 前端单测。

### P4 — WASM 沙箱（可选，后置）

- `wasm` handler 变体实现（wasmtime 5 集成，复用 `plans/new-app-bootstrap-wasm-load.md` 经验）。
- WIT 契约层（`contracts/mod.rs` 已有 WIT-compatible 设计）。
- 与 PluginRpc 并存，作为"强沙箱"选项供高安全场景选择。

### P5 — 签名校验（可选，后置）

- L2+ 覆盖引入插件签名（ECDSA），签名不匹配拒绝。
- 签名验证集成到 `cap.pluginDiscovery` 安装流程。

---

## 6. 验收标准

1. **L2 语义自由**：插件用 Node.js 写一个 handler，注册 `cap.user.custom`（handler.type=`plugin-rpc`）→ `cap_dispatch("cap.user.custom", {...})` → 插件进程返回结果 → 宿主收到。
2. **L3 覆盖自由**：插件覆盖 `cap.bash`（L2，需签名 + config allow + 用户确认）→ 原 `cap.bash` 被遮蔽 → 插件 handler 处理所有 `cap.bash` 调用 → 插件卸载后原 `cap.bash` 恢复。
3. **三种覆盖模式**：`override`（完全替换）/ `wrap`（增强）/ `fallback`（失败回退）均验证通过。
4. **崩溃降级**：覆盖 `cap.bash` 的插件进程崩溃 → 后续 `cap.bash` 调用返回 `{"provider":"offline"}` 或按 `fallback` 策略下探。
5. **权限分级**：L0 直接放行 / L1 需用户确认 / L2 需签名+config+会话确认 / L3 需签名+config+会话确认 / L4 拒绝。
6. **审计不可关闭**：覆盖注册/卸载/降级全程落审计，含 who + cap + mode + originalHandler + timestamp。
7. **自递归保护**：覆盖 `cap.registry` 后，新注册请求经新 handler 走，不产生无限递归。
8. **向后兼容**：现有 `cap.registry register`（无 `replace`）行为不变，`forward` handler 不变，旧插件不需改动。
9. **验证命令全绿**：`cargo check`、`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`、`pnpm exec tsc --noEmit`、`pnpm lint`、相关 vitest。

---

## 7. 边界与不做（v1）

- **不做任意 HTML/JS 注入宿主**：WASM 沙箱是 P4 可选项，v1 首发 PluginRpc（进程隔离已足够）。
- **不做"覆盖方绕过 dispatch gate"**：覆盖 cap 的 handler 内部调用外部 cap 仍过 `PolicyPermission`。"最大自由"是覆盖入口自由，不是能力调用自由。
- **不改 `Capability` trait**：仍同步 `invoke(params, ctx) -> Result<Value, String>`。流式能力走 `StreamingCapability` 平行表，本方案不涉及。
- **不做跨宿主插件（远程 cap 注册）**：`RemoteHttp` handler 可指向远程服务，但注册入口仍在本地宿主。
- **不放开 L4 FORBIDDEN**：内部句柄、非 `cap.*` 前缀永不覆盖，`config` 也不可放开。
- **不重构 `respond_plugin_card`**：覆盖审批走 `ask_user_question` 通道，不新建回填入口。
- **不动 `contributes.toolProviders`**：那是引擎工具层替换，与本方案正交，保持现状。

---

## 8. 风险与权衡

| 风险 | 对策 |
|---|---|
| `handles` 改 `Vec` 破坏所有 `dispatch` 调用点 | P0 集中改动 + 全量单测覆盖 + `cargo check` 把关；提供 `find_active_handle` 单一查询入口，避免散点改动 |
| PluginRpc 超时导致宿主阻塞 | 强制 `timeout_ms`（默认 30s，上限 5min）+ tokio `timeout` + 超时后标记 `offline` |
| 覆盖链顺序错乱（重启后重建） | 持久化含 `registered_at_ms` 时间戳，重建按时间升序；单测覆盖 |
| L2/L3 覆盖被恶意插件滥用 | 签名校验（P5）+ config 白名单 + 会话级确认 + 审计不可关闭 |
| 自递归（覆盖 `cap.registry` 后新注册经新 handler 走） | 显式 `allow` 标志 + 递归深度护栏（最多 1 层） |
| 插件崩溃导致被覆盖 cap 不可用 | `fallback: KeepOriginal` 默认策略 + `provider_status` 标记 + 覆盖链自动下探 |
| 前端审批 UI 复杂化 | 复用 `ask_user_question` 通道 + `plugin_card` 渲染，不新建 UI 栈 |
| 与 `plans/plugin-cap-inject-render-v1.md` 的 `ui-render` handler 冲突 | 正交：本方案加 `PluginRpc` 等，`ui-render` 独立变体共存；P1 可先不实现 `ui-render`，由另一 spec 落地 |
| 审计日志膨胀 | 覆盖事件审计独立 tag（`cap.override.*`），便于过滤；普通 dispatch 审计不变 |

---

## 9. 与既有 spec 的关系

- **复用** `plans/dynamic-capability-registry.md`（cap.registry 基础机制），本方案在其上扩 handler + 覆盖。
- **正交** `plans/plugin-cap-inject-render-v1.md`（可交互渲染）：该 spec 加 `ui-render` handler 变体，本方案加 `PluginRpc` / `Wasm` / `RemoteHttp` / `Composite` 变体，两者在同一 `DynamicHandler` 枚举上并列。
- **对齐** `plans/capability-seam-upgrade-plan.md`（Capability Seam 三阶段）：本方案是 P1 toolProviders 的自然延伸，把"工具层替换"提升到"cap 层替换"。
- **对齐** `plans/ai-self-management-capability.md`（AI 自我管理能力）：`cap.self.inspect` 透视覆盖链，`cap.self.mutate` 插槽改造与本方案覆盖链语义一致。
- **复用** `plans/new-app-bootstrap-wasm-load.md`（WASM 加载经验）供 P4。
- **不动** `plans/git-plugin-extraction-plan.md`（git 插件化）：那是 cap 化路径，与本方案正交。

---

## 10. 与 AGENTS.md 的对齐

- **唯一权威**：`RouterBus` 仍是 cap 唯一分发入口，覆盖链在其内部，不引入旁路。
- **权限/审计统一**：所有覆盖方调用仍过 `PolicyPermission` + `AuditSink`，护栏不降级。
- **协议双向同步**：`DynamicHandler` 枚举新增变体 → Rust 类型 + 前端 `src/types/` 同步（camelCase）。
- **验证清单**：P0-P3 每阶段需跑 `cargo check` + `pnpm exec tsc --noEmit` + `pnpm lint`；P0 新增单测覆盖覆盖链语义。
- **不冒进**：分阶段落地，每阶段独立可验证、可回滚；L4 FORBIDDEN 永不放开。
