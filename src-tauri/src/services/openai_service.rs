/*! 统一的 OpenAI 服务层
 *
 * 提供 OpenAI API 调用的核心功能，包括：
 * - 工具定义（单一来源）
 * - 工具执行（统一逻辑）
 * - 非流式聊天（QQ Bot 等使用）
 * - 流式聊天（前端使用）
 */

use crate::error::{AppError, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use std::process::Command as StdCommand;

#[cfg(not(windows))]
use std::process::Command as StdCommand;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// OpenAI Provider 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIConfig {
    pub provider_id: String,
    pub provider_name: String,
    pub api_key: String,
    pub api_base: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub supports_tools: bool,
}

/// 消息内容部分（支持多模态）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    /// 纯文本
    Text(String),
    /// 多部分内容（文本 + 图片）
    Parts(Vec<ContentPart>),
}

/// 内容部分
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentPart {
    #[serde(rename = "type")]
    pub part_type: String, // "text" or "image_url"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<ImageUrl>,
}

/// 图片 URL
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String, // data:image/png;base64,xxx or URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>, // "auto", "low", "high"
}

/// 聊天消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<MessageContent>,
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

/// Chat 请求
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

/// 非流式响应
#[derive(Debug, Clone, Deserialize)]
pub struct ChatResponse {
    pub id: Option<String>,
    pub choices: Vec<ChatChoice>,
}

/// 选择项
#[derive(Debug, Clone, Deserialize)]
pub struct ChatChoice {
    pub index: u32,
    pub message: ResponseMessage,
    pub finish_reason: Option<String>,
}

/// 响应消息
#[derive(Debug, Clone, Deserialize)]
pub struct ResponseMessage {
    pub role: String,
    pub content: Option<String>,
    pub tool_calls: Option<Vec<ToolCall>>,
}

/// 流式响应
#[derive(Debug, Clone, Deserialize)]
pub struct StreamResponse {
    pub id: Option<String>,
    pub choices: Vec<StreamChoice>,
}

/// 流式选择项
#[derive(Debug, Clone, Deserialize)]
pub struct StreamChoice {
    pub index: u32,
    pub delta: Delta,
    pub finish_reason: Option<String>,
}

/// 增量内容
#[derive(Debug, Clone, Deserialize)]
pub struct Delta {
    pub role: Option<String>,
    pub content: Option<String>,
    pub tool_calls: Option<Vec<ToolCallDelta>>,
}

/// 增量工具调用
#[derive(Debug, Clone, Deserialize)]
pub struct ToolCallDelta {
    pub index: Option<u32>,
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub call_type: Option<String>,
    pub function: Option<FunctionCallDelta>,
}

/// 增量函数调用
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct FunctionCallDelta {
    pub name: Option<String>,
    pub arguments: Option<String>,
}

/// 统一的 OpenAI 服务
pub struct OpenAIService {
    client: Client,
}

impl Default for OpenAIService {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAIService {
    /// 创建新实例
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("Failed to create HTTP client");

        Self { client }
    }

