//! Computer MCP Binary Entry Point
//!
//! Usage: polaris-computer-mcp [config_dir] [workspace_path]
//!
//! 电脑操作（截图 / 鼠标键盘 / 控件树）MCP server。**仅 Windows** 为真实实现，
//! 因核心能力依赖 Windows UI Automation；其它平台为 stub，直接报错退出。
//! `config_dir` / `workspace_path` 仅为与其它内置 MCP server 的命令行约定对齐而接受。
//! 运行时行为由环境变量控制：POLARIS_COMPUTER_MCP_ENABLED / POLARIS_COMPUTER_FAILSAFE（默认 true）。

#[cfg(windows)]
fn main() {
    use polaris_lib::services::computer_mcp_server::run_computer_mcp_server;

    let args: Vec<String> = std::env::args().collect();
    let config_dir = args.get(1).map(String::as_str).unwrap_or("");
    let workspace_path = args.get(2).map(String::as_str);

    if let Err(error) = run_computer_mcp_server(config_dir, workspace_path) {
        eprintln!("{}", error.to_message());
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!(
        "polaris-computer-mcp 仅支持 Windows（电脑操作依赖 Windows UI Automation 等平台能力）"
    );
    std::process::exit(1);
}
