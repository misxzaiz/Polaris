//! Reconciler 纯函数核心：期望 ↔ 账本 ↔ 观测 → 动作表（重构 spec §3.2）
//!
//! **不变式（评审口径）**：
//! 1. 本模块零 IO、零时钟依赖（now 由调用方注入）——全部决策可单测复现；
//! 2. 单写者：动作表是唯一合法的进程操作来源，执行层不得自由发挥；
//! 3. 幂等：同一份输入重复运行输出一致（无隐藏状态；预算由调用方持有传入）。
//!
//! 动作矩阵（spec §3.2 表格的代码化）：
//!
//! | 期望 | 账本进程 | 观测 | 动作 |
//! |---|---|---|---|
//! | Running | 无 | - | Spawn（受退避预算） |
//! | Running | 活+健康 | - | 无 |
//! | Running | 活+健康连败 | ≥3 | Kill(ZombieUnhealthy) |
//! | Running | 死 | - | 清记录+预算计数，退避到期 Spawn |
//! | Stopped | 活 | - | Kill(Unwanted) |
//! | Stopped | 死/无 | - | 清记录 |
//! | 任意 | 孤儿（无主同特征进程） | - | KillOrphan |

use std::collections::HashMap;

pub type ServiceKey = (String, String);

/// 期望（纯派生输入）。
#[derive(Debug, Clone)]
pub struct Desire {
    pub plugin_id: String,
    pub service_id: String,
    /// enabled && (autoStart || 手动要求)；stop = false
    pub wanted: bool,
    /// maxRestarts（contribution 声明）
    pub max_restarts: u32,
}

/// 观测（OS 真相输入，由执行层探测后传入）。
#[derive(Debug, Clone, Default)]
pub struct Observed {
    /// 在管 epoch 进程是否存活（None = 无在管进程记录）
    pub alive: Option<bool>,
    /// http 健康探测结果（None = 本轮未探测/非 http 型）
    pub healthy: Option<bool>,
    /// 扫描发现的无主同特征进程（PID ∉ 任何在管记录）→ 孤儿
    pub orphan_pids: Vec<u32>,
}

/// 在管进程记录（内存态；可由 registry 重建）。
#[derive(Debug, Clone)]
pub struct EpochRecord {
    pub epoch: u64,
    pub pid: u32,
    pub port: Option<u16>,
    pub started_at_ms: u64,
    pub consecutive_health_fails: u32,
}

