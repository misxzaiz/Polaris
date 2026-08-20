/*! 提示词配置存储服务
 *
 * 管理提示词模块、预设和场景映射的持久化存储。
 */

use crate::error::{AppError, Result};
use crate::models::prompt::{PromptConfig, PromptModule, PromptPreset, SceneMapping, SceneType};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::fs;

/// 提示词存储管理器
pub struct PromptStore {
    /// 提示词配置
    config: PromptConfig,
    /// 配置文件路径
    #[allow(dead_code)]
    config_path: PathBuf,
}

impl PromptStore {
    /// 创建新的提示词存储
    pub fn new(config_dir: &Path) -> Result<Self> {
        // 确保 .polaris 目录存在
        let polaris_dir = config_dir.join(".polaris");
        fs::create_dir_all(&polaris_dir)?;

        let config_path = polaris_dir.join("prompt_config.json");

        let config = if config_path.exists() {
            Self::load_from_file(&config_path)?
        } else {
            // 创建默认配置
            let config = PromptConfig::with_defaults();
            // 保存默认配置
            Self::save_to_file(&config, &config_path)?;
            config
        };

        Ok(Self { config, config_path })
    }

    /// 从工作目录创建提示词存储
    pub fn from_work_dir(work_dir: &Path) -> Result<Self> {
        Self::new(work_dir)
    }

    /// 从文件加载配置
    fn load_from_file(path: &Path) -> Result<PromptConfig> {
        let content = fs::read_to_string(path)?;
        let config: PromptConfig = serde_json::from_str(&content)
            .unwrap_or_else(|_| PromptConfig::with_defaults());
        Ok(config)
    }

    /// 保存配置到文件
    fn save_to_file(config: &PromptConfig, path: &Path) -> Result<()> {
        let content = serde_json::to_string_pretty(config)?;
        fs::write(path, content)?;
        Ok(())
    }

    /// 获取预设
    pub fn get_preset(&self, preset_id: &str) -> Option<&PromptPreset> {
        self.config.get_preset(preset_id)
    }

    /// 获取启用的模块列表（按预设顺序）
    pub fn get_enabled_modules(&self, preset_id: &str) -> Vec<&PromptModule> {
        self.config.get_enabled_modules(preset_id)
    }

    /// 构建提示词
    ///
    /// # 参数
    /// - `preset_id`: 预设 ID
    /// - `variables`: 变量替换表
    ///
    /// # 返回
    /// 构建后的提示词字符串
    pub fn build_prompt(&self, preset_id: &str, variables: &HashMap<String, String>) -> String {
        let modules = self.get_enabled_modules(preset_id);
        let mut parts = Vec::new();

        for module in modules {
            let mut content = module.content.clone();
            // 替换变量
            for (key, value) in variables {
                content = content.replace(&format!("{{{{{}}}}}", key), value);
            }
            parts.push(content);
        }

        parts.join("\n\n")
    }

    // === 以下方法为将来扩展预留 ===

    /// 保存配置（原子写入）
    #[allow(dead_code)]
    pub fn save(&self) -> Result<()> {
        // 原子写入：先写临时文件，再重命名
        let temp_path = self.config_path.with_extension("json.tmp");
        let content = serde_json::to_string_pretty(&self.config)?;
        fs::write(&temp_path, content)?;
        fs::rename(&temp_path, &self.config_path)?;
        Ok(())
    }

    /// 获取配置（只读）
    #[allow(dead_code)]
    pub fn get(&self) -> &PromptConfig {
        &self.config
    }

    /// 获取配置（可变）
    #[allow(dead_code)]
    pub fn get_mut(&mut self) -> &mut PromptConfig {
        &mut self.config
    }

    /// 更新配置
    #[allow(dead_code)]
    pub fn update(&mut self, config: PromptConfig) -> Result<()> {
        let mut config = config;
        config.touch();
        self.config = config;
        self.save()
    }

    /// 重新加载配置
    #[allow(dead_code)]
    pub fn reload(&mut self) -> Result<()> {
        self.config = Self::load_from_file(&self.config_path)?;
        Ok(())
    }

    /// 获取所有模块
    #[allow(dead_code)]
    pub fn get_modules(&self) -> &[PromptModule] {
        &self.config.modules
    }

    /// 获取模块
    #[allow(dead_code)]
    pub fn get_module(&self, module_id: &str) -> Option<&PromptModule> {
        self.config.get_module(module_id)
    }

    /// 添加模块
    #[allow(dead_code)]
    pub fn add_module(&mut self, module: PromptModule) -> Result<()> {
        // 检查 ID 是否已存在
        if self.config.modules.iter().any(|m| m.id == module.id) {
            return Err(AppError::ConfigError(format!("模块 ID 已存在: {}", module.id)));
        }
        self.config.modules.push(module);
        self.config.touch();
        self.save()
    }

