//! FileAuditSink —— dispatch 审计的生产实现（第五步阶段 B）
//!
//! 对应 `dev/docs/sky/step5-permission-audit.md` §2.B：
//! - JSONL 落 `<DataRoot>/audit/dispatch.jsonl`，`O_APPEND` 独立文件句柄
//!   （契约注释：Bootstrap 直管，不经 Storage trait，换 storage 不影响审计通道）。
//! - tamper-evident 链：每条 `record_hash = sha256(prev_hash ‖ canonical_json(本条除 record_hash 外字段))`，
//!   首条 `prev_hash = GENESIS_HASH`。
//! - **不改冻结的 `AuditEntry` 契约**：记录层在 JSONL 中增加 `recordHash` 字段，
//!   deny 原因编码进 `action`（如 `dispatch.deny:permission`）。
//! - 脱敏：`Source::Remote { token }` 只落变体名（对齐 SqliteStorage::source_kind），
//!   token 明文永不落盘。
//!
//! 校验：`verify_chain` 逐条重算哈希并检查链式衔接，篡改定位到行号（1-based）。

use crate::contracts::{AuditEntry, AuditSink, Source};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 审计链起始哈希（空链的 prev_hash）
pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// JSONL 单条记录（AuditEntry 的落盘形态 + 链哈希）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditRecord {
    timestamp_ms: u64,
    capability: String,
    /// Source 变体名（脱敏，不存 token）
    source: String,
    action: String,
    prev_hash: String,
    /// 本条记录哈希（tamper-evident）
    record_hash: String,
    /// 资源摘要（2026-10-24 审计 X4；旧记录缺省 → None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    /// dispatch 耗时 ms（同上；旧记录缺省 → None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
}

/// 参与哈希计算的核心字段（canonical JSON）
///
/// 兼容性铁律：**新增字段只追加在既有五字段之后且 Option+skip**——旧记录
/// （无新字段）的 canonical JSON 与历史哈希完全一致，`verify_chain` 对混合链
/// （旧记录 + 新记录）依然通过；新记录的新字段纳入哈希，防篡改不降级。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditRecordCore<'a> {
    timestamp_ms: u64,
    capability: &'a str,
    source: &'a str,
    action: &'a str,
    prev_hash: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
}

/// Source 变体名（审计落盘脱敏：不存 token 明文）
fn source_kind(source: &Source) -> &'static str {
    match source {
        Source::Bootstrap => "Bootstrap",
        Source::Remote { .. } => "Remote",
        Source::Plugin { .. } => "Plugin",
    }
}