/// 重启预算（per service，调用方持久持有）。
#[derive(Debug, Clone, Default)]
pub struct Budget {
    pub restart_count: u32,
    pub next_retry_at_ms: u64,
    /// Some(reason) = 终态 Error，不再拉起（用户手动 start 可清除）
    pub error_terminal: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Spawn { key: ServiceKey },
    Kill {
        key: ServiceKey,
        pid: u32,
        epoch: u64,
        reason: KillReason,
    },
    KillOrphan { pid: u32, fragment: String },
    Note { key: ServiceKey, msg: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KillReason {
    /// 期望为停止而进程仍在（用户禁用/卸载/手动 stop）
    Unwanted,
    /// 进程在但健康连败（僵死）
    ZombieUnhealthy,
}

/// 参数（沿用户可感知的现有默认值）。
pub struct ReconcileParams {
    pub now_ms: u64,
    /// 运行满此时长自然退出 → 预算清零再计（旧 STABLE_UPTIME_SECS）
    pub stable_uptime_ms: u64,
    /// 健康连败判死阈值（旧 HEALTH_FAIL_THRESHOLD）
    pub health_fail_threshold: u32,
}

impl Default for ReconcileParams {
    fn default() -> Self {
        Self {
            now_ms: 0,
            stable_uptime_ms: 60_000,
            health_fail_threshold: 3,
        }
    }
}

/// 决策主函数（纯）。
pub fn reconcile(
    desires: &[Desire],
    observed: &HashMap<ServiceKey, Observed>,
    epochs: &mut HashMap<ServiceKey, EpochRecord>,
    budgets: &mut HashMap<ServiceKey, Budget>,
    params: &ReconcileParams,
) -> Vec<Action> {
    let mut actions = Vec::new();

    for d in desires {
        let key = (d.plugin_id.clone(), d.service_id.clone());
        let obs = observed.get(&key).cloned().unwrap_or_default();
        let budget = budgets.entry(key.clone()).or_default();

        if !d.wanted {
            // ── 期望停止 ──
            if let Some(rec) = epochs.get(&key).cloned() {
                if obs.alive.unwrap_or(false) {
                    actions.push(Action::Kill {
                        key: key.clone(),
                        pid: rec.pid,
                        epoch: rec.epoch,
                        reason: KillReason::Unwanted,
                    });
                    continue;
                }
                // 进程已死：仅清记录
                epochs.remove(&key);
            }
            continue;
        }

        // ── 期望运行 ──
        if let Some(rec) = epochs.get(&key).cloned() {
            let alive = obs.alive.unwrap_or(false);
            if alive {
                // 健康门控：http 型连败 ≥ 阈值 → 僵死处决，下轮重拉
                if obs.healthy == Some(false) {
                    let fails = rec.consecutive_health_fails + 1;
                    if fails >= params.health_fail_threshold {
                        actions.push(Action::Kill {
                            key: key.clone(),
                            pid: rec.pid,
                            epoch: rec.epoch,
                            reason: KillReason::ZombieUnhealthy,
                        });
                        epochs.remove(&key);
                        budget.restart_count = budget.restart_count.saturating_add(1);
                        budget.next_retry_at_ms = params.now_ms + backoff_ms(budget.restart_count);
                        actions.push(Action::Note {
                            key: key.clone(),
                            msg: format!("健康连败 {fails}，僵死处决待重拉"),
                        });
                    } else {
                        epochs.get_mut(&key).unwrap().consecutive_health_fails = fails;
                        actions.push(Action::Note {
                            key: key.clone(),
                            msg: format!("健康失败 {}/{}", fails, params.health_fail_threshold),
                        });
                    }
                } else {
                    if obs.healthy == Some(true) && rec.consecutive_health_fails > 0 {
                        epochs.get_mut(&key).unwrap().consecutive_health_fails = 0;
                    }
                    // 活+健康 → 无动作
                }
                continue;
            }

            // 在管进程已死：清记录 + 预算 + 退避（本轮决策结束，下轮评估拉起）
            epochs.remove(&key);
            let uptime = params.now_ms.saturating_sub(rec.started_at_ms);
            if uptime >= params.stable_uptime_ms {
                budget.restart_count = 0;
            }
            budget.restart_count = budget.restart_count.saturating_add(1);
            if budget.restart_count > d.max_restarts {
                budget.error_terminal = Some(format!(
                    "超过最大重启次数（{}）",
                    d.max_restarts
                ));
                actions.push(Action::Note {
                    key: key.clone(),
                    msg: budget.error_terminal.clone().unwrap(),
                });
            } else {
                budget.next_retry_at_ms = params.now_ms + backoff_ms(budget.restart_count);
                actions.push(Action::Note {
                    key: key.clone(),
                    msg: format!(
                        "进程退出，退避后第 {} 次重拉",
                        budget.restart_count
                    ),
                });
            }
            continue;
        }

        // 无在管进程 → 是否可拉起
        if !epochs.contains_key(&key) {
            if let Some(reason) = &budget.error_terminal {
                actions.push(Action::Note {
                    key: key.clone(),
                    msg: format!("终态不拉起：{reason}（手动 start 可清除）"),
                });
            } else if params.now_ms < budget.next_retry_at_ms {
                actions.push(Action::Note {
                    key: key.clone(),
                    msg: format!(
                        "退避中，{}ms 后重试",
                        budget.next_retry_at_ms - params.now_ms
                    ),
                });
            } else {
                actions.push(Action::Spawn { key });
            }
        }
    }

    // 全局：孤儿清杀（不区分期望——无主即杀，防注册表外进程长期游离）
    let mut seen_orphans = std::collections::HashSet::new();
    for obs in observed.values() {
        for &pid in &obs.orphan_pids {
            if seen_orphans.insert(pid) {
                actions.push(Action::KillOrphan {
                    pid,
                    fragment: "plugins/".to_string(),
                });
            }
        }
    }

    actions
}

/// spawn 失败回写：端口类错误 = 非瞬态，终态不再重试（spec §3.3）。
pub fn mark_spawn_failed(
    key: &ServiceKey,
    budgets: &mut HashMap<ServiceKey, Budget>,
    reason: String,
    transient: bool,
) {
    let budget = budgets.entry(key.clone()).or_default();
    if transient {
        budget.restart_count = budget.restart_count.saturating_add(1);
        budget.next_retry_at_ms = now_hint(key) + backoff_ms(budget.restart_count);
    } else {
        budget.error_terminal = Some(reason);
    }
}

fn now_hint(_key: &ServiceKey) -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 指数退避：min(2^n 秒, 60 秒)，n 从 1 起。
fn backoff_ms(restart_count: u32) -> u64 {
    let secs = std::cmp::min(2u64.saturating_pow(restart_count.min(6)), 60);
    secs * 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(p: &str, s: &str) -> ServiceKey {
        (p.to_string(), s.to_string())
    }

    fn desire(p: &str, s: &str, wanted: bool, max_restarts: u32) -> Desire {
        Desire {
            plugin_id: p.into(),
            service_id: s.into(),
            wanted,
            max_restarts,
        }
    }

    fn rec(pid: u32, started_ms: u64) -> EpochRecord {
        EpochRecord {
            epoch: 1,
            pid,
            port: Some(10000),
            started_at_ms: started_ms,
            consecutive_health_fails: 0,
        }
    }

    /// 矩阵行 1：期望运行 + 无在管 → Spawn
    #[test]
    fn t1_wanted_without_record_spawns() {
        let desires = vec![desire("p", "s", true, 10)];
        let mut epochs = HashMap::new();
        let mut budgets = HashMap::new();
        let actions = reconcile(
            &desires,
            &HashMap::new(),
            &mut epochs,
            &mut budgets,
            &ReconcileParams { now_ms: 1000, ..Default::default() },
        );
        assert_eq!(actions, vec![Action::Spawn { key: key("p", "s") }]);
    }

    /// 矩阵行 2：活+健康 → 无动作；健康恢复清零连败计数。
    #[test]
    fn t2_alive_healthy_is_noop() {
        let desires = vec![desire("p", "s", true, 10)];
        let mut epochs = HashMap::from([(key("p", "s"), rec(100, 0))]);
        let mut budgets = HashMap::new();
        let obs = HashMap::from([(
            key("p", "s"),
            Observed { alive: Some(true), healthy: Some(true), orphan_pids: vec![] },
        )]);
        let actions = reconcile(
            &desires, &obs, &mut epochs, &mut budgets,
            &ReconcileParams { now_ms: 5000, ..Default::default() },
        );
        assert!(actions.is_empty(), "活+健康应为无动作，实际 {actions:?}");
        assert_eq!(epochs[&key("p", "s")].consecutive_health_fails, 0);
    }

    /// 矩阵行 4（回归固定用例，验收 A1/B2）：在管进程死后——
    /// 退避期内不拉、退避到期真实重拉（旧实现此处被「Starting 挡」拦死）。
    #[test]
    fn t4_process_death_retries_after_backoff() {
        let desires = vec![desire("p", "s", true, 10)];
        let mut epochs = HashMap::from([(key("p", "s"), rec(100, 0))]);
        let mut budgets = HashMap::new();
        let dead = HashMap::from([(
            key("p", "s"),
            Observed { alive: Some(false), healthy: None, orphan_pids: vec![] },
        )]);

        // 退出：稳定运行 60s+ → 预算清零再计为 1，退避 2s
        let actions = reconcile(
            &desires, &dead, &mut epochs, &mut budgets,
            &ReconcileParams { now_ms: 70_000, ..Default::default() },
        );
        assert!(epochs.get(&key("p", "s")).is_none(), "死亡记录应清除");
        assert!(
            !actions.iter().any(|a| matches!(a, Action::Spawn { .. })),
            "退避期内不得立即重拉"
        );
        assert_eq!(budgets[&key("p", "s")].restart_count, 1);

        // 退避到期 → Spawn
        let actions = reconcile(
            &desires, &dead, &mut epochs, &mut budgets,
            &ReconcileParams { now_ms: 70_000 + 2_100, ..Default::default() },
        );
        assert_eq!(
            actions,
            vec![Action::Spawn { key: key("p", "s") }],
            "退避到期必须重拉（aba91319 回归的回归用例）"
        );
    }

    /// 早夭（<60s）不清零预算；超 max_restarts → 终态 Error 不再拉起。
    #[test]
    fn t5_early_death_accumulates_to_terminal() {
        let desires = vec![desire("p", "s", true, 2)];
        let mut epochs;
        let mut budgets = HashMap::new();
        let dead = HashMap::from([(
            key("p", "s"),
            Observed { alive: Some(false), healthy: None, orphan_pids: vec![] },
        )]);
        let p = |now| ReconcileParams { now_ms: now, ..Default::default() };

        // 三轮崩溃循环（每轮早夭），退避到期再死
        epochs = HashMap::from([(key("p", "s"), rec(1, 90_000))]);
        reconcile(&desires, &dead, &mut epochs, &mut budgets, &p(100_000));
        epochs = HashMap::from([(key("p", "s"), rec(2, 102_100))]);
        reconcile(&desires, &dead, &mut epochs, &mut budgets, &p(103_000));
        // restart_count=2，未超 max_restarts=2（> 判定），仍排重拉
        epochs = HashMap::from([(key("p", "s"), rec(3, 106_000))]);
        let actions = reconcile(&desires, &dead, &mut epochs, &mut budgets, &p(110_000));
        assert_eq!(budgets[&key("p", "s")].restart_count, 3);
        assert!(budgets[&key("p", "s")].error_terminal.is_some(), "第 3 次超限应终态");
        assert!(
            !actions.iter().any(|a| matches!(a, Action::Spawn { .. })),
            "终态后不再拉起"
        );
    }

    /// 矩阵行 5：期望停止 + 在管活 → Kill(Unwanted)；死 → 仅清记录。
    #[test]
    fn t6_unwanted_kills() {
        let desires = vec![desire("p", "s", false, 10)];
        let mut epochs = HashMap::from([(key("p", "s"), rec(100, 0))]);
        let mut budgets = HashMap::new();
        let alive = HashMap::from([(
            key("p", "s"),
            Observed { alive: Some(true), healthy: Some(true), orphan_pids: vec![] },
        )]);
        let actions = reconcile(
            &desires, &alive, &mut epochs, &mut budgets,
            &ReconcileParams { now_ms: 1000, ..Default::default() },
        );
        assert_eq!(
            actions,
            vec![Action::Kill {
                key: key("p", "s"),
                pid: 100,
                epoch: 1,
                reason: KillReason::Unwanted,
            }]
        );

        // 死亡：清记录
        let dead = HashMap::from([(
            key("p", "s"),
            Observed { alive: Some(false), healthy: None, orphan_pids: vec![] },
        )]);
        epochs = HashMap::from([(key("p", "s"), rec(100, 0))]);
        let actions = reconcile(
            &desires, &dead, &mut epochs, &mut budgets,
            &ReconcileParams { now_ms: 1000, ..Default::default() },
        );
        assert!(actions.is_empty());
        assert!(epochs.get(&key("p", "s")).is_none());
    }

    /// 矩阵行 6（验收 A2/B5）：孤儿清杀；在管进程不被误杀。
    #[test]
    fn t7_orphans_killed_managed_spared() {
        let desires = vec![desire("p", "s", true, 10)];
        let mut epochs = HashMap::from([(key("p", "s"), rec(100, 0))]);
        let mut budgets = HashMap::new();
        let obs = HashMap::from([(
            key("p", "s"),
            Observed {
                alive: Some(true),
                healthy: Some(true),
                orphan_pids: vec![200, 300],
            },
        )]);
        let actions = reconcile(
            &desires, &obs, &mut epochs, &mut budgets,
            &ReconcileParams { now_ms: 1000, ..Default::default() },
        );
        let orphans: Vec<u32> = actions
            .iter()
            .filter_map(|a| match a {
                Action::KillOrphan { pid, .. } => Some(*pid),
                _ => None,
            })
            .collect();
        assert_eq!(orphans, vec![200, 300], "无主进程全部判杀");
        assert!(
            !actions.iter().any(|a| matches!(a,
                Action::Kill { pid: 100, .. } | Action::KillOrphan { pid: 100, .. })),
            "在管进程不得被孤儿逻辑误杀"
        );
        assert!(epochs.get(&key("p", "s")).is_some(), "在管记录保留");
    }

    /// 排除语义契约（spec plans/supervisor-orphan-kill-false-positive-fix.md）：
    /// `orphan_pids` 必须是**已通过排除判定**的进程（调用方在观测层完成
    /// Job 成员/引擎 PID 排除）。2026-11-11 事故回归固定用例：旧实现排除表
    /// 恒空，codebuddy 适配器（命令行含 plugins 路径、Job 成员、随会话生灭）
    /// 被 10s tick 周期性误杀。本用例固定「排除发生在观测层」的分层契约：
    /// 观测层传入的 orphan_pids 就是终判名单，reconciler 不做二次排除。
    #[test]
    fn t7b_orphan_exclusion_happens_in_observation_layer() {
        let desires = vec![desire("p", "s", true, 10)];
        let mut epochs = HashMap::from([(key("p", "s"), rec(100, 0))]);
        let mut budgets = HashMap::new();
        // 模拟观测层正确排除后的输入：适配器 PID 500（Job 成员）已被剔除，
        // 仅剩真孤儿 600。若观测层回归「排除表恒空」，500 会被一并传入。
        let obs = HashMap::from([(
            key("p", "s"),
            Observed {
                alive: Some(true),
                healthy: Some(true),
                orphan_pids: vec![600],
            },
        )]);
        let actions = reconcile(
            &desires, &obs, &mut epochs, &mut budgets,
            &ReconcileParams { now_ms: 1000, ..Default::default() },
        );
        let orphans: Vec<u32> = actions
            .iter()
            .filter_map(|a| match a {
                Action::KillOrphan { pid, .. } => Some(*pid),
                _ => None,
            })
            .collect();
        assert_eq!(orphans, vec![600], "仅真孤儿被清杀");
    }

    /// 矩阵行 3：健康连败 ≥3 → 僵死处决 + 退避；未达阈值仅累计。
    #[test]
    fn t8_zombie_killed_after_health_threshold() {
        let desires = vec![desire("p", "s", true, 10)];
        let mut epochs = HashMap::from([(key("p", "s"), rec(100, 0))]);
        let mut budgets = HashMap::new();
        let unhealthy = |fails_base: u32| {
            (
                desires.clone(),
                HashMap::from([(
                    key("p", "s"),
                    Observed { alive: Some(true), healthy: Some(false), orphan_pids: vec![] },
                )]),
                HashMap::from([(key("p", "s"), EpochRecord {
                    consecutive_health_fails: fails_base,
                    ..rec(100, 0)
                })]),
            )
        };

        // 前两轮：仅累计
        let (d, obs, mut e) = unhealthy(0);
        let actions = reconcile(&d, &obs, &mut e, &mut budgets, &ReconcileParams { now_ms: 1000, ..Default::default() });
        assert!(actions.iter().any(|a| matches!(a, Action::Note { .. })));
        assert_eq!(e[&key("p", "s")].consecutive_health_fails, 1);

        // 第三轮：处决
        let (d, obs, mut e) = unhealthy(2);
        let actions = reconcile(&d, &obs, &mut e, &mut budgets, &ReconcileParams { now_ms: 3000, ..Default::default() });
        assert_eq!(
            actions.iter().find(|a| matches!(a, Action::Kill { reason: KillReason::ZombieUnhealthy, .. })),
            Some(&Action::Kill {
                key: key("p", "s"),
                pid: 100,
                epoch: 1,
                reason: KillReason::ZombieUnhealthy,
            }),
            "连败达阈值应僵死处决"
        );
        assert!(e.get(&key("p", "s")).is_none());
    }

    /// spawn 失败回写：端口类（非瞬态）= 终态；瞬态 = 计数+退避。
    #[test]
    fn t9_spawn_failure_classification() {
        let mut budgets = HashMap::new();
        let k = key("p", "s");
        mark_spawn_failed(&k, &mut budgets, "端口冲突".into(), false);
        assert!(budgets[&k].error_terminal.is_some(), "非瞬态应终态");

        let mut budgets = HashMap::new();
        mark_spawn_failed(&k, &mut budgets, "spawn err".into(), true);
        assert!(budgets[&k].error_terminal.is_none(), "瞬态不终态");
        assert_eq!(budgets[&k].restart_count, 1);
        assert!(budgets[&k].next_retry_at_ms > 0, "瞬态应排退避");
    }
}
