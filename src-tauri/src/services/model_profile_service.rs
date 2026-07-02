/*! 模型 Profile 服务
 *
 * 管理第三方 Anthropic 兼容端点的模型配置。
 * 核心功能：根据 Profile 生成 settings overlay 文件和环境变量覆盖，
 * 用于将 Claude Code CLI 的请求路由到非官方模型端点。
 */

use crate::ai::EnvKeyMapping;
use crate::error::Result;
use crate::models::config::ModelProfile;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;

/// 连接测试结果
///
/// 相比此前的 `bool`，额外携带 HTTP 状态码与错误体摘要，
/// 使前端能区分鉴权失败(401/403)、路径错误(404)、服务端错误(5xx)与网络不可达。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    /// 是否连通（HTTP 2xx 或 400 视为端点可达）
    pub ok: bool,
    /// HTTP 状态码；网络层失败（无响应）时为 None
    pub status: Option<u16>,
    /// 失败详情：错误体摘要或网络错误信息；成功时为 None
    pub detail: Option<String>,
}

impl ConnectionTestResult {
    /// 网络层失败（无 HTTP 响应）构造器
    fn network_error(detail: String) -> Self {
        Self {
            ok: false,
            status: None,
            detail: Some(detail),
        }
    }
}

/// 模型 Profile 服务
pub struct ModelProfileService;

impl ModelProfileService {
    /// 判断 Profile 是否使用 OpenAI Chat Completions 线路格式
    pub fn is_openai_wire_api(profile: &ModelProfile) -> bool {
        profile.wire_api.as_deref() == Some("openai-chat-completions")
    }

    /// 生成代理模式的 settings overlay
    ///
    /// 当 Profile 使用 OpenAI Chat Completions 格式时，ANTHROPIC_BASE_URL 指向
    /// 本地代理服务器，API key 由代理内部管理（使用占位符）。
    pub fn generate_proxy_settings_overlay(
        profile: &ModelProfile,
        proxy_addr: SocketAddr,
    ) -> serde_json::Value {
        serde_json::json!({
            "model": profile.model,
            "env": {
                "ANTHROPIC_MODEL": profile.model,
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": profile.model,
                "ANTHROPIC_DEFAULT_OPUS_MODEL": profile.model,
                "ANTHROPIC_DEFAULT_SONNET_MODEL": profile.model,
                "ANTHROPIC_REASONING_MODEL": profile.model,
                "ANTHROPIC_BASE_URL": format!("http://{}", proxy_addr),
                "ANTHROPIC_AUTH_TOKEN": "PROXY_MANAGED",
            }
        })
    }

    /// 将代理模式的 settings overlay 写入临时文件
    pub fn write_proxy_settings_overlay(
        profile: &ModelProfile,
        proxy_addr: SocketAddr,
    ) -> Result<PathBuf> {
        let overlay = Self::generate_proxy_settings_overlay(profile, proxy_addr);
        let json_str = serde_json::to_string_pretty(&overlay).map_err(|e| {
            crate::error::AppError::ProcessError(format!("序列化 proxy settings overlay 失败: {}", e))
        })?;

        let temp_dir = std::env::temp_dir();
        let file_name = format!("polaris-model-settings-{}.json", profile.id);
        let path = temp_dir.join(&file_name);

        std::fs::write(&path, json_str).map_err(|e| {
            crate::error::AppError::ProcessError(format!("写入 proxy settings overlay 文件失败: {}", e))
        })?;

        tracing::info!("[ModelProfileService] 写入 proxy settings overlay: {:?}", path);
        Ok(path)
    }

    /// 根据 Profile 生成 settings overlay JSON 内容
    ///
    /// 覆盖所有五个模型变体（MODEL / HAIKU / OPUS / SONNET / REASONING）
    /// 确保无论 CLI 内部选择哪个变体，都路由到用户指定的模型。
    pub fn generate_settings_overlay(profile: &ModelProfile) -> serde_json::Value {
        // 与 generate_env_overrides 保持一致（含 authType 与 customEnv）
        let env = Self::generate_env_overrides(profile);
        serde_json::json!({
            "model": profile.model,
            "env": env,
        })
    }