/// 计算记录哈希：sha256(prev_hash ‖ canonical_json(core))
fn record_hash_of(
    timestamp_ms: u64,
    capability: &str,
    source: &str,
    action: &str,
    prev_hash: &str,
    detail: Option<&str>,
    duration_ms: Option<u64>,
) -> String {
    let core = AuditRecordCore {
        timestamp_ms,
        capability,
        source,
        action,
        prev_hash,
        detail,
        duration_ms,
    };
    let canonical = serde_json::to_string(&core).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(prev_hash.as_bytes());
    hasher.update(canonical.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 审计文件路径：`<DataRoot>/audit/dispatch.jsonl`
pub fn audit_file_path() -> PathBuf {
    crate::services::data_root::data_root()
        .root()
        .join("audit")
        .join("dispatch.jsonl")
}

/// 具名审计文件路径（跨进程来源隔离：bus-mcp 用独立链文件，避免哈希链竞争）
pub fn audit_file_path_named(name: &str) -> PathBuf {
    crate::services::data_root::data_root()
        .root()
        .join("audit")
        .join(name)
}

/// 文件型审计通道（Bootstrap 直管，dispatch allow/deny 都经这里追加）
pub struct FileAuditSink {
    inner: Mutex<SinkState>,
}

struct SinkState {
    file: File,
    last_hash: String,
    count: u64,
}

impl FileAuditSink {
    /// 打开（或创建）审计文件并续链。
    ///
    /// 文件已存在时扫描既有记录，从最后一条有效记录的 `record_hash` 续链
    /// （文件中断/损坏由 `verify_chain` 显式发现，这里不阻塞写入）。
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建审计目录失败: {}", e))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| format!("打开审计文件失败: {}", e))?;

        // 续链：取最后一条有效记录的 record_hash
        let mut last_hash = GENESIS_HASH.to_string();
        let mut count = 0u64;
        if path.exists() {
            let reader = File::open(path)
                .map_err(|e| format!("读取审计文件失败: {}", e))
                .map(BufReader::new)?;
            for line in reader.lines() {
                let Ok(line) = line else { continue };
                if line.trim().is_empty() {
                    continue;
                }
                count += 1;
                if let Ok(rec) = serde_json::from_str::<AuditRecord>(&line) {
                    last_hash = rec.record_hash;
                }
                // 无效行不中断：count 仍计入，链哈希沿用最后一条有效记录
            }
        }

        Ok(Self {
            inner: Mutex::new(SinkState { file, last_hash, count }),
        })
    }

    /// 当前链尾哈希（测试/诊断用）
    pub fn last_hash(&self) -> String {
        self.inner.lock().unwrap().last_hash.clone()
    }

    /// 已追加条数（含打开时扫描到的历史记录）
    pub fn count(&self) -> u64 {
        self.inner.lock().unwrap().count
    }
}

impl AuditSink for FileAuditSink {
    fn append(&self, entry: &AuditEntry) -> Result<(), String> {
        let mut state = self.inner.lock().map_err(|e| format!("审计锁失败: {}", e))?;
        let source = source_kind(&entry.source);
        let prev_hash = state.last_hash.clone();
        let record_hash = record_hash_of(
            entry.timestamp_ms,
            &entry.capability.0,
            source,
            &entry.action,
            &prev_hash,
            entry.detail.as_deref(),
            entry.duration_ms,
        );
        let record = AuditRecord {
            timestamp_ms: entry.timestamp_ms,
            capability: entry.capability.0.clone(),
            source: source.to_string(),
            action: entry.action.clone(),
            prev_hash,
            record_hash,
            detail: entry.detail.clone(),
            duration_ms: entry.duration_ms,
        };
        let line = serde_json::to_string(&record).map_err(|e| format!("审计序列化失败: {}", e))?;
        state
            .file
            .write_all(format!("{}\n", line).as_bytes())
            .and_then(|_| state.file.flush())
            .map_err(|e| format!("审计写入失败: {}", e))?;
        state.last_hash = record.record_hash;
        state.count += 1;
        Ok(())
    }
}

/// 读取审计文件尾部 N 行 + 总条数（`audit_tail` 命令用）
pub fn tail_lines(path: &Path, count: usize) -> Result<(Vec<String>, u64), String> {
    if !path.exists() {
        return Ok((Vec::new(), 0));
    }
    let reader = File::open(path)
        .map_err(|e| format!("读取审计文件失败: {}", e))
        .map(BufReader::new)?;
    let mut total = 0u64;
    let mut all: Vec<String> = Vec::new();
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        total += 1;
        all.push(line);
    }
    let start = all.len().saturating_sub(count);
    all.drain(..start);
    Ok((all, total))
}

