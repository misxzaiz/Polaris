//! Protocol Task Service
//!
//! Manages creation, reading, backup, and cleanup of protocol task documents.
//! Protocol mode uses a document-driven workflow with persistent memory.

use std::fs;
use std::io;
use std::path::PathBuf;
use chrono::Local;

/// Task directory name format: YYYYMMDDHHMMSS
const TIMESTAMP_FORMAT: &str = "%Y%m%d%H%M%S";

/// Default line threshold for document backup
const BACKUP_LINE_THRESHOLD: usize = 800;

/// Protocol Task Service
///
/// Handles all file operations related to protocol mode tasks:
/// - Creating task directory structures
/// - Reading/writing protocol documents
/// - Managing user supplements
/// - Maintaining memory files
/// - Backing up and cleaning up documents
pub struct ProtocolTaskService;

impl ProtocolTaskService {
    // =========================================================================
    // Timestamp and Path Utilities
    // =========================================================================

    /// Generate current timestamp string
    pub fn generate_timestamp() -> String {
        Local::now().format(TIMESTAMP_FORMAT).to_string()
    }

    /// Generate task path from timestamp
    pub fn generate_task_path_from_timestamp(timestamp: &str) -> String {
        format!(".polaris/tasks/{}", timestamp)
    }

    /// Generate task path using current timestamp
    pub fn generate_task_path() -> String {
        let timestamp = Self::generate_timestamp();
        Self::generate_task_path_from_timestamp(&timestamp)
    }

    /// Extract timestamp from task path
    pub fn extract_timestamp(task_path: &str) -> Option<String> {
        let parts: Vec<&str> = task_path.split('/').collect();
        parts.last().map(|s| s.to_string())
    }

    // =========================================================================
    // Task Structure Creation
    // =========================================================================

    /// Create protocol task directory structure
    ///
    /// Creates the following structure:
    /// ```text
    /// .polaris/tasks/{timestamp}/
    /// ├── protocol.md           # Main protocol document
    /// ├── supplement.md         # User supplements
    /// └── memory/
    ///     ├── index.md          # Progress index
    ///     └── tasks.md          # Task queue
    ///
    /// .oprcli/tasks/{timestamp}/
    /// └── supplement-history/   # Supplement backup directory
    /// ```
    ///
    /// # Arguments
    /// * `work_dir` - Working directory root
    /// * `task_id` - Task unique identifier
    /// * `mission` - Task mission/goal description
    /// * `template_content` - Optional template content for protocol document
    ///
    /// # Returns
    /// The relative task path (e.g., `.polaris/tasks/20260403011008`)
    pub fn create_task_structure(
        work_dir: &str,
        task_id: &str,
        mission: &str,
        template_content: Option<&str>,
    ) -> io::Result<String> {
        // Generate single timestamp for consistent paths
        let timestamp = Self::generate_timestamp();
        let task_path = Self::generate_task_path_from_timestamp(&timestamp);
        let task_full_path = PathBuf::from(work_dir).join(&task_path);

        // Create main directory structure
        fs::create_dir_all(task_full_path.join("memory"))?;

        // Create backup directory
        let backup_dir = PathBuf::from(work_dir)
            .join(".oprcli/tasks")
            .join(&timestamp)
            .join("supplement-history");
        fs::create_dir_all(&backup_dir)?;

        // Generate and write protocol document
        let protocol_content = template_content
            .map(|t| Self::render_protocol_from_template(task_id, mission, work_dir, &timestamp, t))
            .unwrap_or_else(|| Self::generate_protocol_md(task_id, mission, work_dir, &timestamp));
        fs::write(task_full_path.join("protocol.md"), protocol_content)?;

        // Generate and write supplement document
        let supplement_content = Self::generate_supplement_md(&timestamp);
        fs::write(task_full_path.join("supplement.md"), supplement_content)?;

        // Generate and write memory files
        fs::write(
            task_full_path.join("memory/index.md"),
            Self::generate_memory_index(),
        )?;
        fs::write(
            task_full_path.join("memory/tasks.md"),
            Self::generate_memory_tasks(mission),
        )?;

        Ok(task_path)
    }

    // =========================================================================
    // Document Generation
    // =========================================================================

