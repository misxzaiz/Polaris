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
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
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
}

pub use imp::{assign_child, ensure_initialized};

#[cfg(windows)]
#[cfg(test)]
mod tests {
    use super::imp::{assign_child, ensure_initialized};

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
}
