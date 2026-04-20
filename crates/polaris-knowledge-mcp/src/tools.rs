//! Tool definitions for the knowledge MCP server.

use serde_json::json;
use serde_json::Value;

/// Server metadata.
pub const SERVER_NAME: &str = "polaris-knowledge-mcp";
pub const SERVER_VERSION: &str = "0.1.0";
pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// Get the list of available tools.
pub fn get_tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "list_modules",
                "description": "列出项目所有知识模块（ID、名称、复杂度、变更频率）。返回项目架构的全局视图。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            },
            {
                "name": "get_module",
                "description": "获取指定模块的完整知识文档。包含概述、核心组件、数据流、设计决策和已知陷阱。用于深入理解某个子系统。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "模块 ID（如 chat-render, ai-engine, scheduler）"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "get_module_dependencies",
                "description": "获取指定模块的依赖关系，包括上游依赖和下游被依赖模块。用于分析修改影响面。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "模块 ID"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "get_architecture_overview",
                "description": "获取项目架构概览，包含所有模块列表及其依赖关系图。用于全面了解项目结构。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            },
            {
                "name": "search_modules",
                "description": "按关键词搜索模块。匹配模块 ID、名称和文档内容。用于定位「登录相关的模块在哪」等问题。",
                "inputSchema": {
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": {
                            "type": "string",
                            "minLength": 1,
                            "description": "搜索关键词"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "update_module",
                "description": "更新指定模块的知识文档内容。AI 修改代码后应调用此工具同步更新文档。只有文档内容会被替换，元数据保持不变。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id", "content"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "模块 ID"
                        },
                        "content": {
                            "type": "string",
                            "minLength": 1,
                            "description": "新的模块文档 Markdown 内容"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "mark_modules_stale",
                "description": "将指定模块标记为需要更新。git commit 后检测到文件变更时自动调用，或手动标记。",
                "inputSchema": {
                    "type": "object",
                    "required": ["changedFiles"],
                    "properties": {
                        "changedFiles": {
                            "type": "array",
                            "items": { "type": "string", "minLength": 1 },
                            "description": "变更的文件路径列表（相对工作区根目录）"
                        }
                    },
                    "additionalProperties": false
                }
            }
        ]
    })
}

/// Get initialize response.
pub fn get_initialize_response() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "version": SERVER_VERSION
        }
    })
}
