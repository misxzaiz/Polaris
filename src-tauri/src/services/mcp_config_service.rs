use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};

const MCP_CONFIG_RELATIVE_PATH: &str = ".polaris/claude/mcp.json";
const TODO_MCP_SERVER_NAME: &str = "polaris-todo";
const TODO_MCP_BIN_NAME: &str = "polaris-todo-mcp";
const REQUIREMENTS_MCP_SERVER_NAME: &str = "polaris-requirements";
const REQUIREMENTS_MCP_BIN_NAME: &str = "polaris-requirements-mcp";
const SCHEDULER_MCP_SERVER_NAME: &str = "polaris-scheduler";
const SCHEDULER_MCP_BIN_NAME: &str = "polaris-scheduler-mcp";
const KNOWLEDGE_MCP_SERVER_NAME: &str = "polaris-knowledge";
const KNOWLEDGE_MCP_BIN_NAME: &str = "polaris-knowledge-mcp";

/// Platform-aware executable suffix: ".exe" on Windows, "" on Linux/macOS.
const EXE_SUFFIX: &str = std::env::consts::EXE_SUFFIX;

/// Build a platform-correct relative path for an MCP binary.
fn mcp_exe_path(prefix: &str) -> String {
    format!("{}{}", prefix, EXE_SUFFIX)
}

#[cfg(test)]
fn todo_bundle_path() -> String {
    mcp_exe_path("bin/polaris-todo-mcp")
}
#[cfg(test)]
fn todo_fallback_path() -> String {
    mcp_exe_path("polaris-todo-mcp")
}
#[cfg(test)]
fn todo_dev_path() -> String {
    mcp_exe_path("src-tauri/target/debug/polaris-todo-mcp")
}

#[derive(Debug, Clone, Copy)]
struct BuiltinMcpServerDefinition {
    server_name: &'static str,
    bin_name: &'static str,
    bundled_path_prefix: &'static str,
    fallback_path_prefix: &'static str,
    dev_path_prefix: &'static str,
    env_var_name: &'static str,
    requires_config_dir: bool,
    required: bool,
}

