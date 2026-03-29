//! Template Repository
//!
//! Manages task document templates.

use crate::error::{AppError, Result};
use crate::models::task_template::{
    CreateTemplateParams, TaskTemplate, TemplateDocument, TemplateVariable, TemplateStore,
};
use chrono::Utc;
use std::path::PathBuf;
use uuid::Uuid;

const TEMPLATES_DIR_NAME: &str = "templates";
const BUILTIN_DIR_NAME: &str = "builtin";
const CUSTOM_DIR_NAME: &str = "custom";
const TEMPLATE_FILE_NAME: &str = "template.json";

/// Repository for managing document templates
pub struct TemplateRepository {
    /// Storage directory (config_dir/scheduler/templates)
    storage_dir: PathBuf,
}

impl TemplateRepository {
    /// Create a new template repository
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            storage_dir: config_dir.join("scheduler").join(TEMPLATES_DIR_NAME),
        }
    }

    /// List all templates (builtin + custom)
    pub fn list_templates(&self) -> Result<Vec<TaskTemplate>> {
        let mut templates = Vec::new();

        // Load builtin templates
        templates.extend(self.get_builtin_templates());

        // Load custom templates
        if let Ok(custom) = self.list_custom_templates() {
            templates.extend(custom);
        }

        Ok(templates)
    }

    /// Get a single template by ID
    pub fn get_template(&self, id: &str) -> Result<Option<TaskTemplate>> {
        let templates = self.list_templates()?;
        Ok(templates.into_iter().find(|t| t.id == id))
    }

    /// Create a custom template
    pub fn create_template(&self, params: CreateTemplateParams) -> Result<TaskTemplate> {
        let id = Uuid::new_v4().to_string();
        let now = now_iso();

        let template = TaskTemplate {
            id: id.clone(),
            name: params.name,
            description: params.description,
            version: "1.0.0".to_string(),
            builtin: false,
            icon: None,
            tags: params.tags,
            variables: params.variables,
            documents: params.documents,
            primary_document: params.primary_document,
            created_at: now.clone(),
            updated_at: now,
            author: None,
        };

        self.save_custom_template(&template)?;
        Ok(template)
    }

    /// Update a custom template
    pub fn update_template(&self, id: &str, params: CreateTemplateParams) -> Result<TaskTemplate> {
        let existing = self
            .get_template(id)?
            .ok_or_else(|| AppError::ValidationError(format!("模板不存在: {}", id)))?;

        if existing.builtin {
            return Err(AppError::ValidationError("不能修改内置模板".to_string()));
        }

        let now = now_iso();
        let updated = TaskTemplate {
            id: id.to_string(),
            name: params.name,
            description: params.description,
            version: existing.version,
            builtin: false,
            icon: None,
            tags: params.tags,
            variables: params.variables,
            documents: params.documents,
            primary_document: params.primary_document,
            created_at: existing.created_at,
            updated_at: now,
            author: existing.author,
        };

        self.save_custom_template(&updated)?;
        Ok(updated)
    }

    /// Delete a custom template
    pub fn delete_template(&self, id: &str) -> Result<()> {
        let template = self
            .get_template(id)?
            .ok_or_else(|| AppError::ValidationError(format!("模板不存在: {}", id)))?;

        if template.builtin {
            return Err(AppError::ValidationError("不能删除内置模板".to_string()));
        }

        let template_dir = self.storage_dir.join(CUSTOM_DIR_NAME).join(id);
        if template_dir.exists() {
            std::fs::remove_dir_all(&template_dir)?;
        }

        Ok(())
    }

    /// Duplicate a template (creates a custom copy)
    pub fn duplicate_template(&self, id: &str, new_name: &str) -> Result<TaskTemplate> {
        let existing = self
            .get_template(id)?
            .ok_or_else(|| AppError::ValidationError(format!("模板不存在: {}", id)))?;

        self.create_template(CreateTemplateParams {
            name: new_name.to_string(),
            description: existing.description,
            variables: existing.variables,
            documents: existing.documents,
            primary_document: existing.primary_document,
            tags: existing.tags,
        })
    }

    /// Export template as JSON
    pub fn export_template(&self, id: &str) -> Result<String> {
        let template = self
            .get_template(id)?
            .ok_or_else(|| AppError::ValidationError(format!("模板不存在: {}", id)))?;

        serde_json::to_string_pretty(&template).map_err(AppError::from)
    }

    /// Import template from JSON
    pub fn import_template(&self, json: &str) -> Result<TaskTemplate> {
        let mut template: TaskTemplate = serde_json::from_str(json)
            .map_err(AppError::from)?;

        // Generate new ID and mark as custom
        template.id = Uuid::new_v4().to_string();
        template.builtin = false;
        let now = now_iso();
        template.created_at = now.clone();
        template.updated_at = now;

        self.save_custom_template(&template)?;
        Ok(template)
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    fn get_builtin_templates(&self) -> Vec<TaskTemplate> {
        vec![
            self.create_basic_template(),
            self.create_daily_report_template(),
            self.create_code_review_template(),
        ]
    }

    fn create_basic_template(&self) -> TaskTemplate {
        let now = now_iso();
        TaskTemplate {
            id: "builtin-basic".to_string(),
            name: "基础任务".to_string(),
            description: Some("基础任务模板，包含任务文档和记忆系统".to_string()),
            version: "1.0.0".to_string(),
            builtin: true,
            icon: Some("📝".to_string()),
            tags: Some(vec!["基础".to_string()]),
            variables: vec![],
            documents: vec![
                TemplateDocument {
                    filename: "task.md".to_string(),
                    content: r#"# 任务协议

> 任务ID: {{taskId}}
> 创建时间: {{datetime}}

## 任务目标

[请在此描述任务目标]

## 工作区

```
{{workspacePath}}
```

## 执行规则

1. 读取任务目标和要求
2. 按步骤执行
3. 更新记忆文档

## 成果定义

[定义任务完成的条件]
"#.to_string(),
                    is_primary: true,
                    description: Some("任务文档".to_string()),
                },
                TemplateDocument {
                    filename: "user.md".to_string(),
                    content: r#"# 用户补充

> 用于临时添加要求或调整任务内容

---

<!-- 在下方添加补充内容 -->

"#.to_string(),
                    is_primary: false,
                    description: Some("用户补充文档".to_string()),
                },
                TemplateDocument {
                    filename: "memory/index.md".to_string(),
                    content: r#"# 成果索引

## 当前状态

- 状态: 初始化
- 当前阶段: 启动
- 进度: 0%

## 本轮结论

[待填写]

## 已完成

[暂无]

## 当前阻塞

[暂无]

## 下一步

- 开始执行任务
"#.to_string(),
                    is_primary: false,
                    description: Some("记忆索引".to_string()),
                },
            ],
            primary_document: "task.md".to_string(),
            created_at: now.clone(),
            updated_at: now,
            author: Some("Polaris".to_string()),
        }
    }

    fn create_daily_report_template(&self) -> TaskTemplate {
        let now = now_iso();
        TaskTemplate {
            id: "builtin-daily-report".to_string(),
            name: "每日日报".to_string(),
            description: Some("自动生成每日工作日报，汇总 Git 提交、任务完成情况".to_string()),
            version: "1.0.0".to_string(),
            builtin: true,
            icon: Some("📊".to_string()),
            tags: Some(vec!["日报".to_string(), "自动化".to_string()]),
            variables: vec![
                TemplateVariable {
                    id: "reportDate".to_string(),
                    name: "报告日期".to_string(),
                    var_type: crate::models::task_template::VariableType::Date,
                    default_value: Some("{{date}}".to_string()),
                    required: true,
                    description: Some("日报日期".to_string()),
                    options: None,
                },
                TemplateVariable {
                    id: "includeGit".to_string(),
                    name: "包含 Git 提交".to_string(),
                    var_type: crate::models::task_template::VariableType::Boolean,
                    default_value: Some("true".to_string()),
                    required: false,
                    description: Some("是否包含 Git 提交记录".to_string()),
                    options: None,
                },
            ],
            documents: vec![
                TemplateDocument {
                    filename: "task.md".to_string(),
                    content: r#"# 每日日报生成任务

## 报告日期

{{reportDate}}

## 工作区

```
{{workspacePath}}
```

## 任务目标

1. 汇总 {{reportDate}} 的 Git 提交记录
2. 统计任务完成情况
3. 生成格式化日报

## 执行规则

1. 读取 Git 日志 (`git log --since="{{reportDate}} 00:00:00" --until="{{reportDate}} 23:59:59"`)
2. 统计代码变更
3. 汇总任务进度
4. 生成报告文档
"#.to_string(),
                    is_primary: true,
                    description: Some("日报任务文档".to_string()),
                },
                TemplateDocument {
                    filename: "user.md".to_string(),
                    content: r#"# 用户补充

> 用于临时调整报告内容或补充要求

---

<!-- 在下方添加补充内容 -->

"#.to_string(),
                    is_primary: false,
                    description: Some("用户补充文档".to_string()),
                },
                TemplateDocument {
                    filename: "memory/index.md".to_string(),
                    content: r#"# 成果索引

## 当前状态

- 状态: 初始化
- 进度: 0%

## 本轮结论

[待填写]

## 历史日报

[记录已生成的日报概要]
"#.to_string(),
                    is_primary: false,
                    description: Some("记忆索引".to_string()),
                },
            ],
            primary_document: "task.md".to_string(),
            created_at: now.clone(),
            updated_at: now,
            author: Some("Polaris".to_string()),
        }
    }

    fn create_code_review_template(&self) -> TaskTemplate {
        let now = now_iso();
        TaskTemplate {
            id: "builtin-code-review".to_string(),
            name: "代码审查".to_string(),
            description: Some("定期进行代码审查，检查代码质量和潜在问题".to_string()),
            version: "1.0.0".to_string(),
            builtin: true,
            icon: Some("🔍".to_string()),
            tags: Some(vec!["代码审查".to_string(), "质量".to_string()]),
            variables: vec![
                TemplateVariable {
                    id: "targetPath".to_string(),
                    name: "目标路径".to_string(),
                    var_type: crate::models::task_template::VariableType::String,
                    default_value: Some("src/".to_string()),
                    required: false,
                    description: Some("要审查的代码路径".to_string()),
                    options: None,
                },
                TemplateVariable {
                    id: "focusArea".to_string(),
                    name: "关注领域".to_string(),
                    var_type: crate::models::task_template::VariableType::Select,
                    default_value: Some("全部".to_string()),
                    required: false,
                    description: Some("审查关注点".to_string()),
                    options: Some(vec![
                        "全部".to_string(),
                        "安全性".to_string(),
                        "性能".to_string(),
                        "可维护性".to_string(),
                        "代码风格".to_string(),
                    ]),
                },
            ],
            documents: vec![
                TemplateDocument {
                    filename: "task.md".to_string(),
                    content: r#"# 代码审查任务

## 审查目标

- 路径: {{targetPath}}
- 关注点: {{focusArea}}

## 工作区

```
{{workspacePath}}
```

## 任务目标

1. 审查指定路径下的代码
2. 检查潜在问题和改进点
3. 生成审查报告

## 审查要点

### 安全性
- SQL 注入风险
- XSS 漏洞
- 敏感信息泄露

### 性能
- 循环优化
- 内存使用
- 异步处理

### 可维护性
- 代码复杂度
- 命名规范
- 注释完整性
"#.to_string(),
                    is_primary: true,
                    description: Some("代码审查任务文档".to_string()),
                },
                TemplateDocument {
                    filename: "user.md".to_string(),
                    content: r#"# 审查重点补充

> 用于指定本次审查的特殊关注点

---

<!-- 在下方添加审查重点 -->

"#.to_string(),
                    is_primary: false,
                    description: Some("用户补充文档".to_string()),
                },
            ],
            primary_document: "task.md".to_string(),
            created_at: now.clone(),
            updated_at: now,
            author: Some("Polaris".to_string()),
        }
    }

    fn list_custom_templates(&self) -> Result<Vec<TaskTemplate>> {
        let custom_dir = self.storage_dir.join(CUSTOM_DIR_NAME);
        if !custom_dir.exists() {
            return Ok(Vec::new());
        }

        let mut templates = Vec::new();
        for entry in std::fs::read_dir(&custom_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                let template_file = path.join(TEMPLATE_FILE_NAME);
                if template_file.exists() {
                    if let Ok(content) = std::fs::read_to_string(&template_file) {
                        if let Ok(template) = serde_json::from_str::<TaskTemplate>(&content) {
                            templates.push(template);
                        }
                    }
                }
            }
        }

        Ok(templates)
    }

    fn save_custom_template(&self, template: &TaskTemplate) -> Result<()> {
        let template_dir = self.storage_dir.join(CUSTOM_DIR_NAME).join(&template.id);
        std::fs::create_dir_all(&template_dir)?;

        let template_file = template_dir.join(TEMPLATE_FILE_NAME);
        let content = serde_json::to_string_pretty(template)?;
        std::fs::write(&template_file, format!("{}\n", content))?;

        Ok(())
    }
}

// =========================================================================
// Helper functions
// =========================================================================

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
