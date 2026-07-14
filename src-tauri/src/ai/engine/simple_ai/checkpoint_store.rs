/*! SimpleAI 上下文 checkpoint 存储
 *
 * 自动压缩的持久化档案存放在 DataRoot，而不是用户工作区：
 *
 * ```text
 * <DataRoot>/simple-ai/context-checkpoints/<stable-conversation-id>/
 *   manifest.json
 *   checkpoint-0001.jsonl
 * ```
 *
 * 每次压缩交接前保存完整的内部 OpenAI 消息序列。写入顺序为：
 * checkpoint 临时文件 → 校验 → rename → manifest 临时文件 → rename。
 * 任一阶段失败都不会修改运行中 session 的 messages。
 */

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::services::data_root::data_root;

const CHECKPOINT_SCHEMA_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "manifest.json";
const MAX_CHECKPOINTS: usize = 3;

/// 一个压缩交接点的完整、可恢复内部状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ContextCheckpoint {
    pub schema_version: u32,
    pub stable_conversation_id: String,
    pub runtime_session_id: String,
    pub work_dir: String,
    pub generation: u64,
    pub model_profile_id: Option<String>,
    pub model: String,
    pub wire_protocol: String,
    pub bootstrap_end: usize,
    /// 交接前完整的内部消息。不会写入日志或前端事件。
    pub archived_messages: Vec<Value>,
    /// 生成成功后附回，用于运行时恢复；摘要失败时允许为 None。
    pub briefing: Option<String>,
    pub recent_tail_start: Option<usize>,
    pub created_at_ms: i64,
}

impl ContextCheckpoint {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new(
        stable_conversation_id: String,
        runtime_session_id: String,
        work_dir: String,
        generation: u64,
        model_profile_id: Option<String>,
        model: String,
        wire_protocol: String,
        bootstrap_end: usize,
        archived_messages: Vec<Value>,
        briefing: Option<String>,
        recent_tail_start: Option<usize>,
    ) -> Self {
        Self {
            schema_version: CHECKPOINT_SCHEMA_VERSION,
            stable_conversation_id,
            runtime_session_id,
            work_dir,
            generation,
            model_profile_id,
            model,
            wire_protocol,
            bootstrap_end,
            archived_messages,
            briefing,
            recent_tail_start,
            created_at_ms: chrono::Utc::now().timestamp_millis(),
        }
    }
}

/// 写入文件的记录包装，checksum 不参与自身计算。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointRecord {
    checkpoint: ContextCheckpoint,
    checksum: String,
}

/// 只保存用于定位和清理的信息，绝不包含对话正文。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    generation: u64,
    runtime_session_id: String,
    created_at_ms: i64,
    checksum: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointManifest {
    schema_version: u32,
    stable_conversation_id: String,
    latest_generation: u64,
    checkpoints: Vec<ManifestEntry>,
}

impl CheckpointManifest {
    fn new(stable_conversation_id: String) -> Self {
        Self {
            schema_version: CHECKPOINT_SCHEMA_VERSION,
            stable_conversation_id,
            latest_generation: 0,
            checkpoints: Vec::new(),
        }
    }
}

/// DataRoot 下的会话 checkpoint 存储。
#[derive(Debug, Clone)]
pub(super) struct ContextCheckpointStore {
    base_dir: PathBuf,
}

impl ContextCheckpointStore {
    pub(super) fn from_data_root() -> Self {
        Self {
            base_dir: data_root()
                .root()
                .join("simple-ai")
                .join("context-checkpoints"),
        }
    }

