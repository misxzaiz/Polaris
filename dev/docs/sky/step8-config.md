# Polaris 重构 · 第八步：系统配置存储改造 —— cap.config 上总线（管理面收敛）

> 状态：试点实施中（performance 段已完成：cap.config 注册 + 白名单 + 深层合并 + 脱敏 + 前端分流）
> 日期：2026-09-12
> 目标目录：`dev/docs/sky/` 记录规划
> 承接：第七步阶段 C 第一块（`step7-consolidation.md` §2 阶段 C）
> 原则：**先实现新骨架，再一块块替换，不着急**。config 维持 `config.json` 单一真源，
> 不切 SqliteStorage；收敛的是「读写路径 + 安全」，不是「存储引擎」。

---

## 0. 一句话结论

**cap.config 上总线** = 把 config 读写收敛成唯一入口（同步能力 + 权限门 + 审计 + 摘旧**多份复刻**）。
它既不是 step2 的存储引擎替换，也不是 sky 那种「插件工具改自己 config」，
而是「把 config 收成管理面唯一入口，让它在总线上可审计、可设权」。

⚠️ **config 的复刻不止三份，是四通道**：命令层（lib.rs）+ Web 桥（ipc.rs）+ 第三份
（settings.rs，实为 Web 承载体）+ **httpTransport 路由映射表**（§2.C）；外加多个「非命令壳
但直读 config_store」的旁路点，摘旧时全量核对。

---

## 1. 关键判断（代码级核实）

### 1.1 config 在 Polaris 里是「特殊域」，不能照套 todo 模板

与已闭环的 todo / prompt_snippet / context 相比，config 域有四个本质差异：

| 差异 | 证据 | 对迁移的影响 |
|---|---|---|
| **巨型嵌套结构** | `Config` **顶层 41 个字段**（`models/config.rs:1494`，2026-09-12 代码级核实），嵌套 3–4 层：`default_engine` / `claude_code` / `model_profiles`(Vec<ModelProfile> 含 `api_key` 明文) / `provider_groups` / `plugins`(BTreeMap) / `permissions` / `performance` / `web` / `qqbot` / `feishu` / `dingtalk` / `workspaces` / `terminal_scripts`… | 不适合「item=半结构化 JSON + json_extract WHERE」的 SqliteStorage 模型——那是给**大量同构记录**用的，config 是**一份大文档**；41 个顶层字段意味着白名单 section 建模要覆盖全量，而非 sky 的 4 字段 |
| **副作用热生效** | 改 config ≠ 落库就完事。`update_config*` 必须顺序执行：级联写 Claude settings.json → 刷新引擎缓存 → emit `config-changed`（`lib.rs:143-177`）；`apply_web_server` 还要启停 Web 服务（`lib.rs:314`） | 普通 CRUD capability 没有副作用钩子；cap.config 的写动作必须**保留这些副作用**，否则热激活语义全丢 |
| **进程级共享** | 主应用 Web/桌面双进程 + `personal_hub_mcp_server.rs:36-45` 旁路 `std::fs::read_to_string` 直接读 config.json（不共享 ConfigStore 锁/迁移逻辑）；未来 bus MCP 若开放 config 给 AI 还会加第三个读者 | config 本质是「进程启动时的全局状态快照」，不是纯数据；跨进程一致性要靠「读写唯一下沉到总线」而非换存储 |
| **敏感字段密集** | config.json 里躺着 `api_key` / `web.token` / `personal_hub.session_token` / 插件 secret | 读取要脱敏、写入要白名单、审计不能落明文（§3.3） |

### 1.2 现状三份复刻，正是「收敛」要消灭的对象

1. **命令层**：`lib.rs` 的 `get_config/update_config/update_config_patch/set_work_dir/set_claude_cmd/reset_cli_config/find_claude_paths/validate_claude_path/health_check/detect_claude/get_local_ips/apply_web_server/get_web_server_status`（`lib.rs:134-495`）
2. **Web 桥**：`ipc.rs` 逐命令复刻，且有的**实现已分叉**——`set_work_dir` 手写 clone→update 而非复用 `ConfigStore::set_work_dir`（`ipc.rs:1226`）
3. **第三份**：`web/api/settings.rs:23` 的 `handle_update_settings`，**注释自承认**「Web 模式无 app_handle，不广播 config-changed 事件」（`settings.rs:19-22`）

