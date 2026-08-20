//! Scheduler Models
//!
//! Data models for scheduled task management with support for both
//! simple mode and protocol mode (document-driven workflow).

use chrono::Datelike;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================================
// Core Types
// ============================================================================

/// 触发类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TriggerType {
    /// 单次执行
    Once,
    /// Cron 表达式
    Cron,
    /// 间隔执行（支持 s/m/h/d）
    #[default]
    Interval,
    /// 完成后间隔：上次任务完成后等待指定时间再触发下一次
    AfterCompletion,
}

/// 任务状态
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Running,
    Success,
    Failed,
}

/// 任务模式
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TaskMode {
    /// 简单模式：直接使用 prompt
    #[default]
    Simple,
    /// 协议模式：使用文档驱动的工作流
    Protocol,
}

impl std::fmt::Display for TaskMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskMode::Simple => write!(f, "simple"),
            TaskMode::Protocol => write!(f, "protocol"),
        }
    }
}

/// 任务分类（用于模板分组）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TaskCategory {
    /// 开发任务
    #[default]
    Development,
    /// 审查任务
    Review,
    /// 新闻搜索
    News,
    /// 监控任务
    Monitor,
    /// 自定义
    Custom,
}

// ============================================================================
// Protocol Template
// ============================================================================

/// 协议模板参数类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TemplateParamType {
    /// 单行文本
    Text,
    /// 多行文本
    Textarea,
    /// 下拉选择
    Select,
    /// 数字
    Number,
    /// 日期
    Date,
}

/// 模板选择选项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectOption {
    /// 选项值
    pub value: String,
    /// 选项标签
    pub label: String,
}

/// 协议模板参数定义
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateParam {
    /// 参数键（用于占位符匹配）
    pub key: String,
    /// 显示标签
    pub label: String,
    /// 参数类型
    #[serde(rename = "type")]
    pub param_type: TemplateParamType,
    /// 是否必填
    #[serde(default)]
    pub required: bool,
    /// 默认值
    #[serde(default)]
    pub default_value: Option<String>,
    /// 占位提示
    #[serde(default)]
    pub placeholder: Option<String>,
    /// 选择选项（select 类型使用）
    #[serde(default)]
    pub options: Option<Vec<SelectOption>>,
}

/// 协议模板配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolTemplateConfig {
    /// 任务目标模板
    #[serde(default)]
    pub mission_template: String,
    /// 执行规则模板（可选）
    #[serde(default)]
    pub execution_rules: Option<String>,
    /// 记忆规则模板（可选）
    #[serde(default)]
    pub memory_rules: Option<String>,
    /// 自定义区块模板（可选）
    #[serde(default)]
    pub custom_sections: Option<Vec<CustomSection>>,
}

/// 自定义区块
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSection {
    /// 区块标题
    pub title: String,
    /// 区块模板内容
    pub template: String,
    /// 区块位置
    #[serde(default)]
    pub position: SectionPosition,
}

/// 区块位置
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SectionPosition {
    /// 在执行规则之前
    BeforeRules,
    /// 在执行规则之后
    #[default]
    AfterRules,
    /// 在记忆规则之后
    AfterMemory,
}

/// 协议任务模板
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolTemplate {
    /// 模板 ID
    pub id: String,
    /// 模板名称
    pub name: String,
    /// 模板描述
    #[serde(default)]
    pub description: Option<String>,
    /// 模板分类
    pub category: TaskCategory,
    /// 是否为内置模板
    #[serde(default)]
    pub builtin: bool,
    /// 协议模板配置
    pub protocol_config: ProtocolTemplateConfig,
    /// 提示词模板（用于生成最终 prompt）
    #[serde(default)]
    pub prompt_template: Option<String>,
    /// 模板参数定义
    #[serde(default)]
    pub params: Vec<TemplateParam>,
    /// 默认触发类型
    #[serde(default)]
    pub default_trigger_type: Option<TriggerType>,
    /// 默认触发值
    #[serde(default)]
    pub default_trigger_value: Option<String>,
    /// 默认引擎 ID
    #[serde(default)]
    pub default_engine_id: Option<String>,
    /// 默认最大执行次数
    #[serde(default)]
    pub default_max_runs: Option<u32>,
    /// 默认超时时间（分钟）
    #[serde(default)]
    pub default_timeout_minutes: Option<u32>,
    /// 是否启用
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 创建时间
    pub created_at: i64,
    /// 更新时间
    pub updated_at: i64,
}

