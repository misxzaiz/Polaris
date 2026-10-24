# AGENTS.md — Polaris 协作行为规范

> 本文档是给 **coding agent（含 Claude / 其他 AI 助手）与人类协作者** 的行为宪法。
> 目的在于把 Polaris 的架构治理（cap 总线、session-v2、数据根、插件边界）变成**可执行的门槛与约定**，而非靠记忆或口头约定。
> 来源：对照 `temp/ZCode`（AI 编程工作台 monorepo）工程治理体系提炼，结合 Polaris 实际结构改写。
> 修改任何业务流程、状态模型、跨进程协议前，**先读本文件**。

---

## 〇、分支约定（唯一权威，先于一切）

- **主分支：`main`** —— 唯一的开发 / 提交 / 推送 / 合并目标。所有 coding agent 与协作者默认在 `main` 上工作。
- **`master` 已废弃并删除**（2026-10-21 清理，见 `AGENTS.md` 本节点）。仓库内不再存在 master 分支。
- 新建功能分支一律从 `main` 切出：`git checkout -b feat/xxx main`。
- **禁止**创建、切换、提交、推送任何名为 `master` 的分支或 ref；若工具/AI 检测到 `master` 引用，一律视作歧义错误，改用 `main`。
- 合并目标统一为 `main`；远程 `origin/HEAD` 指向 `refs/heads/main`。
- 历史备份：原 master 内容保留在 tag `backup/master-20261021-32d958f3`（只读，勿删勿推）。

---

## 一、命令与仓库结构（必须真实可执行）

以下命令从仓库根目录执行；改动任何前端/后端行为后，**按需运行**对应验证，不得跳过：

| 用途 | 命令 | 备注 |
|---|---|---|
| 前端开发 | `pnpm dev` | Vite + HMR |
| **Web / 桌面开发（默认）** | `pnpm tauri:dev:web` | 前端 9827、后端 9829；vite proxy 代理 `/api` |
| 桌面 Tauri 开发 | `pnpm tauri:dev` | |
| 类型检查（**前端门槛**） | `pnpm typecheck` | 即 `tsc --noEmit`；CI `build-check` 会跑；本地改动后自行跑 |
| 前端测试 | `pnpm test:run`（一次）/ `pnpm test`（watch） | 118 个 vitest 文件，`src/` 下 |
| Lint | `pnpm lint` / `pnpm lint:fix` | eslint + typescript-eslint |
| 安全审计 | `pnpm security:audit` | audit-ci |
| **Rust 静态检查（后端门槛）** | `cargo check` | 本机 **不可** `cargo test --lib`（Tauri DLL 启动问题），**用 `cargo check` 代替** |
| **Rust Clippy** | `cargo clippy --lib` | 存量 warning 治理中；新代码按 clippy 建议编写（见「Clippy 治理」节） |
| Rust Web-only 门控检查 | `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` | 发布前必须跑；见「命令门控」节 |
| 测试包隔离构建 | `pnpm tauri:build:test` | 产 MSI，隔离数据根 `%APPDATA%\Polaris-dev` |

> **CI 现状**：`ci.yml` 已有 commitlint / security / lint / test / build-check（含 `pnpm typecheck`）。
> **本地已落地**（对照 ZG）：`typecheck` script（2026-10-10）。
> **本地缺**（对照 ZG）：`clippy`/`knip`/`husky` 脚本门槛——`clippy` 存量 warning 治理见「Clippy 治理」节；`knip`/`husky` 是后续工作项。

---

## 二、核心原则（先立规范，再写代码）

1. **改动前先确认现状**。定位/修改用已有符号，先**读源码与对应测试**，确认结构后再动手，不臆造接口。
2. **唯一权威，禁止多写路径**。每个状态/数据有一明确所有者与写入路径；明确**依赖方向、事件顺序、幂等边界**；**绝不用超时掩盖同步问题**。
3. **改动后必须验证并报告真实结果**。执行 `tsc --noEmit`（前端）或 `cargo check`（后端）；**不把已有失败写成通过**；实验/环境受限时如实说明。
4. **spec / 方案优先**。涉及行为、状态、协议、UI 的改动，**先在 `plans/` 补简短 spec**（目标、所有者、接口、验收），再实现。（现有 `plans/` 已有 26 个方案文档可参考。）
5. **修复 bug 说明原因**。用中文注释说明根因与修复依据；发现设计缺陷先对齐，不盲目加兜底分支。
6. **涉及异步/多端/时序的方案用图**。画出所有者与事件顺序（可文字图），避免隐式时序假设。

---

## 三、分层与边界（架构约束）