另有 Web 侧漏注册的既成 bug：`set_personal_hub_session` 只在 `ipc.rs` 注册、`lib.rs` 的 `generate_handler!` 没有——桌面模式调用会静默失败（前端 `personalHubAuthStore.ts:30,39` try/catch 吞掉 warning）。**这就是「多份代码必然漂移」的活证据。**

### 1.3 sky 参考：范式可取，教训要防

**可借鉴**（commit `85e6440` 验证过）：
- **schema 驱动**：Rust `field_schemas()/all_field_schemas()` 是单一真源（`sky/src/config.rs:519-564`），新增可写字段只改 Rust 一处、前端 `<sky-tool-config>` 零改动；`schema` action 是纯声明、不读 config.json、面板在服务启动前也能拿到。
- **白名单写**：`ALLOWED_SECTIONS = ["limits","session","log"]`，`runtime/model_profiles` 硬编码拒绝（`sky/src/plugins/tools/config.rs:3-5`）；前端只渲染 schema 返回的字段，双端双重兜底。

**反面教训**（Polaris 要规避）：
1. config 在 sky 是 **Tool 非 Capability**（走 `cap.ai.tools` 宿主）——改 config 与改 bash/fs 同权，gate 按 `target` 裁决不看 payload（`sky/src/router.rs:341-345`），管理面无差异化防线。Polaris 的 PolicyPermission 按 `cap.config*` 精确匹配，比这强。
2. `cap.provider` 的 `get` 返回明文 `api_key`，而 `list` 脱敏（`sky/src/plugins/provider.rs:68 vs 76-80`）——**敏感级别不一致**。
3. config 写后不触发热更新、并发写无锁（`save_config` 靠 tmp+rename 保证单次写不损坏，但有 last-write-wins 丢失更新风险）。

---

## 2. 交付清单

### A. 新增 `services/router/config_capability.rs`（核心，先做 + 单测）

同步 `cap.config`，注册于 `state.rs` 装配点（与 cap.kv/todo/context 并列）。动作协议：

| 动作 | 说明 | 敏感处理 |
|---|---|---|
| `get` | 读指定 section（缺省 = 白名单全部）；只暴露白名单 section，不泄露 model_profiles 全量结构 | `api_key/web.token/session_token` → `mask_key` 脱敏 |
| `patch` | 按 section 合并写 + 持久化 + **副作用链**（见 §2.B） | 写前字段白名单校验；Secret/Path 独立动作 |
| `schema` | 纯声明（同 sky），不读 config.json；面板据此渲染控件 | — |
| `apply_web` | 复用 `apply_web_server` 语义，Web 配置保存后即时生效 | — |
| `reset_cli` | 复用 `reset_cli_config` 语义 | — |

**单测**（真实能力，非骨架）：白名单 section 读写 / 越权 section 拒绝 / 未知字段拒绝 /
脱敏快照（api_key 变 masked）/ schema 全量声明 / patch 副作用触发顺序 / 权限 deny 落审计。

### B. 副作用链（cap.config 与 sky ConfigTool 的最大差异点）

写动作 `patch` 落地后必须顺序执行（保留 `lib.rs:143-177` 语义）：
1. `cascade_active_model_profile(&config)` —— 激活 ModelProfile 凭证级联写 Claude settings.json
2. `refresh_engine_configs(&state, config)` —— 引擎注册表失效缓存
3. `emit_config_changed(&app_handle, &config)` —— 广播 `config-changed`（payload `performance`）
4. `apply_web_server`（仅 web section 变化时）—— 启停 Web 服务

> **这是 cap.config 与 sky ConfigTool 的本质差异**：sky 写后不热更新（`sky/src/config.rs:65-68` 注释明说需重启），Polaris 必须做热生效，否则 config 的「改即生效」语义全丢。

### C. 三份复刻摘除（收尾动作）

> ⚠️ **修正（2026-09-12 复审）**：`web/api/settings.rs` **不是**「多余的一份」，而是 **Web 模式下 config 读写的实际承载体**。前端 `httpTransport.ts:31-33` 把 `get_config/update_config/update_config_patch` **三个命令统一映射到 `/api/settings`**（`GET_COMMANDS` 里 `get_config` 走 GET 分支），路由注册在 `web/router.rs:131`。**摘掉 settings.rs = 整条 Web config 读写断裂**。

