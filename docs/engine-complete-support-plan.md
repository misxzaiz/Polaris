# 引擎完整支持实施方案

> 状态：规划中
> 创建：2026-07-31
> 关联：`docs/pi-capability-support-analysis.md`、`docs/pi-long-term-plan.md`、`docs/adr/0005-simpleai-hybrid-context-compaction.md`

## 1. 背景与目标

Polaris 已接入五个引擎（claude-code / codex / simple-ai / mimo / pi），但存在三类断裂：

1. **Pi 无法消费 MCP 生态**：Pi 引擎不消费 `--mcp-config`，启动带 `--no-extensions --no-skills`，导致选 Pi 时用户失去全部 ~65 个 MCP 工具（浏览器 / 电脑操作 / PH / 调度等）。
2. **辅助功能缺引擎可选 / 无 AI**：标题生成是本地截断（前 16 字符），无 AI 能力；运行时压缩仅 SimpleAI / claude-code 支持，codex / pi / mimo 缺位。
3. **Pi 首版未启用图片附件**：pi.rs 注释明确"首版未传递"，RPC prompt 命令已支持 images 字段。

目标：消除上述断裂，让"任选引擎都能获得完整能力"。

## 2. 现状矩阵

### 2.1 引擎能力矩阵

| 能力 | claude-code | codex | simple-ai | mimo | pi |
|------|:-----------:|:-----:|:---------:|:----:|:--:|
| 工具调用 | ✅ | ✅ | ✅ | ✅ | ✅(原生4) |
| 流式 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 续聊(resume) | ✅ | ✅ | ✅(message_history) | ✅ | ✅ |
| 中断 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 图片输入 | ✅ | ❌ | ✅ | ❌ | ❌(首版未传) |
| **MCP 工具** | ✅ | ✅ | ✅(stdio) | ❌ | ❌ |
| **运行时压缩** | ✅ `/compact` | ❌ | ✅ compact_history | ❌ | ❌(parser 不透出) |
| 多目录(--add-dir) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Fork 会话 | ✅ | ❌ | ❌ | ✅ | ❌ |

### 2.2 辅助功能引擎选择现状

| 功能 | 引擎可选 | 实现 | 缺口 |
|------|:--------:|------|------|
| 主聊天 | ✅ 会话级 | SessionMetadata.engineId | — |
| 提示词润色 | ✅ 独立 | promptOptimizeService（独立配置持久化） | — |
| 压缩交接 | ✅ 参数级 | contextCompactHandoff（compact/newSession.engineId） | — |
| 会话续接 | ✅ 跨引擎 | sessionHandoff（不限制引擎） | — |
| 提交信息生成 | ✅ 参数级 | commitMessageChat | — |
| **标题生成** | ❌ | generateTitleFromMessage 本地截断前 16 字符 | **无 AI、不可选引擎** |
| **运行时压缩** | ⚠️ | SimpleAI/claude-code 有；codex/pi/mimo 无 | **三引擎缺位** |

## 3. 实施计划

### M1 — 辅助任务引擎 + AI 标题（P1，~3d）

**目标**：引入"辅助任务引擎"全局配置；标题生成改 AI，复用一次性静默会话模式。

**动机**：
- 标题纯本地截断可读性差。
- 辅助任务（标题/润色默认）用便宜引擎可显著降本。

#### M1.1 后端：Config 新增 auxiliary_engine

- `src-tauri/src/models/config.rs`
  - `Config` 增 `auxiliary_engine: Option<String>`（serde default None）。
  - `validate()` 校验：None 或 `EngineId::parse` 通过；非法 → None。
  - `get_auxiliary_engine_id(&self) -> Option<EngineId>`：返回辅助引擎；None 时调用方降级到 `get_engine_id()`。
- `src/types/config.ts`：镜像 `auxiliaryEngine?: string`。
- 设置页 `AIEngineTab`：默认引擎下方增"辅助任务引擎（标题/润色等，留空跟随主引擎）"下拉。

#### M1.2 前端：AI 标题生成

- `src/stores/conversationStore/conversationStoreUtils.ts`
  - 保留 `generateTitleFromMessage` 作降级兜底。
- 新增 `src/services/titleGenerationService.ts`：
  - 复用 promptOptimize 的一次性静默会话模式（kind='title-generation'，silentMode）。
  - 一次性系统提示：`You generate a concise session title (≤16 chars, user's language). Output ONLY the title.`
  - 触发点：首轮助手回复流式结束后（`createConversationStore` 里现有 `generateTitleFromMessage` 调用点改为调异步 `runTitleGeneration`，失败/超时回退本地截断）。
  - 引擎解析优先级：辅助引擎 > 主引擎。
  - 防抖：会话已有非截断标题则跳过。

**验收**：
- 首轮回复后标题由 AI 生成（≤16 字符）。
- AI 失败时回退本地截断，无报错冒泡。
- 设置页可选辅助引擎，留空跟随主引擎。

### M2 — Pi 图片附件传递（P2，~1d）

