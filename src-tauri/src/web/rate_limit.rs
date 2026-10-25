//! 登录端点限速(P0 安全部署闸,plans/p0-web-security-gate-spec.md §2)
//!
//! 唯一所有者:进程内静态失败记录表(登录尝试没有第二个写者)。
//! 接入点:`POST /api/auth/token`(唯一"登录"入口)。Bearer/WS 的 token 校验
//! 是常量时间比较、无登录语义,不经过本模块。
//!
//! 规则:
//! - 仅记录**失败的** token 交换;成功即清空该 key 的记录
//! - 单 key:60 秒滑动窗口内 `PER_KEY_LIMIT` 次失败 → 429
//!   (反代场景 key = `X-Forwarded-For` 首段,直连场景 key = socket IP)
//! - 全局:60 秒内 `GLOBAL_LIMIT` 次失败 → 429(XFF 可被直连攻击者伪造,
//!   单 key 限制可被换 key 绕过,全局上限兜底)
//! - 纯 std 实现,不引新依赖

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// 单 key 失败上限(60s 滑动窗口)
const PER_KEY_LIMIT: usize = 15;
/// 全局失败上限(60s 滑动窗口)
const GLOBAL_LIMIT: usize = 100;
/// 滑动窗口长度
const WINDOW: Duration = Duration::from_secs(60);
/// per_key 表容量上限:防伪造 XFF 撑表(每次失败仍计入全局上限,清空不放松防护)
const PER_KEY_MAP_CAP: usize = 10_000;
/// 限速 key 的最大长度(XFF 取值截断,防超长 header 撑内存)
const KEY_MAX_CHARS: usize = 64;

#[derive(Default)]
struct FailureLog {
    /// key → 窗口内失败时刻
    per_key: HashMap<String, Vec<Instant>>,
    global: Vec<Instant>,
}

static FAILURE_LOG: OnceLock<Mutex<FailureLog>> = OnceLock::new();

fn lock_log() -> MutexGuard<'static, FailureLog> {
    let mutex = FAILURE_LOG.get_or_init(|| Mutex::new(FailureLog::default()));
    // 锁被投毒只可能发生在持锁线程 panic 时；限速计数不属于需要毒化保护的
    // 不变式,直接接管继续工作。
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn prune(v: &mut Vec<Instant>, now: Instant) {
    v.retain(|t| now.duration_since(*t) < WINDOW);
}

/// 窗口内最早一次失败还需多久解禁(向上取整秒,至少 1)。
fn retry_after_seconds(v: &[Instant], now: Instant) -> u64 {
    let earliest = v.iter().min().copied().unwrap_or(now);
    WINDOW
        .checked_sub(now.duration_since(earliest))
        .map(|d| d.as_secs().max(1))
        .unwrap_or(1)
}

/// 判定该 key 当前是否允许尝试登录。`Err(秒数)` 表示超限,调用方回 429。
pub fn check_login_allowed(key: &str) -> Result<(), u64> {
    let mut log = lock_log();
    let now = Instant::now();
    if let Some(v) = log.per_key.get_mut(key) {
        prune(v, now);
    }
    prune(&mut log.global, now);

    if log.global.len() >= GLOBAL_LIMIT {
        return Err(retry_after_seconds(&log.global, now));
    }
    if log.per_key.get(key).is_some_and(|v| v.len() >= PER_KEY_LIMIT) {
        // unwrap 安全:上一行刚确认 key 存在
        let v = log.per_key.get(key).unwrap();
        return Err(retry_after_seconds(v, now));
    }
    Ok(())
}

/// 记录一次失败尝试(key + 全局双计数)。
pub fn record_login_failure(key: &str) {
    let mut log = lock_log();
    let now = Instant::now();
    let entry = log.per_key.entry(key.to_string()).or_default();
    entry.push(now);
    log.global.push(now);
    if log.per_key.len() > PER_KEY_MAP_CAP {
        // 容量防御:伪造海量 XFF key 撑表时清空;全局计数仍在,总体防护不放松。
        log.per_key.clear();
    }
}

/// 登录成功后清空该 key 的失败记录。
pub fn clear_login_failures(key: &str) {
    let mut log = lock_log();
    log.per_key.remove(key);
}

/// 提取限速 key:优先 `X-Forwarded-For` 首段(反代场景),否则 socket IP,
/// 都没有用 "unknown"(单测/本机直调无 ConnectInfo 的场景)。
pub fn rate_limit_key(x_forwarded_for: Option<&str>, socket_ip: Option<IpAddr>) -> String {
    if let Some(xff) = x_forwarded_for {
        let first = xff.split(',').next().unwrap_or("").trim();
        if !first.is_empty() {
            return first.chars().take(KEY_MAX_CHARS).collect();
        }
    }
    socket_ip
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_prefers_xff_first_segment() {
        assert_eq!(
            rate_limit_key(Some("203.0.113.7, 10.0.0.1"), Some("192.168.1.2".parse().unwrap())),
            "203.0.113.7"
        );
    }

    #[test]
    fn key_falls_back_to_socket_then_unknown() {
        assert_eq!(
            rate_limit_key(None, Some("192.168.1.2".parse().unwrap())),
            "192.168.1.2"
        );
        assert_eq!(rate_limit_key(None, None), "unknown");
        assert_eq!(rate_limit_key(Some("  "), None), "unknown");
    }

    #[test]
    fn key_is_bounded() {
        let long = "a".repeat(500);
        assert_eq!(rate_limit_key(Some(&long), None).chars().count(), KEY_MAX_CHARS);
    }
}
