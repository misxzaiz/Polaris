# QQ 机器人分阶段消息格式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 QQ 机器人的回复从"一次性拼接发送"改为"按事件阶段分条发送"，提供即时确认、思考过程、工具调用、最终回复的分段式反馈。

**Architecture:** 改造 `process_ai_message` 中的事件回调，将不同 AIEvent 类型分别处理——Thinking/ToolCall 事件直接格式化后发送到 QQ，AssistantMessage/Token/Result 继续累积为最终回复。增加时间节流防止消息刷屏。优化 `event_parser.rs` 过滤无意义的 system 子类型。

**Tech Stack:** Rust, Tokio (async runtime, time::Instant), Arc/Mutex (shared state)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/src/ai/event_parser.rs:162-190` | Modify | 过滤无意义 system 子类型，不再将 hook_started 等未识别子类型原文发出 |
| `src-tauri/src/integrations/manager.rs:489-783` | Modify | 重写 `process_ai_message` 事件回调，分阶段发送消息 |

---

### Task 1: 过滤无意义的 system 子类型

**Files:**
- Modify: `src-tauri/src/ai/event_parser.rs:162-190`

当前 `parse_system_event` 对未识别的 subtype（如 `hook_started`、`hook_response`）会将 subtype 原文作为 Progress 事件发出。需要改为忽略这些无意义的子类型。

- [ ] **Step 1: 修改 `parse_system_event` 方法**

在 `src-tauri/src/ai/event_parser.rs` 中，将 `parse_system_event` 方法替换为：

```rust
    /// 解析系统事件
    fn parse_system_event(
        &self,
        subtype: Option<String>,
        extra: HashMap<String, serde_json::Value>,
    ) -> Vec<AIEvent> {
        let subtype = match subtype {
            Some(s) => s,
            None => return vec![],
        };

        // 已知的有意义子类型映射
        let message_map = HashMap::from([
            ("init", "💬"),        // 初始化会话
            ("reading", "📖"),     // 读取文件
            ("writing", "✏️"),     // 写入文件
            ("thinking", "🤔"),    // 思考中
            ("searching", "🔍"),   // 搜索中
        ]);

        let message = if let Some(&msg) = message_map.get(subtype.as_str()) {
            msg.to_string()
        } else if let Some(msg) = extra.get("message").and_then(|v| v.as_str()) {
            msg.to_string()
        } else {
            // 未识别的子类型（如 hook_started, hook_response 等）
            // 不发出 Progress 事件，静默忽略
            return vec![];
        };

        vec![AIEvent::Progress(ProgressEvent::new(&self.session_id, message))]
    }
```

关键改动：
- 将 `if let Some(ref subtype)` 改为 early return 模式，让 borrow checker 满意
- **未识别子类型且无 extra.message 时，返回空 vec 而非将 subtype 原文发出**
- 有 `extra["message"]` 的未识别子类型仍然会显示（因为有有意义的描述文字）

- [ ] **Step 2: 编译验证**

Run: `cd D:/space/base/Polaris/src-tauri && cargo check`
Expected: 编译成功，无错误

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/ai/event_parser.rs
git commit -m "fix: 过滤无意义的 system 子类型事件，不再将未识别子类型原文发送"
```

---

### Task 2: 重写 process_ai_message 事件回调，实现分阶段消息发送

**Files:**
- Modify: `src-tauri/src/integrations/manager.rs:489-783`

这是核心改动。将 `process_ai_message` 中的事件回调从"累积所有文本一次性发送"改为"按事件类型分别处理"。

- [ ] **Step 1: 添加必要的 import**

在 `manager.rs` 顶部（约第 10 行 `use tokio::sync::...` 之后），添加：

```rust
use std::time::Instant;
```

注意：`std::time::Instant` 已经在 `process_ai_message` 内部使用（第 565 行），但它是局部 import。将其移到顶部以保持一致性。实际上检查后发现第 565 行使用的是 `std::time::Instant::now()` 的完整路径，不需要额外 import。

需要在文件顶部添加的 import 是 `tokio::sync::Mutex` 相关的 —— 已经存在。无需额外 import。

- [ ] **Step 2: 重写 process_ai_message 函数**

