//! Document Workspace Repository
//!
//! Manages task document workspaces.

use crate::error::{AppError, Result};
use crate::models::document_workspace::{
    CreateWorkspaceParams, DocumentWorkspace, ExecutionSummary, RenderResult, RenderedDocument,
    VariableInstance, WorkspaceDocument, DocumentType,
};
use crate::models::task_template::TaskTemplate;
use chrono::Utc;
use regex::Regex;
use std::collections::HashMap;
use std::path::PathBuf;

const WORKSPACES_DIR_NAME: &str = "workspaces";
const WORKSPACE_FILE_NAME: &str = "workspace.json";

/// Repository for managing document workspaces
pub struct DocumentWorkspaceRepository {
    /// Storage directory (config_dir/scheduler/workspaces)
    storage_dir: PathBuf,
}

impl DocumentWorkspaceRepository {
    /// Create a new document workspace repository
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            storage_dir: config_dir.join("scheduler").join(WORKSPACES_DIR_NAME),
        }
    }

    /// Get workspace for a task
    pub fn get_workspace(&self, task_id: &str) -> Result<Option<DocumentWorkspace>> {
        let workspace_file = self.storage_dir.join(task_id).join(WORKSPACE_FILE_NAME);
        if !workspace_file.exists() {
            return Ok(None);
        }

        let content = std::fs::read_to_string(&workspace_file)?;
        let workspace: DocumentWorkspace = serde_json::from_str(&content)
            .map_err(AppError::from)?;

        Ok(Some(workspace))
    }

    /// Create a new workspace for a task
    pub fn create_workspace(
        &self,
        params: CreateWorkspaceParams,
        template: Option<&TaskTemplate>,
    ) -> Result<DocumentWorkspace> {
        // Check if workspace already exists
        if let Some(existing) = self.get_workspace(&params.task_id)? {
            return Ok(existing);
        }

        let now = now_iso();
        let (documents, variables, primary_document) = if let Some(tpl) = template {
            // Initialize from template
            let docs: Vec<WorkspaceDocument> = tpl
                .documents
                .iter()
                .map(|d| WorkspaceDocument {
                    filename: d.filename.clone(),
                    doc_type: infer_document_type(&d.filename),
                    content: d.content.clone(),
                    is_primary: d.is_primary,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                })
                .collect();

            let vars: Vec<VariableInstance> = tpl
                .variables
                .iter()
                .map(|v| VariableInstance {
                    variable_id: v.id.clone(),
                    name: v.name.clone(),
                    value: v.default_value.clone().unwrap_or_default(),
                    from_template: true,
                })
                .collect();

            // Add initial variables from params
            let mut vars = vars;
            if let Some(initial_vars) = params.initial_variables {
                for (key, value) in initial_vars {
                    if let Some(var) = vars.iter_mut().find(|v| v.variable_id == key || v.name == key) {
                        var.value = value;
                    } else {
                        vars.push(VariableInstance {
                            variable_id: key.clone(),
                            name: key,
                            value,
                            from_template: false,
                        });
                    }
                }
            }

            (docs, vars, tpl.primary_document.clone())
        } else {
            // Create default workspace with basic documents
            let docs = vec![
                WorkspaceDocument {
                    filename: "task.md".to_string(),
                    doc_type: DocumentType::Task,
                    content: default_task_content(),
                    is_primary: true,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
                WorkspaceDocument {
                    filename: "user.md".to_string(),
                    doc_type: DocumentType::User,
                    content: default_user_content(),
                    is_primary: false,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
                WorkspaceDocument {
                    filename: "memory/index.md".to_string(),
                    doc_type: DocumentType::Memory,
                    content: default_memory_content(),
                    is_primary: false,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
            ];
            (docs, Vec::new(), "task.md".to_string())
        };

        let workspace = DocumentWorkspace {
            id: params.task_id.clone(),
            task_id: params.task_id,
            template_id: params.template_id,
            documents,
            primary_document,
            variables,
            execution_history: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        };

        self.save_workspace(&workspace)?;
        Ok(workspace)
    }

    /// Update a workspace
    pub fn update_workspace(
        &self,
        task_id: &str,
        documents: Option<Vec<WorkspaceDocument>>,
        variables: Option<Vec<VariableInstance>>,
    ) -> Result<DocumentWorkspace> {
        let mut workspace = self
            .get_workspace(task_id)?
            .ok_or_else(|| AppError::ValidationError(format!("工作区不存在: {}", task_id)))?;

        if let Some(docs) = documents {
            workspace.documents = docs;
        }

        if let Some(vars) = variables {
            workspace.variables = vars;
        }

        workspace.updated_at = now_iso();
        self.save_workspace(&workspace)?;
        Ok(workspace)
    }

    /// Delete a workspace
    pub fn delete_workspace(&self, task_id: &str) -> Result<()> {
        let workspace_dir = self.storage_dir.join(task_id);
        if workspace_dir.exists() {
            std::fs::remove_dir_all(&workspace_dir)?;
        }
        Ok(())
    }

    /// Update a single document
    pub fn update_document(
        &self,
        task_id: &str,
        filename: &str,
        content: &str,
    ) -> Result<DocumentWorkspace> {
        let mut workspace = self
            .get_workspace(task_id)?
            .ok_or_else(|| AppError::ValidationError(format!("工作区不存在: {}", task_id)))?;

        let now = now_iso();
        if let Some(doc) = workspace.documents.iter_mut().find(|d| d.filename == filename) {
            doc.content = content.to_string();
            doc.updated_at = now.clone();
        } else {
            // Add new document
            workspace.documents.push(WorkspaceDocument {
                filename: filename.to_string(),
                doc_type: infer_document_type(filename),
                content: content.to_string(),
                is_primary: false,
                created_at: now.clone(),
                updated_at: now,
            });
        }

        workspace.updated_at = now_iso();
        self.save_workspace(&workspace)?;
        Ok(workspace)
    }

    /// Render documents with variable substitution
    pub fn render_documents(
        &self,
        task_id: &str,
        task_name: &str,
        workspace_path: Option<&str>,
        workspace_name: Option<&str>,
        run_count: usize,
        last_run_time: Option<i64>,
    ) -> Result<RenderResult> {
        let workspace = self
            .get_workspace(task_id)?
            .ok_or_else(|| AppError::ValidationError(format!("工作区不存在: {}", task_id)))?;

        let renderer = VariableRenderer::new(
            task_id,
            task_name,
            workspace_path,
            workspace_name,
            run_count,
            last_run_time,
            workspace.variables.iter().map(|v| (v.name.clone(), v.value.clone())).collect(),
        );

        let mut variables_map = HashMap::new();
        for v in &workspace.variables {
            variables_map.insert(v.name.clone(), v.value.clone());
        }

        // Add builtin variables
        variables_map.extend(renderer.get_builtin_variables());

        let documents: Vec<RenderedDocument> = workspace
            .documents
            .iter()
            .map(|d| RenderedDocument {
                filename: d.filename.clone(),
                content: renderer.render(&d.content),
                is_primary: d.is_primary,
            })
            .collect();

        let primary_document = documents
            .iter()
            .find(|d| d.is_primary)
            .cloned()
            .or_else(|| documents.first().cloned());

        Ok(RenderResult {
            documents,
            variables: variables_map,
            primary_document,
        })
    }

    /// Add user supplement content
    pub fn append_to_user_document(
        &self,
        task_id: &str,
        content: &str,
    ) -> Result<DocumentWorkspace> {
        let mut workspace = self
            .get_workspace(task_id)?
            .ok_or_else(|| AppError::ValidationError(format!("工作区不存在: {}", task_id)))?;

        let now = now_iso();
        if let Some(user_doc) = workspace
            .documents
            .iter_mut()
            .find(|d| d.doc_type == DocumentType::User)
        {
            user_doc.content = format!("{}\n\n---\n\n{}\n", user_doc.content.trim_end(), content);
            user_doc.updated_at = now.clone();
        } else {
            // Create user document if not exists
            workspace.documents.push(WorkspaceDocument {
                filename: "user.md".to_string(),
                doc_type: DocumentType::User,
                content: format!("{}\n", content),
                is_primary: false,
                created_at: now.clone(),
                updated_at: now,
            });
        }

        workspace.updated_at = now_iso();
        self.save_workspace(&workspace)?;
        Ok(workspace)
    }

    /// Archive user document (clear after execution)
    pub fn archive_user_document(&self, task_id: &str) -> Result<DocumentWorkspace> {
        let mut workspace = self
            .get_workspace(task_id)?
            .ok_or_else(|| AppError::ValidationError(format!("工作区不存在: {}", task_id)))?;

        let now = now_iso();
        if let Some(user_doc) = workspace
            .documents
            .iter_mut()
            .find(|d| d.doc_type == DocumentType::User)
        {
            user_doc.content = default_user_content();
            user_doc.updated_at = now.clone();
        }

        workspace.updated_at = now;
        self.save_workspace(&workspace)?;
        Ok(workspace)
    }

    /// Add execution summary
    pub fn add_execution_summary(
        &self,
        task_id: &str,
        status: &str,
        duration: Option<f64>,
        summary: Option<&str>,
    ) -> Result<DocumentWorkspace> {
        let mut workspace = self
            .get_workspace(task_id)?
            .ok_or_else(|| AppError::ValidationError(format!("工作区不存在: {}", task_id)))?;

        let now = now_iso();
        workspace.execution_history.push(ExecutionSummary {
            timestamp: now.clone(),
            status: status.to_string(),
            duration,
            summary: summary.map(|s| s.to_string()),
            has_user_supplement: workspace
                .documents
                .iter()
                .find(|d| d.doc_type == DocumentType::User)
                .map(|d| !d.content.trim().is_empty() && d.content != default_user_content())
                .unwrap_or(false),
        });

        workspace.updated_at = now;
        self.save_workspace(&workspace)?;
        Ok(workspace)
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    fn save_workspace(&self, workspace: &DocumentWorkspace) -> Result<()> {
        let workspace_dir = self.storage_dir.join(&workspace.task_id);
        std::fs::create_dir_all(&workspace_dir)?;

        let workspace_file = workspace_dir.join(WORKSPACE_FILE_NAME);
        let content = serde_json::to_string_pretty(workspace)?;
        std::fs::write(&workspace_file, format!("{}\n", content))?;

        Ok(())
    }
}

// =========================================================================
// Variable Renderer
// =========================================================================

struct VariableRenderer {
    builtin_values: HashMap<String, String>,
    custom_values: HashMap<String, String>,
}

impl VariableRenderer {
    fn new(
        task_id: &str,
        task_name: &str,
        workspace_path: Option<&str>,
        workspace_name: Option<&str>,
        run_count: usize,
        last_run_time: Option<i64>,
        custom_variables: HashMap<String, String>,
    ) -> Self {
        let now = Utc::now();
        let mut builtin_values = HashMap::new();

        // Time-related variables
        builtin_values.insert(
            "timestamp".to_string(),
            now.timestamp_millis().to_string(),
        );
        builtin_values.insert(
            "datetime".to_string(),
            now.format("%Y-%m-%d %H:%M:%S").to_string(),
        );
        builtin_values.insert(
            "date".to_string(),
            now.format("%Y-%m-%d").to_string(),
        );
        builtin_values.insert(
            "time".to_string(),
            now.format("%H:%M:%S").to_string(),
        );

        // Task-related variables
        builtin_values.insert("taskId".to_string(), task_id.to_string());
        builtin_values.insert("taskName".to_string(), task_name.to_string());
        builtin_values.insert("runCount".to_string(), run_count.to_string());

        // Workspace-related variables
        builtin_values.insert(
            "workspacePath".to_string(),
            workspace_path.unwrap_or("").to_string(),
        );
        builtin_values.insert(
            "workspaceName".to_string(),
            workspace_name.unwrap_or("").to_string(),
        );

        // Last run time
        if let Some(ts) = last_run_time {
            let dt = chrono::DateTime::from_timestamp(ts, 0)
                .map(|utc| utc.with_timezone(&chrono::Local))
                .unwrap_or_else(|| now.with_timezone(&chrono::Local));
            builtin_values.insert(
                "lastRunTime".to_string(),
                dt.format("%Y-%m-%d %H:%M:%S").to_string(),
            );
        }

        Self {
            builtin_values,
            custom_values: custom_variables,
        }
    }

    fn get_builtin_variables(&self) -> HashMap<String, String> {
        self.builtin_values.clone()
    }

    fn render(&self, content: &str) -> String {
        let mut result = content.to_string();

        // Replace simple variables {{variableName}}
        let simple_var_pattern = Regex::new(r"\{\{(\w+)\}\}").unwrap();
        result = simple_var_pattern
            .replace_all(&result, |caps: &regex::Captures| {
                let var_name = &caps[1];
                self.get_value(var_name)
            })
            .to_string();

        // Replace formatted variables {{datetime:format}} etc.
        let formatted_var_pattern = Regex::new(r"\{\{(\w+):([^}]+)\}\}").unwrap();
        result = formatted_var_pattern
            .replace_all(&result, |caps: &regex::Captures| {
                let var_name = &caps[1];
                let format_str = &caps[2];
                self.get_formatted_value(var_name, format_str)
            })
            .to_string();

        result
    }

    fn get_value(&self, name: &str) -> String {
        self.custom_values
            .get(name)
            .or_else(|| self.builtin_values.get(name))
            .cloned()
            .unwrap_or_default()
    }

    fn get_formatted_value(&self, name: &str, format_str: &str) -> String {
        match name {
            "datetime" | "date" | "time" => {
                let now = chrono::Local::now();
                now.format(format_str).to_string()
            }
            _ => self.get_value(name),
        }
    }
}

// =========================================================================
// Helper functions
// =========================================================================

fn infer_document_type(filename: &str) -> DocumentType {
    if filename.contains("task") {
        DocumentType::Task
    } else if filename.contains("user") {
        DocumentType::User
    } else if filename.contains("memory") {
        DocumentType::Memory
    } else {
        DocumentType::Custom
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn default_task_content() -> String {
    r#"# 任务协议

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
"#.to_string()
}

fn default_user_content() -> String {
    r#"# 用户补充

> 用于临时添加要求或调整任务内容

---

<!-- 在下方添加补充内容 -->

"#.to_string()
}

fn default_memory_content() -> String {
    r#"# 成果索引

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
"#.to_string()
}
