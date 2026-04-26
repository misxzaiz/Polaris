//! CLI 解析器 — 共享的 Claude CLI 类型检测和命令构建
//!
//! 所有需要执行 Claude CLI 的 service 应通过此模块构建 Command，
//! 确保在 Windows npm/pnpm 安装场景下正确解析为 node.exe cli.js。

use std::process::Command;
use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

// ---------------------------------------------------------------------------
// CLI 类型
// ---------------------------------------------------------------------------

/// Claude CLI 安装类型（仅 Windows）
#[cfg(windows)]
#[derive(Debug, Clone)]
pub enum CliType {
    /// npm/pnpm 安装的包装脚本（需要 node.exe + cli.js）
    NpmWrapper { node_exe: String, cli_js: String },
    /// 独立可执行文件（直接执行）
    Standalone { exe_path: String },
}

// ---------------------------------------------------------------------------
// 命令构建 — 核心公共 API
// ---------------------------------------------------------------------------

/// 构建可直接添加参数的 Command。
///
/// Windows: 根据 CLI 类型解析为 `exe_path` 或 `node.exe cli.js`。
/// 非 Windows: 直接 `Command::new(cli_path)`。
pub fn build_cli_command(cli_path: &str) -> Result<Command> {
    #[cfg(windows)]
    {
        let cli_type = detect_cli_type(cli_path)?;
        let mut cmd = match cli_type {
            CliType::Standalone { exe_path } => Command::new(exe_path),
            CliType::NpmWrapper { node_exe, cli_js } => {
                let mut c = Command::new(node_exe);
                c.arg(cli_js);
                c
            }
        };
        cmd.creation_flags(CREATE_NO_WINDOW);
        Ok(cmd)
    }

    #[cfg(not(windows))]
    {
        Ok(Command::new(cli_path))
    }
}

