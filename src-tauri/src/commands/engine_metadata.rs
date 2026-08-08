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
use crate::error::Result;
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