将 `manager.rs` 第 489-783 行的 `process_ai_message` 函数替换为以下完整实现：

```rust
    /// 处理 AI 消息
    async fn process_ai_message(ctx: ProcessAiMessageContext) {
        let ProcessAiMessageContext {
            engine_registry,
            conversation_id,
            message,
            app_handle,
            platform,
            adapters,
            conversation_states,
            active_sessions,
        } = ctx;
        tracing::info!("[IntegrationManager] 🤖 开始 AI 回复: conversation={}, message_len={}", conversation_id, message.len());

        // 获取会话状态（包括已有的 ai_session_id）
        let (engine_id, work_dir, system_prompt, existing_session_id) = {
            let mut states = conversation_states.lock().await;
            let state = states.get_or_create(&conversation_id);

            // 构建系统提示词
            let default_prompt = "你是一个友好的助手，通过 QQ 回复用户消息。回复简洁、有帮助。";

            // 优先使用预设提示词，其次使用自定义提示词
            let system_prompt = if let Some(ref preset_id) = state.prompt_preset_id {
                let work_dir_path = state.work_dir.clone().unwrap_or_else(|| ".".to_string());
                match Self::build_prompt_from_preset(preset_id, &work_dir_path) {
                    Some(preset_prompt) => {
                        match &state.custom_prompt {
                            Some(custom) => {
                                match state.prompt_mode {
                                    PromptMode::Append => format!("{}\n\n{}", preset_prompt, custom),
                                    PromptMode::Replace => custom.clone(),
                                }
                            }
                            None => preset_prompt,
                        }
                    }
                    None => {
                        match &state.custom_prompt {
                            Some(custom) => {
                                match state.prompt_mode {
                                    PromptMode::Append => format!("{}\n\n{}", default_prompt, custom),
                                    PromptMode::Replace => custom.clone(),
                                }
                            }
                            None => default_prompt.to_string(),
                        }
                    }
                }
            } else {
                match &state.custom_prompt {
                    Some(custom) => {
                        match state.prompt_mode {
                            PromptMode::Append => format!("{}\n\n{}", default_prompt, custom),
                            PromptMode::Replace => custom.clone(),
                        }
                    }
                    None => default_prompt.to_string(),
                }
            };

            let session_id = state.ai_session_id.clone();
            let engine_id = state.get_engine_id();

            (
                engine_id,
                state.work_dir.clone(),
                system_prompt,
                session_id,
            )
        };

        // 记录开始时间
        let start_time = std::time::Instant::now();

        // 检查引擎可用性
        {
            let registry = engine_registry.lock().await;
            if !registry.is_available(&engine_id) {
                tracing::error!("[IntegrationManager] ❌ {} 引擎不可用", engine_id);
                Self::send_reply(&adapters, platform, &conversation_id, &format!("❌ {} 引擎不可用", engine_id)).await;
                return;
            }
        }

        // 发送即时确认消息
        Self::send_reply(&adapters, platform, &conversation_id, "✅ 已接收到消息，正在处理中").await;

        // 用于累积最终回复文本（仅 AssistantMessage / Token / Result）
        let accumulated_text = Arc::new(Mutex::new(String::new()));
        let accumulated_text_clone = accumulated_text.clone();

        // 进度消息节流：记录上次发送进度消息的时间
        let last_progress_time = Arc::new(std::sync::Mutex::new(std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(10))
            .unwrap_or_else(std::time::Instant::now)));
        let last_progress_time_clone = last_progress_time.clone();

        // 创建 oneshot 通道等待进程完成
        let (complete_tx, complete_rx) = oneshot::channel();
        let complete_tx = Arc::new(std::sync::Mutex::new(Some(complete_tx)));

        let conversation_id_for_callback = conversation_id.clone();
        let app_handle_for_callback = app_handle.clone();

        // 进度消息节流间隔（毫秒）
        const PROGRESS_THROTTLE_MS: u64 = 1500;

        // 创建事件回调
        let callback = move |event: crate::models::AIEvent| {
            tracing::debug!("[IntegrationManager] 收到事件: {:?}", std::mem::discriminant(&event));

            match &event {
                // 思考事件：发送思考摘要
                crate::models::AIEvent::Thinking(thinking) => {
                    let text = &thinking.content;
                    if !text.is_empty() {
                        // 截取前 150 字符作为摘要
                        let preview: String = text.chars().take(150).collect();
                        let preview = if preview.len() < text.len() {
                            format!("{}...", preview)
                        } else {
                            preview
                        };
                        let msg = format!("[思考中] {}", preview);
                        // 思考事件不受节流限制，直接克隆需要的变量后异步发送
                        let adapters = adapters.clone();
                        let conv_id = conversation_id_for_callback.clone();
                        tokio::spawn(async move {
                            Self::send_reply(&adapters, platform, &conv_id, &msg).await;
                        });
                    }
                }

                // 工具调用开始
                crate::models::AIEvent::ToolCallStart(tc) => {
                    let msg = format!("[{}] 执行中...", tc.tool);
                    // 节流检查
                    let should_send = {
                        if let Ok(mut last) = last_progress_time_clone.try_lock() {
                            let now = std::time::Instant::now();
                            if now.duration_since(*last) >= std::time::Duration::from_millis(PROGRESS_THROTTLE_MS) {
                                *last = now;
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    };
                    if should_send {
                        let adapters = adapters.clone();
                        let conv_id = conversation_id_for_callback.clone();
                        tokio::spawn(async move {
                            Self::send_reply(&adapters, platform, &conv_id, &msg).await;
                        });
                    }
                }

                // 工具调用结束
                crate::models::AIEvent::ToolCallEnd(tc) => {
                    let status = if tc.success { "完成 ✅" } else { "失败 ❌" };
                    let msg = format!("[{}] {}", tc.tool, status);
                    // 工具完成事件不受节流限制
                    let adapters = adapters.clone();
                    let conv_id = conversation_id_for_callback.clone();
                    tokio::spawn(async move {
                        Self::send_reply(&adapters, platform, &conv_id, &msg).await;
                    });
                }

                // Progress 事件：忽略（已由 Thinking/ToolCall 覆盖）
                crate::models::AIEvent::Progress(_) => {
                    // 不再发送 Progress 事件到 QQ
                }

                // 文本类事件：累积到最终回复
                _ => {
                    if let Some(text) = event.extract_text() {
                        let preview: String = text.chars().take(100).collect();
                        let preview = if preview.len() < text.len() { format!("{}...", preview) } else { preview };
                        tracing::info!("[IntegrationManager] AI 文本 (len={}): {}", text.len(), preview);

                        if let Ok(mut accumulated) = accumulated_text_clone.try_lock() {
                            accumulated.push_str(&text);
                        }

                        // 发送增量更新到前端
                        let _ = app_handle_for_callback.emit("integration:ai:delta", serde_json::json!({
                            "conversationId": conversation_id_for_callback,
                            "text": text,
                            "isDelta": true
                        }));
                    }
                }
            }

            if event.is_session_end() {
                tracing::info!("[IntegrationManager] AI 会话结束");
            }

            if event.is_error() {
                tracing::error!("[IntegrationManager] AI 会话出错: {:?}", event);
            }
        };

        // 创建完成回调
        let complete_tx_clone = complete_tx.clone();
        let complete_callback = move |_exit_code: i32| {
            tracing::debug!("[IntegrationManager] 进程完成回调触发");
            if let Ok(mut tx) = complete_tx_clone.lock() {
                if let Some(tx) = tx.take() {
                    let _ = tx.send(());
                }
            }
        };

        // 启动 AI 会话任务
        let task_conversation_id = conversation_id.clone();
        let task_adapters = adapters.clone();
        let task_app_handle = app_handle.clone();
        let task_engine_registry = engine_registry.clone();
        let task_conversation_states = conversation_states.clone();
        let task_active_sessions = active_sessions.clone();

        // 创建 session_id 更新回调
        let task_conversation_id_for_update = conversation_id.clone();
        let conversation_states_for_update = conversation_states.clone();
        let session_id_update_callback = Arc::new(move |new_session_id: String| {
            tracing::info!("[IntegrationManager] 📌 Session ID 更新回调: {}", &new_session_id[..8.min(new_session_id.len())]);
            if let Ok(mut states) = conversation_states_for_update.try_lock() {
                states.set_ai_session(&task_conversation_id_for_update, new_session_id);
            }
        });

        let task = tokio::spawn(async move {
            // 调用 AI 引擎（根据是否已有会话决定创建新会话还是继续会话）
            let session_id_for_response: String;

            if let Some(ref existing_id) = existing_session_id {
                tracing::info!("[IntegrationManager] 🔄 继续已有会话: {}", &existing_id[..8.min(existing_id.len())]);

                let result = {
                    let mut registry = task_engine_registry.lock().await;
                    let mut options = SessionOptions::new(callback)
                        .with_system_prompt(&system_prompt)
                        .with_on_complete(complete_callback);
                    options.on_session_id_update = Some(session_id_update_callback.clone());

                    if let Some(ref dir) = work_dir {
                        options = options.with_work_dir(dir);
                    }

                    registry.continue_session(engine_id, existing_id, &message, options)
                };

                match result {
                    Ok(()) => {
                        session_id_for_response = existing_id.clone();
                    }
                    Err(e) => {
                        tracing::error!("[IntegrationManager] 继续会话失败: {:?}", e);
                        let _ = task_app_handle.emit("integration:ai:error", serde_json::json!({
                            "conversationId": task_conversation_id,
                            "error": e.to_string()
                        }));
                        Self::send_reply(&task_adapters, platform, &task_conversation_id, &format!("❌ AI 调用失败: {}", e)).await;

                        let mut sessions = task_active_sessions.lock().await;
                        sessions.remove(&task_conversation_id);
                        return;
                    }
                }
            } else {
                tracing::info!("[IntegrationManager] 🆕 创建新会话");

                let result = {
                    let mut registry = task_engine_registry.lock().await;
                    let mut options = SessionOptions::new(callback)
                        .with_system_prompt(&system_prompt)
                        .with_on_complete(complete_callback);
                    options.on_session_id_update = Some(session_id_update_callback.clone());

                    if let Some(ref dir) = work_dir {
                        options = options.with_work_dir(dir);
                    }

                    registry.start_session(Some(engine_id), &message, options)
                };

                match result {
                    Ok(session_id) => {
                        tracing::info!("[IntegrationManager] AI 会话创建: session_id={}", session_id);
                        session_id_for_response = session_id.clone();

                        {
                            let mut states = task_conversation_states.lock().await;
                            states.set_ai_session(&task_conversation_id, session_id);
                        }
                    }
                    Err(e) => {
                        tracing::error!("[IntegrationManager] 创建会话失败: {:?}", e);
                        let _ = task_app_handle.emit("integration:ai:error", serde_json::json!({
                            "conversationId": task_conversation_id,
                            "error": e.to_string()
                        }));
                        Self::send_reply(&task_adapters, platform, &task_conversation_id, &format!("❌ AI 调用失败: {}", e)).await;

                        let mut sessions = task_active_sessions.lock().await;
                        sessions.remove(&task_conversation_id);
                        return;
                    }
                }
            }

            // 等待进程完成
            tracing::info!("[IntegrationManager] ⏳ 等待 AI 进程完成...");
            let _ = complete_rx.await;

            // 获取最终回复文本
            let final_text = accumulated_text.lock().await.clone();
            tracing::info!("[IntegrationManager] 📝 回复文本长度: {}", final_text.len());

            // 发送完整回复事件到前端
            let _ = task_app_handle.emit("integration:ai:complete", serde_json::json!({
                "conversationId": task_conversation_id,
                "sessionId": session_id_for_response,
                "text": final_text
            }));

            // 发送最终回复到平台
            if !final_text.is_empty() {
                Self::send_reply(&task_adapters, platform, &task_conversation_id, &final_text).await;
                tracing::info!("[IntegrationManager] ✅ 回复已发送");

                // 发送完成消息
                let elapsed = start_time.elapsed();
                let complete_msg = format!("✅ 处理完成（⏰ {:.1}s）", elapsed.as_secs_f32());
                Self::send_reply(&task_adapters, platform, &task_conversation_id, &complete_msg).await;
            } else {
                tracing::warn!("[IntegrationManager] ⚠️ AI 返回空文本，不发送回复");
            }

            // 从活跃会话中移除
            let mut sessions = task_active_sessions.lock().await;
            sessions.remove(&task_conversation_id);
        });

        // 记录活跃会话
        {
            let mut sessions = active_sessions.lock().await;
            sessions.insert(conversation_id.clone(), task);
        }
    }
```