### 3.1 前端（`src/`）
- **store** 集中在 `src/stores/`（56 个，Zustand）；会话状态走 `src/stores/conversationStore/` 与 `src/session-v2/`（Reconcile 对账：**日志即真相，前端只是缓存**）。
- **hooks** 集中在 `src/hooks/`；**优先通过 hooks 访问 service/store**，组件不直连 store 内部实现。
- **service 层**：业务逻辑放 `src/services/`。迁移样板：以 `src/services/dataRootService.ts` 为准——**业务签名不变、内部改走 RouterBus**（`router_dispatch`），获得统一权限 gate + 审计。
- **AI 运行时**：`src/ai-runtime/`、`src/engines/`。引擎选择/模型供应商逻辑若跨端复用，收敛到单一服务（参照 ZCode `provider` 单权威的治理思路）。
- 组件/UI 改动遵循 **`DESIGN.md`**（若已创建）与主题 token（`.polaris-theme` / 7 层 88 维度体系）。**禁止硬编码颜色、字号**；用主题 token 与既有刻度。

### 3.2 后端（`src-tauri/src/`）
- 目录划分：
  - `commands/`（40 个 tauri command，多为旧路径）
  - `services/`（业务核：ai_chat_core、ask_listener、plugin_service 等）
  - `models/`（AIEvent 等跨进程协议类型）
  - `services/router/`（**RouterBus —— cap 总线**）
- **cap 总线是统一权限/审计通道**。已装配能力（`router/` 目录，共 26 个，2026-10-25 实测对齐）：`cap.ai.chat`（流式 + form 动作）、`cap.bash`、`cap.todo`、`cap.http`、`cap.fs`、`cap.data_root`、`cap.config`、`cap.context`、`cap.history`、`cap.hook`、`cap.kv`、`cap.mcp`、`cap.voice`、`cap.registry`、`cap.help`、`cap.stream.echo`（流式骨架）、`cap.prompt_snippet`、`cap.pluginDiscovery`、`cap.pluginServiceManager`、`cap.ui.render`（含 DSL 模板 + chart 图表节点）、`cap.ui.theme`、`cap.ui.chat`、`cap.ui.input`、`cap.self.inspect`、`cap.self.mutate`、`cap.git`（feature 门控）。**新增能力须同步本清单与 `plans/two-bus-architecture.md`**。
- **迁移方向**：高频命令应从 `commands/` 迁上 RouterBus，每迁一个砍一个旧命令；以 `dataRootService.ts` 前端样板 + `router/` 内 capability 实现为范式。

### 3.3 数据根与隔离
- **数据根单点**：路径解析统一走 `services/data_root.rs`（DataRoot 抽象）。**禁止散落硬编码路径**。
- **dev/test 隔离**：`POLARIS_DATA_ROOT` env 覆盖数据根（env > anchor > 默认）；`tauri:dev:web` 注入 `Polaris-dev`；`tauri:build:test` 产隔离 MSI。**改路径前先读 `data_root.rs` 与 `Cargo.toml` features。**

### 3.4 命令门控（Rust feature 陷阱，双方向）
- Tauri 命令有条件编译（`tauri-app` / `git` / `lsp-index` 等 feature）。
- **两个方向都会挂**：① 命令漏 gate（Web-only 构建仍引用 Tauri 类型）；② 辅助函数引用被门控的导入（`--no-default-features` 构建挂）。
- **发布前必跑**：`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`。改动命令层时同步检查 gate。

---

## 四、跨进程协议与状态

### 4.1 协议类型
- AIEvent / Task 等前后端共享类型：Rust 在 `src-tauri/src/models/ai_event.rs`，前端在 `src/types/`（camelCase 对齐）。
- **改协议 = 双向同步**：Rust 类型 + 前端类型 +（如涉及）序列化/校验。**无运行时 schema 校验是已知缺口**——改协议时务必保守，至少保持关键枚举与必填字段不漂移。

### 4.2 中断与幂等（对照 ZCode 的护栏意识）
- AI 引擎中断链路在 `services/ai_engine.rs`、`engines/`。**已知风险**（对接记忆 `ai-chat-interrupt-continue-root-cause`、`simpleai-interrupt-bug-confirmed`）：晚到 stop / 中断不被消费 / 误杀无关运行。
- 涉及 stop/interrupt 的改动，**保留幂等与顺序语义**：提交/中断的调用方与处理方必须有明确归属，不因超时或重试产生双写或误杀。

### 4.3 会话与存储
- 会话存储：`src/session-v2/`（Reconcile 对账）、`src/services/dialogStorage`（JSONL）、`src/stores/conversationStore/`。
- **写入路径收敛**：避免多条写路径竞争；广播/同步事件**尽量携带并分类 reason**，避免高频写触发整表刷新。

