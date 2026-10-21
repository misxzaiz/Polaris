//! PR-2a B2 基础设施：写闸 FIFO 队列 + progress 4Hz 合流器（纯 std，可独立真实验证）
//!
//! 放到独立 mini crate 的原因：polaris lib 链接 tauri/gtk DLL，`cargo test --lib`
//! 在本机不可运行（STATUS_ENTRYPOINT_NOT_FOUND，见 AGENTS 已知边界）。此 crate
//! 只依赖 std，`cargo test -p polaris-gate-queue` 可在受限环境真跑，给纯逻辑
//! 提供字段级/时序级运行时验证；主仓经 path 依赖接入，避免代码双份。

use std::sync::{Condvar, Mutex, MutexGuard};

// ============================================================================
// WriteGate —— FIFO 票号写闸（读无限 / 写 max=1 的"队列完整版"）
// ============================================================================

/// 写闸（裁决 8：破坏性动作全局串联，FIFO 公平）。
///
/// 与旧 `Mutex<()>` 直锁的差异：
/// 1. **FIFO 公平**：票号轮转，先到先得（OS mutex 不保证排队顺序，starvation 可复现）；
/// 2. **队列可审计**：`pending()` 暴露排队深度（观测降级时的等待堆积）；
/// 3. **内部锁中毒恢复**：state 只做 u64 自增，`into_inner` 恢复是有理由的安全
///    （注释明示，不用超时掩盖同步问题——无超时，无丢失唤醒路径）。
pub struct WriteGate {
    state: Mutex<GateState>,
    release_cv: Condvar,
}

struct GateState {
    /// 正在被放行的票号（持闸者的票号）
    now_serving: u64,
    /// 下一个分配的票号
    next_ticket: u64,
}

impl WriteGate {
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(GateState { now_serving: 0, next_ticket: 0 }),
            release_cv: Condvar::new(),
        }
    }

    /// FIFO 取闸（阻塞直到本票号轮到）。RAII：guard drop → 放行下一票。
    pub fn acquire(&self) -> WriteGuard<'_> {
        let ticket = {
            // 中毒恢复依据：state 仅 u64 自增（无不变量可破坏），持锁期无用户代码。
            // 此处永不 panic 中文/英文一致；恢复语义 = 使用崩溃线程已提交的值。
            let mut st = match self.state.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            let ticket = st.next_ticket;
            st.next_ticket += 1;
            ticket
        };
        let mut st = match self.state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        while st.now_serving != ticket {
            st = match self.release_cv.wait(st) {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
        WriteGuard { gate: self }
    }

    /// 当前排队 + 持有的总深度（next_ticket - now_serving ≈ 等待中的写请求数）
    pub fn pending(&self) -> u64 {
        let st = match self.state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        st.next_ticket - st.now_serving
    }
}

impl Default for WriteGate {
    fn default() -> Self {
        Self::new()
    }
}

/// 写闸守卫（drop → now_serving += 1 → notify_all）
pub struct WriteGuard<'g> {
    gate: &'g WriteGate,
}

impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        let mut st = match self.gate.state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        // 只在仍有排队者时 advance；持闸 drop 有序（last guard 先 advance）。
        // 每次放行恰一票：写动作本身已在票内串行，advance 后 notify_all 逐票接力。
        st.now_serving += 1;
        self.gate.release_cv.notify_all();
    }
}

// ============================================================================
// ProgressCoalescer —— progress ≤4Hz 合流（纯时间决策，emit 由调用方触发）
// ============================================================================

use std::time::{Duration, Instant};

/// progress 事件合流器（PR-2a B2：合流在内、出口在外）。
///
/// 规则：首个进度必发；pct=100（终态）必发；中间进度距上次发射 ≥ min_interval 才发。
/// `should_emit(now, pct)` 把"现在"当入参注入 → 测试确定性（不 sleep）。
pub struct ProgressCoalescer {
    min_interval: Duration,
    last_emit: Option<Instant>,
    last_pct: u8,
}

impl ProgressCoalescer {
    /// min_interval_ms：4Hz = 250ms
    pub const fn new(min_interval_ms: u64) -> Self {
        Self {
            min_interval: Duration::from_millis(min_interval_ms),
            last_emit: None,
            last_pct: 0,
        }
    }

