//! Standalone Web Server Entry Point
//!
//! Runs the Polaris web server without Tauri desktop dependencies (no webkit2gtk).
//! Designed for WSL/Linux headless server deployment.
//!
//! Usage:
//!   polaris-web                                    # default: 0.0.0.0:9800
//!   POLARIS_WEB_PORT=8080 polaris-web              # custom port
//!
//! Token authentication is disabled by default. Configure via Web UI Settings
//! page or edit config.json at ~/.config/claude-code-pro/config.json

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    polaris_lib::run_web_server()
}
