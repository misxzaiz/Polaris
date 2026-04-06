/*! 工具系统类型定义
 *
 * 定义工具执行相关的类型：
 * - ToolError: 工具执行错误
 * - PermissionMode: 权限模式
 * - PermissionPolicy: 权限策略
 * - ToolSpec: 工具规范
 */

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 工具执行错误
#[derive(Debug, Clone)]
pub enum ToolError {
    /// 工具不存在
    NotFound(String),
    /// 权限不足
    PermissionDenied {
        tool: String,
        required: PermissionMode,
        current: PermissionMode,
    },
    /// 参数错误
    InvalidInput(String),
    /// 执行错误
    ExecutionError(String),
    /// IO 错误
    IoError(String),
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(name) => write!(f, "工具不存在: {}", name),
            Self::PermissionDenied { tool, required, current } => {
                write!(f, "权限不足: 工具 {} 需要 {} 权限，当前权限为 {}",
                    tool, required.display_name(), current.display_name())
            }
            Self::InvalidInput(msg) => write!(f, "参数错误: {}", msg),
            Self::ExecutionError(msg) => write!(f, "执行错误: {}", msg),
            Self::IoError(msg) => write!(f, "IO 错误: {}", msg),
        }
    }
}

impl std::error::Error for ToolError {}

/// 权限模式
///
/// 定义工具执行的权限级别。
/// 参考 claw-code 的 PermissionLevel 设计。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// 只读模式 - 只允许读取文件和搜索
    ReadOnly,
    /// 工作区写入 - 允许在工作区内写入和编辑文件
    WorkspaceWrite,
    /// 完全访问 - 允许执行任意命令（危险）
    DangerFullAccess,
}

impl PermissionMode {
    /// 获取显示名称
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::ReadOnly => "只读",
            Self::WorkspaceWrite => "工作区写入",
            Self::DangerFullAccess => "完全访问",
        }
    }

    /// 检查是否满足所需的权限级别
    pub fn satisfies(&self, required: &Self) -> bool {
        // 权限级别顺序：ReadOnly < WorkspaceWrite < DangerFullAccess
        match (self, required) {
            // DangerFullAccess 可以满足所有权限
            (Self::DangerFullAccess, _) => true,
            // WorkspaceWrite 可以满足 ReadOnly 和 WorkspaceWrite
            (Self::WorkspaceWrite, Self::ReadOnly | Self::WorkspaceWrite) => true,
            // ReadOnly 只能满足 ReadOnly
            (Self::ReadOnly, Self::ReadOnly) => true,
            // 其他情况不满足
            _ => false,
        }
    }
}

impl Default for PermissionMode {
    fn default() -> Self {
        Self::ReadOnly
    }
}

/// 权限策略
///
/// 定义工具执行的权限检查规则。
#[derive(Debug, Clone)]
pub struct PermissionPolicy {
    /// 默认权限模式
    pub default_mode: PermissionMode,
    /// 工具权限要求（覆盖默认值）
    pub tool_requirements: HashMap<String, PermissionMode>,
    /// 工作目录（用于路径检查）
    pub work_dir: Option<std::path::PathBuf>,
}

impl PermissionPolicy {
    /// 创建新的权限策略
    pub fn new(default_mode: PermissionMode) -> Self {
        Self {
            default_mode,
            tool_requirements: HashMap::new(),
            work_dir: None,
        }
    }

    /// 设置工作目录
    pub fn with_work_dir(mut self, work_dir: impl Into<std::path::PathBuf>) -> Self {
        self.work_dir = Some(work_dir.into());
        self
    }

    /// 添加工具权限要求
    pub fn with_tool_requirement(mut self, tool_name: impl Into<String>, mode: PermissionMode) -> Self {
        self.tool_requirements.insert(tool_name.into(), mode);
        self
    }

    /// 获取工具所需的权限级别
    pub fn required_permission(&self, tool_name: &str) -> PermissionMode {
        self.tool_requirements
            .get(tool_name)
            .copied()
            .unwrap_or(self.default_mode)
    }

    /// 检查工具是否允许执行
    ///
    /// 检查逻辑：工具本身的权限需求（builtin_tool_permission）必须被当前权限级别满足。
    /// tool_requirements 可以覆盖工具的默认权限需求。
    pub fn check(&self, tool_name: &str, current_mode: &PermissionMode) -> Result<(), ToolError> {
        // 获取工具本身的默认权限需求
        let builtin_required = builtin_tool_permission(tool_name);

        // 如果策略中有覆盖配置，使用覆盖值
        let required = self.tool_requirements
            .get(tool_name)
            .copied()
            .unwrap_or(builtin_required);

        // 检查当前权限是否满足工具需求
        if current_mode.satisfies(&required) {
            Ok(())
        } else {
            Err(ToolError::PermissionDenied {
                tool: tool_name.to_string(),
                required,
                current: *current_mode,
            })
        }
    }

