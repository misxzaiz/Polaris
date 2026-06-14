use crate::services::data_root::DataRoot;
use std::path::PathBuf;
use tracing::Level;
use tracing_subscriber::{fmt, prelude::*};
use tracing_appender::{non_blocking, rolling};

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

        // 创建日志文件（按天轮转）
        let file_appender = rolling::daily(&log_dir, "app.log");
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
        // 使用 DataRoot 默认解析（兼容 LEGACY 命名）。
        // log_dir 是静态方法，无法访问 AppState 的动态 DataRoot；
        // Phase 2 引入自定义根后，Logger 可改为从参数或全局持有 DataRoot。
        let dr = DataRoot::resolve_default();
        dr.logs_dir()
    }

    /// 获取当前日志文件路径
    pub fn current_log_file() -> PathBuf {
        Self::log_dir().join("app.log")
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

    /// 读取日志内容
    pub fn read_logs(max_lines: usize) -> Result<String, std::io::Error> {
        let log_file = Self::current_log_file();

        if !log_file.exists() {
            return Ok("暂无日志".to_string());
        }

        let content = std::fs::read_to_string(&log_file)?;

        // 只返回最后 N 行
        let lines: Vec<&str> = content.lines().rev().take(max_lines).collect();
        let result = lines.into_iter().rev().collect::<Vec<_>>().join("\n");

        Ok(result)
    }
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