| 复刻 | 文件 | 摘除方式 |
|---|---|---|
| 命令层 | `lib.rs:134-495`（`generate_handler` 注册于 `lib.rs:810`） | 业务核保留（`ConfigStore` 不动），命令壳 → cap.config |
| Web 桥 | `ipc.rs` config 分支 + dispatch fn（`ipc.rs:224,240-244,353-355,390-391` 等） | 分支摘除，Web 改走 `router_dispatch("cap.config")` |
| 第三份 | `web/api/settings.rs` + `web/router.rs:131` | **改走 `router_dispatch`，而非直接删**：`/api/settings` 路由保留给 get_config 兼容或一并切 dispatch |
| **路由映射** | `httpTransport.ts:31-33`（`get_config/update_config/update_config_patch → /api/settings`）| **cap.config 迁移必牵动此表**：三个命令的映射要么切 `router_dispatch`，要么保持 `/api/settings` 但让其后端走 cap.config |

前端 `configService.ts` 全部出口 → `router_dispatch`，`SettingsPage` / `configStore` / `MobileConnectionGate` 等消费方 **UI 零改动**（service 层透明切换）。

> **第四处隐藏漂移源（非命令壳但直读 config_store）**：`lib.rs:730`（web server 启动判定）、`lib.rs:1298`（守护进程健康监控）、`lib.rs:1356`（token 注入）、`commands/integration.rs:290`（直写 `config_store.patch` 三集成段）、`commands/mcp_manager.rs:19`、`commands/plugin.rs:20` 等**不是命令壳、但直接 `state.config_store.lock()` 现场读**。摘旧时这些点**不会随命令壳一起消失**，需单独 grep `config_store` 全量核对——否则「命令壳摘了、旁路直读还在」的双通道仍在。

### D. 权限门 + 敏感字段治理

- **权限**：启用 `policy_permission.rs:236-272` 已预埋的 `cap.config → remote deny`（Bootstrap 不受限）；读动作若对 Remote 放开，用精确规则 `cap.config.read → allow` 覆盖通配 deny（`policy_permission.rs:258-275` 已验证特异性）。
- **敏感字段**：读路脱敏（复用 `mask_key` 形态：`${ENV}`→`env:<NAME>`、≤4 字符全遮、否则 `****<后4字符>`）；写路 Secret/Path 型字段独立动作或二次授权；dispatch 审计沿用 `audit_sink.rs:10-11`「source 只落变体名」惯例，**永不落明文**。

---

## 3. 边界（做/不做）

- ✅ 新增 `cap.config` 同步能力 + 真实白名单 schema + 副作用链 + 单测
- ✅ 三份复刻摘除，前端零改动
- ✅ 启用 `cap.config → remote deny` 权限收紧
- ✅ 敏感字段读脱敏 / 写白名单 / 审计不落明文
- ❌ **不切 SqliteStorage**（config 维持 config.json 单一真源；step2「沿用」决策不变）
- ❌ 不迁移旧配置数据（配置本身无「旧数据」概念，读文件即最新）
- ❌ 不改冻结契约（cap.config 是普通同步 Capability，不加新 trait）
- ❌ 不顺手改 `mobile_config`（独立文件，随其所在域单独立项）

## 4. 验收标准

1. `cargo check --lib` / `--tests` / `--no-default-features --bin polaris-web` 全绿；
   独立 crate `sky-verify` 实跑通过（沿用 /tmp verify 模式，绕 Tauri DLL `0xc0000139`）。
2. `cap.config`：`get/patch/schema/apply_web/reset_cli` 全链路 + 白名单越权拒绝 + 脱敏快照。
3. **副作用链验证**：patch 后 Claude settings.json 级联更新、引擎缓存失效、`config-changed` 广播。
4. 权限：Web 测试台传 `cap.config` → Deny 落审计；桌面主窗口 → Allow；`cap.config.read` 精确放行生效。
5. 摘旧四层清单全过（代码标识 / 持久化配置 / 用户可见性 / AI 工具消费方）；`grep get_config|update_config_patch|handle_update_settings` 零残留；**httpTransport 三命令映射已切 dispatch**；**`config_store` 旁路直读点（lib.rs:730/1298/1356、integration.rs:290 等）全量核对、无第二通道残留**。
6. 24h 用户可见性回访：Settings 各 Tab 保存/热生效 / Web 开关 / ModelProfile 切换 / 局域网访问全回归。

