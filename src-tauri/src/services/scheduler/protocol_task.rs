/*! 协议任务服务
 *
 * 负责创建、读取、备份协议任务相关文件
 */

use std::path::PathBuf;
use std::fs;
use chrono::Local;

use super::ExecutionOutcome;

/// 任务目录名格式：年月日时分秒
const TIMESTAMP_FORMAT: &str = "%Y%m%d%H%M%S";

/// 协议任务服务
pub struct ProtocolTaskService;

#[allow(dead_code)]
impl ProtocolTaskService {
    /// 生成当前时间戳
    pub fn generate_timestamp() -> String {
        Local::now().format(TIMESTAMP_FORMAT).to_string()
    }

    /// 生成任务路径
    pub fn generate_task_path_from_timestamp(timestamp: &str) -> String {
        format!(".polaris/tasks/{}", timestamp)
    }

    /// 生成任务路径（使用当前时间）
    pub fn generate_task_path() -> String {
        let timestamp = Self::generate_timestamp();
        Self::generate_task_path_from_timestamp(&timestamp)
    }

    /// 从任务路径提取时间戳
    pub fn extract_timestamp(task_path: &str) -> Option<String> {
        let parts: Vec<&str> = task_path.split('/').collect();
        parts.last().map(|s| s.to_string())
    }

    /// 创建协议任务目录结构
    pub fn create_task_structure(
        work_dir: &str,
        task_id: &str,
        mission: &str,
    ) -> std::io::Result<String> {
        // 调用带模板参数的版本，使用默认模板
        Self::create_task_structure_with_templates(work_dir, task_id, mission, None, None, None, None, None)
    }

    /// 创建协议任务目录结构（支持自定义模板）
    pub fn create_task_structure_with_templates(
        work_dir: &str,
        task_id: &str,
        mission: &str,
        task_template: Option<&str>,
        memory_template: Option<&str>,
        tasks_template: Option<&str>,
        runs_template: Option<&str>,
        supplement_template: Option<&str>,
    ) -> std::io::Result<String> {
        // 统一生成时间戳，确保所有地方使用相同的时间
        let timestamp = Self::generate_timestamp();
        let task_path = Self::generate_task_path_from_timestamp(&timestamp);
        let task_full_path = PathBuf::from(work_dir).join(&task_path);

        // 创建目录结构
        fs::create_dir_all(task_full_path.join("memory"))?;
        fs::create_dir_all(
            PathBuf::from(work_dir)
                .join(".oprcli/tasks")
                .join(&timestamp)
                .join("supplement-history")
        )?;

        // 生成并写入协议文档
        let task_content = if let Some(template) = task_template {
            Self::render_template(template, task_id, mission, work_dir, &timestamp)
        } else {
            Self::generate_task_md(task_id, mission, work_dir, &timestamp)
        };
        fs::write(task_full_path.join("task.md"), task_content)?;

        // 生成并写入用户补充文档
        let supplement_content = if let Some(template) = supplement_template {
            Self::render_supplement_template(template, &timestamp)
        } else {
            Self::generate_supplement_md(&timestamp)
        };
        fs::write(task_full_path.join("user-supplement.md"), supplement_content)?;

        // 生成并写入记忆文件
        let memory_content = if let Some(template) = memory_template {
            Self::render_memory_template(template)
        } else {
            Self::generate_memory_index()
        };
        fs::write(task_full_path.join("memory/index.md"), memory_content)?;

        let tasks_content = if let Some(template) = tasks_template {
            Self::render_tasks_template(template, mission)
        } else {
            Self::generate_memory_tasks(mission)
        };
        fs::write(task_full_path.join("memory/tasks.md"), tasks_content)?;

        let runs_content = if let Some(template) = runs_template {
            Self::render_runs_template(template)
        } else {
            Self::generate_memory_runs()
        };
        fs::write(task_full_path.join("memory/runs.md"), runs_content)?;

        Ok(task_path)
    }

    /// 渲染模板（替换占位符）
    fn render_template(template: &str, task_id: &str, mission: &str, work_dir: &str, timestamp: &str) -> String {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        template
            .replace("{taskId}", task_id)
            .replace("{task}", mission)
            .replace("{dateTime}", &now.to_string())
            .replace("{workDir}", work_dir)
            .replace("{timestamp}", timestamp)
    }

    /// 渲染用户补充模板
    fn render_supplement_template(template: &str, timestamp: &str) -> String {
        template.replace("{timestamp}", timestamp)
    }

    /// 渲染记忆模板
    fn render_memory_template(template: &str) -> String {
        template.to_string()
    }