const BUILTIN_MCP_SERVER_DEFINITIONS: &[BuiltinMcpServerDefinition] = &[
    BuiltinMcpServerDefinition {
        server_name: TODO_MCP_SERVER_NAME,
        bin_name: TODO_MCP_BIN_NAME,
        bundled_path_prefix: "bin/polaris-todo-mcp",
        fallback_path_prefix: "polaris-todo-mcp",
        dev_path_prefix: "src-tauri/target/debug/polaris-todo-mcp",
        env_var_name: "POLARIS_TODO_MCP_PATH",
        requires_config_dir: true,
        required: true,
    },
    BuiltinMcpServerDefinition {
        server_name: REQUIREMENTS_MCP_SERVER_NAME,
        bin_name: REQUIREMENTS_MCP_BIN_NAME,
        bundled_path_prefix: "bin/polaris-requirements-mcp",
        fallback_path_prefix: "polaris-requirements-mcp",
        dev_path_prefix: "src-tauri/target/debug/polaris-requirements-mcp",
        env_var_name: "POLARIS_REQUIREMENTS_MCP_PATH",
        requires_config_dir: true,
        required: false,
    },
    BuiltinMcpServerDefinition {
        server_name: SCHEDULER_MCP_SERVER_NAME,
        bin_name: SCHEDULER_MCP_BIN_NAME,
        bundled_path_prefix: "bin/polaris-scheduler-mcp",
        fallback_path_prefix: "polaris-scheduler-mcp",
        dev_path_prefix: "src-tauri/target/debug/polaris-scheduler-mcp",
        env_var_name: "POLARIS_SCHEDULER_MCP_PATH",
        requires_config_dir: true,
        required: false,
    },
    BuiltinMcpServerDefinition {
        server_name: KNOWLEDGE_MCP_SERVER_NAME,
        bin_name: KNOWLEDGE_MCP_BIN_NAME,
        bundled_path_prefix: "bin/polaris-knowledge-mcp",
        fallback_path_prefix: "polaris-knowledge-mcp",
        dev_path_prefix: "src-tauri/target/debug/polaris-knowledge-mcp",
        env_var_name: "POLARIS_KNOWLEDGE_MCP_PATH",
        requires_config_dir: true,
        required: false,
    },
];

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
    requires_config_dir: bool,
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
        knowledge_executable_path: Option<PathBuf>,
    ) -> Self {
        let mut binaries = vec![ResolvedMcpBinary {
            server_name: TODO_MCP_SERVER_NAME,
            executable_path: todo_executable_path,
            requires_config_dir: true,
        }];

        if let Some(path) = requirements_executable_path {
            binaries.push(ResolvedMcpBinary {
                server_name: REQUIREMENTS_MCP_SERVER_NAME,
                executable_path: path,
                requires_config_dir: true,
            });
        }

        if let Some(path) = scheduler_executable_path {
            binaries.push(ResolvedMcpBinary {
                server_name: SCHEDULER_MCP_SERVER_NAME,
                executable_path: path,
                requires_config_dir: true,
            });
        }

        if let Some(path) = knowledge_executable_path {
            binaries.push(ResolvedMcpBinary {
                server_name: KNOWLEDGE_MCP_SERVER_NAME,
                executable_path: path,
                requires_config_dir: true,
            });
        }

        Self {
            binaries,
            config_dir,
        }
    }

    pub fn executable_path(&self) -> &Path {
        &self.binaries[0].executable_path
    }

    pub fn from_app_paths(
        config_dir: PathBuf,
        resource_dir: Option<PathBuf>,
        app_root: PathBuf,
    ) -> Result<Self> {
        let mut binaries = Vec::new();

        for definition in BUILTIN_MCP_SERVER_DEFINITIONS {
            match resolve_builtin_mcp_binary(*definition, resource_dir.clone(), app_root.clone()) {
                Ok(binary) => binaries.push(binary),
                Err(error) if definition.required => return Err(error),
                Err(error) => {
                    tracing::warn!(
                        "[MCP] 璺宠繃鍙€?MCP server {}: {}",
                        definition.bin_name,
                        error.to_message()
                    );
                }
            }
        }

        Ok(Self {
            binaries,
            config_dir,
        })
    }

    pub fn prepare_workspace_config(&self, workspace_path: &str) -> Result<PathBuf> {
        self.prepare_workspace_config_with_disabled(workspace_path, &[])
    }

    pub fn prepare_workspace_config_with_disabled(
        &self,
        workspace_path: &str,
        disabled_server_names: &[String],
    ) -> Result<PathBuf> {
        let normalized_workspace = workspace_path.trim();
        if normalized_workspace.is_empty() {
            return Err(AppError::ValidationError(
                "workspace_path 不能为空".to_string(),
            ));
        }

        let workspace_dir = PathBuf::from(normalized_workspace);
        let config_path = workspace_dir.join(Path::new(MCP_CONFIG_RELATIVE_PATH));

        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::ProcessError(format!("创建 MCP 配置目录失败: {}", e)))?;
        }

        let mut servers = std::collections::BTreeMap::new();
        for binary in &self.binaries {
            if is_server_disabled(disabled_server_names, binary.server_name) {
                tracing::info!("[MCP] 跳过已禁用 MCP server: {}", binary.server_name);
                continue;
            }

            if !binary.executable_path.exists() {
                return Err(AppError::ProcessError(format!(
                    "{} 可执行文件不存在: {}",
                    binary.server_name,
                    binary.executable_path.display()
                )));
            }

            let args = if binary.requires_config_dir {
                vec![
                    strip_unc_prefix(&self.config_dir.to_string_lossy()),
                    normalized_workspace.to_string(),
                ]
            } else {
                vec![normalized_workspace.to_string()]
            };

            servers.insert(
                binary.server_name.to_string(),
                ClaudeMcpServerConfig {
                    command: strip_unc_prefix(&binary.executable_path.to_string_lossy()),
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

    pub fn prepare_workspace_codex_config_args(&self, workspace_path: &str) -> Result<Vec<String>> {
        self.prepare_workspace_codex_config_args_with_disabled(workspace_path, &[])
    }

    pub fn prepare_workspace_codex_config_args_with_disabled(
        &self,
        workspace_path: &str,
        disabled_server_names: &[String],
    ) -> Result<Vec<String>> {
        let normalized_workspace = workspace_path.trim();
        if normalized_workspace.is_empty() {
            return Err(AppError::ValidationError(
                "workspace_path 不能为空".to_string(),
            ));
        }

        let mut args = Vec::new();
        for binary in &self.binaries {
            if is_server_disabled(disabled_server_names, binary.server_name) {
                tracing::info!("[MCP] 跳过已禁用 Codex MCP server: {}", binary.server_name);
                continue;
            }

            if !binary.executable_path.exists() {
                return Err(AppError::ProcessError(format!(
                    "{} 可执行文件不存在: {}",
                    binary.server_name,
                    binary.executable_path.display()
                )));
            }

            let server_args = if binary.requires_config_dir {
                vec![
                    strip_unc_prefix(&self.config_dir.to_string_lossy()),
                    normalized_workspace.to_string(),
                ]
            } else {
                vec![normalized_workspace.to_string()]
            };

            args.push("-c".to_string());
            args.push(format!(
                "mcp_servers.{}.command={}",
                binary.server_name,
                toml_string(&strip_unc_prefix(&binary.executable_path.to_string_lossy()))?
            ));
            args.push("-c".to_string());
            args.push(format!(
                "mcp_servers.{}.args={}",
                binary.server_name,
                toml_string_array(&server_args)?
            ));
        }

        Ok(args)
    }
}

fn is_server_disabled(disabled_server_names: &[String], server_name: &str) -> bool {
    disabled_server_names.iter().any(|name| name == server_name)
}

/// Strip the Windows UNC extended-length path prefix (`\\?\`) from a path string.
///
/// On Windows, `std::fs::canonicalize()` and some Tauri path APIs return paths
/// with the `\\?\` prefix. While valid for Win32 APIs, this prefix can cause
/// issues with Node.js `child_process.spawn()` and some CLI tools. For paths
/// under MAX_PATH (260 chars), the prefix is unnecessary.
fn strip_unc_prefix(s: &str) -> String {
    if s.starts_with(r"\\?\") {
        s[4..].to_string()
    } else {
        s.to_string()
    }
}

fn resolve_builtin_mcp_binary(
    definition: BuiltinMcpServerDefinition,
    resource_dir: Option<PathBuf>,
    app_root: PathBuf,
) -> Result<ResolvedMcpBinary> {
    let executable_path = resolve_mcp_executable_path(
        resource_dir,
        app_root,
        definition.bin_name,
        &mcp_exe_path(definition.bundled_path_prefix),
        &mcp_exe_path(definition.fallback_path_prefix),
        &mcp_exe_path(definition.dev_path_prefix),
        definition.env_var_name,
    )?;

    Ok(ResolvedMcpBinary {
        server_name: definition.server_name,
        executable_path,
        requires_config_dir: definition.requires_config_dir,
    })
}

#[allow(dead_code)]
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
            tracing::warn!(
                "[MCP] 跳过可选 MCP server {}: {}",
                bin_name,
                error.to_message()
            );
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
            resource_dir
                .join(Path::new(bundled_relative_path))
                .display(),
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

    // Fallback: also check release directory (debug path may not exist if only release was built)
    let release_relative_path = dev_relative_path.replace("/debug/", "/release/");
    let release_path = app_root.join(Path::new(&release_relative_path));
    if release_path.exists() {
        tracing::info!(
            "[MCP] {} 在 debug 目录未找到，使用 release 目录: {}",
            bin_name,
            release_path.display()
        );
        return Ok(release_path);
    }

    Err(AppError::ProcessError(format!(
        "无法定位 {}。已检查资源路径 '{}'、'{}' 与开发路径 '{}'、'{}'",
        bin_name,
        resource_dir
            .as_ref()
            .map(|dir| dir
                .join(Path::new(bundled_relative_path))
                .display()
                .to_string())
            .unwrap_or_else(|| "<无资源目录>".to_string()),
        resource_dir
            .as_ref()
            .map(|dir| dir
                .join(Path::new(bundled_fallback_relative_path))
                .display()
                .to_string())
            .unwrap_or_else(|| "<无资源目录>".to_string()),
        dev_path.display(),
        release_path.display()
    )))
}

fn write_json_atomically<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let temp_path = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(value)?;
    std::fs::write(&temp_path, format!("{}\n", content))?;
    std::fs::rename(&temp_path, path)?;
    Ok(())
}

