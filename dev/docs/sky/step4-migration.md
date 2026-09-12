# Polaris 重构 · 第四步：闭环替换（持续迁移主文档）

> 状态：进行中 —— cap.todo（第一块）、cap.prompt_snippet（第二块）均已完整闭环（迁移 + 摘旧）
> 日期：2026-09-12（文档析出 + playbook 沉淀 + backlog）/ 2026-09-12（第二块实施）
> 原则：**一块块替换，不着急**。每块走完整周期：新能力上总线 → 前端切换 → 摘旧 → 复盘。
> 原 step3-dispatch.md 中的第四步实施记录与摘旧复盘已析出至本文档。

---

## ⏩ 第二块实施：cap.prompt_snippet（2026-09-12）

按 §2 playbook 七步完整走完：

- **能力**：`services/router/prompt_snippet_capability.rs` —— domain=`prompt_snippet`
  （`<DataRoot>/stores/prompt_snippet.db`），动作 list/get/create/update/delete；
  名称唯一校验对齐旧命令层 ValidationError 语义；写路径与域审计同库同事务
  （第五步阶段 D 模式，新能力直接按最终形态写）。
- **旧数据衔接**：`import_legacy_store` 一次性只读导入（domain 为空且旧
  `config/prompt-snippets.json` 存在才导入；旧文件原地保留可回退，导入后不再读取）。
- **摘旧（四层清单全过）**：删 `commands/prompt_snippet.rs` + `services/prompt_snippet_service.rs`
  （lib.rs 注册 ×5、commands/mod.rs、services/mod.rs 同步摘除）；Web 桥 ipc.rs 五个
  snippet 分支 + service 引用摘除（① 代码标识 grep 零残留：`snippet_list` 等 5 个命令名
  仅剩 ipc.rs 顶部注释示例）；② 无持久化 MCP 配置残留（snippet 从未入 mcp.json）；
  ③ 前端 `schedulerService.ts` 五个方法全部改走 `router_dispatch("cap.prompt_snippet")`，
  设置页 PromptSnippetTab + ChatInput 消费方零改动经 service 透明切换（③ 用户可见性经
  9827 Web 实测验证）；④ AI 工具消费方核查：snippet 无 AI 工具注册，无死代码前提。
- **验证**：`cargo check` 三重全绿；独立 crate `sky-verify` 80 passed
  （cap.prompt_snippet 10 个单测：CRUD 往返/排序/重名拒绝/部分更新/删除语义/域审计/
  旧 JSON 导入/缺文件 no-op）；HTTP 实测 create→dup 拒绝→list→delete 全链路 ok。

### 附带修复：cap.todo status 流转既有 bug

第五步验证时发现 HEAD 上 `update_completed_at_semantics` 测试实际失败
（`apply_updates` 从未应用 `status` 字段；`update_timestamps` 从不置位 completed_at，
与其注释声称的语义不符——第三步文档声称的"55 passed"未覆盖此测试）。
已修复：update 状态流转生效 + completed_at 按语义置位/清空，verify crate 全绿。

### cap.kv 去留裁决落地

采纳 §5 建议方案 B：cap.kv 定性为 demo 能力，契约测试台能力列表已加 "demo" 徽标
（`cap.kv`/`cap.echo`/`cap.faulty`）。不为它硬找消费方。

---

## 0. 承接与已完成块

第四步的定义：把旧命令层（382 个 `#[tauri::command]`）按业务域一块块搬上 dispatch，
cap.X 成为该域的唯一入口，然后摘掉旧通道。已完成：

| 块 | 内容 | 记录 |
|---|---|---|
| P2 | 第一个真实能力 cap.kv 接线 SqliteStorage | step3-dispatch.md |
| P3 | 面板阶段 C：已注册能力列表 + dispatch 测试台 | step3-dispatch.md |
| P4 | cap.todo 完整闭环：迁移 + 摘旧（`418dbc53` / `e78b3726`） | 本文 §2 / §3 |
| 第二块 | cap.prompt_snippet 完整闭环：迁移 + 摘旧 + 旧 JSON 一次性导入 | 本文 ⏩ 实施进展 |

