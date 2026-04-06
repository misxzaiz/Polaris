/*! 工具系统模块
 *
 * 提供工具执行器 trait 和基础工具实现。
 * 参考 claw-code 的 ToolExecutor 设计。
 */

pub mod types;
pub mod executor;

pub use types::{ToolError, PermissionMode, PermissionPolicy, ToolSpec};
pub use executor::{PolarisToolExecutor, BasicToolExecutor, ToolExecutionContext, ToolHandler};