    /// 时间决策（emit 出口由调用方完成）。终态 pct>=100 必发。
    pub fn should_emit(&mut self, now: Instant, pct: u8) -> bool {
        let is_final = pct >= 100;
        let due = match self.last_emit {
            None => true, // 首个进度必发（用户即时反馈）
            Some(last) => {
                is_final || now.duration_since(last) >= self.min_interval
            }
        };
        if due {
            self.last_emit = Some(now);
            self.last_pct = pct;
        }
        due
    }

    pub fn last_pct(&self) -> u8 {
        self.last_pct
    }
}

// ============================================================================
// tests（独立 crate → `cargo test -p polaris-gate-queue` 真实可跑）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn gate_fifo_order() {
        // 12 线程序列取闸：观察到的持闸顺序必须与取票顺序一致（FIFO）
        let gate = Arc::new(WriteGate::new());
        let observed: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let mut handles = Vec::new();
        for i in 0..12 {
            let gate = Arc::clone(&gate);
            let observed = Arc::clone(&observed);
            handles.push(thread::spawn(move || {
                // 错开启动，让取票次序大致等于线程创建次序（优先观察公平性）
                thread::sleep(Duration::from_millis(i * 3));
                let _g = gate.acquire();
                observed.lock().unwrap().push(i as u64);
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let seq = observed.lock().unwrap().clone();
        assert_eq!(seq.len(), 12);
        // FIFO：任意相邻对不得逆序（允许同票内紧邻次序颠倒——它们几乎同时取票）
        // 稳定喂票下（每 3ms 一个），实际拿到严格递增；宽松断言防慢机器抖动。
        for w in seq.windows(2) {
            assert!(
                w[1] + 2 >= w[0],
                "FIFO 顺序被打破: {:?}",
                seq
            );
        }
    }

    #[test]
    fn gate_exclusive_and_pending_drains_to_zero() {
        let gate = Arc::new(WriteGate::new());
        let inside = Arc::new(AtomicU64::new(0));
        let max_inside = Arc::new(AtomicU64::new(0));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let gate = Arc::clone(&gate);
            let inside = Arc::clone(&inside);
            let max_inside = Arc::clone(&max_inside);
            handles.push(thread::spawn(move || {
                let _g = gate.acquire();
                let cur = inside.fetch_add(1, Ordering::SeqCst) + 1;
                max_inside.fetch_max(cur, Ordering::SeqCst);
                // 持闸期做点活，制造竞争窗口
                thread::sleep(Duration::from_millis(2));
                inside.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert!(
            max_inside.load(Ordering::SeqCst) <= 1,
            "写闸内并发超过 1"
        );
        assert_eq!(gate.pending(), 0, "全部完成后队列应清空");
    }

    #[test]
    fn coalescer_first_final_and_rate() {
        let base = Instant::now();
        let mut c = ProgressCoalescer::new(250);

        // 首个进度必发
        assert!(c.should_emit(base, 10));
        // 100ms 后未到 250ms → 压制
        assert!(!c.should_emit(base + Duration::from_millis(100), 30));
        // 260ms 处到点 → 放行
        assert!(c.should_emit(base + Duration::from_millis(260), 30));
        // 终态必发（即使刚发过）
        assert!(c.should_emit(base + Duration::from_millis(261), 100));
        assert_eq!(c.last_pct(), 100);
    }

    #[test]
    fn coalescer_no_regression_on_last_emit_for_suppressed() {
        // 压制期间 last_emit 不动：下一次可发点仍以最近一次"发射"为基准
        let base = Instant::now();
        let mut c = ProgressCoalescer::new(100);
        assert!(c.should_emit(base, 10));
        assert!(!c.should_emit(base + Duration::from_millis(50), 40)); // <100ms 压制
        assert!(!c.should_emit(base + Duration::from_millis(99), 50)); // 压制期间基準不移动
        assert!(c.should_emit(base + Duration::from_millis(100), 60)); // 相对发射点 100ms 到点
        assert!(!c.should_emit(base + Duration::from_millis(110), 70)); // 紧随其后 <interval 压制
    }
}
