use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use tracing::Level;
use tracing_subscriber::{fmt, prelude::*};
use tracing_appender::{non_blocking, rolling};

use crate::models::config::LogRetentionConfig;
use crate::services::data_root::data_root;

/// 日志服务
pub struct Logger {
    _guard: Option<non_blocking::WorkerGuard>,
}

#[allow(dead_code)]
impl Logger {
    /// 初始化日志系统
    pub fn init(enabled: bool) -> Self {
        if !enabled {
            // 如果禁用日志，使用默认的空订阅者
            tracing_subscriber::registry()
                .with(fmt::layer().with_writer(std::io::sink))
                .init();
            return Self { _guard: None };
        }

        // 获取日志目录
        let log_dir = Self::log_dir();
        std::fs::create_dir_all(&log_dir).ok();

        // 创建日志文件（按天轮转）。
        // 文件名按实例区分：多实例同时运行时各自写各自的日志文件。
        let log_file = crate::services::instance::log_filename();
        let file_appender = rolling::daily(&log_dir, &log_file);
        let (non_blocking_appender, guard) = non_blocking(file_appender);

        // 配置订阅者
        let env_filter = tracing_subscriber::EnvFilter::builder()
            .with_default_directive(Level::INFO.into())
            .from_env_lossy();

        tracing_subscriber::registry()
            .with(env_filter)
            .with(
                fmt::layer()
                    .with_writer(std::io::stdout)
                    .with_ansi(true)
                    .with_target(false)
            )
            .with(
                fmt::layer()
                    .with_writer(non_blocking_appender)
                    .with_ansi(false)
                    .with_target(true)
            )
            .init();

        Self { _guard: Some(guard) }
    }

    /// 获取日志目录
    pub fn log_dir() -> PathBuf {
        data_root().logs_dir()
    }

    /// 获取当前日志文件路径
    pub fn current_log_file() -> PathBuf {
        Self::log_dir().join(crate::services::instance::log_filename())
    }

    /// 清空日志文件
    pub fn clear_logs() -> Result<(), std::io::Error> {
        let log_dir = Self::log_dir();

        // 删除所有日志文件
        for entry in std::fs::read_dir(log_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("log") ||
               path.extension().and_then(|s| s.to_str()) == Some("gz") {
                std::fs::remove_file(path)?;
            }
        }

        Ok(())
    }

    /// 读取日志内容（DS-1 尾读：从文件尾最多读 [`READ_TAIL_BYTES`] 再取 max_lines 行）
    pub fn read_logs(max_lines: usize) -> Result<String, std::io::Error> {
        let log_file = Self::current_log_file();

        if !log_file.exists() {
            return Ok("暂无日志".to_string());
        }

        let content = read_tail_string(&log_file, READ_TAIL_BYTES)?;

        // 只返回最后 N 行
        let lines: Vec<&str> = content.lines().rev().take(max_lines).collect();
        let result = lines.into_iter().rev().collect::<Vec<_>>().join("\n");

        Ok(result)
    }

    /// 发起启动期日志保留清扫（DS-1 日志管道治理，plans/ds1-log-pipeline-spec.md）。
    ///
    /// 非阻塞：后台短命线程执行，失败静默不 panic，绝不阻塞启动。
    /// 用 `std::thread` 而非 `tokio::spawn`——两个装配点（桌面 `run()` 的
    /// `ConfigStore::new()` 之后、web `run_web_server()` 的 `rt.block_on` 之前）
    /// 此刻都还没有 tokio runtime 上下文，`tokio::spawn` 会 panic
    /// "there is no reactor running"；对齐 lib.rs 启动恢复线程先例
    /// （`std::thread::spawn(recover_pending_turns)`）。清扫是纯短命 IO
    /// （少量 stat + remove），无需 async 运行时。
    pub fn spawn_retention_sweep(cfg: LogRetentionConfig) {
        std::thread::spawn(move || retention_sweep(cfg));
    }
}

/// read_logs 尾读窗口（DS-1）：84MB 洪水日全量 read_to_string 意味着等额的
/// 一次性内存分配，而调用方只需要最后 N 行。从尾部最多读 512KB。
const READ_TAIL_BYTES: u64 = 512 * 1024;

