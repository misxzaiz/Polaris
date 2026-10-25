# 方案：AI 对话过程块折叠行为统一（移除 collapseMode，仅保留改进版 legacy）

> 状态：已实施（2026-10-25 定稿并落地，验证：typecheck / vitest / cargo check 双门通过）
> 前置讨论：原型已确认（三态对照：流式全展开 / 结束后新形态 / 结束后旧形态）。
> 本文档取代原「需求 1-4」版本：用户追加决策——**移除 `processBlockCollapse` 设置项本身**，auto/legacy 二分不复存在，全体用户统一为下述唯一行为。

---

## 一、最终行为（唯一形态）

一条 assistant 消息由 `ContentBlock[]` 渲染，规则：

1. **分组**：连续的 `thinking` / `tool_call` 块归为一个折叠组。
   - **仅非空 `text` 块打断分组**（空文本/"..." 不打断，现状保留）。
   - **面板类块（plugin_card / question / form / permission_request / artifact_preview 等）不打断分组**——它们不进组、也不把组切开；面板前后被「穿透」的过程块合并为一组，面板自身按原序渲染在组渲染器外侧（自然浮到其前面折叠条下方）。避免面板穿插产生多条折叠条的碎片形态。
2. **任何 ≥1 块的组都渲染为折叠组**（去掉原 `collapseThreshold: 5` 门槛，无「小组平铺」形态）。
3. **流式期间**：组渲染器透明——过程块直接平铺（无汇总条包装，避免"组壳套卡片"双层视觉）；面板即时原位出现。
4. **流式结束**（`isStreaming` false）：组自动折叠为**一条汇总条**（零可见块，不再保留前 4 个卡片头）。汇总条 = 图标 + 「运行过程」 + 计数 pills（思考 紫 / 工具 蓝）+ 总块数 + chevron。点击展开 = **回到平铺**（无容器壳，与流式期间同构；块卡自带间距），尾部一个无边框的轻量「收起」文字按钮；汇总条头部点击或尾部按钮均可收起。
5. **中间文本**：非空 text 块始终按原序平铺显示（不被吞）。
6. `SessionSummaryCard` 补充卡片**整体移除**：其三段（运行过程/变更文件/预览）在新形态下均与正文重复——过程在折叠条内、面板与预览原位直出、文件变更在组内 Edit/Write 工具卡（含 diff）中。
7. `artifact_preview.inlineToBody` 字段与写入链路保留（`eventHandler.ts` HTML 卡片检测），行为无差异（所有 artifact_preview 均正文直出）。

## 二、改动清单

### 前端
| 文件 | 改动 |
|---|---|
| `src/types/config.ts` | 删 `ProcessBlockCollapseMode` 类型、`ChatDisplaySettings.processBlockCollapse` 字段、`DEFAULT_CHAT_DISPLAY_SETTINGS.processBlockCollapse`、normalize 归一化行 |
| `src/components/Chat/messages/SessionMessagesView.tsx` | 删 collapseMode 读取与传参 |
| `src/components/Chat/messages/renderChatMessage.tsx` | 删 collapseMode 参数 |
| `src/components/Chat/chatBubbles/AssistantBubble.tsx` | 删 collapseMode prop、memo 比较行；删 SessionSummaryCard 渲染与 import |
| `src/components/Chat/tool-calls/blockGrouping.tsx` | 重写：`identifyCollapsibleBlockGroups` 打断条件收窄为仅非空 text；`CollapsibleBlockGroupRenderer` 全折叠 + 新汇总条；`renderBlocksWithGrouping` 删 collapseMode/auto 分支、阈值改 ≥1；删 `AutoModeRenderer`、`categorizeBlock`、`extractProcessBlocks`、`extractFileChanges`、`ProcessBlockGroupedList` 及其辅助（ProcessSection/ProcessBlockItem/FallbackBlockItem/deriveSectionSummary/getBlockGroup*/getGroupIcon） |
| `src/components/Chat/chatUtils/constants.ts` | 删 `TOOL_COLLAPSE_CONFIG` |
| `src/components/Chat/chatBubbles/SessionSummaryCard.tsx` | **删除文件** |
| `src/components/Chat/chatBubbles/AssistantBubble.test.tsx` | 删 3 处 `collapseMode="legacy"` 传参与过时注释 |
| `src/locales/{zh-CN,en-US}/chat.json` | `summary` 段仅保留 `collapsedLabel/chipThinking/chipTool/toolbarBlockCount`（新汇总条复用），删其余；删 `summaryCard` 段；删 `tool.moreTools/moreThinking/moreMixed` |
| 新增 `src/components/Chat/tool-calls/blockGrouping.test.tsx` | 分组规则（文本打断/面板不打断/空文本不打断）+ 全折叠行为（非流式零可见块）+ 流式展开 |

### 后端（Rust）
| 文件 | 改动 |
|---|---|
| `src-tauri/src/models/config.rs` | 删 `ProcessBlockCollapseMode` enum + Default、`ChatDisplaySettings.process_block_collapse` 字段与 default 构造 |
| `src-tauri/src/services/router/ui_chat_capability.rs` | `cap.ui.chat` patch 白名单删 `processBlockCollapse`，删对应取值校验 |

### 兼容性
- 旧配置文件中残留的 `processBlockCollapse` 字段：`ChatDisplaySettings` 无 `deny_unknown_fields`，serde 静默忽略，无需迁移。
- `cap.ui.chat` patch 再传该字段将被「未知字段」拒绝（防漂移语义正确）。

## 三、验收标准

1. 任意配置下（无设置项），结束后正文 = 折叠条（一条/文本段）+ 原序文本 + 原序面板 + 最终文本。
2. 单个工具调用也折叠为一条汇总条；汇总条可展开/收起。
3. 面板穿插工具之间时：折叠条数量仅由非空文本分段决定，与面板数量无关；面板不被折叠吞掉。
4. 流式期间过程块平铺直出（无汇总条包装）、面板即时可见；结束后自动收拢为汇总条（无前 4 个残留）。
5. 中间文本不被折叠。
6. `pnpm typecheck` / `pnpm test:run` / `cargo check` / `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过。
