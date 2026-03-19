/*! 单例锁模块
 *
 * 用于确保同一时刻只有一个实例运行调度器
 * Windows: 使用 Named Mutex
 * Unix: 使用文件锁 (flock)
 */

use std::io;

/// 调度器单例锁
pub struct SchedulerLock {
    #[cfg(target_os = "windows")]
    handle: usize, // HANDLE 是指针大小
    #[cfg(not(target_os = "windows"))]
    _file: std::fs::File,
}

/// 锁名称常量
pub const SCHEDULER_LOCK_NAME: &str = "PolarisScheduler";

impl SchedulerLock {
    /// 尝试获取调度器单例锁
    /// 返回 Ok(Some(guard)) 表示成功获取锁
    /// 返回 Ok(None) 表示其他实例已持有锁
    /// 返回 Err 表示发生错误
    pub fn try_acquire() -> io::Result<Option<Self>> {
        #[cfg(target_os = "windows")]
        {
            Self::try_acquire_windows()
        }

        #[cfg(not(target_os = "windows"))]
        {
            Self::try_acquire_unix()
        }
    }

    /// 强制释放锁（用于重置/接管）
    pub fn force_release() -> io::Result<()> {
        #[cfg(target_os = "windows")]
        {
            Self::force_release_windows()
        }

        #[cfg(not(target_os = "windows"))]
        {
            Self::force_release_unix()
        }
    }

    /// 检查是否有其他实例持有锁
    pub fn is_locked() -> bool {
        Self::try_acquire().map(|g| g.is_none()).unwrap_or(false)
    }

    // ========================================================================
    // Windows 实现
    // ========================================================================

    #[cfg(target_os = "windows")]
    fn try_acquire_windows() -> io::Result<Option<Self>> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use std::ptr;

        // 动态加载 kernel32.dll
        let kernel32 = match unsafe { libloading::Library::new("kernel32.dll") } {
            Ok(lib) => lib,
            Err(_) => {
                // 如果无法加载，返回一个假的成功，让应用继续运行
                tracing::warn!("[SchedulerLock] 无法加载 kernel32.dll，跳过锁检查");
                return Ok(Some(Self { handle: 0 }));
            }
        };

        // 获取 CreateMutexW 函数
        let create_mutex: libloading::Symbol<
            unsafe extern "system" fn(
                *mut std::ffi::c_void,
                i32,
                *const u16,
            ) -> *mut std::ffi::c_void,
        > = match unsafe { kernel32.get(b"CreateMutexW") } {
            Ok(sym) => sym,
            Err(_) => {
                tracing::warn!("[SchedulerLock] 无法获取 CreateMutexW 函数");
                return Ok(Some(Self { handle: 0 }));
            }
        };

        // 获取 GetLastError 函数
        let get_last_error: libloading::Symbol<unsafe extern "system" fn() -> u32> =
            match unsafe { kernel32.get(b"GetLastError") } {
                Ok(sym) => sym,
                Err(_) => {
                    tracing::warn!("[SchedulerLock] 无法获取 GetLastError 函数");
                    return Ok(Some(Self { handle: 0 }));
                }
            };

        // 准备锁名称 (Global\ 前缀确保跨会话)
        let name = format!("Global\\{}", SCHEDULER_LOCK_NAME);
        let wide_name: Vec<u16> = OsStr::new(&name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        // 创建 Mutex
        let handle = unsafe { create_mutex(ptr::null_mut(), 0, wide_name.as_ptr()) };

        if handle.is_null() {
            return Err(io::Error::other(
                "CreateMutex 返回 NULL",
            ));
        }

        let err = unsafe { get_last_error() };
        const ERROR_ALREADY_EXISTS: u32 = 183;

        if err == ERROR_ALREADY_EXISTS {
            // 已存在，其他实例持有锁
            tracing::info!("[SchedulerLock] 其他实例已持有调度器锁");
            // 关闭我们获取的句柄
            let close_handle: libloading::Symbol<
                unsafe extern "system" fn(*mut std::ffi::c_void) -> i32,
            > = unsafe { kernel32.get(b"CloseHandle").unwrap() };
            unsafe { close_handle(handle) };
            return Ok(None);
        }

        tracing::info!("[SchedulerLock] 成功获取调度器锁");
        // 将句柄转换为 usize 存储（避免裸指针）
        Ok(Some(Self {
            handle: handle as usize,
        }))
    }

    #[cfg(target_os = "windows")]
    fn force_release_windows() -> io::Result<()> {
        // Windows 的 Named Mutex 无法从外部强制释放
        // 只能由持有者释放，或进程终止时自动释放
        tracing::warn!("[SchedulerLock] Windows 不支持强制释放 Named Mutex，请确保其他实例已关闭");
        Ok(())
    }

    // ========================================================================
    // Unix 实现 (macOS, Linux)
    // ========================================================================

    #[cfg(not(target_os = "windows"))]
    fn try_acquire_unix() -> io::Result<Option<Self>> {
        use std::os::unix::fs::OpenOptionsExt;

        let lock_dir = std::env::temp_dir();
        let lock_path = lock_dir.join(format!("{}.lock", SCHEDULER_LOCK_NAME));

        // 打开或创建锁文件
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .mode(0o644)
            .open(&lock_path)?;

        // 尝试获取排他锁（非阻塞）
        let result = unsafe {
            libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB)
        };

        if result != 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::EWOULDBLOCK)
                || err.raw_os_error() == Some(libc::EAGAIN)
            {
                // 已被其他进程锁定
                tracing::info!("[SchedulerLock] 其他实例已持有调度器锁");
                return Ok(None);
            }
            return Err(err);
        }

        // 写入当前进程 PID（用于诊断）
        let pid = std::process::id();
        use std::io::Write;
        let mut file = file;
        file.set_len(0)?; // 清空文件
        file.write_all(format!("{}", pid).as_bytes())?;

        tracing::info!("[SchedulerLock] 成功获取调度器锁 (PID: {})", pid);
        Ok(Some(Self { _file: file }))
    }

    #[cfg(not(target_os = "windows"))]
    fn force_release_unix() -> io::Result<()> {
        let lock_dir = std::env::temp_dir();
        let lock_path = lock_dir.join(format!("{}.lock", SCHEDULER_LOCK_NAME));

        // 删除锁文件
        match std::fs::remove_file(&lock_path) {
            Ok(_) => {
                tracing::info!("[SchedulerLock] 已删除锁文件: {:?}", lock_path);
                Ok(())
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                tracing::info!("[SchedulerLock] 锁文件不存在，无需删除");
                Ok(())
            }
            Err(e) => Err(e),
        }
    }
}

impl Drop for SchedulerLock {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        {
            if self.handle != 0 {
                // 动态加载 CloseHandle
                if let Ok(kernel32) = unsafe { libloading::Library::new("kernel32.dll") } {
                    if let Ok(close_handle) =
                        unsafe { kernel32.get(b"CloseHandle") }
                            as Result<_, _>
                    {
                        let close_handle: libloading::Symbol<
                            unsafe extern "system" fn(*mut std::ffi::c_void) -> i32,
                        > = close_handle;
                        unsafe { close_handle(self.handle as *mut std::ffi::c_void) };
                    }
                }
                tracing::info!("[SchedulerLock] 已释放调度器锁");
            }
        }
        // Unix: 文件锁会在 File drop 时自动释放
    }
}

/// 锁状态信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    /// 当前实例是否持有锁
    pub is_holder: bool,
    /// 是否有其他实例持有锁
    pub is_locked_by_other: bool,
    /// 当前进程 PID
    pub pid: u32,
}