摘旧复盘（可见性漏项 / 持久化 MCP 配置 / 死代码）见本文 §3 —— **复盘结论已反哺进 §2 的 playbook**。

---

## 1. 关键判断

1. **迁移模式已被 cap.todo 验证**，且成本可控：一个中等规模域（8 个动作 + 11 个单测）
   的迁移+摘旧在一次会话内可完成。瓶颈不在写能力，而在**摘旧的验证完整性**（见 §3 教训）。
2. **下一批不必追求数量，先挑"同构 + 低风险"的域再挑"权限敏感"的域**。
   cap.todo 证明了 CRUD 型域能直接套模板；而 config 类管理面域要等第五步权限策略
   （step5-permission-audit.md）落地后再迁，否则 Remote 全放行的问题会被搬上总线。
3. **cap.kv 目前零真实消费方**（全库搜 `cap.kv` 仅命中 ContractExplorerPanel 测试台与
   Rust 侧定义）。它的历史使命（P2 验证 dispatch→SqliteStorage 链路）已完成，
   应裁决去留而不是默认留着（见 §5）。

---

## 2. 迁移 playbook（从 cap.todo 沉淀，后续每块照此执行）

### 2.1 迁移七步

1. **定动作协议**：对照旧命令层列出动作集（cap.todo 是 list/get/create/update/delete/
   start/complete/breakdown），payload/Reply 形态一次定稿，不留半套。
2. **写 `services/router/X_capability.rs`**：经 `ctx.storage()` 读写 SqliteStorage
   （domain=X，数据落 `<DataRoot>/stores/X.db`），单测覆盖过滤/limit/状态流转/动作错误。
3. **独立 crate 实测**：复制 contracts+sqlite+router 到 `/tmp/X-verify` 实际跑单测
   （绕开 Tauri DLL `0xc0000139` 限制），加端到端 main 走全链路。
4. **注册**：`state.rs` `create_app_state` 里 `register_handle`。
5. **前端切换**：对应 service 全部方法改走 `router_dispatch("cap.X", ...)`，UI 不动。
6. **三重编译验证**：`cargo check --lib` / `--tests` / `--no-default-features --bin
   polaris-web` 全绿 + `tsc --noEmit` 相关文件 0 error。
7. **摘旧**（见 §2.2 清单 v2）→ 提交 → **24h 内回访一次用户可见行为**（§3 教训）。

### 2.2 摘旧验证清单 v2（cap.todo 复盘后升级）

摘旧的验证必须覆盖四层，缺一不可：

| 层 | 检查 | cap.todo 的教训 |
|---|---|---|
| ① 代码标识 | `grep` 旧命令名/常量/服务名零残留 | 已覆盖，无遗漏 |
| ② 持久化配置 | 已落盘的 mcp.json / config 副本是否残留指向已删二进制的条目 | 漏了：3 份历史 mcp.json 残留 `polaris-todo`（§3.2） |
| ③ 用户可见性 | 相关面板/入口在两种插件状态下都实际出现/消失 | 漏了：面板从未打开验证（§3.1） |
| ④ AI 工具消费方 | AI 工具名是否有真实 execute 调用链（死代码要先删再下结论） | 前提就错了：todoTools.ts 从未被调用（§3.3） |

---

## 3. 摘旧复盘（2026-09-12，自 step3-dispatch.md §7 析出）

`e78b3726` 摘掉 todo 旧通道后，实测发现两个漏项。**教训：摘旧的验证清单只覆盖了"代码标识是否残留"，没有覆盖"用户可见性是否仍然成立"。**

### 3.1 漏项 A：前端面板可见性从未验证