/// 创建协议模板参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProtocolTemplateParams {
    /// 模板名称
    pub name: String,
    /// 模板描述
    #[serde(default)]
    pub description: Option<String>,
    /// 模板分类
    pub category: TaskCategory,
    /// 协议模板配置
    pub protocol_config: ProtocolTemplateConfig,
    /// 提示词模板
    #[serde(default)]
    pub prompt_template: Option<String>,
    /// 模板参数定义
    #[serde(default)]
    pub params: Vec<TemplateParam>,
    /// 默认触发类型
    #[serde(default)]
    pub default_trigger_type: Option<TriggerType>,
    /// 默认触发值
    #[serde(default)]
    pub default_trigger_value: Option<String>,
    /// 默认引擎 ID
    #[serde(default)]
    pub default_engine_id: Option<String>,
    /// 默认最大执行次数
    #[serde(default)]
    pub default_max_runs: Option<u32>,
    /// 默认超时时间
    #[serde(default)]
    pub default_timeout_minutes: Option<u32>,
    /// 是否启用
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// 协议模板存储
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProtocolTemplateStore {
    pub version: String,
    pub templates: Vec<ProtocolTemplate>,
}

// ============================================================================
// Prompt Template (Simple Mode)
// ============================================================================

/// 提示词模板（简单模式使用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    /// 模板 ID
    pub id: String,
    /// 模板名称
    pub name: String,
    /// 模板描述
    #[serde(default)]
    pub description: Option<String>,
    /// 模板内容，支持占位符：{{prompt}}, {{taskName}}, {{date}}, {{time}}, {{datetime}}, {{weekday}}
    pub content: String,
    /// 是否启用
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 创建时间
    pub created_at: i64,
    /// 更新时间
    pub updated_at: i64,
}

/// 创建模板参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTemplateParams {
    /// 模板名称
    pub name: String,
    /// 模板描述
    #[serde(default)]
    pub description: Option<String>,
    /// 模板内容
    pub content: String,
    /// 是否启用
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// 模板存储
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TemplateStore {
    pub version: String,
    pub templates: Vec<PromptTemplate>,
}

// ============================================================================
// Task Model
// ============================================================================

