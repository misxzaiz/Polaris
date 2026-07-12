# 方案：MCP 伴生进程实现 AskUserQuestion（Claude Code 引擎）

**基于测试验证结果修订**。codeg 的路是唯一能实现「同回合实时交互」的路径。

## 为什么必须用 MCP 伴生进程

前次测试已证伪两种简化方案：

| 尝试 | 结果 |
|------|------|
| 去掉 `--print` 让 CLI 等 stdin | CLI 自动拒绝 AskUserQuestion（`is_error: true`） |
| 在 event_parser 提前解析 `input_json_delta` | 仅改善时机，无法同回合回填答案 |

**根源**：Claude CLI 把所有 `AskUserQuestion` 当作不可交互工具拒绝。要让 CLI 接受用户答案，必须把 `ask_user_question` 实现为**外部 MCP 工具**——CLI 把它当作普通 MCP 工具调用，MCP server 阻塞等待答案，答案返回后 CLI 作为 tool_result 接收。

**codeg 的做法**：`codeg-mcp` 伴生进程拦截 `ask_user_question`，通过 UDS 与主进程通信，oneshot 阻塞等用户回答。

**Polaris 的做法**：创建 `polaris-ask-mcp` 伴生进程，通过**本地 TCP** 与主进程通信——比 codeg 的 UDS/Token 体系简单得多。

## 整体架构

```
                    ┌── MCP JSON-RPC 2.0 over stdio ──┐
                    │  tools/list                       │
Claude CLI ─────────┤  tools/call(ask_user_question)    ├── polaris-ask-mcp
                    │  ← tool_result (含用户答案)       │   (伴生进程)
                    └──────────────────────────────────┘
                                                         │
                                          local TCP 连接  │
                                          (127.0.0.1:N)  │
                                                         │
┌─ Polaris 主进程 (Tauri) ───────────────────────────────┼──────────┐
│                                          TCP listener   │          │
│                                          ├ 接收问题 JSON│          │
│                                          ├ 发 Tauri event│         │
│                                          ├ 等答案       │          │
│                                          └ 返回答案 JSON│          │
│                                                         │          │
│  emit("chat-event", QuestionEvent{...})    ─────────────┼─→ 前端   │
│  ← answer_question(string)                  ←───────────┼── 前端   │
└──────────────────────────────────────────────────────────────────┘
```

## 改动清单

### 新建文件

| 文件 | 说明 |
|------|------|
| `src-tauri/src/bin/polaris_ask_mcp.rs` | MCP 伴生二进制入口（~100 行） |
| `src-tauri/src/services/ask_mcp_server.rs` | MCP JSON-RPC 循环 + ask_user_question handler（~200 行） |

### 修改文件

| 文件 | 改动内容 |
|------|----------|
| `src-tauri/Cargo.toml` | 新增 `[[bin]] polaris-ask-mcp` |
| `src-tauri/src/ai/engine/claude.rs` | 启动 TCP listener，把 `--polaris-port` + `--polaris-token` 注入 MCP config |
| `src-tauri/src/services/mcp_config_service.rs` | 新增 `ASK_MCP_SERVER_NAME` / `ASK_MCP_BIN_NAME` 常量 + 注册 |
| `src-tauri/src/commands/chat.rs` | `answer_question` 改造为通过 TCP 发送答案回 MCP companion |
| `src-tauri/src/app_state.rs` | 新增 `pending_questions: Arc<Mutex<HashMap<String, PendingQuestionEntry>>>` |
| `src-tauri/src/lib.rs` | 注册新的 command（如有） |
| `src/components/Chat/QuestionBlockRenderer.tsx` | 移除 `continueChat` 调用（答案在同回合回填） |

## 技术细节

### 1. polaris-ask-mcp 伴生进程 (`src/bin/polaris_ask_mcp.rs`)

**命令行参数**：
```
polaris-ask-mcp --polaris-port <N> --polaris-token <UUID>
```

**主循环**（仿 codeg 的 `companion.rs`，但极简化）：

