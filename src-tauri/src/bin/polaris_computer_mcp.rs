//! polaris-computer-mcp —— 电脑操作 MCP server 独立二进制（仅 Windows）
//!
//! 内置插件 polaris.computer 摘除后，MCP server 面以独立 exe 随插件 zip 分发
//! （插件仓 plugins/computer/bin/）。工具面与协议 1:1 复用
//! `services/computer_mcp_server.rs`（与 SimpleAI 引擎共用 `computer_control`
//! 业务核，金标单源不变）。
//!
//! 用法：polaris-computer-mcp [config_dir]（参数当前未消费，兼容占位）
//!
//! 非 Windows 平台：编译为空壳（打印错误退出），插件 manifest 无平台声明
//! 字段（SPEC 限制），非 Windows 用户装上后 server 启动失败即不注入。

#[cfg(windows)]
fn main_impl() -> polaris_lib::Result<()> {
    polaris_lib::services::computer_mcp_server::run_computer_mcp_server("", None)
}

#[cfg(not(windows))]
fn main_impl() -> polaris_lib::Result<()> {
    Err(polaris_lib::AppError::ValidationError(
        "polaris-computer-mcp 仅支持 Windows（依赖 UI Automation / enigo / xcap）".into(),
    ))
}

fn main() {
    if let Err(error) = main_impl() {
        let message = error.to_message();
        eprintln!("{}", message);
        std::process::exit(1);
    }
}
