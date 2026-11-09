# 主仓瘦身：存量功能插件化拆分方案（core-slimdown）

> 状态：**方案待评审，未实施** · 日期：2026-11-06
> 上游定案：`plans/plugin-first-slim-plan.md`（2026-10-30 用户定案「新功能一律插件化」）+ `AGENTS.md` §五功能路由原则。
> 本方案定位：把该定案从**增量纪律**推进到**存量迁移**——盘点主仓已有功能，判定哪些拆出为 `Polaris-plugin` 仓插件，给出分批路径、验收标准与不拆清单。
> 数据口径：行数为 2026-11-06 工作区实测（`wc -l`，前端含 .ts/.tsx）；改动热度为 `git log --since=2026-08-01` 文件触碰次数。

---

## 1. 背景与目标

**为什么做**：
- 主仓前后端合计约 25 万行，其中相当比例是「面向用户的功能域」（浏览器、调度器、语音电台、IM 集成……），与「宿主本体」（会话 + cap 总线 + 插件系统 + 数据根）混居一仓。
- 已有 12 个「内置插件壳」（`src/plugins/*/manifest.ts`，`polaris.*` 命名）：manifest 在插件系统注册，但 UI 仍在 `src/components/`、后端仍在 `commands/` + `services/`、MCP 以 trusted 内嵌形态由 `mcp_config_service.rs::builtin_plugin_mcp_manifests` 注册——**壳是插件的，身子是核心的**，双轨状态本身就是不规范。
- 功能迭代被迫随主程序发版；插件仓（130+ 插件）已有 `update.json` 热更新通道，功能外移后可独立发布。

**目标**：
1. 主仓功能域代码出仓（预计 ~50k 行，见 §4），主包、构建、评审面缩小。
2. 消灭「内置插件壳」双轨：要么真外移，要么显式归入核心清单。
3. 宿主边界清晰化：**Polaris 核心 = 会话 + AI 运行时 + cap 总线/权限/审计 + 插件系统 + 数据根 + 开发环境基础面板**，其余面向用户的功能皆插件。

**与 `plugin-first-slim-plan.md` 的关系（不冲突声明）**：
- 该计划的「核心冻结」指不做行为变更与新功能；本方案的每一批都是**存量迁移**（行为等价搬出），逐批独立 spec + 用户批准后执行，属于该计划框架内的「有明确产品收益的迁移」，不是运动式重构。
- 该计划「不拆巨型文件」指不做无收益的代码级拆分（createConversationStore 等）；本方案拆的是**产品功能边界**，两者正交。

---

## 2. 现状盘点

### 2.1 主仓体量与热度（拆分依据数据）

后端 Rust ~140k 行：`services/` 84k（router 20k、git 8.1k、proxy 5k、scheduler 3.2k、lsp_index 3.2k）、`ai/` 23k、`commands/` 14k、`models/` 7.6k、`web/` 7.2k、`integrations/` 7.1k。
前端 ~110k 行：`services/` 31.8k、`components/` ~60k（Chat 29.5k、GitPanel 15k、Settings 10.5k）、`ai-runtime/` 6.6k、`session-v2/` 5.7k、`plugin-system/` 4.7k。

近三个月改动热度 Top（功能域相关）：`components/Browser/BrowserPanel.tsx` 58 次、`commands/browser.rs` 44 次、`components/GitPanel/` 28+20 次、`tauri/browserService.ts` 20 次、`router/git_capability.rs` 20 次。**Browser 域是「最大 + 最热」的双料拆分候选**。

### 2.2 内置插件双轨现状

12 个 `polaris.*` 内置插件壳（browser / scheduler / todo / requirement / prd-preview / computer / personal-hub / agnes / agent-gallery / ask / dispatch / contracts）+ `corePluginManifest`（直接挂 files/git/browser/translate/terminal/developer/integration/aiConsole/radio-broadcast 九个核心面板）。内置插件面板经 `builtinPlugins.ts` 手动注册懒加载入口，MCP 经 `builtin_plugin_mcp_manifests()` 以 **trusted（跳过 aiToolAccess 检查）** 形态注入。

### 2.3 插件系统地基状态（拆分可行性）

已修复（2026-10 底，对照 `plans/plugin-cap-plugin-system-audit-2026-10-24.md`）：
- X2/X3 停止竞态 + 退出孤儿进程（`aba91319`）；
- P1 端口治理 + healthCheck 状态机 + 服务状态回推（`0ecf97e8`）。