`src/plugins/todo/manifest.ts` 声明 `enabledByDefault: false` + `deprecated: true`。
`src/plugin-system/registry.ts` 的 `listViewContributions` 第一行按 `enabledByDefault` 硬过滤
（`:247`），而 `listPlugins()` 不过滤。所有 activityBar 入口（`App.tsx` hasLeftPanel、
`toolSwitcherData.tsx` 工具切换器、`RadialMenu.tsx`）都依赖前者。

**两层门不等价**：第一层按静态声明 `enabledByDefault`，第二层
`isPluginUiEnabled`（`pluginStore.ts:63-66`）按运行时 `pluginStates`（无记录回退全 true）。
结果：插件设置页能看到「待办」、能勾选开关、状态能写进 state.json，
但**对 activityBar 完全无效**——开启状态为 true，面板仍不出。

受影响插件共 3 个：`polaris.todo`、`polaris.requirement`、`polaris.agnes`，
共同症状一致。`polaris.todo` 已修复（改 `enabledByDefault: true`、去 `deprecated`）；
另两个仍处 `false + deprecated`，需要独立裁决（面板是否保留）。

**通用问题**：`listViewContributions` 以 `enabledByDefault` 做硬过滤，
与消费方的 `isPluginUiEnabled` 重复且不等价，且同样的硬过滤还存在于
`listChatCardContributions`（`:271`）/ `listToolProviderContributions`（`:289`）/
`listStyleContributions`（`:325`）——影响面是所有插件的四类贡献。

→ 修法已独立成篇：**[plans/plugin-visibility-plan.md](../../plans/plugin-visibility-plan.md)**，
不夹在迁移块里做。

### 3.2 漏项 B：持久化 MCP 配置未清

摘旧删了 `services/todo_mcp_server.rs` 与代码里的声明，但没清持久化 mcp.json。
3 份历史副本残留 `polaris-todo`，指向已不存在的
`src-tauri/target/debug/polaris-todo-mcp.exe`（该二进制从未再编译）。

**关键判断：这是无害残留，不是活跃故障。** 核实 `mcp_config_service.rs`：
- `prepare_workspace_config_with_disabled` 是**整文件覆盖写**
  （`ClaudeMcpConfig` 全新构造 + `write_json_atomically`），**不读旧文件不合并**；
- 单测断言旧内容被清空（`json["mcpServers"].len() == 0`）；
- 唯一调用方是 `ai/launcher.rs` 的 `prepare_workspace_config_with_disabled(params.work_dir, ...)`；
- 4 份历史副本 mtime 均早于 9/11 摘旧日（最新 8/27），摘旧后零回写；
- 当前实际写入的工作区 `.polaris/claude/mcp.json` 摘旧次日凌晨被覆盖写，8 个 server，无 todo。

指向不存在的 exe 只会产生 MCP 连接失败噪音，不会注册出工具。已清理 3 份副本并留
`.bak-polaris-todo` 备份。→ 已反哺进 §2.2 清单第 ② 层。

### 3.3 附带发现：`ai-runtime/tools/todoTools.ts` 是死代码

`tool-bootstrap.ts` 在启动时把 7 个 todo 工具注册进 `globalToolRegistry`
（`useAppInit.ts` → `bootstrapTools()`），但 `globalToolRegistry` 全库只有 3 个引用点，
全在 `tool-bootstrap.ts` 内（register / listNames / re-export）。**无 execute / get / has
调用方**——`tool-registry.ts` 的 `execute` 只有自身定义。这套工具从未被 AI 调用过。

已删除 `src/ai-runtime/tools/todoTools.ts`、`src/core/tool-bootstrap.ts` 及其 3 处接线。
`tool-registry.ts` 本身已无生产调用方（仅剩测试与 index.ts 导出），属更大范围的
ai-runtime 清理，本次未动（记入 backlog，见 §6）。

**用户感知的「AI 调用 todo 工具」实为引擎内置 `TodoWrite`**（默认引擎 claude-code），
是 AI 给自己写任务清单的规划工具，前端有独立渲染链
（`chatBlocks/TodoWriteRenderer.tsx`、`helpers.ts` `isTodoWriteTool`）。
与 cap.todo / simpleTodoService / 待办面板零关系，摘旧前后行为不变。

