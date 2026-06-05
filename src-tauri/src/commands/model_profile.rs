//! 模型 Profile 命令
//!
//! 提供 Profile 连接测试等 Tauri IPC 命令。

use crate::error::Result;
use crate::models::config::ModelProfile;
use crate::services::ModelProfileService;

/// 测试模型 Profile 连接
///
/// 向 Profile 配置的端点发送最小化请求，验证连通性。
/// 返回 `true` 表示端点可达（HTTP 2xx 或 400），`false` 表示不可达。
#[tauri::command]
pub async fn test_model_profile_connection(profile: ModelProfile) -> Result<bool> {
    ModelProfileService::test_connection(&profile).await
}
