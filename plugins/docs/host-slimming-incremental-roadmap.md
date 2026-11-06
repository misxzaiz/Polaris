# 宿主瘦身渐进路线（Incremental Pluginization Roadmap）

> 状态：**规划文档，未实施** · 日期：2026-11-06
> 来源：用户定案——「解决项目臃肿，一点点去简化、插件化」。
> 定位：`plans/core-slimdown-plugin-extraction-plan.md`（下称**总纲**）是判定标准与批次总账；
> `plugins/docs/host-slimdown-plugin-contracts-plan.md`（下称**契约规划**）是能力契约设计；
> 本文件是**执行排程序**——把总纲的批次排成风险阶梯式的波次，每波独立验收、可叫停，
> 并给出量化基线与首步清单。三文档冲突时以总纲判定标准为准。

---

## 1. 问题量化：臃肿到底在哪（2026-11-06 实测基线）

### 1.1 总量

| 口径 | 行数 | 备注 |
|---|---|---|
| 前端 `src/`（非测试，699 文件） | **168,974** | 总纲 §2.1 估 ~110k 为**低估**，以本表为准 |
| 前端含测试 | 211,064 | 测试 42k 行随功能外移同步出仓 |
| 后端 `src-tauri/src/`（Rust） | **148,692** | 与总纲 ~140k 基本一致 |
| **合计（非测试）** | **≈ 318k** | 臃肿基线 |

### 1.2 分布（非测试 LOC 实测）

| 域 | 行数 | 判定 |
|---|---|---|
| `components/`（86.5k，其中 Chat 25.6k / GitPanel 12.4k / Settings 10.5k） | 86,531 | Chat/编辑器/设置=宿主本体；其余按总纲逐项判 |
| `services/` 前端 | 25,309 | 含大量功能域 service（外移主体之一） |
| `stores/` | 21,938 | conversationStore 系=宿主本体；功能域 store 随功能外移 |
| `src-tauri/src/services/`（Rust） | ~84k | router 20k=总线本体；git 8.1k/browser/proxy/scheduler/voice=外移主体 |
| `commands/`（Rust） | ~14k | 旧路径，迁移中；外移项连根拔 |
| `ai/` + `ai-runtime` + `integrations/` | ~23k + 7.1k | ai=宿主本体；integrations（IM bot）=外移 |
| `plugin-system` + `session-v2` + `types` + `utils` | ~21k | 宿主本体 |

### 1.3 臃肿的三个来源（对应三种解法）

1. **功能域混居**（主要）：~48k 行功能域代码与宿主同仓同发版 → **插件化出仓**（本路线主体）。
2. **包体积/启动**：已有独立治理线（mermaid 泄漏修复 -34.5%、CodeMirror 懒化、R2 各批次）→
   功能外移后随主包缩小**自动受益**，不重复立项，只在外移每波后复测。
3. **维护面**：10 个 >1800 行巨型文件、12 个「壳是插件身子是核心」双轨内置插件 →
   出仓即消解；**不做无收益的代码级拆文件**（总纲 §4.3 / AGENTS.md §九纪律不变）。

---

## 2. 总体策略：三条不动摇

1. **核心定义不动摇**：Polaris 核心 = 会话（session-v2/conversationStore/dialogStorage）+ cap 总线/权限/审计
   + 插件系统 + 数据根 + AI 运行时（`ai/`）+ 开发环境基础面板（FileExplorer/Terminal/Editor）+ Settings。其余皆候选。
2. **一项一闭环**：一次只搬一项，走完「主仓摘壳 → 插件仓实现 → 主仓删码 → 三处同步 → 功能等价回归」
   全链再开下一项。**禁止半拆双轨**——总纲 §2.2 批评的「壳是插件的身子是核心的」状态就是半拆产物。
3. **行为等价**：外移 = 搬移，不改协议字段；涉及新 cap/贡献点的先过契约评审（契约规划文档）。

---

## 3. 波次规划（W0→W6，风险阶梯）

> 工作量单位为「专注会话数」的粗估，供排期感知，非承诺。每波结束设**停点评估**：
> 复测基线表 → 用户确认下一波范围。

### W0 工作区卫生（0.5 会话，风险≈0，立即可做）

| 项 | 内容 |
|---|---|
| 仓库根 `plugins/` 澄清 | needs/sim-paper-trading 是**运行时安装副本**（`/plugins/` 已 gitignore），非仓库臃肿；不迁移（needs 的 MCP 路径已被 ZCode 配置引用，动了断链），仅在本文档登记归属 |
| `release-local/` 遗留 | codebuddy-engine adapter 等构建产物已进插件仓的，确认后清理（lint 全仓 15 error 均来自此类 CJS 文件，清理即归零） |
| 基线补测 | 主包体积、启动时长各测一次入表（§4），此后每波复测 |

### W1 P0 地基（总纲 §6 三项，~2 会话）