fn toml_string(value: &str) -> Result<String> {
    Ok(toml_string_literal(value))
}

fn toml_string_array(values: &[String]) -> Result<String> {
    Ok(format!(
        "[{}]",
        values
            .iter()
            .map(|value| toml_string_literal(value))
            .collect::<Vec<_>>()
            .join(",")
    ))
}

fn toml_string_literal(value: &str) -> String {
    if !value.contains('\'') && !value.contains('\n') && !value.contains('\r') {
        return format!("'{}'", value);
    }

    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            _ => escaped.push(ch),
        }
    }
    escaped.push('"');
    escaped
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
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let app_root = temp_root.join("app-root");
        let resource_dir = temp_root.join("resources");

        std::fs::create_dir_all(app_root.join("src-tauri/target/debug")).unwrap();
        std::fs::create_dir_all(resource_dir.join("bin")).unwrap();
        std::fs::write(
            app_root.join(fixture_exe("src-tauri/target/debug/polaris-todo-mcp")),
            "dev bin",
        )
        .unwrap();
        std::fs::write(
            resource_dir.join(fixture_exe("bin/polaris-todo-mcp")),
            "bundled bin",
        )
        .unwrap();

        let path = resolve_mcp_executable_path(
            Some(resource_dir.clone()),
            app_root.clone(),
            TODO_MCP_BIN_NAME,
            &todo_bundle_path(),
            &todo_fallback_path(),
            &todo_dev_path(),
            "POLARIS_TODO_MCP_PATH",
        )
        .unwrap();
        assert_eq!(path, resource_dir.join(fixture_exe("bin/polaris-todo-mcp")));

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn prefers_root_level_bundled_path_when_present() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let app_root = temp_root.join("app-root");
        let resource_dir = temp_root.join("resources");

        std::fs::create_dir_all(app_root.join("src-tauri/target/debug")).unwrap();
        std::fs::create_dir_all(&resource_dir).unwrap();
        std::fs::write(
            app_root.join(fixture_exe("src-tauri/target/debug/polaris-todo-mcp")),
            "dev bin",
        )
        .unwrap();
        std::fs::write(
            resource_dir.join(fixture_exe("polaris-todo-mcp")),
            "bundled root bin",
        )
        .unwrap();

        let path = resolve_mcp_executable_path(
            Some(resource_dir.clone()),
            app_root.clone(),
            TODO_MCP_BIN_NAME,
            &todo_bundle_path(),
            &todo_fallback_path(),
            &todo_dev_path(),
            "POLARIS_TODO_MCP_PATH",
        )
        .unwrap();
        assert_eq!(path, resource_dir.join(fixture_exe("polaris-todo-mcp")));

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn falls_back_to_dev_path_when_resource_missing() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let app_root = temp_root.join("app-root");
        let resource_dir = temp_root.join("resources");

        std::fs::create_dir_all(app_root.join("src-tauri/target/debug")).unwrap();
        std::fs::create_dir_all(&resource_dir).unwrap();
        std::fs::write(
            app_root.join(fixture_exe("src-tauri/target/debug/polaris-todo-mcp")),
            "dev bin",
        )
        .unwrap();

        let path = resolve_mcp_executable_path(
            Some(resource_dir),
            app_root.clone(),
            TODO_MCP_BIN_NAME,
            &todo_bundle_path(),
            &todo_fallback_path(),
            &todo_dev_path(),
            "POLARIS_TODO_MCP_PATH",
        )
        .unwrap();
        assert_eq!(
            path,
            app_root.join(fixture_exe("src-tauri/target/debug/polaris-todo-mcp"))
        );

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn falls_back_to_release_path_when_debug_missing() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let app_root = temp_root.join("app-root");
        let resource_dir = temp_root.join("resources");

        // Only create release binary, no debug binary
        std::fs::create_dir_all(app_root.join("src-tauri/target/release")).unwrap();
        std::fs::create_dir_all(&resource_dir).unwrap();
        std::fs::write(
            app_root.join(fixture_exe("src-tauri/target/release/polaris-todo-mcp")),
            "release bin",
        )
        .unwrap();

        let path = resolve_mcp_executable_path(
            Some(resource_dir),
            app_root.clone(),
            TODO_MCP_BIN_NAME,
            &todo_bundle_path(),
            &todo_fallback_path(),
            &todo_dev_path(),
            "POLARIS_TODO_MCP_PATH",
        )
        .unwrap();
        assert_eq!(
            path,
            app_root.join(fixture_exe("src-tauri/target/release/polaris-todo-mcp"))
        );

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn prepares_workspace_scoped_mcp_config() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-a");
        let config_dir = temp_root.join("config");
        let todo_executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));
        let requirements_executable_path =
            temp_root.join(fixture_exe("bin/polaris-requirements-mcp"));
        let scheduler_executable_path = temp_root.join(fixture_exe("bin/polaris-scheduler-mcp"));
        let knowledge_executable_path = temp_root.join(fixture_exe("bin/polaris-knowledge-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(todo_executable_path.parent().unwrap()).unwrap();
        std::fs::write(&todo_executable_path, "todo bin").unwrap();
        std::fs::write(&requirements_executable_path, "requirements bin").unwrap();
        std::fs::write(&scheduler_executable_path, "scheduler bin").unwrap();
        std::fs::write(&knowledge_executable_path, "knowledge bin").unwrap();

        let service = WorkspaceMcpConfigService::new(
            config_dir.clone(),
            todo_executable_path.clone(),
            Some(requirements_executable_path.clone()),
            Some(scheduler_executable_path.clone()),
            Some(knowledge_executable_path.clone()),
        );
        let config_path = service
            .prepare_workspace_config(workspace.to_string_lossy().as_ref())
            .unwrap();

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
    fn prepares_workspace_codex_config_args() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-c");
        let config_dir = temp_root.join("config");
        let todo_executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));
        let requirements_executable_path =
            temp_root.join(fixture_exe("bin/polaris-requirements-mcp"));
        let scheduler_executable_path = temp_root.join(fixture_exe("bin/polaris-scheduler-mcp"));
        let knowledge_executable_path = temp_root.join(fixture_exe("bin/polaris-knowledge-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(todo_executable_path.parent().unwrap()).unwrap();
        std::fs::write(&todo_executable_path, "todo bin").unwrap();
        std::fs::write(&requirements_executable_path, "requirements bin").unwrap();
        std::fs::write(&scheduler_executable_path, "scheduler bin").unwrap();
        std::fs::write(&knowledge_executable_path, "knowledge bin").unwrap();

        let service = WorkspaceMcpConfigService::new(
            config_dir.clone(),
            todo_executable_path.clone(),
            Some(requirements_executable_path.clone()),
            Some(scheduler_executable_path.clone()),
            Some(knowledge_executable_path.clone()),
        );

        let args = service
            .prepare_workspace_codex_config_args(workspace.to_string_lossy().as_ref())
            .unwrap();

        assert_eq!(args.len(), 16);
        assert_eq!(args.iter().filter(|arg| arg.as_str() == "-c").count(), 8);

        let joined = args.join("\n");
        assert!(joined.contains("mcp_servers.polaris-todo.command="));
        assert!(joined.contains("mcp_servers.polaris-requirements.command="));
        assert!(joined.contains("mcp_servers.polaris-scheduler.command="));
        assert!(joined.contains("mcp_servers.polaris-knowledge.command="));
        assert!(joined.contains("mcp_servers.polaris-todo.args=["));

        let expected_config_dir = toml_string_literal(config_dir.to_string_lossy().as_ref());
        let expected_workspace = toml_string_literal(workspace.to_string_lossy().as_ref());
        let expected_todo_command =
            toml_string_literal(todo_executable_path.to_string_lossy().as_ref());
        let expected_args = format!("[{},{}]", expected_config_dir, expected_workspace);

        assert!(joined.contains(&format!(
            "mcp_servers.polaris-todo.command={}",
            expected_todo_command
        )));
        assert!(joined.contains(&format!("mcp_servers.polaris-todo.args={}", expected_args)));
        assert!(
            !joined.contains("\\\""),
            "Codex -c values must be TOML, not JSON-escaped strings"
        );

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn codex_toml_literals_handle_windows_paths_and_quotes() {
        assert_eq!(
            toml_string_literal(r"D:\app\polaris\polaris-todo-mcp.exe"),
            r"'D:\app\polaris\polaris-todo-mcp.exe'"
        );
        assert_eq!(
            toml_string_array(&[
                r"C:\Users\28409\AppData\Roaming\com.polaris.app".to_string(),
                r"D:\space\base\Polaris".to_string(),
            ])
            .unwrap(),
            r"['C:\Users\28409\AppData\Roaming\com.polaris.app','D:\space\base\Polaris']"
        );
        assert_eq!(
            toml_string_literal(r"D:\space\team's project"),
            r#""D:\\space\\team's project""#
        );
    }

    #[test]
    fn rewrites_existing_config_idempotently() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-b");
        let config_dir = temp_root.join("config");
        let executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(executable_path.parent().unwrap()).unwrap();
        std::fs::write(&executable_path, "bin").unwrap();

        let service = WorkspaceMcpConfigService::new(
            config_dir.clone(),
            executable_path.clone(),
            None,
            None,
            None,
        );
        let first = service
            .prepare_workspace_config(workspace.to_string_lossy().as_ref())
            .unwrap();
        let first_content = std::fs::read_to_string(&first).unwrap();
        let second = service
            .prepare_workspace_config(workspace.to_string_lossy().as_ref())
            .unwrap();
        let second_content = std::fs::read_to_string(&second).unwrap();

        assert_eq!(first, second);
        assert_eq!(first_content, second_content);

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn prepare_workspace_config_skips_disabled_servers() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-disabled");
        let config_dir = temp_root.join("config");
        let todo_executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(todo_executable_path.parent().unwrap()).unwrap();
        std::fs::write(&todo_executable_path, "todo bin").unwrap();

        let service =
            WorkspaceMcpConfigService::new(config_dir, todo_executable_path, None, None, None);

        let config_path = service
            .prepare_workspace_config_with_disabled(
                workspace.to_string_lossy().as_ref(),
                &[TODO_MCP_SERVER_NAME.to_string()],
            )
            .unwrap();

        let content = std::fs::read_to_string(&config_path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(json["mcpServers"].as_object().unwrap().len(), 0);

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn prepare_workspace_codex_config_args_skips_disabled_servers() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-disabled-codex");
        let config_dir = temp_root.join("config");
        let todo_executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(todo_executable_path.parent().unwrap()).unwrap();
        std::fs::write(&todo_executable_path, "todo bin").unwrap();

        let service =
            WorkspaceMcpConfigService::new(config_dir, todo_executable_path, None, None, None);

        let args = service
            .prepare_workspace_codex_config_args_with_disabled(
                workspace.to_string_lossy().as_ref(),
                &[TODO_MCP_SERVER_NAME.to_string()],
            )
            .unwrap();

        assert!(args.is_empty());

        let _ = std::fs::remove_dir_all(&temp_root);
    }
}
