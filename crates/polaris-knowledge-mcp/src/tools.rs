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
                "name": "init_knowledge",
                "description": "初始化项目知识库。创建 .polaris/knowledge/ 目录结构（modules/、meta/）和空索引文件（index.json、index.v2.json）。幂等操作——已初始化时返回成功但不覆盖现有数据。新项目首次使用知识库时应调用此工具。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            },
            {
                "name": "list_modules",
                "description": "列出项目所有知识模块（ID、名称、复杂度、变更频率）。返回项目架构的全局视图。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                },
                "annotations": {
                    "readOnlyHint": true
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
                            "description": "模块 ID（如 chat-render, engine-adapter, scheduler）"
                        }
                    },
                    "additionalProperties": false
                },
                "annotations": {
                    "readOnlyHint": true
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
                },
                "annotations": {
                    "readOnlyHint": true
                }
            },
            {
                "name": "get_architecture_overview",
                "description": "获取项目架构概览，包含所有模块列表及其依赖关系图。用于全面了解项目结构。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                },
                "annotations": {
                    "readOnlyHint": true
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
                },
                "annotations": {
                    "readOnlyHint": true
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
                "name": "create_module",
                "description": "创建新的知识模块。同时写入 v1 index.json 和 v2 index.v2.json，并创建对应的 Markdown 文档文件。确保三处数据一致。如果模块 ID 已存在则返回错误。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id", "name", "domain", "scope", "content"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "模块 ID（如 chat-render, ai-engine, scheduler）。使用 kebab-case 命名。"
                        },
                        "name": {
                            "type": "string",
                            "minLength": 1,
                            "description": "模块显示名称（如「聊天渲染与内容展示」）"
                        },
                        "domain": {
                            "type": "string",
                            "minLength": 1,
                            "description": "所属领域 ID（对应 v2 domains 中的 id）"
                        },
                        "scope": {
                            "type": "object",
                            "required": ["include"],
                            "properties": {
                                "include": {
                                    "type": "array",
                                    "items": { "type": "string", "minLength": 1 },
                                    "description": "包含的文件 glob 模式列表"
                                },
                                "exclude": {
                                    "type": "array",
                                    "items": { "type": "string" },
                                    "description": "排除的文件 glob 模式列表"
                                }
                            },
                            "description": "模块文件范围（glob 模式）"
                        },
                        "content": {
                            "type": "string",
                            "minLength": 1,
                            "description": "模块文档 Markdown 内容"
                        },
                        "dependencies": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "依赖的上游模块 ID 列表"
                        },
                        "complexity": {
                            "type": "string",
                            "enum": ["low", "medium", "high"],
                            "default": "medium",
                            "description": "模块复杂度"
                        },
                        "changeFrequency": {
                            "type": "string",
                            "enum": ["low", "medium", "high"],
                            "default": "medium",
                            "description": "变更频率"
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
            },
            {
                "name": "list_stale_modules",
                "description": "列出所有标记为过期（stale）的模块。返回模块 ID、过期时间、触发变更文件等信息。用于判断哪些模块需要重新分析。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                },
                "annotations": {
                    "readOnlyHint": true
                }
            },
            {
                "name": "clear_stale_marker",
                "description": "清除指定模块的过期标记。模块文档更新后自动调用，或手动清除。",
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
                "name": "validate_assertions",
                "description": "运行 v2 断言校验器：检查每条断言的代码锚点是否仍然有效（文件存在、符号存在、expect 通过）。不通过的断言会被降级。结果写入 meta/assertions-health.json。需要工作区模式。",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "persist": {
                            "type": "boolean",
                            "default": true,
                            "description": "是否将报告持久化到 meta/assertions-health.json"
                        }
                    }
                }
            },
            {
                "name": "get_assertions_health",
                "description": "读取最近一次 validate_assertions 的健康报告。不会触发重新校验。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                },
                "annotations": {
                    "readOnlyHint": true
                }
            },
            {
                "name": "compile_context",
                "description": "北极星工具：基于 v2 index.v2.json，针对用户意图编译一个 token-budgeted 上下文包。包含事实、断言、陷阱、相似模式，每条都带代码引用。意图识别 + 多路召回（直接实体/scope glob/关键词）+ 图扩展 + 预算编排。AI 接入新项目时应优先使用此工具而不是逐个 get_module。",
                "inputSchema": {
                    "type": "object",
                    "required": ["intent"],
                    "additionalProperties": false,
                    "properties": {
                        "intent": {
                            "type": "string",
                            "minLength": 1,
                            "description": "自然语言意图，例如「想给 chat-render 再做一轮内存优化」"
                        },
                        "scope": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "可选：显式限定模块 ID 列表"
                        },
                        "budget": {
                            "type": "integer",
                            "minimum": 0,
                            "default": 8000,
                            "description": "软 token 预算。0 表示不限。"
                        },
                        "depth": {
                            "type": "string",
                            "enum": ["shallow", "deep"],
                            "default": "deep",
                            "description": "shallow 跳过图扩展；deep 向依赖/被依赖各走一跳"
                        },
                        "mode": {
                            "type": "string",
                            "enum": ["read", "modify", "plan"],
                            "default": "plan",
                            "description": "意图模式。modify 会优先投放陷阱，read 会降低陷阱权重"
                        }
                    }
                },
                "annotations": {
                    "readOnlyHint": true
                }
            },
            {
                "name": "extract_structure",
                "description": "扫描工作区代码，抽取每个模块的符号表（TS/TSX/JS/Rust），写入 structures/<moduleId>.structure.json。结果可被 validator/compiler 使用做精确符号定位。建议每次代码结构变化后调用。需要工作区模式。",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "moduleId": {
                            "type": "string",
                            "description": "可选：只抽取指定模块。省略则抽取所有模块。"
                        }
                    }
                }
            },
            {
                "name": "get_structure",
                "description": "读取指定模块最近一次 extract_structure 的结果（符号表 + 行号映射）。",
                "inputSchema": {
                    "type": "object",
                    "required": ["moduleId"],
                    "additionalProperties": false,
                    "properties": {
                        "moduleId": { "type": "string", "minLength": 1 }
                    }
                },
                "annotations": {
                    "readOnlyHint": true
                }
            },
            {
                "name": "seed_assertions",
                "description": "自动为缺少断言的模块生成初始 assertions。基于 extract_structure 的符号表，优先选取公共符号（const > class > struct > fn > enum）。数值常量会自动附加 expect.equals。默认跳过已有 ≥3 条断言的模块。需要工作区模式。",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "apply": {
                            "type": "boolean",
                            "default": false,
                            "description": "true = 直接写入 index.v2.json；false = 仅返回预览（dry-run）"
                        },
                        "maxPerModule": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 20,
                            "default": 5,
                            "description": "每个模块最多生成断言数"
                        },
                        "skipIfHas": {
                            "type": "integer",
                            "minimum": 0,
                            "default": 3,
                            "description": "已有断言数 ≥ 此值则跳过该模块"
                        },
                        "onlyModule": {
                            "type": "string",
                            "description": "可选：只处理指定模块 ID"
                        }
                    }
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
