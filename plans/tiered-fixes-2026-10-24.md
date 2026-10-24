# 审计梯队实施记录：P1-P5（tiered-fixes-2026-10-24）

> 承接：`plans/plugin-cap-plugin-system-audit-2026-10-24.md`（问题全景）与
> `plans/p0-foundation-fixes-spec-2026-10-24.md`（第一梯队 X1-X5，已实施）。
> 本文档记录第二至第五梯队的实施内容、设计裁决与如实交代的边界。
> 分支：`fix/plugin-cap-p0-foundation`（worktree `D:\space\base\Polaris-p0`，已基于 main `194d4213` 变基）。
> 日期：2026-10-24

---

## 0. TL;DR

用户裁决「复审确定，无模块冲突则实施直到完成所有内容」。P0 分支与最新 main 零冲突、双 cargo 门槛全绿后，依次完成：

- **P1 生命周期治理**：端口治理（bind 探测 + 宿主端口避让 + 冲突显式报错）、healthCheck 接状态机、服务状态实时回推前端、MCP stderr 消费、更新先停服务、Web token 分级放行（X9/X7）、bus 进程读用户权限规则（X8）、AI 操控审批门（action 粒度 + 非阻塞批准 + 前端确认卡）。
- **P2 cap 自由度**（`plugin-cap-full-freedom-v1` 方案落地）：X12 注册查重、X6 toolProviders 归属校验、RealContext 权限/caller 补全、PluginRpc handler（插件提供真正的 cap 逻辑）、覆盖链（replace/replaceMode + OVERRIDE_LEVELS 分级 + fallback 下探）、`contributes.capabilities` 声明面 + 装配器 + 设置页能力提供者展示 + executors 门控。
- **P3 AI 可见性**：cap_dispatch 去手抄枚举、bus_help 去矛盾、prompt_snippet describe 逐字段、persona 兜底。
- **P4 skill 插件化**：`contributes.skills` + DataRoot 同步（引擎零改动）。
- **P5 样式布局**：views slot/slotMode 前后端漂移修复、CSS 内容校验（fail-closed）、`target:'slot'` 作用域真正落地。

## 1. 各项设计裁决

### P1-a/b/c（0993d84d）
- 端口：allocate/reserve 均 OS bind 探测（被占/Windows 保留段自动跳过）；宿主保留端口（config web.port + ask_listener 池，常量已导出 `ASK_LISTENER_PORT_POOL`）注入 PSM 避让；manifest 声明端口冲突显式报错（此前静默双启动）。已知残余：bind 探测到 spawn 之间存在 TOCTOU 窗口（进程 bind 失败由 healthCheck/watcher 收敛）。
- healthCheck：http 型 spawn 后 Starting，首次探测成功翻 Running；连续 3 次失败置 Error 停止探测（进程退出/重启仍归 watcher）。修复点：旧探针遇 Starting 直接退出，Starting 永远无法收敛。
- 状态回推：PSM 内建 broadcast → `spawn_plugin_status_forwarder`（必须 runtime 内调用，桌面 setup / web block_on 接线）→ RouterBus `emit_event`（kind=`plugin.service.status`）→ 桌面 Tauri emit 中继（新）+ WS（EventBroadcaster 天然直达）→ 前端 pluginLifecycleSubscriber 回填 pluginServiceStore。

### P1-f/g（token 分级 + 审批门）
- X9/X7：`cap.plugin` Remote deny 拆两档——token 匹配 `config.web.token` 的已鉴权 Remote 放行 `cap.pluginServiceManager`（Web 模式插件服务管理）；`cap.pluginDiscovery`（安装/卸载）仍 deny；未鉴权 Remote（含内置浏览器空 token webview）维持全 deny 零回归。
- X8：bus-mcp 进程从 config.json 装载 permissions + web.token（此前 `from_config(None)` 同机两套权限语义）。
- 审批门：`PermissionRequest.action`（dispatch 从 payload.action 注入；策略先匹配 `capId:action` 再回退 bare id，用户既有规则零影响）。内置 Prompt 规则：AI（Plugin 源）调 stop_for_plugin / autostart / uninstall_local / uninstall_with_cleanup / force_uninstall 需用户审批。
- **非阻塞「批准 + 重试」**（关键裁决）：dispatch 是同步契约、调用方横跨 spawn_blocking/独立 runtime，阻塞等 UI 会卡死宿主线程——Prompt 时登记 `PermissionPromptRegistry`（批准摘要 capability+action+source，10 分钟 TTL）+ 广播 `permission.prompt` 事件 + 返回待审批错误；AI 重试即放行。前端 `PermissionPromptHost` 全局确认卡（右下角非模态）。