## 5. 影响面

| 维度 | 影响 | 说明 |
|---|---|---|
| 现有代码 | 🟡 中 | 新增 config_capability.rs + 副作用链；命令壳摘除（ConfigStore 核心保留） |
| 前端 | 🟢 零改动 | service 层透明切换，UI 不动 |
| 数据 | 🟢 零改动 | config.json 原样，不迁移不切库 |
| 安全 | 🟢 正向 | 关闭「三份复刻 + 前端自报」漂移；管理面 remote 收紧 |
| 风险 | 🟡 中 | 副作用链若丢一环则热激活失效——单测必须覆盖顺序 |

## 6. 实施顺序

- **A**：`config_capability.rs` + 白名单 schema + 脱敏 + 单测（先做，独立验证）
- **B**：副作用链接线 + 单测（验证顺序）
- **C**：state.rs 装配 + 权限规则启用 + Web 桥切换
- **D**：前端 service 切换 → 摘旧三份复刻 → 四层清单 → 24h 回访

不一次全改；A 验证通过再动 B，副作用链未稳前不摘旧。

## 7. 关联

- 第七步阶段 C 的第一块（`step7-consolidation.md` §2）——本步是其实施
- 第五步已预埋权限规则（`step5-permission-audit.md` §2.C）
- step2 对 config 的「沿用」决策（`step2-storage.md` §1.2 / `prototype-storage.html:180`）
- sky 范式（`do/sky/src/plugins/tools/config.rs` / `contracts/panels.js` / commit `85e6440`）

---

## 8. 试点实施记录（2026-09-12，performance 段）

### 已完成

- **A. cap.config 实体**：`src-tauri/src/services/router/config_capability.rs` 新增
  `ConfigCapability`（`Capability` trait 实现）。持 `Arc<Mutex<ConfigStore>>`，动作协议
  `get / patch / schema / reset_cli`。
  - 白名单 schema 6 段（core/performance/web/modelProfiles/providerGroups/permissions），
    `performance` 按真实模型 8 字段（fileWatcher/lspIndex/schedulerDaemon/syntaxHighlighting/
    mermaidDiagrams/katexMath/codeEditorLanguages/pluginAutoStart）。
  - **深层合并** `merge_section_value`：先读当前 section 值 → 与 patch 合并 →
    补默认 → 完整对象写顶层。**规避 `ConfigStore::patch` 顶层整体替换丢开关的缺陷**
    （`merge_json_object` 只并第一层）。
  - **脱敏**：`web.token` / `modelProfiles.apiKey` 读路掩码（≤4 全遮，否则留后 4）。
  - 副作用链：`on_patch` 回调由装配层注入（当前为空，B 阶段接线）。
- **A. 装配**：`state.rs` Arc 化 `config_store`，`ConfigCapability::new(config_store_arc, ...)`
  注册进 RouterBus。`mod.rs` pub use。
- **C. 前端分流**：`src/services/configDispatchService.ts` 新增 cap.config 前端 service；
  `configStore.ts` `updateConfigPatch` 对 `performance` 键分流走 cap.config（深层合并），
  其余字段仍走旧 `update_config_patch`；新增 `syncPerfHotSwitch` 手动补热切换
  （cap.config 不 emit `config-changed`，与 tauri command 行为差异化）。

### 验证证据

1. 独立验证 crate 20 项 cap.config 测试全绿（白名单 / 深层合并防丢 / 脱敏 / 副作用顺序 /
   权限 deny），收敛到真实 8 字段后重跑仍全绿。
2. 完整验证 crate 114 项测试全绿。
3. `cargo check --no-default-features --bin polaris-web` 与
   `cargo check --features tauri-app` 双模式编译绿。
4. 前端 `npx tsc --noEmit` 对本次改动文件（configStore/configDispatchService）零错误。

### 遗留（后续阶段）

- **D**：摘旧四层清单（lib.rs `update_config_patch` / settings.rs / httpTransport 映射）。
  试点阶段旧通道保留（双写并存，cap.config 已收敛性能段）。
- Web 模式 `dispatch_router_dispatch` source=Remote，默认权限全放行可写；预埋
  `cap.config* → remote deny` 规则待运行时需要在 config.json permissions.rules 注入。

