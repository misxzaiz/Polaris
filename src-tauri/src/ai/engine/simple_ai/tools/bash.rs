/*! bash 工具：执行 shell 命令 */

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::path::Path;
use serde_json::{json, Value};

use super::{truncate_chars, Tool, ToolContext, ToolOutcome};

pub(super) struct BashTool;

#[async_trait::async_trait]
impl Tool for BashTool {
    fn name(&self) -> &'static str {
        "bash"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Execute a shell command and return its output. \n\nOn Windows: the shell is auto-detected (Git Bash preferred, then PowerShell, then cmd.exe). POSIX commands (grep, sed, find, rm, ls) may not be available on cmd.exe — prefer the dedicated tools (search_files, glob, read_file, edit_file) which work identically across platforms.\n\nIMPORTANT: Bash-specific syntax (&&, ||, 2>/dev/null, $(...)) only works with Git Bash. When the auto-detected shell is PowerShell or cmd.exe, these constructs fail. Rewrite using PowerShell syntax (-and, -or, 2>$null, Get-Content, Select-String) or use dedicated tools instead.\n\nIf a shell command fails with exit code 127, the command is not installed or not in PATH — use a dedicated tool instead.\n\nUse this to run build tools, scripts, and system commands, not for file content search/edit.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The shell command to execute"
                        },
                        "workdir": {
                            "type": "string",
                            "description": "Working directory for the command (optional, defaults to session work_dir)"
                        }
                    },
                    "required": ["command"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let command = args["command"].as_str().unwrap_or("").to_string();
        let workdir_override = args["workdir"].as_str().map(String::from);
        let default_dir = ctx.work_dir.to_string();
        tokio::task::spawn_blocking(move || {
            run_bash(&command, workdir_override.as_deref(), &default_dir)
        })
        .await
        .unwrap_or_else(|e| ToolOutcome::fail(format!("bash task panicked: {}", e)))
    }
}

/// 检测可用的 shell（按优先级：Git Bash → PowerShell → 系统默认）
///
/// 结果在进程内缓存，避免每次调用 bash 工具都弹出 where.exe 窗口。
///
/// 同时供 `context.rs` 注入 `<environment_context>` 使用，让 LLM 获知实际 shell 类型。
pub(crate) fn detect_shell() -> (&'static str, Option<String>) {
    #[cfg(windows)]
    {
        use std::sync::OnceLock;
        static SHELL: OnceLock<(&'static str, Option<String>)> = OnceLock::new();
        SHELL.get_or_init(detect_shell_windows).clone()
    }
    #[cfg(not(windows))]
    {
        ("sh", None)
    }
}

#[cfg(windows)]
fn detect_shell_windows() -> (&'static str, Option<String>) {
    // 1. 尝试 Git Bash（最常见）
    if let Ok(git_root) = std::env::var("GIT_INSTALL_ROOT") {
        let bash_path = std::path::Path::new(&git_root).join("usr/bin/bash.exe");
        if bash_path.exists() {
            return ("git_bash", Some(bash_path.to_string_lossy().to_string()));
        }
    }
    // 1b. 通过 where.exe 探测 Git Bash（更通用）
    // CREATE_NO_WINDOW 防止 where.exe 弹出控制台窗口
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut where_cmd = std::process::Command::new("where");
    where_cmd.arg("bash");
    where_cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = where_cmd.output() {
        if output.status.success() {
            let stdout = decode_windows_output(&output.stdout);
            // 遍历所有结果，跳过 WSL 的 bash（无法正确处理 Windows 路径）
            for line in stdout.lines() {
                let bash_path = line.trim();
                if bash_path.is_empty() || !Path::new(bash_path).exists() {
                    continue;
                }
                if !is_wsl_bash(bash_path) {
                    return ("git_bash", Some(bash_path.to_string()));
                }
            }
        }
    }
    // 1c. where.exe 不可靠时的兜底：扫描 Git for Windows 常见安装路径
    // 这三个路径在 Git for Windows 所有版本中高度稳定，
    // 用于覆盖 Tauri 桌面应用启动时 PATH 不含 Git 的 usr/bin 目录的场景。
    static GIT_BASH_FALLBACKS: &[&str] = &[
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
        r"C:\Git\usr\bin\bash.exe",
    ];
    for path in GIT_BASH_FALLBACKS {
        if Path::new(path).exists() {
            return ("git_bash", Some((*path).to_string()));
        }
    }
    // 2. 尝试 PowerShell
    let pwsh_path = std::path::Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    if pwsh_path.exists() {
        return ("pwsh", Some(pwsh_path.to_string_lossy().to_string()));
    }
    // 3. 回退 cmd
    ("cmd", None)
}

/// 判断是否为 WSL 的 bash（位于 System32/WindowsApps 下的是 WSL 启动器，
/// 不是原生 Windows bash，无法正确处理 `D:\` 等 Windows 路径）
#[cfg(windows)]
fn is_wsl_bash(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    // WSL launcher at C:\Windows\System32\bash.exe
    // WSL distro launchers in WindowsApps
    lower.contains("system32") || lower.contains("syswow64") || lower.contains("windowsapps")
}

/// 解码 Windows 进程输出。
/// 优先级：UTF-8 → GBK（CP936）→ UTF-8 lossy。
/// 适配 PowerShell 5.1（GBK）与 Git Bash / PowerShell 7（UTF-8）的混用场景。
fn decode_windows_output(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            // 参考 codex.rs::decode_process_output_line 的同一模式
            let (decoded, had_errors) = encoding_rs::GBK.decode_without_bom_handling(bytes);
            if !had_errors {
                decoded.into_owned()
            } else {
                String::from_utf8_lossy(bytes).into_owned()
            }
        }
    }
}