    /// 更新模块
    #[allow(dead_code)]
    pub fn update_module(&mut self, module: PromptModule) -> Result<()> {
        if let Some(existing) = self.config.modules.iter_mut().find(|m| m.id == module.id) {
            *existing = module;
            self.config.touch();
            self.save()
        } else {
            Err(AppError::ConfigError(format!("模块不存在: {}", module.id)))
        }
    }

    /// 删除模块
    #[allow(dead_code)]
    pub fn delete_module(&mut self, module_id: &str) -> Result<()> {
        let initial_len = self.config.modules.len();
        self.config.modules.retain(|m| m.id != module_id);

        if self.config.modules.len() == initial_len {
            return Err(AppError::ConfigError(format!("模块不存在: {}", module_id)));
        }

        // 从所有预设中移除该模块
        for preset in &mut self.config.presets {
            preset.module_ids.retain(|id| id != module_id);
        }

        self.config.touch();
        self.save()
    }

    /// 获取所有预设
    #[allow(dead_code)]
    pub fn get_presets(&self) -> &[PromptPreset] {
        &self.config.presets
    }

    /// 添加预设
    #[allow(dead_code)]
    pub fn add_preset(&mut self, preset: PromptPreset) -> Result<()> {
        // 检查 ID 是否已存在
        if self.config.presets.iter().any(|p| p.id == preset.id) {
            return Err(AppError::ConfigError(format!("预设 ID 已存在: {}", preset.id)));
        }

        // 验证所有模块 ID 存在
        for module_id in &preset.module_ids {
            if !self.config.modules.iter().any(|m| &m.id == module_id) {
                return Err(AppError::ConfigError(format!("模块不存在: {}", module_id)));
            }
        }

        self.config.presets.push(preset);
        self.config.touch();
        self.save()
    }

    /// 更新预设
    #[allow(dead_code)]
    pub fn update_preset(&mut self, preset: PromptPreset) -> Result<()> {
        // 验证所有模块 ID 存在
        for module_id in &preset.module_ids {
            if !self.config.modules.iter().any(|m| &m.id == module_id) {
                return Err(AppError::ConfigError(format!("模块不存在: {}", module_id)));
            }
        }

        if let Some(existing) = self.config.presets.iter_mut().find(|p| p.id == preset.id) {
            *existing = preset;
            self.config.touch();
            self.save()
        } else {
            Err(AppError::ConfigError(format!("预设不存在: {}", preset.id)))
        }
    }

    /// 删除预设
    #[allow(dead_code)]
    pub fn delete_preset(&mut self, preset_id: &str) -> Result<()> {
        let preset = self.config.presets.iter().find(|p| p.id == preset_id);

        if let Some(p) = preset {
            if p.is_system {
                return Err(AppError::ConfigError("系统预设不可删除".to_string()));
            }
        }

        let initial_len = self.config.presets.len();
        self.config.presets.retain(|p| p.id != preset_id);

        if self.config.presets.len() == initial_len {
            return Err(AppError::ConfigError(format!("预设不存在: {}", preset_id)));
        }

        // 更新场景映射，使用默认预设替代
        let default_preset_id = "preset-default".to_string();
        for mapping in &mut self.config.scene_mapping {
            if mapping.default_preset_id == preset_id {
                mapping.default_preset_id = default_preset_id.clone();
            }
        }

        self.config.touch();
        self.save()
    }

    /// 获取所有场景映射
    #[allow(dead_code)]
    pub fn get_scene_mappings(&self) -> &[SceneMapping] {
        &self.config.scene_mapping
    }

    /// 获取场景默认预设 ID
    #[allow(dead_code)]
    pub fn get_default_preset_id(&self, scene: SceneType) -> Option<String> {
        self.config.get_default_preset_id(scene)
    }

    /// 设置场景默认预设
    #[allow(dead_code)]
    pub fn set_scene_preset(&mut self, scene: SceneType, preset_id: String) -> Result<()> {
        // 验证预设存在
        if !self.config.presets.iter().any(|p| p.id == preset_id) {
            return Err(AppError::ConfigError(format!("预设不存在: {}", preset_id)));
        }

        if let Some(mapping) = self.config.scene_mapping.iter_mut().find(|m| m.scene == scene) {
            mapping.default_preset_id = preset_id;
        } else {
            self.config.scene_mapping.push(SceneMapping::new(scene, preset_id));
        }

        self.config.touch();
        self.save()
    }
}

impl Default for PromptStore {
    fn default() -> Self {
        let config = PromptConfig::with_defaults();
        let config_path = PathBuf::from(".polaris/prompt_config.json");
        Self { config, config_path }
    }
}
