/*! 提示词配置模型
 *
 * 支持模块化的提示词管理，包括预设配置、场景映射等功能。
 */

use serde::{Deserialize, Serialize};

/// 场景类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SceneType {
    /// 主聊天场景
    #[default]
    Chat,
    /// 定时任务场景
    Scheduler,
    /// QQ 机器人场景
    Qqbot,
    /// Git 提交场景
    Commit,
}

impl SceneType {
    /// 转换为字符串
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Scheduler => "scheduler",
            Self::Qqbot => "qqbot",
            Self::Commit => "commit",
        }
    }

    /// 从字符串解析
    #[allow(dead_code)]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "chat" => Some(Self::Chat),
            "scheduler" => Some(Self::Scheduler),
            "qqbot" => Some(Self::Qqbot),
            "commit" => Some(Self::Commit),
            _ => None,
        }
    }
}

/// 提示词模块类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PromptModuleType {
    /// 工作区信息
    #[default]
    WorkspaceInfo,
    /// 待办管理
    TodoManagement,
    /// 需求队列
    RequirementQueue,
    /// 自定义模块
    Custom,
}

impl PromptModuleType {
    /// 转换为字符串
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::WorkspaceInfo => "workspace-info",
            Self::TodoManagement => "todo-management",
            Self::RequirementQueue => "requirement-queue",
            Self::Custom => "custom",
        }
    }

    /// 从字符串解析
    #[allow(dead_code)]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "workspace-info" => Some(Self::WorkspaceInfo),
            "todo-management" => Some(Self::TodoManagement),
            "requirement-queue" => Some(Self::RequirementQueue),
            "custom" => Some(Self::Custom),
            _ => None,
        }
    }
}

/// 提示词模块
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptModule {
    /// 模块 ID
    pub id: String,
    /// 模块类型
    #[serde(rename = "type")]
    pub module_type: PromptModuleType,
    /// 模块名称
    pub name: String,
    /// 模块描述
    #[serde(default)]
    pub description: Option<String>,
    /// 模块内容模板（支持变量替换）
    pub content: String,
    /// 是否启用
    #[serde(default = "default_module_enabled")]
    pub enabled: bool,
    /// 排序顺序（数字越小越靠前）
    #[serde(default)]
    pub order: i32,
    /// 创建时间
    pub created_at: i64,
    /// 更新时间
    pub updated_at: i64,
}

fn default_module_enabled() -> bool {
    true
}

impl PromptModule {
    /// 创建新模块
    pub fn new(id: String, module_type: PromptModuleType, name: String, content: String) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            id,
            module_type,
            name,
            description: None,
            content,
            enabled: true,
            order: 0,
            created_at: now,
            updated_at: now,
        }
    }
}

/// 提示词预设
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptPreset {
    /// 预设 ID
    pub id: String,
    /// 预设名称
    pub name: String,
    /// 预设描述
    #[serde(default)]
    pub description: Option<String>,
    /// 包含的模块 ID 列表（按顺序）
    pub module_ids: Vec<String>,
    /// 是否为系统预设（不可删除）
    #[serde(default)]
    pub is_system: bool,
    /// 创建时间
    pub created_at: i64,
    /// 更新时间
    pub updated_at: i64,
}

impl PromptPreset {
    /// 创建新预设
    pub fn new(id: String, name: String, module_ids: Vec<String>, is_system: bool) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            id,
            name,
            description: None,
            module_ids,
            is_system,
            created_at: now,
            updated_at: now,
        }
    }
}

/// 场景映射
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneMapping {
    /// 场景类型
    pub scene: SceneType,
    /// 默认预设 ID
    pub default_preset_id: String,
    /// 描述
    #[serde(default)]
    pub description: Option<String>,
}

impl SceneMapping {
    /// 创建新场景映射
    pub fn new(scene: SceneType, default_preset_id: String) -> Self {
        Self {
            scene,
            default_preset_id,
            description: None,
        }
    }
}

/// 提示词配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptConfig {
    /// 配置版本
    #[serde(default = "default_prompt_config_version")]
    pub version: String,
    /// 所有模块
    pub modules: Vec<PromptModule>,
    /// 所有预设
    pub presets: Vec<PromptPreset>,
    /// 场景映射
    pub scene_mapping: Vec<SceneMapping>,
    /// 最后更新时间
    pub updated_at: i64,
}

fn default_prompt_config_version() -> String {
    "1.0.0".to_string()
}