    #[cfg(test)]
    fn for_test(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// 保存 checkpoint 并原子更新 manifest，返回 generation。
    pub(super) fn write(&self, checkpoint: &ContextCheckpoint) -> Result<()> {
        validate_component(&checkpoint.stable_conversation_id)?;
        let conversation_dir = self.conversation_dir(&checkpoint.stable_conversation_id)?;
        fs::create_dir_all(&conversation_dir)?;

        let checksum = checksum(checkpoint)?;
        let record = CheckpointRecord {
            checkpoint: checkpoint.clone(),
            checksum: checksum.clone(),
        };
        let checkpoint_path = conversation_dir.join(checkpoint_file_name(checkpoint.generation));
        atomic_write_json(&checkpoint_path, &record)?;

        let mut manifest = self
            .read_manifest(&checkpoint.stable_conversation_id)?
            .unwrap_or_else(|| CheckpointManifest::new(checkpoint.stable_conversation_id.clone()));
        if manifest.stable_conversation_id != checkpoint.stable_conversation_id {
            return Err(AppError::StateError(
                "checkpoint manifest 对话标识不匹配".to_string(),
            ));
        }
        manifest.latest_generation = checkpoint.generation;
        manifest
            .checkpoints
            .retain(|entry| entry.generation != checkpoint.generation);
        manifest.checkpoints.push(ManifestEntry {
            generation: checkpoint.generation,
            runtime_session_id: checkpoint.runtime_session_id.clone(),
            created_at_ms: checkpoint.created_at_ms,
            checksum,
        });
        manifest.checkpoints.sort_by_key(|entry| entry.generation);

        // 保留最近 generation；删除旧文件必须发生在 manifest 成功更新之后。
        let removed = if manifest.checkpoints.len() > MAX_CHECKPOINTS {
            let count = manifest.checkpoints.len() - MAX_CHECKPOINTS;
            manifest.checkpoints.drain(..count).collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        if let Some(last) = manifest.checkpoints.last() {
            manifest.latest_generation = last.generation;
        }
        atomic_write_json(&conversation_dir.join(MANIFEST_FILE), &manifest)?;

        for entry in removed {
            let _ = fs::remove_file(conversation_dir.join(checkpoint_file_name(entry.generation)));
        }
        Ok(())
    }

    pub(super) fn load_latest(&self, stable_conversation_id: &str) -> Result<ContextCheckpoint> {
        let manifest = self
            .read_manifest(stable_conversation_id)?
            .ok_or_else(|| AppError::SessionNotFound(stable_conversation_id.to_string()))?;
        self.load(stable_conversation_id, manifest.latest_generation)
    }

    pub(super) fn load(
        &self,
        stable_conversation_id: &str,
        generation: u64,
    ) -> Result<ContextCheckpoint> {
        let conversation_dir = self.conversation_dir(stable_conversation_id)?;
        let raw = fs::read_to_string(conversation_dir.join(checkpoint_file_name(generation)))?;
        let record: CheckpointRecord = serde_json::from_str(&raw)?;
        if record.checkpoint.schema_version != CHECKPOINT_SCHEMA_VERSION {
            return Err(AppError::StateError(format!(
                "不支持的 checkpoint schema version: {}",
                record.checkpoint.schema_version
            )));
        }
        if record.checkpoint.stable_conversation_id != stable_conversation_id
            || record.checkpoint.generation != generation
        {
            return Err(AppError::StateError("checkpoint 身份校验失败".to_string()));
        }
        if checksum(&record.checkpoint)? != record.checksum {
            return Err(AppError::StateError("checkpoint 内容校验失败".to_string()));
        }
        Ok(record.checkpoint)
    }

    pub(super) fn next_generation(&self, stable_conversation_id: &str) -> Result<u64> {
        Ok(self
            .read_manifest(stable_conversation_id)?
            .map_or(1, |manifest| manifest.latest_generation.saturating_add(1)))
    }

    pub(super) fn delete_all(&self, stable_conversation_id: &str) -> Result<()> {
        let conversation_dir = self.conversation_dir(stable_conversation_id)?;
        if conversation_dir.exists() {
            fs::remove_dir_all(conversation_dir)?;
        }
        Ok(())
    }

    fn conversation_dir(&self, stable_conversation_id: &str) -> Result<PathBuf> {
        validate_component(stable_conversation_id)?;
        Ok(self.base_dir.join(stable_conversation_id))
    }

    fn read_manifest(&self, stable_conversation_id: &str) -> Result<Option<CheckpointManifest>> {
        let path = self
            .conversation_dir(stable_conversation_id)?
            .join(MANIFEST_FILE);
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(serde_json::from_str(&fs::read_to_string(path)?)?))
    }
}

fn checkpoint_file_name(generation: u64) -> String {
    format!("checkpoint-{generation:04}.jsonl")
}

fn validate_component(value: &str) -> Result<()> {
    if value.is_empty() || value == "." || value == ".." || value.contains(['/', '\\', ':']) {
        return Err(AppError::ValidationError("无效的稳定对话 ID".to_string()));
    }
    Ok(())
}

fn checksum(checkpoint: &ContextCheckpoint) -> Result<String> {
    let bytes = serde_json::to_vec(checkpoint)?;
    Ok(format!("{:016x}", xxhash_rust::xxh3::xxh3_64(&bytes)))
}

/// 使用同目录临时文件 + rename；不会在失败时留下可被 load 的半写入文件。
fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::StateError("checkpoint 文件名无效".to_string()))?;
    let temp = path.with_file_name(format!(".{file_name}.tmp"));
    let content = serde_json::to_vec(value)?;
    let mut file = fs::File::create(&temp)?;
    file.write_all(&content)?;
    file.sync_all()?;
    drop(file);
    if let Err(error) = atomic_replace(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error.into());
    }
    sync_parent_directory(path)?;
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> std::io::Result<()> {
    // MoveFileExW(MOVEFILE_WRITE_THROUGH) above flushes the rename operation on Windows.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn checkpoint(generation: u64) -> ContextCheckpoint {
        ContextCheckpoint::new(
            "stable-abc".to_string(),
            format!("runtime-{generation}"),
            ".".to_string(),
            generation,
            Some("profile-id".to_string()),
            "model".to_string(),
            "openai-chat-completions".to_string(),
            2,
            vec![json!({"role": "user", "content": "hello"})],
            Some("briefing".to_string()),
            Some(2),
        )
    }

    #[test]
    fn round_trip_and_load_latest() {
        let temp = tempfile::tempdir().unwrap();
        let store = ContextCheckpointStore::for_test(temp.path().to_path_buf());
        store.write(&checkpoint(1)).unwrap();
        store.write(&checkpoint(2)).unwrap();

        let latest = store.load_latest("stable-abc").unwrap();
        assert_eq!(latest.generation, 2);
        assert_eq!(latest.archived_messages[0]["content"], "hello");
        assert_eq!(store.next_generation("stable-abc").unwrap(), 3);
    }

    #[test]
    fn rejects_path_traversal_stable_id() {
        let temp = tempfile::tempdir().unwrap();
        let store = ContextCheckpointStore::for_test(temp.path().to_path_buf());
        assert!(store.load_latest("../outside").is_err());
    }

    #[test]
    fn detects_tampered_checkpoint() {
        let temp = tempfile::tempdir().unwrap();
        let store = ContextCheckpointStore::for_test(temp.path().to_path_buf());
        store.write(&checkpoint(1)).unwrap();
        let path = temp.path().join("stable-abc").join(checkpoint_file_name(1));
        let mut raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        raw["checkpoint"]["model"] = json!("tampered");
        fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
        assert!(store.load("stable-abc", 1).is_err());
    }

    #[test]
    fn rewriting_same_generation_atomically_replaces_checkpoint() {
        let temp = tempfile::tempdir().unwrap();
        let store = ContextCheckpointStore::for_test(temp.path().to_path_buf());
        let mut value = checkpoint(1);
        store.write(&value).unwrap();
        value.archived_messages = vec![json!({"role": "user", "content": "updated"})];
        store.write(&value).unwrap();
        assert_eq!(
            store.load("stable-abc", 1).unwrap().archived_messages[0]["content"],
            "updated"
        );
    }

    #[test]
    fn retention_keeps_only_three_latest_generations() {
        let temp = tempfile::tempdir().unwrap();
        let store = ContextCheckpointStore::for_test(temp.path().to_path_buf());
        for generation in 1..=5 {
            store.write(&checkpoint(generation)).unwrap();
        }
        let dir = temp.path().join("stable-abc");
        assert!(!dir.join(checkpoint_file_name(1)).exists());
        assert!(!dir.join(checkpoint_file_name(2)).exists());
        assert!(dir.join(checkpoint_file_name(3)).exists());
        assert!(dir.join(checkpoint_file_name(4)).exists());
        assert!(dir.join(checkpoint_file_name(5)).exists());
        assert_eq!(store.load_latest("stable-abc").unwrap().generation, 5);
    }
}
