/*! 工具执行器 trait 定义
 *
 * 定义所有工具执行器必须实现的接口。
 * 参考 claw-code 的 ToolExecutor trait 设计。
 */

use std::collections::HashMap;
use std::sync::Arc;
use async_trait::async_trait;
use serde_json::Value;

use crate::ai::adapters::ToolDefinition;
use crate::ai::tools::types::{ToolError, PermissionPolicy, PermissionMode, ToolSpec};

/// 工具执行器 trait
///
/// 所有工具执行器必须实现此 trait。
/// 支持异步执行和权限检查。
#[async_trait]
pub trait PolarisToolExecutor: Send + Sync {
    /// 执行工具
    ///
    /// # 参数
    /// - `tool_name`: 工具名称
    /// - `input`: 工具输入参数（JSON Value）
    ///
    /// # 返回
    /// - `Ok(String)`: 工具执行结果（JSON 字符串）
    /// - `Err(ToolError)`: 执行错误
    async fn execute(&self, tool_name: &str, input: &Value) -> Result<String, ToolError>;

    /// 获取可用工具列表
    ///
    /// 返回所有已注册工具的定义，用于发送给 API。
    fn available_tools(&self) -> Vec<ToolDefinition>;

    /// 获取工具规范列表
    ///
    /// 返回所有已注册工具的规范，包含权限信息。
    fn tool_specs(&self) -> Vec<crate::ai::tools::types::ToolSpec>;

    /// 检查工具是否可用
    fn has_tool(&self, name: &str) -> bool;

    /// 获取权限策略
    fn permission_policy(&self) -> &PermissionPolicy;

    /// 检查工具执行权限
    fn check_permission(&self, tool_name: &str) -> Result<(), ToolError> {
        let policy = self.permission_policy();
        let current_mode = policy.default_mode;
        policy.check(tool_name, &current_mode)
    }

    /// 设置权限策略（如果支持）
    fn set_permission_policy(&mut self, policy: PermissionPolicy);

    /// 获取工作目录
    fn work_dir(&self) -> Option<&std::path::Path>;

    /// 设置工作目录（如果支持）
    fn set_work_dir(&mut self, work_dir: std::path::PathBuf);
}

/// 工具执行回调
///
/// 用于在工具执行过程中发送进度更新。
pub type ToolProgressCallback = Arc<dyn Fn(String, Option<u32>) + Send + Sync>;

/// 工具执行上下文
///
/// 包含工具执行所需的所有上下文信息。
pub struct ToolExecutionContext {
    /// 工作目录
    pub work_dir: std::path::PathBuf,
    /// 权限策略
    pub permission_policy: PermissionPolicy,
    /// 进度回调（可选）
    pub progress_callback: Option<ToolProgressCallback>,
    /// 会话 ID（可选，用于事件路由）
    pub session_id: Option<String>,
}

impl ToolExecutionContext {
    /// 创建新的执行上下文
    pub fn new(work_dir: impl Into<std::path::PathBuf>) -> Self {
        Self {
            work_dir: work_dir.into(),
            permission_policy: PermissionPolicy::default(),
            progress_callback: None,
            session_id: None,
        }
    }

    /// 设置权限策略
    pub fn with_permission_policy(mut self, policy: PermissionPolicy) -> Self {
        self.permission_policy = policy;
        self
    }

    /// 设置进度回调
    pub fn with_progress_callback(mut self, callback: ToolProgressCallback) -> Self {
        self.progress_callback = Some(callback);
        self
    }

    /// 设置会话 ID
    pub fn with_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    /// 发送进度更新
    pub fn send_progress(&self, message: String, percent: Option<u32>) {
        if let Some(callback) = &self.progress_callback {
            callback(message, percent);
        }
    }

    /// 解析路径（相对于工作目录）
    pub fn resolve_path(&self, path: &str) -> std::path::PathBuf {
        let p = std::path::Path::new(path);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.work_dir.join(p)
        }
    }

    /// 检查路径是否在工作区内
    pub fn check_path_in_workspace(&self, path: &std::path::Path) -> bool {
        self.permission_policy.check_path_in_workspace(path)
    }
}