    /// 渲染任务队列模板
    fn render_tasks_template(template: &str, mission: &str) -> String {
        template.replace("{task}", mission)
    }

    /// 渲染执行轮次模板
    fn render_runs_template(template: &str) -> String {
        template.to_string()
    }

    /// 生成协议文档
    fn generate_task_md(task_id: &str, mission: &str, workspace_root: &str, timestamp: &str) -> String {
        let now = Local::now().format("%Y-%m-%d %H:%M:%S");

        format!(
r#"# 任务协议

> 任务ID: {}
> 创建时间: {}
> 版本: 2.0.0

---

## 任务目标

{}

---

## 工作区

```
{}
```

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

## 执行边界

- 优先处理 `.polaris/tasks/{}/user-supplement.md` 中的新增补充
- 执行前先读取 `.polaris/tasks/{}/memory/index.md` 与 `memory/tasks.md`
- 每轮只推进一个小闭环，完成后更新记忆与待办
- 用户补充处理完成后归档到 `.oprcli/tasks/{}/supplement-history/`
- 文档超过 800 行时先总结，再执行备份

---

## 连续执行策略

- 默认按调度触发推进
- 若任务仍未完成且启用连续执行，可在本轮完成后立即进入下一轮
- 单次调度只应推进有限阶段，避免一次性完成全部流程

## 会话策略

- 记录最近一次有效 `session_id`
- 后续执行优先复用该会话，无法复用时再创建新会话

## 协议更新

可修改本协议，修改时记录：
- 修改内容
- 修改原因
- 预期效果

不可删除：
- 任务目标
- 工作区
"#,
            task_id, now, mission, workspace_root, timestamp, timestamp, timestamp
        )
    }

    /// 生成用户补充文档
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

    /// 生成记忆索引
    fn generate_memory_index() -> String {
        let now = Local::now().format("%Y-%m-%d %H:%M:%S");

        format!(
            r#"# 成果索引

## 当前状态
状态: 初始化
当前阶段: 分析
进度: 0%
最近更新: {}

## 本轮结论
- [暂无]

## 已完成
- [暂无]

## 当前阻塞
- [暂无]

## 下一步
- 分析任务目标并拆解首个可执行小模块
"#,
            now
        )
    }

    /// 生成记忆任务队列
    fn generate_memory_tasks(mission: &str) -> String {
        format!(
r#"# 任务队列

## 待办
1. 分析任务目标：{}
2. 拆解为可执行步骤
3. 选择首个小模块推进

## 进行中
- [暂无]

## 已完成
- [暂无]

## 暂缓
- [暂无]
"#,
            mission
        )
    }

    /// 生成执行轮次记录
    fn generate_memory_runs() -> String {
        r#"# 执行轮次记录

## Run 0
- 时间: [待首次执行]
- 使用会话: [暂无]
- 完成事项: 初始化任务文档结构
- 遗留事项: 等待首轮推进
- 是否触发连续执行: 否
"#.to_string()
    }

    fn format_memory_run_entry(
        run_number: u32,
        time: &str,
        session_id: Option<&str>,
        completed: &str,
        pending: &str,
        continued: bool,
        outcome: Option<&ExecutionOutcome>,
    ) -> String {
        let session = session_id
            .map(|value| {
                let trimmed = value.trim();
                if trimmed.is_empty() { "[暂无]" } else { trimmed }
            })
            .unwrap_or("[暂无]");
        let completed = Self::normalize_run_summary(completed, "本轮执行已完成，待补充成果摘要");
        let pending = Self::normalize_run_summary(pending, "待结合 memory/index.md 与 tasks.md 决定下一步");
        let continued = if continued { "是" } else { "否" };
        let outcome_str = outcome
            .map(|o| Self::format_outcome(o))
            .unwrap_or_else(|| "[未记录]".to_string());

        format!(
            "## Run {}\n- 时间: {}\n- 使用会话: {}\n- 执行结果: {}\n- 完成事项: {}\n- 遗留事项: {}\n- 是否触发连续执行: {}",
            run_number,
            time,
            session,
            outcome_str,
            completed,
            pending,
            continued,
        )
    }

    /// 格式化执行结果类型
    fn format_outcome(outcome: &ExecutionOutcome) -> String {
        match outcome {
            ExecutionOutcome::SuccessWithProgress => "有进展".to_string(),
            ExecutionOutcome::SuccessNoProgress => "无进展".to_string(),
            ExecutionOutcome::PartialSuccess => "部分成功".to_string(),
            ExecutionOutcome::Failed => "失败".to_string(),
            ExecutionOutcome::Blocked(reason) => format!("阻塞: {}", reason),
            ExecutionOutcome::ConsecutiveNoProgress(count) => format!("连续无进展({}次)", count),
        }
    }

