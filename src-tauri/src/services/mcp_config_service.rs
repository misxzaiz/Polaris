use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};

const MCP_CONFIG_RELATIVE_PATH: &str = ".polaris/claude/mcp.json";
const TODO_MCP_SERVER_NAME: &str = "polaris-todo";
const TODO_MCP_BIN_NAME: &str = "polaris-todo-mcp";
const REQUIREMENTS_MCP_SERVER_NAME: &str = "polaris-requirements";
const REQUIREMENTS_MCP_BIN_NAME: &str = "polaris-requirements-mcp";
const SCHEDULER_MCP_SERVER_NAME: &str = "polaris-scheduler";
const SCHEDULER_MCP_BIN_NAME: &str = "polaris-scheduler-mcp";

/// Platform-aware executable suffix: ".exe" on Windows, "" on Linux/macOS.
const EXE_SUFFIX: &str = std::env::consts::EXE_SUFFIX;

/// Build a platform-correct relative path for an MCP binary.
fn mcp_exe_path(prefix: &str) -> String {
    format!("{}{}", prefix, EXE_SUFFIX)
}

fn todo_bundle_path() -> String { mcp_exe_path("bin/polaris-todo-mcp") }
fn todo_fallback_path() -> String { mcp_exe_path("polaris-todo-mcp") }
fn todo_dev_path() -> String { mcp_exe_path("src-tauri/target/debug/polaris-todo-mcp") }
fn requirements_bundle_path() -> String { mcp_exe_path("bin/polaris-requirements-mcp") }
fn requirements_fallback_path() -> String { mcp_exe_path("polaris-requirements-mcp") }
fn requirements_dev_path() -> String { mcp_exe_path("src-tauri/target/debug/polaris-requirements-mcp") }
fn scheduler_bundle_path() -> String { mcp_exe_path("bin/polaris-scheduler-mcp") }
fn scheduler_fallback_path() -> String { mcp_exe_path("polaris-scheduler-mcp") }
fn scheduler_dev_path() -> String { mcp_exe_path("src-tauri/target/debug/polaris-scheduler-mcp") }

#[derive(Debug, Clone, serde::Serialize)]
struct ClaudeMcpServerConfig {
    command: String,
    args: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeMcpConfig {
    mcp_servers: std::collections::BTreeMap<String, ClaudeMcpServerConfig>,
}

#[derive(Debug, Clone)]
struct ResolvedMcpBinary {
    server_name: &'static str,
    executable_path: PathBuf,
}

pub struct WorkspaceMcpConfigService {
    binaries: Vec<ResolvedMcpBinary>,
    config_dir: PathBuf,
}

impl WorkspaceMcpConfigService {
    pub fn new(
        config_dir: PathBuf,
        todo_executable_path: PathBuf,
        requirements_executable_path: Option<PathBuf>,
        scheduler_executable_path: Option<PathBuf>,
    ) -> Self {
        let mut binaries = vec![ResolvedMcpBinary {
            server_name: TODO_MCP_SERVER_NAME,
            executable_path: todo_executable_path,
        }];

        if let Some(path) = requirements_executable_path {
            binaries.push(ResolvedMcpBinary {
                server_name: REQUIREMENTS_MCP_SERVER_NAME,
                executable_path: path,
            });
        }

        if let Some(path) = scheduler_executable_path {
            binaries.push(ResolvedMcpBinary {
                server_name: SCHEDULER_MCP_SERVER_NAME,
                executable_path: path,
            });
        }

        Self { binaries, config_dir }
    }

    pub fn executable_path(&self) -> &Path {
        &self.binaries[0].executable_path
    }