/// 工具处理器函数类型
///
/// 定义工具的具体执行逻辑。
pub type ToolHandler = fn(&ToolExecutionContext, &Value) -> Result<String, ToolError>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_tool_execution_context_new() {
        let ctx = ToolExecutionContext::new("/tmp/test");
        assert_eq!(ctx.work_dir, PathBuf::from("/tmp/test"));
        assert!(ctx.session_id.is_none());
        assert!(ctx.progress_callback.is_none());
    }

    #[test]
    fn test_tool_execution_context_with_options() {
        let ctx = ToolExecutionContext::new("/tmp/test")
            .with_session_id("test-session")
            .with_permission_policy(PermissionPolicy::new(crate::ai::tools::types::PermissionMode::WorkspaceWrite));

        assert_eq!(ctx.session_id, Some("test-session".to_string()));
        assert_eq!(ctx.permission_policy.default_mode, crate::ai::tools::types::PermissionMode::WorkspaceWrite);
    }

    #[test]
    fn test_resolve_path() {
        let ctx = ToolExecutionContext::new("/tmp/test");

        // 绝对路径保持不变
        let abs = ctx.resolve_path("/absolute/path");
        assert_eq!(abs, PathBuf::from("/absolute/path"));

        // 相对路径添加工作目录前缀
        let rel = ctx.resolve_path("relative/path");
        assert_eq!(rel, PathBuf::from("/tmp/test/relative/path"));
    }
}

/// 基础工具执行器
///
/// 提供简单的工具注册和执行机制。
/// 支持：
/// - 工具注册（register_tool）
/// - 权限检查（permission_policy）
/// - 异步执行（execute）
pub struct BasicToolExecutor {
    /// 工具注册表
    tools: HashMap<String, ToolHandler>,
    /// 工具规范注册表
    tool_specs: HashMap<String, ToolSpec>,
    /// 权限策略
    permission_policy: PermissionPolicy,
    /// 工作目录
    work_dir: std::path::PathBuf,
}

impl BasicToolExecutor {
    /// 创建新的基础工具执行器
    ///
    /// 默认使用 ReadOnly 权限模式。
    pub fn new(work_dir: impl Into<std::path::PathBuf>) -> Self {
        let work_dir = work_dir.into();
        Self {
            tools: HashMap::new(),
            tool_specs: HashMap::new(),
            permission_policy: PermissionPolicy::new(PermissionMode::ReadOnly)
                .with_work_dir(&work_dir),
            work_dir,
        }
    }

    /// 注册工具
    ///
    /// # 参数
    /// - `spec`: 工具规范（名称、描述、schema）
    /// - `handler`: 工具执行处理器函数
    pub fn register_tool(&mut self, spec: ToolSpec, handler: ToolHandler) {
        let name = spec.name.clone();
        self.tools.insert(name.clone(), handler);
        self.tool_specs.insert(name, spec);
    }

    /// 注册内置工具
    ///
    /// 注册 core_tool_specs() 中定义的核心工具。
    pub fn register_builtin_tools(&mut self) {
        for spec in crate::ai::tools::types::core_tool_specs() {
            let name = spec.name.clone();
            let handler = match name.as_str() {
                "read_file" => Self::handle_read_file,
                "write_file" => Self::handle_write_file,
                "edit_file" => Self::handle_edit_file,
                "glob_search" => Self::handle_glob_search,
                "grep_search" => Self::handle_grep_search,
                _ => continue,
            };
            self.register_tool(spec, handler);
        }
    }

    /// 设置权限模式
    pub fn with_permission_mode(mut self, mode: PermissionMode) -> Self {
        self.permission_policy = PermissionPolicy::new(mode)
            .with_work_dir(&self.work_dir);
        self
    }

    /// 设置工作目录
    pub fn with_work_dir(mut self, work_dir: impl Into<std::path::PathBuf>) -> Self {
        self.work_dir = work_dir.into();
        self.permission_policy = self.permission_policy.clone().with_work_dir(&self.work_dir);
        self
    }

    /// 内置工具处理器：read_file
    fn handle_read_file(ctx: &ToolExecutionContext, input: &Value) -> Result<String, ToolError> {
        let path = input["path"].as_str()
            .ok_or_else(|| ToolError::InvalidInput("缺少 path 参数".to_string()))?;

        let resolved_path = ctx.resolve_path(path);

        // 检查路径在工作区内
        if !ctx.check_path_in_workspace(&resolved_path) {
            return Err(ToolError::PermissionDenied {
                tool: "read_file".to_string(),
                required: PermissionMode::ReadOnly,
                current: PermissionMode::ReadOnly,
            });
        }

        // 模拟实现：返回提示信息
        // 完整实现需要实际文件读取逻辑
        Ok(format!("读取文件: {}", resolved_path.display()))
    }