### P2（cap 自由度 L2+L3）
- PluginRpc：经 `cap.mcp` 常驻 client 池调插件 MCP 工具（最低成本路径，任意语言 handler），统一 gate/审计/归属校验/per-tool 门复用；cap.mcp 复核 source（未鉴权 Remote 拒绝）。v1 per-handler timeout 由底层 tools/call 180s 兜底（字段保留、describe 说明）。
- 覆盖链：`RouterBus.overrides`（id → 栈，末位 active）；dispatch 候选链——override 失败即返回、fallback 失败下探、base 恒兜底；一次 dispatch 恰一个终态事件 + 一条审计。`wrap` 模式 v1 未实现（注册显式拒绝）。
- OVERRIDE_LEVELS：L0（prompt_snippet/ui./kv/history/context）任意插件可覆盖；L2 其余高危域需 `config.capOverride.allow` 白名单（Config 新字段，装配注入）；L4（registry/help/ai.chat/stream./self./mcp/voice/hook/plugin）永不覆盖。判定抽 `pub(crate) check_override_permission` 自由函数（registry 与装配器同源）。
- **覆盖注册 v1 不持久化**（与 full-freedom 方案 §3.4 的按时间戳重建不同，如实降级）：重启后覆盖失效、base 自动恢复——避免持久化重建撞 id 的复杂度；返回值 note 明示。
- 装配器：`plugin_capability_assembly`（进程级 OnceLock 共享 RouterBus，模式同 hook_registry），统一入口 `sync_plugin_contributions`（capabilities + skills），挂三个生命周期点：启动（state.rs）、启停切换（plugin_state_save）、安装/更新/卸载（emit_plugin_lifecycle 统一出口）。禁用插件撤销其贡献（覆盖弹出 + 动态卸载，幂等）。
- executors 门控：注册补 enabled 检查（此前三层门独缺）；**workspace scope 限制如实保留**（启动期无 workspace 上下文，项目级插件 executors 仍不注册——记录待治理）。

### P4 skill 插件化
- 复制而非引用：`<pluginDir>/skills/<id>/SKILL.md` → `<DataRoot>/skills/plugin-<pluginId>-<id>/`，SimpleAI `discover_skills` 零改动；`plugin-` 前缀即命名空间（永不与用户手写 skill 同名去重冲突）；孤儿清理（禁用/卸载）；SKILL.md mtime 比较实现更新刷新。
- 安全校验：目录名压平路径分隔符；缺 SKILL.md 的声明 warn 跳过。

### P5 样式布局
- **本梯队范围裁决**：实施「CSS 作用域 + 校验」与「manifest 漂移修复」两个地基项；「统一 slot 注册表收敛六套挂载机制」「theme/layout manifest 贡献点」「插件 JS 沙箱」是特性级设计任务，未在本轮实施（审计 §2.6 原文亦将其列为多阶段路线）。
- scopeCss：选择器逐段前缀 `[data-plugin-scope="<pluginId>"]`，@media/@supports/@layer/@container/@scope 递归、@keyframes/@font-face/@property 原样；PluginPanelHost 容器挂作用域属性。
- validateCss fail-closed：256KB 上限、禁 @import、禁外联 url()（数据外泄/内容注入通道）；拒绝时 warn 跳过该 style。

## 2. 验证门槛（实际执行）

- [x] `cargo check` ✅ 0 error（每个主题提交后均跑）
- [x] `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` ✅ 0 error（动了 commands/ipc/bus_mcp 后跑）
- [x] `cargo clippy --lib`：本次新增文件（assembly/skills/permission_prompt/contracts 新段）warning 全清（含 dead_code 标注与 doc 格式）；存量 warning 维持审计前水平
- [x] `pnpm exec tsc --noEmit` ✅（P1-c 前端订阅、P1-g 审批卡、P2-d 能力展示、P5 styles/PanelHost 改动）
- [x] 新增单测：assembly（注册/查重/撤销/分级拒绝）、permission_prompt（批准流/deny/幂等）——**编译通过；本机 `cargo test --lib` 受 Tauri DLL 限制无法运行**（AGENTS.md 九，同 P0），执行留待 CI
- [x] 审计报告 + P0 spec + 本文档归档 `plans/`

## 3. 未实施与后续（如实交代）

1. **统一 slot 注册表**（六套挂载机制收敛）、**theme/layout 贡献点**、**插件 JS 沙箱**——P5 剩余三项，特性级设计任务，需先出 spec（顺序：slot 注册表 → 沙箱评估 → theme 贡献点）。
2. **覆盖注册持久化**（full-freedom 方案 §3.4 的按时间戳重建）与 **wrap 模式**。
3. **per-handler PluginRpc 超时**（现由 tools/call 180s 兜底）。
4. **executors 项目级 scope**（需会话级注册链路）。
5. **MCP server 端 dispatch 超时**（AI 客户端 180s 兜底已覆盖，服务端双保险留 P2）。
6. **覆盖注册的安装期审批 UI**（L1 弹窗）：v1 以 `config.capOverride.allow` 白名单承载授权，设置页暂无白名单编辑面板（可直接编辑 config.json）。

## 4. 提交清单（本梯队）

| 主题 | 内容 |
|---|---|
| `8ff3709f` | P0-X1 动态转发保留原始 Source（安全） |
| `f0ae25ca` | P0-X4/X5 审计补全 + dispatch 超时护栏 |
| `aba91319` | P0-X2/X3 停止竞态 + 退出孤儿进程 |
| `93aca7b8` | 审计报告 + P0 spec 归档 |
| `0ecf97e8` | P1-a/b/c 端口治理 + healthCheck 状态机 + 状态回推 |
| `2d30c02e` | P1-d/e MCP stderr 消费 + 更新先停服务 |
| `ddc179c3` | P1-f/g Web token 分级 + X8 + AI 操控审批门 |
| `67be4af3` | P2 前置：X12 查重 + X6 归属校验 + RealContext 补全 |
| `37948cf1` | P2-b/c PluginRpc + 覆盖链 + OVERRIDE_LEVELS |
| `32b2ea8a` | P2-d contributes.capabilities + 装配器 + executors 门控 |
| `3ba88134` | P3 AI 使用说明治理四处 |
| `4e74d175` | P4 skill 插件化 |
| `d75282ce` | P5 CSS 校验/scoped + slot 漂移修复 |