    /// Generate protocol document content
    fn generate_protocol_md(
        task_id: &str,
        mission: &str,
        workspace_root: &str,
        timestamp: &str,
    ) -> String {
        let now = Local::now().format("%Y-%m-%d %H:%M:%S");

        format!(
            r#"# 任务协议

> 任务ID: {}
> 创建时间: {}
> 版本: 1.0.0

---

## 任务目标

{}

---

## 工作区

```
{}
```

---

## 执行规则

每次触发时按以下顺序执行：

### 1. 检查用户补充
- 读取 `.polaris/tasks/{}/supplement.md`
- 如有新内容，优先处理并归档

### 2. 推进主任务
- 读取 `.polaris/tasks/{}/memory/index.md` 了解当前进度
- 选择下一个待办事项执行
- 完成后更新记忆

### 3. 记忆更新
- 新成果写入 `.polaris/tasks/{}/memory/index.md`
- 待办任务写入 `.polaris/tasks/{}/memory/tasks.md`

### 4. 文档备份
- 用户补充处理完成后迁移到 `.oprcli/tasks/{}/supplement-history/`
- 文档超过 {} 行时总结后备份

---

## 补充

1. 分析后无需用户审查
2. 修改内容后及时提交git
3. 将任务拆分处理，每次完成一部分，当任务都完成后，就测试，审查，优化，改造

---

## 成果定义

有价值的工作：
- 完成具体功能实现
- 修复已知问题
- 优化代码质量
- 产出可复用资产

避免：
- 无产出的探索
- 重复性工作

---

## 协议更新

可修改本协议，修改时记录：
- 修改内容
- 修改原因
- 预期效果

不可删除：
- 任务目标
- 工作区
"#,
            task_id,
            now,
            mission,
            workspace_root,
            timestamp,
            timestamp,
            timestamp,
            timestamp,
            timestamp,
            BACKUP_LINE_THRESHOLD
        )
    }

    /// Render protocol document from template
    fn render_protocol_from_template(
        task_id: &str,
        mission: &str,
        workspace_root: &str,
        timestamp: &str,
        template: &str,
    ) -> String {
        // Replace template variables
        template
            .replace("{{taskId}}", task_id)
            .replace("{{mission}}", mission)
            .replace("{{workspaceRoot}}", workspace_root)
            .replace("{{timestamp}}", timestamp)
            .replace(
                "{{createdAt}}",
                &Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            )
            .replace(
                "{{currentDate}}",
                &Local::now().format("%Y-%m-%d").to_string(),
            )
    }

    /// Generate user supplement document content
    fn generate_supplement_md(timestamp: &str) -> String {
        format!(
            r#"# 用户补充

> 用于临时调整任务方向或补充要求
> AI 处理后会清空内容，历史记录保存在 .oprcli/tasks/{}/supplement-history/

---

<!-- 在下方添加补充内容 -->




"#,
            timestamp
        )
    }

    /// Generate memory index content
    fn generate_memory_index() -> String {
        r#"# 成果索引

## 当前状态
状态: 初始化
进度: 0%

## 已完成
- [暂无]

## 进行中
- [暂无]
"#
        .to_string()
    }

    /// Generate memory tasks content
    fn generate_memory_tasks(mission: &str) -> String {
        format!(
            r#"# 任务队列

## 待办
1. 分析任务目标：{}
2. 拆解为可执行步骤
3. 逐步推进

## 已完成
- [暂无]
"#,
            mission
        )
    }

    // =========================================================================
    // Document Reading
    // =========================================================================

    /// Read protocol document
    pub fn read_protocol(work_dir: &str, task_path: &str) -> io::Result<String> {
        let path = PathBuf::from(work_dir).join(task_path).join("protocol.md");
        fs::read_to_string(path)
    }

    /// Read supplement document
    pub fn read_supplement(work_dir: &str, task_path: &str) -> io::Result<String> {
        let path = PathBuf::from(work_dir).join(task_path).join("supplement.md");
        fs::read_to_string(path)
    }

    /// Read memory index
    pub fn read_memory_index(work_dir: &str, task_path: &str) -> io::Result<String> {
        let path = PathBuf::from(work_dir).join(task_path).join("memory/index.md");
        fs::read_to_string(path)
    }

    /// Read memory tasks
    pub fn read_memory_tasks(work_dir: &str, task_path: &str) -> io::Result<String> {
        let path = PathBuf::from(work_dir).join(task_path).join("memory/tasks.md");
        fs::read_to_string(path)
    }

    /// Read all memory files as a tuple
    pub fn read_all_memory(
        work_dir: &str,
        task_path: &str,
    ) -> io::Result<(String, String)> {
        let index = Self::read_memory_index(work_dir, task_path)?;
        let tasks = Self::read_memory_tasks(work_dir, task_path)?;
        Ok((index, tasks))
    }