    pub fn from_app_paths(config_dir: PathBuf, resource_dir: Option<PathBuf>, app_root: PathBuf) -> Result<Self> {
        let todo_executable_path = resolve_mcp_executable_path(
            resource_dir.clone(),
            app_root.clone(),
            TODO_MCP_BIN_NAME,
            &todo_bundle_path(),
            &todo_fallback_path(),
            &todo_dev_path(),
            "POLARIS_TODO_MCP_PATH",
        )?;

        let requirements_executable_path = resolve_optional_mcp_executable_path(
            resource_dir.clone(),
            app_root.clone(),
            REQUIREMENTS_MCP_BIN_NAME,
            &requirements_bundle_path(),
            &requirements_fallback_path(),
            &requirements_dev_path(),
            "POLARIS_REQUIREMENTS_MCP_PATH",
        );

        let scheduler_executable_path = resolve_optional_mcp_executable_path(
            resource_dir,
            app_root,
            SCHEDULER_MCP_BIN_NAME,
            &scheduler_bundle_path(),
            &scheduler_fallback_path(),
            &scheduler_dev_path(),
            "POLARIS_SCHEDULER_MCP_PATH",
        );

        Ok(Self::new(
            config_dir,
            todo_executable_path,
            requirements_executable_path,
            scheduler_executable_path,
        ))
    }

    pub fn prepare_workspace_config(&self, workspace_path: &str) -> Result<PathBuf> {
        let normalized_workspace = workspace_path.trim();
        if normalized_workspace.is_empty() {
            return Err(AppError::ValidationError("workspace_path 不能为空".to_string()));
        }

        let workspace_dir = PathBuf::from(normalized_workspace);
        let config_path = workspace_dir.join(Path::new(MCP_CONFIG_RELATIVE_PATH));

        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::ProcessError(format!("创建 MCP 配置目录失败: {}", e))
            })?;
        }

        let mut servers = std::collections::BTreeMap::new();
        for binary in &self.binaries {
            if !binary.executable_path.exists() {
                return Err(AppError::ProcessError(format!(
                    "{} 可执行文件不存在: {}",
                    binary.server_name,
                    binary.executable_path.display()
                )));
            }

            // Todo MCP, Requirements MCP, and Scheduler MCP need both config_dir and workspace_path
            // Other MCPs only need workspace_path
            let args = if binary.server_name == TODO_MCP_SERVER_NAME
                || binary.server_name == REQUIREMENTS_MCP_SERVER_NAME
                || binary.server_name == SCHEDULER_MCP_SERVER_NAME
            {
                vec![
                    self.config_dir.to_string_lossy().to_string(),
                    normalized_workspace.to_string(),
                ]
            } else {
                vec![normalized_workspace.to_string()]
            };

            servers.insert(
                binary.server_name.to_string(),
                ClaudeMcpServerConfig {
                    command: binary.executable_path.to_string_lossy().to_string(),
                    args,
                },
            );
        }

        let config = ClaudeMcpConfig {
            mcp_servers: servers,
        };

        write_json_atomically(&config_path, &config)?;
        Ok(config_path)
    }
}

fn resolve_optional_mcp_executable_path(
    resource_dir: Option<PathBuf>,
    app_root: PathBuf,
    bin_name: &str,
    bundled_relative_path: &str,
    bundled_fallback_relative_path: &str,
    dev_relative_path: &str,
    env_var_name: &str,
) -> Option<PathBuf> {
    match resolve_mcp_executable_path(
        resource_dir,
        app_root,
        bin_name,
        bundled_relative_path,
        bundled_fallback_relative_path,
        dev_relative_path,
        env_var_name,
    ) {
        Ok(path) => Some(path),
        Err(error) => {
            tracing::warn!("[MCP] 跳过可选 MCP server {}: {}", bin_name, error.to_message());
            None
        }
    }
}