/// 定时任务
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    // === 基础属性 ===
    /// 任务 ID
    pub id: String,
    /// 任务名称
    pub name: String,
    /// 是否启用
    pub enabled: bool,
    /// 触发类型
    pub trigger_type: TriggerType,
    /// 触发值
    /// - once: ISO 时间戳字符串 (如 "2024-03-16T14:00:00Z")
    /// - cron: Cron 表达式 (如 "0 9 * * 1-5")
    /// - interval: 间隔表达式 (如 "30s", "5m", "2h", "1d")
    pub trigger_value: String,
    /// 使用的引擎 ID
    pub engine_id: String,
    /// 提示词 (simple 模式使用)
    pub prompt: String,
    /// 工作目录（可选）
    pub work_dir: Option<String>,
    /// 任务描述（可选）
    pub description: Option<String>,

    // === 状态属性 ===
    /// 上次执行时间
    pub last_run_at: Option<i64>,
    /// 上次执行状态
    pub last_run_status: Option<TaskStatus>,
    /// 下次执行时间
    pub next_run_at: Option<i64>,
    /// 创建时间
    pub created_at: i64,
    /// 更新时间
    pub updated_at: i64,

    // === 工作区关联 ===
    /// 所属工作区路径
    #[serde(default)]
    pub workspace_path: Option<String>,
    /// 所属工作区名称
    #[serde(default)]
    pub workspace_name: Option<String>,

    // === 任务模式 ===
    /// 任务模式
    #[serde(default)]
    pub mode: TaskMode,
    /// 任务分类
    #[serde(default)]
    pub category: TaskCategory,

    // === 协议模式属性 ===
    /// 任务文档路径 (protocol 模式)
    #[serde(default)]
    pub task_path: Option<String>,
    /// 任务目标 (protocol 模式)
    #[serde(default)]
    pub mission: Option<String>,
    /// 模板 ID
    #[serde(default)]
    pub template_id: Option<String>,
    /// 模板参数
    #[serde(default)]
    pub template_params: Option<HashMap<String, String>>,

    // === 执行控制 ===
    /// 最大执行次数 (protocol 模式)
    #[serde(default)]
    pub max_runs: Option<u32>,
    /// 当前执行次数
    #[serde(default)]
    pub current_runs: u32,
    /// 最大重试次数
    #[serde(default)]
    pub max_retries: Option<u32>,
    /// 当前重试次数
    #[serde(default)]
    pub retry_count: u32,
    /// 重试间隔
    #[serde(default)]
    pub retry_interval: Option<String>,
    /// 超时时间（分钟）
    #[serde(default)]
    pub timeout_minutes: Option<u32>,

    // === 其他 ===
    /// 分组
    #[serde(default)]
    pub group: Option<String>,
    /// 完成通知
    #[serde(default = "default_true")]
    pub notify_on_complete: bool,
}

/// 创建任务参数
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskParams {
    // === 基础属性 ===
    /// 任务名称
    pub name: String,
    /// 是否启用
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 触发类型
    pub trigger_type: TriggerType,
    /// 触发值
    pub trigger_value: String,
    /// 使用的引擎 ID
    pub engine_id: String,
    /// 提示词 (simple 模式使用)
    pub prompt: String,
    /// 工作目录（可选）
    pub work_dir: Option<String>,
    /// 任务描述（可选）
    pub description: Option<String>,

    // === 工作区关联 ===
    /// 所属工作区路径
    #[serde(default)]
    pub workspace_path: Option<String>,
    /// 所属工作区名称
    #[serde(default)]
    pub workspace_name: Option<String>,

    // === 任务模式 ===
    /// 任务模式
    #[serde(default)]
    pub mode: TaskMode,
    /// 任务分类
    #[serde(default)]
    pub category: TaskCategory,

    // === 协议模式属性 ===
    /// 任务目标 (protocol 模式)
    #[serde(default)]
    pub mission: Option<String>,
    /// 模板 ID
    #[serde(default)]
    pub template_id: Option<String>,
    /// 模板参数
    #[serde(default)]
    pub template_params: Option<HashMap<String, String>>,

    // === 执行控制 ===
    /// 最大执行次数 (protocol 模式)
    #[serde(default)]
    pub max_runs: Option<u32>,
    /// 最大重试次数
    #[serde(default)]
    pub max_retries: Option<u32>,
    /// 重试间隔
    #[serde(default)]
    pub retry_interval: Option<String>,
    /// 超时时间（分钟）
    #[serde(default)]
    pub timeout_minutes: Option<u32>,

    // === 其他 ===
    /// 分组
    #[serde(default)]
    pub group: Option<String>,
    /// 完成通知
    #[serde(default = "default_true")]
    pub notify_on_complete: bool,
}

fn default_enabled() -> bool {
    true
}

fn default_true() -> bool {
    true
}

/// 任务存储
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskStore {
    pub tasks: Vec<ScheduledTask>,
}

// ============================================================================
// Helper Methods
// ============================================================================