---

## 五、插件与扩展边界

- 插件是独立进程 / WASM 组件，通过 cap 总线与 MCP 交互；**核心可替换、一切皆插件**。
- 修改 `cap.*` 契约时，**同步**：
  - 后端 capability 实现（`router/`）
  - 前端 service（如有）
  - 插件仓库（`D:\space\base\Polaris-plugin`）的对应适配（如涉及）
- 插件图标取白名单 17 值（`contributes.views[].icon`），FileText 等非白名单会被拒。插件 UI 有「静态 enabledByDefault + 设置开关」两层门，状态 true ≠ 面板可见。
- MCP list 接口 schema 改动后，**须重新构建独立 bin**：`cargo build --bin polaris-mcp`（`ask_mcp_server.rs` 等），否则 AI 看到旧 schema（记忆 `polaris-mcp-schema-exe-staleness`）。

---

## 六、日志

- 用 `src-tauri/src/services/logger.rs` + 前端 `src/utils/logger`（如存在），**不使用裸 `console.log` / `eprintln!` 承载业务关键路径**。
- 分级约定（对照 ZCode `createServiceLogger`）：`debug` 用于高频诊断；**生产不落盘**；`warn`/`error` 落盘并含定位信息；RPC 数据流（stdio 等）**日志走 stderr，stdout 仅用于协议数据**。

---

## 七、验证与提交清单

### 改动前
- [ ] 读目标文件与对应测试
- [ ] 行为/协议/UI 改动 → 先补 spec 到 `plans/`（简短即可）
- [ ] 涉及 cap 契约 → 确认后端 + 前端 + 插件三处同步

### 改动后（本地验证）
- [ ] 前端：`pnpm exec tsc --noEmit` + `pnpm lint`
- [ ] 后端：`cargo check`
- [ ] 若动命令层/协议：`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`
- [ ] 若动 MCP schema：`cargo build --bin polaris-mcp`
- [ ] 有测试就更新/新增测试（前端 vitest / 后端已存在的测试），并**实际执行**验证

### 提交
- [ ] 一次改动一个主题；提交信息遵循 `commitlint.config.mjs`
- [ ] 不把「未完成」「环境受限」写成「已完成」；如实报告

---

## 八、Clippy 治理（2026-10-10 起步）

- **现状**：存量 warning ~55（cargo check）+ ~274（clippy 全量，含 doc 格式类 62）。**已修复** 5 个 clippy error（`absurd_extreme_comparisons`，`MAX_INLINE_DIFF_BYTES=usize::MAX` 恒假比较，`services/git/diff.rs` 删比较保二进制判断，行为等价）。
- **策略**：分阶段收紧，不冒进删代码。
  1. 机械类（doc 格式 / 冗余闭包 / needless deref / map_or 等）→ `cargo clippy --fix` 自动修。
  2. 死代码类（`never used` / `never constructed`，多为预留 API / 测试辅助 / 插件契约）→ **不删**，模块级 `#![allow(dead_code)]` 兜底或保持 warning。
  3. 设计类（`too_many_arguments` 13 处）→ 逐个评估；存量可加 `#[allow(clippy::too_many_arguments)]`，新代码避免。
- **门槛形态**：CI clippy job 用 `-D warnings -A dead_code`（死代码豁免、其余阻塞）。存量 warning 清到接近零后收紧。
- **新增代码纪律**：新 Rust 代码按 clippy 默认 lint 编写（`cargo clippy --lib` 无新增 warning）。

---

## 九、已知边界（如实交代，避免踩坑）

- **本机 `cargo test --lib` 不可用**（Tauri DLL 启动限制），测试验证用 `cargo check` + 已有前端 vitest 代替。
- **`src-tauri/src/commands/` 是旧路径 + 迁移中**；新增功能优先走 RouterBus。
- **巨型文件**（>1800 行，10 个）：`commands/browser.rs`(3977)、`web/api/ipc.rs`(2686)、`services/ai_chat_core.rs`(2547)、`stores/conversationStore/createConversationStore.ts`(2535)、`services/ask_listener.rs`(2384)、`services/plugin_service.rs`(2046)、`components/Chat/input/ChatInput.tsx`(2010)、`services/mcp_config_service.rs`(1893)、`integrations/manager.rs`(1881)、`models/ai_event.rs`(1868)。**拆分须克制**：在没有架构门槛的情况下，只拆「新增改动经常触碰」的文件，不做无收益的大规模重构。
- **协议无运行时 schema 校验**是已知缺口；改动协议时以「保持双边类型同步」为最低纪律。