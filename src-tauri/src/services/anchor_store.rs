//! anchor_store —— 核内唯一持久化：文件锚点记录（kernel-5k 方案 S3.2）
//!
//! 只记录「key → 插件 id + 数据文件路径」指针，不存业务内容。
//! jsonl 单写者（append-only，启动时全量重放构建内存索引）。
//!
//! 用途：存储插件化后，宿主核通过锚点知道「某类数据当前由哪个插件、
//! 哪个文件承接」；插件热替换时改写锚点即完成指向切换。
//!
//! 纪律：本文件不依赖任何业务语义（不含 session/message 等概念），
//! key 由调用方自定（如 `storage/session-messages`）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 单条锚点记录
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnchorEntry {
    /// 业务键（如 `storage/session-messages`）
    pub key: String,
    /// 承接插件 id（如 `storage-sqlite`；bootstrap 阶段为 `host`)
    pub plugin_id: String,
    /// 数据文件绝对路径（原地文件，零迁移）
    pub file_path: String,
    /// 最近写入时间（epoch ms，审计用）
    #[serde(default)]
    pub updated_at: u64,
}

const ANCHOR_FILE: &str = "anchors.jsonl";

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 锚点存储（进程内单例语义：每次 `open` 拿到独立文件句柄；
/// 写入走全量重写以保持单写者简单性——锚点量级极小（<100 条））
pub struct AnchorStore {
    path: PathBuf,
    inner: Mutex<BTreeMap<String, AnchorEntry>>,
}

impl AnchorStore {
    /// 在数据根 config_dir 下打开（不存在则懒创建）
    pub fn open(config_dir: &Path) -> Self {
        let path = config_dir.join(ANCHOR_FILE);
        let inner = Self::load(&path);
        Self { path, inner: Mutex::new(inner) }
    }

    fn load(path: &Path) -> BTreeMap<String, AnchorEntry> {
        let mut map = BTreeMap::new();
        if let Ok(content) = std::fs::read_to_string(path) {
            for line in content.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<AnchorEntry>(line) {
                    Ok(e) => {
                        map.insert(e.key.clone(), e);
                    }
                    Err(_) => continue, // 坏行跳过（jsonl 容错）
                }
            }
        }
        map
    }

    /// 全量重写（单写者：调用方须持有本 store 的唯一引用）
    fn flush(&self, map: &BTreeMap<String, AnchorEntry>) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = String::new();
        for e in map.values() {
            out.push_str(&serde_json::to_string(e).map_err(|e| e.to_string())?);
            out.push('\n');
        }
        // tmp + rename 原子替换
        let tmp = self.path.with_extension("jsonl.tmp");
        std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 设置/更新锚点
    pub fn set(&self, key: &str, plugin_id: &str, file_path: &str) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        map.insert(
            key.to_string(),
            AnchorEntry {
                key: key.to_string(),
                plugin_id: plugin_id.to_string(),
                file_path: file_path.to_string(),
                updated_at: now_ms(),
            },
        );
        self.flush(&map)
    }

    /// 读取单条
    pub fn get(&self, key: &str) -> Option<AnchorEntry> {
        self.inner.lock().ok()?.get(key).cloned()
    }

    /// 全量快照（审计/诊断）
    pub fn list(&self) -> Vec<AnchorEntry> {
        self.inner
            .lock()
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchor_roundtrip() {
        let dir = std::env::temp_dir().join(format!("anchor-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let store = AnchorStore::open(&dir);
        store.set("storage/session-messages", "storage-sqlite", "D:/data/messages.db").unwrap();
        store.set("storage/session-state", "storage-sqlite", "D:/data/state.db").unwrap();

        let got = store.get("storage/session-messages").unwrap();
        assert_eq!(got.plugin_id, "storage-sqlite");
        assert_eq!(got.file_path, "D:/data/messages.db");

        // 重开（模拟重启）后仍在
        let store2 = AnchorStore::open(&dir);
        assert!(store2.get("storage/session-state").is_some());
        assert_eq!(store2.list().len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
