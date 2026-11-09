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
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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

/// 尾部续链扫描窗口（spec audit-startup-firsttoken-root-cure §A.2）：
/// 续链只需最后一条有效记录的 `record_hash`，从文件末尾回读该窗口即可，
/// 不再全量扫描——历史单文件曾积累 3GB/695 万条，全量 serde_json 解析使
/// 启动阻塞 16s（2026-10-30 生产日志 00:19:13.5→00:19:29.8 实证）。
const TAIL_SCAN_BYTES: u64 = 64 * 1024;

/// 归档超大旧式审计文件（spec §A.2，P0-1 配套）。
///
/// 单文件无轮转的历史布局已证明会无限增长（13.9 万条/天）。打开 sink 前
/// 把超过 `max_bytes` 的文件整体改名进同级 `archive/`（保留可回溯），
/// 当前路径从空文件重新起链。
///
/// 加固 H-5：返回 `ArchiveOutcome` 区分三种状态——归档成功 / 未超限 / 改名失败，
/// 让调用方能落可区分的日志（多实例并发归档时 rename 失败与未超限不再同返 None，
/// 归档成功率/竞态可观测）。绝不阻塞启动，尾读续链本身已 O(1)。
pub fn archive_oversized_legacy(path: &Path, max_bytes: u64) -> ArchiveOutcome {
    let Ok(meta) = fs::metadata(path) else {
        return ArchiveOutcome::NotOversized; // 文件不存在视为未超限
    };
    if !meta.is_file() || meta.len() <= max_bytes {
        return ArchiveOutcome::NotOversized;
    }
    let Some(parent) = path.parent() else {
        return ArchiveOutcome::RenameFailed;
    };
    let dir = parent.join("archive");
    if fs::create_dir_all(&dir).is_err() {
        return ArchiveOutcome::RenameFailed;
    }
    // 目标名：dispatch-<mtime YYYYMMDD-HHMMSS>.<ext>，撞名追加序号
    let stamp = match meta.modified() {
        Ok(m) => chrono::DateTime::<chrono::Utc>::from(m)
            .format("%Y%m%d-%H%M%S")
            .to_string(),
        Err(_) => return ArchiveOutcome::RenameFailed,
    };
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
        return ArchiveOutcome::RenameFailed;
    };
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("jsonl");
    let mut target = dir.join(format!("{}-{}.{}", stem, stamp, ext));
    let mut n = 2;
    while target.exists() {
        target = dir.join(format!("{}-{}-{}.{}", stem, stamp, n, ext));
        n += 1;
    }
    match fs::rename(path, &target) {
        Ok(()) => ArchiveOutcome::Archived(target),
        // 被其他实例占用（Windows 改名打开中的文件可能成功也可能失败）：
        // 失败即放弃本次归档，下次启动再试
        Err(_) => ArchiveOutcome::RenameFailed,
    }
}

/// 归档结果（加固 H-5）：让调用方按状态落可区分日志。
#[derive(Debug)]
pub enum ArchiveOutcome {
    /// 已归档到 archive/（携带目标路径）
    Archived(PathBuf),
    /// 未超限 / 文件不存在 → 不动
    NotOversized,
    /// rename 失败（多实例占用、权限等）→ 静默跳过，下次再试
    RenameFailed,
}