    /// 将 settings overlay 写入临时文件并返回文件路径
    ///
    /// 文件路径使用 Profile ID 隔离，避免多 Profile 冲突。
    /// 写入平台临时目录，随系统清理自动删除。
    pub fn write_settings_overlay(profile: &ModelProfile) -> Result<PathBuf> {
        let overlay = Self::generate_settings_overlay(profile);
        let json_str = serde_json::to_string_pretty(&overlay).map_err(|e| {
            crate::error::AppError::ProcessError(format!("序列化 settings overlay 失败: {}", e))
        })?;

        let temp_dir = std::env::temp_dir();
        let file_name = format!("polaris-model-settings-{}.json", profile.id);
        let path = temp_dir.join(&file_name);

        std::fs::write(&path, json_str).map_err(|e| {
            crate::error::AppError::ProcessError(format!("写入 settings overlay 文件失败: {}", e))
        })?;

        tracing::info!("[ModelProfileService] 写入 settings overlay: {:?}", path);
        Ok(path)
    }

    /// 根据 Profile 生成环境变量覆盖映射（引擎感知版本）。
    ///
    /// 使用引擎元数据中的 `EnvKeyMapping` 确定正确的环境变量名，
    /// 而非硬编码 ANTHROPIC_*。Claude Code 使用 5 槽位模型映射，
    /// 其他引擎使用单模型 key。
    pub fn generate_env_overrides_for_engine(
        profile: &ModelProfile,
        env_keys: &EnvKeyMapping,
    ) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert(env_keys.base_url.to_string(), profile.base_url.clone());

        // Claude Code 专属：展开主模型到所有 5 个模型槽位
        if env_keys.base_url == "ANTHROPIC_BASE_URL" {
            for model_key in &[
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_REASONING_MODEL",
            ] {
                env.insert(model_key.to_string(), profile.model.clone());
            }
        } else {
            env.insert(env_keys.model.to_string(), profile.model.clone());
        }

        // 按认证方式注入鉴权变量（引擎感知）
        let auth_type = profile.auth_type.as_deref().unwrap_or("auth_token");
        match auth_type {
            "api_key" => {
                env.insert("ANTHROPIC_API_KEY".to_string(), profile.api_key.clone());
            }
            "custom_env" => {
                let name = profile
                    .api_key_env_name
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(env_keys.api_key);
                env.insert(name.to_string(), profile.api_key.clone());
            }
            "none" => {}
            _ => {
                env.insert(env_keys.api_key.to_string(), profile.api_key.clone());
            }
        }

