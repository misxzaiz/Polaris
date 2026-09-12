/*! HTTP 请求重试（Phase 3.2）

对 `429 / 5xx / 网络错误` 做退避重试。`400 / 401 / 403` 等其他 4xx 立即返回错误，不重试。

两套退避策略：
- **429 限流（tpm/rpm）**：长退避序列 `10s / 30s / 60s`。tpm/rpm 是「分钟窗口」配额，
  短间隔快速重试会全部落在同一限流窗口内，必然连续 429；须等到窗口量级配额才恢复。
- **5xx / 网络错误（瞬时故障）**：指数退避 `base * 2^(attempt-1)`（默认 500ms），快速重试。
- 两者都尊重 `Retry-After` 响应头（秒）；429 无该头时回落到 `RATE_LIMIT_BACKOFF_SECS` 序列。

设计要点：
- 决策逻辑（`is_retryable_status` / `backoff_delay` / `rate_limit_backoff_delay` / `parse_retry_after`）
  为纯函数，单测覆盖。
- `send_with_retry` 是循环胶水：try_clone 请求 → send → 按状态/错误决策 → sleep 或返回。
- 重试需要 `RequestBuilder::try_clone`；SimpleAI 的请求体是 JSON 字符串，可克隆。
- 退避无抖动（确定性，便于测试）；生产可后续加 `rand` 抖动。
 */

use std::time::Duration;

use crate::error::{AppError, Result};

/// 默认最大尝试次数（含首次）。
/// 默认 4 = 「初始请求 + 3 次重试」，配合 429 长退避（10s/30s/60s）正好 3 次睡眠。
/// `SIMPLE_AI_RETRY_MAX` 可覆盖（设 1 = 不重试）。
pub(super) const DEFAULT_RETRY_MAX_ATTEMPTS: u32 = 4;
/// 默认退避基数（毫秒，5xx/网络错误用）。`SIMPLE_AI_RETRY_BASE_MS` 可覆盖。
pub(super) const DEFAULT_RETRY_BASE_MS: u64 = 500;

/// 429 限流专用退避序列（秒）：tpm/rpm 是分钟窗口，短退避会全部撞在同一窗口。
/// attempt=1/2/3 依次取 10s/30s/60s；越界饱和到末值（不再无限等待）。
const RATE_LIMIT_BACKOFF_SECS: [u64; 3] = [10, 30, 60];

/// 判定 HTTP 状态码是否可重试（429 / 5xx）。
pub(super) fn is_retryable_status(status: u16) -> bool {
    matches!(status, 429 | 500..=599)
}

/// 计算第 `attempt` 次重试的退避时长（指数：base * 2^(attempt-1)）。
/// `attempt` 从 1 起。饱和运算避免溢出。
pub(super) fn backoff_delay(attempt: u32, base_ms: u64) -> Duration {
    let exponent = attempt.saturating_sub(1);
    let ms = base_ms.saturating_mul(2u64.saturating_pow(exponent));
    Duration::from_millis(ms)
}

/// 429 限流专用的长退避时长（秒级序列 10/30/60）。
/// `attempt` 从 1 起；越界饱和到序列末值（60s），避免无限延长等待。
pub(super) fn rate_limit_backoff_delay(attempt: u32) -> Duration {
    let idx = (attempt.saturating_sub(1) as usize).min(RATE_LIMIT_BACKOFF_SECS.len() - 1);
    Duration::from_secs(RATE_LIMIT_BACKOFF_SECS[idx])
}

/// 解析 `Retry-After` 头（仅支持秒数；HTTP 日期格式不支持，返回 None）。
fn parse_retry_after(value: Option<&str>) -> Option<Duration> {
    value?.parse::<u64>().ok().map(Duration::from_secs)
}

