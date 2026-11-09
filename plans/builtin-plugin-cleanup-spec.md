# 内置插件清理实施 spec

> 状态：已批准（用户 2026-11-09 定案 + 决策点 D1-D5 全部按推荐执行 + 追加：删除 TodoWriteRenderer）· 日期：2026-11-09
> 分析依据：`plans/builtin-plugin-cleanup-analysis.md`（6 路探索实测，锚点/边界判定以此为准）
> 实施分支：`feat/builtin-plugin-cleanup`（独立 worktree `D:/space/base/Polaris-cleanup`），完成后合并 `main` 并发布 v11.2.7（MSI+APK 走 CI 三工作流）。

## 目标

主仓 12 个内置插件收敛为 5 个（core/ask/browser/scheduler/contracts）：
- **移除 4**：`polaris.todo`（含 cap.todo 能力、TodoWriteRenderer）、`polaris.requirements`（整域）、`polaris.agent-gallery`（仅壳）、`polaris.dispatch`（A+B 档）。
- **外移 3**：`polaris.agnes`（插件仓 v0.1.2 去 legacy 承接）、`polaris.personal-hub`（插件仓新建 stdio MCP + 自包含面板）、`polaris.computer`（主仓新增 `polaris-computer-mcp` 独立 bin，exe 随 zip 分发）。
- 外移插件一律 stdio MCP（禁 `contributes.services` http 常驻），不做任何历史数据/接口兼容。

## 决策点定案（按推荐）

- D1：polaris-bus 后端 registry 不动，前端声明随 todo 壳删除（接受设置页失去 bus 插件级开关）。
- D2：dispatch A 档删除，AI 失去 12 工具（含专家自助维护六件套、cap_dispatch 旁路），不迁移。
- D3：cap.todo 随删（AGENTS.md §三 cap 清单 28→27）。
- D4：computer 方案 a——主仓 `src-tauri` 新增独立 bin target，release exe 拷入插件仓 zip。
- D5：DispatchTaskCard + chatBlocks 接线随 A 档删除。
- 追加：TodoWriteRenderer（Claude Code 引擎 TodoWrite 工具渲染器）整体删除——新版 Claude Code 已无该工具。

## 边界（明确不做）

- 不删 `bus_mcp_server.rs`（宿主通用，bus_dispatch 放开 18+ cap）。
- 不删 `computer_control/` + `simple_ai/tools/computer.rs`（SimpleAI 引擎共用业务核）。
- 不删 `agent_corpus.rs`/`subagent.rs`/`agentStore.ts`/`agentSlashCommand.ts`/`agentCorpusService.ts` 的专家 CRUD 部分（Chat 主链路 + 引擎数据层）。
- 不删 `aiChatDispatch.ts`/`dispatchTaskService.ts`/`dispatchStore.ts`/`ask_listener.rs` 派发帧/`DispatchedTask` 注册表（/dispatch 与 /nexus 的执行链）。
- 不动 `web/api/ipc.rs` 的 agent_corpus 桥(:82-130)与 dispatch 桥(:72-81,:167-171)；只删 requirements 桥(:296-302,:1900-1918,:1961,:1966)。
- 不迁移旧数据、不留 shim/别名/旧配置兜底；`needs` 插件自包含无需桥接。

## 面板与配置（用户要求：外移插件尽量带面板/配置/存储管理）

- agnes：沿用外置 v0.1.1 面板 + configSchema（apiKey/apiBase/模型/尺寸）。
- personal-hub：新建自包含面板（登录/链接 CRUD/收藏管理）+ configSchema（supabase url/anon key/session token/encryption key）；数据存储在 Supabase（远端），面板经 cap.http 直调 REST。
- computer：无面板/配置/存储语义（系统级 AI 工具），README 声明仅 Windows。

## 验收

1. 主仓门槛全绿：`pnpm typecheck` / `pnpm lint` / `pnpm test:run` / `cargo check` / `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` / `cargo build --bin polaris-mcp`。
2. 残留 grep：7 个插件 id 与 `*_mcp_server` 符号在业务代码零命中（仅历史归档文档与保留域注释）。
3. 插件仓 `node scripts/validate.js` 通过；agnes/personal-hub/computer 三插件 pack + index.json/sha256/tag 齐；stdio server 本地 JSON-RPC 冒烟（真实 spawn + initialize/tools list）。
4. AGENTS.md §三 cap 清单、roadmap/core-slimdown 对账同步。
5. 合并 main → `chore: release v11.2.7` 四文件 bump → push tag → Release/APK/Web 三工作流通过，MSI+APK 资产产出。

## 实施批次（一次一主题 commit）

1. docs：分析报告+交接单+本 spec
2. 移除 polaris.todo + cap.todo + bus 联动 + 死代码
3. 移除 TodoWriteRenderer
4. 移除 polaris.requirements 整域
5. 移除 polaris.agent-gallery 壳
6. 移除 polaris.dispatch（A+B 档）
7. agnes 主仓摘除（外置承接）
8. personal-hub 主仓摘除（外置承接，插件仓另 commit）
9. 新增 polaris-computer-mcp bin
10. computer MCP server 面摘除
11. 文档/清单同步
12. 插件仓三插件发版（分仓 commit）
13. release v11.2.7