    fn normalize_run_summary(value: &str, fallback: &str) -> String {
        let normalized = value
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("；");

        if normalized.is_empty() {
            fallback.to_string()
        } else {
            normalized
        }
    }

    /// 读取协议文档
    pub fn read_task_md(work_dir: &str, task_path: &str) -> std::io::Result<String> {
        let path = PathBuf::from(work_dir).join(task_path).join("task.md");
        fs::read_to_string(path)
    }

    /// 读取用户补充文档
    pub fn read_supplement_md(work_dir: &str, task_path: &str) -> std::io::Result<String> {
        let path = PathBuf::from(work_dir).join(task_path).join("user-supplement.md");
        fs::read_to_string(path)
    }

    /// 读取记忆索引
    pub fn read_memory_index(work_dir: &str, task_path: &str) -> std::io::Result<String> {
        let path = PathBuf::from(work_dir).join(task_path).join("memory/index.md");
        fs::read_to_string(path)
    }

    /// 读取记忆任务
    pub fn read_memory_tasks(work_dir: &str, task_path: &str) -> std::io::Result<String> {
        let path = PathBuf::from(work_dir).join(task_path).join("memory/tasks.md");
        fs::read_to_string(path)
    }

    /// 读取执行轮次记录
    pub fn read_memory_runs(work_dir: &str, task_path: &str) -> std::io::Result<String> {
        let path = PathBuf::from(work_dir).join(task_path).join("memory/runs.md");
        fs::read_to_string(path)
    }

    /// 获取最新一轮运行的摘要（用于续跑提示词）
    ///
    /// 返回格式：
    /// - 完成事项: xxx
    /// - 遗留事项: xxx
    pub fn get_latest_run_summary(work_dir: &str, task_path: &str) -> Option<String> {
        let content = Self::read_memory_runs(work_dir, task_path).ok()?;

        // 解析最新的 Run 块
        let mut latest_run: Option<String> = None;
        let mut current_run_content = String::new();
        let mut in_run_block = false;

        for line in content.lines() {
            if line.starts_with("## Run ") {
                // 遇到新的 Run 块，保存之前的
                if in_run_block && !current_run_content.is_empty() {
                    latest_run = Some(current_run_content.clone());
                }
                current_run_content.clear();
                in_run_block = true;
            }

            if in_run_block {
                // 提取"完成事项"和"遗留事项"
                if line.starts_with("- 完成事项:") || line.starts_with("- 遗留事项:") {
                    if !current_run_content.is_empty() {
                        current_run_content.push('\n');
                    }
                    current_run_content.push_str(line);
                }
            }
        }

        // 处理最后一个 Run 块
        if in_run_block && !current_run_content.is_empty() {
            latest_run = Some(current_run_content);
        }

        latest_run
    }

    /// 更新记忆索引
    pub fn update_memory_index(work_dir: &str, task_path: &str, content: &str) -> std::io::Result<()> {
        let path = PathBuf::from(work_dir).join(task_path).join("memory/index.md");
        fs::write(path, content)
    }

    /// 更新记忆任务
    pub fn update_memory_tasks(work_dir: &str, task_path: &str, content: &str) -> std::io::Result<()> {
        let path = PathBuf::from(work_dir).join(task_path).join("memory/tasks.md");
        fs::write(path, content)
    }

    /// 更新执行轮次记录
    pub fn update_memory_runs(work_dir: &str, task_path: &str, content: &str) -> std::io::Result<()> {
        let path = PathBuf::from(work_dir).join(task_path).join("memory/runs.md");
        fs::write(path, content)
    }

    /// 追加执行轮次记录
    pub fn append_memory_run(
        work_dir: &str,
        task_path: &str,
        run_number: u32,
        session_id: Option<&str>,
        completed: &str,
        pending: &str,
        continued: bool,
        outcome: Option<&ExecutionOutcome>,
    ) -> std::io::Result<()> {
        let path = PathBuf::from(work_dir).join(task_path).join("memory/runs.md");
        let existing = fs::read_to_string(&path).unwrap_or_else(|_| Self::generate_memory_runs());
        let entry = Self::format_memory_run_entry(
            run_number,
            Local::now().format("%Y-%m-%d %H:%M:%S").to_string().as_str(),
            session_id,
            completed,
            pending,
            continued,
            outcome,
        );

        let mut content = existing.trim_end().to_string();
        content.push_str("\n\n");
        content.push_str(&entry);
        content.push('\n');

        fs::write(path, content)
    }