/// 带重试地发送请求。
///
/// 成功（2xx）返回 `Response`；不可重试错误或达上限后返回最后一次错误。
pub(super) async fn send_with_retry(
    req: reqwest::RequestBuilder,
    max_attempts: u32,
    base_ms: u64,
) -> Result<reqwest::Response> {
    // max_attempts 至少为 1（首次尝试）。
    let max_attempts = max_attempts.max(1);
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        // try_clone：body 是 JSON 字符串可克隆；不可克隆则立即失败（不重试）。
        let cloned = req.try_clone().ok_or_else(|| {
            AppError::ProcessError("request body is not cloneable for retry".to_string())
        })?;
        match cloned.send().await {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
            Ok(resp) => {
                let status = resp.status().as_u16();
                let retry_after = parse_retry_after(
                    resp.headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok()),
                );
                let body = resp.text().await.unwrap_or_default();
                let err = format!("API error ({}): {}", status, body);
                if !is_retryable_status(status) || attempt >= max_attempts {
                    return Err(AppError::ProcessError(err));
                }
                // 429 限流走秒级长退避（10s/30s/60s），否则走 5xx 的毫秒级指数退避。
                // Retry-After 头优先于两者（网关显式告知的等待时间最可靠）。
                let delay = retry_after.unwrap_or_else(|| {
                    if status == 429 {
                        rate_limit_backoff_delay(attempt)
                    } else {
                        backoff_delay(attempt, base_ms)
                    }
                });
                tracing::warn!(
                    "[SimpleAI] 请求失败 {}，{}ms 后重试 (attempt {}/{})",
                    status,
                    delay.as_millis(),
                    attempt,
                    max_attempts
                );
                tokio::time::sleep(delay).await;
            }
            Err(e) => {
                let err = format!("API request failed: {}", e);
                if attempt >= max_attempts {
                    return Err(AppError::ProcessError(err));
                }
                let delay = backoff_delay(attempt, base_ms);
                tracing::warn!(
                    "[SimpleAI] 网络错误 {}，{}ms 后重试 (attempt {}/{})",
                    e,
                    delay.as_millis(),
                    attempt,
                    max_attempts
                );
                tokio::time::sleep(delay).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_retryable_classifies_correctly() {
        // 可重试
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(500));
        assert!(is_retryable_status(502));
        assert!(is_retryable_status(503));
        assert!(is_retryable_status(599));
        // 不可重试
        assert!(!is_retryable_status(400));
        assert!(!is_retryable_status(401));
        assert!(!is_retryable_status(403));
        assert!(!is_retryable_status(404));
        assert!(!is_retryable_status(200));
        assert!(!is_retryable_status(301));
    }

    #[test]
    fn backoff_grows_exponentially() {
        assert_eq!(backoff_delay(1, 500), Duration::from_millis(500));
        assert_eq!(backoff_delay(2, 500), Duration::from_millis(1000));
        assert_eq!(backoff_delay(3, 500), Duration::from_millis(2000));
        assert_eq!(backoff_delay(4, 500), Duration::from_millis(4000));
        // base=0 退化为 0（饱和）
        assert_eq!(backoff_delay(1, 0), Duration::from_millis(0));
    }

    #[test]
    fn backoff_saturates_on_large_exponent() {
        // 极大 exponent 不溢出
        let _ = backoff_delay(40, 500);
    }

    #[test]
    fn rate_limit_backoff_uses_long_seconds_sequence() {
        // 429 专用序列：10s / 30s / 60s
        assert_eq!(rate_limit_backoff_delay(1), Duration::from_secs(10));
        assert_eq!(rate_limit_backoff_delay(2), Duration::from_secs(30));
        assert_eq!(rate_limit_backoff_delay(3), Duration::from_secs(60));
    }

    #[test]
    fn rate_limit_backoff_saturates_at_max() {
        // 越界饱和到末值 60s，不无限延长
        assert_eq!(rate_limit_backoff_delay(4), Duration::from_secs(60));
        assert_eq!(rate_limit_backoff_delay(10), Duration::from_secs(60));
    }

    #[test]
    fn parse_retry_after_accepts_seconds() {
        assert_eq!(parse_retry_after(Some("5")), Some(Duration::from_secs(5)));
        assert_eq!(parse_retry_after(Some("0")), Some(Duration::from_secs(0)));
        assert_eq!(parse_retry_after(None), None);
        assert_eq!(parse_retry_after(Some("not-a-number")), None);
        // HTTP 日期格式不支持
        assert_eq!(parse_retry_after(Some("Wed, 21 Oct 2025 07:28:00 GMT")), None);
    }
}