hostInvoke 插件级白名单（UI 外移安全前提）→ manifest 校验补齐 → Web 插件服务放行。
**不做 W1 不开 W3**——这是所有 UI 外移的前置。

### W2 契约 P1（契约规划 §3，~3 会话）

cap.session（含所有权记账）+ `ai.stream.end` hook 插桩 + `contributes.chatActions` + toast 进度态。
纯增量零删除。**受益方不止压缩交接**：task-runner/watchtower/context-pack 等（契约规划 §6 路线图）。

### W3 B1 低耦合四小项（~7.3k 行，每项 1-2 会话）

按总纲 §4.1 顺序执行，从小到大建立样板：

| 项 | 行数 | 关键点 |
|---|---|---|
| B1-1 PRD 预览 | ~1k | **最小闭环样板**：纯 chatCards 契约现成，走通全链发布（含商城/热更）即树立范式 |
| B1-2 Agnes | ~2.3k | 同路径复制 |
| B1-5 Computer | ~1.5k | 桌面专属，Web 声明不可用 |
| B1-4 PersonalHub | ~2.5k | 存储迁 DataRoot 插件命名空间 |

### W4 中项（~5.9k 行，每项 1-2 会话）

B1-3 Requirement（~3.6k，存储外迁是关键点）+ B2-3 PetOverlay（1.5k，边界最干净）+ B2-4 Translate（0.8k）。

### W5 B2 大项（~25k 行，每项 2-4 会话，收益主体）

| 项 | 行数 | 风险 |
|---|---|---|
| B2-2 IM 集成 | ~8k | 低——典型独立进程形态（contributes.services） |
| B1-6 Scheduler | ~10.1k | 中——daemon 刚修完 PSM，上线前跑 stop/restart/孤儿回归 |
| B2-1 语音电台 | ~7.2k | 中——高频演进域，发布解耦收益最大；锁屏/媒体键留薄通道 |

### W6 B1-7 Browser（最难，~8.9k，最后动）

两步走：①核心收编薄 `cap.browser`（webview 控制原语，RouterBus 范式）→ ②脚本库/面板/MCP 外移。
先出 cap.browser spec 单独评审再动手（总纲 §8 已标注最高风险项）。

**W3-W6 全部完成后：主仓非测试 ≈ 318k → ~275k（出仓 ~43k + 测试随迁 ~10k），
12 个内置壳消解为 2 个核心通道壳。**

---

## 4. 量化目标与度量口径

| 指标 | 基线（2026-11-06） | W3 后 | W5 后 | W6 后 |
|---|---|---|---|---|
| 主仓非测试 LOC | 318k | ~310k | ~293k | ~275k |
| 内置插件壳数 | 12 | 8 | 2-3 | 2（ask/dispatch 核心通道） |
| 主包体积 / 启动时长 | W0 补测 | 复测 | 复测 | 复测 |

- LOC 复测命令（本文件口径可复跑）：
  `find src -type f \( -name "*.ts" -o -name "*.tsx" \) ! -name "*.test.*" -exec cat {} + | wc -l`
  与 `find src-tauri/src -name "*.rs" -exec cat {} + | wc -l`。
- 每项完成后行数对账（总纲 §7：实测 vs spec 预估 ±20%），偏差记入该项 spec 收尾。

---

## 5. 首步清单（建议顺序）

1. **B1-1 PRD 预览外移**——理由：最小（~1k）+ chatCards 契约现成 + 不依赖 W1/W2 地基 +
   一次走完「插件仓建仓 → 发布 → 商城可见 → 主仓删码 → 热更验证」全链，为后续所有项树立可复制样板。
2. **W0 卫生项**——顺手完成，建立 §4 基线表。
3. **W1 hostInvoke 白名单 spec**——为 W3 后续项铺路。

---

## 6. 纪律与风险（总纲 §8/§9 全文适用，此处只补三条）

- **每波停点**：波内最后一项完成后必须停，复测基线 + 用户确认再开下一波——「一点点」的机制化。
- **双轨清扫**：每项主仓删码时，同时摘 `builtinPlugins.ts` + `builtin_plugin_mcp_manifests` 注册项，
  `grep` 验证无孤儿引用（防「壳残留」回潮）。
- **契约先行**：任何外移项若发现缺公共通道（如压缩交接之于 cap.session），先回 W2 补契约，
  不允许走同 window 直调的侧门（hostInvoke 白名单之外的路）。

## 7. 明确不做（重申总纲 §4.3 不拆清单）

Chat/ChatInput/会话域、Git 域（观察项）、FileExplorer/Terminal/Editor/Diff、Settings/主题、
`ai/`+proxy、ask/dispatch 核心通道壳、lsp_index、conversationPackager 等共享原语。
判定四问（总纲 §3）随时可用：宿主性/边界性/通道性/收益——四问二否即不拆。