    /// 内置工具处理器：write_file
    fn handle_write_file(ctx: &ToolExecutionContext, input: &Value) -> Result<String, ToolError> {
        let path = input["path"].as_str()
            .ok_or_else(|| ToolError::InvalidInput("缺少 path 参数".to_string()))?;
        let _content = input["content"].as_str()
            .ok_or_else(|| ToolError::InvalidInput("缺少 content 参数".to_string()))?;

        let resolved_path = ctx.resolve_path(path);

        // 检查路径在工作区内
        if !ctx.check_path_in_workspace(&resolved_path) {
            return Err(ToolError::PermissionDenied {
                tool: "write_file".to_string(),
                required: PermissionMode::WorkspaceWrite,
                current: PermissionMode::ReadOnly,
            });
        }

        // 模拟实现：返回提示信息
        Ok(format!("写入文件: {}", resolved_path.display()))
    }

    /// 内置工具处理器：edit_file
    fn handle_edit_file(ctx: &ToolExecutionContext, input: &Value) -> Result<String, ToolError> {
        let path = input["path"].as_str()
            .ok_or_else(|| ToolError::InvalidInput("缺少 path 参数".to_string()))?;
        let _old_string = input["old_string"].as_str()
            .ok_or_else(|| ToolError::InvalidInput("缺少 old_string 参数".to_string()))?;
        let _new_string = input["new_string"].as_str()
            .ok_or_else(|| ToolError::InvalidInput("缺少 new_string 参数".to_string()))?;

        let resolved_path = ctx.resolve_path(path);

        // 检查路径在工作区内
        if !ctx.check_path_in_workspace(&resolved_path) {
            return Err(ToolError::PermissionDenied {
                tool: "edit_file".to_string(),
                required: PermissionMode::WorkspaceWrite,
                current: PermissionMode::ReadOnly,
            });
        }

        // 模拟实现：返回提示信息
        Ok(format!("编辑文件: {}", resolved_path.display()))
    }

    /// 内置工具处理器：glob_search
    fn handle_glob_search(ctx: &ToolExecutionContext, input: &Value) -> Result<String, ToolError> {
        let pattern = input["pattern"].as_str()
            .ok_or_else(|| ToolError::InvalidInput("缺少 pattern 参数".to_string()))?;
        let _path = input["path"].as_str();

        // 模拟实现：返回提示信息
        Ok(format!("Glob 搜索: {} (工作目录: {})", pattern, ctx.work_dir.display()))
    }

    /// 内置工具处理器：grep_search
    fn handle_grep_search(ctx: &ToolExecutionContext, input: &Value) -> Result<String, ToolError> {
        let pattern = input["pattern"].as_str()
            .ok_or_else(|| ToolError::InvalidInput("缺少 pattern 参数".to_string()))?;

        // 模拟实现：返回提示信息
        Ok(format!("Grep 搜索: {} (工作目录: {})", pattern, ctx.work_dir.display()))
    }
}

#[async_trait]
impl PolarisToolExecutor for BasicToolExecutor {
    async fn execute(&self, tool_name: &str, input: &Value) -> Result<String, ToolError> {
        // 检查工具是否存在
        let handler = self.tools.get(tool_name)
            .ok_or_else(|| ToolError::NotFound(tool_name.to_string()))?;

        // 检查权限
        self.check_permission(tool_name)?;

        // 创建执行上下文
        let ctx = ToolExecutionContext::new(&self.work_dir)
            .with_permission_policy(self.permission_policy.clone());

        // 执行工具（同步调用，包装为异步）
        let result = handler(&ctx, input);
        async move { result }.await
    }

    fn available_tools(&self) -> Vec<ToolDefinition> {
        self.tool_specs.values()
            .map(|spec| spec.to_tool_definition())
            .collect()
    }

    fn tool_specs(&self) -> Vec<ToolSpec> {
        self.tool_specs.values().cloned().collect()
    }