    /// 获取工具定义（统一来源）
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
                            "path": { "type": "string", "description": "文件的绝对路径" }
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
                            "path": { "type": "string", "description": "文件的绝对路径" },
                            "content": { "type": "string", "description": "文件内容" }
                        },
                        "required": ["path", "content"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "edit_file".to_string(),
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
                    name: "list_directory".to_string(),
                    description: "列出目录内容".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "目录的绝对路径" }
                        },
                        "required": ["path"]
                    }),
                },
            },
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "search_files".to_string(),
                    description: "搜索文件".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "pattern": { "type": "string", "description": "搜索模式" },
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
                    description: "在代码中搜索".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "搜索内容" },
                            "path": { "type": "string", "description": "搜索路径" }
                        },
                        "required": ["query"]
                    }),
                },
            },
            // Shell 执行工具
            ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: "execute_bash".to_string(),
                    description: "执行 Shell 命令".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "command": { "type": "string", "description": "要执行的命令" },
                            "work_dir": { "type": "string", "description": "工作目录" }
                        },
                        "required": ["command"]
                    }),
                },
            },
            // 网络工具
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
                    description: "网络搜索".to_string(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "搜索内容" },
                            "count": { "type": "number", "description": "返回数量" }
                        },
                        "required": ["query"]
                    }),
                },
            },
        ]
    }

    /// 执行工具（统一逻辑）
    pub async fn execute_tool(name: &str, args: &serde_json::Value, client: &Client) -> String {
        tracing::info!("[OpenAIService] 执行工具: {}", name);

        match name {
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
            "write_file" => {
                let path = args.get("path").and_then(|p| p.as_str());
                let content = args.get("content").and_then(|c| c.as_str());
                match (path, content) {
                    (Some(path), Some(content)) => {
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
            "edit_file" => {
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
                    _ => "Error: missing parameters".to_string(),
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
            "search_files" => {
                let pattern = args.get("pattern").and_then(|p| p.as_str()).unwrap_or("");
                let path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
                let command = if cfg!(windows) {
                    format!("dir /b /s \"{}\\{}\"", path, pattern)
                } else {
                    format!("find \"{}\" -name \"{}\"", path, pattern)
                };
                Self::execute_command(&command, None)
            }
            "search_code" => {
                let query = args.get("query").and_then(|p| p.as_str()).unwrap_or("");
                let path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
                let command = format!("rg \"{}\" \"{}\"", query, path);
                Self::execute_command(&command, None)
            }
            "execute_bash" => {
                if let Some(command) = args.get("command").and_then(|c| c.as_str()) {
                    let work_dir = args.get("work_dir").and_then(|d| d.as_str());
                    Self::execute_command(command, work_dir)
                } else {
                    "Error: missing command parameter".to_string()
                }
            }
            "web_fetch" => {
                if let Some(url) = args.get("url").and_then(|u| u.as_str()) {
                    match client.get(url).send().await {
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
                match client.get(&url).send().await {
                    Ok(resp) => {
                        match resp.text().await {
                            Ok(text) => {
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
            _ => format!("Unknown tool: {}", name),
        }
    }

    /// 执行 Shell 命令
    fn execute_command(command: &str, work_dir: Option<&str>) -> String {
        #[cfg(windows)]
        let output = {
            let wrapped = format!("chcp 65001 >nul & {}", command);
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
            cmd.args(["-c", command]);
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
    }

    /// 非流式聊天（QQ Bot 等使用）
    /// 返回完整响应，内部处理所有工具调用
    pub async fn chat_complete(
        &self,
        config: &OpenAIConfig,
        messages: Vec<ChatMessage>,
    ) -> Result<String> {
        let mut current_messages = messages;
        let mut tool_call_count = 0;
        const MAX_TOOL_CALLS: u32 = 50;

        loop {
            // 构建请求
            let tools = if config.supports_tools {
                Some(Self::get_tools())
            } else {
                None
            };

            let request = ChatRequest {
                model: config.model.clone(),
                messages: current_messages.clone(),
                temperature: Some(config.temperature),
                max_tokens: Some(config.max_tokens),
                stream: Some(false),
                tools,
            };

            tracing::info!("[OpenAIService] 发送请求到 {}", config.api_base);

            // 发送请求
            let response = self.client
                .post(format!("{}/chat/completions", config.api_base.trim_end_matches('/')))
                .header("Authorization", format!("Bearer {}", config.api_key))
                .header("Content-Type", "application/json")
                .json(&request)
                .send()
                .await
                .map_err(|e| AppError::NetworkError(format!("API 请求失败: {}", e)))?;

            let status = response.status();
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                return Err(AppError::NetworkError(format!("API 错误 ({}): {}", status, body)));
            }

            // 解析响应
            let chat_response: ChatResponse = response
                .json()
                .await
                .map_err(|e| AppError::ParseError(format!("解析响应失败: {}", e)))?;

            let choice = chat_response.choices.first()
                .ok_or_else(|| AppError::ParseError("No choices in response".to_string()))?;

            // 添加助手消息
            current_messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: choice.message.content.clone().map(MessageContent::Text),
                tool_calls: choice.message.tool_calls.clone(),
                tool_call_id: None,
            });

            // 检查是否有工具调用
            if let Some(ref tool_calls) = choice.message.tool_calls {
                if tool_calls.is_empty() {
                    // 没有工具调用，返回最终内容
                    return Ok(choice.message.content.clone().unwrap_or_default());
                }

                tool_call_count += 1;
                if tool_call_count > MAX_TOOL_CALLS {
                    return Err(AppError::ValidationError("Too many tool calls".to_string()));
                }

                tracing::info!("[OpenAIService] 处理 {} 个工具调用", tool_calls.len());

                // 执行每个工具调用
                for tool_call in tool_calls {
                    let args: serde_json::Value = serde_json::from_str(&tool_call.function.arguments)
                        .unwrap_or(serde_json::Value::Null);

                    let result = Self::execute_tool(&tool_call.function.name, &args, &self.client).await;

                    tracing::info!("[OpenAIService] 工具 {} 执行完成", tool_call.function.name);

                    // 添加工具结果消息
                    current_messages.push(ChatMessage {
                        role: "tool".to_string(),
                        content: Some(MessageContent::Text(result)),
                        tool_calls: None,
                        tool_call_id: Some(tool_call.id.clone()),
                    });
                }

                // 继续循环，发送包含工具结果的消息
            } else {
                // 没有工具调用，返回最终内容
                return Ok(choice.message.content.clone().unwrap_or_default());
            }
        }
    }

    /// 获取 HTTP 客户端（供 openai_proxy 使用）
    pub fn client(&self) -> &Client {
        &self.client
    }
}