    /// 检查路径是否在工作区内
    pub fn check_path_in_workspace(&self, path: &std::path::Path) -> bool {
        if let Some(work_dir) = &self.work_dir {
            // 规范化路径
            let canonical_path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                work_dir.join(path)
            };

            // 尝试获取规范路径（可能失败，如路径不存在）
            let Ok(normalized_path) = canonical_path.canonicalize() else {
                // 如果路径不存在，使用原始路径进行前缀检查
                return canonical_path.starts_with(work_dir);
            };

            let Ok(normalized_work_dir) = work_dir.canonicalize() else {
                return false;
            };

            normalized_path.starts_with(&normalized_work_dir)
        } else {
            // 无工作区限制
            true
        }
    }
}

impl Default for PermissionPolicy {
    fn default() -> Self {
        Self::new(PermissionMode::ReadOnly)
    }
}

/// 工具规范
///
/// 定义工具的名称、描述和输入参数 schema。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    /// 工具名称
    pub name: String,
    /// 工具描述
    pub description: String,
    /// 输入参数 JSON Schema
    pub input_schema: Value,
    /// 所需权限级别
    pub required_permission: PermissionMode,
}

impl ToolSpec {
    /// 创建新的工具规范
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        input_schema: Value,
        required_permission: PermissionMode,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema,
            required_permission,
        }
    }

    /// 转换为 ToolDefinition（用于 API 请求）
    pub fn to_tool_definition(&self) -> crate::ai::adapters::ToolDefinition {
        crate::ai::adapters::ToolDefinition {
            name: self.name.clone(),
            description: Some(self.description.clone()),
            input_schema: self.input_schema.clone(),
        }
    }
}

/// 内置工具权限映射
///
/// 定义各内置工具所需的权限级别。
pub fn builtin_tool_permission(tool_name: &str) -> PermissionMode {
    match tool_name {
        // 只读工具
        "read_file" | "glob_search" | "grep_search" | "lsp" => PermissionMode::ReadOnly,

        // 工作区写入工具
        "write_file" | "edit_file" => PermissionMode::WorkspaceWrite,

        // 完全访问工具
        "bash" | "WebFetch" | "WebSearch" => PermissionMode::DangerFullAccess,

        // 其他工具默认为只读
        _ => PermissionMode::ReadOnly,
    }
}

/// 常用工具的 JSON Schema 定义
pub mod schemas {
    use serde_json::json;