**目标**：SessionOptions.image_attachments 透传到 pi RPC prompt 命令。

- `src-tauri/src/ai/engine/pi_parser.rs`
  - `build_prompt_command` 补 `images` 字段：`{"id":..,"type":"prompt","message":..,"images":[{"media_type":..,"data":..}]}`。
- `src-tauri/src/ai/engine/pi.rs`
  - `start_session` / `continue_session`：若 `options.image_attachments` 非空，传入 build_prompt_command。
- 注释更新：移除"首版未传递"。

**验收**：
- 选 Pi 引擎发送图片，pi 接收并响应多模态。
- 无图片时行为不变。

### M3 — 运行时压缩覆盖补齐（P1，~5d）

**目标**：codex / pi / mimo 长会话不再 token 单调增长。

#### M3.1 Pi compaction 透出（~2d）

- `src-tauri/src/ai/engine/pi_parser.rs:215`
  - 移除"compaction 当前不透出"注释。
  - 映射 pi `compaction` 事件 → `AIEvent::ContextCompacted`。
- `pi.rs`：若 pi 本体支持触发压缩（需实测确认），暴露触发入口；不支持则前端在 token 阈值时提示用户走压缩交接。

#### M3.2 codex / mimo 压缩兜底（~3d）

- codex：评估是否有原生 `/compact` 等价；无则在前端检测 token 阈值，提示用户用压缩交接（compactHandoff 已支持指定引擎）。
- mimo：同 codex 路径。
- 前端：`ChatInput` 或状态栏在 token 用量 > 阈值时展示"上下文将满，建议压缩交接"提示卡片（非阻塞）。

**验收**：
- Pi compaction 事件映射为 ContextCompacted，前端正确渲染压缩块。
- codex/mimo 在 token 高位时出现压缩交接提示。

### M4 — Pi MCP 桥接（P0，~10d）

**目标**：选 Pi 引擎时仍能使用 Polaris MCP 工具。

**路径选择**（按风险递增）：

#### M4.1 路径 A：auth.json extensions 注入（首选，~4d）

Pi 的 extensions 体系通过 `~/.pi/agent/auth.json` 注册扩展。若 Pi Extension 能调用 stdio MCP server，则：

- `pi.rs` 移除 `--no-extensions`（保留 `--no-skills --no-context-files`）。
- 新增 `PiEngine::write_extensions_config()`：把 `SessionOptions.mcp_servers` 写入 auth.json extensions。
- 实测 Pi Extension 是否能桥接 stdio MCP（Pi 本体能力验证）。

**风险**：Pi Extension 协议未实测，可能不支持 stdio MCP。

#### M4.2 路径 B：Pi Extension 桥接（兜底，~6d）

若路径 A 失败，编写一个 Polaris 自带的 Pi Extension（TypeScript），内部起 stdio MCP client 连接 Polaris MCP server，把工具调用转发。

- 位置：`src-tauri/src/services/pi_extension_bridge/` 或独立 npm 包。
- 注册到 auth.json extensions。

#### M4.3 回退开关

- `PiCodeConfig` 增 `enable_extensions: bool`（默认 false，用户显式开启）。
- 开启时走 M4.1/M4.2；关闭时保持现状（`--no-extensions`，无 MCP）。

**验收**：
- 选 Pi 引擎 + 开启 enable_extensions，AI 可调用 polaris-browser / polaris-computer 等工具。
- 关闭时行为不变。
- 通信不中断（保留回退开关防 RPC 干扰）。

### M5 — 长期统一 MCP config（P3，~8d，本次不实施）

Pi 启用 `--mcp-config` 等价能力，所有引擎统一走 `--mcp-config`。依赖 Pi 上游支持，本次仅记录，不实施。

## 4. 依赖与顺序

```
M1（辅助引擎+AI标题）  ← 独立，可先做
M2（Pi 图片）          ← 独立
M3（运行时压缩）       ← M3.1 依赖 pi_parser；M3.2 独立
M4（Pi MCP 桥接）      ← 依赖 M4.1 实测结果选路径
```

建议实施顺序：M1 → M2 → M3 → M4。

## 5. 风险

1. **Pi `--mode rpc` + extensions 兼容性未实测**：M4.1 移除 `--no-extensions` 可能干扰 RPC 通信，需保留 `enable_extensions` 回退开关。
2. **pi compaction 透出 ≠ 真能压缩**：pi_parser 识别事件只是第一步，pi 本体是否支持触发压缩需实测，可能仍需 compactHandoff 兜底。
3. **辅助引擎双凭证复杂度**：用户需为辅助引擎单独配 Profile，UI 需明确引导。
4. **Pi Extension 协议未公开稳定**：M4.2 依赖逆向，可能随 Pi 版本失效。

## 6. 不做项

- mimo/codex 原生图片输入（CLI 不支持）。
- mimo MCP 支持（内置认证架构限制）。
- M5 长期统一 MCP config（依赖 Pi 上游）。
