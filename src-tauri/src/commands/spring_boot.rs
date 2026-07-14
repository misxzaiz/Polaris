/*! Spring Boot 调试运行模块
 *
 * 提供 Spring Boot 项目的检测、启动、停止、状态查询等功能
 */

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
#[cfg(feature = "tauri-app")]
use tauri::{AppHandle, State};

use crate::error::{AppError, Result};
use crate::AppState;

/// 项目构建工具类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum BuildTool {
    Maven,
    Gradle,
}

/// Spring Boot 项目信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringBootProject {
    /// 项目路径
    pub path: String,
    /// 项目名称
    pub name: String,
    /// 构建工具
    pub build_tool: BuildTool,
    /// Spring Boot 版本
    pub spring_boot_version: Option<String>,
    /// Java 版本
    pub java_version: Option<String>,
    /// 主类名
    pub main_class: Option<String>,
    /// 是否包含 devtools 依赖
    pub has_devtools: bool,
    /// 配置的端口
    pub port: Option<u16>,
}

/// 应用运行状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AppStatus {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

/// Spring Boot 应用运行信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringBootApp {
    /// 应用 ID
    pub id: String,
    /// 终端会话 ID (用于查看日志)
    pub session_id: Option<String>,
    /// 项目信息
    pub project: SpringBootProject,
    /// 运行状态
    pub status: AppStatus,
    /// 进程 ID
    pub pid: Option<u32>,
    /// 监听端口
    pub port: Option<u16>,
    /// 启动时间
    pub started_at: Option<String>,
    /// 错误信息
    pub error: Option<String>,
    /// 是否启用调试模式
    pub debug_enabled: bool,
    /// 调试端口
    pub debug_port: Option<u16>,
}

/// 启动配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartConfig {
    /// 项目路径
    pub project_path: String,
    /// 是否启用调试模式
    pub debug: Option<bool>,
    /// 调试端口 (默认 5005)
    pub debug_port: Option<u16>,
    /// 应用端口 (覆盖配置)
    pub app_port: Option<u16>,
    /// 额外的 JVM 参数
    pub jvm_args: Option<Vec<String>>,
    /// 额外的 Maven/Gradle 参数
    pub build_args: Option<Vec<String>>,
    /// 环境变量
    pub env: Option<HashMap<String, String>>,
}

/// 运行管理器
pub struct SpringBootManager {
    /// 运行中的应用
    apps: Mutex<HashMap<String, SpringBootApp>>,
    /// 终端会话 ID 映射
    session_map: Mutex<HashMap<String, String>>,
}

impl Default for SpringBootManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SpringBootManager {
    pub fn new() -> Self {
        Self {
            apps: Mutex::new(HashMap::new()),
            session_map: Mutex::new(HashMap::new()),
        }
    }

    /// 获取所有运行中的应用
    pub fn list_apps(&self) -> Result<Vec<SpringBootApp>> {
        let apps = self.apps.lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;
        Ok(apps.values().cloned().collect())
    }