fn resolve_mcp_executable_path(
    resource_dir: Option<PathBuf>,
    app_root: PathBuf,
    bin_name: &str,
    bundled_relative_path: &str,
    bundled_fallback_relative_path: &str,
    dev_relative_path: &str,
    env_var_name: &str,
) -> Result<PathBuf> {
    if let Some(ref resource_dir) = resource_dir {
        let bundled_candidates = [
            resource_dir.join(Path::new(bundled_relative_path)),
            resource_dir.join(Path::new(bundled_fallback_relative_path)),
        ];

        for bundled_path in bundled_candidates {
            if bundled_path.exists() {
                return Ok(bundled_path);
            }
        }

        tracing::warn!(
            "[MCP] 未在资源目录找到 {} 可执行文件，已检查: '{}' 和 '{}'，回退到开发目录",
            bin_name,
            resource_dir.join(Path::new(bundled_relative_path)).display(),
            resource_dir
                .join(Path::new(bundled_fallback_relative_path))
                .display()
        );
    }

    if let Ok(path) = std::env::var(env_var_name) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            let override_path = PathBuf::from(trimmed);
            if override_path.exists() {
                return Ok(override_path);
            }

            tracing::warn!(
                "[MCP] {} 指向的文件不存在，继续回退: {}",
                env_var_name,
                override_path.display()
            );
        }
    }

    let dev_path = app_root.join(Path::new(dev_relative_path));
    if dev_path.exists() {
        return Ok(dev_path);
    }

    Err(AppError::ProcessError(format!(
        "无法定位 {}。已检查资源路径 '{}'、'{}' 与开发路径 '{}'",
        bin_name,
        resource_dir
            .as_ref()
            .map(|dir| dir.join(Path::new(bundled_relative_path)).display().to_string())
            .unwrap_or_else(|| "<无资源目录>".to_string()),
        resource_dir
            .as_ref()
            .map(|dir| dir.join(Path::new(bundled_fallback_relative_path)).display().to_string())
            .unwrap_or_else(|| "<无资源目录>".to_string()),
        dev_path.display()
    )))
}