/// 检查 CLI 是否可用（不抛错误，返回 bool）
pub fn is_cli_available(cli_path: &str) -> bool {
    #[cfg(windows)]
    {
        detect_cli_type(cli_path).is_ok()
    }

    #[cfg(not(windows))]
    {
        if Path::new(cli_path).is_absolute() {
            Path::new(cli_path).exists()
        } else {
            Command::new("which")
                .arg(cli_path)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
    }
}

// ---------------------------------------------------------------------------
// 检测
// ---------------------------------------------------------------------------

/// 将裸命令名（如 "claude"）解析为完整路径（仅 Windows）
///
/// 使用 `where` 命令查找，与 `ConfigStore::resolve_claude_path` 策略对齐。
#[cfg(windows)]
fn resolve_bare_command(cmd: &str) -> Option<String> {
    let output = Command::new("cmd")
        .args(["/C", "where", cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok();

    if let Some(out) = output {
        if out.status.success() {
            return String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
        }
    }
    None
}

/// 检测 CLI 安装类型（仅 Windows）
#[cfg(windows)]
pub fn detect_cli_type(cli_path: &str) -> Result<CliType> {
    // 如果是裸命令名（不含路径分隔符），先用 where 解析为完整路径
    let resolved = if !cli_path.contains(std::path::MAIN_SEPARATOR)
        && !cli_path.contains('/')
        && !cli_path.contains('\\')
    {
        match resolve_bare_command(cli_path) {
            Some(full_path) => {
                tracing::info!("[CliResolver] 裸命令 '{}' 解析为: {}", cli_path, full_path);
                full_path
            }
            None => {
                return Err(AppError::ProcessError(format!(
                    "CLI 路径不存在且无法通过 where 命令解析: {}", cli_path
                )));
            }
        }
    } else {
        cli_path.to_string()
    };

    let resolved_path = Path::new(&resolved);

    // 提前检查路径是否存在
    if !resolved_path.exists() {
        return Err(AppError::ProcessError(format!("CLI 路径不存在: {}", resolved)));
    }

    // 情况 1: 如果是 .exe 文件且不在 node_modules 中，可能是独立可执行文件
    if resolved_path.extension().map(|e| e == "exe").unwrap_or(false) {
        // 检查是否是 npm/pnpm 的包装脚本
        // npm/pnpm 的 .exe 通常很小，真正的逻辑在 cli.js 中
        // 如果是较大的独立可执行文件，直接执行
        let is_standalone = is_likely_standalone_exe(&resolved);

        if is_standalone {
            tracing::info!("[CliResolver] 检测到独立可执行文件: {}", resolved);
            return Ok(CliType::Standalone {
                exe_path: resolved,
            });
        }
    }

    // 情况 2: npm/pnpm 安装 - 需要解析 node.exe 和 cli.js
    tracing::info!("[CliResolver] 尝试解析为 npm/pnpm 安装: {}", resolved);
    let (node_exe, cli_js) = resolve_node_and_cli(&resolved)?;
    Ok(CliType::NpmWrapper { node_exe, cli_js })
}

/// 判断一个 exe 文件是否可能是独立的 Claude Code
#[cfg(windows)]
pub fn is_likely_standalone_exe(exe_path: &str) -> bool {
    // 策略 1: 检查文件名是否包含 "claude"
    let path = Path::new(exe_path);
    let file_name = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");

    if !file_name.to_lowercase().contains("claude") {
        return false;
    }

    // 策略 2: 检查文件大小，独立可执行文件通常 > 10MB
    // 而 npm/pnpm 的包装脚本通常 < 1MB
    if let Ok(metadata) = std::fs::metadata(exe_path) {
        let size_mb = metadata.len() as f64 / (1024.0 * 1024.0);
        tracing::info!("[CliResolver] {} 文件大小: {:.2} MB", exe_path, size_mb);

        // 如果大于 5MB，认为是独立可执行文件
        if size_mb > 5.0 {
            return true;
        }
    }

    // 策略 3: 检查同一目录下是否有 node_modules/@anthropic-ai/claude-code
    if let Some(parent) = path.parent() {
        let has_node_modules = parent.join("node_modules").join("@anthropic-ai").join("claude-code").exists();
        if !has_node_modules {
            // 没有 node_modules，可能是独立可执行文件
            return true;
        }
    }

    false
}

// ---------------------------------------------------------------------------
// Windows 内部辅助函数（从 claude.rs 提取，逻辑不变）
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn resolve_node_and_cli(claude_cmd_path: &str) -> Result<(String, String)> {
    let cmd_path = Path::new(claude_cmd_path);
    let cmd_parent = cmd_path.parent()
        .ok_or_else(|| AppError::ProcessError("无法获取 claude.cmd 的父目录".to_string()))?;

    tracing::info!("[CliResolver] 解析 node 和 cli.js，基础路径: {:?}", cmd_parent);

    // 1. 尝试查找 node.exe
    let node_exe = find_node_exe(cmd_parent)?;
    tracing::info!("[CliResolver] 找到 node.exe: {}", node_exe);

    // 2. 尝试查找 cli.js（支持 npm 和 pnpm 的不同目录结构）
    let cli_js = find_cli_js(cmd_parent, &node_exe)?;
    tracing::info!("[CliResolver] 找到 cli.js: {}", cli_js);

    Ok((node_exe, cli_js))
}

#[cfg(windows)]
fn find_node_exe(base_dir: &Path) -> Result<String> {
    // 策略 1: 检查同一目录下是否有 node.exe（npm 安装）
    let local_node = base_dir.join("node.exe");
    if local_node.exists() {
        tracing::info!("[CliResolver] 在同一目录找到 node.exe: {:?}", local_node);
        return Ok(local_node.to_string_lossy().to_string());
    }

    // 策略 2: 使用 where 命令查找
    let output = Command::new("where")
        .args(["node"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| AppError::ProcessError(format!("查找 node.exe 失败: {}", e)))?;

    if output.status.success() {
        let node_path = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .map(|s| s.trim().to_string());

        if let Some(path) = node_path {
            tracing::info!("[CliResolver] 通过 where 找到 node.exe: {}", path);
            return Ok(path);
        }
    }

    // 策略 3: 尝试常见路径
    let common_paths = vec![
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ];

    for path in common_paths {
        if Path::new(path).exists() {
            tracing::info!("[CliResolver] 在常见路径找到 node.exe: {}", path);
            return Ok(path.to_string());
        }
    }

    Err(AppError::ProcessError("无法找到 node.exe，请确保 Node.js 已安装".to_string()))
}

#[cfg(windows)]
fn find_cli_js(base_dir: &Path, node_exe_path: &str) -> Result<String> {
    // 策略 1: 检查同一目录下的 node_modules（npm 本地安装）
    let local_cli_js = base_dir
        .join("node_modules")
        .join("@anthropic-ai")
        .join("claude-code")
        .join("cli.js");
    if local_cli_js.exists() {
        tracing::info!("[CliResolver] 在同一目录 node_modules 找到 cli.js");
        return Ok(local_cli_js.to_string_lossy().to_string());
    }

    // 策略 2: 检查全局 npm 安装路径 (%APPDATA%\npm\node_modules)
    if let Ok(appdata) = std::env::var("APPDATA") {
        let npm_global = PathBuf::from(&appdata)
            .join("npm")
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");
        if npm_global.exists() {
            tracing::info!("[CliResolver] 在 APPDATA\\npm\\node_modules 找到 cli.js");
            return Ok(npm_global.to_string_lossy().to_string());
        }
    }

    // 策略 3: 检查 pnpm 全局安装路径
    // pnpm 全局安装通常位于 %PNPM_HOME% 或 %LOCALAPPDATA%\pnpm
    if let Ok(pnpm_home) = std::env::var("PNPM_HOME") {
        // pnpm 全局包的位置
        let pnpm_global = PathBuf::from(&pnpm_home)
            .join("global")
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");
        if pnpm_global.exists() {
            tracing::info!("[CliResolver] 在 PNPM_HOME\\global\\node_modules 找到 cli.js");
            return Ok(pnpm_global.to_string_lossy().to_string());
        }

        // 另一种 pnpm 结构
        let pnpm_global2 = PathBuf::from(&pnpm_home)
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");
        if pnpm_global2.exists() {
            tracing::info!("[CliResolver] 在 PNPM_HOME\\node_modules 找到 cli.js");
            return Ok(pnpm_global2.to_string_lossy().to_string());
        }
    }

    // 策略 4: 检查 LOCALAPPDATA\pnpm（pnpm 的默认安装位置）
    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let pnpm_default = PathBuf::from(&localappdata)
            .join("pnpm")
            .join("global")
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");
        if pnpm_default.exists() {
            tracing::info!("[CliResolver] 在 LOCALAPPDATA\\pnpm\\global\\node_modules 找到 cli.js");
            return Ok(pnpm_default.to_string_lossy().to_string());
        }
    }

    // 策略 5: 从 node.exe 路径推断（pnpm 可能与 node 在同一目录）
    if let Some(node_dir) = Path::new(node_exe_path).parent() {
        // pnpm 可能将全局包放在与 node.exe 同级的 node_modules
        let node_sibling = node_dir
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");
        if node_sibling.exists() {
            tracing::info!("[CliResolver] 在 node.exe 同级 node_modules 找到 cli.js");
            return Ok(node_sibling.to_string_lossy().to_string());
        }

        // 检查上级目录的 node_modules（pnpm 的某些配置）
        if let Some(parent) = node_dir.parent() {
            let parent_global = parent
                .join("global")
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("cli.js");
            if parent_global.exists() {
                tracing::info!("[CliResolver] 在 node.exe 上级目录找到 cli.js");
                return Ok(parent_global.to_string_lossy().to_string());
            }
        }
    }

    // 策略 6: 使用 npm root -g 获取全局安装路径
    if let Ok(output) = Command::new("npm")
        .args(["root", "-g"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if output.status.success() {
            let npm_root = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !npm_root.is_empty() {
                let npm_cli = PathBuf::from(npm_root)
                    .join("@anthropic-ai")
                    .join("claude-code")
                    .join("cli.js");
                if npm_cli.exists() {
                    tracing::info!("[CliResolver] 通过 npm root -g 找到 cli.js");
                    return Ok(npm_cli.to_string_lossy().to_string());
                }
            }
        }
    }

    // 策略 7: 使用 pnpm root -g 获取 pnpm 全局安装路径
    if let Ok(output) = Command::new("pnpm")
        .args(["root", "-g"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if output.status.success() {
            let pnpm_root = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !pnpm_root.is_empty() {
                let pnpm_cli = PathBuf::from(pnpm_root)
                    .join("@anthropic-ai")
                    .join("claude-code")
                    .join("cli.js");
                if pnpm_cli.exists() {
                    tracing::info!("[CliResolver] 通过 pnpm root -g 找到 cli.js");
                    return Ok(pnpm_cli.to_string_lossy().to_string());
                }
            }
        }
    }

    Err(AppError::ProcessError(
        "无法找到 cli.js。请确保 Claude Code 已通过 npm 或 pnpm 全局安装:\n\
        npm install -g @anthropic-ai/claude-code\n\
        或\n\
        pnpm add -g @anthropic-ai/claude-code".to_string(),
    ))
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn test_is_likely_standalone_exe_rejects_non_claude_name() {
        assert!(!is_likely_standalone_exe("C:\\some\\random.exe"));
    }

    #[test]
    fn test_is_cli_available_returns_false_for_nonexistent() {
        assert!(!is_cli_available("C:\\nonexistent\\path\\claude.exe"));
    }

    #[test]
    #[cfg(not(windows))]
    fn test_build_cli_command_non_windows() {
        let cmd = build_cli_command("claude");
        assert!(cmd.is_ok());
    }
}
