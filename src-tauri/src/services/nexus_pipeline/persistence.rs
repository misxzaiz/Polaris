//! pipeline 落盘（K-R4 自 nexus_pipeline.rs 迁入）

use std::path::PathBuf;
use crate::error::AppError;
use std::path::Path;
use super::types::RosterPipeline;
use crate::error::Result;
use serde_json;
// ============================================================================
// 持久化
// ============================================================================

pub fn save_pipeline(dir: &Path, pipeline: &RosterPipeline) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{}.json", pipeline.id));
    let json = serde_json::to_string_pretty(pipeline)?;
    std::fs::write(path, json)?;
    Ok(())
}

pub fn load_pipeline(dir: &Path, id: &str) -> Result<RosterPipeline> {
    let path = dir.join(format!("{id}.json"));
    let content = std::fs::read_to_string(&path)
        .map_err(|e| AppError::ConfigError(format!("读取 pipeline 失败: {e} ({})", path.display())))?;
    serde_json::from_str(&content)
        .map_err(|e| AppError::ConfigError(format!("pipeline 解析失败: {e}")))
}

pub fn pipelines_dir() -> PathBuf {
    crate::services::data_root::data_root().root().join("nexus")
}

