/*! 模型 Profile 服务
 *
 * 管理第三方 Anthropic 兼容端点的模型配置。
 * 核心功能：根据 Profile 生成 settings overlay 文件和环境变量覆盖，
 * 用于将 Claude Code CLI 的请求路由到非官方模型端点。
 */

use crate::error::Result;
use crate::models::config::ModelProfile;
use std::collections::HashMap;
use std::path::PathBuf;

/// 模型 Profile 服务
pub struct ModelProfileService;

impl ModelProfileService {
    /// 根据 Profile 生成 settings overlay JSON 内容
    ///
    /// 覆盖所有五个模型变体（MODEL / HAIKU / OPUS / SONNET / REASONING）
    /// 确保无论 CLI 内部选择哪个变体，都路由到用户指定的模型。
    pub fn generate_settings_overlay(profile: &ModelProfile) -> serde_json::Value {
        serde_json::json!({
            "model": profile.model,
            "env": {
                "ANTHROPIC_MODEL": profile.model,
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": profile.model,
                "ANTHROPIC_DEFAULT_OPUS_MODEL": profile.model,
                "ANTHROPIC_DEFAULT_SONNET_MODEL": profile.model,
                "ANTHROPIC_REASONING_MODEL": profile.model,
                "ANTHROPIC_BASE_URL": profile.base_url,
                "ANTHROPIC_AUTH_TOKEN": profile.api_key,
            }
        })
    }

    /// 将 settings overlay 写入临时文件并返回文件路径
    ///
    /// 文件路径使用 Profile ID 隔离，避免多 Profile 冲突。
    /// 写入平台临时目录，随系统清理自动删除。
    pub fn write_settings_overlay(profile: &ModelProfile) -> Result<PathBuf> {
        let overlay = Self::generate_settings_overlay(profile);
        let json_str = serde_json::to_string_pretty(&overlay)
            .map_err(|e| crate::error::AppError::ProcessError(
                format!("序列化 settings overlay 失败: {}", e)
            ))?;

        let temp_dir = std::env::temp_dir();
        let file_name = format!("polaris-model-settings-{}.json", profile.id);
        let path = temp_dir.join(&file_name);

        std::fs::write(&path, json_str)
            .map_err(|e| crate::error::AppError::ProcessError(
                format!("写入 settings overlay 文件失败: {}", e)
            ))?;

        tracing::info!("[ModelProfileService] 写入 settings overlay: {:?}", path);
        Ok(path)
    }

    /// 根据 Profile 生成环境变量覆盖映射
    ///
    /// 用于注入到 Claude Code CLI 子进程的环境中
    pub fn generate_env_overrides(profile: &ModelProfile) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_MODEL".to_string(), profile.model.clone());
        env.insert("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(), profile.model.clone());
        env.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), profile.model.clone());
        env.insert("ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(), profile.model.clone());
        env.insert("ANTHROPIC_REASONING_MODEL".to_string(), profile.model.clone());
        env.insert("ANTHROPIC_BASE_URL".to_string(), profile.base_url.clone());
        env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), profile.api_key.clone());
        env
    }

    /// 清理指定 Profile 的 settings overlay 临时文件
    pub fn cleanup_settings_overlay(profile_id: &str) -> Result<()> {
        let temp_dir = std::env::temp_dir();
        let file_name = format!("polaris-model-settings-{}.json", profile_id);
        let path = temp_dir.join(&file_name);

        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| crate::error::AppError::ProcessError(
                    format!("删除 settings overlay 文件失败: {}", e)
                ))?;
            tracing::info!("[ModelProfileService] 清理 settings overlay: {:?}", path);
        }
        Ok(())
    }

    /// 测试 Profile 连接是否可用
    ///
    /// 尝试向 Profile 配置的端点发送简单请求验证连通性
    pub async fn test_connection(profile: &ModelProfile) -> Result<bool> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| crate::error::AppError::ProcessError(
                format!("创建 HTTP 客户端失败: {}", e)
            ))?;

        // 构建 messages 端点 URL
        let url = if profile.base_url.ends_with('/') {
            format!("{}v1/messages", profile.base_url)
        } else {
            format!("{}/v1/messages", profile.base_url)
        };

        // 发送最小化请求测试连通性
        let response = client
            .post(&url)
            .header("x-api-key", &profile.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&serde_json::json!({
                "model": profile.model,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            }))
            .send()
            .await;

        match response {
            Ok(resp) => {
                let status = resp.status();
                tracing::info!(
                    "[ModelProfileService] 连接测试: {} -> status {}",
                    profile.base_url,
                    status
                );
                // 200-299 或 400（模型参数错误但连接成功）都算连通
                Ok(status.is_success() || status.as_u16() == 400)
            }
            Err(e) => {
                tracing::warn!("[ModelProfileService] 连接测试失败: {}", e);
                Ok(false)
            }
        }
    }
}