# 内置插件清理实施提示词（交付给实施 agent）

> 状态：待实施 · 日期：2026-11-09
> 用途：可整份复制交给另一个 coding agent 执行。
> 来源：用户定案——移除内置插件 2/3/7/9，外移 4/5/6 到 `Polaris-plugin`；外移插件一律 stdio、不做历史数据兼容。
> 说明：本文件是「提示词/交接单」，不是 spec；实施前仍按 `AGENTS.md` §七 在 `plans/` 补简短 spec。

---

# 任务：Polaris 内置插件清理（移除 4 项 / 外移 3 项）

## 0. 环境与必读

两个仓库，同级：
- 主仓 `D:\space\base\Polaris`（本次主要改动）
- 插件仓 `D:\space\base\Polaris-plugin`（插件市场，外移目标）

**动手前先读**：
- 主仓 `AGENTS.md`：§〇 分支（唯一 `main`，禁止 `master`）、§三 cap 清单、§五 插件边界、§七 验证与提交清单（"行为/协议/UI 改动先补 spec 到 `plans/`"）、§八 Clippy 纪律
- 主仓 `plugins/docs/prd-preview-extraction-playbook.md` §5 主仓移除清单、§6 八步外移手册、§8 防膨胀规则（注意该文件头部标注为历史归档，但上述三节仍有效）
- 主仓 `plugins/docs/host-slimming-incremental-roadmap.md` 的「双轨清扫」段、`plans/core-slimdown-plugin-extraction-plan.md` §4.1（拆分批次与行数基线）
- 插件仓 `README.md`、`docs/SPEC.md`（plugin.json 规范）、`docs/PUBLISHING.md`（上架流程与 CDN URL 策略）、`docs/plugin-development-guide.md`

**编号映射**（来自当前 12 个内置插件清单，`src/plugin-system/builtinPlugins.ts` 的 `registerBuiltinPlugins()` 为唯一权威）：

| 编号 | id | 动作 |
|---|---|---|
| 2 | `polaris.todo` 待办 | **移除** |
| 3 | `polaris.requirements` 需求库 | **移除** |
| 7 | `polaris.agent-gallery` 专家画廊 | **移除** |
| 9 | `polaris.dispatch` 任务派发 | **移除** |
| 4 | `polaris.computer` 电脑操作 | **外移**到 Polaris-plugin |
| 5 | `polaris.personal-hub` 个人空间 | **外移**到 Polaris-plugin |
| 6 | `polaris.agnes` Agnes 多模态 | **外移**到 Polaris-plugin |

## 1. 用户定案的硬约束

1. 外移的 3 个插件一律走 **MCP stdio**：`contributes.mcpServers[].transport = "stdio"`，`command: "node"` + `argsTemplate: ["{{pluginDir}}/mcp/server.js", ...]`。**禁止** `contributes.services` 的 http 常驻后台服务形态（参见插件仓 `plugins/needs` 的 http service，那是本次要避开的形态）；面板需要外部网络时走宿主 `cap.http` 转发（参考已上架 `plugins/agnes` v0.1.1 的做法），不要自己起 http 服务。注：`docs/SPEC.md` 明确 MCP transport「目前仅支持 stdio」，本约束与规范一致。
2. **不做任何历史数据 / 接口兼容**：不迁移旧数据、不保留旧 MCP server id 别名、不做旧配置读取兜底、不做影子并行双轨、不留向后兼容 shim、不兜底历史对话里的旧卡片与旧工具引用。可据此删掉外移实现里所有 legacy 分支（例如 agnes server.js 中 `agnes/config.json` 旧配置自动迁移逻辑）。
3. 一次一主题、单主题 commit；commit message 遵循 `commitlint.config.mjs`。整项任务建议先在 `plans/` 补一份简短 spec（目标/边界/验收）再实现。
4. 如实报告验证结果，不把失败写成通过；实验/环境受限时明确说明。

## 2. 第 0 步：边界判定（必做，先产出报告再动手）

**这是本任务最大的风险点**：下列符号并非插件专属代码，误删会破坏宿主。先用 `grep` 列出每个符号的**全部消费者**，区分【功能专属】与【宿主通用】，把结论写进报告：