**关键设计决策说明：**

1. **即时确认**：在 AI 处理前立即发送 `"✅ 已接收到消息，正在处理中"`（第 577 行）

2. **Thinking 事件**：截取前 150 字符，格式 `[思考中] xxx`，不受节流限制

3. **ToolCallStart 事件**：格式 `[工具名] 执行中...`，受 1500ms 节流限制（密集工具调用时不刷屏）

4. **ToolCallEnd 事件**：格式 `[工具名] 完成 ✅` 或 `[工具名] 失败 ❌`，不受节流限制（完成事件总有意义）

5. **Progress 事件**：完全忽略（其信息已被 Thinking/ToolCall 覆盖）

6. **文本累积**：`AssistantMessage`、`Token`、`Result` 事件的文本仍然累积到 `accumulated_text`，作为最终回复一次性发送

7. **消息发送**：使用 `tokio::spawn` 异步发送中间进度消息，避免阻塞事件回调

- [ ] **Step 3: 编译验证**

Run: `cd D:/space/base/Polaris/src-tauri && cargo check`
Expected: 编译成功

可能的编译问题及修复：
- `adapters` 在闭包中被 clone —— 需要确保 `Arc<Mutex<HashMap<...>>>` 实现了 `Clone`（Arc 本身就是 Clone 的）
- `platform` 是 `Platform` 类型，在闭包中使用需要 `Copy` —— 检查 `Platform` enum 是否 derive 了 `Copy`。如果没有，在 spawn 前需要 clone 或 copy
- `conversation_id_for_callback` 在多个 match arm 中被 clone —— 每个 arm 需要 `.clone()`

