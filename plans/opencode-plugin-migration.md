# opencode 引擎插件化迁移

> 目标：删除宿主内置 opencode 引擎（`EngineId::OpenCode`），迁移为 codebuddy 同构的
> engine-v1 插件（`plugins/opencode`），主仓只留缺陷/安全/性能治理。
> 依据：AGENTS.md §五「功能路由原则」——新增面向用户功能默认插件化；opencode 已是
> 存量内置引擎，按用户裁定迁移到插件（非新增功能，但同属「核心可替换」方向）。

## 一、现状（2026-11-12 勘察）

### 宿主侧（`Polaris` 主仓）
- **`src-tauri/src/ai/engine/opencode.rs`**（1673 行）：`OpencodeEngine` 实现 + 17 个单测。
  协议：`opencode run "<msg>" --format json --model <m> [--session <id>] --auto --standalone`，
  输出 JSONL（step_start / text / tool_use / step_finish / error），完成信号 = stdout EOF。
- **`src-tauri/src/commands/engine_metadata.rs`**（`get_opencode_models` 命令 + `OpencodeModel` 结构 + TTL 缓存）
- 注册点：`lib.rs:565`、`web/api/ipc.rs:221`、`commands/mod.rs:99`
- `ai/traits.rs`：`EngineId::OpenCode` 变体 + 12 处穷尽 match（as_serialized_str/aliases/as_str/display_name/known/is_known/registry mock）
- `ai/launcher.rs:219`：`inject_mcp_into_session_opts` 的 OpenCode 分支（写项目级 opencode.json）
- `services/ai_chat_core.rs:618,627,774`：Profile 兼容性豁免 + OPENAI_BASE_URL/API_KEY 环境变量注入
- 前端：`engineMetadataStore.ts`（opencodeModels + loadOpencodeModels）、
  `SessionConfigSelector.tsx`（isOpencodeEngine 特化）、`AIEngineTab.tsx`（open-code 卡）、
  `engineDisplay.ts:22`（fallback）、`engineCapabilities.ts:24`（fallback 选择器）
- **保留（无关引擎 id，是通用工具调用形态）**：`chatCardRegistry.ts` / `eventHandler.ts` 的
  Code Mode 适配、`lightweightMarkdown.tsx` 的 `hasOpenCodeBlock`、`streamRateTracker.ts`

### 插件侧（`Polaris-plugin` 仓）
- **`plugins/codebuddy`**（v0.5.0）：engine-v1 adapter 插件范式。`PluginProcessEngine` +
  `adapter.js`（Node），stdin JSONL → 引擎 CLI，stdout 事件帧 → AIEvent。
  已生产级验证（MCP 挂载、interrupt 树杀、token 聚合等）。

## 二、迁移可行性

✅ **可行**。`PluginProcessEngine` 是通用适配器，不关心底层 CLI 协议。opencode 的
`--format json` JSONL 由新 `adapter.js` 翻译，机制完全复用 codebuddy 已验证通路。

**引擎 id 变化**：`EngineId::OpenCode` → `EngineId::Custom("opencode")`。会话数据中
`engineId: "open-code"` 需兼容映射。

## 三、实施步骤

### 插件仓：新增 `plugins/opencode`
1. `plugin.json`：`contributes.engines[0]` id=opencode，protocol=command，sessionFlags=omp，
   adapter（entry=adapter.js, runtime=node, protocol=engine-v1），mcpConsumption=mcp-servers
2. `adapter.js`：翻译 opencode JSONL → engine-v1 事件帧
   - `opencode run <msg> --format json --model <m> --auto --standalone [--session <id>]`
   - prompt 经 stdin（codebuddy 范式，规避 Windows 命令行上限）
   - step_start→session_start + 真实 sessionID 回传（resume_token）
   - text→token, tool_use→tool_call_start/end, step_finish→usage+result, error→error
   - EOF→session_end（completed/aborted/error 判定，对齐宿主原 T1 语义）
   - interrupt→taskkill /T /F 树杀（codebuddy 范式）
   - MCP：mcp_servers → 临时 opencode.json（项目级注入）
3. 模型列表：adapter 提供 `opencode models` 动态拉取（保留免费优先排序）
4. `tests/`：adapter-smoke.mjs（codebuddy 同构）