    /// 更新协议文档
    pub fn update_task_md(work_dir: &str, task_path: &str, content: &str) -> std::io::Result<()> {
        let path = PathBuf::from(work_dir).join(task_path).join("task.md");
        fs::write(path, content)
    }

    /// 清空用户补充文档（保留模板）
    pub fn clear_supplement_md(work_dir: &str, task_path: &str) -> std::io::Result<()> {
        let path = PathBuf::from(work_dir).join(task_path).join("user-supplement.md");
        let timestamp = Self::extract_timestamp(task_path).unwrap_or_default();
        fs::write(path, Self::generate_supplement_md(&timestamp))
    }

    /// 备份用户补充内容
    pub fn backup_supplement(
        work_dir: &str,
        task_path: &str,
        content: &str,
    ) -> std::io::Result<String> {
        let timestamp = Local::now().format("%Y%m%d-%H%M%S");
        let task_timestamp = Self::extract_timestamp(task_path).unwrap_or_default();

        let backup_dir = PathBuf::from(work_dir)
            .join(".oprcli/tasks")
            .join(&task_timestamp)
            .join("supplement-history");

        fs::create_dir_all(&backup_dir)?;

        let backup_filename = format!("{}.md", timestamp);
        let backup_path = backup_dir.join(&backup_filename);

        let backup_content = format!(
            "# 用户补充备份 ({})\n\n{}",
            Local::now().format("%Y-%m-%d %H:%M:%S"),
            content
        );

        fs::write(&backup_path, backup_content)?;
        Ok(backup_path.to_string_lossy().to_string())
    }

    /// 备份文档（内容过多时）
    pub fn backup_document(
        work_dir: &str,
        task_path: &str,
        doc_name: &str,
        content: &str,
        summary: Option<&str>,
    ) -> std::io::Result<String> {
        let timestamp = Local::now().format("%Y%m%d-%H%M%S");
        let task_timestamp = Self::extract_timestamp(task_path).unwrap_or_default();

        let backup_dir = PathBuf::from(work_dir)
            .join(".oprcli/tasks")
            .join(&task_timestamp)
            .join("doc-history");

        fs::create_dir_all(&backup_dir)?;

        let backup_filename = format!("{}-{}.md", doc_name, timestamp);
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

    /// 提取用户补充内容（去掉模板注释和空行）
    pub fn extract_user_content(full_content: &str) -> String {
        let lines: Vec<&str> = full_content.lines().collect();
        let mut content_started = false;
        let mut result = Vec::new();

        for line in &lines {
            // 跳过模板部分
            if line.contains("<!-- 在下方添加补充内容 -->") {
                content_started = true;
                continue;
            }

            if content_started {
                // 跳过开头的空行
                if line.trim().is_empty() && result.is_empty() {
                    continue;
                }
                result.push(*line);
            }
        }

        // 移除末尾的空行
        while result.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
            result.pop();
        }

        result.join("\n")
    }

    /// 检查用户补充是否有内容
    pub fn has_supplement_content(full_content: &str) -> bool {
        let extracted = Self::extract_user_content(full_content);
        !extracted.trim().is_empty()
    }

    /// 计算文档行数
    pub fn count_lines(content: &str) -> usize {
        content.lines().count()
    }

    /// 检查是否需要备份（超过 800 行）
    pub fn needs_backup(content: &str) -> bool {
        Self::count_lines(content) > 800
    }

    /// 删除任务目录
    pub fn delete_task_structure(work_dir: &str, task_path: &str) -> std::io::Result<()> {
        let task_full_path = PathBuf::from(work_dir).join(task_path);
        if task_full_path.exists() {
            fs::remove_dir_all(&task_full_path)?;
        }

        // 同时删除备份目录
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
}

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
    fn test_generate_memory_runs_default_template() {
        let content = ProtocolTaskService::generate_memory_runs();
        assert!(content.contains("# 执行轮次记录"));
        assert!(content.contains("## Run 0"));
        assert!(content.contains("- 完成事项: 初始化任务文档结构"));
        assert!(content.contains("- 是否触发连续执行: 否"));
    }