impl TriggerType {
    /// 解析触发值，计算下次执行时间
    pub fn calculate_next_run(&self, trigger_value: &str, now: i64) -> Option<i64> {
        match self {
            TriggerType::Once => {
                // 解析 ISO 时间戳
                chrono::DateTime::parse_from_rfc3339(trigger_value)
                    .ok()
                    .map(|dt| dt.timestamp())
                    .filter(|&ts| ts > now)
            }
            TriggerType::Cron => {
                // 解析 Cron 表达式
                use cron::Schedule;
                use std::str::FromStr;

                Schedule::from_str(trigger_value)
                    .ok()
                    .and_then(|schedule| {
                        schedule
                            .upcoming(chrono::Utc)
                            .next()
                            .map(|dt| dt.timestamp())
                    })
            }
            TriggerType::Interval | TriggerType::AfterCompletion => {
                // 解析间隔表达式 (30s, 5m, 2h, 1d)
                parse_interval(trigger_value)
                    .map(|interval_secs| now + interval_secs)
            }
        }
    }
}

/// 解析间隔表达式，返回秒数
/// 支持格式: 30s, 5m, 2h, 1d
pub fn parse_interval(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    let (num_str, unit) = value.split_at(value.len() - 1);
    let num: i64 = num_str.parse().ok()?;

    let multiplier = match unit.to_lowercase().as_str() {
        "s" => 1,           // 秒
        "m" => 60,          // 分钟
        "h" => 3600,        // 小时
        "d" => 86400,       // 天
        _ => return None,
    };

    Some(num * multiplier)
}

/// 星期几中文名称
fn weekday_name(weekday: chrono::Weekday) -> &'static str {
    match weekday {
        chrono::Weekday::Mon => "星期一",
        chrono::Weekday::Tue => "星期二",
        chrono::Weekday::Wed => "星期三",
        chrono::Weekday::Thu => "星期四",
        chrono::Weekday::Fri => "星期五",
        chrono::Weekday::Sat => "星期六",
        chrono::Weekday::Sun => "星期日",
    }
}

/// 应用模板变量替换
/// 支持的变量：{{prompt}}, {{taskName}}, {{date}}, {{time}}, {{datetime}}, {{weekday}}
pub fn apply_template(template: &str, task_name: &str, user_prompt: &str) -> String {
    let now = chrono::Utc::now();

    template
        .replace("{{prompt}}", user_prompt)
        .replace("{{taskName}}", task_name)
        .replace("{{date}}", &now.format("%Y-%m-%d").to_string())
        .replace("{{time}}", &now.format("%H:%M").to_string())
        .replace("{{datetime}}", &now.format("%Y-%m-%d %H:%M").to_string())
        .replace("{{weekday}}", weekday_name(now.weekday()))
}

// ============================================================================
// Built-in Protocol Templates
// ============================================================================