```rust
#[tokio::main]
async fn main() {
    let args = parse_args(); // --polaris-port, --polaris-token

    let mut lines = BufReader::new(stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let req: JsonRpcRequest = serde_json::from_str(&line)?;
        match req.method.as_str() {
            "tools/list" => {
                // 返回 ask_user_question 的 JSON schema
                respond(&stdout, tools_list_response(req.id));
            }
            "tools/call" => {
                let params: ToolsCallParams = serde_json::from_value(req.params)?;
                if params.name == "ask_user_question" {
                    // 1. 连接主进程 TCP
                    let mut stream = TcpStream::connect(format!("127.0.0.1:{}", args.polaris_port)).await?;
                    // 2. 发送问题
                    let ask_msg = json!({
                        "type": "ask",
                        "token": args.polaris_token,
                        "session_id": args.session_id,
                        "questions": params.arguments.questions,
                    });
                    write_frame(&mut stream, &ask_msg).await?;
                    // 3. ⏸️ 阻塞等待答案
                    let answer: Value = read_frame(&mut stream).await?;
                    // 4. 返回 MCP tool result
                    respond(&stdout, tools_call_response(req.id, answer));
                }
            }
            "notifications/cancelled" => {
                // 取消等待，发取消帧到 TCP
            }
            _ => {}
        }
    }
}
```

**工具 schema**：
```json
{
  "name": "ask_user_question",
  "description": "Ask the user a multiple-choice question...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "questions": {
        "type": "array",
        "minItems": 1,
        "maxItems": 4,
        "items": {
          "type": "object",
          "properties": {
            "question": { "type": "string" },
            "header": { "type": "string", "maxLength": 12 },
            "multiSelect": { "type": "boolean", "default": false },
            "options": {
              "type": "array",
              "minItems": 2,
              "maxItems": 4,
              "items": {
                "type": "object",
                "properties": {
                  "label": { "type": "string" },
                  "description": { "type": "string" }
                },
                "required": ["label"]
              }
            }
          },
          "required": ["question", "header", "options"]
        }
      }
    },
    "required": ["questions"]
  }
}
```

### 2. TCP 协议：长度前缀帧

与 codeg transport 一致：`u32 LE length + UTF-8 JSON payload`。

**问题帧**（companion → 主进程）：
```json
{
  "type": "ask",
  "token": "uuid",
  "session_id": "claude-session-id",
  "questions": [...]
}
```

**答案帧**（主进程 → companion）：
```json
{
  "type": "answer",
  "declined": false,
  "answers": [
    {"question": "...", "header": "...", "selected": ["火锅", "日料"]}
  ]
}
```

**取消帧**（companion → 主进程）：
```json
{"type": "cancel", "token": "uuid"}
```

### 3. 主进程 TCP Listener（嵌入 claude.rs 或新的 service）

```
spawn CLI 前:
  1. TcpListener::bind("127.0.0.1:0") → 获得随机端口
  2. 生成 token = Uuid::new_v4()
  3. spawn tokio task: accept loop
     - 每个连接: 读类型帧 → ask → emit QuestionEvent → 
       存入 pending_questions[question_id] = {answer_tx}
       → 等 answer_tx.await → 写答案帧 → close
     - cancel → 移除 pending_questions, 通知前端
  4. 把 --polaris-port N --polaris-token X 作为 MCP server args
```

### 4. MCP Config 注入（改造 mcp_config_service.rs 或 claude.rs 直接构建）

方式一（简单，推荐 Phase 1）：在 `claude.rs` 的 `build_command` 中，如果 ask feature enabled：
- 找到 `polaris-ask-mcp` 二进制路径（与现有 MCP 二进制查找逻辑一致：bundle path → fallback path → dev path）
- 直接在 MCP config JSON 中追加一条 `{"polaris-ask": {"command": "...", "args": ["--polaris-port", "N", "--polaris-token", "X"]}}` 
- 写入临时 MCP config 文件

方式二（后续规范化）：在 `mcp_config_service.rs` 中注册为 `PluginMcpServerContribution`。

### 5. answer_question 改造（commands/chat.rs）

当前 `answer_question`（`:1875-1922`）：
- 从 `state.pending_questions` 移除
- emit `question_answered` 事件
- **不阻塞，不回填**