    #[test]
    fn test_append_memory_run() {
        let unique = format!("polaris-protocol-task-{}", Local::now().timestamp_nanos_opt().unwrap_or_default());
        let temp_dir = std::env::temp_dir().join(unique);
        let task_path = ".polaris/tasks/20260324092458";
        let task_memory_dir = temp_dir.join(task_path).join("memory");
        fs::create_dir_all(&task_memory_dir).unwrap();
        fs::write(
            task_memory_dir.join("runs.md"),
            ProtocolTaskService::generate_memory_runs(),
        ).unwrap();

        ProtocolTaskService::append_memory_run(
            temp_dir.to_str().unwrap(),
            task_path,
            1,
            Some("session-123"),
            "完成 runs 自动追加",
            "继续评估会话字段改造",
            false,
            None::<&ExecutionOutcome>,
        ).unwrap();

        let content = fs::read_to_string(task_memory_dir.join("runs.md")).unwrap();
        assert!(content.contains("## Run 1"));
        assert!(content.contains("- 使用会话: session-123"));
        assert!(content.contains("- 完成事项: 完成 runs 自动追加"));
        assert!(content.contains("- 遗留事项: 继续评估会话字段改造"));
        assert!(content.contains("- 是否触发连续执行: 否"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_format_memory_run_entry_normalizes_lines() {
        let entry = ProtocolTaskService::format_memory_run_entry(
            2,
            "2026-03-24 10:30:00",
            Some(""),
            "\n完成 A\n完成 B\n",
            "\n\n",
            true,
            None::<&ExecutionOutcome>,
        );

        assert!(entry.contains("## Run 2"));
        assert!(entry.contains("- 使用会话: [暂无]"));
        assert!(entry.contains("- 完成事项: 完成 A；完成 B"));
        assert!(entry.contains("- 遗留事项: 待结合 memory/index.md 与 tasks.md 决定下一步"));
        assert!(entry.contains("- 是否触发连续执行: 是"));
    }

    #[test]
    fn test_generate_task_md_default_template_is_compact() {
        let content = ProtocolTaskService::generate_task_md(
            "task-123",
            "实现协议调度重构",
            "D:/space/base/Polaris",
            "20260324092458",
        );

        assert!(content.contains("> 版本: 2.0.0"));
        assert!(content.contains("## 执行边界"));
        assert!(content.contains("## 连续执行策略"));
        assert!(content.contains("## 会话策略"));
        assert!(!content.contains("## AgentOS 工程决策协议"));
        assert!(!content.contains("文档超过 300 行时总结后备份"));
        assert!(content.contains("文档超过 800 行时先总结，再执行备份"));
    }

    #[test]
    fn test_get_latest_run_summary() {
        let runs_content = r#"# 执行轮次记录

## Run 0
- 时间: 2026-03-24 09:00:00
- 使用会话: [暂无]
- 完成事项: 初始化任务文档结构
- 遗留事项: 等待首轮推进
- 是否触发连续执行: 否

## Run 1
- 时间: 2026-03-24 10:00:00
- 使用会话: session-abc
- 完成事项: 完成 PromptBuilder 模块
- 遗留事项: 测试验证新模块
- 是否触发连续执行: 是
"#;
        let unique = format!("polaris-latest-run-{}", Local::now().timestamp_nanos_opt().unwrap_or_default());
        let temp_dir = std::env::temp_dir().join(unique);
        let task_path = ".polaris/tasks/20260324092458";
        let task_memory_dir = temp_dir.join(task_path).join("memory");
        fs::create_dir_all(&task_memory_dir).unwrap();
        fs::write(task_memory_dir.join("runs.md"), runs_content).unwrap();

        let summary = ProtocolTaskService::get_latest_run_summary(
            temp_dir.to_str().unwrap(),
            task_path,
        );

        assert!(summary.is_some());
        let summary = summary.unwrap();
        assert!(summary.contains("- 完成事项: 完成 PromptBuilder 模块"));
        assert!(summary.contains("- 遗留事项: 测试验证新模块"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_get_latest_run_summary_empty_file() {
        let unique = format!("polaris-empty-runs-{}", Local::now().timestamp_nanos_opt().unwrap_or_default());
        let temp_dir = std::env::temp_dir().join(unique);
        let task_path = ".polaris/tasks/20260324092458";
        let task_memory_dir = temp_dir.join(task_path).join("memory");
        fs::create_dir_all(&task_memory_dir).unwrap();
        fs::write(task_memory_dir.join("runs.md"), "# 执行轮次记录\n").unwrap();

        let summary = ProtocolTaskService::get_latest_run_summary(
            temp_dir.to_str().unwrap(),
            task_path,
        );

        // 空文件没有有效的 Run 块
        assert!(summary.is_none());

        let _ = fs::remove_dir_all(temp_dir);
    }
}
