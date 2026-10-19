# AI 运行时自拓展能力：动态能力注册表（cap.registry）+ 输入区即时调节（cap.ui.input）

> 目标（goal）：「实现功能，支持 AI 自行拓展能力，如即时调整输入悬浮，如随意支持加功能模组无需启动」
> 状态：**已实现（2026-10-19）**，含死锁修复与测试
> 日期：2026-10-19

## 1. 现状与缺口（调研结论）

### 已存在底座
- `RouterBus.register_handle` / `register_streaming` 是**运行时 API**（RwLock 表，任意时刻可注册），但生产装配全在启动期（state.rs L409-488、lib.rs）。
- `cap_dispatch` / `cap_list`（polaris-dispatch MCP → ask_listener）是 **AI→任意已注册 cap 的动态全量通道**；`cap_list` 每次动态读 `described_capabilities()`。
- `cap.ui.theme` / `cap.ui.chat` + `uiDispatchService.ts` 已实现「AI 经 bus_dispatch → tool_call_end 事件 → 前端 store 即时生效」链路。
- 插件引擎热注册（register_plugin_engine）、前端插件面板/卡片动态加载磁盘 JS（Blob URL + vite-ignore import）均已可用。

### 核心缺口
| # | 缺口 | 影响 |
|---|------|------|
| 1 | `register_handle` 无生产对外入口 | AI/插件无法运行时注册新 cap |
| 2 | 无 unregister API | 注册后无法显式卸载 |
| 3 | 插件 manifest 无 capabilities 贡献 | 插件方向断裂 |
| 4 | ExecutorRegistry 仅启动期注册 | 插件 executor 装后需重启 |
| 5 | bus_dispatch 白名单硬编码 | 新 cap 不自动进白名单 |
| 6 | 输入区悬浮层/附加组件写死（ChatInput 内硬编码 import + 条件渲染） | AI 不能即时调输入悬浮层 |

## 2. 目标架构

```
                    ┌──────────────────────────────────────────┐
                    │             AI 会话（claude-code 等）       │
                    │   tools: cap_dispatch / cap_list / ...     │
                    └───────────────┬──────────────────────────┘
                                    │ JSON-RPC (MCP)
                    ┌───────────────▼──────────────────────────┐
                    │  ask_listener (主进程 TCP)                │
                    │   cap_list → described_capabilities()     │
                    │   cap_dispatch → RouterBus.dispatch       │
                    └───────────────┬──────────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────────┐
                    │  RouterBus（运行时注册表）                 │
                    │   [cap.kv] [cap.http] ... [cap.registry]* │
                    │   [cap.ui.input]*  [cap.<dynamic>]*       │
                    └───────────────┬──────────────────────────┘
                                    │ dispatch.start/end 广播
                    ┌───────────────▼──────────────────────────┐
                    │  EventAdapter → 前端 eventHandler          │
                    │  uiDispatchService → inputUIStore (Zustand)│
                    └──────────────────────────────────────────┘
```

### 2.1 新增：`cap.registry`（运行时能力注册表）
- 动作：`register` / `unregister` / `list` / `listDynamic` / `isRegistered`
- 动态能力模型（配置驱动，**非编译期新 trait**）：
  ```json
  {
    "id": "cap.user.todo-report",
    "summary": "生成待办周报",
    "handler": { "type": "forward", "target": "cap.todo", "defaults": { "action": "list" } },
    "persist": true
  }
  ```
- 语义：`cap.<dynamic>` 注册后立即可被 `cap_list` 发现、`cap_dispatch` 调用。handler 为 forward 转发（复用既有底层 cap 实现，不需要编译期代码）。
- 安全：**拒绝覆盖**既有 cap（id 冲突 → Err）；仅允许 `cap.*` 且不在内置白名单。
- 持久化：注册表存 kv 域（`cap.registry`），启动时自动重新装配。
- 关键：**新增一个泛型 DynamicCapability（Box<dyn Capability>）**，invoke 时按 handler 配置转发。

### 2.2 新增：`cap.ui.input`（输入区即时调节）
- 动作：
  - `get`：返回当前输入区 UI 状态
  - `patch`：调整输入区悬浮层参数（浮窗开关/高度/紧凑度、上下文条可见性、是否显示 / 命令建议等）
  - `banner`：在输入区上方注入一段动态横幅（文案 + 按钮 + 点击执行动作）
  - `reset`
- 效果链路：同 cap.ui.chat —— AI 经 bus_dispatch → tool_call_end 事件 → uiDispatchService → **inputUIStore**（Zustand）→ ChatInput 消费。

### 2.3 RouterBus 补 `unregister`
- `handles` / `streaming_caps` 增加 remove API（RwLock 可直接 remove）。

### 2.4 输入区悬浮层可注入化（最小改动）
- 新增 `inputUIStore`（Zustand）：`floating`（悬浮浮窗配置）、`banner`（动态横幅）、`suggestionOverrides`。
- ChatInput 消费 store：悬浮浮窗开合/高度、banner 渲染。

## 3. 验收标准
1. 对话中 AI 调 `cap_dispatch` → `cap.registry.register` 注册新 cap → 同一会话继续 `cap_list` 能看到新 cap → 用 `cap_dispatch` 调新 cap 成功。
2. 新 cap 持久化：重启应用后 `cap_list` 仍能看到（自动重装配）。
3. `cap.registry` 拒绝覆盖内置 cap（cap.kv 等）与重名。
4. AI 经 `bus_dispatch` → `cap.ui.input` 的 `patch` / `banner`，前端输入区即时变化（浮窗开合、横幅出现）。
5. `cargo check` 通过；前端 `pnpm typecheck` + 相关 vitest 绿。

