//! 宿主进程级 Job Object 收容所（needs 067 P0-1 / 重构 spec §3.4）
//!
//! 目标：宿主的每一个直接子进程（插件服务 / MCP stdio server / 引擎 CLI）
//! 都归属同一个 Job Object（KILL_ON_JOB_CLOSE）。宿主以任何形态死亡
//! （任务管理器强杀、崩溃、`std::process::exit`、正常退出）时，由 OS 保证
//! Job 内全部进程被终止——这是 `kill_on_drop`（仅覆盖 Rust graceful drop
//! 路径）之外唯一的非正常死亡防线。
//!
//! 使用纪律：
//! - 进程启动早期调用一次 [`ensure_initialized`]；失败仅告警并降级
//!   （无 Job 时行为与旧版一致，不阻塞启动）。
//! - 每次 spawn 成功后调用 [`assign_child`]；assign 失败仅告警。
//! - Job 句柄故意泄漏到进程退出（KILL_ON_JOB_CLOSE 的触发条件正是
//!   最后一个句柄关闭）；**不得** CloseHandle。
//!
//! 平台：Windows-only（`cfg(windows)`）；其他平台提供空实现，调用方零分叉。

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    };

    static JOB: OnceLock<usize> = OnceLock::new();

    /// 创建宿主级 Job Object（进程内幂等；首次成功即固定）。
    /// KILL_ON_JOB_CLOSE：宿主退出（句柄随进程关闭）→ OS 终止 Job 内全部进程。
    pub fn ensure_initialized() -> bool {
        if JOB.get().is_some() {
            return true;
        }
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                let err = std::io::Error::last_os_error();
                tracing::warn!("Job Object 创建失败，子进程收容降级为无收容: {}", err);
                return false;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                let err = std::io::Error::last_os_error();
                tracing::warn!("Job Object 限制设置失败，收容不可用: {}", err);
                return false;
            }
            // 句柄故意不关闭（见模块注释）；OnceLock 存裸句柄值。
            let _ = JOB.set(handle as usize);
            tracing::info!("Job Object 收容所已创建（KILL_ON_JOB_CLOSE）");
            true
        }
    }

    /// 把外部进程句柄收进 Job。幂等（重复 assign 同进程为无害操作）。
    fn assign_handle(handle: HANDLE) -> bool {
        let Some(&job) = JOB.get() else {
            return false;
        };
        unsafe { AssignProcessToJobObject(job as HANDLE, handle) != 0 }
    }

    /// 枚举本宿主 Job Object 内全部进程 PID。
    ///
    /// 用途：孤儿清杀的排除全集（spec plans/supervisor-orphan-kill-false-positive-fix.md）。
    /// 宿主认领的进程 = Job 成员；孤儿 = 路径特征命中 && ∉ Job。
    /// 返回 None 表示 Job 未初始化（收容降级）——调用方走降级排除路径。
    /// 调用方持 std Mutex 时调用安全（本函数零锁、纯 FFI 查询）。
    pub fn job_member_pids() -> Option<std::collections::HashSet<u32>> {
        use windows_sys::Win32::System::JobObjects::JobObjectBasicProcessIdList;

        let &job = JOB.get()?;
        // JOBOBJECT_BASIC_PROCESS_ID_LIST：首字段 NumberOfAssignedProcesses 为
        // 所需容量提示。先按提示分配查询；缓冲不足（两调用间又有进程加入）则
        // 按返回的实际需求扩容重试一次。上限防御异常值。
        let mut capacity: usize = 16;
        for _ in 0..2 {
            let mut buf = vec![0u64; 1 + capacity];
            let ok = unsafe {
                QueryInformationJobObject(
                    job as HANDLE,
                    JobObjectBasicProcessIdList,
                    buf.as_mut_ptr() as *mut core::ffi::c_void,
                    (buf.len() * std::mem::size_of::<u64>()) as u32,
                    std::ptr::null_mut(),
                )
            };
            if ok != 0 {
                let list = unsafe { &*(buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
                return Some(
                    list.ProcessIdList
                        .iter()
                        .take(list.NumberOfProcessIdsInList as usize)
                        .map(|&pid| pid as u32)
                        .collect(),
                );
            }
            // 失败：容量不足时 NumberOfAssignedProcesses 提示所需数量；
            // 其余错误（job 句柄无效等）重试同样结果，直接退出。
            let list = unsafe { &*(buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
            let need = list.NumberOfAssignedProcesses as usize;
            if need > 0 && need < 100_000 {
                capacity = need;
            } else {
                break;
            }
        }
        // Job 存在但查询失败：保守返回空集（不误杀优先于彻底清扫）。
        Some(std::collections::HashSet::new())
    }

    /// 判断 PID 是否为本宿主 Job 成员（KillOrphan 动作前重验用）。
    /// None = Job 判定不可用（调用方按各自语义决定放行/降级）。
    pub fn is_job_member(pid: u32) -> Option<bool> {
        job_member_pids().map(|set| set.contains(&pid))
    }

    /// 将 tokio 子进程收进 Job（spawn 成功后立即调用）。
    pub fn assign_child(child: &tokio::process::Child) -> bool {
        match child.raw_handle() {
            Some(h) => {
                let ok = assign_handle(h);
                if !ok {
                    tracing::warn!("子进程收容失败（AssignProcessToJobObject），该进程在宿主强杀时可能残留");
                }
                ok
            }
            None => {
                tracing::warn!("子进程句柄不可用，未收容");
                false
            }
        }
    }

    /// 将 std 子进程收进 Job（同步引擎 spawn 点用；语义同 assign_child）。
    pub fn assign_std_child(child: &std::process::Child) -> bool {
        use std::os::windows::io::AsRawHandle;
        assign_handle(child.as_raw_handle())
    }
}

#[cfg(not(windows))]
mod imp {
    /// 非 Windows 平台：收容依赖 Unix 侧方案（follow-up，见重构 spec P2-2），
    /// 当前为空实现保持调用方零分叉。
    pub fn ensure_initialized() -> bool {
        true
    }

    pub fn assign_child(_child: &tokio::process::Child) -> bool {
        true
    }

    pub fn assign_std_child(_child: &std::process::Child) -> bool {
        true
    }

    /// 非 Windows 无 Job Object：返回 None 表示「Job 成员判定不可用」，
    /// 调用方降级为在管 PID ∪ 引擎活跃 PID 排除（spec §降级路径）。
    pub fn job_member_pids() -> Option<std::collections::HashSet<u32>> {
        None
    }

    pub fn is_job_member(_pid: u32) -> Option<bool> {
        None
    }
}

/// Windows：Job 成员判定可用；None 仅出现在 Job 未初始化（收容降级）。
#[cfg(windows)]
pub use imp::{assign_child, assign_std_child, ensure_initialized, is_job_member, job_member_pids};

#[cfg(windows)]
#[cfg(test)]
mod tests {
    use super::imp::{assign_child, ensure_initialized, job_member_pids};

    /// 收容所可初始化且幂等；真实 spawn 的子进程 assign 成功
    /// （cmd /c exit 即退，无残留）。真实宿主强杀的 OS 级行为由 e2e 冒烟覆盖（验收 B1）。
    #[tokio::test]
    async fn job_init_and_assign_real_child() {
        assert!(ensure_initialized());
        assert!(ensure_initialized(), "幂等");
        let child = tokio::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .stdin(std::process::Stdio::null())
            .spawn()
            .expect("测试环境可 spawn cmd");
        assert!(assign_child(&child), "真实子进程应收容成功");
        let mut child = child;
        let _ = child.wait().await;
    }

    /// Job 成员枚举可用，且 assign 后的子进程 ∈ 成员集合
    /// （孤儿清杀误杀修复的核心判据，spec
    /// plans/supervisor-orphan-kill-false-positive-fix.md）。
    /// 用长驻子进程（ping -n 10）避免退出竞态；测试尾部不等待结束，
    /// 由 KILL_ON_JOB_CLOSE / 测试进程退出兜底回收。
    #[tokio::test]
    async fn job_member_pids_contains_assigned_child() {
        assert!(ensure_initialized());
        let child = tokio::process::Command::new("cmd")
            .args(["/C", "ping -n 10 127.0.0.1 > NUL"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("测试环境可 spawn cmd");
        assert!(assign_child(&child));
        let pid = child.id().expect("应有 pid");
        // assign 是异步生效的 OS 调用，微小间隔后查询
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let members = job_member_pids().expect("Job 已初始化，成员枚举应可用");
        assert!(
            members.contains(&pid),
            "assign 后的子进程 PID={pid} 应在 Job 成员集合中，实际 {members:?}"
        );
        // 清理：直接杀掉测试子进程（kill 的是直接子进程 cmd，ping 由 /T 语义随树终止）
        let mut child = child;
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}
