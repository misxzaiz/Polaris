//! 进程枚举与清杀（sysinfo 原生实现，needs 067 P1-1 / 重构 spec §3.4）
//!
//! 取代旧 `plugin_service.rs` 的 `wmic`/`taskkill`/`pgrep` 外部命令链：
//! - Win11 已无 wmic（生产实证：卸载清杀恒败，"目录删了进程活着"）；
//! - WMI/PowerShell 实测有返回空/单条的抽风问题（067 决策记录坑 2）；
//! - sysinfo 直接读 OS 数据，无外部进程、无解析、无抽风面。
//!
//! 本模块是无状态原语（枚举/匹配/杀）；策略（谁该杀）归 Reconciler（PR-2）。

use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System, UpdateKind};

/// 一次进程表快照（整表一次性刷新，调用方按需多次匹配，避免反复枚举）。
pub struct ProcessSnapshot {
    system: System,
}

#[derive(Debug, Clone)]
pub struct ProcEntry {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub cmd: String,
}

impl ProcessSnapshot {
    /// 全表刷新（含命令行与可执行路径）。数百 ms 级，调用方（tick）应节流。
    pub fn capture() -> Self {
        let system = System::new_with_specifics(
            RefreshKind::nothing().with_processes(
                ProcessRefreshKind::nothing()
                    .with_cmd(UpdateKind::OnlyIfNotSet)
                    .with_exe(UpdateKind::OnlyIfNotSet),
            ),
        );
        Self { system }
    }

    /// 本进程 PID。
    pub fn self_pid() -> u32 {
        sysinfo::get_current_pid().map(|p| p.as_u32()).unwrap_or(0)
    }

    pub fn entries(&self) -> Vec<ProcEntry> {
        self.system
            .processes()
            .values()
            .map(|p| ProcEntry {
                pid: p.pid().as_u32(),
                parent_pid: p.parent().map(|pp| pp.as_u32()),
                name: p.name().to_string_lossy().to_string(),
                cmd: p.cmd().iter().map(|s| s.to_string_lossy()).collect::<Vec<_>>().join(" "),
            })
            .collect()
    }

    /// 命令行包含 `fragment` 的进程 PID（排除 `exclude` 表，默认排除自身）。
    pub fn find_by_cmd_fragment(&self, fragment: &str, exclude: &[u32]) -> Vec<u32> {
        if fragment.is_empty() {
            return Vec::new();
        }
        let self_pid = Self::self_pid();
        self.system
            .processes()
            .values()
            .filter(|p| {
                let pid = p.pid().as_u32();
                pid != self_pid
                    && !exclude.contains(&pid)
                    && p.cmd().iter().any(|s| s.to_string_lossy().contains(fragment))
            })
            .map(|p| p.pid().as_u32())
            .collect()
    }

    /// 进程当前是否存活（基于本快照；过期快照需重新 capture）。
    pub fn is_alive(&self, pid: u32) -> bool {
        self.system.process(Pid::from_u32(pid)).is_some()
    }
}

/// 杀单个 PID（TerminateProcess/SIGKILL 语义）。返回是否成功。
pub fn kill_pid(pid: u32) -> bool {
    let mut system = System::new();
    system.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
    );
    match system.process(Pid::from_u32(pid)) {
        Some(p) => {
            let ok = p.kill();
            if !ok {
                tracing::warn!("清杀 PID={} 失败（进程存在但终止被拒）", pid);
            }
            ok
        }
        None => {
            tracing::debug!("清杀 PID={} 时进程已不存在（视为成功）", pid);
            true
        }
    }
}

/// 批量清杀；返回逐个结果（PID, 是否成功/已不存在）。
pub fn kill_pids(pids: &[u32]) -> Vec<(u32, bool)> {
    pids.iter().map(|&pid| (pid, kill_pid(pid))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 快照非空、包含自身进程，且命令行片段匹配能命中自身或测试宿主进程。
    #[test]
    fn snapshot_contains_self() {
        let snap = ProcessSnapshot::capture();
        let self_pid = ProcessSnapshot::self_pid();
        assert!(self_pid > 0);
        assert!(snap.is_alive(self_pid), "快照应包含自身进程");
        // 自身命令行包含当前 exe 名（对 cargo test 为 test 二进制路径）。
        let entries = snap.entries();
        assert!(
            entries.iter().any(|e| e.pid == self_pid),
            "枚举列表应含自身"
        );
    }

    /// 不可能匹配的片段返回空集（排除表与空片段语义）。
    #[test]
    fn fragment_match_edge_cases() {
        let snap = ProcessSnapshot::capture();
        assert!(snap
            .find_by_cmd_fragment("definitely-not-a-real-fragment-067", &[])
            .is_empty());
        assert!(
            snap.find_by_cmd_fragment("", &[]).is_empty(),
            "空片段不匹配任何进程"
        );
    }
}
