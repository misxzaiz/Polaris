use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::Result;
use crate::services::mcp_config_service::WorkspaceMcpConfigService;

/// Platform-aware executable suffix: ".exe" on Windows, "" on Linux/macOS.
const EXE_SUFFIX: &str = std::env::consts::EXE_SUFFIX;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoMcpDiagnostics {
    pub app_root: String,
    pub config_dir: String,
    pub resource_dir: Option<String>,
    pub resolved_executable_path: String,
    pub executable_exists: bool,
    pub expected_resource_bin_path: Option<String>,
    pub expected_resource_root_path: Option<String>,
    pub expected_dev_path: String,
    pub workspace_config_path: Option<String>,
    pub workspace_config_exists: Option<bool>,
}

pub struct TodoMcpDiagnosticsService;

impl TodoMcpDiagnosticsService {
    pub fn collect(
        config_dir: PathBuf,
        app_root: PathBuf,
        resource_dir: Option<PathBuf>,
        workspace_path: Option<&str>,
    ) -> Result<TodoMcpDiagnostics> {
        let service = WorkspaceMcpConfigService::from_app_paths(config_dir.clone(), resource_dir.clone(), app_root.clone())?;
        let resolved_executable_path = service.executable_path().to_path_buf();
        let workspace_config_path = workspace_path
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| PathBuf::from(value).join(Path::new(".polaris/claude/mcp.json")));

        let workspace_config_exists = workspace_config_path
            .as_ref()
            .map(|path| path.exists());

        Ok(TodoMcpDiagnostics {
            app_root: app_root.to_string_lossy().to_string(),
            config_dir: config_dir.to_string_lossy().to_string(),
            resource_dir: resource_dir.as_ref().map(|path| path.to_string_lossy().to_string()),
            resolved_executable_path: resolved_executable_path.to_string_lossy().to_string(),
            executable_exists: resolved_executable_path.exists(),
            expected_resource_bin_path: resource_dir
                .as_ref()
                .map(|dir| dir.join(format!("bin/polaris-todo-mcp{}", EXE_SUFFIX)).to_string_lossy().to_string()),
            expected_resource_root_path: resource_dir
                .as_ref()
                .map(|dir| dir.join(format!("polaris-todo-mcp{}", EXE_SUFFIX)).to_string_lossy().to_string()),
            expected_dev_path: app_root
                .join(format!("src-tauri/target/debug/polaris-todo-mcp{}", EXE_SUFFIX))
                .to_string_lossy()
                .to_string(),
            workspace_config_path: workspace_config_path
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            workspace_config_exists,
        })
    }
}