---

## 4. 第二批迁移候选 backlog（2026-09-12 摸底定稿）

按"同构度 / 风险 / 前置依赖"排序。规模与命令数经代码摸底核实（2026-09-12）。

| 序 | 候选 | 旧命令层 | 命令数 | 前端消费方 | 排序理由 / 前置 |
|---|---|---|---|---|---|
| 1 | **cap.prompt_snippet** | `commands/prompt_snippet.rs` + `services/tauri/schedulerService.ts:349-372` | 5（完整 CRUD） | `Settings/tabs/PromptSnippetTab.tsx`、`ChatInput.tsx`（插入菜单） | 与 cap.todo 同构度最高、规模最小；消费方清晰。**下一块首选** |
| 2 | **cap.requirement** | `services/requirementService.ts` | 7 | `RequirementPanel.tsx`、requirementStore | 与 polaris.requirement 插件去留裁决联动（§插件可见性计划）；裁决保留则迁 |
| 3 | **cap.history** | `services/historyService.ts` | 5 | SessionTree / SessionHistoryPanel 等 4 处 | 只读+删除为主，低风险 |
| 4 | **cap.context** | `services/tauri/contextService.ts` | 9 | contextStore（AI 上下文注入链） | upsert/query 语义与 Storage 契约贴合 |
| 5 | **cap.config** | `services/tauri/configService.ts` | 15 | SettingsPage、useAppInit、MobileConnectionGate | **管理面域**：✅ 前置已解锁（第五步阶段 C PolicyPermission 已落地），**下一迁移块首选**——作为第一个权限敏感迁移样本，迁完即具备启用 `cap.config* remote deny` 规则的条件 |
| 6 | **cap.dialog** | `services/dialogStorage/dialogBackend.ts` | 8 | 会话持久化全链 | 高价值高风险（聊天数据），建议攒到模板熟练后 |
| — | cap.scheduler / cap.browser / cap.lsp / cap.integration | 48 / 39 / 16 / 20 命令 | — | — | 大域，等小域把模板与权限地基磨稳后批量做 |

> 注：polaris_mcp 内置 server 现为 9 个（`requirements, prd-preview, agnes, ph, computer,
> scheduler, ask, browser, dispatch`，`bin/polaris_mcp.rs`），与插件清单的映射在
> `mcp_config_service.rs:12-28`。迁移某域时同步检查其 MCP server 是否随旧命令层摘除。

---

## 5. 开放裁决：cap.kv 去留

- 现状：零真实消费方，唯一调用方是契约测试台（可手输 target）。
- **建议**：降级定性为 demo 能力（与 cap.echo 同列），在测试台的能力列表里标注
  "演示"；**不再**为它硬找消费方。后续真实 KV 需求出现时（如前端 kv 型 store 落库），
  再按 §2 playbook 升格为真实能力。
- 反对方案（找消费方强迁，如 marqueeStore / plugin state）：收益低、
  且这两个各有更合适的归属，不为凑数而迁。

---

## 6. 边界（做/不做）

- ✅ 本文档只做规划与 playbook 沉淀；每块迁移动工前按 §2 走
- ❌ 不在本步内做插件可见性修复（独立计划：plans/plugin-visibility-plan.md）
- ❌ 不在权限策略落地前迁移 config 类管理面域
- ❌ `tool-registry.ts` / ai-runtime 更大范围清理不夹在迁移块做（独立 backlog）

## 7. 验收标准（对每个迁移块）

1. §2.1 七步全走完，三重编译 + 独立 crate 单测全绿
2. §2.2 四层摘旧清单全过（含 24h 用户可见性回访）
3. cap.X 成为该域唯一入口，`grep` 四层零残留
4. 旧命令层 / MCP server / 前端旧 service 同步摘除，不留双通道
