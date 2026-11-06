# qoder/codebuddy 工具调用头部只显示"执行"修复 spec（2026-11-06）

## 背景

用户反馈：qoder、codebuddy 引擎对话中，**工具调用头部只显示工具名（如"执行"），看不到内容**（文件路径 / 命令 / 查询词），特别是检查文件相关、MCP 调用等工具。用户"不知道干嘛"。

## 根因

### 根因 A（qoder 主因）：adapter 未聚合 `input_json_delta` 分片

qoder / codebuddy 都用 claude-code stream-json 协议。Anthropic 流协议中 `tool_use` 参数经
`content_block_delta` 的 `input_json_delta` 分片到达，`content_block_start` 时 `input` **恒为空对象**。

- **codebuddy** v0.2.0 已修复：`toolInputFrags` 按 call_id 聚合分片，`content_block_stop` 拼完整
  JSON 后**补发 tool_call_start**（宿主 `appendToolCallBlock` 幂等守卫对同 callId 仅回填缺失 input）。
- **qoder** 从未移植此逻辑 → `ToolCallBlock.input` 恒为空 → 前端 `extractToolKeyInfo` 返回空 →
  工具头只剩工具名（`Bash`→`labels.execute`="执行"），路径/命令/查询词全丢。

### 根因 B（前端，通用）：MCP / 未注册工具的关键参数提取不足

MCP 工具 input 常为 `{ payload: { command, workdir } }` / `{ args: { file_path } }` 等嵌套形态，
`extractToolKeyInfo` 的 default 分支只查顶层 `command/path/query`，嵌套命中不到 → 头部无关键信息。

## 改动

### 适配器（Polaris-plugin 仓 plugins/qoder）

`adapter.js` 移植 codebuddy 的 `input_json_delta` 分片聚合：

- 新增 `toolInputFrags`（call_id → 分片数组）、`blockIndexToCallId`（index → call_id）。
- `content_block_start` 登记 `blockIndexToCallId.set(e.index, callId)`。
- `content_block_delta` 的 `input_json_delta` 累积分片。
- `content_block_stop` 拼完整 JSON、重发 `tool_call_start`（args 回填）。
- `runSession` 清理三个新 Map。

### 前端（主仓 src/utils/toolConfig.ts）

1. `extractDeepValue`：递归提取嵌套参数（payload/args/params/arguments/data/body 包装，深度≤3），
   命中 command/path/query/url/capability 等字段。
2. `extractToolKeyInfo` default 分支：顶层提取未命中时递归深入嵌套。
3. `NAME_WORD_ZH` 增加常见 MCP server 名词典（marketplace / polaris-bus / polaris-dispatch 等），
   使 `mcp__polaris-bus__bus_dispatch` 显示为"总线 · 调度"而非原始名。

## 验证

- [x] qoder 冒烟 16 断言全绿（新增"参数分片补发"断言：tool_call_start 首个 args 为空 →
      补发完整 `{cmd:'ls'}`）。
- [x] codebuddy 冒烟 26 断言全绿（回归无破坏）。
- [x] `pnpm exec tsc --noEmit` 无错误。
- [x] `toolConfig.displayName.test.ts` 21 断言全绿（新增 5 个 extractToolKeyInfo 嵌套提取用例）。
- [x] 相关前端测试（blockGrouping / diffExtractor / AgentRunBlockRenderer）50 断言全绿。

## 已知边界

- 工具调用头部仍不显示**无参数工具**的关键信息（本就无内容），属预期。
- 分片聚合只在 adapter 侧；宿主 `parse_event_frame` 已支持 `tool_call_start` args 字段，
  codebuddy 修复时已实测（`cargo test --lib --no-default-features` 16/16）。