impl Default for PromptConfig {
    fn default() -> Self {
        Self {
            version: default_prompt_config_version(),
            modules: Vec::new(),
            presets: Vec::new(),
            scene_mapping: Vec::new(),
            updated_at: chrono::Utc::now().timestamp_millis(),
        }
    }
}

impl PromptConfig {
    /// 获取默认配置（包含预设模块和预设）
    pub fn with_defaults() -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        let modules = Self::create_default_modules();
        let module_ids: Vec<String> = modules.iter().map(|m| m.id.clone()).collect();

        let default_preset = PromptPreset::new(
            "preset-default".to_string(),
            "默认预设".to_string(),
            module_ids.clone(),
            true,
        );

        let minimal_preset = PromptPreset::new(
            "preset-minimal".to_string(),
            "精简预设".to_string(),
            vec!["module-workspace-info".to_string()],
            true,
        );

        let full_preset = PromptPreset::new(
            "preset-full".to_string(),
            "完整预设".to_string(),
            module_ids,
            true,
        );

        let presets = vec![default_preset, minimal_preset, full_preset];

        let scene_mapping = vec![
            SceneMapping::new(SceneType::Chat, "preset-default".to_string()),
            SceneMapping::new(SceneType::Scheduler, "preset-minimal".to_string()),
            SceneMapping::new(SceneType::Qqbot, "preset-default".to_string()),
            SceneMapping::new(SceneType::Commit, "preset-minimal".to_string()),
        ];

        Self {
            version: default_prompt_config_version(),
            modules,
            presets,
            scene_mapping,
            updated_at: now,
        }
    }

    /// 创建默认模块
    fn create_default_modules() -> Vec<PromptModule> {
        vec![
            PromptModule::new(
                "module-workspace-info".to_string(),
                PromptModuleType::WorkspaceInfo,
                "工作区信息".to_string(),
                "{{workspace_content}}".to_string(),
            ),
            PromptModule::new(
                "module-todo-management".to_string(),
                PromptModuleType::TodoManagement,
                "待办管理".to_string(),
                r#"待办管理:
当前工作区的待办数据存储在: {{workspace_path}}/.polaris/todos.json
当用户提到「待办」、「todo」、「任务」时，使用 Bash 工具操作待办文件:
1. 读取待办: cat .polaris/todos.json
2. 待办文件格式: {"version": "1.0.0", "todos": [{"id": "uuid", "content": "内容", "status": "pending|in_progress|completed", "priority": "low|normal|high|urgent"}]}
3. 可以用 jq 工具解析 JSON: cat .polaris/todos.json | jq '.todos'"#.to_string(),
            ),
            PromptModule::new(
                "module-requirement-queue".to_string(),
                PromptModuleType::RequirementQueue,
                "需求队列".to_string(),
                r#"需求队列:
需求队列用于管理和追踪项目需求，支持 AI 自动生成和用户手动创建。
需求文件路径: {{workspace_path}}/.polaris/requirements/requirements.json"#.to_string(),
            ),
        ]
    }

    /// 根据场景获取默认预设 ID
    #[allow(dead_code)]
    pub fn get_default_preset_id(&self, scene: SceneType) -> Option<String> {
        self.scene_mapping
            .iter()
            .find(|m| m.scene == scene)
            .map(|m| m.default_preset_id.clone())
    }

    /// 获取预设
    pub fn get_preset(&self, preset_id: &str) -> Option<&PromptPreset> {
        self.presets.iter().find(|p| p.id == preset_id)
    }

    /// 获取模块
    pub fn get_module(&self, module_id: &str) -> Option<&PromptModule> {
        self.modules.iter().find(|m| m.id == module_id)
    }

    /// 获取启用的模块列表（按预设顺序）
    pub fn get_enabled_modules(&self, preset_id: &str) -> Vec<&PromptModule> {
        let preset = match self.get_preset(preset_id) {
            Some(p) => p,
            None => return Vec::new(),
        };

        preset
            .module_ids
            .iter()
            .filter_map(|id| {
                self.get_module(id)
                    .filter(|m| m.enabled)
            })
            .collect()
    }

    /// 更新时间戳
    #[allow(dead_code)]
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().timestamp_millis();
    }
}

/// 提示词设置（存储在主配置中）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PromptSettings {
    /// 是否启用自定义提示词配置
    #[serde(default)]
    pub enabled: bool,
    /// 当前使用的预设 ID
    #[serde(default)]
    pub active_preset_id: Option<String>,
}