        // 合并用户自定义环境变量（可覆盖上述默认）
        if let Some(custom) = &profile.custom_env {
            for (k, v) in custom {
                env.insert(k.clone(), v.clone());
            }
        }
        env
    }

    /// 根据 Profile 生成环境变量覆盖映射
    ///
    /// 用于注入到 Claude Code CLI 子进程的环境中。
    /// 向后兼容方法：内部调用 `generate_env_overrides_for_engine` 并使用 Claude 的 env key。
    pub fn generate_env_overrides(profile: &ModelProfile) -> HashMap<String, String> {
        let claude_keys = EnvKeyMapping {
            base_url: "ANTHROPIC_BASE_URL",
            api_key: "ANTHROPIC_AUTH_TOKEN",
            model: "ANTHROPIC_MODEL",
        };
        Self::generate_env_overrides_for_engine(profile, &claude_keys)
    }

    /// 根据 Profile 生成 Codex CLI provider 配置参数。
    ///
    /// Codex 0.125+ 仅支持 Responses wire API，因此该配置要求第三方端点
    /// 兼容 `/v1/responses`。只兼容 Chat Completions 的端点无法直接用于 Codex CLI。
    pub fn generate_codex_config_args(profile: &ModelProfile) -> Vec<String> {
        let provider_id = Self::codex_provider_id(profile);
        let env_key = Self::codex_api_key_env(profile);
        // Codex 仅支持 OpenAI 风格线路：chat-completions → "chat"，其余默认 "responses"
        let codex_wire = match profile.wire_api.as_deref() {
            Some("openai-chat-completions") => "chat",
            _ => "responses",
        };

        vec![
            "-c".to_string(),
            format!(
                "model_provider={}",
                toml_string(&provider_id).unwrap_or_else(|_| format!("\"{}\"", provider_id))
            ),
            "-c".to_string(),
            format!(
                "model_providers.{}.name={}",
                provider_id,
                toml_string(&profile.name).unwrap_or_else(|_| format!("\"{}\"", profile.name))
            ),
            "-c".to_string(),
            format!(
                "model_providers.{}.base_url={}",
                provider_id,
                toml_string(&profile.base_url)
                    .unwrap_or_else(|_| format!("\"{}\"", profile.base_url))
            ),
            "-c".to_string(),
            format!(
                "model_providers.{}.env_key={}",
                provider_id,
                toml_string(&env_key).unwrap_or_else(|_| format!("\"{}\"", env_key))
            ),
            "-c".to_string(),
            format!("model_providers.{}.wire_api=\"{}\"", provider_id, codex_wire),
        ]
    }

    /// 根据 Profile 生成 Codex CLI 所需环境变量。
    pub fn generate_codex_env_overrides(profile: &ModelProfile) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert(Self::codex_api_key_env(profile), profile.api_key.clone());
        env
    }

    fn codex_provider_id(profile: &ModelProfile) -> String {
        let sanitized: String = profile
            .id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' {
                    c.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .collect();

        let trimmed = sanitized.trim_matches('_');
        if trimmed.is_empty() {
            "polaris_profile".to_string()
        } else {
            format!("polaris_{}", trimmed)
        }
    }

    fn codex_api_key_env(profile: &ModelProfile) -> String {
        Self::codex_provider_id(profile).to_ascii_uppercase() + "_API_KEY"
    }

    /// 生成 Codex 代理转换模式的 provider 参数。
    ///
    /// Codex CLI 始终请求本地 `/v1/responses`，Polaris 代理将其转换到上游 Chat Completions 端点。
    /// 同时注入模型目录（model_catalog_json），避免"Model metadata not found"警告。
    /// 模型目录路径使用绝对路径，因为 -c 命令行参数没有配置文件目录上下文，
    /// 相对路径会被解析为当前工作目录而非 ~/.codex/。
    pub fn generate_codex_proxy_config_args(
        profile: &ModelProfile,
        proxy_addr: SocketAddr,
    ) -> Vec<String> {
        let provider_id = Self::codex_provider_id(profile);
        let env_key = Self::codex_api_key_env(profile);
        let base_url = format!("http://{}/v1", proxy_addr);
        let catalog_abs_path = Self::codex_config_dir()
            .join(Self::CODEX_MODEL_CATALOG_FILENAME)
            .to_string_lossy()
            .replace('\\', "\\\\");

        vec![
            "-c".to_string(),
            format!(
                "model_provider={}",
                toml_string(&provider_id).unwrap_or_else(|_| format!("\"{}\"", provider_id))
            ),
            "-c".to_string(),
            format!(
                "model_providers.{}.name={}",
                provider_id,
                toml_string(&profile.name).unwrap_or_else(|_| format!("\"{}\"", profile.name))
            ),
            "-c".to_string(),
            format!(
                "model_providers.{}.base_url={}",
                provider_id,
                toml_string(&base_url).unwrap_or_else(|_| format!("\"{}\"", base_url))
            ),
            "-c".to_string(),
            format!(
                "model_providers.{}.env_key={}",
                provider_id,
                toml_string(&env_key).unwrap_or_else(|_| format!("\"{}\"", env_key))
            ),
            "-c".to_string(),
            format!("model_providers.{}.wire_api=\"responses\"", provider_id),
            // 注入模型目录指针（使用绝对路径，因 -c 参数无文件目录上下文），
            // 让 Codex 获取准确的模型元数据
            "-c".to_string(),
            format!("model_catalog_json=\"{}\"", catalog_abs_path),
        ]
    }

    /// 生成 Codex 代理转换模式的环境变量覆盖。
    pub fn generate_codex_proxy_env_overrides(profile: &ModelProfile) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert(Self::codex_api_key_env(profile), "PROXY_MANAGED".to_string());
        if let Some(custom) = &profile.custom_env {
            for (k, v) in custom {
                env.insert(k.clone(), v.clone());
            }
        }
        env
    }

    // ========================================================================
    // Codex 模型目录（Model Catalog）
    //
    // Codex CLI 需要模型目录文件来获得模型元数据（context_window、tools 支持、
    // reasoning 能力等）。对于非 OpenAI 模型，如果不提供该文件，Codex 会报
    // "Model metadata not found" 警告并使用 fallback 默认值。
    //
    // 该文件写入 ~/.codex/polaris-model-catalog.json，通过 config.toml 的
    // model_catalog_json 字段指向它。参考 cc-switch 的实现。
    // ========================================================================

    /// Codex 模型目录文件名
    pub const CODEX_MODEL_CATALOG_FILENAME: &str = "polaris-model-catalog.json";

    /// 获取 ~/.codex/ 目录路径
    fn codex_config_dir() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".codex")
    }

    /// 为 Codex 代理模式生成模型目录文件。
    ///
    /// 该文件告诉 Codex CLI 模型的元数据（context_window、tools 支持等），
    /// 避免 "Model metadata not found" 警告和回退行为。
    ///
    /// 写入 `~/.codex/polaris-model-catalog.json`，每次调用重新生成。
    pub fn write_codex_proxy_model_catalog(profile: &ModelProfile) -> Result<PathBuf> {
        let codex_dir = Self::codex_config_dir();
        let catalog_path = codex_dir.join(Self::CODEX_MODEL_CATALOG_FILENAME);

        let catalog = serde_json::json!({
            "models": [{
                "slug": profile.model,
                "display_name": profile.name,
                "description": format!("{} - {}", profile.name, profile.model),
                "context_window": 128000,
                "max_context_window": 128000,
                "effective_context_window_percent": 95,
                "supports_parallel_tool_calls": true,
                "shell_type": "shell_command",
                "apply_patch_tool_type": "freeform",
                "supported_reasoning_levels": [
                    {"effort": "low", "description": "Fast responses with lighter reasoning"},
                    {"effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks"},
                    {"effort": "high", "description": "Greater reasoning depth for complex problems"}
                ],
                "default_reasoning_level": "medium",
                "visibility": "list",
                "supported_in_api": true,
                "priority": 500,
                "additional_speed_tiers": [],
                "service_tiers": [],
                "upgrade": null,
                "availability_nux": null,
                "input_modalities": ["text"],
                "supports_search_tool": false,
                "supports_reasoning_summaries": true,
                "support_verbosity": false,
                "supports_image_detail_original": false,
                "base_instructions": "You are Codex, a coding agent. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.\n\nYou are an expert software engineer with deep knowledge across the full stack. You are proactive, thorough, and focused on delivering working solutions. You read the codebase carefully, resist easy assumptions, and let the shape of the existing system teach you how to move.\n\nYou parallelize tool calls whenever you can, especially file reads. You prefer the repo's existing patterns, frameworks, and local helper APIs over inventing new abstractions.",
                "truncation_policy": {
                    "mode": "bytes",
                    "limit": 10000
                },
                "experimental_supported_tools": []
            }]
        });

        // 确保 ~/.codex/ 目录存在
        if let Some(parent) = catalog_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                crate::error::AppError::ProcessError(format!("创建 Codex 配置目录失败: {}", e))
            })?;
        }

        let content = serde_json::to_string_pretty(&catalog).map_err(|e| {
            crate::error::AppError::ProcessError(format!("序列化 Codex 模型目录失败: {}", e))
        })?;
        std::fs::write(&catalog_path, &content).map_err(|e| {
            crate::error::AppError::ProcessError(format!("写入 Codex 模型目录失败: {}", e))
        })?;

        tracing::info!(
            "[ModelProfileService] 写入 Codex 模型目录: {:?} (model={})",
            catalog_path,
            profile.model
        );
        Ok(catalog_path)
    }

    /// 清理 Codex 模型目录文件
    pub fn cleanup_codex_model_catalog() -> Result<()> {
        let catalog_path = Self::codex_config_dir().join(Self::CODEX_MODEL_CATALOG_FILENAME);
        if catalog_path.exists() {
            std::fs::remove_file(&catalog_path).map_err(|e| {
                crate::error::AppError::ProcessError(format!("清理 Codex 模型目录失败: {}", e))
            })?;
            tracing::info!("[ModelProfileService] 清理 Codex 模型目录: {:?}", catalog_path);
        }
        Ok(())
    }

    // ========================================================================
    // 配置级联（Configuration Cascade）
    //
    // 当用户通过设置页面修改模型供应商配置后，这些方法将凭证同步到
    // agent 的原生配置文件，使用户无需手动编辑 CLI 配置。
    // ========================================================================

    /// 将激活的 Profile 凭证级联写入 Claude Code 的原生配置文件。
    ///
    /// 文件路径：`~/.claude/settings.json`（跨平台一致）。
    /// 写入前备份原文件（`.bak`），仅更新 `config.env` 节，
    /// 保留用户手工编辑的其他配置。
    pub fn cascade_to_claude_settings(profile: &ModelProfile) -> Result<()> {
        let claude_config_dir = dirs::config_dir()
            .ok_or_else(|| {
                crate::error::AppError::ConfigError("无法获取用户配置目录".to_string())
            })?
            .join("claude");

        let settings_path = claude_config_dir.join("settings.json");

        // 读取现有 settings.json（可能不存在）
        let mut settings: serde_json::Value = if settings_path.exists() {
            let raw = std::fs::read_to_string(&settings_path).map_err(|e| {
                crate::error::AppError::ProcessError(format!(
                    "读取 Claude settings.json 失败: {}",
                    e
                ))
            })?;
            serde_json::from_str(&raw).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        // 备份原文件
        if settings_path.exists() {
            let bak_path = settings_path.with_extension("json.bak");
            if let Err(e) = std::fs::copy(&settings_path, &bak_path) {
                tracing::warn!(
                    "[ModelProfileService] 备份 Claude settings.json 失败: {}",
                    e
                );
            }
        }

        // 确保父目录存在
        if let Some(parent) = settings_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                crate::error::AppError::ProcessError(format!(
                    "创建 Claude 配置目录失败: {}",
                    e
                ))
            })?;
        }

        // 将环境变量覆盖写入 config.env
        let env_overrides = Self::generate_env_overrides(profile);
        let env_map: serde_json::Map<String, serde_json::Value> = env_overrides
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::String(v)))
            .collect();

        if let Some(config) = settings.as_object_mut() {
            config.insert(
                "env".to_string(),
                serde_json::Value::Object(env_map),
            );
        } else {
            // settings 不是 object（极端情况），重建
            settings = serde_json::json!({ "env": env_map });
        }

        // 原子写入（先写临时文件再 rename）
        let tmp_path = settings_path.with_extension("json.tmp");
        let pretty = serde_json::to_string_pretty(&settings).map_err(|e| {
            crate::error::AppError::ProcessError(format!(
                "序列化 Claude settings.json 失败: {}",
                e
            ))
        })?;
        std::fs::write(&tmp_path, &pretty).map_err(|e| {
            crate::error::AppError::ProcessError(format!(
                "写入 Claude settings.json 临时文件失败: {}",
                e
            ))
        })?;
        std::fs::rename(&tmp_path, &settings_path).map_err(|e| {
            crate::error::AppError::ProcessError(format!(
                "替换 Claude settings.json 失败: {}",
                e
            ))
        })?;

        tracing::info!(
            "[ModelProfileService] 已级联写入 Claude settings.json: {} (model={})",
            settings_path.display(),
            profile.model
        );
        Ok(())
    }

    /// 清除 Claude Code settings.json 中由 Polaris 管理的配置节。
    ///
    /// 在删除所有 ModelProfile 时调用，恢复用户手工配置。
    /// 仅移除 `env` 键，保留其他配置不变。
    pub fn clear_claude_settings_env() -> Result<()> {
        let settings_path = dirs::config_dir()
            .ok_or_else(|| {
                crate::error::AppError::ConfigError("无法获取用户配置目录".to_string())
            })?
            .join("claude")
            .join("settings.json");

        if !settings_path.exists() {
            return Ok(());
        }

        let raw = std::fs::read_to_string(&settings_path).map_err(|e| {
            crate::error::AppError::ProcessError(format!("读取 Claude settings.json 失败: {}", e))
        })?;
        let mut settings: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));

        if let Some(obj) = settings.as_object_mut() {
            obj.remove("env");
        }

        let tmp_path = settings_path.with_extension("json.tmp");
        let pretty = serde_json::to_string_pretty(&settings).map_err(|e| {
            crate::error::AppError::ProcessError(format!(
                "序列化 Claude settings.json 失败: {}",
                e
            ))
        })?;
        std::fs::write(&tmp_path, &pretty)?;
        std::fs::rename(&tmp_path, &settings_path)?;

        tracing::info!("[ModelProfileService] 已清除 Claude settings.json 中的 Polaris env 配置");
        Ok(())
    }

    /// 清理指定 Profile 的 settings overlay 临时文件
    pub fn cleanup_settings_overlay(profile_id: &str) -> Result<()> {
        let temp_dir = std::env::temp_dir();
        let file_name = format!("polaris-model-settings-{}.json", profile_id);
        let path = temp_dir.join(&file_name);

        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| {
                crate::error::AppError::ProcessError(format!(
                    "删除 settings overlay 文件失败: {}",
                    e
                ))
            })?;
            tracing::info!("[ModelProfileService] 清理 settings overlay: {:?}", path);
        }
        Ok(())
    }

    /// 从 Profile 端点拉取可用模型列表
    ///
    /// `GET {baseUrl}/v1/models`，按线路格式注入鉴权头（Anthropic 用 x-api-key，
    /// OpenAI 系用 Bearer），兼容 `{data:[{id}]}` / `{models:[...]}` / 顶层数组。
    pub async fn fetch_models(profile: &ModelProfile) -> Result<Vec<String>> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| {
                crate::error::AppError::ProcessError(format!("创建 HTTP 客户端失败: {}", e))
            })?;

        let base = profile.base_url.trim_end_matches('/');
        let url = if base.ends_with("/models") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{}/models", base)
        } else {
            format!("{}/v1/models", base)
        };

        // 按线路格式选择鉴权头
        let is_anthropic = !matches!(
            profile.wire_api.as_deref(),
            Some("openai-chat-completions") | Some("openai-responses")
        );
        let mut req = client.get(&url);
        if is_anthropic {
            req = req
                .header("x-api-key", &profile.api_key)
                .header("anthropic-version", "2023-06-01");
        } else {
            req = req.header("Authorization", format!("Bearer {}", profile.api_key));
        }
        req = Self::apply_custom_headers(req, profile);

        let resp = req
            .send()
            .await
            .map_err(|e| crate::error::AppError::ProcessError(format!("请求模型列表失败: {}", e)))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(crate::error::AppError::ProcessError(format!(
                "模型列表端点返回 {}: {}",
                status,
                body.chars().take(200).collect::<String>()
            )));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| crate::error::AppError::ProcessError(format!("解析模型列表失败: {}", e)))?;

        let mut models = Vec::new();
        let arr = json
            .get("data")
            .and_then(|d| d.as_array())
            .or_else(|| json.get("models").and_then(|d| d.as_array()))
            .or_else(|| json.as_array());
        if let Some(arr) = arr {
            for m in arr {
                if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                    models.push(id.to_string());
                } else if let Some(name) = m.get("name").and_then(|v| v.as_str()) {
                    models.push(name.to_string());
                } else if let Some(s) = m.as_str() {
                    models.push(s.to_string());
                }
            }
        }
        Ok(models)
    }

    /// 测试 Profile 连接是否可用
    ///
    /// 根据 wire_api 选择不同的测试方式：
    /// - `openai-chat-completions`：发送 `/v1/chat/completions` 请求
    /// - 其他（默认 Anthropic Messages）：发送 `/v1/messages` 请求
    pub async fn test_connection(profile: &ModelProfile) -> Result<ConnectionTestResult> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| {
                crate::error::AppError::ProcessError(format!("创建 HTTP 客户端失败: {}", e))
            })?;

        match profile.wire_api.as_deref() {
            Some("openai-chat-completions") => Self::test_openai_connection(&client, profile).await,
            Some("openai-responses") => Self::test_responses_connection(&client, profile).await,
            _ => Self::test_anthropic_connection(&client, profile).await,
        }
    }

    /// 根据 HTTP 响应构造连接测试结果。
    ///
    /// 失败（非 2xx/400）时读取响应体作为错误详情摘要（截断 300 字符），
    /// 便于前端展示具体原因（如鉴权错误信息、上游报错）。
    async fn build_result(ok: bool, code: u16, resp: reqwest::Response) -> ConnectionTestResult {
        let detail = if ok {
            None
        } else {
            let body = resp.text().await.unwrap_or_default();
            let trimmed = body.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.chars().take(300).collect::<String>())
            }
        };
        ConnectionTestResult {
            ok,
            status: Some(code),
            detail,
        }
    }

    /// 将 Profile 自定义请求头应用到请求构建器
    fn apply_custom_headers(
        mut req: reqwest::RequestBuilder,
        profile: &ModelProfile,
    ) -> reqwest::RequestBuilder {
        if let Some(headers) = &profile.custom_headers {
            for (k, v) in headers {
                req = req.header(k.as_str(), v.as_str());
            }
        }
        req
    }

    /// 测试 Anthropic Messages API 端点连通性
    async fn test_anthropic_connection(
        client: &reqwest::Client,
        profile: &ModelProfile,
    ) -> Result<ConnectionTestResult> {
        let url = if profile.base_url.ends_with('/') {
            format!("{}v1/messages", profile.base_url)
        } else {
            format!("{}/v1/messages", profile.base_url)
        };

        let response = client
            .post(&url)
            .header("x-api-key", &profile.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&serde_json::json!({
                "model": profile.model,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            }));
        let response = Self::apply_custom_headers(response, profile).send().await;

        match response {
            Ok(resp) => {
                let status = resp.status();
                let code = status.as_u16();
                tracing::info!(
                    "[ModelProfileService] Anthropic 连接测试: {} -> status {}",
                    profile.base_url,
                    status
                );
                Ok(Self::build_result(status.is_success() || code == 400, code, resp).await)
            }
            Err(e) => {
                tracing::warn!("[ModelProfileService] Anthropic 连接测试失败: {}", e);
                Ok(ConnectionTestResult::network_error(e.to_string()))
            }
        }
    }

    /// 测试 OpenAI Chat Completions API 端点连通性
    async fn test_openai_connection(
        client: &reqwest::Client,
        profile: &ModelProfile,
    ) -> Result<ConnectionTestResult> {
        let base = profile.base_url.trim_end_matches('/');
        let url = if base.ends_with("/chat/completions") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{}/chat/completions", base)
        } else {
            format!("{}/v1/chat/completions", base)
        };

        let response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", profile.api_key))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "model": profile.model,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            }));
        let response = Self::apply_custom_headers(response, profile).send().await;

        match response {
            Ok(resp) => {
                let status = resp.status();
                let code = status.as_u16();
                tracing::info!(
                    "[ModelProfileService] OpenAI 连接测试: {} -> status {}",
                    profile.base_url,
                    status
                );
                Ok(Self::build_result(status.is_success() || code == 400, code, resp).await)
            }
            Err(e) => {
                tracing::warn!("[ModelProfileService] OpenAI 连接测试失败: {}", e);
                Ok(ConnectionTestResult::network_error(e.to_string()))
            }
        }
    }

    /// 测试 OpenAI Responses API 端点连通性
    async fn test_responses_connection(
        client: &reqwest::Client,
        profile: &ModelProfile,
    ) -> Result<ConnectionTestResult> {
        let base = profile.base_url.trim_end_matches('/');
        let url = if base.ends_with("/responses") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{}/responses", base)
        } else {
            format!("{}/v1/responses", base)
        };

        let response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", profile.api_key))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "model": profile.model,
                "input": "hi",
                "max_output_tokens": 16
            }));
        let response = Self::apply_custom_headers(response, profile).send().await;

        match response {
            Ok(resp) => {
                let status = resp.status();
                let code = status.as_u16();
                tracing::info!(
                    "[ModelProfileService] Responses 连接测试: {} -> status {}",
                    profile.base_url,
                    status
                );
                Ok(Self::build_result(status.is_success() || code == 400, code, resp).await)
            }
            Err(e) => {
                tracing::warn!("[ModelProfileService] Responses 连接测试失败: {}", e);
                Ok(ConnectionTestResult::network_error(e.to_string()))
            }
        }
    }
}