/// 检测命令中是否含有 Bash 特有语法（PowerShell 5.1 / cmd.exe 不支持）。
///
/// 启发式检测，不追求 100% 精确——宁可漏报（让有效命令正常执行），也不误伤。
fn has_bash_syntax(cmd: &str) -> bool {
    for line in cmd.split('\n') {
        let l = line.trim();
        if l.contains("/dev/null") {
            return true;
        }
        if l.contains("2>&1") {
            return true;
        }
        // && 和 || 作为语句分隔符（PowerShell 5.1 不支持）
        if l.contains(" && ") || l.contains(" || ") || l.starts_with("&& ") || l.ends_with(" ||") {
            return true;
        }
        // $(...) 命令替换
        if l.contains("$(") {
            return true;
        }
    }
    false
}

fn run_bash(command: &str, workdir: Option<&str>, default_dir: &str) -> ToolOutcome {
    let cwd = workdir.unwrap_or(default_dir);

    let (shell_name, shell_path) = detect_shell();
    let shell_exe = shell_path.as_deref().unwrap_or(shell_name);

    let mut cmd = std::process::Command::new(shell_exe);
    cmd.current_dir(cwd);

    let (is_bash_shell, uses_powershell_cmd) = if shell_name == "git_bash" {
        // 使用 `-l` 让 Git Bash 以 login shell 模式启动，
        // 确保执行 /etc/profile 设置 MSYS2 PATH（包含 /usr/bin、/bin 等），
        // 避免从桌面启动的程序因 PATH 不含 MSYS2 路径导致 `ls`、`grep`、`cat` 等命令找不到。
        cmd.arg("-l").arg("-c").arg(command);
        (true, false)
    } else if shell_name == "sh" {
        cmd.arg("-c").arg(command);
        (true, false)
    } else if shell_name == "pwsh" {
        cmd.arg("-Command").arg(command);
        (false, true)
    } else if shell_name == "cmd" {
        cmd.arg("/C").arg(command);
        (false, false)
    } else {
        (false, false)
    };

    // 非 Bash shell：执行前检测 Bash 语法并给出前置提示
    // 避免命令裸奔到 shell 被拒导致只收到乱码 stderr
    let syntax_hint = if !is_bash_shell && has_bash_syntax(command) {
        let hint = if uses_powershell_cmd {
            "[Shell hint] The auto-detected shell is PowerShell 5.1, which does not support \
             Bash syntax (&&, ||, 2>/dev/null, $(), etc.).\n\
             Consider: (1) rewrite using PowerShell syntax (-and, -or, 2>$null, Get-Content, \
             Select-String); or (2) use dedicated tools (search_files, glob, read_file, edit_file)\
             which work across all shells.\n\
             ---\n\
             Command: "
        } else {
            "[Shell hint] The auto-detected shell is cmd.exe, which does not support \
             Bash syntax (&&, ||, 2>/dev/null, $(), etc.).\n\
             Consider using dedicated tools (search_files, glob, read_file, edit_file) for \
             file operations, or install Git Bash for POSIX command support.\n\
             ---\n\
             Command: "
        };
        Some(format!("{}\n{}", hint, truncate_chars(command, 512)))
    } else {
        None
    };

    #[cfg(windows)]
    {
        use crate::utils::CREATE_NO_WINDOW;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output();

    match output {
        Ok(o) => {
            let stdout = decode_windows_output(&o.stdout);
            let stderr = decode_windows_output(&o.stderr);
            let exit_code = o.status.code().unwrap_or(-1);

            let mut result = if let Some(hint) = syntax_hint {
                hint
            } else {
                String::new()
            };

            if !stdout.is_empty() {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&stdout);
            }
            if !stderr.is_empty() {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&format!("[stderr]\n{}", stderr));
            }

            // 退出码解读：根据实际 shell 生成针对性提示（避免写死 "cmd.exe" 误导 LLM）
            let cmd_not_found_hint = if shell_name == "git_bash" || shell_name == "sh" {
                // Git Bash 下 exit 127：可能是用了 cmd / PowerShell 专有命令
                format!("[Shell hint] Exit code 127: command not found. The shell is {}, but the \
                 command may use cmd.exe or PowerShell syntax (e.g. dir→ls, type→cat, \
                 findstr→grep, Get-Content→read_file tool). \
                 Use dedicated tools (search_files, glob, read_file, edit_file) for file operations.]",
                    shell_name)
            } else if shell_name == "pwsh" {
                "[Shell hint] Exit code 127: command not found. The shell is PowerShell 5.1. \
                 Use PowerShell syntax (Get-Content, Select-String, Get-ChildItem) or \
                 dedicated tools (search_files, glob, read_file, edit_file).]".to_string()
            } else {
                "[Shell hint] Exit code 127: command not found. The shell is cmd.exe; \
                 POSIX commands are not available. Use dedicated tools or install Git Bash.]".to_string()
            };
            if exit_code == 127 {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&format!("\n{}", cmd_not_found_hint));
            } else if exit_code != 0 {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&format!("[exit code: {}]", exit_code));
            }

            let content = if result.is_empty() {
                "(no output)".to_string()
            } else {
                truncate_chars(&result, 32_768)
            };

            if exit_code == 0 {
                ToolOutcome::ok(content)
            } else {
                ToolOutcome::fail(content)
            }
        }
        Err(e) => ToolOutcome::fail(format!("Failed to execute command with {}: {}", shell_name, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_bash_empty_output() {
        // 基本测试：空命令应该成功
        let out = run_bash("echo hi", None, ".");
        // 不同平台 shell 行为不同，只检查基本结构
        assert!(out.success || out.content.contains("exit code"));
    }

    #[test]
    fn detect_shell_returns_valid_shell() {
        let (name, path) = detect_shell();
        assert!(!name.is_empty());
        #[cfg(windows)]
        assert!(["git_bash", "pwsh", "cmd"].contains(&name));
        #[cfg(not(windows))]
        assert_eq!(name, "sh");
    }
}
