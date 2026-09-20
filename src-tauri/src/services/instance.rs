//! 实例身份（Multi-Instance）
//!
//! Polaris 支持同时运行多个独立进程（多开）。本模块只负责「我是第几个实例」的
//! 解析，以及由此派生的两处隔离：
//!
//! - WebView2 UserData 目录（硬隔离，避免 `0x8007139F`）
//! - 实例专属数据子目录（logs / dialogs / downloads）
//!
//! ## 实例号解析优先级
//!
//! 1. `--instance <n>` / `--instance=<n>` 命令行参数
//! 2. `POLARIS_INSTANCE` 环境变量
//! 3. 默认 `0`
//!
//! ## 数据分层
//!
//! - 共享层（所有实例）：anchor.json、config.json、plugins/、requirements/、
//!   cache/、scheduler/、.meta/
//! - 实例层（仅实例 >=1）：`instances/<n>/{logs,dialogs,downloads}`
//!
//! 实例 0 复用现有路径，零数据迁移；仅实例 >=1 使用 `instances/<n>/` 子目录。
//!
//! WebView2 目录例外：实例 >=1 才带 `.inst<n>` 后缀；实例 0 沿用原目录
//! 以复用已安装的浏览器缓存。

use std::path::PathBuf;
use std::sync::OnceLock;

/// 实例环境变量名
pub const ENV_INSTANCE: &str = "POLARIS_INSTANCE";

/// 命令行参数名
const ARG_INSTANCE: &str = "--instance";

/// 静态解析结果。`data_root()` 是 `OnceLock` 懒初始化，因此必须在任何路径
/// 解析之前调用 `resolve()`；此处用 `OnceLock` 保证解析一次并复用。
static INSTANCE: OnceLock<u32> = OnceLock::new();

/// 解析并返回当前实例号（首次调用后固定）。
pub fn resolve() -> u32 {
    *INSTANCE.get_or_init(detect)
}

/// 当前实例号
pub fn id() -> u32 {
    resolve()
}

/// 是否为默认实例（共享原始数据路径）
pub fn is_primary() -> bool {
    resolve() == 0
}

/// 解析实例号
fn detect() -> u32 {
    // 优先级 1：命令行参数（`--instance 3` 或 `--instance=3`）
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if args[i] == ARG_INSTANCE {
            if let Some(next) = args.get(i + 1) {
                if let Ok(n) = next.parse::<u32>() {
                    return n;
                }
            }
        }
        if let Some(val) = args[i].strip_prefix(&format!("{}=", ARG_INSTANCE)) {
            if let Ok(n) = val.parse::<u32>() {
                return n;
            }
        }
    }

    // 优先级 2：环境变量
    if let Ok(env) = std::env::var(ENV_INSTANCE) {
        let env = env.trim();
        if !env.is_empty() {
            if let Ok(n) = env.parse::<u32>() {
                return n;
            }
        }
    }

    0
}

// ============================================================================
// WebView2 UserData 隔离
// ============================================================================

/// 按编译模式 + 实例号返回 WebView2 `data_directory`。
///
/// 根因（`0x8007139F`「组或资源状态不正确」）：多个 `polaris.exe` 共用同一个
/// WebView2 UserData 目录时，旧实例锁住目录，新实例创建 webview 失败，表现为
/// 后台服务正常但桌面窗口不显示。按实例拆分目录是唯一的硬隔离手段。
///
/// 目录布局：
/// - dev + 实例 0            -> `com.polaris.app.dev`
/// - dev + 实例 n            -> `com.polaris.app.dev.inst<n>`
/// - test-profile + 实例 0   -> `com.polaris.app.test`
/// - test-profile + 实例 n   -> `com.polaris.app.test.inst<n>`
/// - release + 实例 0        -> `com.polaris.app`
/// - release + 实例 n        -> `com.polaris.app.inst<n>`
pub fn webview_data_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    webview_data_dir_in(&base, resolve())
}

/// 计算 base 目录下的 WebView2 UserData 目录（可注入 base 便于测试）。
fn webview_data_dir_in(base: &std::path::Path, instance: u32) -> PathBuf {
    base.join(webview_instance_dir_name(instance))
        .join("EBWebView")
}

/// 按构建模式 + 实例号返回 WebView2 的 app 目录名（不含 `EBWebView` 段）。
///
/// 各构建模式按 `cfg!` 选择（编译期求值为常量，无运行时开销）。
pub fn webview_instance_dir_name(instance: u32) -> String {
    let app = if cfg!(debug_assertions) {
        "com.polaris.app.dev"
    } else if cfg!(feature = "test-profile") {
        "com.polaris.app.test"
    } else {
        "com.polaris.app"
    };

    if instance == 0 {
        app.to_string()
    } else {
        format!("{}.inst{}", app, instance)
    }
}

// ============================================================================
// 实例专属数据子目录
// ============================================================================

/// 实例专属子目录名：`instances/<n>`（实例 0 不创建该层）。
///
/// 由 [`crate::services::data_root::DataRoot`] 消费：实例 0 返回 `None`，
/// 沿用 `<root>/<name>` 的原始布局；实例 >=1 返回 `Some("instances/<n>")`。
pub fn instance_subdir() -> Option<String> {
    let n = resolve();
    if n == 0 {
        None
    } else {
        Some(format!("instances/{}", n))
    }
}