改造后：
```rust
pub async fn answer_question(
    session_id: String,
    call_id: String,
    answer: QuestionAnswer,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    // 1. 找到 pending question
    let entry = {
        let mut pending = state.pending_questions.lock()?;
        pending.remove(&call_id)
    };
    
    // 2. 构建 outcome
    if let Some(entry) = entry {
        let outcome = build_outcome(&entry.questions, &answer);
        
        // 3. 通过 oneshot 发回 TCP listener task
        let _ = entry.answer_tx.send(outcome);
        
        // 4. emit 事件通知前端更新 UI
        let event = json!({
            "type": "question_answered",
            "sessionId": session_id,
            "callId": call_id,
            "answer": answer,
        });
        window.emit("chat-event", &event)?;
    }
    
    Ok(())
}
```

### 6. AppState 扩展

```rust
pub struct PendingQuestionEntry {
    pub session_id: String,
    pub call_id: String,
    pub questions: Vec<QuestionSpec>,
    pub answer_tx: tokio::sync::oneshot::Sender<QuestionOutcome>,
}

// AppState 新增字段:
pub pending_questions: Arc<Mutex<HashMap<String, PendingQuestionEntry>>>,
```

## 实施步骤

### Step 1：创建 polaris-ask-mcp 二进制（1 天）
- [ ] `Cargo.toml` 新增 `[[bin]] polaris-ask-mcp`
- [ ] `src/bin/polaris_ask_mcp.rs` — 命令行参数解析 + MCP JSON-RPC 主循环
- [ ] `src/services/ask_mcp_server.rs` — tools/list + tools/call 实现 + TCP 客户端
- [ ] `cargo check --bin polaris-ask-mcp`

### Step 2：主进程 TCP Listener（1 天）
- [ ] `app_state.rs` 新增 `pending_questions` 字段
- [ ] 新建 `src/services/ask_listener.rs` — TCP accept loop + oneshot 管理
- [ ] 在 `claude.rs` 中集成：spawn CLI 前启动 listener，传端口/Token 给 MCP server
- [ ] `cargo check --lib`

### Step 3：MCP Config 注入（0.5 天）
- [ ] 二进制路径查找（复用现有 `mcp_exe_path` / `locate_binary` 逻辑）
- [ ] 动态生成临时 MCP config JSON，注入 `polaris-ask` server
- [ ] CLI 启动后清理临时 config

### Step 4：答案回填通道（0.5 天）
- [ ] 改造 `answer_question` 命令（加入 oneshot send）
- [ ] `QuestionBlockRenderer.tsx` 移除 `continueChat`
- [ ] 前后端联调

### Step 5：端到端测试（0.5 天）
- [ ] CLI 正常启动，MCP server 出现在工具列表
- [ ] 触发 ask_user_question → 问题实时弹出
- [ ] 回答后 CLI 同回合继续
- [ ] 取消/拒绝场景
- [ ] 非 ask_user_question 工具不受影响

**总计**：~3.5 天

## 为什么比 codeg 简单

| 组件 | codeg | Polaris |
|------|-------|---------|
| IPC 协议 | UDS/Named Pipe（Unix+Windows 两套） | **TCP 127.0.0.1**（跨平台一致） |
| 认证 | TokenRegistry + per-launch token + 撤销 | **简单 UUID token**（伴随进程生命周期） |
| 事件广播 | ACP EventEmitter（Tauri + WebSocket 双模） | **chat-event**（已有） |
| 连接管理 | ConnectionManager + SessionState + snapshot | **AppState HashMap**（极简） |
| 取消处理 | BrokerCancelRequest + 级联 | **notifications/cancelled → TCP cancel 帧** |
| 伴生进程 | codeg-mcp 支持 delegation+feedback+ask 三合一 | **polaris-ask-mcp 只做 ask_user_question** |
| 二进制数量 | 3 个 (codeg, codeg-server, codeg-mcp) | **已在 Cargo.toml 中**（新增 1 个 bin） |

**核心原因**：Polaris 只需要 `ask_user_question`，不需要多智能体委托（delegation）和实时反馈（feedback）。单体功能不需要通用框架。

## 方案 A（简化补充）：纯 event_parser 提速

如果项目短期内无法承受 ~3.5 天工作量的 MCP 伴生方案，可以先做 **event_parser 提前解析 input_json_delta**：

- 单文件改动 (`event_parser.rs`)
- ~1 天工作量
- 改善时机但不支持同回合回填

两个方案不冲突，A 可以作为 B 的热身铺垫。
