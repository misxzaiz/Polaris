/*! 引擎元数据查询命令
 *
 * 提供统一的引擎元数据查询接口，前端通过此命令获取所有已注册引擎的元数据。
 * 新增引擎时只需注册到 EngineRegistry，此命令自动包含新引擎。
 *
 * 使用方式（前端）：
 * ```typescript
 * const engines = await invoke('get_engine_metadata_list')
 * ```
 */

use crate::ai::EngineMetadata;
use crate::error::{AppError, Result};
use crate::state::AppState;
#[cfg(feature = "tauri-app")]
use tauri::State;

/// 获取所有已注册引擎的元数据列表。
///
/// 返回 `EngineMetadata` 数组，包含引擎 ID、名称、描述、分发方式、能力标志等。
/// 前端据此动态渲染引擎列表、能力标签、选择器选项，无需硬编码。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn get_engine_metadata_list(
    state: State<'_, AppState>,
) -> Result<Vec<EngineMetadata>> {
    let registry = state.engine_registry.lock().await;
    let metas = registry.list_all_metadata();
    let ids: Vec<String> = metas.iter().map(|m| m.id.to_string()).collect();
    tracing::info!("[EngineMetadataCmd] 返回 {} 个引擎: [{}]", metas.len(), ids.join(", "));
    Ok(metas)
}

/// opencode 可选模型项
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeModel {
    /// 模型 ID（如 `opencode/glm-5.3-flash-free`）
    pub id: String,
    /// 显示名称（去掉 provider 前缀的简短名）
    pub name: String,
    /// 是否免费模型（免 API key）
    pub free: bool,
}

/// 获取 opencode 可用模型列表。
///
/// 执行 `opencode models` 解析纯文本输出（一行一个模型 ID）。
/// 排序规则：免费模型排前（`opencode/*-free` 优先于 `openrouter/*:free`），
/// `opencode/glm-5.3-flash-free` 强制排第一；其余付费模型按字母序排在后面。
///
/// 此命令不依赖 AppState，每次调用实时执行 `opencode models`。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn get_opencode_models() -> Result<Vec<OpencodeModel>> {
    get_opencode_models_impl()
}

/// 非 Tauri 环境的共享实现（供 web bin 路径调用）
pub fn get_opencode_models_impl() -> Result<Vec<OpencodeModel>> {
    let cmd_name = if cfg!(windows) { "opencode.cmd" } else { "opencode" };
    let output = std::process::Command::new(cmd_name)
        .arg("models")
        .output()
        .map_err(|e| AppError::ProcessError(format!("执行 opencode models 失败: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::ProcessError(format!(
            "opencode models 执行失败: {}",
            stderr.trim()
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut models: Vec<OpencodeModel> = stdout
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|id| {
            let free = id.ends_with("-free") || id.ends_with(":free");
            let name = id
                .split('/')
                .next_back()
                .unwrap_or(id)
                .to_string();
            OpencodeModel {
                id: id.to_string(),
                name,
                free,
            }
        })
        .collect();

    // 排序：免费在前，付费在后
    // 免费组内：opencode/glm-5.3-flash-free 第一，其余 opencode/*-free 字母序，
    // 然后 openrouter/*:free 字母序
    models.sort_by(|a, b| {
        match (a.free, b.free) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (true, true) => {
                // glm 强制第一
                if a.id == "opencode/glm-5.3-flash-free" {
                    return std::cmp::Ordering::Less;
                }
                if b.id == "opencode/glm-5.3-flash-free" {
                    return std::cmp::Ordering::Greater;
                }
                // opencode/* 排在 openrouter/* 前
                let a_oc = a.id.starts_with("opencode/");
                let b_oc = b.id.starts_with("opencode/");
                match (a_oc, b_oc) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => a.id.cmp(&b.id),
                }
            }
            (false, false) => a.id.cmp(&b.id),
        }
    });

    tracing::info!(
        "[OpencodeModels] 返回 {} 个模型，免费 {} 个",
        models.len(),
        models.iter().filter(|m| m.free).count()
    );
    Ok(models)
}