    /// 获取单个应用
    pub fn get_app(&self, id: &str) -> Result<SpringBootApp> {
        let apps = self.apps.lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;
        apps.get(id)
            .cloned()
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))
    }

    /// 更新应用状态
    pub fn update_app(&self, app: SpringBootApp) -> Result<()> {
        let mut apps = self.apps.lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;
        apps.insert(app.id.clone(), app);
        Ok(())
    }

    /// 移除应用
    pub fn remove_app(&self, id: &str) -> Result<()> {
        let mut apps = self.apps.lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;
        apps.remove(id);
        
        let mut session_map = self.session_map.lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;
        session_map.remove(id);
        
        Ok(())
    }

    /// 获取终端会话 ID
    pub fn get_session_id(&self, app_id: &str) -> Result<Option<String>> {
        let session_map = self.session_map.lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;
        Ok(session_map.get(app_id).cloned())
    }

    /// 设置终端会话 ID
    pub fn set_session_id(&self, app_id: &str, session_id: &str) -> Result<()> {
        let mut session_map = self.session_map.lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;
        session_map.insert(app_id.to_string(), session_id.to_string());
        Ok(())
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// 检测 Spring Boot 项目
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn spring_boot_detect_project(path: String) -> Result<SpringBootProject> {
    let project_path = PathBuf::from(&path);
    
    if !project_path.exists() {
        return Err(AppError::ValidationError(format!("路径不存在: {}", path)));
    }

    // 检测构建工具
    let (build_tool, config_file) = if project_path.join("pom.xml").exists() {
        (BuildTool::Maven, "pom.xml")
    } else if project_path.join("build.gradle").exists() || project_path.join("build.gradle.kts").exists() {
        let file = if project_path.join("build.gradle.kts").exists() {
            "build.gradle.kts"
        } else {
            "build.gradle"
        };
        (BuildTool::Gradle, file)
    } else {
        return Err(AppError::ValidationError("未找到 Maven 或 Gradle 配置文件".to_string()));
    };

    // 读取配置文件内容
    let config_content = std::fs::read_to_string(project_path.join(config_file))
        .map_err(|e| AppError::IoError(e))?;

    // 提取项目名称
    let name = project_path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("spring-boot-app")
        .to_string();

    // 提取 Spring Boot 版本
    let spring_boot_version = extract_spring_boot_version(&config_content, &build_tool);

    // 提取 Java 版本
    let java_version = extract_java_version(&config_content, &build_tool);

    // 提取主类
    let main_class = find_main_class(&project_path);

    // 检测 devtools
    let has_devtools = config_content.contains("spring-boot-devtools");

    // 提取端口配置
    let port = extract_port(&project_path);

    Ok(SpringBootProject {
        path,
        name,
        build_tool,
        spring_boot_version,
        java_version,
        main_class,
        has_devtools,
        port,
    })
}

/// 启动 Spring Boot 应用
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn spring_boot_start(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    config: StartConfig,
) -> Result<SpringBootApp> {
    // 检测项目
    let project = spring_boot_detect_project(config.project_path.clone())?;
    
    let app_id = uuid::Uuid::new_v4().to_string();
    let port = config.app_port.unwrap_or(project.port.unwrap_or(8080));
    let debug_port = config.debug_port.unwrap_or(5005);
    let debug = config.debug.unwrap_or(false);

    // 构建启动命令
    let (command, jvm_env_args) = build_start_command(&project, &config, debug, debug_port, port);
    
    // 创建终端会话
    let terminal_manager = state.terminal_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;
    
    let mut env = config.env.unwrap_or_default();
    env.insert("SPRING_BOOT_APP_ID".to_string(), app_id.clone());
    
    // Windows: 通过环境变量传递 JVM 参数
    if let Some(jvm_args) = jvm_env_args {
        env.insert("MAVEN_OPTS".to_string(), jvm_args.clone());
        // Gradle 也使用 GRADLE_OPTS 或 JAVA_OPTS
        env.insert("JAVA_OPTS".to_string(), jvm_args);
    }
    
    let session = terminal_manager.create_session(
        crate::commands::terminal::TerminalEventSink::Tauri(app_handle),
        Some(format!("Spring Boot: {}", project.name)),
        Some(project.path.clone()),
        120,
        30,
        Some(command),
        Some(env),
        Some("spring-boot".to_string()),
        None,
    )?;
    
    drop(terminal_manager);

    // 记录应用信息
    let app_info = SpringBootApp {
        id: app_id.clone(),
        session_id: Some(session.id.clone()),
        project,
        status: AppStatus::Starting,
        pid: None,
        port: Some(port),
        started_at: Some(chrono::Local::now().to_rfc3339()),
        error: None,
        debug_enabled: debug,
        debug_port: if debug { Some(debug_port) } else { None },
    };

    let manager = state.spring_boot_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;
    
    manager.update_app(app_info.clone())?;
    manager.set_session_id(&app_id, &session.id)?;

    Ok(app_info)
}

/// 停止 Spring Boot 应用
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn spring_boot_stop(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<()> {
    let manager = state.spring_boot_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;
    
    let session_id = manager.get_session_id(&app_id)?
        .ok_or_else(|| AppError::SessionNotFound(format!("未找到应用: {}", app_id)))?;
    
    let mut app = manager.get_app(&app_id)?;
    app.status = AppStatus::Stopping;
    manager.update_app(app)?;
    
    drop(manager);

    // 关闭终端会话
    let terminal_manager = state.terminal_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;
    
    terminal_manager.close_session(&session_id)?;
    
    drop(terminal_manager);

    // 更新状态
    let manager = state.spring_boot_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;
    
    let mut app = manager.get_app(&app_id)?;
    app.status = AppStatus::Stopped;
    manager.update_app(app)?;
    manager.remove_app(&app_id)?;

    Ok(())
}

/// 获取所有 Spring Boot 应用状态
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn spring_boot_list_apps(
    state: State<'_, AppState>,
) -> Result<Vec<SpringBootApp>> {
    let manager = state.spring_boot_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;
    manager.list_apps()
}

/// 获取单个应用状态
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn spring_boot_get_app(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<SpringBootApp> {
    let manager = state.spring_boot_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;
    manager.get_app(&app_id)
}

/// 更新应用状态（内部使用，用于终端退出事件回调）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn spring_boot_update_status(
    state: State<'_, AppState>,
    app_id: String,
    status: AppStatus,
    error: Option<String>,
) -> Result<()> {
    let manager = state.spring_boot_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;
    
    let mut app = manager.get_app(&app_id)?;
    app.status = status;
    app.error = error;
    manager.update_app(app)
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 构建启动命令
fn build_start_command(
    project: &SpringBootProject,
    config: &StartConfig,
    debug: bool,
    debug_port: u16,
    app_port: u16,
) -> (String, Option<String>) {
    // 返回 (命令, 额外的环境变量JVM参数)
    let mut parts = Vec::new();
    let mut env_jvm_args: Option<String> = None;
    
    // Windows 和 Unix 使用不同的命令
    let is_windows = cfg!(windows);
    
    // 构建 JVM 参数
    let mut jvm_args = Vec::new();
    if debug {
        jvm_args.push(format!(
            "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address={}",
            debug_port
        ));
    }
    if let Some(extra) = &config.jvm_args {
        jvm_args.extend(extra.clone());
    }
    
    // Windows 上使用环境变量传递 JVM 参数更可靠
    if is_windows && !jvm_args.is_empty() {
        env_jvm_args = Some(jvm_args.join(" "));
    }
    
    match project.build_tool {
        BuildTool::Maven => {
            if is_windows {
                parts.push("mvnw.cmd".to_string());
            } else {
                parts.push("./mvnw".to_string());
            }
            parts.push("spring-boot:run".to_string());
            
            // JVM 参数 (仅在非Windows时直接传递)
            if !is_windows && !jvm_args.is_empty() {
                parts.push(format!("-Dspring-boot.run.jvmArguments={}", jvm_args.join(" ")));
            }
            
            // 应用端口
            parts.push(format!("-Dserver.port={}", app_port));
            
            // 额外的 Maven 参数
            if let Some(extra) = &config.build_args {
                parts.extend(extra.clone());
            }
        }
        BuildTool::Gradle => {
            if is_windows {
                parts.push("gradlew.bat".to_string());
            } else {
                parts.push("./gradlew".to_string());
            }
            parts.push("bootRun".to_string());
            
            // JVM 参数 (仅在非Windows时直接传递)
            if !is_windows && !jvm_args.is_empty() {
                parts.push(format!("--args={}", jvm_args.join(" ")));
            }
            
            // 应用端口
            parts.push(format!("-Dserver.port={}", app_port));
            
            // 额外的 Gradle 参数
            if let Some(extra) = &config.build_args {
                parts.extend(extra.clone());
            }
        }
    }
    
    (parts.join(" "), env_jvm_args)
}

/// 从 Maven pom.xml 提取 Spring Boot 版本
fn extract_spring_boot_version(content: &str, build_tool: &BuildTool) -> Option<String> {
    match build_tool {
        BuildTool::Maven => {
            // 查找 spring-boot-starter-parent 版本
            if let Some(start) = content.find("spring-boot-starter-parent") {
                if let Some(version_start) = content[start..].find("<version>") {
                    let version_str = &content[start + version_start..];
                    if let Some(end) = version_str.find("</version>") {
                        return Some(version_str[8..end].to_string());
                    }
                }
            }
            // 查找 spring-boot.version 属性
            if let Some(start) = content.find("spring-boot.version") {
                if let Some(version_start) = content[start..].find('<') {
                    let version_str = &content[start + version_start..];
                    if let Some(end) = version_str.find("</") {
                        return Some(version_str[1..end].to_string());
                    }
                }
            }
        }
        BuildTool::Gradle => {
            // 查找 spring-boot 版本
            if let Some(start) = content.find("spring-boot") {
                if let Some(version_start) = content[start..].find("version") {
                    let version_str = &content[start + version_start..];
                    if let Some(eq) = version_str.find('=') {
                        let version_str = &version_str[eq + 1..];
                        if let Some(end) = version_str.find(|c: char| c == '\'' || c == '"') {
                            return Some(version_str[..end].trim().to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

/// 提取 Java 版本
fn extract_java_version(content: &str, build_tool: &BuildTool) -> Option<String> {
    match build_tool {
        BuildTool::Maven => {
            // 查找 java.version 属性
            if let Some(start) = content.find("java.version") {
                if let Some(tag_start) = content[start..].find('>') {
                    let version_str = &content[start + tag_start..];
                    if let Some(end) = version_str.find("</") {
                        return Some(version_str[1..end].trim().to_string());
                    }
                }
            }
            // 查找 maven.compiler.source
            if let Some(start) = content.find("maven.compiler.source") {
                if let Some(tag_start) = content[start..].find('>') {
                    let version_str = &content[start + tag_start..];
                    if let Some(end) = version_str.find("</") {
                        return Some(version_str[1..end].trim().to_string());
                    }
                }
            }
        }
        BuildTool::Gradle => {
            // 查找 sourceCompatibility
            if let Some(start) = content.find("sourceCompatibility") {
                if let Some(eq) = content[start..].find('=') {
                    let version_str = &content[start + eq + 1..];
                    if let Some(end) = version_str.find(|c: char| c == '\n' || c == '\r') {
                        return Some(version_str[..end].trim().to_string());
                    }
                }
            }
        }
    }
    None
}

/// 查找主类
fn find_main_class(project_path: &PathBuf) -> Option<String> {
    let src_main = project_path.join("src").join("main").join("java");
    if !src_main.exists() {
        return None;
    }

    // 递归查找包含 @SpringBootApplication 注解的类
    find_spring_boot_application_class(&src_main)
}

fn find_spring_boot_application_class(dir: &PathBuf) -> Option<String> {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(class) = find_spring_boot_application_class(&path) {
                    return Some(class);
                }
            } else if path.extension().and_then(|e| e.to_str()) == Some("java") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if content.contains("@SpringBootApplication") {
                        // 提取类名
                        let file_name = path.file_stem()?.to_str()?;
                        // 尝试从 package 声明和类名构建完整类名
                        if let Some(package) = extract_package(&content) {
                            return Some(format!("{}.{}", package, file_name));
                        }
                        return Some(file_name.to_string());
                    }
                }
            }
        }
    }
    None
}

fn extract_package(content: &str) -> Option<String> {
    if let Some(start) = content.find("package ") {
        let package_str = &content[start + 8..];
        if let Some(end) = package_str.find(';') {
            return Some(package_str[..end].trim().to_string());
        }
    }
    None
}

/// 提取配置的端口
fn extract_port(project_path: &PathBuf) -> Option<u16> {
    // 检查 application.properties
    let props_path = project_path.join("src")
        .join("main")
        .join("resources")
        .join("application.properties");
    if let Ok(content) = std::fs::read_to_string(&props_path) {
        if let Some(port) = extract_port_from_props(&content) {
            return Some(port);
        }
    }

    // 检查 application.yml
    let yml_path = project_path.join("src")
        .join("main")
        .join("resources")
        .join("application.yml");
    if let Ok(content) = std::fs::read_to_string(&yml_path) {
        if let Some(port) = extract_port_from_yml(&content) {
            return Some(port);
        }
    }

    None
}

fn extract_port_from_props(content: &str) -> Option<u16> {
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("server.port=") {
            if let Ok(port) = line[11..].trim().parse::<u16>() {
                return Some(port);
            }
        }
    }
    None
}

fn extract_port_from_yml(content: &str) -> Option<u16> {
    let lines: Vec<&str> = content.lines().collect();
    let mut in_server = false;
    let mut indent_level = 0;

    for line in &lines {
        let trimmed = line.trim();
        
        if trimmed.starts_with("server:") {
            in_server = true;
            indent_level = line.len() - line.trim_start().len();
            continue;
        }

        if in_server {
            let current_indent = line.len() - line.trim_start().len();
            if current_indent <= indent_level && !trimmed.is_empty() {
                in_server = false;
                continue;
            }

            if trimmed.starts_with("port:") {
                if let Some(port_str) = trimmed.strip_prefix("port:") {
                    if let Ok(port) = port_str.trim().parse::<u16>() {
                        return Some(port);
                    }
                }
            }
        }
    }
    None
}

/// 检查端口是否被占用
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn spring_boot_check_port(port: u16) -> Result<bool> {
    use std::net::TcpListener;
    
    match TcpListener::bind(format!("127.0.0.1:{}", port)) {
        Ok(_) => Ok(false), // 端口可用
        Err(_) => Ok(true), // 端口被占用
    }
}

/// 获取可用端口
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn spring_boot_find_available_port(start: Option<u16>) -> Result<u16> {
    use std::net::TcpListener;
    
    let start_port = start.unwrap_or(8080);
    
    for port in start_port..65535 {
        if TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok() {
            return Ok(port);
        }
    }
    
    Err(AppError::ProcessError("未找到可用端口".to_string()))
}