/// 逐条校验审计链（哈希重算 + 链式衔接）。
///
/// 返回 `Ok(total)`（全部通过）或 `Err(broken_line)`（1-based 行号）。
pub fn verify_chain(path: &Path) -> Result<u64, usize> {
    if !path.exists() {
        return Ok(0);
    }
    let file = File::open(path).map_err(|_| 0usize)?;
    let reader = BufReader::new(file);
    let mut expected_prev = GENESIS_HASH.to_string();
    let mut line_no = 0usize;
    for line in reader.lines() {
        let Ok(line) = line else {
            line_no += 1;
            return Err(line_no);
        };
        if line.trim().is_empty() {
            continue;
        }
        line_no += 1;
        let Ok(rec) = serde_json::from_str::<AuditRecord>(&line) else {
            return Err(line_no);
        };
        // 1. 链式衔接：本条 prev_hash 必须等于上一条 record_hash
        if rec.prev_hash != expected_prev {
            return Err(line_no);
        }
        // 2. 内容完整性：重算哈希必须一致（旧记录无 detail/durationMs → None，
        //    canonical JSON 与历史格式一致，混合链兼容）
        let recomputed = record_hash_of(
            rec.timestamp_ms,
            &rec.capability,
            &rec.source,
            &rec.action,
            &rec.prev_hash,
            rec.detail.as_deref(),
            rec.duration_ms,
        );
        if recomputed != rec.record_hash {
            return Err(line_no);
        }
        expected_prev = rec.record_hash;
    }
    Ok(line_no as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::CapabilityId;

    fn tmp_path(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "polaris-audit-test-{}-{}",
            tag,
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("dispatch.jsonl")
    }

    fn entry(action: &str) -> AuditEntry {
        AuditEntry {
            timestamp_ms: 1_700_000_000_000,
            capability: CapabilityId("cap.todo".into()),
            source: Source::Remote { token: "SECRET".into() },
            action: action.into(),
            prev_hash: String::new(),
            detail: None,
            duration_ms: None,
        }
    }

    #[test]
    fn append_creates_chain_and_verifies() {
        let path = tmp_path("chain");
        let sink = FileAuditSink::open(&path).unwrap();
        assert_eq!(sink.last_hash(), GENESIS_HASH);
        sink.append(&entry("dispatch.ok")).unwrap();
        sink.append(&entry("dispatch.deny:permission")).unwrap();
        assert_eq!(sink.count(), 2);
        assert_ne!(sink.last_hash(), GENESIS_HASH, "链尾应推进");

        let total = verify_chain(&path).unwrap();
        assert_eq!(total, 2);

        let (lines, total) = tail_lines(&path, 1).unwrap();
        assert_eq!(total, 2);
        assert_eq!(lines.len(), 1);
        // 脱敏：token 明文不落盘
        assert!(!lines[0].contains("SECRET"));
        assert!(lines[0].contains("\"source\":\"Remote\""));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn tampered_line_is_located() {
        let path = tmp_path("tamper");
        let sink = FileAuditSink::open(&path).unwrap();
        sink.append(&entry("dispatch.ok")).unwrap();
        sink.append(&entry("dispatch.ok")).unwrap();
        sink.append(&entry("dispatch.ok")).unwrap();

        // 篡改第 2 行的 action（不重算哈希）
        let content = fs::read_to_string(&path).unwrap();
        let mut lines: Vec<String> = content.lines().map(String::from).collect();
        lines[1] = lines[1].replace("dispatch.ok", "dispatch.TAMPERED");
        fs::write(&path, lines.join("\n") + "\n").unwrap();

        let broken = verify_chain(&path).unwrap_err();
        assert_eq!(broken, 2, "应定位到被篡改的第 2 行");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn chain_continues_across_reopen() {
        let path = tmp_path("reopen");
        {
            let sink = FileAuditSink::open(&path).unwrap();
            sink.append(&entry("dispatch.ok")).unwrap();
        }
        {
            let sink = FileAuditSink::open(&path).unwrap();
            assert_eq!(sink.count(), 1, "重开应扫描到历史记录");
            sink.append(&entry("dispatch.ok")).unwrap();
        }
        assert_eq!(verify_chain(&path).unwrap(), 2, "重开续链后整体校验应通过");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn genesis_prev_hash_is_linked() {
        let path = tmp_path("genesis");
        let sink = FileAuditSink::open(&path).unwrap();
        sink.append(&entry("dispatch.ok")).unwrap();
        let first = fs::read_to_string(&path).unwrap();
        let rec: AuditRecord = serde_json::from_str(first.lines().next().unwrap()).unwrap();
        assert_eq!(rec.prev_hash, GENESIS_HASH, "首条 prev_hash 应为 GENESIS");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// X4 回归：新字段（detail/durationMs）落盘 + 旧格式记录构成的混合链
    /// 仍可整体校验（升级审计文件不破坏既有 tamper-evident 链）。
    #[test]
    fn mixed_old_and_new_format_chain_verifies() {
        let path = tmp_path("mixed");
        // 1) 手工写一条「旧格式」记录（无 detail/durationMs）。
        //    canonical 串手工按 AuditRecordCore 声明序拼（serde_json::json! 的
        //    Map 字段序不确定，不能用于复现结构体序列化形态）。
        let old_canonical = format!(
            "{{\"timestampMs\":1700000000000,\"capability\":\"cap.todo\",\
             \"source\":\"Bootstrap\",\"action\":\"dispatch.ok\",\"prevHash\":\"{}\"}}",
            GENESIS_HASH
        );
        let mut hasher = Sha256::new();
        hasher.update(GENESIS_HASH.as_bytes());
        hasher.update(old_canonical.as_bytes());
        let old_hash = format!("{:x}", hasher.finalize());
        let old_line = format!(
            "{{\"timestampMs\":1700000000000,\"capability\":\"cap.todo\",\
             \"source\":\"Bootstrap\",\"action\":\"dispatch.ok\",\
             \"prevHash\":\"{}\",\"recordHash\":\"{}\"}}",
            GENESIS_HASH, old_hash
        );
        fs::write(&path, format!("{}\n", old_line)).unwrap();

        // 2) 以新格式续链（带 detail/durationMs）
        let sink = FileAuditSink::open(&path).unwrap();
        assert_eq!(sink.count(), 1, "应扫描到旧格式历史记录");
        let mut enriched = entry("dispatch.error");
        enriched.detail = Some("action=run".into());
        enriched.duration_ms = Some(42);
        sink.append(&enriched).unwrap();

        // 3) 混合链整体校验通过，且新字段确实落盘
        assert_eq!(verify_chain(&path).unwrap(), 2, "旧格式 + 新格式混合链应校验通过");
        let content = fs::read_to_string(&path).unwrap();
        let new_line = content.lines().nth(1).unwrap();
        assert!(new_line.contains("\"detail\":\"action=run\""), "detail 应落盘");
        assert!(new_line.contains("\"durationMs\":42"), "durationMs 应落盘");
        assert!(!content.contains("SECRET"), "token 明文仍不落盘");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