/// 日志文件名（按实例区分）。
///
/// `tracing-appender` 的 `rolling::daily` 不接受闭包，只能在初始化前算好文件名。
/// 实例 0 保持 `app.log` 不变，实例 >=1 为 `app-<n>.log`。
pub fn log_filename() -> String {
    let n = resolve();
    if n == 0 {
        "app.log".to_string()
    } else {
        format!("app-{}.log", n)
    }
}

/// 主窗口标题。仅实例 >=1 追加标识，避免用户分不清哪个窗口对应哪个实例。
pub fn app_title() -> String {
    let n = resolve();
    if n == 0 {
        "Polaris".to_string()
    } else {
        format!("Polaris - {}", n)
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 不读真实 argv/env 的纯函数版本，供单测断言。
    fn detect_from(args: &[&str], env_value: Option<&str>) -> u32 {
        for i in 0..args.len() {
            if args[i] == ARG_INSTANCE {
                if let Some(next) = args.get(i + 1) {
                    if let Ok(n) = next.parse::<u32>() {
                        return n;
                    }
                }
            }
            if let Some(val) = args[i].strip_prefix(&format!("{}=", ARG_INSTANCE)) {
                if let Ok(n) = val.parse::<u32>() {
                    return n;
                }
            }
        }
        env_value
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty())
            .and_then(|e| e.parse::<u32>().ok())
            .unwrap_or(0)
    }

    #[test]
    fn test_arg_separate_value() {
        assert_eq!(detect_from(&["polaris", "--instance", "3"], None), 3);
    }

    #[test]
    fn test_arg_equals_value() {
        assert_eq!(detect_from(&["polaris", "--instance=7"], None), 7);
    }

    #[test]
    fn test_arg_takes_priority_over_env() {
        assert_eq!(detect_from(&["polaris", "--instance", "3"], Some("9")), 3);
    }

    #[test]
    fn test_env_fallback() {
        assert_eq!(detect_from(&["polaris"], Some("5")), 5);
        assert_eq!(detect_from(&["polaris"], Some("  5  ")), 5);
    }

    #[test]
    fn test_invalid_input_falls_back_to_zero() {
        assert_eq!(detect_from(&["polaris", "--instance", "abc"], None), 0);
        assert_eq!(detect_from(&["polaris", "--instance", "-1"], None), 0);
        assert_eq!(detect_from(&["polaris"], Some("not-a-number")), 0);
        assert_eq!(detect_from(&["polaris"], Some("")), 0);
        assert_eq!(detect_from(&["polaris"], Some("   ")), 0);
        // 悬空参数（后面没有值）不 panic，回退 0
        assert_eq!(detect_from(&["polaris", "--instance"], Some("2")), 2);
        assert_eq!(detect_from(&["polaris", "--instance"], None), 0);
    }

    #[test]
    fn test_other_args_ignored() {
        assert_eq!(detect_from(&["polaris", "-p", "8080"], None), 0);
        assert_eq!(
            detect_from(&["polaris", "--port", "8080", "--instance", "4"], None),
            4
        );
    }

    #[test]
    fn test_webview_dir_never_empty() {
        let dir = webview_data_dir();
        assert!(!dir.as_os_str().is_empty());
        assert!(dir.to_string_lossy().ends_with("EBWebView"));
    }

    #[test]
    fn test_webview_dir_name_isolated_per_instance() {
        let primary = webview_instance_dir_name(0);
        let second = webview_instance_dir_name(1);
        let third = webview_instance_dir_name(42);

        // 关键断言：不同实例的 WebView2 目录名必须两两不同，
        // 否则就是 0x8007139F 的根因（旧实例锁住目录，新实例创建 webview 失败）
        assert_ne!(primary, second);
        assert_ne!(primary, third);
        assert_ne!(second, third);

        // 实例 0 不带 .inst 后缀，沿用原目录（保持已安装版本的兼容）
        assert!(!primary.contains(".inst"));
        assert!(second.contains(".inst1"));
        assert!(third.contains(".inst42"));

        // 完整路径以 EBWebView 结尾，且在 base 目录下
        let full = webview_data_dir_in(std::path::Path::new("/tmp/local"), 3);
        let s = full.to_string_lossy();
        assert!(s.ends_with("EBWebView"));
        assert!(s.contains("inst3"));
    }

    #[test]
    fn test_log_filename_and_title() {
        let n = resolve();
        let expected_file = if n == 0 {
            "app.log".to_string()
        } else {
            format!("app-{}.log", n)
        };
        assert_eq!(log_filename(), expected_file);

        let expected_title = if n == 0 {
            "Polaris".to_string()
        } else {
            format!("Polaris - {}", n)
        };
        assert_eq!(app_title(), expected_title);
    }

    #[test]
    fn test_instance_subdir_semantics() {
        // 纯逻辑：实例 0 不创建 instances/ 层，非 0 创建
        let check = |n: u32| -> Option<String> {
            if n == 0 {
                None
            } else {
                Some(format!("instances/{}", n))
            }
        };
        assert_eq!(check(0), None);
        assert_eq!(check(1), Some("instances/1".to_string()));
        assert_eq!(check(99), Some("instances/99".to_string()));

        // 当前进程的实际值必须自洽
        let n = resolve();
        assert_eq!(instance_subdir().is_some(), n != 0);
        assert_eq!(is_primary(), n == 0);
        assert_eq!(id(), n);
    }
}