---

## 9. B 副作用链分析（2026-09-13，方案 A 落文档）

### 9.1 现状对照（三路径副作用）

| 路径 | cascade(Claude settings) | refresh(引擎缓存) | emit(config-changed) | apply_web |
|---|---|---|---|---|
| 桌面 `update_config_patch`（lib.rs:164） | ✅ `cascade_active_model_profile` | ✅ `refresh_engine_configs` | ✅ `emit_config_changed`（同步 `AppHandle`） | 分开命令 |
| Web `handle_update_settings`（settings.rs） | ❌ 缺 | ✅（内联 registry.refresh_all_configs） | ❌ 缺（注释自承认「Web 无 app_handle」） | 分开命令 |
| **cap.config `on_patch`（当前为空）** | ❌ | ❌ | ❌ | ❌ |

### 9.2 核心约束

`ConfigCapability::on_patch` 签名是 **`Box<dyn Fn(&Config) + Send + Sync>`**（同步、无 `AppState`/`AppHandle`）。但副作用需：

| 副作用 | 依赖 | 与签名兼容 |
|---|---|---|
| `cascade_active_model_profile(&config)` | 仅 `&Config` | ✅ 同步可做 |
| `refresh_engine_configs(&state, config)` | `&AppState`、异步 | ❌ |
| `emit_config_changed(&app_handle, config)` | `&tauri::AppHandle`、异步 | ❌ |

**emit 依赖 AppHandle**：桌面模式由 `lib.rs:587` `state.app_handle.set(app.handle().clone())` 填充，**Web 模式 AppState.app_handle 为空**（integration_tests.rs:860 `get().is_none()`）。即 **Web 下 emit 客观不可行**，与现状一致。

### 9.3 方案 A（选定 A2 —— 桌面走总线 + 全量副作用）

**capability 保持纯逻辑可测，副作用分两层**：

- **capability 内**：`on_patch` 只做**同步可做的 cascade**（`cascade_active_model_profile(&config)`）。
- **调用方**：桌面侧**新增 tauri command `config_patch_via_bus`** 包装 cap.config patch，成功后补 **refresh + emit**（桌面有 `AppHandle`，全量副作用）；Web 桥保留现状（refresh 已有、emit 无 AppHandle 不可行，与 `handle_update_settings` 一致）。

**前端分流事实**：`updateConfigPatch` 仍被 SettingsPage/ChatStatusBar/PromptSnippetTab/ThemeManager 大量消费（非 performance 键）。A2 下：
- **桌面模式**：新增 `config_patch_via_bus`（cap.config 包装）——前端桌面线走它，补全量副作用
- **Web 模式**：走 `router_dispatch`（既有的 cap.config Web 桥），refresh 已有
- 旧 `update_config_patch` **保留**（非 performance 字段消费方仍依赖，cascade+refresh+emit 原样，作为非 performance 通道）

### 9.3.1 A2 实施清单

- [x] **后端**：新增 `config_patch_via_bus` tauri command（`lib.rs`）
  - `req: RouterDispatchRequest`（target=cap.config, action=patch, section, value）
  - 经 `state.router.dispatch` 走总线（权限 gate + audit + 白名单 + 深层合并）
  - 成功后补 `refresh_engine_configs` + `emit_config_changed`（桌面 AppHandle）
  - 注册进 `generate_handler!`
- [x] **后端**：cap.config `on_patch` 补 cascade（能力内同步，桌面/Web 通用）
  - `model_profile_service.rs` 新增 `cascade_active_profile_to_claude(&Config)`（无 Tauri 依赖）
  - `lib.rs` `cascade_active_model_profile` 委托为 services 版（单一真源，消除双份）
  - `state.rs` `on_patch` 注入该函数
- [x] **前端**：桌面模式走 `config_patch_via_bus`，Web 模式走 `router_dispatch`（`configPatch` 分流）
- [x] **验证**：verify crate 114 绿（副作用顺序未破坏）；双模式 cargo check（`--no-default-features
  --bin polaris-web` / `--features tauri-app`）均 EXIT=0；tsc 对改动文件（configDispatchService/
  configStore）零错误；隔离实例冒烟复验 cap.config 机制零回归（get/patch 深层合并/白名单拒绝/
  持久化）
