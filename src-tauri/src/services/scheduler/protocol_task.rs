/*! 协议任务服务
 *
 * 负责创建、读取、备份协议任务相关文件
 */

use std::path::PathBuf;
use std::fs;
use chrono::Local;

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
        let task_content = Self::generate_task_md(task_id, mission, work_dir, &timestamp);
        fs::write(task_full_path.join("task.md"), task_content)?;

        // 生成并写入用户补充文档
        let supplement_content = Self::generate_supplement_md(&timestamp);
        fs::write(task_full_path.join("user-supplement.md"), supplement_content)?;

        // 生成并写入记忆文件
        fs::write(task_full_path.join("memory/index.md"), Self::generate_memory_index())?;
        fs::write(task_full_path.join("memory/tasks.md"), Self::generate_memory_tasks(mission))?;

        Ok(task_path)
    }

    /// 生成协议文档
    fn generate_task_md(task_id: &str, mission: &str, workspace_root: &str, timestamp: &str) -> String {
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
- 读取 `.polaris/tasks/{}/user-supplement.md`
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
- 文档超过 800 行时总结后备份

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
            task_id, now, mission, workspace_root, timestamp, timestamp, timestamp, timestamp, timestamp
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
        r#"# 成果索引

## 当前状态
状态: 初始化
进度: 0%

## 已完成
- [暂无]

## 进行中
- [暂无]
"#.to_string()
    }

    /// 生成记忆任务队列
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
}
