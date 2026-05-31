//! Standalone Web Server Entry Point
//!
//! Runs the Polaris web server without Tauri desktop dependencies (no webkit2gtk).
//! Designed for WSL/Linux headless server deployment.
//!
//! Usage:
//!   polaris-web                                    # default: 0.0.0.0:9830
//!   polaris-web --port 8080                        # custom port
//!   polaris-web --host 127.0.0.1 --port 3000      # custom host + port
//!   polaris-web --token my-secret                  # enable token auth
//!   POLARIS_WEB_PORT=8080 polaris-web              # custom port via env var
//!   POLARIS_WEB_TOKEN=my-secret polaris-web        # token auth via env var
//!
//! Priority: CLI args > environment variables > config file
//!
//! Token authentication is disabled by default. Enable via --token flag,
//! POLARIS_WEB_TOKEN env var, Web UI Settings page, or edit config.json
//! at ~/.config/claude-code-pro/config.json

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut port: Option<u16> = None;
    let mut host: Option<String> = None;
    let mut token: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--port" | "-p" => {
                if let Some(val) = args.get(i + 1) {
                    port = val.parse().ok();
                    i += 2;
                } else {
                    eprintln!("Error: --port requires a value");
                    std::process::exit(1);
                }
            }
            "--host" | "-h" => {
                if let Some(val) = args.get(i + 1) {
                    host = Some(val.clone());
                    i += 2;
                } else {
                    eprintln!("Error: --host requires a value");
                    std::process::exit(1);
                }
            }
            "--token" | "-t" => {
                if let Some(val) = args.get(i + 1) {
                    token = Some(val.clone());
                    i += 2;
                } else {
                    eprintln!("Error: --token requires a value");
                    std::process::exit(1);
                }
            }
            "--help" => {
                print_help();
                std::process::exit(0);
            }
            other => {
                eprintln!("Unknown argument: {}", other);
                print_help();
                std::process::exit(1);
            }
        }
    }

    // Token 也支持环境变量回退: POLARIS_WEB_TOKEN
    let token = token
        .or_else(|| std::env::var("POLARIS_WEB_TOKEN").ok().filter(|v| !v.is_empty()));

    polaris_lib::run_web_server(port, host, token)
}

fn print_help() {
    println!("Polaris Web Server — standalone headless mode");
    println!();
    println!("USAGE:");
    println!("  polaris-web [OPTIONS]");
    println!();
    println!("OPTIONS:");
    println!("  -p, --port <PORT>    Listening port (default: 9830, env: POLARIS_WEB_PORT)");
    println!("  -h, --host <HOST>    Listening address (default: 0.0.0.0)");
    println!("  -t, --token <TOKEN>  Auth token (env: POLARIS_WEB_TOKEN, disabled by default)");
    println!("      --help           Show this help message");
    println!();
    println!("Priority: CLI args > environment variables > config file");
}
