/*! 消息去重器
 *
 * 基于滑动时间窗口的消息去重机制。
 */

use std::collections::HashMap;
use chrono::Utc;

/// 消息去重器
///
/// 使用滑动时间窗口记录已处理的消息 ID，防止重复处理。
pub struct MessageDedup {
    /// 已处理消息 (message_id -> timestamp)
    processed: HashMap<String, i64>,
    /// 时间窗口 (毫秒)
    window_ms: i64,
    /// 最大缓存数量
    max_size: usize,
}

impl MessageDedup {
    /// 创建新的消息去重器
    ///
    /// # Arguments
    /// * `window_ms` - 时间窗口（毫秒），同一消息在此时间内视为已处理
    /// * `max_size` - 最大缓存数量，超过后自动清理
    pub fn new(window_ms: i64, max_size: usize) -> Self {
        Self {
            processed: HashMap::new(),
            window_ms,
            max_size,
        }
    }

    /// 检查消息是否已处理
    ///
    /// 如果消息已处理，返回 true；否则标记为已处理并返回 false。
    pub fn is_processed(&mut self, message_id: &str) -> bool {
        let now = Utc::now().timestamp_millis();

        // 定期清理过期记录
        if self.processed.len() > self.max_size {
            self.cleanup(now);
        }

        if let Some(&ts) = self.processed.get(message_id) {
            if now - ts < self.window_ms {
                return true; // 已处理
            }
        }

        // 标记为已处理
        self.processed.insert(message_id.to_string(), now);
        false
    }

    /// 清理过期记录
    fn cleanup(&mut self, now: i64) {
        let threshold = now - self.window_ms * 6; // 保留 6 倍时间窗口
        self.processed.retain(|_, &mut ts| ts > threshold);
    }

    /// 清空所有记录
    pub fn clear(&mut self) {
        self.processed.clear();
    }

    /// 获取当前缓存大小
    #[allow(dead_code)]
    pub fn size(&self) -> usize {
        self.processed.len()
    }
}

impl Default for MessageDedup {
    fn default() -> Self {
        Self::new(60_000, 10_000) // 默认 60 秒窗口，最多 1 万条
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dedup() {
        let mut dedup = MessageDedup::new(1000, 100);

        // 第一次检查应该返回 false（未处理）
        assert!(!dedup.is_processed("msg1"));

        // 第二次检查应该返回 true（已处理）
        assert!(dedup.is_processed("msg1"));

        // 不同消息应该返回 false
        assert!(!dedup.is_processed("msg2"));
        assert!(dedup.is_processed("msg2"));
    }
}