仍缺（本方案 §6 地基项）：
- 插件面板 JS 与宿主同 window 零隔离，`__POLARIS_HOST_INVOKE__` 可调任意 command 无插件级白名单（审计 §2.6.3）——UI 外移的安全前提；
- manifest 校验只覆盖 2/11 贡献点块；
- Web 模式插件服务管理被 Remote deny（审计 X9）——影响外移后 Web 端功能等价。

---

## 3. 判定标准：核心 / 插件四问

| # | 问题 | 判「留核心」 | 判「拆插件」 |
|---|---|---|---|
| Q1 | **宿主性**：属于会话/总线/插件系统/数据根/权限审计/引擎运行时？ | 是 | 否 |
| Q2 | **边界性**：自带「面板 + MCP server + 自有存储」三件套，与 Chat/编辑器无深度交织？ | 否 | 是 |
| Q3 | **通道性**：依赖宿主的是公共通道（cap 总线 / MCP stdio / AskListener / `__POLARIS_HOST_INVOKE__`）还是内部接口（commands 直调、store 直连、editor 扩展点）？ | 依赖内部接口且改造代价高 | 只依赖公共通道 |
| Q4 | **收益**：改动热度（发布解耦收益）与体量（瘦身收益）？ | 低 | 高 |

补充纪律：Q3 不满足的功能**先 cap 化再拆**（对齐 AGENTS.md §3.2「高频命令迁 RouterBus」既有方向），不直接拆。

---

## 4. 拆分清单与批次

### 4.1 B1：已有插件壳的功能外移（技术路径成熟，优先）

顺序按「耦合低 → 耦合高、体量小 → 体量大」排列，**每项独立 spec、独立验收、可单独叫停**：

| 序 | 功能 | 主仓删除（约） | 插件仓新建 | 行数 | 耦合点与路径 |
|---|---|---|---|---|---|
| B1-1 | PRD 预览 | `prd_preview_mcp_server.rs` 557 + `plugins/prd-preview` 卡片 | prd-preview 插件（MCP stdio + chatCards） | ~1k | 纯 result 卡片，chatCards 契约现成 |
| ~~B1-2~~ | Agnes 多模态 | ✅ 已完成（2026-11-09 内置插件清理：主仓删码，插件仓 agnes v0.1.2 承接） | agnes 插件 | ~2.3k | 同上 |
| ~~B1-3~~ | Requirement | ✅ 已完成（2026-11-09：整域移除，needs 插件承接，主仓不留桥接） | — | ~3.6k | 定案改为直接移除 |
| ~~B1-4~~ | PersonalHub | ✅ 已完成（2026-11-09：插件仓 personal-hub v1.0.0 新建承接，stdio MCP + 面板） | personal-hub 插件 | ~2.5k | |
| ~~B1-5~~ | Computer 控制 | ✅ 已完成（2026-11-09：MCP server 面摘除，业务核 computer_control 保留给 SimpleAI 引擎；独立 bin polaris-computer-mcp 随插件 zip 分发） | computer 插件 | ~1.5k | 桌面专属能力，Web 端按不可用声明 |
| B1-6 | Scheduler | `scheduler/` 3229 + `commands/scheduler.rs` 1055 + `scheduler_daemon.rs` 550 + Scheduler 组件 4906 + `schedulerService.ts` 401 | scheduler 插件（插件仓 `sundial` 为同类先例；daemon 以 `contributes.services` 常驻进程形态落地） | ~10.1k | AI 执行任务经 cap 总线回调；sqlite 存储外迁 |
| B1-7 | Browser | `commands/browser.rs` 4049 + `browser_scripts.rs` 407 + `browser_mcp_server.rs` 977 + Browser 组件 2707 + `browserService.ts` 774 | browser 插件 | ~8.9k | **最难**：webview 实例属宿主（Tauri 桌面）。路径分两步：①核心保留薄 `cap.browser`（webview 控制原语，按 RouterBus 范式收编 commands/browser.rs）；②脚本库/自动化逻辑/面板/MCP 全部外移。TCB 圈选上下文块与 ChatInput 的联动改走 chatCards/contextBlock 公共机制 |