fn write_json_atomically<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let temp_path = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(value)?;
    std::fs::write(&temp_path, format!("{}\n", content))?;
    std::fs::rename(&temp_path, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to create a platform-correct fixture file path.
    fn fixture_exe(base: &str) -> String {
        format!("{}{}", base, EXE_SUFFIX)
    }

    #[test]
    fn prefers_bundled_resource_path_when_present() {
        let temp_root = std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let app_root = temp_root.join("app-root");
        let resource_dir = temp_root.join("resources");

        std::fs::create_dir_all(app_root.join("src-tauri/target/debug")).unwrap();
        std::fs::create_dir_all(resource_dir.join("bin")).unwrap();
        std::fs::write(app_root.join(fixture_exe("src-tauri/target/debug/polaris-todo-mcp")), "dev bin").unwrap();
        std::fs::write(resource_dir.join(fixture_exe("bin/polaris-todo-mcp")), "bundled bin").unwrap();

        let path = resolve_mcp_executable_path(
            Some(resource_dir.clone()),
            app_root.clone(),
            TODO_MCP_BIN_NAME,
            &todo_bundle_path(),
            &todo_fallback_path(),
            &todo_dev_path(),
            "POLARIS_TODO_MCP_PATH",
        ).unwrap();
        assert_eq!(path, resource_dir.join(fixture_exe("bin/polaris-todo-mcp")));

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn prefers_root_level_bundled_path_when_present() {
        let temp_root = std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let app_root = temp_root.join("app-root");
        let resource_dir = temp_root.join("resources");

        std::fs::create_dir_all(app_root.join("src-tauri/target/debug")).unwrap();
        std::fs::create_dir_all(&resource_dir).unwrap();
        std::fs::write(app_root.join(fixture_exe("src-tauri/target/debug/polaris-todo-mcp")), "dev bin").unwrap();
        std::fs::write(resource_dir.join(fixture_exe("polaris-todo-mcp")), "bundled root bin").unwrap();

        let path = resolve_mcp_executable_path(
            Some(resource_dir.clone()),
            app_root.clone(),
            TODO_MCP_BIN_NAME,
            &todo_bundle_path(),
            &todo_fallback_path(),
            &todo_dev_path(),
            "POLARIS_TODO_MCP_PATH",
        ).unwrap();
        assert_eq!(path, resource_dir.join(fixture_exe("polaris-todo-mcp")));

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn falls_back_to_dev_path_when_resource_missing() {
        let temp_root = std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let app_root = temp_root.join("app-root");
        let resource_dir = temp_root.join("resources");

        std::fs::create_dir_all(app_root.join("src-tauri/target/debug")).unwrap();
        std::fs::create_dir_all(&resource_dir).unwrap();
        std::fs::write(app_root.join(fixture_exe("src-tauri/target/debug/polaris-todo-mcp")), "dev bin").unwrap();

        let path = resolve_mcp_executable_path(
            Some(resource_dir),
            app_root.clone(),
            TODO_MCP_BIN_NAME,
            &todo_bundle_path(),
            &todo_fallback_path(),
            &todo_dev_path(),
            "POLARIS_TODO_MCP_PATH",
        ).unwrap();
        assert_eq!(path, app_root.join(fixture_exe("src-tauri/target/debug/polaris-todo-mcp")));

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn prepares_workspace_scoped_mcp_config() {
        let temp_root = std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-a");
        let config_dir = temp_root.join("config");
        let todo_executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));
        let requirements_executable_path = temp_root.join(fixture_exe("bin/polaris-requirements-mcp"));
        let scheduler_executable_path = temp_root.join(fixture_exe("bin/polaris-scheduler-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(todo_executable_path.parent().unwrap()).unwrap();
        std::fs::write(&todo_executable_path, "todo bin").unwrap();
        std::fs::write(&requirements_executable_path, "requirements bin").unwrap();
        std::fs::write(&scheduler_executable_path, "scheduler bin").unwrap();

        let service = WorkspaceMcpConfigService::new(
            config_dir.clone(),
            todo_executable_path.clone(),
            Some(requirements_executable_path.clone()),
            Some(scheduler_executable_path.clone()),
        );
        let config_path = service.prepare_workspace_config(workspace.to_string_lossy().as_ref()).unwrap();

        assert_eq!(config_path, workspace.join(".polaris/claude/mcp.json"));

        let content = std::fs::read_to_string(&config_path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();

        // Todo MCP should have two args: config_dir and workspace_path
        let todo_server = &json["mcpServers"][TODO_MCP_SERVER_NAME];
        assert_eq!(
            todo_server["command"],
            serde_json::Value::String(todo_executable_path.to_string_lossy().to_string())
        );
        assert_eq!(
            todo_server["args"][0],
            serde_json::Value::String(config_dir.to_string_lossy().to_string())
        );
        assert_eq!(
            todo_server["args"][1],
            serde_json::Value::String(workspace.to_string_lossy().to_string())
        );

        // Requirements MCP should have two args: config_dir and workspace_path
        let requirements_server = &json["mcpServers"][REQUIREMENTS_MCP_SERVER_NAME];
        assert_eq!(
            requirements_server["command"],
            serde_json::Value::String(requirements_executable_path.to_string_lossy().to_string())
        );
        assert_eq!(
            requirements_server["args"][0],
            serde_json::Value::String(config_dir.to_string_lossy().to_string())
        );
        assert_eq!(
            requirements_server["args"][1],
            serde_json::Value::String(workspace.to_string_lossy().to_string())
        );

        // Scheduler MCP should have two args: config_dir and workspace_path
        let scheduler_server = &json["mcpServers"][SCHEDULER_MCP_SERVER_NAME];
        assert_eq!(
            scheduler_server["command"],
            serde_json::Value::String(scheduler_executable_path.to_string_lossy().to_string())
        );
        assert_eq!(
            scheduler_server["args"][0],
            serde_json::Value::String(config_dir.to_string_lossy().to_string())
        );
        assert_eq!(
            scheduler_server["args"][1],
            serde_json::Value::String(workspace.to_string_lossy().to_string())
        );

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn rewrites_existing_config_idempotently() {
        let temp_root = std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-b");
        let config_dir = temp_root.join("config");
        let executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(executable_path.parent().unwrap()).unwrap();
        std::fs::write(&executable_path, "bin").unwrap();

        let service = WorkspaceMcpConfigService::new(config_dir.clone(), executable_path.clone(), None, None);
        let first = service.prepare_workspace_config(workspace.to_string_lossy().as_ref()).unwrap();
        let first_content = std::fs::read_to_string(&first).unwrap();
        let second = service.prepare_workspace_config(workspace.to_string_lossy().as_ref()).unwrap();
        let second_content = std::fs::read_to_string(&second).unwrap();

        assert_eq!(first, second);
        assert_eq!(first_content, second_content);

        let _ = std::fs::remove_dir_all(&temp_root);
    }
}