- [ ] **Step 4: 修复编译错误（如果有）**

根据 `cargo check` 的输出修复问题。常见修复：
- 如果 `Platform` 没有 `Copy`，在闭包前添加 `let platform = platform.clone();` 或在结构体中添加 `#[derive(Clone, Copy)]`
- 如果 `conversation_id_for_callback` borrow 冲突，在每个使用它的 match arm 中提前 clone

- [ ] **Step 5: 编译再次验证**

Run: `cd D:/space/base/Polaris/src-tauri && cargo check`
Expected: 编译成功，零错误零警告

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/integrations/manager.rs
git commit -m "feat: QQ 机器人分阶段消息格式 - 即时确认/思考/工具调用/最终回复分段发送"
```

---

## Self-Review

### 1. Spec Coverage
- ✅ 即时确认消息 → Task 2 Step 2 第 577 行
- ✅ 思考过程带标签 → Task 2 Step 2 Thinking 分支
- ✅ 工具调用带标签 → Task 2 Step 2 ToolCallStart/ToolCallEnd 分支
- ✅ 最终回复独立发送 → Task 2 Step 2 文本累积 + 发送逻辑
- ✅ 处理完成通知 → Task 2 Step 2 完成消息
- ✅ 过滤 hook_started 等无意义文本 → Task 1
- ✅ 防刷节流 → Task 2 Step 2 PROGRESS_THROTTLE_MS

### 2. Placeholder Scan
- 无 TBD / TODO / "implement later" / "fill in details"
- 所有步骤包含完整代码
- 无 "similar to Task N" 引用

### 3. Type Consistency
- `AIEvent::Thinking(ThinkingEvent)` → `thinking.content: String` ✅
- `AIEvent::ToolCallStart(ToolCallStartEvent)` → `tc.tool: String` ✅
- `AIEvent::ToolCallEnd(ToolCallEndEvent)` → `tc.tool: String`, `tc.success: bool` ✅
- `ProgressEvent::message: Option<String>` → 不再使用 ✅
- `adapters: Arc<Mutex<HashMap<Platform, Box<dyn PlatformIntegration>>>>` → `Clone` via Arc ✅