/// 从文件尾部最多读 `window` 字节返回字符串（audit_sink `scan_tail_last_hash`
/// 同款尾读思路）。文件小于 window 时行为与全量 read_to_string 一致。
///
/// 窗口起点可能落在某行中间甚至 UTF-8 多字节字符中间：起点不在文件头时，
/// 先按**字节**（`read_until(b'\n')`，不做 UTF-8 校验）读走不完整半行丢弃，
/// 之后的剩余部分才是完整行，`read_to_string` 不会因切割失败。
fn read_tail_string(path: &PathBuf, window: u64) -> Result<String, std::io::Error> {
    use std::io::{BufRead, Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(window);
    let mut reader = std::io::BufReader::new(&mut file);
    if start > 0 {
        reader.seek(SeekFrom::Start(start))?;
        let mut partial = Vec::new();
        reader.read_until(b'\n', &mut partial)?;
    }
    let mut content = String::new();
    reader.read_to_string(&mut content)?;
    Ok(content)
}

// ============================================================================
// 启动期日志保留清扫（DS-1，plans/ds1-log-pipeline-spec.md）
// ============================================================================

/// 保留清扫的决策结果（纯函数 [`plan_retention`] 的输出，便于单测）。
#[derive(Debug, Default, PartialEq)]
pub struct RetentionPlan {
    /// 待删除文件（路径, 大小字节），按 mtime 旧→新排序（超限时最旧先删）
    pub to_delete: Vec<(PathBuf, u64)>,
    /// 因策略跳过的文件数（命名不匹配 / 当日活跃文件）
    pub skipped: usize,
    /// to_delete 全部删除成功时的释放字节数（实际释放由 sweep 按成功数计）
    pub bytes_freed: u64,
}

/// 日志保留决策纯函数：输入文件列表 (路径, mtime, 大小) + now + 配置 +
/// 本应用日志文件基名，输出待删/跳过/释放字节。不触碰文件系统，便于单测。
///
/// 规则（spec §三.1）：
/// 1. `enabled=false` 整体跳过（to_delete 空）；
/// 2. 只匹配本应用日志命名（`base_filename` + rolling 日期后缀，见
///    [`is_rotated_log_file`]），不匹配的计入 skipped，误伤面为零；
/// 3. **当日活跃文件永不删**（Windows 文件锁 + 正在写入；硬规则，即使总量
///    超限也从它让步），计入 skipped；
/// 4. mtime 早于 now − max_age_days 的过期文件删除（旧→新）；
/// 5. 过期删除后总量仍超 max_total_mb，从未过期的最旧起删到限内。
///
/// `base_filename` 相对 spec 原签名（files/now/cfg）多出一参：使命名匹配
/// 规则本身可单测，且清扫不隐式依赖全局实例状态。
pub fn plan_retention(
    files: Vec<(PathBuf, SystemTime, u64)>,
    now: SystemTime,
    cfg: &LogRetentionConfig,
    base_filename: &str,
) -> RetentionPlan {
    let mut plan = RetentionPlan::default();
    if !cfg.enabled {
        // enabled=false：整体跳过，一个文件都不动（不可逆删除必须 config 可关）
        return plan;
    }
    let limit_bytes = cfg.max_total_mb.saturating_mul(1024 * 1024);
    let cutoff = now - Duration::from_secs(cfg.max_age_days.saturating_mul(86_400));
    let today = local_date(now);

    // (mtime, path, size, expired)，已剔除不匹配与当日文件
    let mut candidates: Vec<(SystemTime, PathBuf, u64, bool)> = Vec::new();
    let mut total_bytes = 0u64;
    for (path, mtime, size) in files {
        let matched = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| is_rotated_log_file(n, base_filename))
            .unwrap_or(false);
        if !matched {
            plan.skipped += 1;
            continue;
        }
        total_bytes += size;
        if local_date(mtime) == today {
            // 当日活跃文件永不删：性能治理 plans/ds1-log-pipeline-spec.md；
            // 当日活跃文件永不删（Windows 文件锁 + 在写）
            plan.skipped += 1;
            continue;
        }
        let expired = mtime < cutoff;
        candidates.push((mtime, path, size, expired));
    }
    // 旧→新排序：mtime 并列时按路径保证确定性
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    // 阶段 1：过期文件全删（旧→新）
    for (_, path, size, expired) in &candidates {
        if !*expired {
            continue;
        }
        plan.to_delete.push((path.clone(), *size));
        plan.bytes_freed += *size;
    }
    // 阶段 2：总量超限，从未过期的最旧起删到限内
    let mut remaining = total_bytes.saturating_sub(plan.bytes_freed);
    if remaining > limit_bytes {
        for (_, path, size, expired) in &candidates {
            if remaining <= limit_bytes {
                break;
            }
            if *expired {
                continue; // 已在阶段 1
            }
            plan.to_delete.push((path.clone(), *size));
            plan.bytes_freed += *size;
            remaining -= *size;
        }
    }
    plan
}