- `cap.todo` / `src-tauri/src/services/router/todo_capability.rs`：是 `AGENTS.md` §三 28 个 cap 之一，被 `src/services/uiDispatchService.ts:293` 白名单、`capSlashCommand.ts`、`contextBlockRegistry`、多个 `*.test.ts` 引用。
- `bus_mcp_server` / `polaris-bus`：todo 插件 manifest 声明的 MCP server，但它把 cap 总线能力暴露给 AI，可能不只服务 todo —— 是否随 todo 一并删除须按本节判定。
- dispatch 的 `src/services/dispatchTaskService.ts`、`aiChatDispatch.ts`、`dispatchStore.ts`、`session-v2/kernel/*`、`conversationStore/*`、`SchedulerPanel.tsx` 等 20+ 处引用 —— 属会话后台派发基础设施，不是插件壳本身。
- agent-gallery 的 `src-tauri/src/commands/agent_corpus.rs`、`src-tauri/src/capabilities/subagent.rs`、`src/stores/agentStore.ts`、`src/services/agentSlashCommand.ts` 可能属 AI 引擎通用专家能力。

判定规则：
- 通用能力若存在其它核心消费者 → **保留能力**，只删功能专属层（面板/壳/MCP server/专属 service），并同步 `AGENTS.md` §三 cap 清单与 `plans/two-bus-architecture.md`。
- 确认无任何消费者 → 才整域删除。
- 禁止臆断，一律以 grep 实测为准；报告中列出 grep 命令与结果。
- 同理，`polaris.requirements` 被移除后由插件仓已有的 `needs` 插件承接，主仓不留桥接。

## 3. 通用删除锚点（7 个插件都适用，逐项按 grep 实测补全）

主仓：

1. **前端壳与注册**：`src/plugins/<x>/` 整目录；`src/plugin-system/builtinPlugins.ts` 中对应 import、`pluginRegistry.register(...)`、`pluginPanelRegistry.register(...)`（仅 agentGallery / personalHub / agnes 三项）、`chatCardRegistry.registerBuiltin('polaris.agnes', ...)`（media-card，约 :168-177）。
2. **前端功能代码**：组件 / 服务 / store / types / hooks / locales。已知锚点：`src/components/TodoPanel/`、`src/components/RequirementPanel/`、`src/components/Agent/AgentGalleryPanel.tsx`、`src/components/PersonalHub/`、`src/components/Settings/tabs/PersonalHubTab.tsx`、`src/plugins/agnes/AgnesPanel.tsx` + `AgnesMediaCard.tsx` + `api.ts`、`src/components/Chat/dispatch/`、`src/services/simpleTodoService.ts`、`src/services/requirementService.ts`、`src/stores/requirementStore.ts`、`src/services/personalHub/*`、`src/types/{todo,requirement,agent}.ts`。
3. **`src/App.tsx`**：`SimpleTodoPanel` / `RequirementPanel` 的 lazy import（约 :49/:51）与 `todoContent` / `requirementContent` props（约 :319/:321）。
4. **侧栏入口**：`src/components/Layout/toolSwitcherData.tsx` 的 `case 'todo'` / `'requirement'` / `'personalHub'`；`ActivityBar`、`LeftPanel`、`viewStore` 中相关项。
5. **测试**：`src/plugin-system/mcp.test.ts`（断言含 `polaris.requirements` / `polaris.computer` 与 `[pluginId, serverName, command]` 表）、`src/stores/pluginStore.test.ts`（`polaris.todo` / `polaris.agnes`）、`registry*.test.ts`、`docs/mcp/2-roadmap.md` 中引用的 manifest 校验用例 —— 同步更新或删除。
6. **后端模块**：`src-tauri/src/services/mod.rs` 的 `pub mod`（已知 :32 `bus_mcp_server`、:33 `dispatch_mcp_server`、:40 `unified_requirement_repository`、:42 `requirements_mcp_server`、:50 `agnes_mcp_server`、:51-52 `personal_hub_*`、:58 `computer_control`、:60 `computer_mcp_server`）；对应 `services/*_mcp_server.rs`、`commands/requirement.rs`、`commands/agnes.rs`、`commands/agent_corpus.rs`、`commands/dispatch.rs`、`models/requirement.rs`、`models/todo.rs`。`bus_mcp_server` 的去留按 §2 判定。
7. **`mcp_config_service.rs`**：常量区（约 :12-29）、`builtin_plugin_mcp_manifests()`（:144-179）、`builtin_mcp_contribution_registry()`（:181-265）、`builtin_plugin_mcp_manifest_matches_registry` 测试（:1623）。注意前端 manifest 里写的 `command: polaris_*_mcp` 与真实打包不符——所有内置 MCP server 实际由 **`polaris-mcp` 单 bin 的子命令**提供，以后端 registry 为准。
8. **`src-tauri/src/bin/polaris_mcp.rs`**：`requirements` / `agnes` / `ph` / `computer` / `bus` / `dispatch` 子命令分支、顶部 `use` 导入、用法字符串（含 `parse_config_dir_args` 的 `get_default_config_dir` 等辅助函数是否仍被其它子命令使用，按实测决定去留）。
9. **其它硬编码**：`src-tauri/src/services/plugin_state_service.rs:71`、`plugin_events.rs:301` 中的 `polaris.todo`（测试用，按实测处理）。
10. **i18n**：`src/locales/{zh-CN,en-US}/todo.json`、`requirement.json` 及 `common.json` / `settings.json` / `chat.json` 中相关 key。
11. **文档同步**：`docs/mcp/4-manifest-schema.md`、`docs/personal-hub-mcp-server.md`、`plans/plugin-visibility-plan.md` 等现状描述；历史归档文档只加「已失效」标注，不重写。`AGENTS.md` §三 cap 清单、§五 插件清单按判定结果同步。