### 宿主：删除内置 opencode
1. 删 `src-tauri/src/ai/engine/opencode.rs` + `engine/mod.rs` 的 mod/pub use
2. `traits.rs`：删 `EngineId::OpenCode` 变体 + 全部穷尽 match 分支
3. `launcher.rs`：删 OpenCode 分支（Custom 分支已覆盖，MCP 注入走 mcp_servers）
4. `ai_chat_core.rs`：删 618/627/774 OpenCode 分支（Profile 豁免改造为 Custom 判定）
5. `engine_metadata.rs`：删 `get_opencode_models` + `OpencodeModel` + 缓存
6. `lib.rs` / `web/api/ipc.rs` / `commands/mod.rs`：删注册与命令分发
7. 前端：删 `engineMetadataStore` opencodeModels/loadOpencodeModels、`SessionConfigSelector`
   isOpencodeEngine、`AIEngineTab` open-code 卡、`engineDisplay`/`engineCapabilities` fallback

### 验证
- 插件仓：`node tests/adapter-smoke.mjs` + 构建
- 宿主：`cargo check` + `pnpm typecheck` + 相关 vitest + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`

## 四、风险与边界

| 风险 | 处置 |
|---|---|
| Profile 豁免丢失 | `opencode_exempted` 改为 `matches!(engine, EngineId::Custom(id) if id=="opencode")` |
| 存量会话 id | `EngineId::parse_any` 加别名 `"open-code"`→`Custom("opencode")` 映射 |
| MCP 注入语义 | Custom 分支 `inject_mcp_into_session_opts` 走 mcp_servers，adapter 写 opencode.json |
| 模型动态拉取 | adapter 侧 `opencode models`，manifest models 静态目录兜底 |
| `known()` 变化 | 前端 fallback 删 `open-code`；`normalizeEngineId` 兜底 |

## 五、验收

1. `cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过
2. `pnpm typecheck` + 相关 vitest 通过
3. 插件仓 adapter 冒烟测试通过（假 CLI 注入，覆盖 start/continue/interrupt/token 流）
4. 宿主无残留 `EngineId::OpenCode` / `get_opencode_models` 引用（grep 验证）

## 六、交付物（2026-11-12 实态）

### 插件仓（Polaris-plugin `plugins/opencode/`）
- `adapter.js`：engine-v1 适配器，翻译 opencode JSONL（step_start/text/tool_use/step_finish/error → engine-v1 帧），EOF 终态判定对齐宿主原 T1 语义
- `plugin.json`：contributes.engines[0] id=opencode，adapter（node/engine-v1），models 静态目录（免费优先），mcpConsumption=mcp-servers
- `tests/adapter-smoke.mjs` + `tests/fake-cli.js`：25 项契约断言（全部通过）
- `opencode.zip`（10.6 KB，sha256 6df66260…）+ `update.json` + `README.md`
- `index.json`：新增 opencode 条目（v0.1.0，category=ai）

### 宿主（worktree `worktree-opencode-plugin-migration`）
- 删 `src-tauri/src/ai/engine/opencode.rs`（1672 行）
- `traits.rs`：删 `EngineId::OpenCode` 变体 + 12 处穷尽 match；`parse_any` 加 `open-code`/`opencode`/`open_code` → `Custom("opencode")` 别名映射（存量会话兼容）+ 4 个单测
- `launcher.rs` / `ai_chat_core.rs`：删 OpenCode 分支，Custom 分支承接（opencode Profile 豁免保留为 `Custom("opencode")` 判定）
- `engine_metadata.rs`：删 `get_opencode_models` + `OpencodeModel` + TTL 缓存（161 行）
- `lib.rs`（桌面 + web 两处注册点）/ `web/api/ipc.rs` / `commands/mod.rs`：删注册与分发
- 前端：`engineMetadataStore`（opencodeModels/loadOpencodeModels）、`SessionConfigSelector`（isOpencodeEngine 特化）、`AIEngineTab`（open-code 卡）、`engineDisplay`/`engineCapabilities`（fallback）、locales（openCode 文案）全部删除

### 保留（无关引擎 id，通用工具调用形态/渲染逻辑）
- `chatCardRegistry.ts` / `eventHandler.ts`：Code Mode 适配（opencode execute 载体，任何引擎走此形态均适用）
- `lightweightMarkdown.tsx` `hasOpenCodeBlock`（Markdown 代码块检测，非引擎）
- `streamRateTracker.ts` / `StreamRateBadge.tsx`（TPS 算法参考，非引擎绑定）
