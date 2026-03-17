/// OpenAI API 代理服务
///
/// 为 OpenAI 兼容 API 提供后端代理，支持工具调用。
/// 解决前端直接调用 API 的安全问题。

use crate::error::{AppError, Result};
use crate::models::events::StreamEvent;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{Emitter, Window};
use tauri_plugin_notification::NotificationExt;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use std::process::Command as StdCommand;

#[cfg(not(windows))]
use std::process::Command as StdCommand;

/// Windows 进程创建标志：不创建新窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// OpenAI Provider 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIProviderConfig {
    pub provider_id: String,
    pub provider_name: String,
    pub api_key: String,
    pub api_base: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub supports_tools: bool,
}

/// OpenAI Chat 请求
#[derive(Debug, Clone, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,
}

/// 聊天消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// 工具定义（OpenAI 格式）
#[derive(Debug, Clone, Serialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: FunctionDefinition,
}

/// 函数定义
#[derive(Debug, Clone, Serialize)]
pub struct FunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// 工具调用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCall,
}

/// 函数调用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

/// SSE 流事件（已废弃，保留用于兼容性）
#[derive(Debug, Clone, Deserialize)]
struct SSEEvent {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    object: Option<String>,
    #[serde(default)]
    created: Option<i64>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    choices: Vec<SSEChoice>,
}

/// SSE 选择项
#[derive(Debug, Clone, Deserialize)]
struct SSEChoice {
    index: u32,
    #[serde(default)]
    delta: Option<SSEDelta>,
    #[serde(default)]
    finish_reason: Option<String>,
}

/// SSE Delta
#[derive(Debug, Clone, Deserialize)]
struct SSEDelta {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<SSEToolCall>>,
}

/// SSE 工具调用
#[derive(Debug, Clone, Deserialize)]
struct SSEToolCall {
    index: u32,
    id: Option<String>,
    #[serde(rename = "type")]
    call_type: Option<String>,
    function: Option<SSEFunctionCall>,
}

/// SSE 函数调用
#[derive(Debug, Clone, Deserialize)]
struct SSEFunctionCall {
    name: Option<String>,
    arguments: Option<String>,
}

/// 非流式响应
#[derive(Debug, Clone, Deserialize)]
struct ChatResponse {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    object: Option<String>,
    #[serde(default)]
    created: Option<i64>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    choices: Vec<ChatResponseChoice>,
}

/// 非流式响应选择项
#[derive(Debug, Clone, Deserialize)]
struct ChatResponseChoice {
    index: u32,
    #[serde(default)]
    message: Option<ResponseMessage>,
    #[serde(default)]
    finish_reason: Option<String>,
}

/// 响应消息
#[derive(Debug, Clone, Deserialize)]
struct ResponseMessage {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCall>>,
}

/// OpenAI 代理服务
pub struct OpenAIProxyService {
    client: Client,
}

impl OpenAIProxyService {
    /// 创建新的代理服务实例
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("Failed to create HTTP client");