/// 获取内置协议模板列表
pub fn get_builtin_protocol_templates() -> Vec<ProtocolTemplate> {
    let now = chrono::Utc::now().timestamp();

    vec![
        // 开发任务模板
        ProtocolTemplate {
            id: "dev-feature".to_string(),
            name: "功能开发".to_string(),
            description: Some("用于持续开发新功能的任务模板，包含需求分析、实现、测试等阶段".to_string()),
            category: TaskCategory::Development,
            builtin: true,
            protocol_config: ProtocolTemplateConfig {
                mission_template: "帮我开发以下功能：\n\n{mission}\n\n请按照以下步骤执行：\n1. 分析需求和现有代码结构\n2. 设计实现方案\n3. 编写代码实现\n4. 编写测试用例\n5. 进行代码审查和优化".to_string(),
                execution_rules: Some(r#"### 1. 检查用户补充
- 读取用户补充文件
- 如有新内容，优先处理并归档

### 2. 推进主任务
- 读取记忆索引了解当前进度
- 选择下一个待办事项执行
- 完成后更新记忆

### 3. 记忆更新
- 新成果写入记忆文件
- 待办任务写入任务文件"#.to_string()),
                memory_rules: Some(r#"## 成果定义

有价值的工作：
- 完成具体功能实现
- 修复已知问题
- 优化代码质量
- 产出可复用资产

避免：
- 无产出的探索
- 重复性工作"#.to_string()),
                custom_sections: None,
            },
            prompt_template: None,
            params: vec![
                TemplateParam {
                    key: "mission".to_string(),
                    label: "任务目标".to_string(),
                    param_type: TemplateParamType::Textarea,
                    required: true,
                    default_value: None,
                    placeholder: Some("描述要开发的功能...".to_string()),
                    options: None,
                },
            ],
            default_trigger_type: Some(TriggerType::Interval),
            default_trigger_value: Some("1h".to_string()),
            default_engine_id: Some("claude-code".to_string()),
            default_max_runs: None,
            default_timeout_minutes: None,
            enabled: true,
            created_at: now,
            updated_at: now,
        },

        // 协议协助模式模板
        ProtocolTemplate {
            id: "protocol-assist".to_string(),
            name: "协议协助模式".to_string(),
            description: Some("完整的协议任务模板，支持任务目标和用户补充内容".to_string()),
            category: TaskCategory::Development,
            builtin: true,
            protocol_config: ProtocolTemplateConfig {
                mission_template: "{mission}".to_string(),
                execution_rules: Some(r#"### 1. 检查用户补充
- 读取 `.polaris/tasks/{taskId}/supplement.md`
- 如有新内容，优先处理并归档

### 2. 推进主任务
- 读取 `memory/index.md` 了解当前进度
- 选择下一个待办事项执行
- 完成后更新记忆

### 3. 记忆更新
- 新成果写入 `memory/index.md`
- 待办任务写入 `memory/tasks.md`

### 4. 文档备份
- 用户补充处理完成后迁移到 `supplement-history/`
- 文档超过 800 行时总结后备份"#.to_string()),
                memory_rules: Some(r#"## 成果定义

有价值的工作：
- 完成具体功能实现
- 修复已知问题
- 优化代码质量
- 产出可复用资产

避免：
- 无产出的探索
- 重复性工作"#.to_string()),
                custom_sections: None,
            },
            prompt_template: None,
            params: vec![
                TemplateParam {
                    key: "mission".to_string(),
                    label: "任务目标".to_string(),
                    param_type: TemplateParamType::Textarea,
                    required: true,
                    default_value: None,
                    placeholder: Some("描述任务目标...".to_string()),
                    options: None,
                },
            ],
            default_trigger_type: Some(TriggerType::Interval),
            default_trigger_value: Some("1h".to_string()),
            default_engine_id: Some("claude-code".to_string()),
            default_max_runs: None,
            default_timeout_minutes: None,
            enabled: true,
            created_at: now,
            updated_at: now,
        },

        // 审查任务模板
        ProtocolTemplate {
            id: "review-code".to_string(),
            name: "代码审查".to_string(),
            description: Some("用于定期审查代码质量的任务模板".to_string()),
            category: TaskCategory::Review,
            builtin: true,
            protocol_config: ProtocolTemplateConfig {
                mission_template: "审查以下代码：\n\n{mission}\n\n审查要点：\n- 代码质量\n- 安全问题\n- 性能问题\n- 测试覆盖".to_string(),
                execution_rules: Some(r#"### 1. 收集信息
- 获取待审查的代码变更
- 分析代码结构

### 2. 执行审查
- 检查代码质量
- 分析潜在问题
- 提出改进建议

### 3. 汇报结果
- 总结审查发现
- 提供改进建议"#.to_string()),
                memory_rules: Some(r#"## 审查清单

- [ ] 代码质量
- [ ] 安全问题
- [ ] 性能问题
- [ ] 测试覆盖
- [ ] 文档完整"#.to_string()),
                custom_sections: None,
            },
            prompt_template: None,
            params: vec![
                TemplateParam {
                    key: "mission".to_string(),
                    label: "审查范围".to_string(),
                    param_type: TemplateParamType::Textarea,
                    required: true,
                    default_value: None,
                    placeholder: Some("描述要审查的代码范围...".to_string()),
                    options: None,
                },
            ],
            default_trigger_type: Some(TriggerType::Interval),
            default_trigger_value: Some("6h".to_string()),
            default_engine_id: Some("claude-code".to_string()),
            default_max_runs: None,
            default_timeout_minutes: Some(30),
            enabled: true,
            created_at: now,
            updated_at: now,
        },

        // 新闻任务模板
        ProtocolTemplate {
            id: "news-search".to_string(),
            name: "新闻搜索".to_string(),
            description: Some("用于搜索和总结新闻的任务模板".to_string()),
            category: TaskCategory::News,
            builtin: true,
            protocol_config: ProtocolTemplateConfig {
                mission_template: "搜索以下关键词的新闻：\n\n{keywords}\n\n时间范围：{timeRange}".to_string(),
                execution_rules: Some(r#"### 1. 搜索新闻
- 使用指定关键词搜索
- 筛选相关新闻
- 记录来源

### 2. 总结要点
- 提取关键信息
- 分类整理
- 生成摘要

### 3. 汇报结果
- 汇总新闻要点
- 提供原文链接"#.to_string()),
                memory_rules: Some(r#"## 搜索范围

- 关键词: {keywords}
- 时间范围: {timeRange}
- 来源限制: {sources}"#.to_string()),
                custom_sections: None,
            },
            prompt_template: None,
            params: vec![
                TemplateParam {
                    key: "keywords".to_string(),
                    label: "搜索关键词".to_string(),
                    param_type: TemplateParamType::Text,
                    required: true,
                    default_value: None,
                    placeholder: Some("输入搜索关键词...".to_string()),
                    options: None,
                },
                TemplateParam {
                    key: "timeRange".to_string(),
                    label: "时间范围".to_string(),
                    param_type: TemplateParamType::Select,
                    required: true,
                    default_value: Some("1d".to_string()),
                    placeholder: None,
                    options: Some(vec![
                        SelectOption { value: "1d".to_string(), label: "最近一天".to_string() },
                        SelectOption { value: "3d".to_string(), label: "最近三天".to_string() },
                        SelectOption { value: "1w".to_string(), label: "最近一周".to_string() },
                        SelectOption { value: "1m".to_string(), label: "最近一月".to_string() },
                    ]),
                },
                TemplateParam {
                    key: "sources".to_string(),
                    label: "来源限制".to_string(),
                    param_type: TemplateParamType::Text,
                    required: false,
                    default_value: None,
                    placeholder: Some("可选，限制新闻来源".to_string()),
                    options: None,
                },
            ],
            default_trigger_type: Some(TriggerType::Interval),
            default_trigger_value: Some("12h".to_string()),
            default_engine_id: Some("claude-code".to_string()),
            default_max_runs: None,
            default_timeout_minutes: Some(15),
            enabled: true,
            created_at: now,
            updated_at: now,
        },

        // 监控任务模板
        ProtocolTemplate {
            id: "monitor-service".to_string(),
            name: "服务监控".to_string(),
            description: Some("用于监控服务状态的任务模板".to_string()),
            category: TaskCategory::Monitor,
            builtin: true,
            protocol_config: ProtocolTemplateConfig {
                mission_template: "监控以下服务：\n\n{service}\n\n监控项：\n- 服务可用性\n- 响应时间\n- 错误率".to_string(),
                execution_rules: Some(r#"### 1. 检查状态
- 获取服务状态
- 检查关键指标
- 记录数据

### 2. 分析问题
- 检测异常
- 分析原因
- 评估影响

### 3. 汇报结果
- 状态摘要
- 问题报告
- 建议措施"#.to_string()),
                memory_rules: Some(r#"## 监控指标

- 服务名称: {service}
- 检查频率: {interval}
- 告警阈值: {threshold}"#.to_string()),
                custom_sections: None,
            },
            prompt_template: None,
            params: vec![
                TemplateParam {
                    key: "service".to_string(),
                    label: "服务名称".to_string(),
                    param_type: TemplateParamType::Text,
                    required: true,
                    default_value: None,
                    placeholder: Some("输入服务名称...".to_string()),
                    options: None,
                },
                TemplateParam {
                    key: "interval".to_string(),
                    label: "检查间隔".to_string(),
                    param_type: TemplateParamType::Select,
                    required: true,
                    default_value: Some("5m".to_string()),
                    placeholder: None,
                    options: Some(vec![
                        SelectOption { value: "1m".to_string(), label: "1 分钟".to_string() },
                        SelectOption { value: "5m".to_string(), label: "5 分钟".to_string() },
                        SelectOption { value: "15m".to_string(), label: "15 分钟".to_string() },
                        SelectOption { value: "30m".to_string(), label: "30 分钟".to_string() },
                    ]),
                },
                TemplateParam {
                    key: "threshold".to_string(),
                    label: "告警阈值".to_string(),
                    param_type: TemplateParamType::Text,
                    required: false,
                    default_value: Some("响应时间 > 5s 或 错误率 > 5%".to_string()),
                    placeholder: None,
                    options: None,
                },
            ],
            default_trigger_type: Some(TriggerType::Interval),
            default_trigger_value: Some("5m".to_string()),
            default_engine_id: Some("claude-code".to_string()),
            default_max_runs: None,
            default_timeout_minutes: Some(5),
            enabled: true,
            created_at: now,
            updated_at: now,
        },
    ]
}

/// 渲染协议模板
pub fn render_protocol_template(template: &str, params: &HashMap<String, String>) -> String {
    let now = chrono::Utc::now();
    let mut result = template.to_string();

    // 替换系统占位符
    result = result.replace("{dateTime}", &now.format("%Y-%m-%d %H:%M").to_string());
    result = result.replace("{date}", &now.format("%Y-%m-%d").to_string());
    result = result.replace("{time}", &now.format("%H:%M").to_string());
    result = result.replace("{weekday}", weekday_name(now.weekday()));

    // 替换用户参数占位符
    for (key, value) in params {
        let placeholder = format!("{{{}}}", key);
        result = result.replace(&placeholder, value);
    }

    result
}

/// 生成协议文档
pub fn generate_protocol_document(template: &ProtocolTemplate, params: &HashMap<String, String>) -> String {
    let now = chrono::Utc::now();
    let date_time = now.format("%Y-%m-%d %H:%M:%S").to_string();

    // 渲染任务目标
    let mission = render_protocol_template(&template.protocol_config.mission_template, params);

    let mut doc = format!(
        r#"# 任务协议

> 任务ID: {{taskId}}
> 创建时间: {}
> 模板类型: {:?}
> 版本: 1.0.0

---

## 任务目标

{}

---

## 工作区

```
{{workspacePath}}
```

---

## 执行规则

{}
"#,
        date_time,
        template.category,
        mission,
        template.protocol_config.execution_rules.as_deref().unwrap_or("按需执行任务")
    );

    // 添加自定义区块
    if let Some(sections) = &template.protocol_config.custom_sections {
        for section in sections {
            let content = render_protocol_template(&section.template, params);
            doc.push_str(&format!("\n---\n\n## {}\n\n{}\n", section.title, content));
        }
    }

    // 添加记忆规则
    if let Some(memory_rules) = &template.protocol_config.memory_rules {
        let rules = render_protocol_template(memory_rules, params);
        doc.push_str(&format!("\n---\n\n{}\n", rules));
    }

    // 添加补充部分
    doc.push_str("\n---\n\n## 补充\n\n> 用于临时调整任务方向或补充要求\n\n");

    // 添加协议更新说明
    doc.push_str("\n---\n\n## 协议更新\n\n可修改本协议，修改时记录：\n- 修改内容\n- 修改原因\n- 预期效果\n");

    doc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_interval() {
        assert_eq!(parse_interval("30s"), Some(30));
        assert_eq!(parse_interval("5m"), Some(300));
        assert_eq!(parse_interval("2h"), Some(7200));
        assert_eq!(parse_interval("1d"), Some(86400));
        assert_eq!(parse_interval("invalid"), None);
    }

    #[test]
    fn test_calculate_next_run_interval() {
        let now = 1000i64;
        let next = TriggerType::Interval.calculate_next_run("5m", now);
        assert_eq!(next, Some(1000 + 300));
    }
}