B1 合计 ~30k 行。外移后同步动作（每项相同，下称「三处同步」）：主仓删码 + `builtinPlugins.ts`/`builtin_plugin_mcp_manifests` 注册表摘除；插件仓新增（plugin.json + dist + update.json + marketplace `index.json`）；`AGENTS.md` §五 cap 清单如有增删同步更新。

### 4.2 B2：无壳独立功能域，新建插件

| 序 | 功能 | 主仓删除（约） | 行数 | 说明 |
|---|---|---|---|---|
| B2-1 | 语音电台 / 伴播 | `voice_capability.rs` 1229 + RadioBroadcast 组件 2044 + `voiceBroadcast` ~1.8k + `speechService` 683 + `ttsService` 617 + VoiceCompanion 476 + `streamingTts` 309 | ~7.2k | 近期高频演进域（radio-broadcast P0-P3 刚收尾），发布解耦收益最大；插件仓 `mimo-tts` 已有 TTS 先例。锁屏控制/媒体键如属宿主能力，保留薄通道 |
| B2-2 | IM 集成 | `integrations/` 7095（钉钉/飞书/QQ bot）+ Integration 组件 771 + `integrationService.ts` 168 | ~8k | 典型独立进程形态（`contributes.services` 常驻 + webhook），与宿主仅共享 config |
| B2-3 | PetOverlay | `petOverlay/` 1531 | 1.5k | 独立浮窗，边界干净 |
| B2-4 | Translate | `commands/translate.rs` 107 + Translate 组件 705 | 0.8k | 顺手项，可与 B2-3 同批 |

B2 合计 ~17.5k。

### 4.3 明确不拆清单（防无收益重构，对照 AGENTS.md §九「拆分须克制」）

| 功能 | 行数 | 不拆理由 |
|---|---|---|
| Chat / ChatInput / 会话域（session-v2、conversationStore、dialogStorage、turn_persist） | ~40k | 宿主本体，「日志即真相」核心架构 |
| Git 域（GitPanel 15k + `git/` 8.1k + git_capability 1.6k） | ~25k | cap.git 是 bus 静态注册的 AI 核心工具；GitPanel 深耦合编辑器（gutter/blame/changeNavigator 扩展点）；git-panel P0-P3 演进中。**远期观察项**：待 git-panel 系列收尾、编辑器扩展贡献点对外部插件开放后再评估仅拆 UI |
| FileExplorer / Terminal / Editor / Diff | ~9k | 开发环境核心面板，cap.fs / cap.bash 宿主能力的原生 UI |
| Settings / 主题体系 | ~11k | 宿主管理面 |
| `ai/` + `ai-runtime` + proxy | ~35k | AI 运行时与供应商网关，AGENTS.md 已定核心 |
| ask / dispatch 插件壳 | — | ask 保留（interaction 卡片伴生通道）；dispatch 已于 2026-11-09 移除（A+B 档，/dispatch 与 /nexus 基础设施保留）——见 plans/builtin-plugin-cleanup-analysis.md |
| lsp_index | 3.2k | 编辑器核心配套，feature 门控，无独立发布诉求 |

---

## 5. 技术路径（L1/L2/L3 分级）

每个功能项的迁移按三层推进，允许阶段性停在 L1（先瘦前端）：

- **L1 前端外移**：面板组件 + 前端 service → 插件 `dist/panel.js`（`pluginModuleLoader` 从 installPath 加载，参照 multichat）。宿主交互经公共通道：cap 总线（`router_dispatch`）、MCP 工具、`__POLARIS_HOST_INVOKE__`。**前置：hostInvoke 白名单（§6-1）**。
- **L2 后端外移**：功能 MCP server 从主进程内嵌（`builtin_plugin_mcp_manifests`，trusted）→ 插件 stdio 独立进程（aiToolAccess 门控）。Rust 功能代码出仓（用 Node/Rust 独立进程重写或移植），主包不再携带。**注意 AGENTS.md §五：MCP schema 改动后 `cargo build --bin polaris-mcp` 的 staleness 纪律在插件仓侧等价存在（插件 server schema 变更需版本协商）。**
- **L3 数据外移**：功能自有存储（scheduler sqlite、requirement 库、电台资产）→ DataRoot 下插件命名空间目录，卸载即清，遵守数据根单点原则（不散落硬编码路径）。