**残留验收（每个 id 分别跑，要求业务代码零命中，仅允许历史归档文档保留）**：

```bash
grep -rn "polaris.todo\|polaris.requirements\|polaris.agent-gallery\|polaris.dispatch\|polaris.computer\|polaris.personal-hub\|polaris.agnes" src src-tauri/src
grep -rn "polaris-todo\|polaris-requirements\|polaris-computer\|polaris-agnes\|polaris-ph\|polaris-dispatch\|polaris-bus" src src-tauri/src
grep -rn "agnes_mcp_server\|personal_hub_mcp_server\|computer_mcp_server\|dispatch_mcp_server\|requirements_mcp_server\|agnes.rs\|agent_corpus" src-tauri/src
```

## 4. 外移 4 / 5 / 6 到 Polaris-plugin（三项各自独立闭环，禁止混批）

### 4.1 插件目录结构

```
plugins/<id>/
├── plugin.json          # 完整 manifest
├── mcp/server.js        # Node 零依赖 stdio JSON-RPC server
├── src/ + dist/panel.js # 面板（若有），esbuild/vite 打包
├── update.json          # 与最新 plugin.json 一致
├── <id>.zip             # 由 pack.js 生成
├── .pluginignore
└── README.md
```

`plugin.json` 骨架：

```jsonc
{
  "id": "<id>", "name": "...", "version": "1.0.0",
  "description": "...", "enabledByDefault": true,
  "contributes": {
    "views": [{ "id": "<x>.panel", "area": "activityBar", "panelType": "<x>", "icon": "...", "labelKey": "...", "labelDefault": "...", "order": 50 }],
    "panel": { "entry": "./dist/panel.js" },
    "mcpServers": [{ "id": "<server-id>", "transport": "stdio", "command": "node",
                     "argsTemplate": ["{{pluginDir}}/mcp/server.js", "{{appConfigDir}}", "{{workspacePath}}"] }],
    "chatCards": [{ "id": "...", "mcpServerId": "<server-id>", "tools": ["..."], "mode": "result", "entry": "./dist/..." }]
  },
  "permissions": { "appConfigRead": true, "appConfigWrite": true, "aiToolAccess": true },
  "origin": { "repository": "...", "homepage": "...", "updateUrl": "...", "downloadUrl": "..." }
}
```

要点：
- `chatCards[].mcpServerId` 必须指向**本插件自己声明**的 server（registry 会校验）。
- MCP 工具行为以主仓 Rust 实现为金标，逐条对齐工具名 / schema / 返回结构 / 错误语义；先跑一次现 server 抓真实 argv 与交互，再写 Node 版。
- 面板 bundle 必须**自包含**：插件模块加载器只重写 `react` / `react/jsx-runtime`，不能 import `@/...` 宿主内部模块；参考 `plugins/agnes/vite.config.ts`。
- `{{pluginDir}}` / `{{appConfigDir}}` / `{{workspacePath}}` 是 SPEC 允许的模板变量；`plugin.json` 与 `update.json` 的 `argsTemplate` 必须逐字一致（现有 agnes 两文件此处已 drift，顺手对齐）。

### 4.2 三项专门说明（按此顺序处理）

