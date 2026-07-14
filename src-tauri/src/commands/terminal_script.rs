//! 终端脚本发现命令

use std::path::Path;

use crate::error::{AppError, Result};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredTerminalScript {
    pub id: String,
    pub name: String,
    pub command: String,
    pub cwd: String,
    pub source: String,
    pub source_path: String,
    pub enabled: bool,
    pub tags: Vec<String>,
}

/// 发现工作区可运行脚本。首期支持 package.json scripts。
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn terminal_discover_scripts(
    workspace_path: String,
) -> Result<Vec<DiscoveredTerminalScript>> {
    discover_scripts_in_workspace(Path::new(&workspace_path))
}

fn discover_scripts_in_workspace(workspace_path: &Path) -> Result<Vec<DiscoveredTerminalScript>> {
    if !workspace_path.exists() || !workspace_path.is_dir() {
        return Err(AppError::InvalidPath(
            "工作区路径不存在或不是目录".to_string(),
        ));
    }

    let mut scripts = Vec::new();
    scripts.extend(discover_package_json_scripts(workspace_path)?);
    scripts.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(scripts)
}

fn discover_package_json_scripts(workspace_path: &Path) -> Result<Vec<DiscoveredTerminalScript>> {
    let package_json_path = workspace_path.join("package.json");
    if !package_json_path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&package_json_path)?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| AppError::ParseError(format!("package.json 解析失败: {}", e)))?;

    let Some(scripts) = value.get("scripts").and_then(|v| v.as_object()) else {
        return Ok(Vec::new());
    };

    let runner = detect_node_runner(workspace_path);
    let source_path = package_json_path.to_string_lossy().to_string();
    let cwd = workspace_path.to_string_lossy().to_string();

    Ok(scripts
        .iter()
        .filter_map(|(name, command_value)| {
            command_value.as_str()?;
            Some(DiscoveredTerminalScript {
                id: format!("package-json:{}", name),
                name: name.clone(),
                command: format_node_script_command(&runner, name),
                cwd: cwd.clone(),
                source: "package.json".to_string(),
                source_path: source_path.clone(),
                enabled: true,
                tags: vec!["package.json".to_string(), runner.clone()],
            })
        })
        .collect())
}

fn detect_node_runner(workspace_path: &Path) -> String {
    let candidates: [(&str, &str); 4] = [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lockb", "bun"),
        ("package-lock.json", "npm"),
    ];

    candidates
        .iter()
        .find_map(|(file, runner)| {
            workspace_path
                .join(file)
                .exists()
                .then(|| (*runner).to_string())
        })
        .unwrap_or_else(|| "npm".to_string())
}

fn format_node_script_command(runner: &str, script_name: &str) -> String {
    match runner {
        "yarn" => format!("yarn {}", script_name),
        "bun" => format!("bun run {}", script_name),
        "pnpm" => format!("pnpm run {}", script_name),
        _ => format!("npm run {}", script_name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_package_json_scripts_with_npm_lock() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path();
        std::fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"vite","tauri:dev":"tauri dev","test:run":"vitest run"}}"#,
        )
        .unwrap();
        std::fs::write(root.join("package-lock.json"), "{}").unwrap();

        let scripts = discover_scripts_in_workspace(root).unwrap();

        assert_eq!(scripts.len(), 3);
        assert!(scripts
            .iter()
            .any(|s| s.name == "tauri:dev" && s.command == "npm run tauri:dev"));
    }

    #[test]
    fn prefers_pnpm_when_lockfile_exists() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path().to_path_buf();
        std::fs::write(root.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        std::fs::write(root.join("pnpm-lock.yaml"), "").unwrap();

        let scripts = discover_scripts_in_workspace(&root).unwrap();

        assert_eq!(scripts[0].command, "pnpm run dev");
    }
}
