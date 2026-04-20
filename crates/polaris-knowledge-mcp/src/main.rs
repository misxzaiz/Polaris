//! Standalone Knowledge MCP Server binary.
//!
//! Usage:
//!   polaris-knowledge-mcp <knowledge-dir>
//!   polaris-knowledge-mcp --workspace <workspace-path>
//!
//! The server reads .polaris/knowledge/ module documents and exposes them
//! as MCP tools for Claude Code to query project architecture.

use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();

    // Parse arguments
    let result = if args.len() < 2 {
        eprintln!("Usage: polaris-knowledge-mcp <knowledge-dir>");
        eprintln!("       polaris-knowledge-mcp --workspace <workspace-path>");
        std::process::exit(1);
    } else if args[1] == "--workspace" {
        if args.len() < 3 {
            eprintln!("Error: --workspace requires a path argument");
            std::process::exit(1);
        }
        // Use empty config_dir for standalone mode
        polaris_knowledge_mcp::run_server_with_workspace("", Some(&args[2]))
    } else if args[1] == "--help" || args[1] == "-h" {
        println!("polaris-knowledge-mcp - Standalone Knowledge MCP Server");
        println!();
        println!("Usage:");
        println!("  polaris-knowledge-mcp <knowledge-dir>");
        println!("  polaris-knowledge-mcp --workspace <workspace-path>");
        println!();
        println!("Arguments:");
        println!("  <knowledge-dir>      Path to .polaris/knowledge directory");
        println!("  --workspace <path>   Path to workspace root (uses .polaris/knowledge inside)");
        println!();
        println!("The server communicates via JSON-RPC over stdin/stdout.");
        std::process::exit(0);
    } else {
        // First argument is the knowledge directory
        polaris_knowledge_mcp::run_server(&args[1])
    };

    if let Err(e) = result {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