fn toml_string(value: &str) -> Result<String> {
    serde_json::to_string(value).map_err(crate::error::AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ModelProfile {
        ModelProfile {
            id: "profile_test-1".to_string(),
            name: "Ruoli".to_string(),
            base_url: "https://ruoli.dev/v1".to_string(),
            api_key: "secret".to_string(),
            model: "glm-5.1".to_string(),
            active: true,
            wire_api: None,
            target_engines: None,
            target_engine: None,
            category: None,
            description: None,
            auth_type: None,
            api_key_env_name: None,
            custom_headers: None,
            custom_env: None,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn generates_codex_provider_config_args() {
        let args = ModelProfileService::generate_codex_config_args(&profile());
        let joined = args.join("\n");

        assert_eq!(args.iter().filter(|arg| arg.as_str() == "-c").count(), 5);
        assert!(joined.contains("model_provider=\"polaris_profile_test_1\""));
        assert!(joined.contains("model_providers.polaris_profile_test_1.name=\"Ruoli\""));
        assert!(joined
            .contains("model_providers.polaris_profile_test_1.base_url=\"https://ruoli.dev/v1\""));
        assert!(joined.contains(
            "model_providers.polaris_profile_test_1.env_key=\"POLARIS_PROFILE_TEST_1_API_KEY\""
        ));
        assert!(joined.contains("model_providers.polaris_profile_test_1.wire_api=\"responses\""));
    }

    #[test]
    fn generates_codex_env_overrides() {
        let env = ModelProfileService::generate_codex_env_overrides(&profile());

        assert_eq!(
            env.get("POLARIS_PROFILE_TEST_1_API_KEY"),
            Some(&"secret".to_string())
        );
        assert!(!env.contains_key("OPENAI_API_KEY"));
    }

    #[test]
    fn maps_openai_chat_codex_wire_to_chat() {
        let mut p = profile();
        p.wire_api = Some("openai-chat-completions".to_string());
        let args = ModelProfileService::generate_codex_config_args(&p);
        let joined = args.join("\n");

        assert!(joined.contains("model_providers.polaris_profile_test_1.wire_api=\"chat\""));
        assert!(joined.contains("model_providers.polaris_profile_test_1.base_url=\"https://ruoli.dev/v1\""));
    }

    #[test]
    fn generates_codex_proxy_config_args_pointing_to_local_proxy() {
        let mut p = profile();
        p.wire_api = Some("openai-chat-completions".to_string());
        let args = ModelProfileService::generate_codex_proxy_config_args(
            &p,
            "127.0.0.1:12345".parse().unwrap(),
        );
        let joined = args.join("\n");

        assert!(joined.contains("model_provider=\"polaris_profile_test_1\""));
        assert!(joined.contains("model_providers.polaris_profile_test_1.base_url=\"http://127.0.0.1:12345/v1\""));
        assert!(joined.contains("model_providers.polaris_profile_test_1.env_key=\"POLARIS_PROFILE_TEST_1_API_KEY\""));
        assert!(joined.contains("model_providers.polaris_profile_test_1.wire_api=\"responses\""));
        assert!(joined.contains("model_catalog_json="));
        assert!(joined.contains("polaris-model-catalog.json"));
    }

    #[test]
    fn generates_codex_proxy_env_overrides_with_placeholder_and_custom_env() {
        let mut p = profile();
        p.wire_api = Some("openai-chat-completions".to_string());
        p.custom_env = Some(std::collections::HashMap::from([(
            "EXTRA_HEADER".to_string(),
            "1".to_string(),
        )]));

        let env = ModelProfileService::generate_codex_proxy_env_overrides(&p);

        assert_eq!(env.get("POLARIS_PROFILE_TEST_1_API_KEY"), Some(&"PROXY_MANAGED".to_string()));
        assert_eq!(env.get("EXTRA_HEADER"), Some(&"1".to_string()));
    }
}
