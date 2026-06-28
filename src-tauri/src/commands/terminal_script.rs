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
pub async fn terminal_discover_scripts(workspace_path: String) -> Result<Vec<DiscoveredTerminalScript>> {
    discover_scripts_in_workspace(Path::new(&workspace_path))
}

fn discover_scripts_in_workspace(workspace_path: &Path) -> Result<Vec<DiscoveredTerminalScript>> {
    if !workspace_path.exists() || !workspace_path.is_dir() {
        return Err(AppError::InvalidPath("工作区路径不存在或不是目录".to_string()));
    }

    let mut scripts = Vec::new();
    scripts.extend(discover_package_json_scripts(workspace_path)?);
    scripts.extend(discover_maven_scripts(workspace_path)?);
    scripts.extend(discover_gradle_scripts(workspace_path)?);
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
        .find_map(|(file, runner)| workspace_path.join(file).exists().then(|| (*runner).to_string()))
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

// ===== Maven / Gradle 发现（Spring Boot 优先） =====
//
// 检测 pom.xml / build.gradle[.kts]，识别 Spring Boot 项目并生成运行命令。
// wrapper（mvnw / gradlew）存在时优先使用，免依赖全局安装。
// 命令仅负责"如何运行"，不校验构建工具是否已安装——运行结果由终端反馈。

fn discover_maven_scripts(workspace_path: &Path) -> Result<Vec<DiscoveredTerminalScript>> {
    let pom_path = workspace_path.join("pom.xml");
    if !pom_path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&pom_path).unwrap_or_default();
    let runner = detect_maven_runner(workspace_path);
    let source_path = pom_path.to_string_lossy().to_string();
    let cwd = workspace_path.to_string_lossy().to_string();

    let mut entries: Vec<(&str, String, Vec<String>)> = Vec::new();
    // 仅 Spring Boot 项目生成 spring-boot:run
    if is_spring_boot_maven(&content) {
        entries.push((
            "spring-boot:run",
            format!("{} spring-boot:run", runner),
            vec!["maven".into(), "spring-boot".into(), "run".into()],
        ));
    }
    entries.push(("package", format!("{} clean package", runner), vec!["maven".into(), "build".into()]));
    entries.push(("test", format!("{} test", runner), vec!["maven".into(), "test".into()]));

    Ok(build_discovered("maven", entries, &cwd, &source_path))
}

fn discover_gradle_scripts(workspace_path: &Path) -> Result<Vec<DiscoveredTerminalScript>> {
    let groovy = workspace_path.join("build.gradle");
    let kotlin = workspace_path.join("build.gradle.kts");
    let build_file = if groovy.exists() {
        groovy
    } else if kotlin.exists() {
        kotlin
    } else {
        return Ok(Vec::new());
    };

    let content = std::fs::read_to_string(&build_file).unwrap_or_default();
    let runner = detect_gradle_runner(workspace_path);
    let source_path = build_file.to_string_lossy().to_string();
    let cwd = workspace_path.to_string_lossy().to_string();

    let mut entries: Vec<(&str, String, Vec<String>)> = Vec::new();
    if is_spring_boot_gradle(&content) {
        entries.push((
            "bootRun",
            format!("{} bootRun", runner),
            vec!["gradle".into(), "spring-boot".into(), "run".into()],
        ));
    }
    entries.push(("build", format!("{} build", runner), vec!["gradle".into(), "build".into()]));
    entries.push(("test", format!("{} test", runner), vec!["gradle".into(), "test".into()]));

    Ok(build_discovered("gradle", entries, &cwd, &source_path))
}

fn build_discovered(
    source: &str,
    entries: Vec<(&str, String, Vec<String>)>,
    cwd: &str,
    source_path: &str,
) -> Vec<DiscoveredTerminalScript> {
    entries
        .into_iter()
        .map(|(name, command, tags)| DiscoveredTerminalScript {
            id: format!("{}:{}", source, name),
            name: name.to_string(),
            command,
            cwd: cwd.to_string(),
            source: source.to_string(),
            source_path: source_path.to_string(),
            enabled: true,
            tags,
        })
        .collect()
}

fn is_spring_boot_maven(pom: &str) -> bool {
    pom.contains("spring-boot-starter-parent")
        || pom.contains("spring-boot-maven-plugin")
        || pom.contains("org.springframework.boot")
}

fn is_spring_boot_gradle(build: &str) -> bool {
    build.contains("org.springframework.boot") || build.contains("spring-boot-gradle-plugin")
}

/// Maven runner：存在 wrapper 时优先 wrapper，否则使用全局 `mvn`。
fn detect_maven_runner(workspace_path: &Path) -> String {
    if cfg!(windows) {
        if workspace_path.join("mvnw.cmd").exists() {
            return ".\\mvnw.cmd".to_string();
        }
    } else if workspace_path.join("mvnw").exists() {
        return "./mvnw".to_string();
    }
    "mvn".to_string()
}

/// Gradle runner：存在 wrapper 时优先 wrapper，否则使用全局 `gradle`。
fn detect_gradle_runner(workspace_path: &Path) -> String {
    if cfg!(windows) {
        if workspace_path.join("gradlew.bat").exists() {
            return ".\\gradlew.bat".to_string();
        }
    } else if workspace_path.join("gradlew").exists() {
        return "./gradlew".to_string();
    }
    "gradle".to_string()
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
        assert!(scripts.iter().any(|s| s.name == "tauri:dev" && s.command == "npm run tauri:dev"));
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

    #[test]
    fn discovers_spring_boot_maven_run() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path();
        std::fs::write(
            root.join("pom.xml"),
            r#"<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>"#,
        )
        .unwrap();

        let scripts = discover_scripts_in_workspace(root).unwrap();
        assert!(scripts
            .iter()
            .any(|s| s.name == "spring-boot:run" && s.command.contains("spring-boot:run") && s.source == "maven"));
        assert!(scripts.iter().any(|s| s.name == "package" && s.source == "maven"));
    }

    #[test]
    fn skips_spring_boot_run_for_plain_maven() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path();
        std::fs::write(root.join("pom.xml"), r#"<project></project>"#).unwrap();

        let scripts = discover_scripts_in_workspace(root).unwrap();
        assert!(!scripts.iter().any(|s| s.name == "spring-boot:run"));
        assert!(scripts.iter().any(|s| s.name == "package"));
    }

    #[test]
    fn discovers_spring_boot_gradle_boot_run() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path();
        std::fs::write(
            root.join("build.gradle"),
            "plugins { id 'org.springframework.boot' version '3.2.5' }",
        )
        .unwrap();

        let scripts = discover_scripts_in_workspace(root).unwrap();
        assert!(scripts
            .iter()
            .any(|s| s.name == "bootRun" && s.command.contains("bootRun") && s.source == "gradle"));
    }

    #[test]
    fn prefers_maven_wrapper_when_present() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path();
        std::fs::write(
            root.join("pom.xml"),
            r#"<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>"#,
        )
        .unwrap();
        let wrapper = if cfg!(windows) { "mvnw.cmd" } else { "mvnw" };
        std::fs::write(root.join(wrapper), "").unwrap();

        let scripts = discover_scripts_in_workspace(root).unwrap();
        let run = scripts.iter().find(|s| s.name == "spring-boot:run").unwrap();
        assert!(run.command.contains("mvnw"));
    }
}