/// 是否为本应用的按天轮转日志文件名。
///
/// 命名模式实测（2026-11-01，生产数据根 102 文件 + Polaris-dev 44 文件归纳）：
/// `tracing_appender::rolling::daily(&dir, "app.log")` 生成的文件名为
/// `app.log.YYYY-MM-DD`（基名 + `.` + 日期）；实例 n 的基名为 `app-<n>.log`，
/// 轮转文件即 `app-<n>.log.YYYY-MM-DD`。目录内不存在无日期后缀的裸 `app.log`。
/// 只匹配该形态，其余文件（用户/他方文件）一律不参与删除。
fn is_rotated_log_file(name: &str, base_filename: &str) -> bool {
    let Some(rest) = name.strip_prefix(base_filename) else {
        return false;
    };
    let Some(date) = rest.strip_prefix('.') else {
        return false;
    };
    is_yyyy_mm_dd(date)
}

/// 严格 `YYYY-MM-DD`（10 字节，数字-横线形态）。
fn is_yyyy_mm_dd(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..10].iter().all(u8::is_ascii_digit)
}

/// SystemTime 的本地日历日（「当日活跃文件」判定）。
fn local_date(t: SystemTime) -> chrono::NaiveDate {
    chrono::DateTime::<chrono::Local>::from(t).date_naive()
}

/// 启动期保留清扫（同步实现，经 [`Logger::spawn_retention_sweep`] 后台执行）：
/// 遍历日志目录 → [`plan_retention`] 决策 → 逐个 remove_file（失败跳过计数，
/// 如被另一实例占用）→ 落一条 info 汇总（不逐条打，AGENTS.md §六）。
fn retention_sweep(cfg: LogRetentionConfig) {
    let log_dir = Logger::log_dir();
    if !cfg.enabled {
        tracing::debug!("[Logger] 日志保留清扫未启用（logRetention.enabled=false），跳过");
        return;
    }
    let Ok(entries) = std::fs::read_dir(&log_dir) else {
        // 日志目录不存在（首次启动）无需清扫，静默即可
        tracing::debug!("[Logger] 日志目录不存在，跳过保留清扫: {:?}", log_dir);
        return;
    };
    let now = SystemTime::now();
    let base_filename = crate::services::instance::log_filename();
    let mut files: Vec<(PathBuf, SystemTime, u64)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(mtime) = meta.modified() else {
            continue;
        };
        files.push((path, mtime, meta.len()));
    }
    let scanned = files.len();
    let plan = plan_retention(files, now, &cfg, &base_filename);

    let mut deleted = 0usize;
    let mut freed = 0u64;
    let mut failed = 0usize;
    for (path, size) in &plan.to_delete {
        match std::fs::remove_file(path) {
            Ok(()) => {
                deleted += 1;
                freed += *size;
            }
            Err(e) => {
                // 删除失败（被另一实例占用/权限）跳过并计数，不 panic 不阻塞启动
                failed += 1;
                tracing::debug!("[Logger] 删除日志文件失败跳过: {:?}: {}", path, e);
            }
        }
    }
    tracing::info!(
        "[Logger] 日志保留清扫完成: 扫描 {} 文件, 计划删 {} 个({} 字节), 实删 {} 个释放 {} 字节, 失败跳过 {}, 策略跳过 {}(命名不匹配/当日活跃)",
        scanned,
        plan.to_delete.len(),
        plan.bytes_freed,
        deleted,
        freed,
        failed,
        plan.skipped
    );
}

// 使用宏简化日志调用
#[macro_export]
macro_rules! app_info {
    ($($arg:tt)*) => {
        tracing::info!($($arg)*)
    };
}

#[macro_export]
macro_rules! app_error {
    ($($arg:tt)*) => {
        tracing::error!($($arg)*)
    };
}

