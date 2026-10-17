# image-recognition 输出截断优化 + v0.1.2 发布

> 状态：**实施中**
> 创建：2026-10-17
> 涉及仓库：`D:\space\base\Polaris-plugin`（插件）+ `D:\space\base\Polaris`（引擎）

---

## 一、问题诊断

### 现象
调用 `recognize_image` 时输出「明显少了很多」：
- 用户调用 `maxTokens: 1200` → 输出约到第 3 条分析就被截断；
- 实测 `maxTokens: 4000` 同一张图同一 prompt → 五条分析 + 总结完整。

### 根因（两层）

**① 调用方预算过低（直接原因）**
- `server.js L267`：`Math.min(Math.max(args.maxTokens || 1000, 100), 4000)`
- `max_tokens` 是模型输出硬预算，`1200` 对「逐条专业美术分析」必然腰斩；
- 默认 `1000` 本身就偏低，钳制下限 `100` 等于只够一句话。

**② 引擎压缩时「断头截断」丢关键结论**
- `src-tauri/src/ai/engine/simple_ai/compact.rs L515`：
  `truncate_chars(&text, SERIALIZE_TOOL_RESULT_CAP=1000)` 只保留 tool 结果**头部** 1000 字符；
- 长文分析的**结尾总结/结论**（通常最有信息量）在历史压缩时全丢；
- `truncate_chars`（L490-497）是纯头部截断，无保尾逻辑。

### 排除项（实测确认非根因）
- SimpleAI 回传路径（`mcp/mod.rs` → `chat_loop.rs`）在 4000 token 量级**无截断**；
- 前端 `JsonTreeView` 的 `…+167` 是**显示折叠**（`LONG_STRING_THRESHOLD=120`），非数据丢失。

---

## 二、目标与所有者

| 项 | 目标 | 所有者 |
|---|---|---|
| 插件 `server.js` | 默认输出预算提高、钳制下限提高、结果保头保尾，减少截断 | image-recognition 插件 |
| 引擎 `compact.rs` | 历史压缩时 tool 结果「保头+保尾」，关键结论不丢 | Polaris SimpleAI 引擎 |

不涉及 cap 契约 / MCP schema / 前后端协议类型，无跨端同步。

---

## 三、接口与行为

### 3.1 插件 `server.js`（行为不变，参数语义调整）

- `maxTokens` 默认 `1000 → 3000`；钳制 `100~4000 → 500~8000`。
- `extractAnswer` 结果返回前做「保头保尾」截断（新增 `truncateHeadTail(text, headCap, tailCap)`）：
  - 超长时保留头部 + 尾部，中间 `…[truncated]`，避免 JSON 包裹被断头截断。
- MCP 工具定义（`inputSchema`）的 `maxTokens` description 同步更新默认值。

### 3.2 引擎 `compact.rs`（行为增强）

- `truncate_chars` 保持不变（其他调用方依赖）；
- 新增 `truncate_head_tail(s, head_cap, tail_cap)`：保留头 `head_cap` + 尾 `tail_cap`，中段替换为 `…[truncated]`；
- `serialize_message` 对 `role == "tool"` 改用 `truncate_head_tail(text, 600, 400)`（合计仍 ≤1000 字符预算，头尾各留，中间省略）；
- 更新对应测试断言。

---

## 四、验收

1. `maxTokens=1200` 时输出比修复前明显更长（尾部总结不再被断头截断丢给模型）。
2. `maxTokens=4000` 输出完整五条 + 总结（回归不变）。
3. `compact.rs` 序列化 tool 结果：超长时**同时含头与尾**，且总长仍受控（≤CAP+标记）。
4. `cargo check` 通过；`node --check server.js` 通过。
5. 插件版本 `0.1.1 → 0.1.2`，`plugin.json`/`update.json`/`package.json`/`index.json` 同步。

---

## 五、风险与边界

| 风险 | 缓解 |
|---|---|
| 提高默认 maxTokens 增加 token 成本 | 仅默认值变化，调用方仍可显式覆盖；4000 实测成本可接受 |
| 保头保尾截断对非 JSON 文本（普通描述） | 只影响超长文本，短文本原样返回，行为等价 |
| 引擎改动影响其他 tool 结果压缩 | 仅 `role:"tool"` 分支改用保头保尾，user/assistant 不受影响 |
| 发布后 CDN 缓存延迟 | 走 `@main` + `@v0.1.2` tag，jsDelivr 常规刷新 |