- **6 `polaris.agnes` — 不要重建**：插件仓 `plugins/agnes` v0.1.1 **已存在且已上架**（`index.json` 约 :373），stdio MCP + 面板 + media-card + configSchema 齐全。先逐项核对与主仓内置版（`src/plugins/agnes/` + `agnes_mcp_server.rs` + `commands/agnes.rs`）的工具与配置差异；补齐差异、按「不做历史兼容」删掉 server.js 中旧 `agnes/config.json` 迁移分支，然后**主仓只需删码**。若版本号有变化，同步 plugin.json / update.json / `index.json` 条目 / zip / sha256 / CDN tag。不要新建第二个 agnes 插件。
- **4 `polaris.computer` — 先评估可行性**：依赖 Windows UI Automation / 截图 / 鼠标键盘控制（主仓 `services/computer_control/` + `computer_mcp_server.rs`，`#[cfg(windows)]` 门控），Node 无法等价实现。**先产出方案再动手**，可选：(a) 随 zip 分发 Rust 编译的独立 exe，`command` 指向它（platform-specific，manifest 声明仅 Windows 可用）；(b) Node server.js 通过 PowerShell / .NET 调用系统能力；(c) 其它。禁止硬套 `node mcp/server.js` 导致功能缺失；Web / 非 Windows 端按「不可用」声明。
- **5 `polaris.personal-hub`**：Supabase 登录注册 + 字段级加密（主仓 `personal_hub_crypto.rs` + `src/services/personalHub/*` + `PersonalHubPanel.tsx`）。Node 侧用内建 `crypto` 重写等价加解密，面板能力全部经 stdio MCP 暴露；**不要起 http 常驻服务**。

### 4.3 上架流程（插件仓）

```bash
node scripts/pack.js plugins/<id>     # 校验 plugin.json + 打 zip + 输出 sha256
# 复制 plugin.json 为 update.json（内容一致，含最新 downloadUrl）
# 在 index.json 的 plugins[] 追加/更新一条：manifestUrl / downloadUrl / updateUrl / sha256 / permissions / readme
node scripts/validate.js              # 校验 index.json + 全部 plugin.json
```

CDN URL 策略严格按 `docs/PUBLISHING.md` §4：`updateUrl` / `manifestUrl` 用 `@main`，`downloadUrl` 用 `@vX.Y.Z` tag（**不要用 commit hash 做 updateUrl，不要用 @main 做 downloadUrl**）。

### 4.4 三处同步（每项外移必须同时完成）

主仓删码 + `builtinPlugins.ts` / `builtin_plugin_mcp_manifests` 注册表摘除；插件仓 `plugin.json` + `update.json` + `index.json`；`AGENTS.md` §五 与瘦身路线基线表（roadmap §4、core-slimdown §4.1 批次勾选）。

## 5. 验证门槛（AGENTS.md §七，必须真实执行并报告真实输出）

主仓：

```bash
pnpm typecheck
pnpm lint                       # 或 pnpm exec eslint <改动文件>
pnpm test:run                   # 相关 vitest（含 plugin-system / stores 测试）
cargo check
cargo check --no-default-features --bin polaris-web --bin polaris-mcp   # 删了 MCP 子命令/命令层，必跑
```

若 MCP schema 有变 → `cargo build --bin polaris-mcp`。残留 grep 见 §3。
插件仓：`node scripts/validate.js`；真宿主 dev-link / zip 安装冒烟 —— 安装 → 启用 → AI 对话能调到该插件工具 → 面板能开 → 禁用插件后工具消失（门控生效）；桌面 + Web 双端各验一次。

## 6. 交付物

- 分主题 commit（建议：移除 4 项可合并为一到两个 commit；外移三项各一 commit，插件仓对应 commit）。
- 报告内容：每个插件的「删除文件清单 + 行数 + §2 边界判定结论（通用能力保留/删除及 grep 依据）」；三个外移插件各自的 stdio 落地方案（computer 需含可行性评估结论）；门槛命令的**真实**输出；残留 grep 输出；插件仓上架条目与 sha256；`AGENTS.md` / `plans/` 同步情况。
- 如某项无法完成，明确列出已完成 / 未完成 / 阻塞原因，不要写成已完成。

## 7. 反模式（明令禁止）

- 留兼容 shim、影子并行、旧数据迁移、旧 server id 别名、旧配置读取兜底。
- 重建已存在的 `plugins/agnes` 外置插件。
- 复制宿主核心组件进插件 bundle，或为单个插件往宿主加通用桥。
- 把 `session-v2` / `conversationStore` 的会话派发基础设施当成 `polaris.dispatch` 插件一并删除。
- 误删 `cap.todo` / `bus_mcp_server` 等仍被其它核心消费者依赖的通用能力（须先过 §2）。
- 用 `contributes.services` 的 http 常驻服务替代 stdio MCP；面板自建 http 服务。
- 一次外移多项混批；删码前未冻结行为金标；把已有失败写成通过。