**样板参照**：`multichat`（面板 + 走 cap.ai.chat 复用宿主引擎，零改造对话架构）、`sundial`（调度先例）、`mimo-tts`（TTS 先例）。

**回滚**：插件仓每项发版保留前一版本 zip；主仓删除以单独 commit 落地，revert 边界干净。

---

## 6. 地基前置项（B1 开工前完成）

1. **hostInvoke 插件级白名单**：`__POLARIS_HOST_INVOKE__` 按 manifest `permissions` 六布尔裁剪可调 command 面（审计 §2.6.3）。UI 外移的安全前提，主仓内改动，约 1 个 spec 的量。
2. **manifest 校验补齐**：`validate_manifest_fields` 从 2/11 块扩到覆盖 services / chatCards / panel 等外移将用到的块（防止拆分插件契约漂移）。
3. **Web 模式插件服务管理放行**（审计 X9）：至少让已鉴权 Remote 可查询服务状态与触发 autostart，否则 Web 端用户装了插件功能不可用，拆分即功能降级。
4. **内置插件禁用语义对账**：外移后 `builtin_plugin_mcp_manifests` 注册表逐项摘除时，核对 `capability_to_builtin_servers` 映射与 trusted 免检逻辑不残留死项。

---

## 7. 验收标准

**每批（每项）通用**：
- [ ] 主仓：`pnpm typecheck` + `pnpm lint` + `cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 全绿；相关 vitest 文件实际执行通过。
- [ ] 行数对账：主仓净删除行数与 spec 预估一致（±20%），无半拆残留（孤儿组件、死 manifest、死 i18n key）。
- [ ] 插件仓：插件安装后功能等价回归清单逐项通过（每项 spec 中列出）；`update.json` 热更新链路验证一次。
- [ ] 双端验证：桌面（tauri dev）+ Web（tauri:dev:web）两模式回归；Web 不可用能力在插件描述中显式声明。
- [ ] 三处同步完成：主仓 / 插件仓 / `AGENTS.md` §五清单（如涉及 cap 契约）。

**整体（全部批次完成后）**：
- [ ] 主仓前后端合计出仓 ≥ 40k 行；`commands/` 目录剩余为不可拆核心命令。
- [x] `src/plugins/` 内置插件壳仅剩核心通道（2026-11-09 清理后：core/ask/browser/scheduler/contracts；dispatch 已移除，双轨状态消除）。
- [ ] 新功能全部落在插件仓（既有定案的可验证状态）。

---

## 8. 风险与边界

| 风险 | 等级 | 缓解 |
|---|---|---|
| 插件 JS 零沙箱，外移面板扩大磁盘来源代码的攻击面 | 高 | §6-1 白名单先行；L1 暂缓的项停在 L2（仅后端外移） |
| 协议漂移（AGENTS.md §4.1 无运行时 schema 校验） | 高 | 每项迁移不改协议字段，仅搬移；涉及 AIEvent/工具 schema 的变更走独立协议 spec |
| Browser 拆分触碰 webview 宿主边界，桌面/Web 行为分裂 | 高 | B1-7 排最后，先出 `cap.browser` 薄层 spec 评审再动；参照 `web-mode-browser-availability.md` 结论 |
| Scheduler daemon 外移后可靠性回退（进程生命周期治理刚修完） | 中 | 以 `contributes.services` 落地，复用已修的 PSM；上线前跑一轮 stop/restart/孤儿进程回归 |
| 功能等价性回归遗漏（电台锁屏、浏览器圈选联动等宿主交界功能） | 中 | 每项 spec 附「宿主交界功能清单」，逐项标注保留通道 |
| 用户已装内置功能，外移后首次启动需装插件才可用 | 中 | 外移插件在 marketplace 标记 `enabledByDefault`；迁移期主仓保留一次性引导（设置页提示安装） |

---

## 9. 实施纪律

- 每项动手前：读目标文件与测试 → 补该项独立 spec（本文件仅是总纲）→ 用户批准。
- 每项一次主题一个 commit 序列：①主仓摘壳 ②插件仓实现 ③主仓删码 ④文档同步；不混批。
- 全程不引入新的行为变更；发现设计缺陷先对齐（AGENTS.md §二.5）。
- 主仓删除的代码不保留「向后兼容垫层」；插件仓版本从 1.0.0 起按语义化演进。
