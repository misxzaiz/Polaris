//! 服务账本（registry）：宿主「承诺过什么」的落盘记录（重构 spec §3.7）
//!
//! 定位：**账本，不是状态权威**——真相在 OS 进程表与期望派生。用途：
//! 1. epoch → PID 归属判定（在管 vs 孤儿）；
//! 2. 启动对账线索（上一任留下的记录 → 孤儿判定输入）；
//! 3. 快照透出（面板/诊断）。
//!
//! 写纪律：单写者（Reconciler tick 执行末尾整文件重写，tmp+rename 原子）；
//! 损坏/缺失 → 按空账本处理（安全方向：孤儿判定走全杀+重拉）。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub epoch: u64,
    pub plugin_id: String,
    pub service_id: String,
    pub pid: u32,
    pub port: Option<u16>,
    pub started_at_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    version: u32,
    entries: Vec<RegistryEntry>,
}

const VERSION: u32 = 1;

pub struct Registry {
    path: PathBuf,
    entries: Vec<RegistryEntry>,
}

impl Registry {
    /// 从 dataRoot 打开（`<dataRoot>/services-registry.json`）。损坏/缺失 → 空账本。
    pub fn open(data_root: &Path) -> Self {
        let path = data_root.join("services-registry.json");
        let entries = read_file(&path).unwrap_or_default();
        Self { path, entries }
    }

    pub fn entries(&self) -> &[RegistryEntry] {
        &self.entries
    }

    /// 单点重写（tick 执行末尾调用）。tmp + rename 原子替换。
    pub fn persist(&mut self, entries: Vec<RegistryEntry>) -> std::io::Result<()> {
        self.entries = entries;
        let file = RegistryFile {
            version: VERSION,
            entries: self.entries.clone(),
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(json.as_bytes())?;
            f.sync_all().ok();
        }
        // Windows rename 覆盖已存在目标：先移除旧文件（rename 到存在目标在部分
        // Windows 版本会失败），失败即报错——原子性由 tmp 存在保证。
        if self.path.exists() {
            let _ = std::fs::remove_file(&self.path);
        }
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

fn read_file(path: &Path) -> Option<Vec<RegistryEntry>> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok()?;
    let file: RegistryFile = serde_json::from_str(&buf).ok()?;
    Some(file.entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "polaris-registry-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_is_empty_ledger() {
        let dir = tmpdir("missing");
        let r = Registry::open(&dir);
        assert!(r.entries().is_empty(), "缺失账本按空处理（安全方向）");
    }

    #[test]
    fn corrupt_file_is_empty_ledger() {
        let dir = tmpdir("corrupt");
        std::fs::write(dir.join("services-registry.json"), "{not json").unwrap();
        let r = Registry::open(&dir);
        assert!(r.entries().is_empty(), "损坏账本按空处理（安全方向）");
    }

    #[test]
    fn persist_then_reopen_roundtrip() {
        let dir = tmpdir("roundtrip");
        let mut r = Registry::open(&dir);
        let entries = vec![RegistryEntry {
            epoch: 42,
            plugin_id: "feed-radar".into(),
            service_id: "radar-service".into(),
            pid: 1234,
            port: Some(10001),
            started_at_ms: 1699999999999,
        }];
        r.persist(entries.clone()).unwrap();
        let r2 = Registry::open(&dir);
        assert_eq!(r2.entries(), &entries, "重开读回一致");
        // 二次覆盖写（替换语义）
        r.persist(vec![]).unwrap();
        assert!(Registry::open(&dir).entries().is_empty());
    }
}