/// 从文件尾部 `window` 字节窗口扫描最后一条有效记录的 `record_hash`。
///
/// 返回 `(last_hash, 窗口内非空行数)`：
/// - 窗口起点落在某行中间 → 该不完整半行读走丢弃（窗口内其余行完整）；
/// - 文件末行无换行符（写入中崩溃截断）→ 解析失败自动沿用上一条有效记录；
/// - 语义与旧全量扫描一致：无效行不中断，链哈希只认最后一条有效记录。
fn scan_tail_last_hash(path: &Path, window: u64) -> (String, u64) {
    let Ok(file) = File::open(path) else {
        return (GENESIS_HASH.to_string(), 0);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len == 0 {
        return (GENESIS_HASH.to_string(), 0);
    }
    let mut reader = BufReader::new(file);
    let start = len.saturating_sub(window);
    if start > 0 {
        use std::io::Seek as _;
        if reader.seek(std::io::SeekFrom::Start(start)).is_err() {
            return (GENESIS_HASH.to_string(), 0);
        }
        // 窗口首行大概率是被截断的半行，读走丢弃
        let mut partial = String::new();
        let _ = reader.read_line(&mut partial);
    }
    let mut last_hash = GENESIS_HASH.to_string();
    let mut lines = 0u64;
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = buf.trim_end_matches(['\n', '\r']);
        if line.trim().is_empty() {
            continue;
        }
        lines += 1;
        if let Ok(rec) = serde_json::from_str::<AuditRecord>(line) {
            last_hash = rec.record_hash;
        }
    }
    (last_hash, lines)
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
    /// 打开（或创建）审计文件并续链（O(1)：尾读，spec §A.2）。
    ///
    /// 从文件尾部 `TAIL_SCAN_BYTES` 窗口取最后一条有效记录的 `record_hash`
    /// 续链（文件中断/损坏由 `verify_chain` 显式发现，这里不阻塞写入）。
    /// 打开后 `count()` 只含尾读窗口内行数——历史总量不再全量扫描获取。
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建审计目录失败: {}", e))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| format!("打开审计文件失败: {}", e))?;

        let (last_hash, tail_count) = scan_tail_last_hash(path, TAIL_SCAN_BYTES);

        Ok(Self {
            inner: Mutex::new(SinkState {
                file,
                last_hash,
                count: tail_count,
            }),
        })
    }

    /// 当前链尾哈希（测试/诊断用）
    pub fn last_hash(&self) -> String {
        self.inner.lock().unwrap().last_hash.clone()
    }

    /// 已追加条数（打开时尾读窗口内的行数 + 本次追加数）。
    ///
    /// **语义变更（P0-1）**：不再等于历史总条数——O(1) 启动的代价是只扫尾部
    /// `TAIL_SCAN_BYTES` 窗口。历史总量按需走 `verify_chain`（全量扫描）或
    /// `tail_lines`（audit_tail 命令独立全量读，返回自己的 total）。
    /// 唯一生产侧消费者是 `state.rs` 启动日志（打印一次），不作为总量展示。
    pub fn count(&self) -> u64 {
        self.inner.lock().unwrap().count
    }

    fn append_inner(&self, entry: &AuditEntry) -> Result<(), String> {
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

impl AuditSink for FileAuditSink {
    fn append(&self, entry: &AuditEntry) -> Result<(), String> {
        let started = Instant::now();
        let result = self.append_inner(entry);
        // 慢追加观测（2026-10-31 楔死取证）：append 是每条 dispatch 的必经点，
        // 若文件写被外部因素拖慢（杀软实时扫描/磁盘停顿），所有 dispatch 会
        // 在此排队——生产楔死时 watchdog 点名 cap.kv 但 sqlite 慢操作为零，
        // 本观测点用于二值定位「storage 慢 vs audit 慢」。
        //
        // 加固 H-3：>500ms warn 进程级 10s 去重——cap.kv 高频期若 append 卡住，
        // 原实现每秒落 60 条 warn 反向制造洪水。窗口内重复降 debug。
        let elapsed = started.elapsed();
        if elapsed >= Duration::from_millis(500) {
            observe_slow_append(&entry.capability.0, elapsed);
        }
        result
    }

}

/// 慢追加告警去重（加固 H-3）：进程级 10s 窗口，每 capability 最多 1 条 warn。
fn observe_slow_append(capability: &str, elapsed: Duration) {
    static LAST_WARN: OnceLock<Mutex<std::collections::HashMap<String, Instant>>> = OnceLock::new();
    let last = LAST_WARN.get_or_init(|| Mutex::new(std::collections::HashMap::new()));

    let now = Instant::now();
    let should_warn = {
        let mut guard = last.lock().unwrap();
        match guard.get(capability) {
            Some(t) if now.duration_since(*t) < Duration::from_secs(10) => false,
            _ => {
                guard.insert(capability.to_string(), now);
                true
            }
        }
    };
    if should_warn {
        tracing::warn!(
            capability = %capability,
            elapsed_ms = elapsed.as_millis() as u64,
            "[AuditSink] 慢追加（>500ms），dispatch 排队元候（10s 去重）"
        );
    } else {
        tracing::debug!(
            capability = %capability,
            elapsed_ms = elapsed.as_millis() as u64,
            "[AuditSink] 慢追加（10s 窗口内已 warn，本次降 debug）"
        );
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
            capability: CapabilityId("cap.kv".into()),
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

    /// P0-1：末行被截断（无换行 + 非法 JSON）时，续链沿用上一条有效记录
    /// 且重开后续链校验通过。
    #[test]
    fn reopen_with_truncated_last_line_keeps_last_valid_hash() {
        let path = tmp_path("truncated");
        {
            let sink = FileAuditSink::open(&path).unwrap();
            sink.append(&entry("dispatch.ok")).unwrap();
            sink.append(&entry("dispatch.ok")).unwrap();
        }
        // 模拟写入中崩溃：追加半行（无换行、非法 JSON）
        let mut content = fs::read_to_string(&path).unwrap();
        content.push_str("{\"timestampMs\":1700000000");
        fs::write(&path, content).unwrap();

        let sink = FileAuditSink::open(&path).unwrap();
        // 链尾 = 第 2 条完整记录的 hash（截断行被忽略）
        let content = fs::read_to_string(&path).unwrap();
        let second: AuditRecord =
            serde_json::from_str(content.lines().nth(1).unwrap()).unwrap();
        assert_eq!(sink.last_hash(), second.record_hash, "应沿用最后一条有效记录");
        sink.append(&entry("dispatch.ok")).unwrap();
        // 截断半行 + 新记录后，链校验应定位到截断行（第 3 行）而非静默通过
        assert_eq!(verify_chain(&path).unwrap_err(), 3, "截断行应被 verify_chain 定位");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// P0-1：窗口小于文件时只扫窗口内行，链尾哈希仍正确。
    #[test]
    fn tail_scan_with_small_window_finds_last_hash() {
        let path = tmp_path("window");
        {
            let sink = FileAuditSink::open(&path).unwrap();
            for _ in 0..50 {
                sink.append(&entry("dispatch.ok")).unwrap();
            }
        }
        // 每行约 300B，256B 窗口必然落在文件中部
        let (last_hash, lines) = scan_tail_last_hash(&path, 256);
        assert!(lines >= 1 && lines <= 3, "窗口内行数应远小于全量 50 行，实际 {}", lines);
        let content = fs::read_to_string(&path).unwrap();
        let last: AuditRecord = serde_json::from_str(content.lines().last().unwrap()).unwrap();
        assert_eq!(last_hash, last.record_hash, "窗口扫描应命中全文件链尾");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// P0-1：超大文件被归档（保留在 archive/），当前路径重新起链；
    /// 未超限文件不归档；rename 失败状态可区分（加固 H-5）。
    #[test]
    fn archive_oversized_legacy_moves_and_restarts_chain() {
        let path = tmp_path("archive");
        fs::write(&path, "x".repeat(4096)).unwrap();

        // 未超限 → NotOversized（不动）
        assert!(matches!(
            archive_oversized_legacy(&path, 8192),
            ArchiveOutcome::NotOversized
        ));
        assert!(path.exists(), "未超限文件应保留原位");

        // 超限 → Archived（携带目标路径），原路径消失，重开从 GENESIS 起链
        let archived = match archive_oversized_legacy(&path, 1024) {
            ArchiveOutcome::Archived(p) => p,
            other => panic!("超限文件应被归档，实际 {:?}", other),
        };
        assert!(archived.parent().unwrap().ends_with("archive"));
        assert!(archived.exists());
        assert!(!path.exists(), "归档后原路径应不存在");

        let sink = FileAuditSink::open(&path).unwrap();
        assert_eq!(sink.last_hash(), GENESIS_HASH, "归档后应从 GENESIS 起新链");
        sink.append(&entry("dispatch.ok")).unwrap();
        assert_eq!(verify_chain(&path).unwrap(), 1, "新文件自身链应完整");
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
            "{{\"timestampMs\":1700000000000,\"capability\":\"cap.kv\",\
             \"source\":\"Bootstrap\",\"action\":\"dispatch.ok\",\"prevHash\":\"{}\"}}",
            GENESIS_HASH
        );
        let mut hasher = Sha256::new();
        hasher.update(GENESIS_HASH.as_bytes());
        hasher.update(old_canonical.as_bytes());
        let old_hash = format!("{:x}", hasher.finalize());
        let old_line = format!(
            "{{\"timestampMs\":1700000000000,\"capability\":\"cap.kv\",\
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