    /// read_file 工具 schema
    pub fn read_file() -> serde_json::Value {
        json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {
                    "type": "string",
                    "description": "要读取的文件路径"
                },
                "offset": {
                    "type": "integer",
                    "description": "起始行号（可选）"
                },
                "limit": {
                    "type": "integer",
                    "description": "读取行数限制（可选）"
                }
            }
        })
    }

    /// write_file 工具 schema
    pub fn write_file() -> serde_json::Value {
        json!({
            "type": "object",
            "required": ["path", "content"],
            "properties": {
                "path": {
                    "type": "string",
                    "description": "要写入的文件路径"
                },
                "content": {
                    "type": "string",
                    "description": "文件内容"
                }
            }
        })
    }

    /// edit_file 工具 schema
    pub fn edit_file() -> serde_json::Value {
        json!({
            "type": "object",
            "required": ["path", "old_string", "new_string"],
            "properties": {
                "path": {
                    "type": "string",
                    "description": "要编辑的文件路径"
                },
                "old_string": {
                    "type": "string",
                    "description": "要替换的原始字符串"
                },
                "new_string": {
                    "type": "string",
                    "description": "替换后的新字符串"
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "是否替换所有匹配项（可选）"
                }
            }
        })
    }

    /// glob_search 工具 schema
    pub fn glob_search() -> serde_json::Value {
        json!({
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob 搜索模式（如 **/*.rs）"
                },
                "path": {
                    "type": "string",
                    "description": "搜索目录（可选，默认为工作目录）"
                }
            }
        })
    }

    /// grep_search 工具 schema
    pub fn grep_search() -> serde_json::Value {
        json!({
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "正则表达式搜索模式"
                },
                "path": {
                    "type": "string",
                    "description": "搜索目录（可选，默认为工作目录）"
                },
                "glob": {
                    "type": "string",
                    "description": "文件过滤模式（可选）"
                }
            }
        })
    }
}

/// 获取核心工具规范列表
pub fn core_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec::new(
            "read_file",
            "读取文件内容",
            schemas::read_file(),
            PermissionMode::ReadOnly,
        ),
        ToolSpec::new(
            "write_file",
            "写入文件内容",
            schemas::write_file(),
            PermissionMode::WorkspaceWrite,
        ),
        ToolSpec::new(
            "edit_file",
            "编辑文件内容（字符串替换）",
            schemas::edit_file(),
            PermissionMode::WorkspaceWrite,
        ),
        ToolSpec::new(
            "glob_search",
            "使用 Glob 模式搜索文件",
            schemas::glob_search(),
            PermissionMode::ReadOnly,
        ),
        ToolSpec::new(
            "grep_search",
            "使用正则表达式搜索文件内容",
            schemas::grep_search(),
            PermissionMode::ReadOnly,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_permission_mode_satisfies() {
        // ReadOnly 只能满足 ReadOnly
        assert!(PermissionMode::ReadOnly.satisfies(&PermissionMode::ReadOnly));
        assert!(!PermissionMode::ReadOnly.satisfies(&PermissionMode::WorkspaceWrite));
        assert!(!PermissionMode::ReadOnly.satisfies(&PermissionMode::DangerFullAccess));

        // WorkspaceWrite 可以满足 ReadOnly 和 WorkspaceWrite
        assert!(PermissionMode::WorkspaceWrite.satisfies(&PermissionMode::ReadOnly));
        assert!(PermissionMode::WorkspaceWrite.satisfies(&PermissionMode::WorkspaceWrite));
        assert!(!PermissionMode::WorkspaceWrite.satisfies(&PermissionMode::DangerFullAccess));

        // DangerFullAccess 可以满足所有
        assert!(PermissionMode::DangerFullAccess.satisfies(&PermissionMode::ReadOnly));
        assert!(PermissionMode::DangerFullAccess.satisfies(&PermissionMode::WorkspaceWrite));
        assert!(PermissionMode::DangerFullAccess.satisfies(&PermissionMode::DangerFullAccess));
    }

    #[test]
    fn test_permission_policy_check() {
        let policy = PermissionPolicy::new(PermissionMode::ReadOnly);

        // ReadOnly 模式下允许 read_file
        assert!(policy.check("read_file", &PermissionMode::ReadOnly).is_ok());

        // ReadOnly 模式下不允许 write_file（需要 WorkspaceWrite）
        assert!(policy.check("write_file", &PermissionMode::ReadOnly).is_err());

        // DangerFullAccess 模式下允许所有工具
        assert!(policy.check("bash", &PermissionMode::DangerFullAccess).is_ok());
    }

    #[test]
    fn test_permission_policy_with_tool_requirement() {
        let policy = PermissionPolicy::new(PermissionMode::ReadOnly)
            .with_tool_requirement("read_file", PermissionMode::WorkspaceWrite);

        // 覆盖后的 read_file 需要 WorkspaceWrite
        assert!(policy.check("read_file", &PermissionMode::ReadOnly).is_err());
        assert!(policy.check("read_file", &PermissionMode::WorkspaceWrite).is_ok());
    }

    #[test]
    fn test_tool_error_display() {
        let err = ToolError::NotFound("unknown_tool".to_string());
        assert_eq!(err.to_string(), "工具不存在: unknown_tool");

        let err = ToolError::PermissionDenied {
            tool: "bash".to_string(),
            required: PermissionMode::DangerFullAccess,
            current: PermissionMode::ReadOnly,
        };
        assert!(err.to_string().contains("权限不足"));
    }

    #[test]
    fn test_builtin_tool_permission() {
        assert_eq!(builtin_tool_permission("read_file"), PermissionMode::ReadOnly);
        assert_eq!(builtin_tool_permission("write_file"), PermissionMode::WorkspaceWrite);
        assert_eq!(builtin_tool_permission("bash"), PermissionMode::DangerFullAccess);
    }

    #[test]
    fn test_core_tool_specs() {
        let specs = core_tool_specs();
        assert_eq!(specs.len(), 5);

        // 检查 read_file 规范
        let read_spec = specs.iter().find(|s| s.name == "read_file").unwrap();
        assert_eq!(read_spec.required_permission, PermissionMode::ReadOnly);
        assert!(read_spec.input_schema["required"].as_array().unwrap().contains(&serde_json::json!("path")));
    }
}