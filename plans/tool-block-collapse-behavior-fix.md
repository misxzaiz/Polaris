# 问题文档：AI 对话过程块（工具/思考）折叠行为调整

> 状态：待实施（由其他 AI 实施）
> 关联用户反馈：对话结束后工具调用被折叠成汇总条，用户希望默认不折叠（legacy 行为），且折叠规则按以下需求调整。

---

## 一、背景与现状

Polaris 中 AI 回复的消息按内容块（`ContentBlock`）渲染，其中过程块（thinking / tool_call / plan_mode / agent_run / permission_request / question / context_compact / tool_group）会被折叠。

当前折叠模式由配置 `chatDisplay.processBlockCollapse` 控制，两个取值：

- **`auto`（当前默认）**：消息结束后（非流式）所有过程块折叠进 `SessionSummaryCard` 补充卡片，正文只显示文本结果块。
- **`legacy`（旧版）**：按 `identifyCollapsibleBlockGroups` 识别相邻可折叠块，块数 > `collapseThreshold(5)` 时才折叠成 `CollapsibleBlockGroupRenderer`（默认展开 4 个，其余折叠），否则逐个平铺渲染。

用户当前配置已被改为 `legacy`，但有以下期望：

1. **默认就是 legacy 模式**（改代码默认值，而非只改用户配置）。
2. **不管数量几个都折叠**（去掉"超过 5 个才折叠"的阈值限制）。
3. **相邻的才折叠**：连续的 thinking/tool_call 块折叠成一组；中间若有真实文本，则文本正常显示、不被吞掉。
4. **自动生成的中间面板**（如 plugin_card 等交互卡/预览卡）放到折叠块的**上方**，不被折叠。

用户原话（2026-10-25）："目前好像是香菱的那个工具在最后会折叠……但是我希望就是不管数量几个都折叠。然后是相邻的折叠，如果是那个有文本的话就还是正常显示文本。另外的话就是要注意那些，比如说自动生成的中间的一些面板，那个的话就放到折叠的上面。"

> 注："香菱"是用户对某个工具/MCP server 的称呼，代码中无此字符串，实施时以实际渲染表现定位即可（用户默认引擎为 `simple-ai`）。

---

## 二、需求明细

### 需求 1：默认 legacy 模式

把 `processBlockCollapse` 的**代码默认值**改为 `'legacy'`。涉及默认值/归一化逻辑，不涉及用户已有配置迁移（已有配置优先）。

### 需求 2：不管数量几个都折叠

在 legacy 渲染路径中，去掉 `TOOL_COLLAPSE_CONFIG.collapseThreshold(5)` 的阈值门槛：**任何长度 ≥ 1 的相邻可折叠块组**都应折叠为组渲染器（`CollapsibleBlockGroupRenderer`），而不是小规模时逐个平铺。

### 需求 3：相邻才折叠、有文本则正常显示

折叠分组边界按"相邻 + 无真实文本打断"判定：

- 连续的 thinking / tool_call 块归为一组折叠。
- 空文本块（内容为空或只有 `...`）**不打断**分组（现状如此，保留）。
- **非空文本块打断分组**，且文本块本身正常平铺显示（不被折叠、不被吞掉）。
- 现状 `identifyCollapsibleBlockGroups` 已有此判定，但需结合需求 2 验证：分组正确性 + 文本块不被误折叠。

### 需求 4：自动生成的中间面板放到折叠块上方

消息中自动生成的中间面板类块（典型：`plugin_card`，可能含 `artifact_preview` / `question` / `permission_request` 等交互卡）：

- **不参与折叠**，始终正常渲染。
- **渲染顺序在折叠块上方**（用户可即时看到/交互），折叠内容在其下方。
- 注意 `categorizeBlock` 当前把 `plugin_card` 的 `interaction + pending` 态归为 `process`（会进折叠）；需调整分类，让这类交互面板保持独立展示在折叠区上方。

---

## 三、涉及文件（实施方参考，需自行确认）

| 文件 | 相关位置 | 说明 |
|---|---|---|
| `src/types/config.ts` | L26 `ProcessBlockCollapseMode`、L50-59 `DEFAULT_CHAT_DISPLAY_SETTINGS` | 前端默认值 `processBlockCollapse: 'auto'` → `'legacy'` |
| `src/components/Chat/tool-calls/blockGrouping.tsx` | L8-13 常量引用、L448-487 `identifyCollapsibleBlockGroups`、L552+ `renderBlocksWithGrouping`、L593 阈值判断 | 折叠分组识别与渲染入口 |
| `src/components/Chat/chatUtils/constants.ts` | L8-13 `TOOL_COLLAPSE_CONFIG`（`collapseThreshold: 5`） | 阈值常量 |
| `src/components/Chat/chatBubbles/AssistantBubble.tsx` | L154-167 渲染、L183 `SessionSummaryCard` | 消息气泡组装 |
| `src/components/Chat/chatBubbles/SessionSummaryCard.tsx` | 全文 | auto 模式的补充卡片（legacy 下是否仍需/调整） |
| `src/components/Chat/tool-calls/blockGrouping.tsx` L35-58 `categorizeBlock` | plugin_card 分类 | 需求 4 调整点 |
| `src-tauri/src/models/config.rs` | L898-903 `ProcessBlockCollapseMode`、L965 `default()` | 后端默认值 |
| `src-tauri/src/services/router/ui_chat_capability.rs` | L34/L63-68 字段白名单与校验 | cap.ui.chat 协议字段（枚举 `auto/legacy` 不变，无需改，但确认默认值同步） |

**注意（AGENTS.md 约定）**：

- 改协议 = 前后端双向同步：前端类型 + 后端 Rust 类型 + 校验，关键枚举不漂移。
- 改动后需验证：`pnpm exec tsc --noEmit` + `cargo check`（若动 Rust 默认值）。
- `docs/review-claude-code-process-block-collapse.md` 是本功能的历史设计文档，实施前建议通读。

---

## 四、验收标准

1. 全新配置（无用户覆盖）时，`processBlockCollapse` 默认生效为 `legacy` 行为。
2. 即使只有 1 个工具调用/思考块，消息结束后也折叠展示（点击可展开）。
3. 中间夹有真实文本时：文本正常显示，只有被文本分隔开的相邻块各自折叠。
4. plugin_card / 交互面板等自动生成的中间面板：正常渲染在折叠内容上方，不被折叠。
5. 流式输出期间保持展开（现状：流式不折叠，结束才折叠，此项不回归）。
6. 现有测试不回归；如行为变更，更新 `src/components/Chat/tool-calls/` 与 `blockGrouping` 相关测试。