## 4. 实施步骤
1. RouterBus 补 `unregister`（+ 单测）
2. 新增 `DynamicCapability`（forward handler）到 router/
3. 新增 `cap.registry` 能力（register/unregister/list + kv 持久化 + 启动重装配）
4. 新增 `cap.ui.input` 能力（校验 + 转发）
5. state.rs / lib.rs 装配 cap.registry、cap.ui.input
6. 前端：`inputUIStore` + uiDispatchService 接 cap.ui.input + ChatInput 消费
7. bus_dispatch 白名单追加 cap.ui.input
8. 测试：后端单测 + 前端 vitest + 手工链路验证

## 5. 边界与不做
- 不做「插件 manifest 贡献 cap」字段（可后续扩展，本 spec 走 AI 直接注册）
- 不做动态 executor 热注册（独立工作项）
- 不碰 Context 的 resolve_cap（跨 cap 运行时互调，独立工作项）

## 6. 实现记录与关键决策（2026-10-19）

### 6.1 死锁修复：handles 表 Box → Arc（生产可靠性门槛）
**根因**：`RouterBus::dispatch` 原在 `handles.read()` 读锁 guard 存活期间调用 `cap.invoke()`。动态能力
`DynamicCapability::invoke` 会 `self.router.dispatch()` 重入 RouterBus，再取同一把 handles 读锁。
std `RwLock` 是**写者优先**：只要任一 `register_handle` / `unregister` 写者已在队列等待，第二次读锁 acquire
会阻塞到写者完成——而写者又等持读锁的线程释放 → 读-读重试死锁。

**修复**：`handles: RwLock<HashMap<CapabilityHandle, Arc<dyn Capability>>>`（原 Box）。dispatch 在读锁内
`cloned()` 取出 `Arc` 强引用、**释放锁后再 invoke**。`register_handle` 对外仍收 `Box`，内部 `Arc::from(cap)`，
对 trait `Router::register_handle` 契约零破坏。同时统一了同步/流式能力表的生命周期管理（流式本就 Arc）。

### 6.2 敏感能力转发防护
`SENSITIVE_TARGETS = [cap.ai.chat, cap.registry, cap.help, cap.context]`：拒绝动态能力转发到这些目标，
防「AI 自递归 / 元能力混淆 / 白名单旁路特权放大」。

### 6.3 动态能力调用通道（非 bus_dispatch）
动态能力注册在主进程总线，**经 `cap_dispatch`（polaris-dispatch MCP → ask_listener → 主进程 RouterBus）
调用，不受 bus_mcp_server 静态白名单限制**。bus_mcp_server 是独立进程自建 router，本就未装配
cap.registry，保持白名单隔离是正确边界，不改。

### 6.4 测试
- 后端：`registry_capability::tests` 8 用例（注册/调用/覆盖拒绝/敏感目标拒绝/卸载/persist 回滚）。
- 前端：`inputUIStore.test.ts` 13 用例（store 动作 + applyInputUiConfig 动作协议）。
- 验证：`cargo check --tests --lib` 通过；`pnpm exec tsc --noEmit` 通过；vitest 13 绿。

### 6.5 真实运行环境 E2E（2026-10-19，headless 后端）
未满足于编译+单测，另在**真实启动的后端进程**做了端到端验证（非 Tauri 桌面，走独立
`polaris-web` 二进制 + HTTP `/api/ipc` `router_dispatch` 直连 RouterBus）。

验证环境：`cargo build --no-default-features --bin polaris-web` + `POLARIS_DATA_ROOT` 隔离数据根，
请求 `POST /api/<cmd>` 带 `{"req":{target,payload}}`，source 为 `Remote`（audit 落盘证实）。

**13/13 断言通过**，覆盖：
1. `cap.registry.list` 返回 17 个 builtin，含 `cap.registry` + `cap.ui.input`。
2. `register` 动态能力 `cap.todo.weekly`（forward→cap.todo，persist）→ `exists`/`list` 立即可见。
3. **动态转发调用成功**（`cap.todo.weekly` 重入 dispatch 无死锁——验证 6.1 修复在真实运行时成立）。
4. 显式 payload 覆盖 defaults（`{action:list, scope:all}` → `{items:[]}`）。
5. 安全护栏：转发到 `cap.ai.chat`（敏感）被拒；覆盖 `cap.kv`（内置）被拒。
6. `cap.ui.input` get/patch/banner/reset 四动作全通（config 精确 allow 后）。
7. **重启持久化重建**：杀进程后重新启动同一数据根，日志 `[cap.registry] 重启已重建动态能力: cap.todo.weekly`；
   `cap.registry.db`（stores/ 下独立 SqliteStorage）含完整配置。
8. 审计链：`audit/dispatch.jsonl` 记录全部动态注册/转发/ui.input 调用，带 source。

**经验结论**：
- `cap.ui*` 对 `Source::Remote` 默认 deny 是**有意安全基线**（`policy_permission.rs` 内置收紧，
  防远程旁路控制本地面板）。Web/远程 AI 需 config 精确 allow 覆盖（已验证生效）。
- 动态转发跨 bus 重入的场景就是 6.1 死锁修复的真实触发路径，E2E 证明修复有效。
