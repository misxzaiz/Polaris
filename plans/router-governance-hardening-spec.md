# RouterBus 治理收紧 — 修补三个现存旁路 + 高危 Prompt 覆盖

## 背景（评审 agent 交叉验证发现，均为现存问题，与主题改造无耦合）

1. **横幅按钮旁路**：AI 注入的横幅按钮（`inputUIStore.dispatchBannerAction` → `dispatchCapUiAction`）在主窗口 IPC 下获得 `Source::Bootstrap`，可执行任意 cap（含 `cap.bash`）；Remote-deny 规则对 Bootstrap 无效。按钮文案与实际动作可不一致。
2. **uiControlEnabled 开关旁路**：开关只在前端把 `polaris-bus` 加入 `disabledMcpServers`（`conversationStoreUtils.ts`），而 `polaris-dispatch` 的 `cap_dispatch` 同样能调 `cap.ui.*` / `cap.self.mutate`，开关对它无效。
3. **cap 覆盖白名单过宽**：`registry_capability.rs` `OVERRIDE_L0_PREFIXES` 含 `cap.kv` / `cap.history` / `cap.context` / `cap.prompt_snippet`，任意插件（或 AI 经 cap_dispatch）`replaces=true` 覆盖**无需授权**；覆盖 `cap.kv` 可劫持动态 cap 持久化键空间。
4. **高危 cap 对 AI 默认放行**：Prompt 规则只覆盖 5 个插件管理动作；`cap.bash:run` / `cap.http`（SSRF 校验已放开）/ `cap.data_root:set_root` / `cap.registry:register` 对 Plugin 源默认 Allow。

## 方案

1. 前端 `dispatchCapUiAction` 增加 target 白名单（对齐 form 白名单语义）：仅 `cap.ui.*`、`cap.kv`、`cap.todo`、`cap.context`；其余 target 拒绝并 log.warn。用户点击注入 UI 触发的动作不再能直达高危 cap。
2. `PolicyPermission::from_config` 读取 `ui_control_enabled`：为 false（默认）时注入 Plugin 源对 `cap.ui.theme/chat/input/render` 与 `cap.self.mutate` 的 Deny 规则——策略层生效，覆盖 bus_dispatch 与 cap_dispatch 两条路径；Bootstrap（本机用户直点 UI）不受影响。
3. `OVERRIDE_L0_PREFIXES` 收窄为 `cap.ui.`（保留插件换 UI 皮的低危能力）；`cap.kv/history/context/prompt_snippet` 移出 L0（按默认级别走授权）。
4. 新增 Plugin 源 Prompt 规则：`cap.bash:run`、`cap.http`（全动作）、`cap.data_root:set_root`、`cap.registry:register`。审批基建（PermissionPromptHost + 10min TTL Registry）已存在，无需新 UI。

## 验收

- `cargo check`（+ no-default-features 门控）；policy/registry 相关 Rust 测试更新后全绿（本机以 `cargo check` 编译验证为门槛，测试断言同步修正）。
- 前端 `pnpm typecheck`；若有 dispatchCapUiAction 相关测试则更新。
- 行为验证点：uiControlEnabled=false 时 AI 经 cap_dispatch 调 cap.ui.theme 收到 deny；横幅 dispatch 带 cap.bash target 被前端拒绝。

## 不做（显式）

- cap.bash 内置 SimpleAI 工具（不经总线）的审批 —— 另行立项。
- cap.http SSRF 目标校验恢复 —— 独立决策（当前放开可能是有意为之的 agent 能力面）。
