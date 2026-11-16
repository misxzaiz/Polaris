//! 模型 Profile 选项应用（K-R6 自 ai_chat_core.rs 迁入）

use crate::error::Result;
use crate::ai::{EngineId, SessionOptions};
use crate::error::AppError;
use super::attachments::with_additional_disallowed_tools;

pub(super) async fn apply_model_profile_options(
    mut session_opts: SessionOptions,
    profile_id: Option<&String>,
    engine: &EngineId,
    state: &crate::AppState,
    log_scope: &str,
    session_id: &str,
) -> Result<SessionOptions> {
    let Some(profile_id) = profile_id else {
        return Ok(session_opts);
    };

    let config = state
        .clone_config()
        .map_err(AppError::ProcessError)?;
    let profiles = &config.model_profiles;
    let Some(profile) = profiles.iter().find(|p| p.id == *profile_id) else {
        // 用户明确选择了某 Profile，但配置中已不存在（可能已删除或未同步）。
        // 不再静默回退到官方端点（会产生意外费用/答非所选），而是中断并提示用户。
        tracing::warn!(
            "[{}] 未找到模型 Profile: {}，中断请求",
            log_scope,
            profile_id
        );
        return Err(AppError::ClientError(
            "errors:modelProfile.notFoundRuntime".to_string(),
        ));
    };

    tracing::info!(
        "[{}] 使用模型 Profile: {} ({}), wireApi={:?}, targetEngines={:?}, category={:?}",
        log_scope,
        profile.name,
        profile.model,
        profile.wire_api,
        profile.resolve_target_engines(),
        profile.category
    );

    // 检查 Profile 是否适用于当前引擎。
    let expected_engine = match engine {
        EngineId::ClaudeCode => "claude",
        EngineId::SimpleAI => "simple-ai",
        EngineId::Custom(id) => id.as_str(),
    };
    // opencode 引擎豁免兼容性校验（迁移后为 Custom("opencode")）：opencode 有自己的
    // provider 体系，model 路由用 --model <provider>/<model>，Polaris 的 ModelProfile
    // targetEngines 通常只标了 claude/simple-ai，会误伤 opencode 官方免费模型（残留
    // 旧 Profile id 时会误中断请求抛 incompatibleRuntime）。此豁免不删除下方 Custom 分支
    // 的端点注入——Profile 仍可作二阶能力提供端点，只是不再因 targetEngines 不匹配而拦截。
    let opencode_exempted = matches!(engine, EngineId::Custom(id) if id == "opencode");
    if !opencode_exempted && !profile.is_for_engine(expected_engine) {
        // 同样不静默跳过：明确告知用户所选 Profile 不适用于当前引擎，引导重新选择。
        tracing::warn!(
            "[{}] Profile {} 不适用于引擎 {:?}（targetEngines={:?}），中断请求",
            log_scope,
            profile.name,
            engine,
            profile.resolve_target_engines()
        );
        return Err(AppError::ClientError(
            "errors:modelProfile.incompatibleRuntime".to_string(),
        ));
    }

    match engine {
        EngineId::ClaudeCode => {
            let wire = profile.wire_api.as_deref();
            let use_openai_proxy = matches!(
                wire,
                Some("openai-chat-completions") | Some("openai-responses")
            );
            let use_anthropic_sanitized_proxy = !use_openai_proxy
                && !crate::services::ModelProfileService::supports_anthropic_server_tool_blocks(
                    profile,
                );
            let use_proxy = use_openai_proxy || use_anthropic_sanitized_proxy;
            if use_proxy {
                let proxy_wire = if use_anthropic_sanitized_proxy {
                    crate::services::proxy::ProxyWireApi::AnthropicMessages
                } else {
                    crate::services::proxy::ProxyWireApi::from_profile_wire_api(wire)
                };
                let custom_headers = profile.custom_headers.clone().unwrap_or_default();
                // 启动本地代理（Chat Completions 或 Responses 线路，由 proxy_wire 决定转换方式）
                tracing::info!(
                    "[{}] Profile {} 使用代理模式（{:?}），启动内嵌代理",
                    log_scope,
                    profile.name,
                    proxy_wire
                );

                match state
                    .proxy_manager
                    .start_proxy(
                        session_id,
                        &profile.id,
                        &profile.base_url,
                        &profile.api_key,
                        proxy_wire,
                        custom_headers,
                    )
                    .await
                {
                    Ok(proxy_addr) => {
                        tracing::info!(
                            "[{}] 代理已启动: {} -> http://{} (session={})",
                            log_scope,
                            profile.name,
                            proxy_addr,
                            session_id
                        );

                        match crate::services::ModelProfileService::write_proxy_settings_overlay(
                            profile, proxy_addr,
                        ) {
                            Ok(path) => {
                                session_opts = session_opts
                                    .with_settings_overlay_path(path.to_string_lossy().to_string());
                            }
                            Err(e) => {
                                tracing::warn!(
                                    "[{}] 生成 proxy settings overlay 失败: {}",
                                    log_scope,
                                    e
                                );
                            }
                        }

                        // 代理模式下 env overrides 只需设置基础覆盖（API key 由代理管理）
                        let mut env_overrides = std::collections::HashMap::new();
                        env_overrides.insert(
                            "ANTHROPIC_BASE_URL".to_string(),
                            format!("http://{}", proxy_addr),
                        );
                        env_overrides.insert(
                            "ANTHROPIC_AUTH_TOKEN".to_string(),
                            "PROXY_MANAGED".to_string(),
                        );
                        // 合并用户自定义环境变量
                        if let Some(custom) = &profile.custom_env {
                            for (k, v) in custom {
                                env_overrides.insert(k.clone(), v.clone());
                            }
                        }
                        session_opts = session_opts.with_env_overrides(env_overrides);
                        if use_anthropic_sanitized_proxy {
                            session_opts = with_additional_disallowed_tools(
                                session_opts,
                                &["WebSearch", "WebFetch"],
                            );
                        }
                    }
                    Err(e) => {
                        tracing::error!("[{}] 启动代理失败: {}", log_scope, e);
                        return Err(crate::error::AppError::ProcessError(format!(
                            "启动模型代理失败: {}",
                            e
                        )));
                    }
                }
            } else {
                // Anthropic Messages 直连模式（原有逻辑）
                match crate::services::ModelProfileService::write_settings_overlay(profile) {
                    Ok(path) => {
                        session_opts = session_opts
                            .with_settings_overlay_path(path.to_string_lossy().to_string());
                    }
                    Err(e) => {
                        tracing::warn!("[{}] 生成 settings overlay 失败: {}", log_scope, e);
                    }
                }

                let env_overrides =
                    crate::services::ModelProfileService::generate_env_overrides(profile);
                session_opts = session_opts.with_env_overrides(env_overrides);
            }
        }
        EngineId::SimpleAI => {
            // SimpleAI 引擎直接使用 profile 的 baseUrl/apiKey/model
            // 通过 env_overrides 传递 profile ID，让 SimpleAI 可以精确查找 Profile
            tracing::info!(
                "[{}] SimpleAI 引擎使用 Profile: {} (id={}, model={}, baseUrl={})",
                log_scope,
                profile.name,
                profile.id,
                profile.model,
                profile.base_url
            );
            let mut env_overrides = std::collections::HashMap::new();
            env_overrides.insert("__simple_ai_profile_id".to_string(), profile.id.clone());
            session_opts = session_opts.with_env_overrides(env_overrides);
        }
        // 插件引擎（Custom）：复用 Pi 的 provider 配置逻辑。
        // 当引擎 manifest 声明了 providerConfig 时，PluginEngine 会据此
        // 写配置文件（models.yml/models.json）+ 传 --provider/--model；
        // 同时注入 env_overrides 兜底（部分 CLI 也读 env）。
        // 注：opencode 迁移后为 Custom("opencode")，其 adapter 直接消费
        // env_overrides（OPENAI_BASE_URL/API_KEY），manifest 不声明 providerConfig
        // 时 write_provider_config 为 no-op，此处走通用兜底逻辑安全。
        EngineId::Custom(_) => {
            tracing::info!(
                "[{}] 插件引擎使用 Profile: {} (model={}, wireApi={:?})",
                log_scope,
                profile.name,
                profile.model,
                profile.wire_api
            );

            // 剥离 CLI 私有后缀（如 [1m]），传给 CLI 的必须是纯模型名
            let source_model = session_opts.model.clone()
                .unwrap_or_else(|| profile.model.clone());
            let stripped = crate::ai::engine::simple_ai_protocol::strip_cli_model_suffix(&source_model);
            let clean_model = stripped.base_model.clone().unwrap_or(source_model);

            // 覆盖 session_opts.model 为纯模型名，确保传给 CLI 的 --model 不带后缀
            // （PluginEngine 的 write_provider_config model_id 和 build_command --model 都读这个字段）
            session_opts = session_opts.with_model(clean_model.clone());

            // provider 名称：polaris-<profile_id>，与 Pi 引擎一致
            let provider_name = format!("polaris-{}", profile.id);

            // 构造 pi_provider_config：PluginEngine 据此写配置文件 + 传 CLI 参数。
            // api 字段仅作默认；实际写入时由 manifest 的 providerConfig.apiValue 覆盖
            // （omp 要求 openai-completions，Pi 要求 openai-chat-completions）。
            let ctx_window = profile.context_window.unwrap_or(128000);
            session_opts = session_opts.with_pi_provider_config(
                crate::ai::PiProviderConfig {
                    name: provider_name,
                    base_url: profile.base_url.clone(),
                    api_key: profile.api_key.clone(),
                    api: String::new(), // 由 PluginEngine 按 manifest apiValue 覆盖
                    context_window: ctx_window,
                    max_tokens: 16384,
                }
            );

            // env_overrides 兜底（部分 CLI 也读环境变量）
            let mut env_overrides = std::collections::HashMap::new();
            if let Some(custom) = &profile.custom_env {
                for (k, v) in custom {
                    env_overrides.insert(k.clone(), v.clone());
                }
            }
            if !profile.base_url.is_empty() {
                env_overrides.entry("ANTHROPIC_BASE_URL".to_string())
                    .or_insert_with(|| profile.base_url.clone());
                env_overrides.entry("OPENAI_BASE_URL".to_string())
                    .or_insert_with(|| profile.base_url.clone());
            }
            if !profile.api_key.is_empty() {
                let env_name = match profile.wire_api.as_deref() {
                    Some("openai-chat-completions" | "openai-responses") => "OPENAI_API_KEY",
                    _ => "ANTHROPIC_API_KEY",
                };
                env_overrides.entry(env_name.to_string())
                    .or_insert_with(|| profile.api_key.clone());
                env_overrides.entry("ANTHROPIC_API_KEY".to_string())
                    .or_insert_with(|| profile.api_key.clone());
            }
            if !clean_model.is_empty() {
                env_overrides.insert("ANTHROPIC_MODEL".to_string(), clean_model.clone());
                env_overrides.insert("OPENAI_MODEL".to_string(), clean_model);
            }
            session_opts = session_opts.with_env_overrides(env_overrides);
        }
    }

    // 如果前端传入了模型，优先使用前端选择的模型（Profile 多模型选择）
    // 否则回退到 Profile 默认模型
    let selected_model = session_opts.model.clone().unwrap_or_else(|| profile.model.clone());

    // 如果选了非默认模型，更新日志
    if selected_model != profile.model {
        tracing::info!(
            "[{}] Profile 使用前端选择的模型: {}（Profile 默认: {}）",
            log_scope,
            selected_model,
            profile.model
        );
    }

    Ok(session_opts.with_model(selected_model))
}