        Self { client }
    }

    /// 获取可用工具定义
    pub fn get_tools() -> Vec<ToolDefinition> {
        vec![
            // 文件操作工具
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "read_file".to_string(),
                    description: "读取文件内容".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "文件的绝对路径"
                            }
                        },
                        "required": ["path"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "read_many_files".to_string(),
                    description: "批量读取文件内容".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "paths": {
                                "type": "array",
                                "description": "文件路径列表（绝对路径）"
                            }
                        },
                        "required": ["paths"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "image_read".to_string(),
                    description: "读取图片文件（以 Base64 返回）".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "图片的绝对路径"
                            }
                        },
                        "required": ["path"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "write_file".to_string(),
                    description: "写入文件内容".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "文件的绝对路径"
                            },
                            "content": {
                                "type": "string",
                                "description": "文件内容"
                            }
                        },
                        "required": ["path", "content"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "replace".to_string(),
                    description: "编辑文件（文本替换）".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "文件的绝对路径" },
                            "oldStr": { "type": "string", "description": "原文（精确匹配）" },
                            "newStr": { "type": "string", "description": "新文本" }
                        },
                        "required": ["path", "oldStr", "newStr"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "edit_file".to_string(),
                    description: "精确编辑文件（文本替换）".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "文件的绝对路径" },
                            "oldStr": { "type": "string", "description": "原文（精确匹配）" },
                            "newStr": { "type": "string", "description": "新文本" }
                        },
                        "required": ["path", "oldStr", "newStr"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "multi_edit".to_string(),
                    description: "批量编辑多个文件".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "edits": {
                                "type": "array",
                                "description": "编辑列表"
                            }
                        },
                        "required": ["edits"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "list_directory".to_string(),
                    description: "列出目录内容".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "目录的绝对路径"
                            }
                        },
                        "required": ["path"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "list_files".to_string(),
                    description: "列出目录文件（与 list_directory 等价）".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "目录的绝对路径" },
                            "recursive": { "type": "boolean", "description": "是否递归" }
                        },
                        "required": ["path"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "search_file_content".to_string(),
                    description: "在文件中搜索内容".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "pattern": {
                                "type": "string",
                                "description": "搜索模式（正则表达式）"
                            },
                            "path": {
                                "type": "string",
                                "description": "搜索路径"
                            }
                        },
                        "required": ["pattern"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "search_files".to_string(),
                    description: "按文件名搜索".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "pattern": { "type": "string", "description": "搜索模式（支持 *）" },
                            "path": { "type": "string", "description": "搜索路径" }
                        },
                        "required": ["pattern"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "search_code".to_string(),
                    description: "在文件内容中搜索".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "搜索内容" },
                            "path": { "type": "string", "description": "搜索路径" },
                            "file_pattern": { "type": "string", "description": "文件模式过滤" }
                        },
                        "required": ["query"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "glob".to_string(),
                    description: "按模式匹配文件（与 search_files 等价）".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "pattern": { "type": "string", "description": "搜索模式（支持 *）" },
                            "path": { "type": "string", "description": "搜索路径" }
                        },
                        "required": ["pattern"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "xml_escape".to_string(),
                    description: "对文本进行 XML 转义".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "text": { "type": "string", "description": "输入文本" }
                        },
                        "required": ["text"]
                    }),
                },
            },
            // ToolDefinition {
            //     tool_type: "function".to_string(),
            //     function: FunctionDefinition {
            //         name: "run_shell_command".to_string(),
            //         description: "执行 Shell 命令（与 execute_bash 等价）".to_string(),
            //         parameters: serde_json::json!({
            //             "type": "object",
            //             "properties": {
            //                 "command": { "type": "string", "description": "要执行的命令" }
            //             },
            //             "required": ["command"]
            //         }),
            //     },
            // },
            // Shell 执行工具
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "execute_bash".to_string(),
                    description: "执行 Shell 命令".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "command": {
                                "type": "string",
                                "description": "要执行的命令"
                            }
                        },
                        "required": ["command"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "web_fetch".to_string(),
                    description: "获取网页内容".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "url": { "type": "string", "description": "网页 URL" }
                        },
                        "required": ["url"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "web_search".to_string(),
                    description: "网络搜索（返回简要结果）".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "搜索内容" },
                            "count": { "type": "number", "description": "返回数量（1-10）" }
                        },
                        "required": ["query"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "ask_user_question".to_string(),
                    description: "询问用户问题".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "question": { "type": "string", "description": "问题内容" }
                        },
                        "required": ["question"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "save_memory".to_string(),
                    description: "保存记忆".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "content": { "type": "string", "description": "记忆内容" }
                        },
                        "required": ["content"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "task".to_string(),
                    description: "执行子任务（当前实现为简单记录）".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "input": { "type": "string", "description": "任务输入" }
                        },
                        "required": ["input"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "Skill".to_string(),
                    description: "执行技能（读取工作区 .codex/skills）".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "name": { "type": "string", "description": "技能名称" }
                        },
                        "required": ["name"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "ReadCommandOutput".to_string(),
                    description: "读取命令输出".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "description": "输出 ID" }
                        },
                        "required": ["id"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "exit_plan_mode".to_string(),
                    description: "退出规划模式".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {}
                    }),
                },
            },
        ]
    }

    /// 启动流式聊天会话
    pub async fn start_chat(
        config: OpenAIProviderConfig,
        messages: Vec<ChatMessage>,
        window: Window,
        context_id: Option<String>,
        openai_tasks: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, CancellationToken>>>,
    ) -> Result<String> {
        let session_id = Uuid::new_v4().to_string();
        let service = Self::new();
        let ctx_id = context_id.clone();
        let session_id_clone = session_id.clone();
        let session_id_for_task = session_id.clone();
        let cancel_token = CancellationToken::new();

        {
            let mut tasks = openai_tasks
                .lock()
                .map_err(|e| AppError::Unknown(e.to_string()))?;
            tasks.insert(session_id.clone(), cancel_token.clone());
        }

        // 在后台任务中执行
        let openai_tasks_clone = openai_tasks.clone();
        tokio::spawn(async move {
            if let Err(e) = service
                .run_chat_loop(config, messages, window, session_id_clone, ctx_id, cancel_token)
                .await
            {
                tracing::error!("[OpenAIProxy] Chat loop error: {}", e);
            }

            if let Ok(mut tasks) = openai_tasks_clone.lock() {
                tasks.remove(&session_id_for_task);
            }
        });

        Ok(session_id)
    }

    /// 运行聊天循环（处理工具调用）
    async fn run_chat_loop(
        &self,
        config: OpenAIProviderConfig,
        mut messages: Vec<ChatMessage>,
        window: Window,
        session_id: String,
        context_id: Option<String>,
        cancel_token: CancellationToken,
    ) -> Result<()> {
        tracing::info!(
            "[OpenAIProxy] 开始聊天循环, session={}, model={}, messages={:?}",
            session_id,
            config.model,
            messages
        );

        let mut tool_call_count = 0;
        const MAX_TOOL_CALLS: u32 = 500; // 防止无限循环

        loop {
            // 构建请求
            let tools = if config.supports_tools {
                Some(Self::get_tools())
            } else {
                None
            };

            let request = ChatRequest {
                model: config.model.clone(),
                messages: messages.clone(),
                temperature: Some(config.temperature),
                max_tokens: Some(config.max_tokens),
                stream: Some(false),
                tools,
            };

            tracing::info!("[OpenAIProxy] 发送 API 请求到 {}", config.api_base);

            // 发送请求
            let response = self
                .client
                .post(format!("{}/chat/completions", config.api_base.trim_end_matches('/')))
                .header("Authorization", format!("Bearer {}", config.api_key))
                .header("Content-Type", "application/json")
                .json(&request)
                .send()
                .await
                .map_err(|e| {
                    tracing::error!("[OpenAIProxy] API 请求失败: {}", e);
                    AppError::NetworkError(format!("API 请求失败: {}", e))
                })?;

            let status = response.status();
            tracing::info!("[OpenAIProxy] API 响应状态: {}", status);

            if !status.is_success() {
                let body: String = response.text().await.unwrap_or_default();
                tracing::error!("[OpenAIProxy] API 错误 ({}): {}", status, body);
                
                // 发送错误事件到前端
                self.emit_event(&window, &session_id, &context_id, StreamEvent::Error { 
                    error: format!("API 错误 ({}): {}", status, body) 
                });
                self.emit_event(&window, &session_id, &context_id, StreamEvent::SessionEnd);
                
                return Err(AppError::NetworkError(format!(
                    "API 错误 ({}): {}",
                    status, body
                )));
            }

            // 处理非流式响应
            let (content, tool_calls) = self
                .process_response(response, &window, &session_id, &context_id)
                .await?;

            // 添加助手消息（无论是否有工具调用，确保对话上下文完整）
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: if content.is_empty() {
                    None
                } else {
                    Some(serde_json::Value::String(content.clone()))
                },
                tool_calls: if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls.clone())
                },
                tool_call_id: None,
            });

            // 如果没有工具调用，结束循环
            if tool_calls.is_empty() {
                // 发送会话结束事件
                self.emit_event(&window, &session_id, &context_id, StreamEvent::SessionEnd);
                if !cancel_token.is_cancelled() {
                    notify_ai_reply_complete(&window);
                }
                break;
            }

            // 执行工具调用
            for tool_call in &tool_calls {
                tool_call_count += 1;
                if tool_call_count > MAX_TOOL_CALLS {
                    return Err(AppError::Unknown("工具调用次数超过限制".to_string()));
                }

                // 发送工具开始事件
                self.emit_event(
                    &window,
                    &session_id,
                    &context_id,
                    StreamEvent::ToolStart {
                        tool_use_id: tool_call.id.clone(),
                        tool_name: tool_call.function.name.clone(),
                        input: serde_json::from_str(&tool_call.function.arguments)
                            .unwrap_or(serde_json::Value::Null),
                    },
                );

                // 执行工具
                let result = self.execute_tool(&tool_call.function).await;

                // 发送工具结束事件
                self.emit_event(
                    &window,
                    &session_id,
                    &context_id,
                    StreamEvent::ToolEnd {
                        tool_use_id: tool_call.id.clone(),
                        tool_name: Some(tool_call.function.name.clone()),
                        output: Some(result.clone()),
                    },
                );

                // 添加工具结果消息
                messages.push(ChatMessage {
                    role: "tool".to_string(),
                    content: Some(serde_json::Value::String(result)),
                    tool_calls: None,
                    tool_call_id: Some(tool_call.id.clone()),
                });
            }
        }

        Ok(())
    }

    /// 处理非流式响应
    async fn process_response(
        &self,
        response: reqwest::Response,
        window: &Window,
        session_id: &str,
        context_id: &Option<String>,
    ) -> Result<(String, Vec<ToolCall>)> {
        tracing::info!("[OpenAIProxy] 开始处理非流式响应");

        // 读取响应体
        let body = response.text().await.map_err(|e| {
            tracing::error!("[OpenAIProxy] 读取响应失败: {}", e);
            AppError::NetworkError(format!("读取响应失败: {}", e))
        })?;

        tracing::info!("[OpenAIProxy] 响应体长度: {} bytes", body.len());

        // 解析响应
        let chat_response: ChatResponse = serde_json::from_str(&body).map_err(|e| {
            tracing::error!("[OpenAIProxy] 解析响应失败: {}, body: {}", e, truncate_for_log(&body, 500));
            AppError::ParseError(format!("解析响应失败: {}", e))
        })?;

        let mut content = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();

        // 处理选择项
        for choice in chat_response.choices {
            if let Some(message) = choice.message {
                // 处理内容
                if let Some(text) = &message.content {
                    content = text.clone();
                    // 发送完整的文本内容
                    self.emit_event(
                        window,
                        session_id,
                        context_id,
                        StreamEvent::TextDelta { text: text.clone() },
                    );
                }

                // 处理工具调用
                if let Some(tc) = &message.tool_calls {
                    tool_calls = tc.clone();
                }
            }
        }

        tracing::info!(
            "[OpenAIProxy] 非流式响应处理完成, 内容长度: {}, 工具调用数: {}",
            content.len(),
            tool_calls.len()
        );

        Ok((content, tool_calls))
    }

    /// 执行工具
    async fn execute_tool(&self, function: &FunctionCall) -> String {
        tracing::info!("[OpenAIProxy] Executing tool: {}", function.name);

        let args: serde_json::Value = serde_json::from_str(&function.arguments).unwrap_or(serde_json::Value::Null);

        match function.name.as_str() {
            "read_file" => {
                if let Some(path) = args.get("path").and_then(|p| p.as_str()) {
                    match tokio::fs::read_to_string(path).await {
                        Ok(content) => content,
                        Err(e) => format!("Error reading file: {}", e),
                    }
                } else {
                    "Error: missing path parameter".to_string()
                }
            }
            "read_many_files" => {
                if let Some(paths) = args.get("paths").and_then(|p| p.as_array()) {
                    let mut result = serde_json::Map::new();
                    for p in paths {
                        if let Some(path) = p.as_str() {
                            match tokio::fs::read_to_string(path).await {
                                Ok(content) => {
                                    result.insert(path.to_string(), serde_json::json!({
                                        "success": true,
                                        "data": content
                                    }));
                                }
                                Err(e) => {
                                    result.insert(path.to_string(), serde_json::json!({
                                        "success": false,
                                        "error": e.to_string()
                                    }));
                                }
                            }
                        }
                    }
                    serde_json::Value::Object(result).to_string()
                } else {
                    "Error: missing paths parameter".to_string()
                }
            }
            "image_read" => {
                if let Some(path) = args.get("path").and_then(|p| p.as_str()) {
                    match tokio::fs::read(path).await {
                        Ok(bytes) => {
                            let b64 = BASE64_STANDARD.encode(bytes);
                            serde_json::json!({ "base64": b64 }).to_string()
                        }
                        Err(e) => format!("Error reading image: {}", e),
                    }
                } else {
                    "Error: missing path parameter".to_string()
                }
            }
            "write_file" => {
                let path = args.get("path").and_then(|p| p.as_str());
                let content = args.get("content").and_then(|c| c.as_str());
                match (path, content) {
                    (Some(path), Some(content)) => {
                        // 确保父目录存在
                        if let Some(parent) = std::path::Path::new(path).parent() {
                            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                                return format!("Error creating directory: {}", e);
                            }
                        }
                        match tokio::fs::write(path, content).await {
                            Ok(_) => "File written successfully".to_string(),
                            Err(e) => format!("Error writing file: {}", e),
                        }
                    }
                    _ => "Error: missing path or content parameter".to_string(),
                }
            }
            "replace" | "edit_file" => {
                let path = args.get("path").and_then(|p| p.as_str());
                let old_str = args.get("oldStr").and_then(|s| s.as_str());
                let new_str = args.get("newStr").and_then(|s| s.as_str());
                match (path, old_str, new_str) {
                    (Some(path), Some(old_str), Some(new_str)) => {
                        match tokio::fs::read_to_string(path).await {
                            Ok(content) => {
                                if !content.contains(old_str) {
                                    return "Error: oldStr not found".to_string();
                                }
                                let new_content = content.replace(old_str, new_str);
                                match tokio::fs::write(path, new_content).await {
                                    Ok(_) => "File edited successfully".to_string(),
                                    Err(e) => format!("Error editing file: {}", e),
                                }
                            }
                            Err(e) => format!("Error reading file: {}", e),
                        }
                    }
                    _ => "Error: missing path or oldStr/newStr parameter".to_string(),
                }
            }
            "multi_edit" => {
                if let Some(edits) = args.get("edits").and_then(|e| e.as_array()) {
                    let mut results = Vec::new();
                    for edit in edits {
                        let path = edit.get("path").and_then(|p| p.as_str());
                        let old_str = edit.get("oldStr").and_then(|s| s.as_str());
                        let new_str = edit.get("newStr").and_then(|s| s.as_str());
                        if let (Some(path), Some(old_str), Some(new_str)) = (path, old_str, new_str) {
                            let res = match tokio::fs::read_to_string(path).await {
                                Ok(content) => {
                                    if !content.contains(old_str) {
                                        serde_json::json!({ "path": path, "success": false, "error": "oldStr not found" })
                                    } else {
                                        let new_content = content.replace(old_str, new_str);
                                        match tokio::fs::write(path, new_content).await {
                                            Ok(_) => serde_json::json!({ "path": path, "success": true }),
                                            Err(e) => serde_json::json!({ "path": path, "success": false, "error": e.to_string() })
                                        }
                                    }
                                }
                                Err(e) => serde_json::json!({ "path": path, "success": false, "error": e.to_string() })
                            };
                            results.push(res);
                        } else {
                            results.push(serde_json::json!({ "path": path.unwrap_or(""), "success": false, "error": "missing parameters" }));
                        }
                    }
                    serde_json::Value::Array(results).to_string()
                } else {
                    "Error: missing edits parameter".to_string()
                }
            }
            "list_directory" => {
                if let Some(path) = args.get("path").and_then(|p| p.as_str()) {
                    match tokio::fs::read_dir(path).await {
                        Ok(mut entries) => {
                            let mut result = Vec::new();
                            while let Ok(Some(entry)) = entries.next_entry().await {
                                if let Some(name) = entry.file_name().to_str() {
                                    result.push(name.to_string());
                                }
                            }
                            result.join("\n")
                        }
                        Err(e) => format!("Error listing directory: {}", e),
                    }
                } else {
                    "Error: missing path parameter".to_string()
                }
            }
            "list_files" => {
                if let Some(path) = args.get("path").and_then(|p| p.as_str()) {
                    let recursive = args.get("recursive").and_then(|r| r.as_bool()).unwrap_or(false);
                    let mut result = Vec::new();
                    if recursive {
                        let mut dirs = vec![path.to_string()];
                        while let Some(dir) = dirs.pop() {
                            let mut entries = match tokio::fs::read_dir(&dir).await {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                            while let Ok(Some(entry)) = entries.next_entry().await {
                                let p = entry.path();
                                if let Ok(metadata) = entry.metadata().await {
                                    if metadata.is_dir() {
                                        if let Some(s) = p.to_str() {
                                            dirs.push(s.to_string());
                                        }
                                    } else if let Some(s) = p.to_str() {
                                        result.push(s.to_string());
                                    }
                                }
                            }
                        }
                    } else {
                        match tokio::fs::read_dir(path).await {
                            Ok(mut entries) => {
                                while let Ok(Some(entry)) = entries.next_entry().await {
                                    if let Some(name) = entry.file_name().to_str() {
                                        result.push(name.to_string());
                                    }
                                }
                            }
                            Err(e) => return format!("Error listing directory: {}", e),
                        }
                    }
                    result.join("\n")
                } else {
                    "Error: missing path parameter".to_string()
                }
            }
            "search_file_content" => {
                let pattern = args.get("pattern").and_then(|p| p.as_str()).unwrap_or("");
                let path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
                let command = format!("rg \"{}\" \"{}\"", pattern, path);
                #[cfg(windows)]
                let output = StdCommand::new("cmd")
                    .args(["/C", &command])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
                #[cfg(not(windows))]
                let output = StdCommand::new("sh").args(["-c", &command]).output();
                match output {
                    Ok(output) => {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        if stderr.is_empty() { stdout.to_string() } else { format!("{}\n{}", stdout, stderr) }
                    }
                    Err(e) => format!("Error searching file content: {}", e),
                }
            }
            "search_files" => {
                let pattern = args.get("pattern").and_then(|p| p.as_str()).unwrap_or("");
                let path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
                let command = if cfg!(windows) {
                    format!("dir /b /s \"{}\\{}\"", path, pattern)
                } else {
                    format!("find \"{}\" -name \"{}\"", path, pattern)
                };
                let output = if cfg!(windows) {
                    StdCommand::new("cmd")
                        .args(["/C", &command])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output()
                } else {
                    StdCommand::new("sh").args(["-c", &command]).output()
                };
                match output {
                    Ok(output) => {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        if stderr.is_empty() { stdout.to_string() } else { format!("{}\n{}", stdout, stderr) }
                    }
                    Err(e) => format!("Error searching files: {}", e),
                }
            }
            "search_code" => {
                let query = args.get("query").and_then(|p| p.as_str()).unwrap_or("");
                let path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
                let command = format!("rg \"{}\" \"{}\"", query, path);
                let output = if cfg!(windows) {
                    StdCommand::new("cmd")
                        .args(["/C", &command])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output()
                } else {
                    StdCommand::new("sh").args(["-c", &command]).output()
                };
                match output {
                    Ok(output) => {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        if stderr.is_empty() { stdout.to_string() } else { format!("{}\n{}", stdout, stderr) }
                    }
                    Err(e) => format!("Error searching code: {}", e),
                }
            }
            "glob" => {
                let pattern = args.get("pattern").and_then(|p| p.as_str()).unwrap_or("");
                let path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
                let command = if cfg!(windows) {
                    format!("dir /b /s \"{}\\{}\"", path, pattern)
                } else {
                    format!("find \"{}\" -name \"{}\"", path, pattern)
                };
                let output = if cfg!(windows) {
                    StdCommand::new("cmd")
                        .args(["/C", &command])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output()
                } else {
                    StdCommand::new("sh").args(["-c", &command]).output()
                };
                match output {
                    Ok(output) => {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        if stderr.is_empty() { stdout.to_string() } else { format!("{}\n{}", stdout, stderr) }
                    }
                    Err(e) => format!("Error glob: {}", e),
                }
            }
            "xml_escape" => {
                if let Some(text) = args.get("text").and_then(|t| t.as_str()) {
                    
                    text
                        .replace("&", "&amp;")
                        .replace("<", "&lt;")
                        .replace(">", "&gt;")
                        .replace("\"", "&quot;")
                        .replace("'", "&apos;")
                } else {
                    "Error: missing text parameter".to_string()
                }
            }
            // "run_shell_command" => {
            //     if let Some(command) = args.get("command").and_then(|c| c.as_str()) {
            //         #[cfg(windows)]
            //         let output = StdCommand::new("cmd")
            //             .args(["/C", command])
            //             .creation_flags(CREATE_NO_WINDOW)
            //             .output();
            //         #[cfg(not(windows))]
            //         let output = StdCommand::new("sh").args(["-c", command]).output();
            //         match output {
            //             Ok(output) => {
            //                 let stdout = String::from_utf8_lossy(&output.stdout);
            //                 let stderr = String::from_utf8_lossy(&output.stderr);
            //                 if stderr.is_empty() { stdout.to_string() } else { format!("{}\n{}", stdout, stderr) }
            //             }
            //             Err(e) => format!("Error executing command: {}", e),
            //         }
            //     } else {
            //         "Error: missing command parameter".to_string()
            //     }
            // }
            "web_fetch" => {
                if let Some(url) = args.get("url").and_then(|u| u.as_str()) {
                    match self.client.get(url).send().await {
                        Ok(resp) => {
                            let status = resp.status().as_u16();
                            match resp.text().await {
                                Ok(text) => serde_json::json!({ "url": url, "status": status, "text": text }).to_string(),
                                Err(e) => format!("Error reading response: {}", e),
                            }
                        }
                        Err(e) => format!("Error fetching url: {}", e),
                    }
                } else {
                    "Error: missing url parameter".to_string()
                }
            }
            "web_search" => {
                let query = args.get("query").and_then(|q| q.as_str()).unwrap_or("");
                let count = args.get("count").and_then(|c| c.as_u64()).unwrap_or(5);
                let url = format!("https://duckduckgo.com/html/?q={}", urlencoding::encode(query));
                match self.client.get(&url).send().await {
                    Ok(resp) => {
                        match resp.text().await {
                            Ok(text) => {
                                // 简单提取结果链接
                                let mut results = Vec::new();
                                let re = regex::Regex::new(r#"<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap();
                                for cap in re.captures_iter(&text) {
                                    if results.len() >= count as usize { break; }
                                    results.push(serde_json::json!({
                                        "title": cap.get(2).map(|m| m.as_str()).unwrap_or("").to_string(),
                                        "url": cap.get(1).map(|m| m.as_str()).unwrap_or("").to_string()
                                    }));
                                }
                                serde_json::json!({ "query": query, "results": results }).to_string()
                            }
                            Err(e) => format!("Error reading search results: {}", e),
                        }
                    }
                    Err(e) => format!("Error searching: {}", e),
                }
            }
            "ask_user_question" => {
                if let Some(question) = args.get("question").and_then(|q| q.as_str()) {
                    serde_json::json!({ "question": question, "answer": "" }).to_string()
                } else {
                    "Error: missing question parameter".to_string()
                }
            }
            "save_memory" => {
                if let Some(content) = args.get("content").and_then(|c| c.as_str()) {
                    serde_json::json!({ "saved": true, "content": content }).to_string()
                } else {
                    "Error: missing content parameter".to_string()
                }
            }
            "task" => {
                if let Some(input) = args.get("input").and_then(|i| i.as_str()) {
                    serde_json::json!({ "message": input }).to_string()
                } else {
                    "Error: missing input parameter".to_string()
                }
            }
            "Skill" => {
                if let Some(name) = args.get("name").and_then(|n| n.as_str()) {
                    serde_json::json!({ "name": name }).to_string()
                } else {
                    "Error: missing name parameter".to_string()
                }
            }
            "ReadCommandOutput" => {
                if let Some(id) = args.get("id").and_then(|i| i.as_str()) {
                    serde_json::json!({ "id": id }).to_string()
                } else {
                    "Error: missing id parameter".to_string()
                }
            }
            "exit_plan_mode" => {
                serde_json::json!({ "exited": true }).to_string()
            }
            "execute_bash" => {
                if let Some(command) = args.get("command").and_then(|c| c.as_str()) {
                    // Accept both snake_case and camelCase for compatibility.
                    let work_dir = args
                        .get("work_dir")
                        .and_then(|d| d.as_str())
                        .or_else(|| args.get("workDir").and_then(|d| d.as_str()));

                    // Remove any leading `cd` command to avoid shell-specific issues
                    // This ensures commands execute directly in the specified directory
                    let mut effective_command = command.to_string();
                    let trimmed = effective_command.trim_start();
                    if trimmed.to_lowercase().starts_with("cd ") {
                        if let Some((_, rest)) = trimmed.split_once("&&") {
                            effective_command = rest.trim_start().to_string();
                        } else {
                            // If it's just a cd command without &&, use pwd or echo to show directory change
                            effective_command = "pwd".to_string();
                        }
                    }

                    #[cfg(windows)]
                    let output = {
                        // Force UTF-8 output from cmd to avoid mojibake.
                        let wrapped = format!("chcp 65001 >nul & {}", effective_command);
                        let mut cmd = StdCommand::new("cmd");
                        cmd.args(["/C", &wrapped]).creation_flags(CREATE_NO_WINDOW);
                        if let Some(dir) = work_dir {
                            cmd.current_dir(dir);
                        }
                        cmd.output()
                    };

                    #[cfg(not(windows))]
                    let output = {
                        let mut cmd = StdCommand::new("sh");
                        cmd.args(["-c", &effective_command]);
                        if let Some(dir) = work_dir {
                            cmd.current_dir(dir);
                        }
                        cmd.output()
                    };

                    match output {
                        Ok(output) => {
                            let stdout = String::from_utf8_lossy(&output.stdout);
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            if stderr.is_empty() {
                                stdout.to_string()
                            } else {
                                format!("{}\n{}", stdout, stderr)
                            }
                        }
                        Err(e) => format!("Error executing command: {}", e),
                    }
                } else {
                    "Error: missing command parameter".to_string()
                }
            }
            _ => format!("Unknown tool: {}", function.name),
        }
    }

    /// 发送事件到前端
    fn emit_event(
        &self,
        window: &Window,
        _session_id: &str,
        context_id: &Option<String>,
        event: StreamEvent,
    ) {
        let event_json = if let Some(cid) = context_id {
            serde_json::json!({
                "contextId": cid,
                "payload": event
            })
            .to_string()
        } else {
            serde_json::json!({
                "contextId": "main",
                "payload": event
            })
            .to_string()
        };

        tracing::debug!(
            "[OpenAIProxy] 发送事件: {}",
            truncate_for_log(&event_json, 100)
        );
        
        if let Err(e) = window.emit("chat-event", &event_json) {
            tracing::error!("[OpenAIProxy] 发送事件失败: {}", e);
        }
    }
}

fn notify_ai_reply_complete(window: &Window) {
    let _ = window
        .notification()
        .builder()
        .title("Polaris")
        .body("已完成本轮回复")
        .show();
}

fn truncate_for_log(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_string()
    } else {
        value.chars().take(max_chars).collect()
    }
}

impl Default for OpenAIProxyService {
    fn default() -> Self {
        Self::new()
    }
}
