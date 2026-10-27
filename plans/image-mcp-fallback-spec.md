# 方案：非多模态模型的图片识别桥接（三级防护 + MCP 视觉兜底）

> 状态：已实施（v2 三级防护版）
> 日期：2026-10-27
> 目标：让**不支持图片输入**的模型（如 SensenNova / 商量，走 SimpleAI 引擎）也能"看到"用户发的图片——图片落盘给路径引用，AI 自主决定直接读图或调 image-recognition MCP（智谱 GLM-4V）识别。

---

## 一、背景与问题

用户在 Android 移动端发图片，AI 回复"没看到图片"。排查结论（待办 `d530de03`）：

- 前端正常：`createAttachment` 读 base64 → `sendMessage` 带 `content`。
- 后端收集正常：`process_attachments`（`ai_chat_core.rs:216`）→ `image_data` → `with_image_attachments`。
- **根因引擎侧**：`SimpleAIEngine::start_session`/`continue_session` **从不读取 `options.image_attachments`**，消息只以纯文本构建。`EngineCapabilities { image_input: false }` 印证。

**用户核心痛点**：不是每个模型都支持看图；且**同一模型供应商下模型能力不齐**（`glm-4v` 支持、`glm-4-flash` 不支持），静态判定不可靠，**盲发图块会 400 报错**。因此不能默认"直通图块"，应给"路径指向"，让 AI 自主决策。

---

## 二、三级防护架构

```
┌─ 第一层：能力判定（vision.rs 单一权威）─────────────────────┐
│ ModelProfile.imageInput: auto|support|unsupported           │
│   + 已知视觉模型名清单（glm-4v/gpt-4o/claude-3/qwen-vl...） │
│   auto → 模型名命中清单 = Support，否则 Unknown（保守）      │
└────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ 第二层：直通判定（ai_chat_core 直通点）────────────────────┐
│ Support  → with_image_attachments（原生图块，Claude 用）    │
│ Unknown/Unsupported → 跳过直通（绝不发图块 → 绝不 400）     │
└────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ 第三层：落盘 + 指向 + AI 决策（永不 400 的兜底）───────────┐
│ 图片落盘 .polaris/attachments/ → 指引消息（带路径+可选动作） │
│  AI 自己选：read_file 直读 / 调 recognize_image / 告知       │
└────────────────────────────────────────────────────────────┘
```

### 关键：SimpleAI 引擎天然走第三层
SimpleAI 不消费 `image_attachments`，所以无论第二层判定结果，图片都会以**指引文本**（`build_message_with_attachments`）进入 user 消息。模型收到指引后，自主调用 `mcp__image-recognition__recognize_image` 识别。**不会发图块 → 不会 400**。

---

## 三、实现清单（已完成）

### 3.1 `models/config.rs` — 新增 `ModelProfile.image_input`
```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub image_input: Option<String>,
```
- `None`/`"auto"`：按模型名+协议启发式推断
- `"support"`：确定支持（直通原生图块）
- `"unsupported"`：确定不支持（走指向路径）

### 3.2 `ai/vision.rs` — 新增能力判定单一权威
- `enum VisionSupport { Support, Unsupported, Unknown }`
- `resolve_vision_support(profile)`：Profile 显式声明 > 已知视觉模型名清单 > 保守 `Unknown`
- `VISION_MODEL_KEYWORDS`：`gpt-4o/gpt-4.1/claude-3*/glm-4v/qwen-vl/gemini/doubao-vision/pixtral/llava/sensenova-vl...`
- 单元测试覆盖：声明优先、清单命中、未知保守

### 3.3 `services/ai_chat_core.rs` — 落盘 + 直通判定 + 指引
- `ProcessedAttachment` 加 `image_paths: Vec<String>`
- `process_attachments` image 分支：**解码 base64 落盘 `.polaris/attachments/img_<n>.<ext>`**，push 到 `image_paths`
- `build_message_with_attachments`：`image_paths` 非空时生成**指引文本**（带路径 + 可选动作 a/b/c）
- `should_direct_send_image(state, profile_id)`：从 config 找 Profile，用 `vision::resolve_vision_support` 判定
- start/continue 直通点：仅 `Support` 才 `with_image_attachments`；否则跳过（走指向）

### 3.4 `ai/mod.rs` — 挂载 `vision` 模块

---

## 四、指引消息格式（模型实际收到）

```
用户上传了 1 张图片，已保存到以下路径：
- /workspace/.polaris/attachments/img_0.png
请根据当前模型能力自行决定：
a) 若你支持视觉（多模态），可用 read_file 直接查看图片内容；
b) 否则请调用 mcp__image-recognition__recognize_image 工具，传入 image="<上述路径>" 识别图片内容后，把识别结果告诉用户；
c) 若两者都不可行，请明确告知用户图片无法识别。
注意：不要把图片 base64 直接嵌入文本（会超长且无效）。
```

`image-recognition` MCP（`.polaris/claude/mcp.json`）的 `recognize_image` 接受本地路径（自动转 base64）、URL、base64 data URL。API Key 从 config.json `plugins["image-recognition"]` 读。

---

## 五、降级策略

| 场景 | 行为 |
|---|---|
| 图片附件为空 | 不落盘、不指引 |
| Profile 判定 Support | 直通原生图块（Claude 引擎用 `send_stream_json_message`） |
| Profile 判定 Unknown/Unsupported | 不直通，走指向（AI 自主决策） |
| Profile 未指定 | 保守不直通，走指向（避免 400） |
| 落盘失败（权限/目录） | 记录 warn，仍收集 image_data（不阻断），指引缺失时模型看不了图但会话不崩 |
| 识别服务无 API Key | MCP 返回 `isError`，AI 降级告知用户 |
| HEIC 等非标准 MIME | `guess_image_ext` 兜底，识别服务按 data: 上传；智谱若拒绝降级提示（另立待办） |

---

## 六、验收清单

- [x] `cargo check --lib` 通过（Step 1/2/3 编译）
- [x] 新增 `vision.rs` 单元测试编译
- [ ] 运行时验证：SimpleAI（SensenNova/商量）发图 → 模型收到指引 → 调 `recognize_image` → 能说出图内容
- [ ] 运行时验证：Claude 引擎判定 Support → 直通原生图块（不 400）
- [ ] 前端零改动（`ChatInput`/`createAttachment`/`sendMessage` 全复用）
- [ ] 无新增 clippy warning（新代码按 clippy 编写）

---

## 七、后续待办

1. **SimpleAI 多模态直通**：当前 SimpleAI 不消费 `image_attachments`（`image_input: false`）。若某 Profile 声明 `support` 且走 SimpleAI，未来应补 OpenAI `content:[{type:image_url}]` 直通。本方案暂不实现（SimpleAI 走指向已达成核心目标）。
2. **HEIC 兼容验证**（待办 `29d07fd5`）。
3. **前端 `imageInput` 设置项**：Profile 设置面板暴露 `imageInput` 三态（auto/support/unsupported），当前后端字段已就绪，前端 UI 另立任务。

---

## 八、涉及文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/ai/vision.rs` | **新增**：能力判定单一权威 + 测试 |
| `src-tauri/src/ai/mod.rs` | 挂载 `vision` |
| `src-tauri/src/models/config.rs` | `ModelProfile` 加 `image_input` |
| `src-tauri/src/services/ai_chat_core.rs` | 落盘 + 指引 + 直通判定 |

**不改**：前端、`simple_ai/*` 引擎（天然走指向）、Claude 引擎（判定 Support 直通，不受影响）。