    fn has_tool(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    fn permission_policy(&self) -> &PermissionPolicy {
        &self.permission_policy
    }

    fn set_permission_policy(&mut self, policy: PermissionPolicy) {
        self.permission_policy = policy;
    }

    fn work_dir(&self) -> Option<&std::path::Path> {
        Some(&self.work_dir)
    }

    fn set_work_dir(&mut self, work_dir: std::path::PathBuf) {
        self.work_dir = work_dir.clone();
        self.permission_policy = self.permission_policy.clone().with_work_dir(&work_dir);
    }
}

#[cfg(test)]
mod basic_executor_tests {
    use super::*;

    #[test]
    fn test_basic_executor_new() {
        let executor = BasicToolExecutor::new("/tmp/test");
        assert!(executor.work_dir().is_some());
        assert_eq!(executor.permission_policy().default_mode, PermissionMode::ReadOnly);
        assert!(!executor.has_tool("read_file"));
    }

    #[test]
    fn test_basic_executor_register_builtin_tools() {
        let mut executor = BasicToolExecutor::new("/tmp/test");
        executor.register_builtin_tools();

        assert!(executor.has_tool("read_file"));
        assert!(executor.has_tool("write_file"));
        assert!(executor.has_tool("edit_file"));
        assert!(executor.has_tool("glob_search"));
        assert!(executor.has_tool("grep_search"));
    }

    #[test]
    fn test_basic_executor_available_tools() {
        let mut executor = BasicToolExecutor::new("/tmp/test");
        executor.register_builtin_tools();

        let tools = executor.available_tools();
        assert_eq!(tools.len(), 5);

        // 检查 read_file 定义
        let read_def = tools.iter().find(|t| t.name == "read_file").unwrap();
        assert!(read_def.description.is_some());
    }

    #[test]
    fn test_basic_executor_with_permission_mode() {
        let executor = BasicToolExecutor::new("/tmp/test")
            .with_permission_mode(PermissionMode::WorkspaceWrite);

        assert_eq!(executor.permission_policy().default_mode, PermissionMode::WorkspaceWrite);
    }

    #[tokio::test]
    async fn test_basic_executor_execute_not_found() {
        let executor = BasicToolExecutor::new("/tmp/test");

        let result = executor.execute("unknown_tool", &serde_json::json!({})).await;
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)));
    }

    #[tokio::test]
    async fn test_basic_executor_execute_read_file() {
        let mut executor = BasicToolExecutor::new("/tmp/test");
        executor.register_builtin_tools();

        let input = serde_json::json!({
            "path": "test.txt"
        });

        let result = executor.execute("read_file", &input).await;
        // 因为是模拟实现，应该成功
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("读取文件"));
    }

    #[tokio::test]
    async fn test_basic_executor_execute_write_file_permission_denied() {
        // ReadOnly 模式下，write_file 需要 WorkspaceWrite 权限
        let mut executor = BasicToolExecutor::new("/tmp/test");
        executor.register_builtin_tools();

        let input = serde_json::json!({
            "path": "test.txt",
            "content": "hello"
        });

        let result = executor.execute("write_file", &input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_basic_executor_execute_write_file_with_permission() {
        // WorkspaceWrite 模式下，write_file 应成功
        let mut executor = BasicToolExecutor::new("/tmp/test")
            .with_permission_mode(PermissionMode::WorkspaceWrite);
        executor.register_builtin_tools();

        let input = serde_json::json!({
            "path": "test.txt",
            "content": "hello"
        });

        let result = executor.execute("write_file", &input).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("写入文件"));
    }

    #[test]
    fn test_basic_executor_set_permission_policy() {
        let mut executor = BasicToolExecutor::new("/tmp/test");
        executor.register_builtin_tools();

        let new_policy = PermissionPolicy::new(PermissionMode::DangerFullAccess);
        executor.set_permission_policy(new_policy);

        assert_eq!(executor.permission_policy().default_mode, PermissionMode::DangerFullAccess);
    }

    #[test]
    fn test_basic_executor_set_work_dir() {
        let mut executor = BasicToolExecutor::new("/tmp/test");
        executor.set_work_dir(std::path::PathBuf::from("/new/work/dir"));

        assert_eq!(executor.work_dir(), Some(std::path::Path::new("/new/work/dir")));
    }
}