    // =========================================================================
    // Document Updating
    // =========================================================================

    /// Update protocol document
    pub fn update_protocol(work_dir: &str, task_path: &str, content: &str) -> io::Result<()> {
        let path = PathBuf::from(work_dir).join(task_path).join("protocol.md");
        fs::write(path, content)
    }

    /// Update supplement document
    pub fn update_supplement(work_dir: &str, task_path: &str, content: &str) -> io::Result<()> {
        let path = PathBuf::from(work_dir).join(task_path).join("supplement.md");
        fs::write(path, content)
    }

    /// Update memory index
    pub fn update_memory_index(work_dir: &str, task_path: &str, content: &str) -> io::Result<()> {
        let path = PathBuf::from(work_dir).join(task_path).join("memory/index.md");
        fs::write(path, content)
    }

    /// Update memory tasks
    pub fn update_memory_tasks(work_dir: &str, task_path: &str, content: &str) -> io::Result<()> {
        let path = PathBuf::from(work_dir).join(task_path).join("memory/tasks.md");
        fs::write(path, content)
    }

    /// Clear supplement document (reset to template)
    pub fn clear_supplement(work_dir: &str, task_path: &str) -> io::Result<()> {
        let timestamp = Self::extract_timestamp(task_path).unwrap_or_default();
        let content = Self::generate_supplement_md(&timestamp);
        Self::update_supplement(work_dir, task_path, &content)
    }

    // =========================================================================
    // Backup Operations
    // =========================================================================

    /// Backup supplement content
    ///
    /// Saves the supplement content to history with timestamp
    pub fn backup_supplement(
        work_dir: &str,
        task_path: &str,
        content: &str,
    ) -> io::Result<String> {
        let backup_timestamp = Local::now().format("%Y%m%d-%H%M%S");
        let task_timestamp = Self::extract_timestamp(task_path).unwrap_or_default();

        let backup_dir = PathBuf::from(work_dir)
            .join(".oprcli/tasks")
            .join(&task_timestamp)
            .join("supplement-history");

        fs::create_dir_all(&backup_dir)?;

        let backup_filename = format!("{}.md", backup_timestamp);
        let backup_path = backup_dir.join(&backup_filename);

        let backup_content = format!(
            "# 用户补充备份 ({})\n\n{}",
            Local::now().format("%Y-%m-%d %H:%M:%S"),
            content
        );

        fs::write(&backup_path, backup_content)?;
        Ok(backup_path.to_string_lossy().to_string())
    }

    /// Backup document (when content exceeds threshold)
    pub fn backup_document(
        work_dir: &str,
        task_path: &str,
        doc_name: &str,
        content: &str,
        summary: Option<&str>,
    ) -> io::Result<String> {
        let backup_timestamp = Local::now().format("%Y%m%d-%H%M%S");
        let task_timestamp = Self::extract_timestamp(task_path).unwrap_or_default();

        let backup_dir = PathBuf::from(work_dir)
            .join(".oprcli/tasks")
            .join(&task_timestamp)
            .join("doc-history");

        fs::create_dir_all(&backup_dir)?;

        let backup_filename = format!("{}-{}.md", doc_name, backup_timestamp);
        let backup_path = backup_dir.join(&backup_filename);

        let backup_content = if let Some(s) = summary {
            format!(
                "# {} 备份 ({})\n\n## 摘要\n\n{}\n\n## 原文\n\n{}",
                doc_name,
                Local::now().format("%Y-%m-%d %H:%M:%S"),
                s,
                content
            )
        } else {
            format!(
                "# {} 备份 ({})\n\n{}",
                doc_name,
                Local::now().format("%Y-%m-%d %H:%M:%S"),
                content
            )
        };

        fs::write(&backup_path, backup_content)?;
        Ok(backup_path.to_string_lossy().to_string())
    }

    // =========================================================================
    // Cleanup Operations
    // =========================================================================

    /// Delete task directory structure
    ///
    /// Removes both the main task directory and backup directory
    pub fn delete_task_structure(work_dir: &str, task_path: &str) -> io::Result<()> {
        // Delete main task directory
        let task_full_path = PathBuf::from(work_dir).join(task_path);
        if task_full_path.exists() {
            fs::remove_dir_all(&task_full_path)?;
        }

        // Delete backup directory
        if let Some(timestamp) = Self::extract_timestamp(task_path) {
            let backup_path = PathBuf::from(work_dir)
                .join(".oprcli/tasks")
                .join(&timestamp);
            if backup_path.exists() {
                fs::remove_dir_all(&backup_path)?;
            }
        }

        Ok(())
    }