#[macro_export]
macro_rules! app_warn {
    ($($arg:tt)*) => {
        tracing::warn!($($arg)*)
    };
}

#[macro_export]
macro_rules! app_debug {
    ($($arg:tt)*) => {
        tracing::debug!($($arg)*)
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// 构造保留配置
    fn cfg(enabled: bool, max_age_days: u64, max_total_mb: u64) -> LogRetentionConfig {
        LogRetentionConfig {
            enabled,
            max_age_days,
            max_total_mb,
        }
    }

    fn days_ago(now: SystemTime, days: u64) -> SystemTime {
        now - Duration::from_secs(days * 86_400)
    }

    fn f(name: &str) -> PathBuf {
        PathBuf::from(name)
    }

    const BASE: &str = "app.log";

    /// 过期删：mtime 早于 now − max_age_days 的文件进 to_delete，释放字节正确
    #[test]
    fn plan_deletes_expired_files() {
        let now = SystemTime::now();
        let files = vec![
            (f("app.log.2026-08-09"), days_ago(now, 30), 1000),
            (f("app.log.2026-10-25"), days_ago(now, 5), 2000),
        ];
        let plan = plan_retention(files, now, &cfg(true, 14, 500), BASE);
        assert_eq!(plan.to_delete, vec![(f("app.log.2026-08-09"), 1000)]);
        assert_eq!(plan.bytes_freed, 1000);
        assert_eq!(plan.skipped, 0);
    }

    /// 未过期留：14 天内的文件一个不动
    #[test]
    fn plan_keeps_recent_files() {
        let now = SystemTime::now();
        let files = vec![
            (f("app.log.2026-10-25"), days_ago(now, 5), 2000),
            (f("app.log.2026-10-30"), days_ago(now, 1), 3000),
        ];
        let plan = plan_retention(files, now, &cfg(true, 14, 500), BASE);
        assert!(plan.to_delete.is_empty());
        assert_eq!(plan.bytes_freed, 0);
    }

    /// 当日活跃文件永不删：即使总量超限（max_total_mb 压到只剩当日文件）也绝不删
    #[test]
    fn plan_never_deletes_today_active_file() {
        let now = SystemTime::now();
        // 只有当日文件，总量 10MB > 1MB 上限
        let files = vec![(f("app.log.2026-11-01"), now, 10 * 1024 * 1024)];
        let plan = plan_retention(files, now, &cfg(true, 14, 1), BASE);
        assert!(plan.to_delete.is_empty(), "当日活跃文件永不删（硬规则）");
        assert_eq!(plan.skipped, 1);
        assert_eq!(plan.bytes_freed, 0);
    }

    /// 超限最旧先删：过期删完后仍超限，从未过期的最旧起删到限内
    #[test]
    fn plan_deletes_oldest_first_when_over_limit() {
        let now = SystemTime::now();
        let mb = 1024 * 1024u64;
        // 3 个未过期文件（5 天前）共 11MB，上限 8MB → 删最旧 6MB 后剩 5MB
        let files = vec![
            (f("app.log.2026-10-20"), days_ago(now, 5), 3 * mb),
            (f("app.log.2026-10-19"), days_ago(now, 6), 6 * mb),
            (f("app.log.2026-10-21"), days_ago(now, 4), 2 * mb),
        ];
        let plan = plan_retention(files, now, &cfg(true, 14, 8), BASE);
        assert_eq!(plan.to_delete, vec![(f("app.log.2026-10-19"), 6 * mb)]);
        assert_eq!(plan.bytes_freed, 6 * mb);
        // to_delete 必须按旧→新排序（删除顺序语义）
        let order: Vec<&str> = plan
            .to_delete
            .iter()
            .map(|(p, _)| p.to_str().unwrap())
            .collect();
        let mut sorted = order.clone();
        sorted.sort();
        assert_eq!(order, sorted);
    }

    /// enabled=false 全留：不可逆删除必须 config 可关
    #[test]
    fn plan_noop_when_disabled() {
        let now = SystemTime::now();
        let files = vec![(f("app.log.2026-08-09"), days_ago(now, 90), 999)];
        let plan = plan_retention(files, now, &cfg(false, 14, 500), BASE);
        assert!(plan.to_delete.is_empty());
        assert_eq!(plan.skipped, 0);
        assert_eq!(plan.bytes_freed, 0);
    }

    /// 组合：过期 + 未过期 + 当日同时存在且超限——过期删、未过期旧的删到限内、
    /// 当日文件无论如何保留
    #[test]
    fn plan_combined_expired_recent_and_today() {
        let now = SystemTime::now();
        let mb = 1024 * 1024u64;
        let files = vec![
            (f("app.log.2026-10-01"), days_ago(now, 30), 5 * mb), // 过期
            (f("app.log.2026-10-26"), days_ago(now, 5), 5 * mb),  // 未过期
            (f("app.log.2026-11-01"), now, 10 * mb),              // 当日活跃
        ];
        // 上限 12MB：过期删 5MB 后剩 15MB 仍超 → 再删未过期的 5MB → 剩 10MB（当日）
        let plan = plan_retention(files, now, &cfg(true, 14, 12), BASE);
        assert_eq!(
            plan.to_delete,
            vec![
                (f("app.log.2026-10-01"), 5 * mb),
                (f("app.log.2026-10-26"), 5 * mb),
            ]
        );
        assert_eq!(plan.bytes_freed, 10 * mb);
        assert_eq!(plan.skipped, 1, "当日文件计一次策略跳过");
    }

    /// 只匹配本应用日志命名：目录里的他方文件一律计入 skipped 不参与删除
    #[test]
    fn plan_skips_non_app_files() {
        let now = SystemTime::now();
        let files = vec![
            (f("other-tool.txt"), days_ago(now, 90), 1),
            (f("readme.md"), days_ago(now, 90), 1),
            (f("app.log"), days_ago(now, 90), 1), // 无日期后缀的裸基名不匹配
        ];
        let plan = plan_retention(files, now, &cfg(true, 14, 500), BASE);
        assert!(plan.to_delete.is_empty());
        assert_eq!(plan.skipped, 3);
    }

    /// rolling 命名匹配规则（实测模式：基名 + `.` + YYYY-MM-DD）
    #[test]
    fn rotated_name_matching() {
        // 命中：实例 0 与实例 n 的轮转名
        assert!(is_rotated_log_file("app.log.2026-08-09", "app.log"));
        assert!(is_rotated_log_file("app-1.log.2026-08-09", "app-1.log"));
        assert!(is_rotated_log_file("app-42.log.2026-12-31", "app-42.log"));
        // 不命中：裸基名 / 他方前缀 / 日期位型不对 / 缺日期
        assert!(!is_rotated_log_file("app.log", "app.log"));
        assert!(!is_rotated_log_file("app.log.2026-08-09.old", "app.log"));
        assert!(!is_rotated_log_file("evil.log.2026-08-09", "app.log"));
        assert!(!is_rotated_log_file("app.log.2026-8-9", "app.log"));
        assert!(!is_rotated_log_file("app.log.20260809", "app.log"));
        assert!(!is_rotated_log_file("app.log.abcdefghij", "app.log"));
    }

    /// read_logs 尾读：大于窗口的文件只取尾部窗口，max_lines 语义不变
    #[test]
    fn read_tail_string_reads_only_tail_window() {
        let dir = std::env::temp_dir().join(format!("polaris-logger-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tail-test.log");
        let line = "x".repeat(999) + "\n";
        let body = line.repeat(2000); // ~2MB
        std::fs::write(&path, &body).unwrap();
        let tail = read_tail_string(&path, READ_TAIL_BYTES).unwrap();
        assert!(tail.len() as u64 <= READ_TAIL_BYTES + 1100);
        // 尾读结果必须是尾部内容（以最后一个完整行收尾）
        assert!(tail.ends_with(&line));
        // 行数语义：取尾 5 行
        let lines: Vec<&str> = tail.lines().rev().take(5).collect();
        assert_eq!(lines.len(), 5);
        std::fs::remove_file(&path).ok();
        std::fs::remove_dir(&dir).ok();
    }

    /// read_logs 尾读：文件小于窗口时行为与全量读一致
    #[test]
    fn read_tail_string_small_file_matches_full_read() {
        let dir = std::env::temp_dir().join(format!("polaris-logger-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("small-test.log");
        let body = "a\nbb\nccc\n";
        std::fs::write(&path, body).unwrap();
        let tail = read_tail_string(&path, READ_TAIL_BYTES).unwrap();
        assert_eq!(tail, body);
        std::fs::remove_file(&path).ok();
        std::fs::remove_dir(&dir).ok();
    }
}