    // =========================================================================
    // Content Analysis
    // =========================================================================

    /// Extract user content from supplement document
    ///
    /// Removes template comments and empty lines
    pub fn extract_user_content(full_content: &str) -> String {
        let lines: Vec<&str> = full_content.lines().collect();
        let mut content_started = false;
        let mut result = Vec::new();

        for line in &lines {
            // Skip until we find the content marker
            if line.contains("<!-- 在下方添加补充内容 -->") {
                content_started = true;
                continue;
            }

            if content_started {
                // Skip leading empty lines
                if line.trim().is_empty() && result.is_empty() {
                    continue;
                }
                result.push(*line);
            }
        }

        // Remove trailing empty lines
        while result.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
            result.pop();
        }

        result.join("\n")
    }

    /// Check if supplement has user content
    pub fn has_supplement_content(full_content: &str) -> bool {
        let extracted = Self::extract_user_content(full_content);
        !extracted.trim().is_empty()
    }

    /// Count document lines
    pub fn count_lines(content: &str) -> usize {
        content.lines().count()
    }

    /// Check if document needs backup (exceeds threshold)
    pub fn needs_backup(content: &str) -> bool {
        Self::count_lines(content) > BACKUP_LINE_THRESHOLD
    }

    // =========================================================================
    // Prompt Building
    // =========================================================================

    /// Build complete prompt for protocol mode task
    ///
    /// Combines protocol document, user supplement, and memory files
    /// into a single prompt for AI execution.
    ///
    /// # Arguments
    /// * `work_dir` - Working directory root
    /// * `task_path` - Relative task path (e.g., `.polaris/tasks/20260403011008`)
    ///
    /// # Returns
    /// Complete prompt string or error
    pub fn build_protocol_prompt(work_dir: &str, task_path: &str) -> io::Result<String> {
        // Read all documents
        let protocol = Self::read_protocol(work_dir, task_path)?;
        let supplement = Self::read_supplement(work_dir, task_path)?;
        let (memory_index, memory_tasks) = Self::read_all_memory(work_dir, task_path)?;

        // Extract user content from supplement (remove template comments)
        let user_supplement = Self::extract_user_content(&supplement);

        // Build prompt with clear sections
        let mut prompt_parts = Vec::new();

        // Add protocol document (main task definition)
        prompt_parts.push(protocol);

        // Add separator
        prompt_parts.push("\n---\n".to_string());

        // Add user supplement if has content
        if !user_supplement.trim().is_empty() {
            prompt_parts.push(format!(
                "# 用户补充（当前轮次）\n\n{}\n\n---\n",
                user_supplement
            ));
        }

        // Add memory state
        prompt_parts.push(format!(
            "# 当前状态\n\n## 进度索引\n\n{}\n\n## 任务队列\n\n{}",
            memory_index, memory_tasks
        ));

        Ok(prompt_parts.join("\n"))
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_user_content() {
        let content = r#"# 用户补充

> 用于临时调整任务方向或补充要求

---

<!-- 在下方添加补充内容 -->

这是用户的补充内容
第二行


"#;
        let extracted = ProtocolTaskService::extract_user_content(content);
        assert_eq!(extracted, "这是用户的补充内容\n第二行");
    }

    #[test]
    fn test_has_supplement_content() {
        let empty = r#"# 用户补充

<!-- 在下方添加补充内容 -->




"#;
        assert!(!ProtocolTaskService::has_supplement_content(empty));

        let with_content = r#"# 用户补充

<!-- 在下方添加补充内容 -->

有内容
"#;
        assert!(ProtocolTaskService::has_supplement_content(with_content));
    }

    #[test]
    fn test_needs_backup() {
        let short_content = "line\n".repeat(100);
        assert!(!ProtocolTaskService::needs_backup(&short_content));

        let long_content = "line\n".repeat(900);
        assert!(ProtocolTaskService::needs_backup(&long_content));
    }

    #[test]
    fn test_timestamp_generation() {
        let ts = ProtocolTaskService::generate_timestamp();
        assert_eq!(ts.len(), 14); // YYYYMMDDHHMMSS

        let path = ProtocolTaskService::generate_task_path_from_timestamp(&ts);
        assert!(path.starts_with(".polaris/tasks/"));

        let extracted = ProtocolTaskService::extract_timestamp(&path);
        assert_eq!(extracted, Some(ts));
    }
}
